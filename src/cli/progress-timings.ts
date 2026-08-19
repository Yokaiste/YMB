import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProgressCommandName } from './progress-types.ts';

/**
 * What one stage cost last time. Nothing in a build plan predicts duration --
 * scanning a project and building its output are one step each, and one is a
 * thousand times slower -- so YMB measures a run and estimates the next.
 */
export interface RecordedStage {
  message: string;
  durationMs: number;
  /** Items the stage counted, or 0 when it reports no counts. */
  items: number;
}

/**
 * The largest difference between two otherwise identical runs: a cold build can be
 * twenty times slower than the warm one after it, and nothing on the command line
 * reveals which is which.
 */
export type RunCacheVariant = 'warm' | 'cold';

const TIMINGS_FILE_NAME = 'progress-timings.json';
const TIMINGS_SCHEMA_VERSION = 2;
/** Commands times selections times cache states one project realistically repeats. */
const MAX_PROFILES = 32;
/** Half old, half new: one odd run moves the estimate without owning it. */
const BLEND_WEIGHT = 0.5;
/** Nothing is cached before the first run, so that is what an unknown run is. */
const DEFAULT_VARIANT: RunCacheVariant = 'cold';

/** `cleanup` removes the work root the timings file sits in. */
export function commandRecordsProgressTimings(commandName: ProgressCommandName): boolean {
  return commandName !== 'cleanup';
}

export interface ProgressTimingStore {
  /** The stages of the last comparable run, once the project root is known. */
  previousRun(): readonly RecordedStage[] | undefined;
  /** Timings sit beside the build directory, not in the cache every build prunes. */
  useProjectRoot(buildRoot: string): void;
  /** Recorded under the measured variant, so a cold build never lands in the warm profile. */
  useMeasuredVariant(variant: RunCacheVariant): void;
  save(stages: readonly RecordedStage[]): void;
}

interface TimingsFile {
  version: number;
  profiles: Record<string, RecordedStage[]>;
  /**
   * A run cannot know its own cache state until it is under way, so it starts from
   * what the one before it turned out to be and lets the estimator correct it.
   */
  lastVariants: Record<string, RunCacheVariant>;
}

/** Separates a different command, selection, or bypassed cache; measured state splits it again. */
export function createProgressTimingStore(profileKey: string): ProgressTimingStore {
  let buildRoot: string | undefined;
  let loaded: RecordedStage[] | undefined;
  let guessedVariant: RunCacheVariant = DEFAULT_VARIANT;
  let measuredVariant: RunCacheVariant | undefined;

  return {
    previousRun() {
      return loaded;
    },
    useProjectRoot(nextBuildRoot: string) {
      if (buildRoot !== undefined) {
        return;
      }
      buildRoot = nextBuildRoot;
      const file = readTimingsFile(nextBuildRoot);
      guessedVariant = file?.lastVariants[profileKey] ?? DEFAULT_VARIANT;
      loaded = file?.profiles[`${profileKey}|${guessedVariant}`];
    },
    useMeasuredVariant(variant: RunCacheVariant) {
      measuredVariant = variant;
    },
    save(stages: readonly RecordedStage[]) {
      if (buildRoot === undefined || stages.length === 0) {
        return;
      }
      const variant = measuredVariant ?? guessedVariant;
      const storageKey = `${profileKey}|${variant}`;
      const file = readTimingsFile(buildRoot) ?? {
        version: TIMINGS_SCHEMA_VERSION,
        profiles: {},
        lastVariants: {},
      };
      const previous = new Map(
        (file.profiles[storageKey] ?? []).map((stage) => [stage.message, stage] as const),
      );
      file.profiles[storageKey] = stages.map((stage) =>
        blendStage(previous.get(stage.message), stage),
      );
      file.lastVariants[profileKey] = variant;
      writeTimingsFile(buildRoot, dropOldestProfiles(file, storageKey));
    },
  };
}

function blendStage(previous: RecordedStage | undefined, current: RecordedStage): RecordedStage {
  if (!previous) {
    return current;
  }
  return {
    message: current.message,
    durationMs: Math.round(
      previous.durationMs * BLEND_WEIGHT + current.durationMs * (1 - BLEND_WEIGHT),
    ),
    items: Math.round(previous.items * BLEND_WEIGHT + current.items * (1 - BLEND_WEIGHT)),
  };
}

/** Newest profile last, so the oldest keys fall off the front first. */
function dropOldestProfiles(file: TimingsFile, keepKey: string): TimingsFile {
  const keys = Object.keys(file.profiles).filter((key) => key !== keepKey);
  const surviving = keys.slice(Math.max(0, keys.length - (MAX_PROFILES - 1)));
  const profiles: Record<string, RecordedStage[]> = {};
  for (const key of surviving) {
    const stages = file.profiles[key];
    if (stages) profiles[key] = stages;
  }
  const kept = file.profiles[keepKey];
  if (kept) profiles[keepKey] = kept;

  // A remembered variant only means anything while the profile it points at is
  // still here, so the two are trimmed together.
  const lastVariants: Record<string, RunCacheVariant> = {};
  for (const [key, variant] of Object.entries(file.lastVariants)) {
    if (profiles[`${key}|${variant}`]) lastVariants[key] = variant;
  }
  return { version: TIMINGS_SCHEMA_VERSION, profiles, lastVariants };
}

function readTimingsFile(buildRoot: string): TimingsFile | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(buildRoot, TIMINGS_FILE_NAME), 'utf8'),
    );
    return parseTimingsFile(parsed);
  } catch {
    // Timings are an estimate, never a result. An unreadable or stale file just
    // means this run measures itself instead of predicting.
    return undefined;
  }
}

function writeTimingsFile(buildRoot: string, file: TimingsFile): void {
  try {
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(
      path.join(buildRoot, TIMINGS_FILE_NAME),
      `${JSON.stringify(file, undefined, 2)}\n`,
    );
  } catch {
    // Never fail a build over a progress estimate.
  }
}

function parseTimingsFile(value: unknown): TimingsFile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<TimingsFile>;
  if (candidate.version !== TIMINGS_SCHEMA_VERSION) return undefined;
  if (!candidate.profiles || typeof candidate.profiles !== 'object') return undefined;

  const profiles: Record<string, RecordedStage[]> = {};
  for (const [key, stages] of Object.entries(candidate.profiles)) {
    const parsedStages = parseStages(stages);
    if (parsedStages) profiles[key] = parsedStages;
  }
  const lastVariants: Record<string, RunCacheVariant> = {};
  for (const [key, variant] of Object.entries(candidate.lastVariants ?? {})) {
    if (variant === 'warm' || variant === 'cold') lastVariants[key] = variant;
  }
  return { version: TIMINGS_SCHEMA_VERSION, profiles, lastVariants };
}

function parseStages(value: unknown): RecordedStage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const stages: RecordedStage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const stage = entry as Partial<RecordedStage>;
    if (
      typeof stage.message !== 'string' ||
      typeof stage.durationMs !== 'number' ||
      !Number.isFinite(stage.durationMs) ||
      stage.durationMs < 0 ||
      typeof stage.items !== 'number' ||
      !Number.isFinite(stage.items) ||
      stage.items < 0
    ) {
      return undefined;
    }
    stages.push({ message: stage.message, durationMs: stage.durationMs, items: stage.items });
  }
  return stages;
}
