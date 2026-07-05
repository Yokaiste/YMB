export type Scope = 'prod' | 'dev';

export type ErrorCategory =
  | 'CommandError'
  | 'LayoutError'
  | 'ConfigError'
  | 'SchemaError'
  | 'ParserError'
  | 'SelectorError'
  | 'ConflictError'
  | 'ScriptError'
  | 'RecoveryError'
  | 'IoError';

export interface ErrorContext {
  absolutePath: string;
  modId?: string | undefined;
  modName?: string | undefined;
  patchId?: string | undefined;
  operationIndex?: number | undefined;
  reason: string;
  suggestion: string;
  details?: string[] | undefined;
}

export interface ModConfig {
  version: number;
  id: string;
  name: string;
  description?: string | undefined;
  dependsOn: string[];
  priority: number;
  allowWriteToModifiedFiles: boolean;
  variables?: Record<string, unknown> | undefined;
  enabled: boolean;
  scripts: ScriptConfig[];
  tempPaths: TempArtifactConfig[];
}

export interface MatchWhere {
  [fieldName: string]: string | number | boolean;
}

export interface Selector {
  kind: 'field' | 'object' | 'collection';
  by: 'path' | 'name' | 'match' | 'index';
  value?: string | number | undefined;
  where?: MatchWhere | undefined;
}

export interface CopyDestination {
  kind: 'sibling' | 'name';
  name: string;
}

export interface CollectionPosition {
  mode: 'start' | 'end' | 'before' | 'after';
  anchor?: string | undefined;
}

export interface NdfOperation {
  op: 'add' | 'remove' | 'modify' | 'copy';
  selector: Selector;
  value?: unknown;
  changes?: Record<string, unknown> | undefined;
  destination?: CopyDestination | undefined;
  position?: CollectionPosition | undefined;
}

export interface PatchTarget {
  file: string;
  operations: NdfOperation[];
}

export interface ScriptConfig {
  path: string;
  enabled: boolean;
  tests: string[];
}

export interface TempArtifactConfig {
  path: string;
  unsafeToRemove: boolean;
}

export interface PatchConfig {
  version: number;
  id: string;
  name: string;
  description?: string | undefined;
  enabled: boolean;
  scope: Scope;
  dependsOn: string[];
  variables?: Record<string, unknown> | undefined;
  targets: PatchTarget[];
  scripts: ScriptConfig[];
  tempPaths: TempArtifactConfig[];
}

export interface DiscoveredPatch {
  config: PatchConfig;
  absolutePath: string;
  relativePathInMod: string;
  absoluteConfigPath: string;
}

export interface DiscoveredMod {
  config: ModConfig;
  absolutePath: string;
  configAbsolutePath: string;
  relativePathFromMods: string;
  absoluteConfigPath: string;
  patches: DiscoveredPatch[];
  replaceAbsolutePath?: string | undefined;
}

export interface BuilderContext {
  ymbRoot: string;
  modRoot: string;
  modsRoot: string;
  gameDataRoot: string;
  commonDataRoot: string;
  buildRoot: string;
  stateRoot: string;
}

export interface SelectionInput {
  scope: Scope;
  modFilters: string[];
  patchFilters: string[];
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
  useCache?: boolean;
}

export interface ReplaceFile {
  sourceAbsolutePath: string;
  targetRelativePath: string;
  modId: string;
  modName: string;
  priority: number;
  allowWriteToModifiedFiles: boolean;
  templateVariables: Record<string, unknown>;
}

export interface BuildContributor {
  modId: string;
  modName?: string | undefined;
  patchId?: string | undefined;
}

export interface PatchApplication {
  mod: DiscoveredMod;
  patch: DiscoveredPatch;
}

export interface ScriptApplication {
  mod: DiscoveredMod;
  patch?: DiscoveredPatch | undefined;
  config: ScriptConfig;
  absolutePath: string;
  testAbsolutePaths: string[];
}

export interface SelectedPatchReason {
  patchId: string;
  included: boolean;
  reasons: string[];
}

export interface BuildPlan {
  context: BuilderContext;
  selection: SelectionInput;
  discoveredMods: DiscoveredMod[];
  selectedMods: DiscoveredMod[];
  selectedPatches: PatchApplication[];
  selectedReplaceFiles: ReplaceFile[];
  selectedScripts: ScriptApplication[];
  explanations: SelectedPatchReason[];
  targetFiles: string[];
}

export type ScriptRuntimePlan = Pick<BuildPlan, 'context' | 'selection' | 'selectedReplaceFiles'>;

export interface WrittenBuildFile {
  targetRelativePath: string;
  sourceType: 'patch' | 'replace' | 'script';
  content: string | Uint8Array;
  contributors: BuildContributor[];
}

export interface GeneratedScriptFile {
  targetRelativePath: string;
  content: string | Uint8Array;
}

export interface BuildScriptContext {
  builder: BuilderContext;
  selection: SelectionInput;
  mod: DiscoveredMod;
  patch?: DiscoveredPatch | undefined;
  variables: Record<string, unknown>;
  resolvePath(relativePath: string): string;
  resolveModPath(relativePath: string): string;
  readOwnedTextIfExists(relativePath: string): Promise<string>;
  writeOwnedTextIfChanged(relativePath: string, content: string): Promise<boolean>;
  readModTextIfExists(relativePath: string): Promise<string>;
  writeModTextIfChanged(relativePath: string, content: string): Promise<boolean>;
  readTarget(relativePath: string): Promise<string>;
  readTargets(relativePaths: string[]): Promise<Record<string, string>>;
  readBinaryTarget(relativePath: string): Promise<Uint8Array>;
}

export interface BuildScriptTestContext extends BuildScriptContext {
  script: ScriptApplication;
  testAbsolutePath: string;
}

export type BuildScriptResult =
  | GeneratedScriptFile
  | GeneratedScriptFile[]
  | Promise<GeneratedScriptFile | GeneratedScriptFile[]>;

export type BuildScriptModule = {
  default?: ((context: BuildScriptContext) => BuildScriptResult) | undefined;
  generate?: ((context: BuildScriptContext) => BuildScriptResult) | undefined;
};

export interface ScriptTestResult {
  name: string;
  status: 'passed' | 'failed';
  reason?: string | undefined;
  suggestion?: string | undefined;
  details?: string[] | undefined;
}

export interface ScriptTestReport {
  results: ScriptTestResult[];
}

export type BuildScriptTestResult = ScriptTestReport | Promise<ScriptTestReport>;

export type BuildScriptTestModule = {
  default?: ((context: BuildScriptTestContext) => BuildScriptTestResult) | undefined;
};

export interface SyncManifestEntry {
  targetRelativePath: string;
  backupFileName: string;
  originalExists: boolean;
  contributors: BuildContributor[];
}

export interface SyncManifest {
  entries: SyncManifestEntry[];
}
