import { describe, expect, test } from 'bun:test';
import {
  createBuilderId,
  decorateTextWithExactMarkers,
  renderOriginalSnippetComments,
  supportsMarkerComments,
  unwrapMarkedContent,
  wrapWithMarker,
} from '../src/markers.ts';

const payload = {
  markerId: 'marker-1',
  markerHash: 'hash-1',
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
// YMB-END ${JSON.stringify({ ...payload, markerId: 'marker-2' })}
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
