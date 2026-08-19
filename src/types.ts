import type { BuildScriptErrorCategory, ScriptScope } from 'ymb/api';
import type { BuilderProjectConfig } from './builder-config.ts';
import type { UnmatchedSelectionFilter } from './selection-filter.ts';

export type Scope = ScriptScope;
export type ErrorCategory = BuildScriptErrorCategory;

export interface ErrorContext {
  absolutePath: string;
  modId?: string | undefined;
  modName?: string | undefined;
  patchId?: string | undefined;
  operationIndex?: number | undefined;
  /** Patch config file the operation was written in, when one is known. */
  patchConfigPath?: string | undefined;
  /** 1-based line of that operation inside `patchConfigPath`. */
  operationLine?: number | undefined;
  reason: string;
  suggestion: string;
  details?: string[] | undefined;
}

/**
 * One value lifted out of the game's own files and handed to the templates as a
 * variable. `path` uses the same selector syntax a `modify` operation targets a
 * field with, so anything that can be changed can also be read.
 */
export interface ReadValueConfig {
  file: string;
  path: string;
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
  readValues?: Record<string, ReadValueConfig> | undefined;
  enabled: boolean;
  scripts: ScriptConfig[];
  tempPaths: TempArtifactConfig[];
}

interface MatchWhere {
  [fieldName: string]: string | number | boolean;
}

export type FieldPathSelector = {
  kind: 'field';
  by: 'path';
  value: string;
  where?: never;
};

type CollectionPathSelector = {
  kind: 'collection';
  by: 'path';
  value: string;
  where?: never;
};

type ObjectSelector =
  | { kind: 'object'; by: 'name'; value: string; where?: never }
  | { kind: 'object'; by: 'index'; value: number; where?: never }
  | { kind: 'object'; by: 'match'; where: MatchWhere; value?: never };

export type Selector = FieldPathSelector | CollectionPathSelector | ObjectSelector;

