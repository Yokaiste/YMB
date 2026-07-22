import { describe, expect, test } from 'bun:test';
import {
  countWrittenFiles,
  createMaterializationMetrics,
  createSummaryLines,
  formatCountSummary,
  formatDurationMs,
  formatPatchCacheSummary,
  formatTimingSummary,
  withSummary,
} from '../src/engine/command-output.ts';

describe('command output helpers', () => {
  test('attaches filtered summaries to command output lines', () => {
    const lines = withSummary(['line one'], createSummaryLines(['summary', '', 'tail']));

    expect(lines).toEqual(['line one']);
    expect(lines.summary).toEqual(['summary', 'tail']);
  });

  test('counts written files by source type', () => {
    expect(
      countWrittenFiles([
        { targetRelativePath: 'a.ndf', sourceType: 'patch', content: '', contributors: [] },
        { targetRelativePath: 'b.ndf', sourceType: 'script', content: '', contributors: [] },
        { targetRelativePath: 'c.txt', sourceType: 'replace', content: '', contributors: [] },
        { targetRelativePath: 'd.ndf', sourceType: 'patch', content: '', contributors: [] },
      ]),
    ).toEqual({
      patch: 2,
      replace: 1,
      script: 1,
    });
  });

  test('formats compact summaries consistently', () => {
    const metrics = createMaterializationMetrics();
    expect(formatPatchCacheSummary(metrics)).toBe('patch cache: 0 hit | 0 miss');

    metrics.patchCacheBypassed = 3;
    expect(formatPatchCacheSummary(metrics)).toBe('patch cache: bypassed for 3 target');

    expect(formatDurationMs(18.4)).toBe('18ms');
    expect(formatDurationMs(1550)).toBe('1.55s');
    expect(
      formatTimingSummary(1550, [
        ['plan', 120],
        ['write', 640],
      ]),
    ).toBe('timing: total 1.55s | plan 120ms | write 640ms');
    expect(
      formatCountSummary('outputs', [
        ['total', 4],
        ['patch', 2],
      ]),
    ).toBe('outputs: 4 total | 2 patch');
  });
});
