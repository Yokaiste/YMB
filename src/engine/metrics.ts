import type { Fact } from '../report/facts.ts';
import { pluralize } from '../report/text.ts';
import type { WrittenBuildFile } from '../types.ts';
import type { MaterializationMetrics } from './types.ts';

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
): Record<WrittenBuildFile['sourceType'], number> {
  const counts = {
    patch: 0,
    replace: 0,
    script: 0,
    file: 0,
  };

  for (const writtenFile of writtenFiles) {
    counts[writtenFile.sourceType] += 1;
  }

  return counts;
}

/** Framed as reuse rather than hit/miss: it answers "why was this fast or slow". */
export function patchCacheFact(metrics: MaterializationMetrics): Fact | undefined {
  if (metrics.patchCacheBypassed > 0) {
    return {
      label: 'reused',
      value: `nothing, cache bypassed for ${metrics.patchCacheBypassed} ${pluralize('target', metrics.patchCacheBypassed)}`,
    };
  }

  const total = metrics.patchCacheHits + metrics.patchCacheMisses;
  const merged = metrics.mergedCacheHits + metrics.mergedCacheMisses;
  const parts: string[] = [];
  if (total > 0) {
    parts.push(
      `${metrics.patchCacheHits} of ${total} ${pluralize('patch target', total)} from cache`,
    );
  }
  if (merged > 0) {
    parts.push(
      `${metrics.mergedCacheHits} of ${merged} merged ${pluralize('result', merged)} from cache`,
    );
  }
  return parts.length > 0 ? { label: 'reused', value: parts.join(', ') } : undefined;
}
