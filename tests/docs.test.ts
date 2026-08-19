import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { buildJsonError, buildJsonResult } from '../src/cli/json-output.ts';
import type { CommandOutputLines } from '../src/report/output.ts';
import type { SelectionInput } from '../src/types.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const docsRoot = path.join(repositoryRoot, 'docs');

const selection: SelectionInput = {
  scope: 'prod',
  modFilters: ['sample_mod'],
  patchFilters: [],
  dryRun: false,
  verbose: false,
  yes: false,
};
const emptyOutput: CommandOutputLines = [];

async function readDocs(): Promise<Array<{ name: string; relativePath: string; text: string }>> {
  const names = (await readdir(docsRoot)).filter((name) => name.endsWith('.md')).sort();
  const pages = await Promise.all(
    names.map(async (name) => ({
      name,
      relativePath: `docs/${name}`,
      text: await readFile(path.join(docsRoot, name), 'utf8'),
    })),
  );
  return [
    ...pages,
    {
      name: 'README.md',
      relativePath: 'README.md',
      text: await readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
    },
  ];
}

const docs = await readDocs();

describe('documentation stays correct', () => {
  test('every relative link points at a file and heading that exist', async () => {
    const anchors = new Map<string, Set<string>>();
    for (const page of docs) {
      anchors.set(
        page.relativePath,
        new Set(
          [...page.text.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map(([, heading]) =>
            (heading ?? '')
              .toLowerCase()
              .replaceAll(/[^a-z0-9 -]/g, '')
              .trim()
              .replaceAll(' ', '-'),
          ),
        ),
      );
    }

    const broken: string[] = [];
    for (const page of docs) {
      const pageDirectory = path.dirname(page.relativePath);
      for (const [, target] of page.text.matchAll(/\]\((?!https?:|mailto:)([^)\s]+)\)/g)) {
        if (target === undefined || target.startsWith('#')) continue;
        const [filePart, anchor] = target.split('#');
        const resolved = path
          .normalize(path.join(pageDirectory, filePart ?? ''))
          .replaceAll('\\', '/');
        if (!(await Bun.file(path.join(repositoryRoot, resolved)).exists())) {
          broken.push(`${page.relativePath} -> ${target} (no such file)`);
          continue;
        }
        // Only Markdown pages have headings to point at.
        const known = anchors.get(resolved);
        if (anchor !== undefined && known && !known.has(anchor)) {
          broken.push(`${page.relativePath} -> ${target} (no such heading)`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  // A version baked into a sample is wrong from the next release onwards, and nothing
  // else in the suite would notice.
  test('no page hard-codes the builder version', () => {
    const offenders = docs.filter((page) => /"ymb":\s*"\d+\.\d+\.\d+"/.test(page.text));

    expect(offenders.map((page) => page.relativePath)).toEqual([]);
  });

  test('the documented `--json` envelope matches what the CLI emits', () => {
    const documented = docs.find((page) => page.name === 'workflow.md')?.text ?? '';
    const block = documented.match(/```json\n([\s\S]*?)```/)?.[1] ?? '';
    const documentedKeys = [...block.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map(([, key]) => key);

    expect(documentedKeys).toEqual(Object.keys(buildJsonResult('build', selection, emptyOutput)));
  });

  // The failure envelope is described in prose rather than a sample block, so pin the
  // fields that prose promises a caller can read.
  test('a failure reports the documented shape and the running version', () => {
    const failure = buildJsonError('build', new Error('boom'));

    expect(Object.keys(failure)).toEqual(['ymb', 'command', 'ok', 'errors', 'errorCount']);
    expect(failure.ymb).toBe(packageDefinition.version);
    expect(Object.keys((failure.errors as object[])[0] as object)).toEqual(
      expect.arrayContaining(['category', 'reason', 'suggestion']),
    );
  });
});
