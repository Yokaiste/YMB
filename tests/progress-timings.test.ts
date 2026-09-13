import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  commandRecordsProgressTimings,
  createProgressTimingStore,
  type ProgressTimingStore,
  type RecordedStage,
  type RunCacheVariant,
} from '../src/cli/progress-timings.ts';
import { pruneCacheDirectory } from '../src/engine/cache-store.ts';
import { runBuild, setCommandRunVariantReporter } from '../src/engine/commands.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
} from './helpers/abstract-builder.ts';

const TIMINGS_FILE = 'progress-timings.json';
const tempRoots: string[] = [];

afterEach(async () => {
  setCommandRunVariantReporter(undefined);
  await cleanupTempRoots(tempRoots);
});

async function createBuildRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ymb-progress-timings-'));
}

function stages(durationMs: number, items = 0): RecordedStage[] {
  return [{ message: 'Building output', durationMs, items }];
}

/** One complete run: open the store, read what it predicts, record what it measured. */
function runOnce(
  buildRoot: string,
  profileKey: string,
  measured?: RunCacheVariant,
): { store: ProgressTimingStore; predicted: readonly RecordedStage[] | undefined } {
  const store = createProgressTimingStore(profileKey);
  store.useProjectRoot(buildRoot);
  const predicted = store.previousRun();
  if (measured) {
    store.useMeasuredVariant(measured);
  }
  return { store, predicted };
}

