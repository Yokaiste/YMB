import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { BUILDER_CONFIG } from './builder-config.ts';
import { resolveBuilderContext } from './config.ts';
import { ensure } from './errors.ts';
import { withOperationLock } from './operation-lock.ts';
import { createTemporarySiblingPath, pathExists } from './path-utils.ts';
import { recoverPendingStateTransactionOrThrow } from './state-transaction.ts';

export interface InitCommandOptions {
  id?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

interface InitAnswers {
  id: string;
  name: string;
  description?: string | undefined;
}

export async function runInit(
  builderPath: string | undefined,
  options: InitCommandOptions,
): Promise<string[]> {
  const context = await resolveBuilderContext(builderPath);
  const answers = await collectInitAnswers(options);
  return withOperationLock(context.ymbRoot, 'init', async () => {
    await recoverPendingStateTransactionOrThrow(context);
    const finalModRoot = path.join(context.modsRoot, answers.id);
    const stagedModRoot = createTemporarySiblingPath(finalModRoot);
    const configRoot = path.join(stagedModRoot, BUILDER_CONFIG.configDirectoryName);
    const patchRoot = path.join(configRoot, BUILDER_CONFIG.patchDirectoryName);
    const replaceRoot = path.join(configRoot, BUILDER_CONFIG.replaceDirectoryName);
    const modConfigPath = path.join(configRoot, BUILDER_CONFIG.modConfigFileName);
    const readmePath = path.join(stagedModRoot, 'README.md');
    const demoPatchRoot = path.join(patchRoot, 'ui', 'branding', 'welcome-view');
    const demoPatchPath = path.join(demoPatchRoot, BUILDER_CONFIG.patchConfigFileName);
    const demoScriptPath = path.join(configRoot, 'generate-build-info.ts');
    const demoScriptTestPath = path.join(configRoot, 'generate-build-info.test.ts');
    const demoLocalisationPath = path.join(
      replaceRoot,
      'GameData',
      'Localisation',
      '${modRootName}',
      'INTERFACE_OUTGAME.csv',
    );

    ensure(!(await pathExists(finalModRoot)), 'CommandError', {
      absolutePath: finalModRoot,
      reason: `The source mod folder \`${answers.id}\` already exists.`,
      suggestion:
        'Choose a different mod id or remove the existing folder before running `init` again.',
    });

    try {
      await mkdir(patchRoot, { recursive: true });
      await mkdir(replaceRoot, { recursive: true });
      await mkdir(demoPatchRoot, { recursive: true });
      await mkdir(path.dirname(demoLocalisationPath), { recursive: true });
      await Bun.write(modConfigPath, renderModConfig(answers));
      await Bun.write(demoPatchPath, renderDemoPatchConfig(answers));
      await Bun.write(demoScriptPath, renderDemoScript());
      await Bun.write(demoScriptTestPath, renderDemoScriptTest(answers));
      await Bun.write(demoLocalisationPath, renderDemoOutgameLocalisation());
      await Bun.write(readmePath, renderReadme(answers));
      await rename(stagedModRoot, finalModRoot);
    } catch (error) {
      await rm(stagedModRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const toFinalPath = (stagedPath: string) =>
      path.join(finalModRoot, path.relative(stagedModRoot, stagedPath));

    return [
      `Created source mod scaffold: ${answers.name}`,
      `Source mod id: ${answers.id}`,
      `Config file: ${normalizeDisplayPath(toFinalPath(modConfigPath))}`,
      `Patch root: ${normalizeDisplayPath(toFinalPath(patchRoot))}`,
      `Replace root: ${normalizeDisplayPath(toFinalPath(replaceRoot))}`,
      `Demo script: ${normalizeDisplayPath(toFinalPath(demoScriptPath))}`,
      `Demo script test: ${normalizeDisplayPath(toFinalPath(demoScriptTestPath))}`,
      `Demo patch: ${normalizeDisplayPath(toFinalPath(demoPatchPath))}`,
      `Demo localisation: ${normalizeDisplayPath(toFinalPath(demoLocalisationPath))}`,
      'Next step: run `validate` or `build` to preview the patch, replace, and generated starter outputs.',
    ];
  });
}

async function collectInitAnswers(options: InitCommandOptions): Promise<InitAnswers> {
  const initialName = normalizeOptionalText(options.name);
  const initialId = deriveInitId(initialName, options.id);
  const initialDescription = normalizeOptionalText(options.description);
  const missingValues = !initialName || !initialId || options.description === undefined;

  if (!missingValues) {
    return validateAnswers({
      name: initialName,
      id: initialId,
      description: initialDescription,
    });
  }

  ensure(input.isTTY && output.isTTY, 'CommandError', {
    absolutePath: 'init',
    reason: 'Interactive setup requires a TTY when required values are missing.',
    suggestion:
      'Run the command in a terminal, or pass `--name`, `--id`, and optionally `--description`.',
  });

  const prompt = createInterface({ input, output });
  try {
    const name = initialName ?? (await askQuestion(prompt, 'Mod display name'));
    const suggestedId = deriveInitId(name, options.id) ?? toSlug(name);
    const id = initialId ?? (await askQuestion(prompt, 'Mod id', suggestedId));
    const description =
      options.description !== undefined
        ? initialDescription
        : normalizeOptionalText(await askQuestion(prompt, 'Description (optional)', ''));

    return validateAnswers({ name, id, description });
  } finally {
    prompt.close();
  }
}

async function askQuestion(
  prompt: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
  const answer = (await prompt.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue || '';
}

function validateAnswers(answers: InitAnswers): InitAnswers {
  ensure(answers.name.length > 0, 'CommandError', {
    absolutePath: 'init',
    reason: 'The mod display name cannot be empty.',
    suggestion: 'Enter a readable source mod name such as `My Balance Pack`.',
  });

  ensure(/^[A-Za-z0-9._-]+$/.test(answers.id), 'CommandError', {
    absolutePath: answers.id,
    reason: 'The mod id may only contain letters, numbers, dots, underscores, and dashes.',
    suggestion: 'Use a stable id such as `my_balance_pack`.',
  });

  return answers;
}

function renderModConfig(answers: InitAnswers): string {
  const lines = ['version: 1', `id: ${answers.id}`, `name: ${quoteYamlString(answers.name)}`];
  if (answers.description) {
    lines.push(`description: ${quoteYamlString(answers.description)}`);
  }

  const welcomeTokenPrefix = toWelcomeTokenPrefix(answers.id);
  lines.push('dependsOn: []');
  lines.push('priority: 0');
  lines.push('allowWriteToModifiedFiles: false');
  lines.push('variables:');
  lines.push(`  welcomeTokenPrefix: ${quoteYamlString(welcomeTokenPrefix)}`);
  lines.push(
    `  welcomeTitleToken: ${quoteYamlString(`${templateVariable('welcomeTokenPrefix')}_T`)}`,
  );
  lines.push(
    `  welcomeInfoToken: ${quoteYamlString(`${templateVariable('welcomeTokenPrefix')}_I`)}`,
  );
  lines.push(
    `  generatedInfoTarget: ${quoteYamlString(
      `GameData/Generated/Gameplay/${templateVariable('modId')}/StarterInfo.ndf`,
    )}`,
  );
  lines.push('enabled: true');
  lines.push('scripts:');
  lines.push(`  - path: ${quoteYamlString('generate-build-info.ts')}`);
  lines.push('    tests:');
  lines.push(`      - ${quoteYamlString('generate-build-info.test.ts')}`);
  return `${lines.join('\n')}\n`;
}

function renderReadme(answers: InitAnswers): string {
  return `# ${answers.name}

This source mod was created by \`init\` in the YMB portable shell and is meant to be a safe, beginner-friendly starting point.

> If YMB itself is not set up yet, read its getting-started and installation instructions first before you build this source mod.

## What This Scaffold Shows

The starter project demonstrates the three main ways YMB produces output:

- a focused patch
- a whole-file replace template
- a generated output with a companion script test

## Layout

\`\`\`text
${answers.id}/
  config/
    ymb.mod.yaml
    generate-build-info.ts
    generate-build-info.test.ts
    patch/
      ui/branding/welcome-view/ymb.patch.yaml
    replace/
      GameData/Localisation/\${modRootName}/INTERFACE_OUTGAME.csv
\`\`\`

## Start Here

- \`ymb.mod.yaml\`: source mod metadata, shared variables, and script registration
- \`generate-build-info.ts\`: a small generator that writes \`StarterInfo.ndf\`
- \`generate-build-info.test.ts\`: the script test format run by \`validate\`, \`build\`, and \`sync\`
- \`patch/ui/branding/welcome-view/ymb.patch.yaml\`: a simple patch that uses template variables
- \`replace/GameData/Localisation/\${modRootName}/INTERFACE_OUTGAME.csv\`: a replace template that uses built-in variables and expressions

## Next Steps

1. Run \`validate --mod ${answers.id}\`.
2. Run \`build --mod ${answers.id}\` to preview the starter output.
3. Open \`ymb.mod.yaml\` first and decide which starter names, variables, and descriptions you want to keep.
4. Add new patches under \`config/patch\`, replace files under \`config/replace\`, and scripts beside the config that owns them.
`;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function deriveInitId(
  displayName: string | undefined,
  explicitId: string | undefined,
): string | undefined {
  const normalizedExplicitId = normalizeOptionalText(explicitId);
  if (normalizedExplicitId) {
    return normalizedExplicitId;
  }

  return normalizeOptionalText(toSlug(displayName ?? ''));
}

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function toTokenPrefix(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function toWelcomeTokenPrefix(value: string): string {
  return toTokenPrefix(value).slice(0, 8) || 'YMB';
}

function renderDemoPatchConfig(answers: InitAnswers): string {
  return `version: 1
id: ${quoteYamlString('ui.branding.welcome_view')}
name: ${quoteYamlString('Welcome View Demo')}
description: ${quoteYamlString(`Adds a small starter welcome block for ${answers.name}.`)}
enabled: true
scope: 'prod'
dependsOn: []
targets:
  - file: 'GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf'
    operations:
      - op: 'add'
        selector:
          kind: 'collection'
          by: 'path'
          value: 'UISpecificOutGameWelcomeDescriptor.Components'
        value:
          $raw: |-
            BUCKTextDescriptor
            (
                ElementName = "MainMenuTitle${toSafeNdfIdentifier(answers.id)}"
                ComponentFrame = TUIFramePropertyRTTI
                (
                    MagnifiableWidthHeight = [1500.0, 90.0]
                    AlignementToAnchor = [0.5, 0.15]
                    AlignementToFather = [0.5, 0.15]
                )
                ParagraphStyle = TParagraphStyle
                (
                    VerticalAlignment = ~/UIText_VerticalCenter
                    Alignment = ~/UIText_Center
                )
                TextColor = "ListeExcel/Cartouche"
                TextSize  = "50"
                TextStyle = "Default"
                TypefaceToken = "UIMainFont"
                TextDico = ~/LocalisationConstantes/dico_interface_outgame
                TextToken = "${templateVariable('welcomeTitleToken')}"

                Components =
                [
                    BUCKSpecificHintableArea
                    (
                        HintTitleToken = '${templateVariable('welcomeTitleToken')}'
                        HintBodyToken = '${templateVariable('welcomeInfoToken')}'
                        DicoToken = ~/LocalisationConstantes/dico_interface_outgame
                    ),
                ]
            ),
`;
}

function renderDemoOutgameLocalisation(): string {
  return `"TOKEN";"REFTEXT"

"${templateVariable('welcomeTitleToken')}";"${templateVariable('modName')}"
"${templateVariable('welcomeInfoToken')}";"${templateVariable(
    "modDescription || 'Starter scaffold generated by YMB.'",
  )}"
`;
}

function renderDemoScript(): string {
  return `import type { BuildScriptContext, GeneratedScriptFile } from 'ymb/api';

export default async function generateBuildInfo(
  context: BuildScriptContext,
): Promise<GeneratedScriptFile> {
  const targetRelativePath = readRequiredStringVariable(context.variables, 'generatedInfoTarget');
  const description = context.mod.description || 'Starter scaffold generated by YMB.';
  const blockName = buildStarterBlockName(context.mod.id);

  return {
    targetRelativePath,
    content: \`\${blockName} is TGeneratedModInfo
(
    ModId = \${JSON.stringify(context.mod.id)}
    ModName = \${JSON.stringify(context.mod.name)}
    Description = \${JSON.stringify(description)}
)
\`,
  };
}

function readRequiredStringVariable(
  variables: Record<string, unknown>,
  variableName: string,
): string {
  const value = variables[variableName];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(\`Expected string variable "\${variableName}" in generate-build-info.ts.\`);
}

function buildStarterBlockName(modId: string): string {
  const normalizedModId = modId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return \`StarterBuildInfo_\${normalizedModId || 'YMB'}\`;
}
`;
}

function renderDemoScriptTest(answers: InitAnswers): string {
  const demoBlockName = `StarterBuildInfo_${toSafeNdfIdentifier(answers.id)}`;
  const expectedTarget = `GameData/Generated/Gameplay/${answers.id}/StarterInfo.ndf`;
  return [
    "import type { BuildScriptTestContext, GeneratedScriptFile, ScriptTestResult } from 'ymb/api';",
    "import generateBuildInfo from './generate-build-info.ts';",
    '',
    'export default async function testGenerateBuildInfo(',
    '  context: BuildScriptTestContext,',
    '): Promise<{ results: ScriptTestResult[] }> {',
    '  const generated = (await generateBuildInfo(context)) as GeneratedScriptFile;',
    '',
    '  return {',
    '    results: [',
    `      generated.targetRelativePath === '${expectedTarget}'`,
    '        ? {',
    "            name: 'writes the expected target path',",
    "            status: 'passed',",
    '          }',
    '        : {',
    "            name: 'writes the expected target path',",
    "            status: 'failed',",
    "            reason: 'The generated target path changed unexpectedly.',",
    "            suggestion: 'Keep the generatedInfoTarget variable aligned with the script output path.',",
    '            details: [`Actual path: ${generated.targetRelativePath}`],',
    '          },',
    `      typeof generated.content === 'string' && generated.content.includes('${demoBlockName}')`,
    '        ? {',
    "            name: 'includes the starter block name',",
    "            status: 'passed',",
    '          }',
    '        : {',
    "            name: 'includes the starter block name',",
    "            status: 'failed',",
    "            reason: 'The generated build info no longer includes the expected starter block name.',",
    "            suggestion: 'Update the script intentionally, then update this test to match.',",
    '          },',
    `      typeof generated.content === 'string' && generated.content.includes(${JSON.stringify(answers.name)})`,
    '        ? {',
    "            name: 'includes the mod display name',",
    "            status: 'passed',",
    '          }',
    '        : {',
    "            name: 'includes the mod display name',",
    "            status: 'failed',",
    "            reason: 'The generated build info no longer includes the source mod display name.',",
    "            suggestion: 'Keep the generated output tied to the mod metadata, or update the test intentionally.',",
    '          },',
    '    ],',
    '  };',
    '}',
    '',
  ].join('\n');
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function toSafeNdfIdentifier(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return compact || 'YMB';
}

function templateVariable(expression: string): string {
  return `\${${expression}}`;
}

function normalizeDisplayPath(value: string): string {
  return value.replaceAll('\\', '/');
}