interface CopyDestination {
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
  // A new top-level block takes no selector: there is nothing in the file yet
  // to select. `position.anchor` names an existing block to sit beside.
  (
    | {
        op: 'add';
        selector?: never;
        value: unknown;
        changes?: never;
        position?: CollectionPosition | undefined;
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

type BulkConditionSubject = 'name' | 'type' | 'text' | 'field';
type BulkConditionOperator = 'startsWith' | 'endsWith' | 'contains' | 'notContains';

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

interface BulkInsertEntry {
  value: unknown;
  position: 'start' | 'end';
}

interface BulkSetEntry {
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
  BulkValueAction & { trailingComment?: string | undefined };
export type BulkListEdit = BulkChangeExpectation &
  BulkListAction & { field?: never; mapEntry?: never; list: string };
export type BulkEdit = BulkValueEdit | BulkListEdit;

interface BulkExpectation {
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

type ExactNdfOperation = CopyOperation | ModifyOperation | AddOperation | RemoveOperation;
export type NdfOperation = ExactNdfOperation | BulkOperation;

/**
 * One authored `forEach` block. `items` is whatever the config wrote - usually a
 * template expression resolving to an array - and `do` is expanded once per
 * entry with `as` bound to it.
 */
export interface ForEachOperations {
  forEach: unknown;
  as: string;
  do: AuthoredOperation[];
}

/** What a config may write inside `operations`, before expansion. */
export type AuthoredOperation = NdfOperation | ForEachOperations;

/** A target as authored, with `forEach` blocks still unexpanded. */
export interface AuthoredPatchTarget {
  file: string;
  operations: AuthoredOperation[];
  /** 1-based patch-file line per authored operation, parallel to `operations`. */
  operationLines?: number[] | undefined;
  expect?: PatchTargetExpectation | undefined;
}

/**
 * What the author states must still be true of the whole project once this
 * target has applied, as opposed to what one operation must find.
 */
interface PatchTargetExpectation {
  /**
   * Top-level blocks that must still be named by something after this target
   * applies. A block nothing points at is compiled into the mod and drawn by
   * nobody, which no operation can notice on its own: each one succeeded.
   */
  referenced: string[];
}

/** A target after variables are resolved and every `forEach` is expanded. */
export interface PatchTarget {
  file: string;
  operations: NdfOperation[];
  /** 1-based patch-file line per expanded operation, parallel to `operations`. */
  operationLines?: number[] | undefined;
  expect?: PatchTargetExpectation | undefined;
}

/**
 * `before` is the default and cheaper: it drives the script's exports against the
 * game files and stops the run before generation spends time. `after` is for what
 * only the finished run can show -- its outputs, and the files it keeps between runs.
 */
export type ScriptTestPhase = 'before' | 'after';

interface ScriptTestConfig {
  path: string;
  when: ScriptTestPhase;
}

export interface ScriptConfig {
  path: string;
  enabled: boolean;
  tests: ScriptTestConfig[];
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
  readValues?: Record<string, ReadValueConfig> | undefined;
  files: FileOperation[];
  /** 1-based patch-file line per file operation, parallel to `files`. */
  fileOperationLines?: number[] | undefined;
  targets: AuthoredPatchTarget[];
  /**
   * A feature built on game data that may not be there. When the file it targets
   * is absent, or a selector finds nothing to work with, the whole patch is left
   * out instead of stopping the build. `--require-all` turns that off.
   */
  optional: boolean;
  scripts: ScriptConfig[];
  tempPaths: TempArtifactConfig[];
}

type FileSourceRoot = 'patch' | 'mod' | 'game' | 'exampleAssets';

export interface FileSource {
  root: FileSourceRoot;
  path: string;
}

interface FileCountExpectation {
  files: number;
}

type FileWriteOperation = {
  op: 'add' | 'copy' | 'replace';
  source: FileSource;
  destination: string;
  expect?: FileCountExpectation | undefined;
};

type FileRemoveOperation = {
  op: 'remove';
  target: string;
  expect?: FileCountExpectation | undefined;
  source?: never;
  destination?: never;
};

export type FileOperation = FileWriteOperation | FileRemoveOperation;

export interface DiscoveredPatch {
  config: PatchConfig;
  /** Directory holding the patch, and the root its relative paths resolve against. */
  absolutePath: string;
  relativePathInMod: string;
  /** The patch's own `ymb.patch.yaml`. */
  configFilePath: string;
  /** `readValues` after the game files were read, ready to use as variables. */
  readValues?: Record<string, unknown> | undefined;
}

export interface DiscoveredMod {
  config: ModConfig;
  /** The source mod's own directory under `mods/`. */
  absolutePath: string;
  /** The `config/` directory inside it, and the root mod-level relative paths resolve against. */
  configDirectoryPath: string;
  relativePathFromMods: string;
  /** The mod's own `ymb.mod.yaml` inside `config/`. */
  configFilePath: string;
  patches: DiscoveredPatch[];
  replaceAbsolutePath?: string | undefined;
  /** `readValues` after the game files were read, ready to use as variables. */
  readValues?: Record<string, unknown> | undefined;
}

export interface BuilderContext {
  ymbRoot: string;
  builderConfigPath: string;
  builderConfig: BuilderProjectConfig;
  modRoot: string;
  modsRoot: string;
  gameDataRoot: string;
  commonDataRoot: string;
  buildRoot: string;
  buildOutputRoot: string;
  buildCacheRoot: string;
  conflictPreviewRoot: string;
  stateRoot: string;
  operationLockRoot: string;
  stateTransactionRoot: string;
}

export interface SelectionInput {
  scope: Scope;
  modFilters: string[];
  patchFilters: string[];
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
  useCache?: boolean;
  /**
   * Discard live files that changed outside YMB, restoring the recorded original
   * before the run applies anything on top of it.
   */
  resetChanged?: boolean;
  /**
   * Hold every `optional` patch to the same standard as the rest, so missing
   * game data stops the run instead of quietly dropping a feature.
   */
  requireAll?: boolean;
}

export interface ReplaceFile {
  sourceAbsolutePath: string;
  targetRelativePath: string;
  modId: string;
  modName: string;
  priority: number;
  allowWriteToModifiedFiles: boolean;
  templateVariables: Record<string, unknown>;
  sourceType: 'replace' | 'file';
  contentMode: 'template' | 'exact';
  patchId?: string | undefined;
  sourceGameRelativePath?: string | undefined;
}

export interface FileDeletion {
  targetRelativePath: string;
  modId: string;
  modName: string;
  patchId: string;
  priority: number;
  allowWriteToModifiedFiles: boolean;
}

export interface BuildContributor {
  modId: string;
  modName?: string | undefined;
  patchId?: string | undefined;
}

export interface PatchApplication {
  mod: DiscoveredMod;
  patch: DiscoveredPatch;
  /**
   * Scoped onto the application while one target runs, because the deep NDF walks know
   * their operation index but not their target, and a patch may target a file twice.
   */
  operationLines?: number[] | undefined;
}

export interface ResolvedScriptTest {
  absolutePath: string;
  when: ScriptTestPhase;
}

export interface ScriptApplication {
  mod: DiscoveredMod;
  patch?: DiscoveredPatch | undefined;
  config: ScriptConfig;
  absolutePath: string;
  tests: ResolvedScriptTest[];
}

/** An `optional` patch left out because the game data it needs is not there. */
export interface SkippedPatch {
  modId: string;
  modName: string;
  patchId: string;
  /** Plain-language account of what was missing, for the run summary. */
  reason: string;
}

export interface SelectedPatchReason {
  modId: string;
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
  selectedFileDeletions: FileDeletion[];
  selectedScripts: ScriptApplication[];
  explanations: SelectedPatchReason[];
  skippedPatches: SkippedPatch[];
  targetFiles: string[];
  /** What planning noticed but did not fail on, such as a removal with nothing left to remove. */
  notices: PatchNotice[];
  /** `--mod` and `--patch` values nothing in the project answered to. */
  unmatchedFilters: UnmatchedSelectionFilter[];
}

export type ScriptRuntimePlan = Pick<BuildPlan, 'context' | 'selection' | 'selectedReplaceFiles'>;

/**
 * A patch writing the value a file already holds is not broken, but must not pass
 * unseen: an operation that no longer does anything is one the author can delete.
 * Plain data, because it travels through the patch cache and back from a worker.
 */
export interface PatchNotice {
  absolutePath: string;
  modId: string;
  modName: string;
  patchId: string;
  operationIndex: number;
  /** Patch config file the operation was written in, when one is known. */
  patchConfigPath?: string | undefined;
  /** 1-based line of that operation inside `patchConfigPath`. */
  operationLine?: number | undefined;
  reason: string;
  suggestion: string;
}

export interface WrittenBuildFile {
  targetRelativePath: string;
  sourceType: 'patch' | 'replace' | 'script' | 'file';
  content: string | Uint8Array;
  contributors: BuildContributor[];
  preservesSourceBytes?: boolean | undefined;
  notices?: PatchNotice[] | undefined;
}

export interface SyncManifestEntry {
  targetRelativePath: string;
  backupFileName: string;
  originalExists: boolean;
  expectedState?: 'present' | 'absent' | undefined;
  originalContentHash?: string | undefined;
  syncedContentHash?: string | undefined;
  contributors: BuildContributor[];
}

export interface SyncManifest {
  entries: SyncManifestEntry[];
}
