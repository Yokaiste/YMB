import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { ensure, YmbError } from './errors.ts';
import { normalizeRelativePath, removePathDirectly } from './path-utils.ts';
import type { BuilderContext, PatchApplication } from './types.ts';

export interface PatchContribution {
  application: PatchApplication;
  targetRelativePath: string;
  hasScripts: boolean;
  previewContent: string;
}

interface PatchPriorityOption {
  modId: string;
  modName: string;
  patchIds: string[];
  previewContent: string;
}

interface PatchPriorityRequest {
  context: BuilderContext;
  targetRelativePath: string;
  baseContent: string;
  options: PatchPriorityOption[];
}

type PatchPriorityResolver = (request: PatchPriorityRequest) => Promise<string>;

let testResolver: PatchPriorityResolver | undefined;

export function setPatchPriorityResolverForTesting(
  resolver: PatchPriorityResolver | undefined,
): void {
  testResolver = resolver;
}

export async function resolvePrioritizedModId(
  context: BuilderContext,
  targetRelativePath: string,
  baseContent: string,
  contributions: PatchContribution[],
): Promise<string | undefined> {
  const options = createPriorityOptions(contributions);
  if (options.length <= 1) {
    return options[0]?.modId;
  }

  const request: PatchPriorityRequest = {
    context,
    targetRelativePath,
    baseContent,
    options,
  };

  if (testResolver) {
    return await testResolver(request);
  }

  return await promptForPriority(request);
}

function createPriorityOptions(contributions: PatchContribution[]): PatchPriorityOption[] {
  const optionMap = new Map<string, PatchPriorityOption>();

  for (const contribution of contributions) {
    const modId = contribution.application.mod.config.id;
    const patchId = contribution.application.patch.config.id;
    const existing = optionMap.get(modId);
    if (existing) {
      if (!existing.patchIds.includes(patchId)) {
        existing.patchIds.push(patchId);
      }
      continue;
    }

    optionMap.set(modId, {
      modId,
      modName: contribution.application.mod.config.name,
      patchIds: [patchId],
      previewContent: contribution.previewContent,
    });
  }

  return [...optionMap.values()].sort((left, right) => left.modId.localeCompare(right.modId));
}

async function promptForPriority(request: PatchPriorityRequest): Promise<string> {
  ensure(input.isTTY && output.isTTY, 'CommandError', {
    absolutePath: normalizeRelativePath(request.targetRelativePath),
    reason: `Patch priority selection for \`${request.targetRelativePath}\` requires an interactive terminal.`,
    suggestion:
      'Re-run the command in an interactive terminal so you can choose a winning mod, or narrow the selected patches to avoid the conflict.',
  });

  const previewPath = await writePreviewFile(request);
  const choices = request.options.map((option, index) => ({
    label: toAlphaLabel(index),
    option,
  }));
  const cancelLabel = toAlphaLabel(choices.length);
  const question = [
    `Patch priority required for ${request.targetRelativePath}`,
    `Open diff preview: file:///${previewPath.replaceAll('\\', '/')}`,
    'Choose which mod should get overwrite priority for this file:',
    ...choices.map(
      ({ label, option }) =>
        `  ${label}: ${option.modId} (${option.modName}) | patches: ${option.patchIds.join(', ')}`,
    ),
    `  ${cancelLabel}: cancel build`,
    'Selection:',
  ].join('\n');

  const terminal = readline.createInterface({ input, output });
  try {
    while (true) {
      const raw = (await terminal.question(`${question} `)).trim().toUpperCase();
      if (raw === cancelLabel) {
        throw new YmbError('CommandError', {
          absolutePath: normalizeRelativePath(request.targetRelativePath),
          reason: `Patch priority selection was cancelled for \`${request.targetRelativePath}\`.`,
          suggestion: 'Re-run the command and choose a prioritized mod, or narrow the selection.',
        });
      }

      const chosen = choices.find((entry) => entry.label === raw);
      if (chosen) {
        return chosen.option.modId;
      }
    }
  } finally {
    terminal.close();
    await removePathDirectly(previewPath).catch(() => undefined);
  }
}

async function writePreviewFile(request: PatchPriorityRequest): Promise<string> {
  const previewRoot = path.join(request.context.buildRoot, 'conflicts');
  await mkdir(previewRoot, { recursive: true });
  const fileName = sanitizeFileName(request.targetRelativePath).concat('.diff.md');
  const previewPath = path.join(previewRoot, fileName);
  const sections = [
    `# Patch Priority Preview`,
    '',
    `- Target: \`${request.targetRelativePath}\``,
    `- Base file: \`${request.targetRelativePath}\``,
    '',
    '## Base Snapshot',
    '',
    '```ndf',
    request.baseContent,
    '```',
  ];

  for (const [index, option] of request.options.entries()) {
    sections.push(
      '',
      `## ${toAlphaLabel(index)}. ${option.modId} (${option.modName})`,
      '',
      `Patches: ${option.patchIds.join(', ')}`,
      '',
      '```diff',
      createSimpleDiff(request.baseContent, option.previewContent, option.modId),
      '```',
    );
  }

  await Bun.write(previewPath, sections.join('\n'));
  return previewPath;
}

function createSimpleDiff(baseContent: string, nextContent: string, label: string): string {
  if (baseContent === nextContent) {
    return `--- base\n+++ ${label}\n(no textual differences)`;
  }

  const baseLines = baseContent.split('\n');
  const nextLines = nextContent.split('\n');
  let prefixLength = 0;
  while (
    prefixLength < baseLines.length &&
    prefixLength < nextLines.length &&
    baseLines[prefixLength] === nextLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < baseLines.length - prefixLength &&
    suffixLength < nextLines.length - prefixLength &&
    baseLines[baseLines.length - 1 - suffixLength] ===
      nextLines[nextLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const baseSlice = baseLines.slice(prefixLength, baseLines.length - suffixLength);
  const nextSlice = nextLines.slice(prefixLength, nextLines.length - suffixLength);
  return [
    '--- base',
    `+++ ${label}`,
    `@@ line ${prefixLength + 1} @@`,
    ...baseSlice.map((line) => `-${line}`),
    ...nextSlice.map((line) => `+${line}`),
  ].join('\n');
}

function toAlphaLabel(index: number): string {
  let current = index;
  let result = '';

  do {
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return result;
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, '_').replaceAll(/^_+|_+$/g, '');
}
