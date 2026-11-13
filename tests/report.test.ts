import { describe, expect, test } from 'bun:test';
import {
  countWrittenFiles,
  createMaterializationMetrics,
  patchCacheFact,
} from '../src/engine/metrics.ts';
import { DETAIL_STATUSES, formatDetailLine, isRoutineDetailLine } from '../src/report/detail.ts';
import { collectFacts, countFact, formatFactLines, timingFact } from '../src/report/facts.ts';
import { toCommandOutput } from '../src/report/output.ts';
import { formatDurationMs, formatInfoLine, formatRecordLine } from '../src/report/text.ts';

describe('detail lines', () => {
  test('every status lands in one column, whatever its length', () => {
    const lines = [
      formatDetailLine('ok', 'GameData/a.ndf'),
      formatDetailLine('to remove', 'GameData/a.ndf'),
      formatDetailLine('generated', 'GameData/a.ndf'),
    ];
    const subjectColumns = lines.map((line) => line.indexOf('GameData/a.ndf'));

    expect(new Set(subjectColumns).size).toBe(1);
    // The gutter is real: no subject touches the status beside it.
    expect(lines.every((line) => line.includes('  GameData'))).toBe(true);
  });

  test('a note rides with its subject', () => {
    expect(formatDetailLine('skipped', 'balance.armor', 'no matching block')).toContain(
      'balance.armor (no matching block)',
    );
  });

  /**
   * The classifier used to be a second, hand-written list of prefixes, so a new
   * status could be printed for a run and quietly never be classified. This is
   * the gate that would have caught that.
   */
  test('routine classification agrees with the table the lines are written from', () => {
    for (const [status, routine] of Object.entries(DETAIL_STATUSES)) {
      expect(isRoutineDetailLine(formatDetailLine(status as never, 'subject'))).toBe(routine);
    }
  });

  test('a line nobody wrote through the vocabulary is treated as worth reading', () => {
    expect(isRoutineDetailLine('warning   2 patch operations: something happened')).toBe(false);
    expect(isRoutineDetailLine('okay so this is prose')).toBe(false);
  });
});

describe('facts', () => {
  test('labels share one column', () => {
    expect(
      formatFactLines([
        { label: 'wrote', value: '2 files' },
        { label: 'took', value: '1.20s' },
      ]),
    ).toEqual(['wrote  2 files', 'took   1.20s']);
  });

  test('capitalizes only when the caller asks', () => {
    expect(formatFactLines([{ label: 'wrote', value: '2 files' }], { indent: '  ' })).toEqual([
      '  wrote  2 files',
    ]);
    expect(
      formatFactLines([{ label: 'wrote', value: '2 files' }], { capitalizeLabels: true }),
    ).toEqual(['Wrote  2 files']);
  });

  test('drops facts with nothing to say', () => {
    expect(
      collectFacts([
        { label: 'reused', value: '' },
        undefined,
        { label: 'wrote', value: '1 file' },
      ]),
    ).toEqual([{ label: 'wrote', value: '1 file' }]);
  });

  test('counts pluralize, drop zeros, and say `nothing` when empty', () => {
    expect(
      countFact('outputs', [
        ['total', 4],
        ['patch', 2],
        ['script', 0],
      ]),
    ).toEqual({ label: 'outputs', value: '4 totals, 2 patches' });
    expect(countFact('outputs', [['total', 0]])).toEqual({ label: 'outputs', value: 'nothing' });
  });

  test('an explicit plural wins for a label whose last word is not its noun', () => {
    expect(
      countFact('applied', [['file reset to its original', 2, 'files reset to their originals']]),
    ).toEqual({ label: 'applied', value: '2 files reset to their originals' });
  });

  test('timing carries its breakdown', () => {
    expect(
      timingFact(1550, [
        ['plan', 120],
        ['write', 640],
      ]),
    ).toEqual({ label: 'took', value: '1.55s (plan 120ms, write 640ms)' });
  });
});

describe('command output', () => {
  test('summaries stay named values rather than text to re-parse', () => {
    const lines = toCommandOutput(['first detail'], {
      summary: [countFact('wrote', [['file', 2]]), undefined],
      detailHeading: 'preview files',
      locations: [{ label: 'preview', path: 'C:/mod/YMB/.ymb-build/output' }],
      nextSteps: ['Run `sync --yes` only after the preview looks correct.'],
    });

    expect(lines).toEqual(['first detail']);
    expect(lines.summary).toEqual([{ label: 'wrote', value: '2 files' }]);
    expect(lines.detailHeading).toBe('preview files');
  });

  test('a value holding the fact separator survives', () => {
    const lines = toCommandOutput([], {
      summary: [{ label: 'installed', value: 'nothing: not synced yet' }],
      detailHeading: 'paths',
    });

    expect(lines.summary?.[0]?.value).toBe('nothing: not synced yet');
  });
});

describe('shared text pieces', () => {
  test('one separator for a name and its value', () => {
    expect(formatInfoLine('game root', 'C:/WARNO')).toBe('game root -> C:/WARNO');
  });

  test('one separator between the fields of a record', () => {
    expect(formatRecordLine(['mod', 'my_pack', 'My Pack', 'on'])).toBe(
      'mod | my_pack | My Pack | on',
    );
  });

  test('durations switch to seconds at a second', () => {
    expect(formatDurationMs(18.4)).toBe('18ms');
    expect(formatDurationMs(1550)).toBe('1.55s');
  });
});

describe('materialization metrics', () => {
  test('counts written files by source type', () => {
    expect(
      countWrittenFiles([
        { targetRelativePath: 'a.ndf', sourceType: 'patch', content: '', contributors: [] },
        { targetRelativePath: 'b.ndf', sourceType: 'script', content: '', contributors: [] },
        { targetRelativePath: 'c.txt', sourceType: 'replace', content: '', contributors: [] },
        { targetRelativePath: 'd.ndf', sourceType: 'patch', content: '', contributors: [] },
        { targetRelativePath: 'e.bin', sourceType: 'file', content: '', contributors: [] },
      ]),
    ).toEqual({ patch: 2, replace: 1, script: 1, file: 1 });
  });

  test('a run that reused nothing reports no reuse fact at all', () => {
    const metrics = createMaterializationMetrics();
    expect(patchCacheFact(metrics)).toBeUndefined();

    metrics.patchCacheBypassed = 3;
    expect(patchCacheFact(metrics)).toEqual({
      label: 'reused',
      value: 'nothing, cache bypassed for 3 targets',
    });
  });
});
