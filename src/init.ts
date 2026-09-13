import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { BUILDER_CONFIG } from './builder-config.ts';
import { resolveBuilderContext } from './config/layout.ts';
import { ensure } from './errors.ts';
import { withOperationLock } from './operation-lock.ts';
import { createTemporarySiblingPath, pathExists } from './path-utils.ts';
import { recoverPendingStateTransactionOrThrow } from './state-transaction.ts';

export interface InitCommandOptions {
  interactive?: boolean | undefined;
  id?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

interface InitAnswers {
  id: string;
  name: string;
  description?: string | undefined;
}

export interface InitResult {
  data?: { id: string; name: string; path: string; files: string[] } | undefined;
  modsRoot: string;
  lines: string[];
}

export async function runInit(
  builderPath: string | undefined,
  options: InitCommandOptions,
): Promise<InitResult> {
  const context = await resolveBuilderContext(builderPath);
  const answers = await collectInitAnswers(options);
  return withOperationLock(context.operationLockRoot, 'init', async () => {
    await recoverPendingStateTransactionOrThrow(context);
    const finalModRoot = path.join(context.modsRoot, answers.id);
    const stagedModRoot = createTemporarySiblingPath(finalModRoot);
    const configRoot = path.join(stagedModRoot, BUILDER_CONFIG.configDirectoryName);
    const patchRoot = path.join(configRoot, BUILDER_CONFIG.patchDirectoryName);
    const replaceRoot = path.join(configRoot, BUILDER_CONFIG.replaceDirectoryName);
    const configFilePath = path.join(configRoot, BUILDER_CONFIG.modConfigFileName);
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
      await Bun.write(configFilePath, renderModConfig(answers));
      await Bun.write(demoPatchPath, renderDemoPatchConfig(answers));
      await Bun.write(demoScriptPath, renderDemoScript());
      await Bun.write(demoScriptTestPath, renderDemoScriptTest());
      await Bun.write(demoLocalisationPath, renderDemoOutgameLocalisation());
      const docsPath = path.relative(finalModRoot, path.join(context.ymbRoot, 'docs'));
      await Bun.write(readmePath, renderReadme(answers, docsPath));
      await rename(stagedModRoot, finalModRoot);
    } catch (error) {
      await rm(stagedModRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const toFinalPath = (stagedPath: string) =>
      path.join(finalModRoot, path.relative(stagedModRoot, stagedPath));

    return {
      data: {
        id: answers.id,
        name: answers.name,
        path: finalModRoot,
        files: [
          configFilePath,
          demoPatchPath,
          demoScriptPath,
          demoScriptTestPath,
          demoLocalisationPath,
          readmePath,
        ].map(toFinalPath),
      },
      modsRoot: context.modsRoot,
      lines: [
        `Created source mod scaffold: ${answers.name}`,
        `Source mod id: ${answers.id}`,
        `Config file: ${normalizeDisplayPath(toFinalPath(configFilePath))}`,
        `Patch root: ${normalizeDisplayPath(toFinalPath(patchRoot))}`,
        `Replace root: ${normalizeDisplayPath(toFinalPath(replaceRoot))}`,
        `Demo script: ${normalizeDisplayPath(toFinalPath(demoScriptPath))}`,
        `Demo script test: ${normalizeDisplayPath(toFinalPath(demoScriptTestPath))}`,
        `Demo patch: ${normalizeDisplayPath(toFinalPath(demoPatchPath))}`,
        `Demo localisation: ${normalizeDisplayPath(toFinalPath(demoLocalisationPath))}`,
        'Next step: run `validate` or `build` to preview the patch, replace, and generated starter outputs.',
      ],
    };
  });
}

async function collectInitAnswers(options: InitCommandOptions): Promise<InitAnswers> {
  const initialName = normalizeOptionalText(options.name);
  const initialId = deriveInitId(initialName, options.id);
  const initialDescription = normalizeOptionalText(options.description);
  // A description is optional; complete CLI arguments must never open a prompt.
  if (initialName && initialId) {
    return validateAnswers({
      name: initialName,
      id: initialId,
      description: initialDescription,
    });
  }

  ensure(options.interactive !== false && input.isTTY && output.isTTY, 'CommandError', {
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

function renderReadme(answers: InitAnswers, docsPath: string): string {
  const docsLink = normalizeDisplayPath(docsPath).split('/').map(encodeURIComponent).join('/');
  return `# ${answers.name}

**${answers.description ?? 'Your starting point for a personal WARNO mod.'}**

Make the welcome screen yours, replace text, and generate new game data with YMB.
This starter connects three small examples you can build on:

| Change | What you get |
| --- | --- |
| Welcome screen | A title and description drawn from your mod settings |
| Localisation | A text template that follows your mod's name |
| Generated data | A small script with independent sample tests |

[Explore the settings](config/ymb.mod.yaml) · [Make your first build](${docsLink}/getting-started.md) · [Customize with YMB](${docsLink}/configuration.md)

Use this page to show players what your mod does as it grows. Keep instructions in docs.
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

function renderDemoScriptTest(): string {
  return `import type { BuildScriptTestContext, ScriptTestResult } from 'ymb/api';
import generateBuildInfo from './generate-build-info.ts';

export default async function testGenerateBuildInfo(
  context: BuildScriptTestContext,
): Promise<{ results: ScriptTestResult[] }> {
  const name = 'Sample "Orchid" Pack';
  const target = 'GameData/Generated/Example.ndf';
  const generated = await generateBuildInfo({
    ...context,
    mod: { ...context.mod, id: 'sample_orchid', name, description: 'A sample description.' },
    variables: { ...context.variables, generatedInfoTarget: target },
  });
  const checks: Array<[string, boolean]> = [
    ['uses the configured destination', generated.targetRelativePath === target],
    ['preserves and escapes the display name', typeof generated.content === 'string' && generated.content.includes(JSON.stringify(name))],
  ];
  return {
    results: checks.map(([name, passed]) => ({
      name,
      status: passed ? 'passed' : 'failed',
      ...(passed ? {} : {
        reason: 'The generator did not preserve its sample input.',
        suggestion: 'Check how the generator reads the destination and mod metadata.',
      }),
    })),
  };
}
`;
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
