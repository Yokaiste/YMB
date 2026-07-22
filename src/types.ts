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

export type FieldPathSelector = {
  kind: 'field';
  by: 'path';
  value: string;
  where?: never;
};

export type CollectionPathSelector = {
  kind: 'collection';
  by: 'path';
  value: string;
  where?: never;
};

export type ObjectSelector =
  | { kind: 'object'; by: 'name'; value: string; where?: never }
  | { kind: 'object'; by: 'index'; value: number; where?: never }
  | { kind: 'object'; by: 'match'; where: MatchWhere; value?: never };

export type Selector = FieldPathSelector | CollectionPathSelector | ObjectSelector;

export interface CopyDestination {
  kind: 'sibling' | 'name';
  name: string;
}

export interface CollectionPosition {
  mode: 'start' | 'end' | 'before' | 'after';
  anchor?: string | undefined;
}

interface OperationWithoutValueOrChanges {
  value?: never;
  changes?: never;
}

interface OperationWithoutDestination {
  destination?: never;
}

interface OperationWithoutPosition {
  position?: never;
}

export type CopyOperation = OperationWithoutValueOrChanges &
  OperationWithoutPosition & {
    op: 'copy';
    selector: ObjectSelector;
    destination: CopyDestination;
    leadingComment?: string | undefined;
  };

export type ModifyOperation = OperationWithoutDestination &
  OperationWithoutPosition &
  (
    | {
        op: 'modify';
        selector: FieldPathSelector;
        value: unknown;
        changes?: never;
        leadingComment?: never;
      }
    | {
        op: 'modify';
        selector: ObjectSelector;
        value?: never;
        changes: Record<string, unknown>;
        leadingComment?: string | undefined;
      }
  );

export type AddOperation = OperationWithoutDestination &
  (
    | {
        op: 'add';
        selector: Extract<ObjectSelector, { by: 'name' | 'index' }>;
        value: unknown;
        changes?: never;
        position?: never;
        leadingComment?: string | undefined;
      }
    | {
        op: 'add';
        selector: CollectionPathSelector;
        value: unknown;
        changes?: never;
        position?: CollectionPosition | undefined;
        leadingComment?: string | undefined;
      }
    | {
        op: 'add';
        selector: FieldPathSelector;
        value: unknown;
        changes?: never;
        position?: never;
        leadingComment?: never;
      }
  );

export type RemoveOperation = OperationWithoutValueOrChanges &
  OperationWithoutDestination &
  OperationWithoutPosition &
  (
    | {
        op: 'remove';
        selector: ObjectSelector;
        leadingComment?: string | undefined;
      }
    | { op: 'remove'; selector: FieldPathSelector; leadingComment?: never }
  );

export type BulkConditionSubject = 'name' | 'type' | 'text' | 'field';
export type BulkConditionOperator = 'startsWith' | 'endsWith' | 'contains' | 'notContains';

type BulkTextCondition = {
  on: Exclude<BulkConditionSubject, 'field'>;
  field?: never;
  is: BulkConditionOperator;
  value: string[];
};

type BulkFieldCondition = {
  on: 'field';
  field: string;
  is: BulkConditionOperator;
  value: string[];
};

export type BulkCondition = BulkTextCondition | BulkFieldCondition;

export interface BulkMatch {
  mode: 'all' | 'any';
  conditions: BulkCondition[];
}

export interface BulkInsertEntry {
  value: unknown;
  position: 'start' | 'end';
}

export interface BulkSetEntry {
  index: number;
  value: unknown;
}

interface BulkChangeExpectation {
  minChanges?: number | undefined;
}

type BulkValueTarget =
  | { field: string; mapEntry?: never; list?: never }
  | { field?: never; mapEntry: string; list?: never };

type BulkValueAction =
  | {
      set: unknown;
      multiply?: never;
      insert?: never;
      removeEntry?: never;
      setEntry?: never;
    }
  | {
      set?: never;
      multiply: number;
      insert?: never;
      removeEntry?: never;
      setEntry?: never;
    };

type BulkListAction =
  | {
      insert: BulkInsertEntry;
      removeEntry?: never;
      setEntry?: never;
      set?: never;
      multiply?: never;
    }
  | {
      insert?: never;
      removeEntry: string;
      setEntry?: never;
      set?: never;
      multiply?: never;
    }
  | {
      insert?: never;
      removeEntry?: never;
      setEntry: BulkSetEntry;
      set?: never;
      multiply?: never;
    };

export type BulkValueEdit = BulkChangeExpectation &
  BulkValueTarget &
  BulkValueAction & { comment?: string | undefined };
export type BulkListEdit = BulkChangeExpectation &
  BulkListAction & { field?: never; mapEntry?: never; list: string };
export type BulkEdit = BulkValueEdit | BulkListEdit;

export interface BulkExpectation {
  minBlocks: number;
}

export interface BulkOperation {
  op: 'bulk';
  match: BulkMatch;
  edits: BulkEdit[];
  leadingComment?: string | undefined;
  expect: BulkExpectation;
  selector?: never;
  value?: never;
  changes?: never;
  destination?: never;
  position?: never;
}

export type ExactNdfOperation = CopyOperation | ModifyOperation | AddOperation | RemoveOperation;
export type NdfOperation = ExactNdfOperation | BulkOperation;

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

export interface SyncManifestEntry {
  targetRelativePath: string;
  backupFileName: string;
  originalExists: boolean;
  syncedContentHash?: string | undefined;
  contributors: BuildContributor[];
}

export interface SyncManifest {
  entries: SyncManifestEntry[];
}
