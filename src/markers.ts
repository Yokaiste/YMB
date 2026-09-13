import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import { YmbError } from './errors.ts';
import { toPathKey, writeFileAtomic } from './path-utils.ts';
import {
  appendLines,
  describeTextChangesCooperative,
  splitTextLines,
  type TextChangeBudgetOptions,
  type TextLineEdit,
} from './text-merge.ts';
import type { BuildContributor, SyncManifest } from './types.ts';

const manifestFileName = BUILDER_CONFIG.recoveryManifestFileName;

interface MarkerCommentStyle {
  startLine: (payload: string) => string;
  endLine: (payload: string) => string;
  commentLine: (content: string) => string;
  startPattern: RegExp;
  endPattern: RegExp;
  /** The literal opening the end delimiter, for finding it without a scan. */
  endMarkerText: string;
}

interface MarkerPayload {
  markerId: string;
  markerHash: string;
  builderId: string;
  contributors: BuildContributor[];
}

const contributorSchema = z.object({
  modId: z.string(),
  modName: z.string().optional(),
  patchId: z.string().optional(),
});

const markerPayloadSchema: z.ZodType<MarkerPayload> = z.object({
  markerId: z.string().regex(/^[a-f0-9]{64}$/),
  markerHash: z.string().regex(/^[a-f0-9]{64}$/),
  builderId: z.string().regex(/^[a-f0-9]{16}$/),
  contributors: z.array(contributorSchema),
});

const manifestEntrySchema = z.object({
  targetRelativePath: z
    .string()
    .refine(
      (value) =>
        (value.startsWith('GameData/') || value.startsWith('CommonData/')) &&
        !value.includes('\\') &&
        !value.split('/').includes('..'),
      'Target must be a normalized game-relative path under GameData or CommonData.',
    ),
  backupFileName: z.string().regex(/^[a-f0-9]{64}\.(?:ndf|bin)$/),
  originalExists: z.boolean().optional().default(true),
  expectedState: z.enum(['present', 'absent']).optional().default('present'),
  originalContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  syncedContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  contributors: z.array(contributorSchema),
});

const manifestSchema: z.ZodType<SyncManifest> = z
  .object({
    entries: z.array(manifestEntrySchema).default([]),
  })
  .superRefine((manifest, context) => {
    const seenTargets = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      const targetKey = toPathKey(entry.targetRelativePath);
      if (seenTargets.has(targetKey)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'targetRelativePath'],
          message: 'Recovery manifest contains duplicate case-insensitive target paths.',
        });
      }
      seenTargets.add(targetKey);
    }
  });

/**
 * One comment syntax, spelled once. The line writers and the patterns that read
 * them back are all derived from the same opener and closer, so a style cannot
 * come to write something its own reader does not accept.
 */
function createMarkerCommentStyle(opener: string, closer = ''): MarkerCommentStyle {
  const name = BUILDER_CONFIG.name;
  const delimiterPattern = (kind: 'START' | 'END') =>
    `${RegExp.escape(`${opener}${name}-${kind} `)}(.+)${RegExp.escape(closer)}`;
  return {
    startLine: (payload) => `${opener}${name}-START ${payload}${closer}`,
    endLine: (payload) => `${opener}${name}-END ${payload}${closer}`,
    commentLine: (content) => `${opener}${content}${closer}`,
    startPattern: new RegExp(`^${delimiterPattern('START')}\\r?\\n`),
    endPattern: new RegExp(`\\r?\\n${delimiterPattern('END')}\\r?\\n?$`),
    endMarkerText: `${opener}${name}-END `,
  };
}

const markerCommentStyles: MarkerCommentStyle[] = [
  createMarkerCommentStyle('// '),
  createMarkerCommentStyle('# '),
  createMarkerCommentStyle('; '),
  createMarkerCommentStyle('<!-- ', ' -->'),
];

export function supportsMarkerComments(targetRelativePath: string): boolean {
  return resolveMarkerCommentStyle(targetRelativePath) !== undefined;
}

