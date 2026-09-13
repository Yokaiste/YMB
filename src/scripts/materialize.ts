import path from 'node:path';
import { type CooperativeYieldController, createCooperativeYieldController } from '../async.ts';
import { reportProgress } from '../engine/progress.ts';
import { ensure, YmbError } from '../errors.ts';
import { tryMergeGeneratedBlocks } from '../generated-block-merge.ts';
import { hasGeneratedBlockMarkers } from '../generated-blocks.ts';
import { hashText } from '../hash.ts';
import {
  abbreviateDisplayPath,
  assertGameRelativePath,
  normalizeRelativePath,
  toPathKey,
} from '../path-utils.ts';
import { formatInfoLine } from '../report/text.ts';
import type { TextMergeContributor } from '../text-merge.ts';
import {
  formatLineEditRange,
  resolveTextMergeBudgets,
  tryMergeTextContributionsCooperative,
} from '../text-merge.ts';
import type { BuildPlan, ScriptApplication, ScriptTestPhase, WrittenBuildFile } from '../types.ts';
import {
  createScriptOutputId,
  dedupeScriptContributors,
  describeFileOwner,
  describeScriptOwner,
  toContributor,
} from './contributors.ts';
import { runScript } from './runtime.ts';
import {
  createScriptTestCacheKey,
  loadCachedScriptTestRun,
  SCRIPT_TEST_CACHE_VERSION,
  saveCachedScriptTestRun,
} from './test-cache.ts';
import { executeScriptTest } from './test-runtime.ts';
import type { ExecutedScriptTestResult } from './testing.ts';
import { ensureTextState, resolveScriptBaseText, type ScriptTextState } from './text-state.ts';

export type ScriptTestReporter = (result: ExecutedScriptTestResult) => void | Promise<void>;

interface ScriptMaterializationOptions {
  reservedReplaceTargets?: readonly string[];
}

