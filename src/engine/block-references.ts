import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { listFilesRecursive } from '../config/layout.ts';
import { ensure } from '../errors.ts';
import { advanceNdfLexicalState, createNdfLexicalState } from '../patch/ndf/chars.ts';
import { isNdfPath } from '../patch/ndf/validate.ts';
import { normalizeRelativePath, pathExists, toPathKey } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type { BuildPlan, PatchApplication, WrittenBuildFile } from '../types.ts';
import { reportProgress } from './progress.ts';
import { resolveVariablesInTarget } from './shared.ts';

/** One `expect.referenced` name, and the target that asked for it. */
interface RequiredReference {
  name: string;
  targetRelativePath: string;
  application: PatchApplication;
}

/**
 * A patch can apply cleanly and still draw nothing, because the block it edited is
 * no longer named by anything -- every operation found its target, so none can
 * notice. It cannot be inferred either: about one top-level block in ten is
 * referenced by nothing and works fine, because WARNO reads it by name from the
 * engine. So the author states which blocks are the reachable kind.
 */
export async function assertRequiredBlockReferences(
  plan: BuildPlan,
  materializedFiles: readonly WrittenBuildFile[],
  yieldController: CooperativeYieldController,
): Promise<void> {
  const required = collectRequiredReferences(plan);
  if (required.length === 0) return;

  reportProgress('Checking patched blocks are still referenced');
  const referenced = await collectReferencedNames(
    plan,
    materializedFiles,
    new Set(required.map((entry) => entry.name)),
    yieldController,
  );

  for (const entry of required) {
    ensure(referenced.has(entry.name), 'SelectorError', {
      absolutePath: entry.targetRelativePath,
      modId: entry.application.mod.config.id,
      modName: entry.application.mod.config.name,
      patchId: entry.application.patch.config.id,
      patchConfigPath: entry.application.patch.configFilePath,
      reason: `No file references \`${entry.name}\` after this patch, but \`expect.referenced\` requires a reference.`,
      suggestion:
        'Check the block that should use it. Update that reference, or remove this check if WARNO loads the block directly by name.',
      details: [`Target: ${entry.targetRelativePath}`],
    });
  }
}

function collectRequiredReferences(plan: BuildPlan): RequiredReference[] {
  const required: RequiredReference[] = [];
  for (const application of plan.selectedPatches) {
    const templateVariables = createTemplateVariables(
      plan.context,
      application.mod,
      application.patch,
    );
    for (const authored of application.patch.config.targets) {
      if (!authored.expect?.referenced) continue;
      const target = resolveVariablesInTarget(authored, templateVariables, application);
      for (const name of target.expect?.referenced ?? []) {
        required.push({ name, targetRelativePath: target.file, application });
      }
    }
  }
  return required;
}

/**
 * The finished project, not the sources: a patched target is read from the output
 * just built. One pass answers every name, and only when a patch asked.
 */
async function collectReferencedNames(
  plan: BuildPlan,
  materializedFiles: readonly WrittenBuildFile[],
  wanted: ReadonlySet<string>,
  yieldController: CooperativeYieldController,
): Promise<Set<string>> {
  const pattern = createReferencePattern(wanted);
  const referenced = new Set<string>();
  const missing = new Set(wanted);
  const builtPaths = new Set(
    plan.selectedFileDeletions.map((deletion) => toPathKey(deletion.targetRelativePath)),
  );

  for (const written of materializedFiles) {
    await yieldController.maybeYield();
    if (!isNdfPath(written.targetRelativePath)) continue;
    builtPaths.add(toPathKey(normalizeRelativePath(written.targetRelativePath)));
    collectMatches(
      typeof written.content === 'string'
        ? written.content
        : new TextDecoder().decode(written.content),
      pattern,
      missing,
      referenced,
    );
  }

  for (const root of [plan.context.gameDataRoot, plan.context.commonDataRoot]) {
    if (missing.size === 0) return referenced;
    if (!(await pathExists(root))) continue;
    for (const absolutePath of await listFilesRecursive(root)) {
      await yieldController.maybeYield();
      if (!isNdfPath(absolutePath)) continue;
      const relativePath = normalizeRelativePath(path.relative(plan.context.modRoot, absolutePath));
      // The built output already answered for this one, and on disk it may still
      // hold the previous sync's content.
      if (builtPaths.has(toPathKey(relativePath))) continue;
      collectMatches(await Bun.file(absolutePath).text(), pattern, missing, referenced);
      if (missing.size === 0) return referenced;
    }
  }

  return referenced;
}

/**
 * A reference is the name used as a token: not glued to a longer word, not inside a
 * string literal, and not its own `Name is Type` header. The string exclusion is
 * what makes this work -- a UI block repeats its name as `ElementName = "Name"`.
 * Comments still count: over-counting costs a warning, under-counting fails a build.
 */
function createReferencePattern(wanted: ReadonlySet<string>): RegExp {
  const alternatives = [...wanted].map(RegExp.escape).join('|');
  return new RegExp(`(?<![\\w])(${alternatives})(?![\\w])(?![ \\t]+is[ \\t\\r\\n])`, 'g');
}

/**
 * A file holding no occurrence of any wanted name cannot answer anything, and a
 * literal search says so far more cheaply than the alternation with its lookarounds.
 */
function collectMatches(
  text: string,
  pattern: RegExp,
  missing: Set<string>,
  referenced: Set<string>,
): void {
  let mentionsAny = false;
  for (const name of missing) {
    if (text.includes(name)) {
      mentionsAny = true;
      break;
    }
  }
  if (!mentionsAny) return;

  pattern.lastIndex = 0;
  const state = createNdfLexicalState();
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    for (; cursor < match.index; cursor += 1) {
      if (advanceNdfLexicalState(state, text, cursor) === 'comment-start') cursor += 1;
    }
    if (state.inString) continue;
    const name = match[1];
    if (!name) continue;
    referenced.add(name);
    missing.delete(name);
  }
}
