import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import {
  createBuilderId,
  decorateTextWithExactMarkersCooperative,
  isMarkedContentIntact,
  loadManifest,
  renderOriginalSnippetComments,
  saveManifest,
  supportsMarkerComments,
  unwrapMarkedContent,
  wrapWithMarker,
} from '../src/markers.ts';
import { resolveExactMarkerBudgets } from '../src/text-merge.ts';

const markerBudgets = resolveExactMarkerBudgets(createDefaultBuilderProjectConfig().settings);

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

  test('adds exact change markers for modified text outputs', async () => {
    const result = await decorateTextWithExactMarkersCooperative(
      'alpha\nbeta\ngamma\n',
      'ALPHA\nbeta\nGAMMA\n',
      'CommonData/Text/shared-script.ndf',
      payload.builderId,
      payload.contributors,
      { maybeYield: async () => undefined },
      markerBudgets,
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
    expect(renderOriginalSnippetComments('setting: 1\n', '', 'inline.yaml')).toBe(
      '# YMB-ORIGINAL\n# setting: 1',
    );
    expect(renderOriginalSnippetComments('Setting=1\n', '', 'inline.ini')).toBe(
      '; YMB-ORIGINAL\n; Setting=1',
    );
  });

  test.each([
    ['.ndf', 'CommonData/Text/sample.ndf', '//'],
    ['.yaml', 'CommonData/Text/sample.yaml', '#'],
    ['.toml', 'CommonData/Text/sample.toml', '#'],
    ['.ini', 'CommonData/Text/sample.ini', ';'],
    ['.cfg', 'CommonData/Text/sample.cfg', ';'],
    ['.md', 'CommonData/Text/sample.md', '<!--'],
  ])('round-trips a %s marker envelope', (_extension, targetRelativePath, prefix) => {
    const wrapped = wrapWithMarker('Value = 7\n', payload, targetRelativePath);
    const lines = wrapped.trimEnd().split('\n');

    expect(lines[0]?.startsWith(`${prefix} YMB-START `)).toBe(true);
    expect(lines[lines.length - 1]?.startsWith(`${prefix} YMB-END `)).toBe(true);
    const result = unwrapMarkedContent(wrapped);
    expect(result.payload).toEqual(payload);
    expect(result.innerContent).toBe('Value = 7');
  });

  test('marks exact changes with the comment style the target uses', async () => {
    const result = await decorateTextWithExactMarkersCooperative(
      'setting: 1\nother: 2\n',
      'setting: 9\nother: 2\n',
      'CommonData/Text/sample.yaml',
      payload.builderId,
      payload.contributors,
      { maybeYield: async () => undefined },
      markerBudgets,
    );

    expect(result.content).toContain('# YMB-MODIFY-START');
    expect(result.content).toContain('# YMB-ORIGINAL');
    expect(result.content).toContain('# setting: 1');
    expect(result.content).toContain('setting: 9\n');
    expect(result.content).not.toContain('// YMB-MODIFY-START');
  });

  test('leaves a file with no comment syntax untouched, and says so when asked to mark it', async () => {
    const target = 'GameData/Localisation/test/INTERFACE_OUTGAME.csv';

    expect(() => wrapWithMarker('a,b\n', payload, target)).toThrow(
      'has no supported comment syntax',
    );
    expect(() => renderOriginalSnippetComments('a,b\n', '', target)).toThrow(
      'has no supported comment syntax',
    );
    // The exact-marker pass is best-effort, so it returns the text unchanged
    // rather than failing a build over a file it cannot annotate.
    const result = await decorateTextWithExactMarkersCooperative(
      'a,b\n',
      'a,c\n',
      target,
      payload.builderId,
      payload.contributors,
      { maybeYield: async () => undefined },
      markerBudgets,
    );
    expect(result.content).toBe('a,c\n');
    expect(result.warning).toBeUndefined();
  });

  test('a raised marker budget annotates a file the configured ceiling refused', async () => {
    const baseText = 'alpha\nbeta\ngamma\n';
    const nextText = 'ALPHA\nbeta\nGAMMA\n';
    const decorate = (settings: Parameters<typeof resolveExactMarkerBudgets>[0]) =>
      decorateTextWithExactMarkersCooperative(
        baseText,
        nextText,
        'CommonData/Text/shared-script.ndf',
        payload.builderId,
        payload.contributors,
        { maybeYield: async () => undefined },
        resolveExactMarkerBudgets(settings),
      );
    const settings = createDefaultBuilderProjectConfig().settings;

    // Over budget the output is handed back untouched, with the warning that
    // turns into the whole-file-markers note.
    const refused = await decorate({ ...settings, markerMaxTextBytesPerSide: 1 });
    expect(refused.warning).toBe('exact_change_budget_exceeded');
    expect(refused.content).toBe(nextText);

    // The same file annotated once the project says it is allowed to be that big.
    const allowed = await decorate({ ...settings, markerMaxTextBytesPerSide: baseText.length });
    expect(allowed.warning).toBeUndefined();
    expect(allowed.content).toContain('// YMB-MODIFY-START');
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
      expect(recovered.entries[0]?.expectedState).toBe('present');

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
