import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { ensure, YmbError } from './errors.ts';
import { normalizeRelativePath, removePathDirectly, writeFileAtomic } from './path-utils.ts';
import type { BuilderContext, PatchApplication } from './types.ts';

interface PatchContribution {
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

const MAX_PRIORITY_PROMPT_ATTEMPTS = 10;

let testResolver: PatchPriorityResolver | undefined;

export function setPatchPriorityResolverForTests(
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
    reason: `${request.options.length} source mods patch \`${request.targetRelativePath}\` with changes YMB could not merge on its own, and picking a winner requires an interactive terminal.`,
    suggestion:
      'Make the layering deliberate so no choice is needed: set `allowWriteToModifiedFiles: true` on the mod that should write on top, and give it a higher `priority` or a `dependsOn` entry naming the other mod, so it patches that output instead of competing with it. Otherwise narrow the build with `--mod`/`--patch`, or re-run in an interactive terminal to choose once.',
    details: request.options.map(
      (option) => `${option.modId} (${option.modName}) | patches: ${option.patchIds.join(', ')}`,
    ),
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

  const validLabels = [...choices.map((entry) => entry.label), cancelLabel].join(', ');
  const terminal = readline.createInterface({ input, output });
  try {
    // A closed or piped stdin answers instantly and forever, so give up instead of
    // spinning on an unanswerable question.
    for (let attempt = 0; attempt < MAX_PRIORITY_PROMPT_ATTEMPTS; attempt += 1) {
      const raw = (
        await terminal.question(attempt === 0 ? `${question} ` : `Selection (${validLabels}): `)
      )
        .trim()
        .toUpperCase();
      if (raw === cancelLabel) {
        throw createPriorityPromptError(
          request,
          'Patch priority selection was cancelled',
          'Re-run the command and choose a prioritized mod, or narrow the selection.',
        );
      }

      const chosen = choices.find((entry) => entry.label === raw);
      if (chosen) {
        return chosen.option.modId;
      }
      output.write(`Unrecognized selection \`${raw}\`. Expected one of: ${validLabels}.\n`);
    }

    throw createPriorityPromptError(
      request,
      `Patch priority selection got no valid answer after ${MAX_PRIORITY_PROMPT_ATTEMPTS} attempts`,
      `Re-run the command in an interactive terminal and answer with one of: ${validLabels}.`,
    );
  } finally {
    terminal.close();
    await removePathDirectly(previewPath).catch(() => undefined);
  }
}

function createPriorityPromptError(
  request: PatchPriorityRequest,
  reason: string,
  suggestion: string,
): YmbError {
  return new YmbError('CommandError', {
    absolutePath: normalizeRelativePath(request.targetRelativePath),
    reason: `${reason} for \`${request.targetRelativePath}\`.`,
    suggestion,
  });
}

async function writePreviewFile(request: PatchPriorityRequest): Promise<string> {
  const previewRoot = request.context.conflictPreviewRoot;
  await mkdir(previewRoot, { recursive: true });
  const previewPath = path.join(
    previewRoot,
    `${sanitizeFileName(request.targetRelativePath)}.diff.md`,
  );
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

  await writeFileAtomic(previewPath, sections.join('\n'));
  return previewPath;
}

/**
 * The whole file is too much to read at a prompt, so the preview trims the
 * lines both versions share and shows only the span that differs.
 */
export function createSimpleDiff(baseContent: string, nextContent: string, label: string): string {
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

/** `A`..`Z`, then `AA`, so a target with more than 26 contributors still labels. */
export function toAlphaLabel(index: number): string {
  let current = index;
  let result = '';

  do {
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return result;
}

export function sanitizeFileName(value: string): string {
  const sanitized = value.replaceAll(/[^A-Za-z0-9._-]+/g, '_').replaceAll(/^_+|_+$/g, '');
  // A target made only of separators would collapse to an empty, hidden file name.
  return sanitized.length > 0 ? sanitized : 'target';
}
