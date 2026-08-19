import type { PatchApplication, PatchTarget } from '../types.ts';

export interface MaterializationMetrics {
  patchCacheHits: number;
  patchCacheMisses: number;
  patchCacheBypassed: number;
  mergedCacheHits: number;
  mergedCacheMisses: number;
}

export interface ResolvedPatchContribution {
  application: PatchApplication;
  target: PatchTarget;
  targetRelativePath: string;
  hasScripts: boolean;
  patchOrder: number;
}
