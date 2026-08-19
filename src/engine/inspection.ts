import { readdir } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../../package.json' with { type: 'json' };
import { BUILDER_CONFIG } from '../builder-config.ts';
import { loadManifest } from '../markers.ts';
import { isMissingPathError, pathExists } from '../path-utils.ts';
import { countFact, timingFact } from '../report/facts.ts';
import {
  formatFindingGroups,
  formatUnmatchedFilterWarnings,
  type ReportFinding,
  toSharedFindings,
  toUnmatchedFilterFinding,
} from '../report/findings.ts';
import { type CommandOutputLines, toCommandOutput } from '../report/output.ts';
import { formatInfoLine, formatRecordLine } from '../report/text.ts';
import type { BuilderContext, SelectionInput } from '../types.ts';
import { preparePlan } from './plan.ts';
import { reportProgress } from './progress.ts';
import { readTrackedTargetState } from './recovery.ts';

export async function runList(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Preparing source mod list');
  const plan = await preparePlan(builderPath, selection);
  const logs: string[] = [...formatUnmatchedFilterWarnings(plan.unmatchedFilters)];

  for (const mod of plan.discoveredMods) {
    logs.push(
      formatRecordLine(['mod', mod.config.id, mod.config.name, mod.config.enabled ? 'on' : 'off']),
    );
    for (const patch of mod.patches) {
      logs.push(
        formatRecordLine([
          'patch',
          patch.config.id,
          patch.config.name,
          patch.config.scope,
          patch.config.enabled ? 'on' : 'off',
        ]),
      );
    }
  }

  return toCommandOutput(logs, {
    summary: [
      countFact('found', [
        ['source mod', plan.discoveredMods.length],
        ['patch', plan.discoveredMods.reduce((count, mod) => count + mod.patches.length, 0)],
      ]),
      timingFact(performance.now() - startedAt, []),
    ],
    detailHeading: 'discovered items',
    nextSteps: ['Run `explain` if a patch is missing or unexpectedly included.'],
  });
}

export async function runExplain(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Explaining selected patches');
  const plan = await preparePlan(builderPath, selection);
  return toCommandOutput(
    [
      ...formatUnmatchedFilterWarnings(plan.unmatchedFilters),
      ...plan.explanations.map((entry) =>
        formatInfoLine(
          `${entry.modId}:${entry.patchId}`,
          formatRecordLine([entry.included ? 'included' : 'excluded', entry.reasons.join('; ')]),
        ),
      ),
    ],
    {
      summary: [
        countFact('explained', [
          ['included patch', plan.explanations.filter((entry) => entry.included).length],
          ['excluded patch', plan.explanations.filter((entry) => !entry.included).length],
        ]),
        timingFact(performance.now() - startedAt, []),
      ],
      detailHeading: 'selection reasons',
      nextSteps: [
        'Adjust `--mod`, `--patch`, `--scope`, or `dependsOn` based on the reasons above.',
      ],
    },
  );
}

export async function runDoctor(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Inspecting builder paths');
  const plan = await preparePlan(builderPath, selection);
  reportProgress('Checking installed state');
  const health = await inspectInstalledState(plan.context);
  const runtime = describeRuntimeVersion();
  return toCommandOutput(
    [
      ...formatFindingGroups([
        ...plan.unmatchedFilters.map(toUnmatchedFilterFinding),
        ...describeInstalledStateFindings(health),
      ]),
      formatInfoLine('builder config', plan.context.builderConfigPath),
      formatInfoLine('builder root', plan.context.ymbRoot),
      formatInfoLine('game root', plan.context.modRoot),
      formatInfoLine('source mods', plan.context.modsRoot),
      formatInfoLine('preview root', plan.context.buildRoot),
      formatInfoLine('recovery root', plan.context.stateRoot),
      formatInfoLine(
        'GameData',
        (await pathExists(plan.context.gameDataRoot)) ? 'found' : 'missing',
      ),
      formatInfoLine(
        'CommonData',
        (await pathExists(plan.context.commonDataRoot)) ? 'found' : 'missing',
      ),
      formatInfoLine('bun', runtime.detail),
      formatInfoLine('installed', describeInstalledState(health)),
    ],
    {
      summary: [
        countFact('this build uses', [
          ['patch', plan.selectedPatches.length],
          [
            'replace file',
            plan.selectedReplaceFiles.filter((file) => file.sourceType === 'replace').length,
          ],
          [
            'file-operation output',
            plan.selectedReplaceFiles.filter((file) => file.sourceType === 'file').length,
          ],
          ['file deletion', plan.selectedFileDeletions.length],
          ['script', plan.selectedScripts.length],
          ['skipped optional patch', plan.skippedPatches.length, 'skipped optional patches'],
        ]),
        countFact('installed', [
          ['tracked file', health.trackedCount],
          ['file changed since sync', health.changedTargets.length, 'files changed since sync'],
          [
            'file back at its original',
            health.revertedTargets.length,
            'files back at their originals',
          ],
          ['missing backup', health.missingBackups.length],
          ['orphaned backup', health.orphanedBackupCount],
        ]),
        timingFact(performance.now() - startedAt, []),
      ],
      detailHeading: 'paths',
      locations: [
        { label: 'builder', path: plan.context.ymbRoot },
        { label: 'live game root', path: plan.context.modRoot },
      ],
      nextSteps: describeDoctorNextSteps(health, runtime.matchesPin),
    },
  );
}