describe('recorded progress timings', () => {
  test('a run predicts the next one with the same profile', async () => {
    const buildRoot = await createBuildRoot();
    try {
      const first = runOnce(buildRoot, 'build|prod|sample||cache', 'cold');
      expect(first.predicted).toBeUndefined();
      first.store.save(stages(4000, 8));

      const second = runOnce(buildRoot, 'build|prod|sample||cache', 'cold');
      expect(second.predicted).toEqual([
        { message: 'Building output', durationMs: 4000, items: 8 },
      ]);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('a different profile keeps its own timings', async () => {
    const buildRoot = await createBuildRoot();
    try {
      const cached = runOnce(buildRoot, 'build|prod|sample||cache', 'warm');
      cached.store.save(stages(4000, 8));

      // The same command with the cache bypassed is a different amount of work.
      const uncached = runOnce(buildRoot, 'build|prod|sample||nocache', 'cold');
      expect(uncached.predicted).toBeUndefined();
      uncached.store.save(stages(30_000, 8));

      const cachedAgain = runOnce(buildRoot, 'build|prod|sample||cache');
      expect(cachedAgain.predicted?.[0]?.durationMs).toBe(4000);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('the run that fills the cache never becomes the estimate for the one that reads it back', async () => {
    const buildRoot = await createBuildRoot();
    try {
      // This is the whole reason the measured cache state is part of the profile:
      // a cold build can be twenty times slower than the warm one right after it,
      // and blending the two predicts neither.
      const cold = runOnce(buildRoot, 'build|prod|sample||cache', 'cold');
      cold.store.save(stages(60_000, 8));

      const firstWarm = runOnce(buildRoot, 'build|prod|sample||cache', 'warm');
      firstWarm.store.save(stages(3000, 8));

      const secondWarm = runOnce(buildRoot, 'build|prod|sample||cache', 'warm');
      expect(secondWarm.predicted?.[0]?.durationMs).toBe(3000);
      secondWarm.store.save(stages(3000, 8));

      // A rebuild that cannot reuse anything - an upgraded builder, a rewritten
      // mod - lands back on the cold profile and leaves the warm one untouched.
      const coldAgain = runOnce(buildRoot, 'build|prod|sample||cache', 'cold');
      coldAgain.store.save(stages(60_000, 8));

      const warmAfterCold = runOnce(buildRoot, 'build|prod|sample||cache', 'warm');
      warmAfterCold.store.save(stages(3000, 8));
      const finalWarm = runOnce(buildRoot, 'build|prod|sample||cache', 'warm');

      expect(finalWarm.predicted?.[0]?.durationMs).toBe(3000);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('the next run starts from what the last one turned out to be', async () => {
    const buildRoot = await createBuildRoot();
    try {
      const cold = runOnce(buildRoot, 'build', 'cold');
      cold.store.save(stages(60_000, 8));
      const warm = runOnce(buildRoot, 'build', 'warm');
      // A run cannot know its own cache state before it starts, so it opens with
      // what the last one turned out to be - wrong exactly once per change, and
      // corrected by the estimator while the run is still going.
      expect(warm.predicted?.[0]?.durationMs).toBe(60_000);
      warm.store.save(stages(3000, 8));

      // ...and now the guess follows what was actually measured.
      expect(runOnce(buildRoot, 'build').predicted?.[0]?.durationMs).toBe(3000);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('a run that never measured its cache state is recorded under the guess', async () => {
    const buildRoot = await createBuildRoot();
    try {
      // `list`, `explain`, and `doctor` never materialize anything, so they have
      // no cache state to report and must still accumulate timings.
      runOnce(buildRoot, 'list').store.save(stages(300));
      runOnce(buildRoot, 'list').store.save(stages(500));

      expect(runOnce(buildRoot, 'list').predicted?.[0]?.durationMs).toBe(400);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('an odd run moves the estimate without owning it', async () => {
    const buildRoot = await createBuildRoot();
    try {
      runOnce(buildRoot, 'build', 'warm').store.save(stages(4000, 8));
      runOnce(buildRoot, 'build', 'warm').store.save(stages(8000, 8));

      expect(runOnce(buildRoot, 'build', 'warm').predicted?.[0]?.durationMs).toBe(6000);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('a stage the previous run never had is taken as measured', async () => {
    const buildRoot = await createBuildRoot();
    try {
      runOnce(buildRoot, 'build', 'cold').store.save(stages(4000, 8));
      runOnce(buildRoot, 'build', 'cold').store.save([
        { message: 'Building output', durationMs: 4000, items: 8 },
        { message: 'Writing preview', durationMs: 900, items: 9 },
      ]);

      expect(runOnce(buildRoot, 'build', 'cold').predicted).toEqual([
        { message: 'Building output', durationMs: 4000, items: 8 },
        { message: 'Writing preview', durationMs: 900, items: 9 },
      ]);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('records nothing until the project is known, and nothing for an empty run', async () => {
    const buildRoot = await createBuildRoot();
    try {
      const rootless = createProgressTimingStore('build');
      rootless.save(stages(4000, 8));
      expect(
        await readFile(path.join(buildRoot, TIMINGS_FILE)).catch(() => undefined),
      ).toBeUndefined();

      runOnce(buildRoot, 'build', 'cold').store.save([]);
      expect(
        await readFile(path.join(buildRoot, TIMINGS_FILE)).catch(() => undefined),
      ).toBeUndefined();
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['not JSON at all', '{ torn'],
    ['a schema from another version', JSON.stringify({ version: 99, profiles: { build: [] } })],
    [
      'a stage with no duration',
      JSON.stringify({ version: 2, profiles: { 'build|cold': [{ message: 'x' }] } }),
    ],
    [
      'a negative duration',
      JSON.stringify({
        version: 2,
        profiles: { 'build|cold': [{ message: 'x', durationMs: -1, items: 0 }] },
      }),
    ],
  ])('measures itself again rather than trusting %s', async (_description, content) => {
    const buildRoot = await createBuildRoot();
    try {
      await writeFile(path.join(buildRoot, TIMINGS_FILE), content);

      const run = runOnce(buildRoot, 'build', 'cold');
      expect(run.predicted).toBeUndefined();

      // A broken file must not stop the next run from recording over it.
      run.store.save(stages(4000, 8));
      expect(runOnce(buildRoot, 'build', 'cold').predicted?.[0]?.durationMs).toBe(4000);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('survives the cache prune that every build runs', async () => {
    const buildRoot = await createBuildRoot();
    try {
      // The timings are not a cache envelope, so keeping them under the build
      // cache would have every build delete them and no run would ever predict.
      runOnce(buildRoot, 'build', 'warm').store.save(stages(4000, 8));
      await mkdir(path.join(buildRoot, 'cache'), { recursive: true });
      await writeFile(path.join(buildRoot, 'cache', 'stale.ndf'), 'not an envelope');

      const removed = await pruneCacheDirectory(path.join(buildRoot, 'cache'));

      expect(removed).toBe(1);
      expect(runOnce(buildRoot, 'build').predicted?.[0]?.durationMs).toBe(4000);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });

  test('the engine reports the cache state it actually measured', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    const reported: RunCacheVariant[] = [];
    setCommandRunVariantReporter((variant) => {
      reported.push(variant);
    });

    // Nothing is cached the first time, so every target is computed...
    await runBuild(builderPath, createSelection());
    // ...and read straight back the second time.
    await runBuild(builderPath, createSelection());
    // A bypassed cache reuses nothing, whatever is sitting on disk.
    await runBuild(builderPath, createSelection({ useCache: false }));

    expect(reported).toEqual(['cold', 'warm', 'cold']);
  });

  test('every command records itself except the one that deletes the recording', () => {
    for (const commandName of [
      'validate',
      'build',
      'sync',
      'recover',
      'doctor',
      'list',
      'explain',
      'find',
    ] as const) {
      expect(commandRecordsProgressTimings(commandName)).toBe(true);
    }

    expect(commandRecordsProgressTimings('cleanup')).toBe(false);
  });

  test('keeps the profile budget bounded as selections accumulate', async () => {
    const buildRoot = await createBuildRoot();
    try {
      for (let index = 0; index < 50; index += 1) {
        runOnce(buildRoot, `build|prod|mod-${index}||cache`, 'warm').store.save(
          stages(1000 + index, 1),
        );
      }

      const file = JSON.parse(await readFile(path.join(buildRoot, TIMINGS_FILE), 'utf8')) as {
        profiles: Record<string, unknown>;
        lastVariants: Record<string, unknown>;
      };

      expect(Object.keys(file.profiles).length).toBeLessThanOrEqual(32);
      // The most recent selection always survives the trim.
      expect(Object.keys(file.profiles)).toContain('build|prod|mod-49||cache|warm');
      // A remembered variant pointing at a trimmed profile is dead weight.
      expect(Object.keys(file.lastVariants).length).toBeLessThanOrEqual(
        Object.keys(file.profiles).length,
      );
      expect(
        Object.entries(file.lastVariants).every(
          ([key, variant]) => file.profiles[`${key}|${String(variant)}`] !== undefined,
        ),
      ).toBe(true);
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });
});
