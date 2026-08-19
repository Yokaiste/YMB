import { BUILDER_CONFIG } from './builder-config.ts';
import { formatFactLines } from './report/facts.ts';
import type { Scope } from './types.ts';

// Beginners read help before they have opened any config file, so places are
// described by where they actually live in a default install, with the setting
// that moves them mentioned only as a footnote.
const DEFAULT_SOURCE_MODS_PATH = `YMB/${BUILDER_CONFIG.modsDirectoryName}`;
const DEFAULT_PREVIEW_PATH = `YMB/${BUILDER_CONFIG.buildDirectoryName}/${BUILDER_CONFIG.buildOutputDirectoryName}`;
const DEFAULT_RECOVERY_PATH = `YMB/${BUILDER_CONFIG.stateDirectoryName}`;
const DEFAULT_GAME_PATH = 'the mod folder holding GameData and CommonData';

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
    description: 'Check that YMB found your game folder and your mods.',
    purpose:
      'Shows every folder YMB will read from and write to. Run it first, and any time something looks wrong.',
    nextSteps: ['Run `validate` once the folders look right.'],
    examples: ['doctor'],
  },
  {
    name: 'validate',
    description: 'Check your mods for mistakes. Changes nothing.',
    purpose:
      'Reads your configs, applies your patches in memory, runs your script tests, and reports anything broken. No file is written.',
    nextSteps: [
      'Run `build` to see the finished files.',
      'Run `explain` if a patch is missing or unexpectedly included.',
    ],
    examples: ['validate', 'validate --mod my_pack'],
  },
  {
    name: 'list',
    description: 'Show the mods and patches YMB can see.',
    purpose: 'A quick inventory when you are not sure what YMB has found.',
    nextSteps: ['Use `explain` when something is missing from the list.'],
    examples: ['list'],
  },
  {
    name: 'explain',
    description: 'Say why each patch was included or skipped.',
    purpose:
      'Answers "why is my patch not applying" by naming the filter, scope, or dependency responsible.',
    nextSteps: ['Adjust `--mod`, `--patch`, `--scope`, or `dependsOn`, then run `build`.'],
    examples: ['explain', 'explain --scope dev'],
  },
  {
    name: 'find',
    description: 'Search the game files for a block, so you can write a selector for it.',
    purpose:
      'Lists the top-level blocks matching a name, a type, or a field value, and where each one lives. Changes nothing.',
    whenToUse: [
      'You need the exact name of a unit, weapon, or texture to target.',
      'A selector stopped matching and you want to see what the file holds now.',
    ],
    nextSteps: ['Copy a name into a selector, then run `validate`.'],
    examples: [
      'find --name T80U',
      'find --type TAmmunitionDescriptor',
      'find --field Nationalite=USSR --file GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf',
    ],
  },
  {
    name: 'build',
    description: 'Write the finished files to a preview folder. Your game stays untouched.',
    purpose:
      'Produces exactly what would be installed, in a folder you can open and read, so you can check it before anything reaches the game.',
    resultLabel: 'Preview',
    resultPath: DEFAULT_PREVIEW_PATH,
    nextSteps: [
      'Open the preview folder and read the files you changed.',
      'Run `sync --yes` once the preview looks right.',
    ],
    examples: ['build', 'build --mod my_pack'],
  },
  {
    name: 'sync',
    description: 'Install the built files into your game mod.',
    purpose:
      'Copies the reviewed result into the live mod and saves the untouched originals so `recover` can put them back.',
    resultLabel: 'Game mod',
    resultPath: DEFAULT_GAME_PATH,
    nextSteps: ['Start WARNO and test the mod.', 'Run `recover --yes` to undo this later.'],
    examples: ['sync --yes', 'sync --mod my_pack --yes'],
  },
  {
    name: 'recover',
    description: 'Undo a sync and put the original game files back.',
    purpose: 'Restores the originals YMB saved during sync, and removes files it created.',
    resultLabel: 'Saved originals',
    resultPath: DEFAULT_RECOVERY_PATH,
    nextSteps: ['Run `build` again if you want a fresh preview afterwards.'],
    examples: ['recover --yes', 'recover --mod my_pack --yes'],
  },
  {
    name: 'cleanup',
    description: 'Delete temporary build files. Keeps everything needed to undo a sync.',
    purpose:
      'Frees disk space taken by previews and caches. The saved originals are kept unless you ask for `--all`.',
    resultLabel: 'Temporary files',
    resultPath: `YMB/${BUILDER_CONFIG.buildDirectoryName}`,
    nextSteps: ['Run `build` again whenever you need the preview back.'],
    examples: ['cleanup', 'cleanup --all --yes'],
  },
  {
    name: 'init',
    description: 'Create a starter mod you can edit and build straight away.',
    purpose:
      'Writes a small working example with a patch, a replaced file, a script, and a test, so you can see how each piece fits.',
    resultLabel: 'Your mods',
    resultPath: DEFAULT_SOURCE_MODS_PATH,
    nextSteps: [
      'Run `validate --mod <id>` on the new mod.',
      'Run `build --mod <id>` and read what it produced.',
    ],
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
  const flowGuides = ['doctor', 'validate', 'build', 'sync'].map((name) =>
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
    'New here? Do this:',
    ...orderedFlow,
    '',
    '  Nothing touches your game until step 4, and `recover` undoes step 4.',
    '',
    'Where things live:',
    ...formatFactLines(
      [
        { label: 'your mods', value: DEFAULT_SOURCE_MODS_PATH },
        { label: 'preview', value: DEFAULT_PREVIEW_PATH },
        { label: 'your game', value: DEFAULT_GAME_PATH },
        { label: 'undo data', value: DEFAULT_RECOVERY_PATH },
      ],
      { indent: '  ' },
    ),
    `  (change these in ${BUILDER_CONFIG.builderConfigFileName})`,
    '',
    'Handy:',
    ...formatFactLines(
      [
        { label: 'init', value: 'create a starter mod to learn from' },
        { label: 'list', value: 'show what YMB found' },
        { label: 'explain', value: 'say why a patch was skipped' },
        { label: '<command> --help', value: 'details for one command' },
        { label: '<command> --mod ID', value: 'work on a single mod' },
        { label: '<command> --json', value: 'one JSON result, for scripts' },
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
    lines.push('', 'Usually next:');
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