export async function materializeScriptOutputs(
  plan: BuildPlan,
  existingFiles: WrittenBuildFile[],
  reportScriptTest?: ScriptTestReporter,
  options?: ScriptMaterializationOptions,
): Promise<WrittenBuildFile[]> {
  const yieldController = createCooperativeYieldController();
  const outputMap = new Map(
    existingFiles.map((file) => [toPathKey(file.targetRelativePath), file] as const),
  );
  const reservedReplaceTargets = new Set(
    (
      options?.reservedReplaceTargets ??
      plan.selectedReplaceFiles.map((file) => file.targetRelativePath)
    ).map(toPathKey),
  );
  const generatedFiles: WrittenBuildFile[] = [];
  const existingGeneratedTextByTarget = new Map<string, string>(
    existingFiles.flatMap((file) =>
      typeof file.content === 'string'
        ? [[toPathKey(file.targetRelativePath), file.content] as const]
        : [],
    ),
  );
  const baseTextCache = new Map<string, string>();
  const textStates = new Map<string, ScriptTextState>();
  const totalScripts = plan.selectedScripts.length;
  const selectedScriptsByOwnerPathByMod = new Map<
    string,
    Map<string, (typeof plan.selectedScripts)[number]>
  >();
  for (const selectedScript of plan.selectedScripts) {
    const scriptsByOwnerPath =
      selectedScriptsByOwnerPathByMod.get(selectedScript.mod.config.id) ?? new Map();
    scriptsByOwnerPath.set(
      normalizeRelativePath(path.relative(plan.context.ymbRoot, selectedScript.absolutePath)),
      selectedScript,
    );
    selectedScriptsByOwnerPathByMod.set(selectedScript.mod.config.id, scriptsByOwnerPath);
  }

  for (const [scriptIndex, script] of plan.selectedScripts.entries()) {
    await yieldController.maybeYield();
    const ownerPath = normalizeRelativePath(
      path.relative(plan.context.ymbRoot, script.absolutePath),
    );
    const progressDetail = abbreviateDisplayPath(ownerPath);
    const progressCounts = {
      current: scriptIndex + 1,
      total: totalScripts,
    };
    await runConfiguredScriptTests({
      plan,
      script,
      when: 'before',
      outputMap,
      yieldController,
      reportScriptTest,
      progressDetail,
      progressCounts,
    });
    reportProgress('Running generation scripts', progressDetail, progressCounts);
    const scriptExecution = await runScriptWithHeartbeat(
      'Running generation scripts',
      progressDetail,
      progressCounts,
      () => runScript(plan, script, outputMap),
    );
    const scriptOutputs = scriptExecution.outputs;
    reportProgress(
      'Running generation scripts',
      `${progressDetail} - integrating ${scriptOutputs.length} output${scriptOutputs.length === 1 ? '' : 's'}`,
      progressCounts,
    );
    for (const [outputIndex, output] of scriptOutputs.entries()) {
      await yieldController.maybeYield();
      const targetRelativePath = assertGameRelativePath(
        output.targetRelativePath,
        plan.context.modRoot,
      );
      const targetKey = toPathKey(targetRelativePath);
      const scriptOutputId = createScriptOutputId(scriptIndex, outputIndex);
      const scriptOwner = describeScriptOwner(script);
      const scriptContributor = toContributor(script);
      const generatedBlockOwnerPaths = [ownerPath, ...(output.generatedBlockOwnerPaths ?? [])];
      const scriptsByOwnerPath =
        selectedScriptsByOwnerPathByMod.get(script.mod.config.id) ?? new Map();
      const invalidOwnerPaths = generatedBlockOwnerPaths.filter(
        (candidate) => !scriptsByOwnerPath.has(candidate),
      );
      ensure(invalidOwnerPaths.length === 0, 'ScriptError', {
        absolutePath: script.absolutePath,
        modId: script.mod.config.id,
        modName: script.mod.config.name,
        patchId: script.patch?.config.id,
        reason: 'Script output delegates generated blocks to unknown or foreign scripts.',
        suggestion:
          'Delegate only to configured scripts from the same source mod, or remove the delegated owner paths.',
        details: invalidOwnerPaths,
      });
      const delegatedContributors = generatedBlockOwnerPaths.flatMap((candidate) => {
        const delegatedScript = scriptsByOwnerPath.get(candidate);
        return delegatedScript ? [toContributor(delegatedScript)] : [];
      });
      const existing = outputMap.get(targetKey);
      ensure(!reservedReplaceTargets.has(targetKey), 'ConflictError', {
        absolutePath: targetRelativePath,
        modId: script.mod.config.id,
        modName: script.mod.config.name,
        patchId: script.patch?.config.id,
        reason: `Script output collides with a replace target \`${targetRelativePath}\`.`,
        suggestion:
          'Generate a different target path, stop replacing the same file, or move the script output into a separate build.',
        details: [script.absolutePath],
      });

      if (existing) {
        const state = await ensureTextState(
          plan,
          existing,
          targetRelativePath,
          textStates,
          existingGeneratedTextByTarget,
          baseTextCache,
          yieldController,
        );
        ensure(
          state &&
            typeof output.content === 'string' &&
            !state.contributors.some((contributor) => contributor.id === scriptOutputId),
          'ConflictError',
          {
            absolutePath: targetRelativePath,
            modId: script.mod.config.id,
            modName: script.mod.config.name,
            patchId: script.patch?.config.id,
            reason:
              typeof output.content !== 'string'
                ? `Script output collides with an existing generated target \`${targetRelativePath}\`.`
                : `Script output overlaps an existing generated target \`${targetRelativePath}\`.`,
            suggestion:
              typeof output.content !== 'string'
                ? 'Binary outputs must keep unique target paths. Generate a different file path instead.'
                : 'Keep same-target script edits disjoint, or merge them into one script owner.',
            details: [describeFileOwner(existing), script.absolutePath],
          },
        );

        const contributor: TextMergeContributor = {
          id: scriptOutputId,
          label: scriptOwner,
          content: output.content,
        };
        const blockMerge = tryMergeGeneratedBlocks(
          String(state.writtenFile.content),
          output.content,
          generatedBlockOwnerPaths,
        );
        if (blockMerge.kind === 'conflict') {
          throw new YmbError('ConflictError', {
            absolutePath: targetRelativePath,
            modId: script.mod.config.id,
            modName: script.mod.config.name,
            patchId: script.patch?.config.id,
            reason: `Script output overlaps with another generated script contribution in \`${targetRelativePath}\`.`,
            suggestion:
              'Keep same-target script edits inside blocks owned by the current script, or merge the contributors into one script owner.',
            details: [...blockMerge.details, script.absolutePath],
          });
        }
        if (blockMerge.kind === 'applied') {
          applyIntegratedScriptText({
            state,
            content: blockMerge.content,
            contributor,
            scriptContributor,
            delegatedContributors,
            outputMap,
            targetKey,
          });
          continue;
        }
        if (
          blockMerge.kind === 'unsupported' &&
          !hasGeneratedBlockMarkers(String(state.writtenFile.content)) &&
          !hasGeneratedBlockMarkers(output.content) &&
          scriptExecution.observedTargetReads.some(
            (read) =>
              read.readKind === 'text' &&
              toPathKey(read.targetRelativePath) === targetKey &&
              read.contentHash === hashText(String(state.writtenFile.content)),
          )
        ) {
          applyIntegratedScriptText({
            state,
            content: output.content,
            contributor,
            scriptContributor,
            delegatedContributors,
            outputMap,
            targetKey,
            replaceContributors: true,
          });
          continue;
        }
        const merged = await tryMergeTextContributionsCooperative(
          state.baseText,
          [...state.contributors, contributor],
          yieldController,
          resolveTextMergeBudgets(plan.context.builderConfig.settings),
        );
        if (!merged.ok) {
          throw new YmbError('ConflictError', {
            absolutePath: targetRelativePath,
            modId: script.mod.config.id,
            modName: script.mod.config.name,
            patchId: script.patch?.config.id,
            reason:
              merged.reason === 'budget_exceeded'
                ? `Script output exceeded YMB's protected merge budget for \`${targetRelativePath}\`.`
                : `Script output overlaps with another generated script contribution in \`${targetRelativePath}\`.`,
            suggestion:
              merged.reason === 'budget_exceeded'
                ? 'Reduce the size of same-target edits, keep generated blocks stable, or raise the `merge` limits under `settings` in `ymb.config.yaml` if this file is legitimately this large.'
                : 'Keep same-target script edits disjoint, or merge them into one script owner.',
            details:
              merged.reason === 'budget_exceeded'
                ? [
                    formatInfoLine(
                      merged.budget.contributorLabel,
                      `changed base lines: ${merged.budget.changedBaseLines}`,
                    ),
                    formatInfoLine(
                      merged.budget.contributorLabel,
                      `changed next lines: ${merged.budget.changedNextLines}`,
                    ),
                    `Estimated diff work: ${merged.budget.estimatedWork}`,
                    script.absolutePath,
                  ]
                : [
                    formatInfoLine(
                      merged.conflict.existing.contributorLabel,
                      formatLineEditRange(merged.conflict.existing),
                    ),
                    formatInfoLine(
                      merged.conflict.incoming.contributorLabel,
                      formatLineEditRange(merged.conflict.incoming),
                    ),
                    script.absolutePath,
                  ],
          });
        }

        applyIntegratedScriptText({
          state,
          content: merged.content,
          contributor,
          scriptContributor,
          delegatedContributors,
          outputMap,
          targetKey,
        });
        continue;
      }

      const writtenFile: WrittenBuildFile = {
        targetRelativePath,
        sourceType: 'script',
        content: output.content,
        contributors: dedupeScriptContributors([scriptContributor, ...delegatedContributors]),
      };

      generatedFiles.push(writtenFile);
      outputMap.set(targetKey, writtenFile);
      if (typeof output.content === 'string') {
        textStates.set(targetKey, {
          baseText: await resolveScriptBaseText(
            plan,
            targetRelativePath,
            existingGeneratedTextByTarget,
            writtenFile,
            baseTextCache,
            yieldController,
          ),
          contributors: [
            {
              id: scriptOutputId,
              label: scriptOwner,
              content: output.content,
            },
          ],
          writtenFile,
        });
      }
    }

    // Everything this script produced is in `outputMap` now, and anything it
    // keeps between runs is on disk, so an `after` test sees the finished run.
    await runConfiguredScriptTests({
      plan,
      script,
      when: 'after',
      outputMap,
      yieldController,
      reportScriptTest,
      progressDetail,
      progressCounts,
    });
  }

  return generatedFiles;
}

