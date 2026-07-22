import type { WrittenBuildFile } from '../types.ts';
import type { MaterializationMetrics } from './types.ts';

interface CommandOutputLocation {
  label: string;
  path: string;
}

interface CommandOutputMeta {
  title?: string | undefined;
  detailHeading?: string | undefined;
  locations?: CommandOutputLocation[] | undefined;
  nextSteps?: string[] | undefined;
}

export type CommandOutputLines = string[] & {
  summary?: string[] | undefined;
  meta?: CommandOutputMeta | undefined;
};

export function withSummary(lines: string[], summary: string[]): CommandOutputLines {
  return Object.assign(lines, { summary });
}

export function withOutputMeta(
  lines: CommandOutputLines,
  meta: CommandOutputMeta,
): CommandOutputLines {
  return Object.assign(lines, { meta });
}

export function createSummaryLines(lines: string[]): string[] {
  return lines.filter((line) => line.length > 0);
}

export function formatTimingSummary(
  totalDurationMs: number,
  stages: Array<readonly [label: string, durationMs: number]>,
): string {
  const parts = [`total ${formatDurationMs(totalDurationMs)}`];
  for (const [label, durationMs] of stages) {
    parts.push(`${label} ${formatDurationMs(durationMs)}`);
  }
  return `timing: ${parts.join(' | ')}`;
}

export function formatCountSummary(
  label: string,
  counts: Array<readonly [itemLabel: string, count: number]>,
): string {
  return `${label}: ${counts.map(([itemLabel, count]) => `${count} ${itemLabel}`).join(' | ')}`;
}

export function createMaterializationMetrics(): MaterializationMetrics {
  return {
    patchCacheHits: 0,
    patchCacheMisses: 0,
    patchCacheBypassed: 0,
    mergedCacheHits: 0,
    mergedCacheMisses: 0,
  };
}

export function countWrittenFiles(
  writtenFiles: WrittenBuildFile[],
): Record<'patch' | 'replace' | 'script', number> {
  const counts = {
    patch: 0,
    replace: 0,
    script: 0,
  };

  for (const writtenFile of writtenFiles) {
    counts[writtenFile.sourceType] += 1;
  }

  return counts;
}

export function formatPatchCacheSummary(metrics: MaterializationMetrics): string {
  if (metrics.patchCacheBypassed > 0) {
    return `patch cache: bypassed for ${metrics.patchCacheBypassed} target`;
  }

  const mergedSummary =
    metrics.mergedCacheHits + metrics.mergedCacheMisses > 0
      ? ` | merged: ${metrics.mergedCacheHits} hit, ${metrics.mergedCacheMisses} miss`
      : '';
  return `patch cache: ${metrics.patchCacheHits} hit | ${metrics.patchCacheMisses} miss${mergedSummary}`;
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }

  return `${Math.round(durationMs)}ms`;
}
