import { BUILDER_CONFIG } from './builder-config.ts';
import type { Scope } from './types.ts';

export type CliCommandName =
  | 'validate'
  | 'list'
  | 'explain'
  | 'build'
  | 'sync'
  | 'recover'
  | 'doctor'
  | 'cleanup'
  | 'init';

export interface CommandGuide {
  name: CliCommandName;
  description: string;
  purpose: string;
  resultLabel?: string | undefined;
  resultPath?: string | undefined;
  workflowStep?: number | undefined;
  whenToUse?: string[] | undefined;
  nextSteps?: string[] | undefined;
  examples: string[];
}

export const COMMAND_GUIDES: CommandGuide[] = [
  {
    name: 'doctor',
    description: 'Confirm that YMB is targeting the WARNO mod folder you expect.',
    purpose:
      'Verifies the builder, preview, live, and recovery paths before you trust later commands.',
    workflowStep: 1,
    nextSteps: ['Run `validate` once the paths look correct.'],
    examples: ['bun run ymb doctor'],
  },
  {
    name: 'validate',
    description:
      'Check configs, patch targets, script outputs, tests, and conflicts without writing preview or live files.',
    purpose: 'Catches mistakes before preview or publish touches live game data.',
    workflowStep: 2,
    nextSteps: [
      'Run `build` to write a preview if validation is clean.',
      'Run `explain` if a patch is missing or unexpectedly selected.',
    ],
    examples: ['bun run ymb validate', 'bun run ymb validate --mod sample_pack'],
  },
  {
    name: 'list',
    description: 'Show the source mods and patches YMB can currently discover.',
    purpose: 'Gives you a quick inventory of the builder-visible project surface.',
    nextSteps: ['Use `explain` when the selection does not match your expectation.'],
    examples: ['bun run ymb list'],
  },
  {
    name: 'explain',
    description: 'Show why patches are included, excluded, or pulled in by dependencies.',
    purpose: 'Explains selection rules, filters, scope, and dependency behavior.',
    nextSteps: ['Run `build --dry-run` or `build` after the selection looks right.'],
    examples: ['bun run ymb explain --scope dev'],
  },
  {
    name: 'build',
    description: `Write preview output to \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.buildDirectoryName}/${BUILDER_CONFIG.buildOutputDirectoryName}\`.`,
    purpose: 'Materializes the final preview without touching the live mod files.',
    resultLabel: 'Preview',
    resultPath: `${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.buildDirectoryName}/${BUILDER_CONFIG.buildOutputDirectoryName}`,
    workflowStep: 3,
    nextSteps: [
      'Open the preview output and inspect the files you changed.',
      'Run `sync --yes` only after the preview looks correct.',
    ],
    examples: ['bun run ymb build', 'bun run ymb build --mod sample_pack --dry-run'],
  },
  {
    name: 'sync',
    description: 'Write the approved build result into the live mod root.',
    purpose: 'Publishes the reviewed preview into the active WARNO mod folder.',
    resultLabel: 'Live mod root',
    workflowStep: 4,
    nextSteps: [
      'Test the live mod in WARNO.',
      'Run `recover --yes` later if you want to restore tracked originals.',
    ],
    examples: ['bun run ymb sync --yes', 'bun run ymb sync --mod sample_pack --yes'],
  },
  {
    name: 'recover',
    description: `Restore tracked originals from \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.stateDirectoryName}\`.`,
    purpose: 'Rolls tracked files back to the original state saved during sync.',
    resultLabel: 'Recovery state',
    resultPath: `${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.stateDirectoryName}`,
    nextSteps: ['Run `build` again if you want to produce a fresh preview after recovery.'],
    examples: ['bun run ymb recover --yes', 'bun run ymb recover --mod sample_pack --yes'],
  },
  {
    name: 'cleanup',
    description:
      'Remove YMB temp artifacts. Safe mode keeps recovery data and all-only temp files.',
    purpose: 'Cleans generated builder state without touching authored source mods.',
    resultLabel: 'Builder temp roots',
    resultPath: `${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.buildDirectoryName}`,
    nextSteps: [
      'Use `cleanup --all --yes` only when you also want to remove recovery data and all-only temp files.',
    ],
    examples: ['bun run ymb cleanup', 'bun run ymb cleanup --all --yes'],
  },
  {
    name: 'init',
    description: `Create a starter source mod scaffold under \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.modsDirectoryName}\`.`,
    purpose:
      'Bootstraps a beginner-friendly working source mod with a patch, replace file, script, and test.',
    resultLabel: 'Source mods',
    resultPath: `${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.modsDirectoryName}`,
    workflowStep: 0,
    nextSteps: [
      'Run `validate --mod <id>` on the new source mod.',
      'Run `build --mod <id>` to inspect the starter preview.',
    ],
    examples: ['bun run ymb init', 'bun run ymb init --id my_pack --name "My Pack"'],
  },
];

export function getCommandGuide(name: CliCommandName): CommandGuide {
  const guide = COMMAND_GUIDES.find((entry) => entry.name === name);
  if (!guide) {
    throw new Error(`Unknown command guide: ${name}`);
  }
  return guide;
}

export function buildRootHelpText(): string {
  const orderedFlow = COMMAND_GUIDES.filter((guide) => guide.workflowStep !== undefined)
    .sort((left, right) => (left.workflowStep ?? 999) - (right.workflowStep ?? 999))
    .filter((guide) => ['doctor', 'validate', 'build', 'sync', 'recover'].includes(guide.name));

  return [
    '',
    'Start Here:',
    '  YMB works best when you treat `build` as preview, `sync` as publish, and `recover` as rollback.',
    '',
    'Recommended Flow:',
    ...orderedFlow.map(
      (guide, index) => `  ${index + 1}. ${guide.name.padEnd(8)} ${guide.description}`,
    ),
    '',
    'Main Places:',
    `  preview  ${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.buildDirectoryName}/${BUILDER_CONFIG.buildOutputDirectoryName}`,
    `  live     <mod root>/GameData and <mod root>/CommonData`,
    `  recovery ${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.stateDirectoryName}`,
    '',
    'Examples:',
    ...COMMAND_GUIDES.flatMap((guide) =>
      guide.examples.slice(0, 1).map((example) => `  ${example}`),
    ),
    '',
  ].join('\n');
}

export function buildCommandHelpText(name: CliCommandName): string {
  const guide = getCommandGuide(name);
  const lines = ['', `What It Does:`, `  ${guide.purpose}`];

  if (guide.resultLabel && guide.resultPath) {
    lines.push('', 'Where To Look:', `  ${guide.resultLabel}: ${guide.resultPath}`);
  }
  if (guide.whenToUse && guide.whenToUse.length > 0) {
    lines.push('', 'Use It When:');
    lines.push(...guide.whenToUse.map((line) => `  - ${line}`));
  }
  if (guide.nextSteps && guide.nextSteps.length > 0) {
    lines.push('', 'Usually Next:');
    lines.push(...guide.nextSteps.map((line) => `  - ${line}`));
  }
  if (guide.examples.length > 0) {
    lines.push('', 'Examples:');
    lines.push(...guide.examples.map((line) => `  ${line}`));
  }
  lines.push('');
  return lines.join('\n');
}

export function describeScope(scope: Scope): string {
  return scope === 'dev' ? 'prod + dev' : 'prod only';
}
