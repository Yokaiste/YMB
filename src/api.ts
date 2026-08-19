export type ScriptScope = 'prod' | 'dev';

export type BuildScriptErrorCategory =
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

export interface GeneratedScriptFile {
  targetRelativePath: string;
  content: string | Uint8Array;
  generatedBlockOwnerPaths?: readonly string[] | undefined;
}

export interface BuildScriptBuilderInfo {
  readonly ymbRoot: string;
  readonly builderConfigPath: string;
  readonly modRoot: string;
  readonly modsRoot: string;
  readonly gameDataRoot: string;
  readonly commonDataRoot: string;
  readonly buildRoot: string;
  readonly buildOutputRoot: string;
  readonly buildCacheRoot: string;
  readonly conflictPreviewRoot: string;
  readonly stateRoot: string;
  readonly operationLockRoot: string;
  readonly stateTransactionRoot: string;
}

export interface BuildScriptSelectionInfo {
  readonly scope: ScriptScope;
  readonly modFilters: readonly string[];
  readonly patchFilters: readonly string[];
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly useCache: boolean;
}

interface BuildScriptOwnerInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly rootPath: string;
  readonly configPath: string;
}

export type BuildScriptModInfo = BuildScriptOwnerInfo;

export type BuildScriptPatchInfo = BuildScriptOwnerInfo;

export interface BuildScriptApplicationInfo {
  readonly path: string;
  readonly absolutePath: string;
  readonly testPaths: readonly string[];
}

export interface BuildScriptNdfBlock {
  name?: string | undefined;
  typeName: string;
  start: number;
  end: number;
  text: string;
}

export interface BuildScriptNdfFieldRange {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  text: string;
  valueText: string;
}

export interface BuildScriptNdfCommentedFieldRange extends BuildScriptNdfFieldRange {
  trailingComment?: string | undefined;
}

export interface BuildScriptNdfRange {
  start: number;
  end: number;
  text: string;
}

export type BuildScriptNdfScalar =
  | { kind: 'int'; value: number; raw: string }
  | { kind: 'float'; value: number; raw: string }
  | { kind: 'bool'; value: boolean; raw: string }
  | { kind: 'string'; value: string; raw: string }
  | { kind: 'reference'; value: string; raw: string }
  | { kind: 'raw'; value: string; raw: string };

export type BuildScriptCollectionPosition =
  'start' | 'end' | { before: string } | { after: string };

export interface BuildScriptGeneratedBlock {
  id: string;
  fullText: string;
  innerText: string;
  sourcePath?: string | undefined;
  start: number;
  end: number;
}

export interface BuildScriptGeneratedBlockOptions {
  ownerId: string;
  blocks: string[];
  title?: string;
  sourcePath?: string;
}

export interface BuildScriptGeneratedBlockMarkers {
  start: string;
  end: string;
}

export interface BuildScriptNdfCollectionEntry {
  start: number;
  end: number;
  separatorStart: number;
  separatorEnd: number;
  text: string;
  typeName?: string | undefined;
}

export type BuildScriptNdfValidationResult =
  | { ok: true }
  | {
      ok: false;
      error: {
        category: BuildScriptErrorCategory;
        message: string;
        absolutePath: string;
        reason: string;
        suggestion: string;
        details: string[];
      };
    };

export interface BuildScriptNdfTools {
  validate(text: string, pathHint?: string): BuildScriptNdfValidationResult;
  assertValid(text: string, pathHint?: string): void;
  findTopLevelBlocks(text: string): BuildScriptNdfBlock[];
  findNamedBlock(text: string, name: string): BuildScriptNdfBlock | undefined;
  findField(blockText: string, fieldName: string): BuildScriptNdfFieldRange | undefined;
  findFieldDeep(blockText: string, fieldName: string): BuildScriptNdfFieldRange | undefined;
  findFieldWithComment(
    blockText: string,
    fieldName: string,
  ): BuildScriptNdfCommentedFieldRange | undefined;
  findCollectionEntries(collectionText: string): BuildScriptNdfCollectionEntry[];
  readField(blockText: string, fieldName: string): string | undefined;
  readFields(blockText: string, fieldNames: readonly string[]): Record<string, string>;
  readFieldDeep(blockText: string, fieldName: string): string | undefined;
  readFieldsDeep(blockText: string, fieldNames: readonly string[]): Record<string, string>;
  readPath(text: string, path: string | string[]): string | undefined;
  extractBody(text: string): BuildScriptNdfRange | undefined;
  extractCollection(text: string): BuildScriptNdfRange | undefined;
  parseValue(valueText: string): BuildScriptNdfScalar;
  parseList(collectionText: string): BuildScriptNdfScalar[];
  primaryTypeName(typeName: string): string;
  listGeneratedBlocks(text: string): BuildScriptGeneratedBlock[];
  stripGeneratedBlocks(text: string): string;
  generatedBlockMarkers(ownerId: string): BuildScriptGeneratedBlockMarkers;
  renderGeneratedBlock(options: BuildScriptGeneratedBlockOptions): string;
  upsertGeneratedBlock(text: string, generatedBlock: string, ownerId: string): string;
  insertIntoCollection(
    text: string,
    collectionPath: string,
    entry: string | { $raw: string | number | bigint | boolean },
    options?: { position?: BuildScriptCollectionPosition | undefined },
  ): string;
  formatValue(value: unknown): string;
  stripComments(text: string): string;
}

