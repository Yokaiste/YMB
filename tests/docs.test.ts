import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const docsRoot = path.join(repositoryRoot, 'docs');

async function readDocs(): Promise<Array<{ relativePath: string; text: string }>> {
  const names = (await readdir(docsRoot)).filter((name) => name.endsWith('.md')).sort();
  const pages = await Promise.all(
    names.map(async (name) => ({
      relativePath: `docs/${name}`,
      text: await readFile(path.join(docsRoot, name), 'utf8'),
    })),
  );
  return [
    ...pages,
    {
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
        if (target === undefined) continue;
        const [filePart, anchor] = target.split('#');
        const resolved = filePart
          ? path.normalize(path.join(pageDirectory, filePart)).replaceAll('\\', '/')
          : page.relativePath;
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
});
