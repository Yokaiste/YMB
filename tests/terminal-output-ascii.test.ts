import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '..');

/** The packaged launcher opens a legacy `cmd.exe`, which does not render UTF-8 in its default code page. */
describe('terminal output stays ASCII', () => {
  test('no source file contains a non-ASCII character', async () => {
    const offenders: string[] = [];

    for await (const relativePath of new Bun.Glob('**/*.ts').scan({ cwd: 'src' })) {
      const filePath = path.join('src', relativePath);
      const contents = await readFile(path.join(repositoryRoot, filePath), 'utf8');

      for (const [index, line] of contents.split('\n').entries()) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ASCII range is the point
        const match = /[^\x00-\x7F]/.exec(line);
        if (match) {
          offenders.push(
            `${filePath}:${index + 1} contains U+${match[0]
              .codePointAt(0)
              ?.toString(16)
              .toUpperCase()
              .padStart(4, '0')} (${match[0]})`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * The ASCII range still holds every control character, so the guard above accepts
 * one written straight into a file. Two were: a NUL joining the error-dedup key in
 * `src/errors.ts`, and an ESC opening a cursor-move sequence in a CLI test. Both
 * did what the author meant, but a raw control byte makes the whole file read as
 * binary to grep and git, hides itself in every editor and diff, and survives only
 * as long as no tool strips it. The escape spells the same byte and stays visible.
 */
describe('sources spell control characters as escapes', () => {
  test('no source file contains a raw control byte', async () => {
    const offenders: string[] = [];

    for (const directory of ['src', 'scripts', 'tests']) {
      for await (const relativePath of new Bun.Glob('**/*.ts').scan({ cwd: directory })) {
        const filePath = path.join(directory, relativePath);
        const contents = await readFile(path.join(repositoryRoot, filePath), 'utf8');

        for (const [index, line] of contents.split('\n').entries()) {
          // Tab and carriage return are the only control characters a line may hold;
          // the split already consumed the line feeds.
          // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
          const match = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.exec(line);
          if (match) {
            offenders.push(
              `${filePath}:${index + 1} contains a raw U+${match[0]
                .codePointAt(0)
                ?.toString(16)
                .toUpperCase()
                .padStart(4, '0')} byte -- write it as an escape instead`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
