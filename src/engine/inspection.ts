import { pathExists } from '../path-utils.ts';
import type { SelectionInput } from '../types.ts';
import {
  type CommandOutputLines,
  createSummaryLines,
  formatCountSummary,
  formatTimingSummary,
  withOutputMeta,
  withSummary,
} from './command-output.ts';
import { preparePlan } from './plan.ts';
import { reportProgress } from './progress.ts';

export async function runList(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Preparing source mod list');
  const plan = await preparePlan(builderPath, selection);
  const logs: string[] = [];

  for (const mod of plan.discoveredMods) {
    logs.push(`mod ${mod.config.id} | ${mod.config.name} | ${mod.config.enabled ? 'on' : 'off'}`);
    for (const patch of mod.patches) {
      logs.push(
        `patch ${patch.config.id} | ${patch.config.name} | ${patch.config.scope} | ${patch.config.enabled ? 'on' : 'off'}`,
      );
    }
  }

  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        formatCountSummary('found', [
          ['source mod', plan.discoveredMods.length],
          ['patch', plan.discoveredMods.reduce((count, mod) => count + mod.patches.length, 0)],
        ]),
        formatTimingSummary(performance.now() - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'discovered items',
      nextSteps: ['Run `explain` if a patch is missing or unexpectedly included.'],
    },
  );
}

export async function runExplain(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Explaining selected patches');
  const plan = await preparePlan(builderPath, selection);
  return withOutputMeta(
    withSummary(
      plan.explanations.map(
        (entry) =>
          `${entry.patchId} -> ${entry.included ? 'included' : 'excluded'} | ${entry.reasons.join('; ')}`,
      ),
      createSummaryLines([
        formatCountSummary('explained', [
          ['included', plan.explanations.filter((entry) => entry.included).length],
          ['excluded', plan.explanations.filter((entry) => !entry.included).length],
        ]),
        formatTimingSummary(performance.now() - startedAt, []),
      ]),
    ),
    {
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
  return withOutputMeta(
    withSummary(
      [
        `builder root -> ${plan.context.ymbRoot}`,
        `mod root -> ${plan.context.modRoot}`,
        `source mods -> ${plan.context.modsRoot}`,
        `preview root -> ${plan.context.buildRoot}`,
        `recovery root -> ${plan.context.stateRoot}`,
        `GameData -> ${(await pathExists(plan.context.gameDataRoot)) ? 'found' : 'missing'}`,
        `CommonData -> ${(await pathExists(plan.context.commonDataRoot)) ? 'found' : 'missing'}`,
      ],
      createSummaryLines([
        formatCountSummary('current selection', [
          ['patch', plan.selectedPatches.length],
          ['replace', plan.selectedReplaceFiles.length],
          ['script', plan.selectedScripts.length],
        ]),
        formatTimingSummary(performance.now() - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'paths',
      locations: [
        { label: 'builder', path: plan.context.ymbRoot },
        { label: 'live mod root', path: plan.context.modRoot },
      ],
      nextSteps: ['Run `validate` if these paths look correct.'],
    },
  );
}
