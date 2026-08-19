import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { pathExists } from '../src/path-utils.ts';
import {
  createExchangeRoot,
  readExchangedFiles,
  removeExchangeRoot,
  writeExchangedFiles,
} from '../src/scripts/runtime-exchange.ts';
import type { WrittenBuildFile } from '../src/types.ts';

const SMALL_TEXT = 'export Descriptor_Unit_A is TEntityDescriptor\n(\n    FrontArmor = 1\n)\n';
/** Comfortably past the threshold, so the payload has to take the file route. */
const LARGE_TEXT = `${'x'.repeat(300_000)}\n`;

function buildFile(targetRelativePath: string, content: string | Uint8Array): WrittenBuildFile {
  return {
    targetRelativePath,
    sourceType: 'script',
    content,
    contributors: [{ modId: 'sample_mod' }],
  };
}

async function roundTrip(files: WrittenBuildFile[]): Promise<{
  received: WrittenBuildFile[];
  exchangedFileNames: string[];
}> {
  const exchangeRoot = await createExchangeRoot();
  try {
    const sent = await writeExchangedFiles(files, exchangeRoot, 'input');
    return {
      received: await readExchangedFiles<WrittenBuildFile>(sent, exchangeRoot),
      exchangedFileNames: await readdir(exchangeRoot),
    };
  } finally {
    await removeExchangeRoot(exchangeRoot);
  }
}

describe('content crossing a worker boundary', () => {
  test('a large text payload travels as a file and arrives unchanged', async () => {
    const { received, exchangedFileNames } = await roundTrip([
      buildFile('GameData/Generated/Gameplay/Units.ndf', LARGE_TEXT),
    ]);

    expect(exchangedFileNames).toEqual(['input-0.txt']);
    expect(received[0]?.content).toBe(LARGE_TEXT);
    expect(received[0]?.targetRelativePath).toBe('GameData/Generated/Gameplay/Units.ndf');
    expect(received[0]?.contributors).toEqual([{ modId: 'sample_mod' }]);
  });

  test('a large binary payload keeps its bytes', async () => {
    const bytes = new Uint8Array(300_000).map((_, index) => index % 256);

    const { received, exchangedFileNames } = await roundTrip([
      buildFile('GameData/Assets/2D/sample.png', bytes),
    ]);

    expect(exchangedFileNames).toEqual(['input-0.bin']);
    expect(received[0]?.content).toEqual(bytes);
  });

  test('a small payload stays inline, because a file per message would cost more', async () => {
    const { received, exchangedFileNames } = await roundTrip([
      buildFile('GameData/Generated/Gameplay/Units.ndf', SMALL_TEXT),
    ]);

    expect(exchangedFileNames).toEqual([]);
    expect(received[0]?.content).toBe(SMALL_TEXT);
  });

  test('payloads sharing one directory do not overwrite each other', async () => {
    const other = `${'y'.repeat(300_000)}\n`;

    const { received, exchangedFileNames } = await roundTrip([
      buildFile('GameData/Generated/Gameplay/A.ndf', LARGE_TEXT),
      buildFile('GameData/Generated/Gameplay/B.ndf', SMALL_TEXT),
      buildFile('GameData/Generated/Gameplay/C.ndf', other),
    ]);

    expect(exchangedFileNames.sort()).toEqual(['input-0.txt', 'input-2.txt']);
    expect(received.map((file) => file.content)).toEqual([LARGE_TEXT, SMALL_TEXT, other]);
  });

  test('keeps order and content across several bounded I/O batches', async () => {
    const files = Array.from({ length: 19 }, (_, index) =>
      buildFile(
        `GameData/Generated/Gameplay/Batch${index}.ndf`,
        index % 3 === 0 ? `${'x'.repeat(300_000)}${index}\n` : `inline ${index}`,
      ),
    );

    const { received, exchangedFileNames } = await roundTrip(files);

    expect(received.map((file) => file.targetRelativePath)).toEqual(
      files.map((file) => file.targetRelativePath),
    );
    expect(received.map((file) => file.content)).toEqual(files.map((file) => file.content));
    expect(exchangedFileNames.sort()).toEqual(
      [0, 3, 6, 9, 12, 15, 18].map((index) => `input-${index}.txt`).sort(),
    );
  });

  test('a missing exchanged payload is reported rather than read as empty', async () => {
    const exchangeRoot = await createExchangeRoot();
    const sent = await writeExchangedFiles(
      [buildFile('GameData/Generated/Gameplay/Units.ndf', LARGE_TEXT)],
      exchangeRoot,
      'input',
    );
    await removeExchangeRoot(exchangeRoot);

    expect(await pathExists(exchangeRoot)).toBe(false);
    await expect(readExchangedFiles<WrittenBuildFile>(sent, exchangeRoot)).rejects.toThrow(
      'missing from the exchange directory',
    );
  });
});
