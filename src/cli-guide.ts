import { BUILDER_CONFIG } from './builder-config.ts';
import { formatFactLines } from './report/facts.ts';
import type { Scope } from './types.ts';

// Show the default folders before introducing the settings that move them.
const DEFAULT_PROJECTS_PATH = `YMB/${BUILDER_CONFIG.modsDirectoryName}`;
const DEFAULT_PREVIEW_PATH = `YMB/${BUILDER_CONFIG.buildDirectoryName}/${BUILDER_CONFIG.buildOutputDirectoryName}`;
const DEFAULT_RECOVERY_PATH = `YMB/${BUILDER_CONFIG.stateDirectoryName}`;
const DEFAULT_GAME_PATH = 'the WARNO mod folder containing GameData and CommonData';

export const CLI_COMMAND_NAMES = [
  'validate',
  'list',
  'explain',
  'find',
  'build',
  'sync',
  'recover',
  'doctor',
  'cleanup',
  'init',
] as const;

export type CliCommandName = (typeof CLI_COMMAND_NAMES)[number];

interface CommandGuide {
  name: CliCommandName;
  description: string;
  purpose: string;
  resultLabel?: string | undefined;
  resultPath?: string | undefined;
  whenToUse?: string[] | undefined;
  nextSteps?: string[] | undefined;
  examples: string[];
}

