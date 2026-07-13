import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createBuilderId,
  decorateTextWithExactMarkers,
  isMarkedContentIntact,
  loadManifest,
  renderOriginalSnippetComments,
  saveManifest,
  supportsMarkerComments,
  unwrapMarkedContent,
  wrapWithMarker,
} from '../src/markers.ts';

const payload = {
  markerId: 'a'.repeat(64),
  markerHash: 'b'.repeat(64),
  builderId: createBuilderId('C:/fixture/YMB'),
  contributors: [{ modId: 'sample_pack', patchId: 'balance.armor' }],
};

describe('marker parsing', () => {
  test('unwraps valid marker payloads', () => {
    const wrapped = wrapWithMarker(
      'FrontArmor = 7\n',
      payload,
      'GameData/Generated/Gameplay/Units.ndf',
    );
    const result = unwrapMarkedContent(wrapped);

    expect(result.payload).toEqual(payload);
    expect(result.innerContent).toBe('FrontArmor = 7');
    expect(wrapped).toContain('"builderId"');
    expect(wrapped).not.toContain('"builderRoot"');
    expect(wrapped).not.toContain('"targetRelativePath"');
  });

  test.each([
    ['without a trailing newline', 'FrontArmor = 7'],
    ['with a trailing LF', 'FrontArmor = 7\n'],
    ['with a trailing CRLF', 'FrontArmor = 7\r\n'],
  ])('verifies generated content %s', (_description, content) => {
    const targetRelativePath = 'GameData/Generated/Gameplay/Units.ndf';
    const markerHash = new Bun.CryptoHasher('sha256').update(content).digest('hex');
    const integrityPayload = {
      ...payload,
      markerHash,
      markerId: new Bun.CryptoHasher('sha256')
        .update(`${targetRelativePath}:${markerHash}`)
        .digest('hex'),
    };

    const marked = unwrapMarkedContent(
      wrapWithMarker(content, integrityPayload, targetRelativePath),
    );

    expect(isMarkedContentIntact(marked, targetRelativePath)).toBe(true);
  });

  test('rejects a genuine edit inside a generated CRLF envelope', () => {
    const targetRelativePath = 'GameData/Generated/Gameplay/Units.ndf';
    const content = 'FrontArmor = 7\r\n';
    const markerHash = new Bun.CryptoHasher('sha256').update(content).digest('hex');
    const integrityPayload = {
      ...payload,
      markerHash,
      markerId: new Bun.CryptoHasher('sha256')
        .update(`${targetRelativePath}:${markerHash}`)
        .digest('hex'),
    };
    const edited = wrapWithMarker(content, integrityPayload, targetRelativePath).replace(
      'FrontArmor = 7',
      'FrontArmor = 8',
    );

    expect(isMarkedContentIntact(unwrapMarkedContent(edited), targetRelativePath)).toBe(false);
  });

  test('rejects changing a generated CRLF content terminator to LF', () => {
    const targetRelativePath = 'GameData/Generated/Gameplay/Units.ndf';
    const content = 'FrontArmor = 7\r\n';
    const markerHash = new Bun.CryptoHasher('sha256').update(content).digest('hex');
    const integrityPayload = {
      ...payload,
      markerHash,
      markerId: new Bun.CryptoHasher('sha256')
        .update(`${targetRelativePath}:${markerHash}`)
        .digest('hex'),
    };
    const changedTerminator = wrapWithMarker(content, integrityPayload, targetRelativePath).replace(
      '\r\n// YMB-END',
      '\n// YMB-END',
    );

    expect(changedTerminator).not.toContain('\r\n// YMB-END');
    expect(isMarkedContentIntact(unwrapMarkedContent(changedTerminator), targetRelativePath)).toBe(
      false,
    );
  });

  test('unwraps html comment marker payloads', () => {
    const wrapped = wrapWithMarker(
      '<root>\n  <value>7</value>\n</root>\n',
      payload,
      'GameData/Generated/Gameplay/Units.xml',
    );
    const result = unwrapMarkedContent(wrapped);

    expect(result.payload).toEqual(payload);
    expect(result.innerContent).toContain('<value>7</value>');
  });

  test('ignores mismatched marker payload pairs', () => {
    const wrapped = `// YMB-START ${JSON.stringify(payload)}
FrontArmor = 7
// YMB-END ${JSON.stringify({ ...payload, markerId: 'c'.repeat(64) })}
`;
    const result = unwrapMarkedContent(wrapped);

    expect(result.payload).toBeUndefined();
    expect(result.innerContent).toBe(wrapped);
  });

  test('ignores malformed marker payloads', () => {
    const wrapped = `// YMB-START {broken-json}
FrontArmor = 7
// YMB-END {broken-json}
`;
    const result = unwrapMarkedContent(wrapped);

    expect(result.payload).toBeUndefined();
    expect(result.innerContent).toBe(wrapped);
  });

  test('reports unsupported comment marker targets', () => {
    expect(supportsMarkerComments('GameData/Generated/Gameplay/Units.ndf')).toBe(true);
    expect(supportsMarkerComments('GameData/Localisation/test/INTERFACE_OUTGAME.csv')).toBe(false);
    expect(supportsMarkerComments('GameData/Generated/Gameplay/Units.json')).toBe(false);
  });

  test('adds exact change markers for modified text outputs', () => {
    const result = decorateTextWithExactMarkers(
      'alpha\nbeta\ngamma\n',
      'ALPHA\nbeta\nGAMMA\n',
      'CommonData/Text/shared-script.ndf',
      payload.builderId,
      payload.contributors,
    );

    expect(result.warning).toBeUndefined();
    expect(result.content).toContain('// YMB-MODIFY-START');
    expect(result.content).toContain('// YMB-ORIGINAL');
    expect(result.content).toContain('// alpha');
    expect(result.content).toContain('ALPHA\n');
    expect(result.content).toContain('// gamma');
    expect(result.content).toContain('GAMMA\n');
  });

  test('renders original snippet comments with the target comment style', () => {
    expect(renderOriginalSnippetComments('alpha\nbeta\n', '  ', 'inline.ndf')).toBe(
      '  // YMB-ORIGINAL\n  // alpha\n  // beta',
    );
    expect(renderOriginalSnippetComments('<a>\n</a>\n', '', 'inline.xml')).toBe(
      '<!-- YMB-ORIGINAL -->\n<!-- <a> -->\n<!-- </a> -->',
    );
  });
});

