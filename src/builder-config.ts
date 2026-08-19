export interface BuilderProjectPaths {
  gameRoot: string;
  sourceMods: string;
  workRoot: string;
  recoveryRoot: string;
  operationLockRoot: string;
  stateTransactionRoot: string;
}

export interface BuilderProjectSettings {
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  cacheMaxAgeDays: number;
  scriptCacheMaxEntriesPerNamespace: number;
  scriptCacheMaxBytesPerNamespace: number;
  scriptTargetReadConcurrency: number;
  scriptTimeoutSeconds: number;
  /**
   * Ceilings on two line-diff jobs that grow super-linearly with file size. Over
   * budget, `merge*` applies contributions in priority order and `marker*` keeps only
   * whole-file markers. Neither loses content, so a project generating a very large
   * file raises them.
   */
  mergeMaxEstimatedDiffWork: number;
  mergeMaxTextBytesPerSide: number;
  mergeMaxTextBytesCombined: number;
  markerMaxEstimatedDiffWork: number;
  markerMaxTextBytesPerSide: number;
  markerMaxTextBytesCombined: number;
}

export interface BuilderProjectConfig {
  version: 1;
  paths: BuilderProjectPaths;
  settings: BuilderProjectSettings;
}

export const BUILDER_CONFIG = {
  name: 'YMB',
  rootDirectoryName: 'YMB',
  builderConfigFileName: 'ymb.config.yaml',
  modsDirectoryName: 'mods',
  configDirectoryName: 'config',
  patchDirectoryName: 'patch',
  replaceDirectoryName: 'replace',
  buildDirectoryName: '.ymb-build',
  buildOutputDirectoryName: 'output',
  conflictDirectoryName: 'conflicts',
  stateDirectoryName: '.ymb-state',
  recoveryOriginalsDirectoryName: 'originals',
  cacheDirectoryName: 'cache',
  patchCacheDirectoryName: 'patches',
  ndfValidationCacheDirectoryName: 'ndf-validation',
  modConfigFileName: 'ymb.mod.yaml',
  patchConfigFileName: 'ymb.patch.yaml',
  recoveryManifestFileName: 'manifest.json',
  operationLockDirectoryName: '.ymb-operation-lock',
  stateTransactionDirectoryName: '.ymb-state-transaction',
  tempPrefix: '.ymb',
  generatedBlockLabel: 'YMB',
  cacheMaxEntries: 512,
  cacheMaxBytes: 1024 * 1024 * 1024,
  cacheMaxAgeDays: 14,
  scriptCacheMaxEntriesPerNamespace: 4,
  scriptCacheMaxBytesPerNamespace: 256 * 1024 * 1024,
  scriptTargetReadConcurrency: 8,
  scriptTimeoutSeconds: 120,
  mergeMaxEstimatedDiffWork: 50_000_000,
  mergeMaxTextBytesPerSide: 4_000_000,
  mergeMaxTextBytesCombined: 6_000_000,
  markerMaxEstimatedDiffWork: 2_000_000,
  markerMaxTextBytesPerSide: 1_000_000,
  markerMaxTextBytesCombined: 1_500_000,
} as const;

export function createDefaultBuilderProjectConfig(): BuilderProjectConfig {
  return {
    version: 1,
    paths: {
      gameRoot: '..',
      sourceMods: BUILDER_CONFIG.modsDirectoryName,
      workRoot: BUILDER_CONFIG.buildDirectoryName,
      recoveryRoot: BUILDER_CONFIG.stateDirectoryName,
      operationLockRoot: BUILDER_CONFIG.operationLockDirectoryName,
      stateTransactionRoot: BUILDER_CONFIG.stateTransactionDirectoryName,
    },
    settings: {
      cacheMaxEntries: BUILDER_CONFIG.cacheMaxEntries,
      cacheMaxBytes: BUILDER_CONFIG.cacheMaxBytes,
      cacheMaxAgeDays: BUILDER_CONFIG.cacheMaxAgeDays,
      scriptCacheMaxEntriesPerNamespace: BUILDER_CONFIG.scriptCacheMaxEntriesPerNamespace,
      scriptCacheMaxBytesPerNamespace: BUILDER_CONFIG.scriptCacheMaxBytesPerNamespace,
      scriptTargetReadConcurrency: BUILDER_CONFIG.scriptTargetReadConcurrency,
      scriptTimeoutSeconds: BUILDER_CONFIG.scriptTimeoutSeconds,
      mergeMaxEstimatedDiffWork: BUILDER_CONFIG.mergeMaxEstimatedDiffWork,
      mergeMaxTextBytesPerSide: BUILDER_CONFIG.mergeMaxTextBytesPerSide,
      mergeMaxTextBytesCombined: BUILDER_CONFIG.mergeMaxTextBytesCombined,
      markerMaxEstimatedDiffWork: BUILDER_CONFIG.markerMaxEstimatedDiffWork,
      markerMaxTextBytesPerSide: BUILDER_CONFIG.markerMaxTextBytesPerSide,
      markerMaxTextBytesCombined: BUILDER_CONFIG.markerMaxTextBytesCombined,
    },
  };
}

export const BUILDER_TEMP_PREFIXES = [BUILDER_CONFIG.tempPrefix] as const;