const COMMAND_GUIDES: CommandGuide[] = [
  {
    name: 'doctor',
    description: 'Check your folders and the files from your last sync.',
    purpose:
      'Shows the mod projects YMB can use, its output folders, and any tracked files changed outside YMB.',
    nextSteps: ['Check the paths, then run `build` to make a preview.'],
    examples: ['doctor'],
  },
  {
    name: 'validate',
    description: 'Check your changes without saving a preview.',
    purpose:
      'Checks settings, patch results, and script tests. YMB leaves the preview and WARNO mod files alone. Scripts can still update their own data and caches.',
    nextSteps: [
      'Run `build` to save the checked output as a preview.',
      'Use `explain` to see why a patch was included or skipped.',
    ],
    examples: ['validate', 'validate --mod my_pack'],
  },
  {
    name: 'list',
    description: 'List your mod projects and their patches.',
    purpose: 'Lists discovered project ids, patch ids, and whether each is enabled.',
    nextSteps: ['Copy an id into `--mod` or `--patch` to select it.'],
    examples: ['list'],
  },
  {
    name: 'explain',
    description: 'Show why each patch is included or skipped.',
    purpose: 'Shows which settings, filters, and dependencies decide whether a patch runs.',
    nextSteps: ['Fix the reported setting or selection, then run `build`.'],
    examples: ['explain', 'explain --scope dev'],
  },
  {
    name: 'find',
    description: 'Find NDF blocks by name, type, or field value.',
    purpose:
      'Searches the files your selected patches target, or the files you name with `--file`. Shows matching blocks and their paths without changing them.',
    whenToUse: [
      'You need a block name for a new patch.',
      'A game update changed a block your patch used to find.',
    ],
    nextSteps: ['Use the matching name in your selector, then run `build`.'],
    examples: [
      'find --name T80U',
      'find --type TAmmunitionDescriptor',
      'find --field Nationalite=USSR --file GameData/Generated/Gameplay/TacticalUnits.ndf',
    ],
  },
  {
    name: 'build',
    description: 'Check your changes and save a preview.',
    purpose:
      'Builds files you can inspect before applying them. YMB does not write to the WARNO mod folder; generation scripts may update their own data and caches.',
    resultLabel: 'Preview',
    resultPath: DEFAULT_PREVIEW_PATH,
    nextSteps: [
      'Open the preview and check the changed files.',
      'Apply the same selection with `sync --yes` when ready.',
    ],
    examples: ['build', 'build --mod my_pack'],
  },
  {
    name: 'sync',
    description: 'Rebuild and apply your changes to the WARNO mod folder.',
    purpose:
      "Builds from your current mod projects, saves originals, and updates the WARNO mod files. Run WARNO's GenerateMod.bat afterwards to compile them.",
    resultLabel: 'WARNO mod folder',
    resultPath: DEFAULT_GAME_PATH,
    nextSteps: [
      'Run GenerateMod.bat in the WARNO mod folder, then enable and test the mod in game.',
      'Use `recover --yes` to restore the saved originals.',
    ],
    examples: ['sync --yes', 'sync --mod my_pack --yes'],
  },
  {
    name: 'recover',
    description: 'Undo applied changes using the saved originals.',
    purpose:
      "Restores tracked files and removes additions from sync using `.ymb-state`. Filters choose whole files: recovering a shared file undoes every project's changes in that file.",
    resultLabel: 'Saved originals',
    resultPath: DEFAULT_RECOVERY_PATH,
    nextSteps: [
      'Sync the projects you want to keep if recovery touched shared files.',
      'Run GenerateMod.bat to compile the resulting files for the game.',
    ],
    examples: ['recover --yes', 'recover --mod my_pack --yes'],
  },
  {
    name: 'cleanup',
    description: 'Clear previews and caches.',
    purpose:
      'Deletes temporary build files. Saved originals stay unless you add `--all`, which removes your ability to undo a sync.',
    resultLabel: 'Temporary files',
    resultPath: `YMB/${BUILDER_CONFIG.buildDirectoryName}`,
    nextSteps: ['Run `build` to recreate a preview when you need one.'],
    examples: ['cleanup', 'cleanup --all --yes'],
  },
  {
    name: 'init',
    description: 'Create a mod project with working examples.',
    purpose:
      'Creates a welcome-screen patch, a text template, and a small generator with a test. Give the project a name here; change its settings afterwards.',
    resultLabel: 'Mod projects',
    resultPath: DEFAULT_PROJECTS_PATH,
    nextSteps: ['Run `build --mod <id>`, then open the preview folder.'],
    examples: ['init', 'init --id my_pack --name "My Pack"'],
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
  const flowGuides = ['doctor', 'build', 'sync'].map((name) =>
    getCommandGuide(name as CliCommandName),
  );
  // Numbered, but still a label beside a value, so the column comes from the
  // names themselves rather than a width someone measured once.
  const orderedFlow = formatFactLines(
    flowGuides.map((guide, index) => ({
      label: `${index + 1}. ${guide.name}`,
      value: guide.description,
    })),
    { indent: '  ' },
  );

  return [
    '',
    'First project: run `init`, or add a downloaded project to YMB/mods/.',
    '',
    'With a project installed:',
    ...orderedFlow,
    '',
    '  Build includes checks. After sync, run GenerateMod.bat in the WARNO mod folder.',
    '',
    'Default folders:',
    ...formatFactLines(
      [
        { label: 'mod projects', value: DEFAULT_PROJECTS_PATH },
        { label: 'preview', value: DEFAULT_PREVIEW_PATH },
        { label: 'WARNO mod', value: DEFAULT_GAME_PATH },
        { label: 'saved originals', value: DEFAULT_RECOVERY_PATH },
      ],
      { indent: '  ' },
    ),
    `  Set paths in ${BUILDER_CONFIG.builderConfigFileName} if your folders are elsewhere.`,
    '',
    'Useful commands:',
    ...formatFactLines(
      [
        { label: 'init', value: 'start a new mod project' },
        { label: 'list', value: 'find project and patch ids' },
        { label: 'explain', value: 'check why a patch runs or gets skipped' },
        { label: '<command> --help', value: 'options and examples' },
        { label: '<command> --mod ID', value: 'select one mod project' },
        { label: '<command> --json', value: 'structured output for scripts and AI agents' },
      ],
      { indent: '  ' },
    ),
    '',
  ].join('\n');
}

export function buildCommandHelpText(name: CliCommandName): string {
  const guide = getCommandGuide(name);
  const lines = ['', 'What it does:', `  ${guide.purpose}`];

  if (guide.resultLabel && guide.resultPath) {
    lines.push('', 'Where to look:', `  ${guide.resultLabel}: ${guide.resultPath}`);
  }
  if (guide.whenToUse && guide.whenToUse.length > 0) {
    lines.push('', 'Use it when:');
    lines.push(...guide.whenToUse.map((line) => `  - ${line}`));
  }
  if (guide.nextSteps && guide.nextSteps.length > 0) {
    lines.push('', 'Next:');
    lines.push(...guide.nextSteps.map((line) => `  - ${line}`));
  }
  if (guide.examples.length > 0) {
    lines.push('', 'Examples:');
    lines.push(...guide.examples.map((line) => `  ymb ${line}`));
  }
  lines.push('');
  return lines.join('\n');
}

export function describeScope(scope: Scope): string {
  return scope === 'dev' ? 'prod + dev patches' : 'prod patches only';
}