interface InstalledState {
  trackedCount: number;
  modIds: string[];
  /** Tracked files holding content YMB cannot account for. Sync refuses these. */
  changedTargets: string[];
  /** The next sync re-applies over these on its own, so nobody is asked to act. */
  revertedTargets: string[];
  /** Tracked originals whose backup is gone, so `recover` cannot restore them. */
  missingBackups: string[];
  orphanedBackupCount: number;
}

/**
 * Answers the questions people arrive with -- is anything installed, did a game
 * update overwrite my work, can I still undo this -- which no path list can show.
 */
async function inspectInstalledState(context: BuilderContext): Promise<InstalledState> {
  const manifest = await loadManifest(context.stateRoot);
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const modIds = new Set<string>();
  const changedTargets: string[] = [];
  const revertedTargets: string[] = [];
  const missingBackups: string[] = [];
  const referencedBackups = new Set<string>();

  for (const entry of manifest.entries) {
    for (const contributor of entry.contributors) {
      modIds.add(contributor.modId);
    }
    referencedBackups.add(entry.backupFileName);
    const state = await readTrackedTargetState(context, entry);
    if (state === 'changed') {
      changedTargets.push(entry.targetRelativePath);
    } else if (state === 'original') {
      revertedTargets.push(entry.targetRelativePath);
    }
    if (
      entry.originalExists &&
      !(await pathExists(path.join(originalsRoot, entry.backupFileName)))
    ) {
      missingBackups.push(entry.targetRelativePath);
    }
  }

  return {
    trackedCount: manifest.entries.length,
    modIds: [...modIds].sort(),
    changedTargets,
    revertedTargets,
    missingBackups,
    orphanedBackupCount: await countOrphanedBackups(originalsRoot, referencedBackups),
  };
}

async function countOrphanedBackups(
  originalsRoot: string,
  referencedBackups: ReadonlySet<string>,
): Promise<number> {
  try {
    const names = await readdir(originalsRoot);
    return names.filter((name) => !referencedBackups.has(name)).length;
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
}

/** Each is a list of paths sharing one explanation, so a reverted thirty says it once. */
function describeInstalledStateFindings(health: InstalledState): ReportFinding[] {
  return [
    ...toSharedFindings(
      {
        severity: 'warning',
        label: 'tracked file',
        detail: 'Changed after the last sync, so YMB cannot account for what it holds now.',
        suggestion:
          'Run `sync --yes --reset-changed` to put the originals back and re-apply, or `recover --yes --reset-changed` to undo YMB entirely.',
      },
      health.changedTargets,
    ),
    ...toSharedFindings(
      {
        severity: 'note',
        label: 'tracked file',
        detail: 'Back at its original bytes, usually from a WARNO update or `GenerateMod.bat`.',
        suggestion: 'The next `sync --yes` re-applies these. Nothing to do.',
      },
      health.revertedTargets,
    ),
    ...toSharedFindings(
      {
        severity: 'warning',
        label: 'tracked file',
        detail: 'Its saved original is gone, so `recover` cannot put this file back.',
        suggestion:
          'Restore the backup from a trusted copy, or accept that this file cannot be undone.',
      },
      health.missingBackups,
    ),
  ];
}

function describeInstalledState(health: InstalledState): string {
  if (health.trackedCount === 0) {
    return 'nothing synced yet';
  }
  return `${health.trackedCount} tracked ${health.trackedCount === 1 ? 'file' : 'files'} from ${health.modIds.join(', ')}`;
}

function describeRuntimeVersion(): { detail: string; matchesPin: boolean } {
  const required = packageDefinition.engines.bun;
  const matchesPin = Bun.semver.satisfies(Bun.version, required);
  return {
    detail: `${Bun.version}${matchesPin ? '' : ` (does not satisfy ${required})`}`,
    matchesPin,
  };
}

/** Advice belonging to a specific file list travels with it as its `suggestion`. */
function describeDoctorNextSteps(health: InstalledState, runtimeMatchesPin: boolean): string[] {
  const steps: string[] = [];
  if (!runtimeMatchesPin) {
    steps.push('Install the Bun version this YMB build requires before running anything else.');
  }
  if (health.orphanedBackupCount > 0) {
    steps.push('The next `recover` clears the orphaned backups. Nothing else to do.');
  }
  if (steps.length === 0) {
    steps.push('Run `validate` if these paths look correct.');
  }
  return steps;
}