describe('sync manifest persistence', () => {
  const manifest = {
    entries: [
      {
        targetRelativePath: 'GameData/Generated/Gameplay/Units.ndf',
        backupFileName: `${'d'.repeat(64)}.ndf`,
        originalExists: true,
        contributors: [],
      },
    ],
  };

  test('keeps a .bak of the previous manifest and falls back to it on corruption', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'ymb-manifest-'));
    try {
      await saveManifest(stateRoot, manifest);
      await saveManifest(stateRoot, manifest);

      await writeFile(path.join(stateRoot, 'manifest.json'), '{ torn json');
      const recovered = await loadManifest(stateRoot);
      expect(recovered.entries).toHaveLength(1);
      expect(recovered.entries[0]?.backupFileName).toBe(`${'d'.repeat(64)}.ndf`);

      const leftovers = (await readdir(stateRoot)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('throws a recovery error when both manifest and backup are corrupted', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'ymb-manifest-'));
    try {
      await writeFile(path.join(stateRoot, 'manifest.json'), '{ torn json');
      await writeFile(path.join(stateRoot, 'manifest.json.bak'), 'also broken');

      await expect(loadManifest(stateRoot)).rejects.toThrow(
        'Failed to read the YMB recovery manifest',
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('rejects recovery backup paths that escape the originals directory', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'ymb-manifest-'));
    try {
      await writeFile(
        path.join(stateRoot, 'manifest.json'),
        JSON.stringify({
          entries: [
            {
              targetRelativePath: 'GameData/Generated/Gameplay/Units.ndf',
              backupFileName: '../outside.ndf',
              originalExists: true,
              contributors: [],
            },
          ],
        }),
      );
      await expect(loadManifest(stateRoot)).rejects.toThrow(
        'Failed to read the YMB recovery manifest',
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('returns empty entries when no manifest exists', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'ymb-manifest-'));
    try {
      expect((await loadManifest(stateRoot)).entries).toEqual([]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