function applyIntegratedScriptText(args: {
  state: ScriptTextState;
  content: string;
  contributor: TextMergeContributor;
  scriptContributor: WrittenBuildFile['contributors'][number];
  delegatedContributors: WrittenBuildFile['contributors'];
  outputMap: Map<string, WrittenBuildFile>;
  targetKey: string;
  replaceContributors?: boolean;
}): void {
  args.state.contributors = args.replaceContributors
    ? [args.contributor]
    : [...args.state.contributors, args.contributor];
  args.state.writtenFile.content = args.content;
  args.state.writtenFile.contributors = dedupeScriptContributors([
    ...args.state.writtenFile.contributors,
    args.scriptContributor,
    ...args.delegatedContributors,
  ]);
  args.outputMap.set(args.targetKey, args.state.writtenFile);
}

interface ScriptTestPhaseRun {
  plan: BuildPlan;
  script: ScriptApplication;
  when: ScriptTestPhase;
  outputMap: Map<string, WrittenBuildFile>;
  yieldController: CooperativeYieldController;
  reportScriptTest?: ScriptTestReporter | undefined;
  progressDetail: string;
  progressCounts: { current: number; total: number };
}

async function runConfiguredScriptTests(args: ScriptTestPhaseRun): Promise<void> {
  const { plan, script, when, outputMap, yieldController, progressDetail, progressCounts } = args;
  const tests = script.tests.filter((test) => test.when === when);
  if (tests.length === 0) {
    return;
  }

  const progressLabel =
    when === 'before' ? 'Running generation script tests' : 'Running generation output checks';
  reportProgress(progressLabel, progressDetail, progressCounts);
  const scriptTestRuns = await runScriptWithHeartbeat(
    progressLabel,
    progressDetail,
    progressCounts,
    async () => {
      const executed: Array<{
        testAbsolutePath: string;
        cached: boolean;
        results: Awaited<ReturnType<typeof executeScriptTest>>['results'];
      }> = [];
      for (const { absolutePath: testAbsolutePath } of tests) {
        await yieldController.maybeYield();
        // An `after` test is a statement about what this run just produced, and
        // part of that - the files a script keeps between runs - is not among
        // the inputs a cache key or an observed target read would notice.
        const cacheKey =
          plan.selection.useCache === false || when === 'after'
            ? undefined
            : await createScriptTestCacheKey(plan, script, testAbsolutePath, yieldController);
        const cachedRun =
          cacheKey === undefined
            ? undefined
            : await loadCachedScriptTestRun({
                plan,
                script,
                testAbsolutePath,
                outputMap,
                cacheKey,
                yieldController,
              });
        if (cachedRun) {
          executed.push({
            testAbsolutePath,
            cached: true,
            results: cachedRun.results,
          });
          continue;
        }
        const executedRun = await executeScriptTest(plan, script, testAbsolutePath, outputMap);
        if (cacheKey !== undefined) {
          await saveCachedScriptTestRun(
            plan,
            cacheKey,
            {
              version: SCRIPT_TEST_CACHE_VERSION,
              results: executedRun.results,
              observedTargetReads: executedRun.observedTargetReads,
              observedScriptFileReads: executedRun.observedScriptFileReads,
            },
            yieldController,
          );
        }
        executed.push({
          testAbsolutePath,
          cached: false,
          results: executedRun.results,
        });
      }
      return executed;
    },
  );
  for (const scriptTestRun of scriptTestRuns) {
    await yieldController.maybeYield();
    for (const result of scriptTestRun.results) {
      await yieldController.maybeYield();
      await args.reportScriptTest?.({
        script,
        testAbsolutePath: scriptTestRun.testAbsolutePath,
        result,
        ...(scriptTestRun.cached ? { cached: true } : {}),
      });
    }
  }
}

async function runScriptWithHeartbeat<T>(
  progressLabel: string,
  progressDetail: string | undefined,
  progressCounts: { current?: number | undefined; total?: number | undefined },
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const timer = setInterval(() => {
    reportProgress(
      progressLabel,
      formatTimedScriptDetail(progressDetail, performance.now() - startedAt),
      progressCounts,
    );
  }, 1000);
  timer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

function formatTimedScriptDetail(progressDetail: string | undefined, durationMs: number): string {
  const duration = formatHeartbeatDuration(durationMs);
  if (!progressDetail) {
    return `script (${duration})`;
  }

  return `${progressDetail} (${duration})`;
}

function formatHeartbeatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${Math.floor(durationMs / 1000)}s`;
  }

  return `${Math.max(1, Math.round(durationMs))}ms`;
}