export function renderOriginalSnippetComments(
  originalSnippet: string,
  indent: string,
  targetRelativePath: string,
): string {
  const style = resolveMarkerCommentStyle(targetRelativePath);
  if (!style) {
    throw new Error(
      `YMB cannot render original snippet comments for ${targetRelativePath} because this file type has no supported comment syntax.`,
    );
  }

  const lines = splitTextLines(originalSnippet.replace(/\r\n/g, '\n').replace(/\n+$/g, ''));
  return [
    `${indent}${style.commentLine('YMB-ORIGINAL')}`,
    ...lines.map((line) => `${indent}${style.commentLine(stripLineEnding(line))}`),
  ].join('\n');
}

export function createBuilderId(builderRoot: string): string {
  return createHash('sha256').update(builderRoot).digest('hex').slice(0, 16);
}

export function wrapWithMarker(
  content: string,
  payload: MarkerPayload,
  targetRelativePath: string,
): string {
  const style = resolveMarkerCommentStyle(targetRelativePath);
  if (!style) {
    throw new Error(
      `YMB cannot add in-file markers to ${targetRelativePath} because this file type has no supported comment syntax.`,
    );
  }

  const encoded = JSON.stringify(payload);
  return `${style.startLine(encoded)}\n${content}${content.endsWith('\n') ? '' : '\n'}${style.endLine(encoded)}\n`;
}

interface InlineChangeMarkerResult {
  content: string;
  warning?: 'exact_change_budget_exceeded' | undefined;
}

export async function decorateTextWithExactMarkersCooperative(
  baseText: string,
  nextText: string,
  targetRelativePath: string,
  builderId: string,
  contributors: BuildContributor[],
  yieldController: CooperativeYieldController,
  budgets: TextChangeBudgetOptions,
): Promise<InlineChangeMarkerResult> {
  const style = resolveMarkerCommentStyle(targetRelativePath);
  if (!style || hasVisibleChangeMarkers(nextText)) {
    return { content: nextText };
  }

  const described = await describeTextChangesCooperative(
    baseText,
    nextText,
    {
      id: `builder:${targetRelativePath}`,
      label: `${BUILDER_CONFIG.name} exact markers`,
    },
    yieldController,
    budgets,
  );
  if (!described.ok) {
    return {
      content: nextText,
      warning: 'exact_change_budget_exceeded',
    };
  }
  if (described.edits.length === 0) {
    return { content: nextText };
  }

  return {
    content: renderExactMarkerContent(
      splitTextLines(baseText),
      described.edits,
      style,
      targetRelativePath,
      builderId,
      contributors,
      resolvePreferredLineEnding(baseText, nextText),
    ),
  };
}

export function unwrapMarkedContent(content: string): {
  payload?: MarkerPayload | undefined;
  innerContent: string;
  envelopeLineEnding?: '\n' | '\r\n' | undefined;
} {
  for (const style of markerCommentStyles) {
    // The start pattern is anchored at the first character; the end pattern has
    // to be searched for. Asking the cheap one first keeps three unanchored
    // scans of the whole file off every read of a file YMB did not write.
    const startMatch = content.match(style.startPattern);
    if (!startMatch) {
      continue;
    }
    const endMatch = matchEndDelimiter(content, style);
    if (!endMatch) {
      continue;
    }

    const startPayload = parseMarkerPayload(startMatch[1]);
    const endPayload = parseMarkerPayload(endMatch[1]);
    if (
      !startPayload.success ||
      !endPayload.success ||
      !isSameMarkerPayload(startPayload.data, endPayload.data)
    ) {
      return { innerContent: content };
    }

    return {
      payload: startPayload.data,
      innerContent: content.slice(startMatch[0].length, content.length - endMatch[0].length),
      envelopeLineEnding: endMatch[0].startsWith('\r\n') ? '\r\n' : '\n',
    };
  }

  return { innerContent: content };
}

/**
 * The end delimiter closes the file, so it is found from the back. Matching the
 * pattern against the whole content re-read every tracked file from the front
 * looking for something that can only be at the end.
 */
function matchEndDelimiter(
  content: string,
  style: MarkerCommentStyle,
): RegExpMatchArray | undefined {
  const markerIndex = content.lastIndexOf(style.endMarkerText);
  if (markerIndex === -1) {
    return undefined;
  }
  // The pattern also claims the line break in front of the delimiter, which is
  // at most the two characters of a CRLF.
  return content.slice(Math.max(0, markerIndex - 2)).match(style.endPattern) ?? undefined;
}