export interface BuildScriptAssertionOptions {
  reason: string;
  suggestion: string;
  details?: string[] | undefined;
  absolutePath?: string | undefined;
}

export interface BuildScriptSelfCheck {
  name: string;
  run: () => void | Promise<void>;
  suggestion?: string | undefined;
}

export interface BuildScriptAssertionTools {
  ok(condition: unknown, options: BuildScriptAssertionOptions): asserts condition;
  textPresent(content: string, options: BuildScriptAssertionOptions): void;
  textIncludes(
    content: string,
    expectedFragment: string,
    options: BuildScriptAssertionOptions,
  ): void;
  textMatches(content: string, pattern: RegExp, options: BuildScriptAssertionOptions): void;
  all(checks: BuildScriptSelfCheck[]): Promise<void>;
}

export interface BuildScriptValueTools {
  record(value: unknown, label: string): Record<string, unknown>;
  string(value: unknown, label: string): string;
  optionalString(value: unknown, label: string): string | undefined;
  boolean(value: unknown, label: string): boolean;
  stringArray(value: unknown, label: string): string[];
  oneOf<const Values extends readonly string[]>(
    value: unknown,
    label: string,
    allowedValues: Values,
  ): Values[number];
  positiveInteger(value: unknown, label: string): number;
}

export interface BuildScriptTextTools {
  escapeRegExp(value: string): string;
  describeChanges(
    baseText: string,
    nextText: string,
  ):
    | { ok: true; edits: Array<{ start: number; end: number }> }
    | { ok: false; reason: 'budget_exceeded' };
}

export interface BuildScriptCacheTools {
  readonly enabled: boolean;
  hash(content: string | Uint8Array): string;
  createKey(input: unknown): Promise<string>;
  readJson<T>(
    namespace: string,
    key: string,
    validate: (value: unknown) => value is T,
  ): Promise<T | undefined>;
  writeJson(namespace: string, key: string, value: unknown): Promise<void>;
}

export interface BuildScriptTools {
  readonly apiVersion: 4;
  ndf: BuildScriptNdfTools;
  assert: BuildScriptAssertionTools;
  values: BuildScriptValueTools;
  text: BuildScriptTextTools;
  cache: BuildScriptCacheTools;
}

export interface BuildScriptContext {
  readonly builder: BuildScriptBuilderInfo;
  readonly selection: BuildScriptSelectionInfo;
  readonly mod: BuildScriptModInfo;
  readonly patch?: BuildScriptPatchInfo | undefined;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly tools: BuildScriptTools;
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
  readonly script: BuildScriptApplicationInfo;
  readonly testAbsolutePath: string;
}

export type BuildScript = (
  context: BuildScriptContext,
) =>
  | GeneratedScriptFile
  | GeneratedScriptFile[]
  | Promise<GeneratedScriptFile | GeneratedScriptFile[]>;

export type BuildScriptModule = {
  default?: BuildScript | undefined;
  generate?: BuildScript | undefined;
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

export type BuildScriptTest = (
  context: BuildScriptTestContext,
) => ScriptTestReport | Promise<ScriptTestReport>;

export type BuildScriptTestModule = {
  default?: BuildScriptTest | undefined;
};

export class ScriptToolError extends Error {
  readonly options: BuildScriptAssertionOptions;

  constructor(options: BuildScriptAssertionOptions) {
    super(options.reason);
    this.name = 'ScriptToolError';
    this.options = options;
  }
}
