import path from 'node:path';
import { createDefaultBuilderProjectConfig } from '../../src/builder-config.ts';
import type {
  BuilderContext,
  BuildPlan,
  DiscoveredMod,
  DiscoveredPatch,
  ModConfig,
  PatchApplication,
  PatchConfig,
  ScriptApplication,
  ScriptRuntimePlan,
  SelectionInput,
} from '../../src/types.ts';

export function createTestPatchApplication(options: {
  modId: string;
  modName?: string;
  patchId: string;
  patchName?: string;
  targetFiles?: string[];
  hasScripts?: boolean;
  modsRoot?: string;
}): PatchApplication {
  const modConfig: ModConfig = {
    version: 1,
    id: options.modId,
    name: options.modName ?? options.modId.toUpperCase(),
    dependsOn: [],
    priority: 0,
    allowWriteToModifiedFiles: false,
    enabled: true,
    scripts: [],
    tempPaths: [],
  };
  const patchConfig: PatchConfig = {
    version: 1,
    id: options.patchId,
    name: options.patchName ?? options.patchId,
    enabled: true,
    scope: 'prod',
    dependsOn: [],
    files: [],
    targets: (options.targetFiles ?? ['GameData/Generated/Test.ndf']).map((file) => ({
      file,
      operations: [],
    })),
    optional: false,
    scripts: options.hasScripts ? [{ path: 'generate.ts', enabled: true, tests: [] }] : [],
    tempPaths: [],
  };
  const modsRoot = options.modsRoot ?? path.resolve('mods');
  const modRoot = path.join(modsRoot, options.modId);
  const mod: DiscoveredMod = {
    config: modConfig,
    absolutePath: modRoot,
    configDirectoryPath: path.join(modRoot, 'config'),
    relativePathFromMods: options.modId,
    configFilePath: path.join(modRoot, 'config', 'ymb.mod.yaml'),
    patches: [],
  };
  const patchRoot = path.join(modRoot, 'config', 'patch', options.patchId);
  const patch: DiscoveredPatch = {
    config: patchConfig,
    absolutePath: patchRoot,
    relativePathInMod: `config/patch/${options.patchId}`,
    configFilePath: path.join(patchRoot, 'ymb.patch.yaml'),
  };
  return { mod, patch };
}

export function createTestBuilderContext(
  modRoot = path.resolve('mod-root'),
  ymbRoot = path.join(modRoot, 'YMB'),
): BuilderContext {
  const builderConfig = createDefaultBuilderProjectConfig();
  const buildRoot = path.join(ymbRoot, builderConfig.paths.workRoot);
  const stateRoot = path.join(ymbRoot, builderConfig.paths.recoveryRoot);
  return {
    ymbRoot,
    builderConfigPath: path.join(ymbRoot, 'ymb.config.yaml'),
    builderConfig,
    modRoot,
    modsRoot: path.join(ymbRoot, builderConfig.paths.sourceMods),
    gameDataRoot: path.join(modRoot, 'GameData'),
    commonDataRoot: path.join(modRoot, 'CommonData'),
    buildRoot,
    buildOutputRoot: path.join(buildRoot, 'output'),
    buildCacheRoot: path.join(buildRoot, 'cache'),
    conflictPreviewRoot: path.join(buildRoot, 'conflicts'),
    stateRoot,
    operationLockRoot: path.join(ymbRoot, builderConfig.paths.operationLockRoot),
    stateTransactionRoot: path.join(ymbRoot, builderConfig.paths.stateTransactionRoot),
  };
}

export function createTestSelection(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    scope: 'prod',
    modFilters: [],
    patchFilters: [],
    dryRun: true,
    verbose: false,
    yes: false,
    ...overrides,
  };
}

export function createTestBuildPlan(
  context: BuilderContext,
  selection: Partial<SelectionInput> = {},
): BuildPlan {
  return {
    context,
    selection: createTestSelection(selection),
    discoveredMods: [],
    selectedMods: [],
    selectedPatches: [],
    selectedReplaceFiles: [],
    selectedFileDeletions: [],
    selectedScripts: [],
    explanations: [],
    skippedPatches: [],
    targetFiles: [],
    notices: [],
    unmatchedFilters: [],
  };
}

export function createTestScriptRuntimePlan(
  context: BuilderContext,
  selection: Partial<SelectionInput> = {},
): ScriptRuntimePlan {
  const plan = createTestBuildPlan(context, selection);
  return {
    context: plan.context,
    selection: plan.selection,
    selectedReplaceFiles: plan.selectedReplaceFiles,
  };
}

export function createTestScriptApplication(options: {
  patchId: string;
  patchName?: string;
  modsRoot?: string;
}): ScriptApplication {
  const application = createTestPatchApplication({
    modId: 'sample_pack',
    modName: 'Sample Pack',
    patchId: options.patchId,
    targetFiles: [],
    ...(options.patchName ? { patchName: options.patchName } : {}),
    ...(options.modsRoot ? { modsRoot: options.modsRoot } : {}),
  });
  return {
    ...application,
    config: { path: 'generate.ts', enabled: true, tests: [] },
    absolutePath: path.join(application.patch.absolutePath, 'generate.ts'),
    tests: [],
  };
}
