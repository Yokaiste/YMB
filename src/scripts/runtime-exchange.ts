import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapConcurrent } from '../async.ts';
import { ensure } from '../errors.ts';
import { isPathInside } from '../path-utils.ts';

/**
 * Workers exchange whole game files with the parent -- the deck target alone is
 * 58 MB -- and IPC copies each payload on both sides, so the parent's peak grew by
 * the size of the whole build per worker. Anything past the threshold below travels
 * as a file instead; small payloads stay inline.
 */
const EXCHANGE_ROOT_PREFIX = 'ymb-runtime-';
const EXCHANGE_THRESHOLD_BYTES = 256 * 1024;
const EXCHANGE_IO_CONCURRENCY = 8;

/** A content parked in the exchange directory rather than sent over IPC. */
interface ExchangedContent {
  exchangedContent: { fileName: string; kind: 'text' | 'binary' };
}

type ExchangeableContent = string | Uint8Array | ExchangedContent;

/** A `WrittenBuildFile` or `GeneratedScriptFile` with its content made exchangeable. */
export type Exchanged<TFile extends { content: string | Uint8Array }> = Omit<TFile, 'content'> & {
  content: ExchangeableContent;
};

export async function createExchangeRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), EXCHANGE_ROOT_PREFIX));
}

export async function removeExchangeRoot(exchangeRoot: string): Promise<void> {
  await rm(exchangeRoot, { recursive: true, force: true }).catch(() => undefined);
}

function isExchangedContent(content: ExchangeableContent): content is ExchangedContent {
  return typeof content === 'object' && content !== null && 'exchangedContent' in content;
}

/** Unique within one exchange directory, and spelled so a reader can tell which is which. */
async function writeExchangedContent(
  content: string | Uint8Array,
  exchangeRoot: string,
  name: string,
): Promise<ExchangeableContent> {
  // UTF-8 never spends fewer bytes than the string has code units, so the
  // cheap length is a sound test against the threshold - and `Buffer.byteLength`
  // is not cheap, because measuring a 58 MB output means reading all of it.
  const size = typeof content === 'string' ? content.length : content.byteLength;
  if (size < EXCHANGE_THRESHOLD_BYTES) {
    return content;
  }

  const kind = typeof content === 'string' ? 'text' : 'binary';
  const fileName = `${name}.${kind === 'text' ? 'txt' : 'bin'}`;
  await Bun.write(path.join(exchangeRoot, fileName), content);
  return { exchangedContent: { fileName, kind } };
}

async function readExchangedContent(
  content: ExchangeableContent,
  exchangeRoot: string,
): Promise<string | Uint8Array> {
  if (!isExchangedContent(content)) {
    return content;
  }

  const absolutePath = path.resolve(exchangeRoot, content.exchangedContent.fileName);
  ensure(isPathInside(exchangeRoot, absolutePath), 'ScriptError', {
    absolutePath,
    reason: 'A YMB worker exchanged an invalid content path.',
    suggestion: 'Re-run the command. If it persists, inspect the YMB worker runtime.',
  });
  const file = Bun.file(absolutePath);
  ensure(await file.exists(), 'ScriptError', {
    absolutePath,
    reason: 'A YMB worker exchanged a content that was missing from the exchange directory.',
    suggestion: 'Re-run the command. If it persists, inspect available temporary disk space.',
  });
  return content.exchangedContent.kind === 'text'
    ? await file.text()
    : new Uint8Array(await file.arrayBuffer());
}

export async function writeExchangedFiles<TFile extends { content: string | Uint8Array }>(
  files: readonly TFile[],
  exchangeRoot: string,
  namePrefix: string,
): Promise<Exchanged<TFile>[]> {
  return await mapConcurrent(files, EXCHANGE_IO_CONCURRENCY, async (file, index) => ({
    ...file,
    content: await writeExchangedContent(file.content, exchangeRoot, `${namePrefix}-${index}`),
  }));
}

export async function readExchangedFiles<TFile extends { content: string | Uint8Array }>(
  files: readonly Exchanged<TFile>[],
  exchangeRoot: string,
): Promise<TFile[]> {
  return await mapConcurrent(
    files,
    EXCHANGE_IO_CONCURRENCY,
    async (file) =>
      ({
        ...file,
        content: await readExchangedContent(file.content, exchangeRoot),
      }) as TFile,
  );
}