export function isMarkedContentIntact(
  marked: ReturnType<typeof unwrapMarkedContent>,
  targetRelativePath: string,
): boolean {
  const payload = marked.payload;
  if (!payload) {
    return false;
  }
  // The end delimiter owns its separating newline. LF is ambiguous because the writer
  // also adds it to unterminated content; CRLF can only have come from CRLF. The
  // terminators are hashed as a continuation of the one pass over the content, since
  // concatenating them copied a tens-of-megabytes file per candidate.
  const contentDigest = createHash('sha256').update(marked.innerContent);
  const possibleHashes =
    marked.envelopeLineEnding === '\r\n'
      ? [contentDigest.update('\r\n').digest('hex')]
      : [contentDigest.copy().digest('hex'), contentDigest.update('\n').digest('hex')];
  return possibleHashes.some(
    (actualHash) =>
      payload.markerHash === actualHash &&
      payload.markerId === hashMarkerId(targetRelativePath, actualHash),
  );
}

function hashMarkerId(targetRelativePath: string, markerHash: string): string {
  return createHash('sha256').update(`${targetRelativePath}:${markerHash}`).digest('hex');
}

function isSameMarkerPayload(left: MarkerPayload, right: MarkerPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseMarkerPayload(
  rawPayload: string | undefined,
): { success: true; data: MarkerPayload } | { success: false } {
  try {
    const parsed = JSON.parse(rawPayload ?? '{}');
    const current = markerPayloadSchema.safeParse(parsed);
    return current.success ? { success: true, data: current.data } : { success: false };
  } catch {
    return { success: false };
  }
}

function resolveMarkerCommentStyle(targetRelativePath: string): MarkerCommentStyle | undefined {
  const extension = path.extname(targetRelativePath).toLowerCase();
  switch (extension) {
    case '.ndf':
    case '.c':
    case '.cc':
    case '.cpp':
    case '.cs':
    case '.cts':
    case '.cxx':
    case '.h':
    case '.hpp':
    case '.java':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.mts':
    case '.ts':
    case '.tsx':
      return markerCommentStyles[0];
    case '.conf':
    case '.properties':
    case '.toml':
    case '.yaml':
    case '.yml':
      return markerCommentStyles[1];
    case '.cfg':
    case '.ini':
      return markerCommentStyles[2];
    case '.htm':
    case '.html':
    case '.md':
    case '.svg':
    case '.xml':
      return markerCommentStyles[3];
    default:
      return undefined;
  }
}

function renderExactMarkerContent(
  baseLines: string[],
  edits: TextLineEdit[],
  style: MarkerCommentStyle,
  targetRelativePath: string,
  builderId: string,
  contributors: BuildContributor[],
  lineEnding: '\n' | '\r\n',
): string {
  const chunks: string[] = [];
  let cursor = 0;

  for (const [index, edit] of edits.entries()) {
    appendLines(chunks, baseLines, cursor, edit.start);
    chunks.push(
      renderExactMarkerEditBlock(
        style,
        targetRelativePath,
        builderId,
        contributors,
        edit.start,
        edit.end,
        edit.newLines,
        index,
        lineEnding,
        baseLines.slice(edit.start, edit.end),
      ),
    );
    cursor = edit.end;
  }

  appendLines(chunks, baseLines, cursor, baseLines.length);
  return chunks.join('');
}

function renderExactMarkerEditBlock(
  style: MarkerCommentStyle,
  targetRelativePath: string,
  builderId: string,
  contributors: BuildContributor[],
  start: number,
  end: number,
  newLines: string[],
  editIndex: number,
  lineEnding: '\n' | '\r\n',
  originalLines: string[],
): string {
  const kind = resolveInlineChangeKind(start, end, newLines);
  const payload = JSON.stringify({
    id: createHash('sha256')
      .update(
        [
          builderId,
          targetRelativePath,
          kind,
          editIndex,
          start,
          end,
          ...contributors.map((contributor) => contributor.patchId ?? contributor.modId),
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 12),
    builderId,
    kind,
    startLine: start + 1,
    endLine: end,
    contributors,
  });
  const indent = resolveMarkerIndent(newLines, originalLines);
  const lines = [
    `${indent}${style.commentLine(`YMB-${kind.toUpperCase()}-START ${payload}`)}${lineEnding}`,
  ];

  if (kind !== 'add') {
    lines.push(renderOriginalLines(style, indent, originalLines, lineEnding));
  }

  if (newLines.length > 0) {
    lines.push(...newLines);
    if (!endsWithLineEnding(newLines[newLines.length - 1])) {
      lines.push(lineEnding);
    }
  }

  lines.push(
    `${indent}${style.commentLine(`YMB-${kind.toUpperCase()}-END ${payload}`)}${lineEnding}`,
  );
  return lines.join('');
}

function renderOriginalLines(
  style: MarkerCommentStyle,
  indent: string,
  originalLines: string[],
  lineEnding: '\n' | '\r\n',
): string {
  const lines = [`${indent}${style.commentLine('YMB-ORIGINAL')}${lineEnding}`];
  for (const line of originalLines) {
    lines.push(
      `${indent}${style.commentLine(stripLineEnding(line))}${endsWithLineEnding(line) ? getLineEnding(line) : lineEnding}`,
    );
  }
  return lines.join('');
}

function hasVisibleChangeMarkers(content: string): boolean {
  return /\bYMB-(?:ADD|COPY|MODIFY|REMOVE)-START\b/.test(content);
}

function resolveInlineChangeKind(
  start: number,
  end: number,
  newLines: string[],
): 'add' | 'modify' | 'remove' {
  if (start === end) {
    return 'add';
  }
  if (newLines.length === 0) {
    return 'remove';
  }
  return 'modify';
}

function resolveMarkerIndent(newLines: string[], originalLines: string[]): string {
  const firstIndentedLine = [...newLines, ...originalLines].find(
    (line) => stripLineEnding(line).trim().length > 0,
  );
  return firstIndentedLine?.match(/^\s*/)?.[0] ?? '';
}

function resolvePreferredLineEnding(baseText: string, nextText: string): '\n' | '\r\n' {
  return baseText.includes('\r\n') || nextText.includes('\r\n') ? '\r\n' : '\n';
}

function stripLineEnding(line: string): string {
  return line.replace(/\r?\n$/, '');
}

function endsWithLineEnding(line: string | undefined): boolean {
  return line !== undefined && /\r?\n$/.test(line);
}

function getLineEnding(line: string): '\n' | '\r\n' {
  return line.endsWith('\r\n') ? '\r\n' : '\n';
}

export async function loadManifest(stateRoot: string): Promise<SyncManifest> {
  const manifestPath = path.join(stateRoot, manifestFileName);
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) {
    return {
      entries: [],
    };
  }

  try {
    return manifestSchema.parse(await file.json());
  } catch (error) {
    const backupManifest = await loadBackupManifest(stateRoot);
    if (backupManifest) {
      return backupManifest;
    }
    throw new YmbError('RecoveryError', {
      absolutePath: manifestPath,
      reason: `Failed to read the ${BUILDER_CONFIG.name} recovery manifest.`,
      suggestion:
        'Delete the broken manifest only if you no longer need to recover files from earlier syncs.',
      details: [error instanceof Error ? error.message : String(error)],
    });
  }
}

async function loadBackupManifest(stateRoot: string): Promise<SyncManifest | undefined> {
  try {
    const backupFile = Bun.file(path.join(stateRoot, `${manifestFileName}.bak`));
    if (!(await backupFile.exists())) {
      return undefined;
    }
    return manifestSchema.parse(await backupFile.json());
  } catch {
    return undefined;
  }
}

export async function saveManifest(stateRoot: string, manifest: SyncManifest): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  const manifestPath = path.join(stateRoot, manifestFileName);
  const currentFile = Bun.file(manifestPath);
  if (await currentFile.exists()) {
    await writeFileAtomic(
      path.join(stateRoot, `${manifestFileName}.bak`),
      await currentFile.text(),
    );
  }
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
