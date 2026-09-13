import { describe, expect, test } from 'bun:test';
import { createProgressEstimator, formatEtaMs } from '../src/cli/progress-estimate.ts';
import type { ProgressTimingStore, RecordedStage } from '../src/cli/progress-timings.ts';
import type { ProgressDisplayEvent } from '../src/cli/progress-types.ts';

const RECORDED: RecordedStage[] = [
  { message: 'Scanning', durationMs: 200, items: 0 },
  { message: 'Building', durationMs: 8000, items: 10 },
  { message: 'Writing', durationMs: 800, items: 0 },
];

function createStore(previous?: RecordedStage[]): ProgressTimingStore & { saved: RecordedStage[] } {
  const store = {
    saved: [] as RecordedStage[],
    previousRun: () => previous,
    useProjectRoot: () => undefined,
    useMeasuredVariant: () => undefined,
    save(stages: readonly RecordedStage[]) {
      store.saved = [...stages];
    },
  };
  return store;
}

function stage(message: string, current?: number, total?: number): ProgressDisplayEvent {
  return { message, ...(current === undefined ? {} : { current, total }) };
}

describe('a run with nothing recorded', () => {
  test('reports no eta and leaves the bar on the plan shape', () => {
    const estimator = createProgressEstimator(createStore());

    expect(estimator.isCalibrated()).toBe(false);
    expect(estimator.update(stage('Scanning'), 0, 0.1)).toEqual({
      overallFraction: 0.1,
      etaMs: undefined,
    });
    expect(estimator.update(stage('Building', 5, 10), 9000, 0.5)).toEqual({
      overallFraction: 0.5,
      etaMs: undefined,
    });
  });

  test('measures its stages so the next run can predict', () => {
    const estimator = createProgressEstimator(createStore());

    estimator.update(stage('Scanning'), 0, 0.1);
    estimator.update(stage('Building', 0, 10), 200, 0.3);
    estimator.update(stage('Writing'), 8200, 0.9);

    expect(estimator.finish(9000)).toEqual([
      { message: 'Scanning', durationMs: 200, items: 0 },
      { message: 'Building', durationMs: 8000, items: 10 },
      { message: 'Writing', durationMs: 800, items: 0 },
    ]);
  });

  test('sums a stage that runs more than once', () => {
    const estimator = createProgressEstimator(createStore());

    estimator.update(stage('Building', 0, 4), 0, 0.1);
    estimator.update(stage('Writing'), 1000, 0.5);
    estimator.update(stage('Building', 0, 6), 1500, 0.7);

    expect(estimator.finish(2500)).toEqual([
      { message: 'Building', durationMs: 2000, items: 6 },
      { message: 'Writing', durationMs: 500, items: 0 },
    ]);
  });
});

describe('a run predicted from the last one', () => {
  test('spends the bar where the time goes, not where the steps are', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    expect(estimator.isCalibrated()).toBe(true);
    // Scanning is one of three steps but 2% of the time, so finishing it must
    // not claim a third of the run.
    estimator.update(stage('Scanning'), 0, 0.33);
    const afterScanning = estimator.update(stage('Building', 0, 10), 200, 0.4);
    expect(afterScanning.overallFraction).toBeCloseTo(200 / 9000, 5);
    expect(afterScanning.etaMs).toBeCloseTo(8800, 5);
  });

  test('is exact when the run matches the recording', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Scanning'), 0, 0.33);
    estimator.update(stage('Building', 0, 10), 200, 0.4);
    const halfway = estimator.update(stage('Building', 5, 10), 4200, 0.5);

    expect(halfway.overallFraction).toBeCloseTo(4200 / 9000, 5);
    expect(halfway.etaMs).toBeCloseTo(4800, 5);
  });

  test('a stage that outlives its recording keeps growing the estimate', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Scanning'), 0, 0.33);
    estimator.update(stage('Building', 0, 10), 200, 0.4);
    // 16.2s into a stage the recording put at 8s. There is nothing left to
    // measure it against, so the overrun stands in for itself - expect at least
    // as much again - and everything after it is expected to be as slow.
    const slow = estimator.update(stage('Building', 5, 10), 16_400, 0.5);

    // 8.2s over an 8s budget, plus the 0.8s stage that has not started.
    expect(slow.etaMs).toBeCloseTo(8200 + 800, 5);
  });

  test('does not read an uneven stage counter as this run being slower', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Scanning'), 0, 0.33);
    estimator.update(stage('Building', 0, 10), 200, 0.4);
    // The one item this stage has finished took most of its recorded budget.
    // Read per item that means 7 more of those - nearly a minute - but WARNO
    // work is wildly uneven, and the clock says the stage is nearly through its
    // recording. The estimate follows the clock and keeps counting down.
    const early = estimator.update(stage('Building', 1, 10), 6200, 0.4);
    const later = estimator.update(stage('Building', 1, 10), 7200, 0.4);

    expect(early.etaMs).toBeCloseTo(2000 + 800, 5);
    expect(later.etaMs).toBeLessThan(early.etaMs ?? 0);
  });

  test('scales a counted stage to the work actually in front of it', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Scanning'), 0, 0.33);
    // Half the targets of the recorded run, so half its expected duration.
    const started = estimator.update(stage('Building', 0, 5), 200, 0.4);

    expect(started.overallFraction).toBeCloseTo(200 / 5000, 5);
    expect(started.etaMs).toBeCloseTo(4800, 5);
  });

  test('moves an uncounted stage against the time it took before', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Scanning'), 0, 0.33);
    // Half of Scanning's recorded 200ms, with no counts to go by.
    const midScan = estimator.update(stage('Scanning'), 100, 0.33);

    expect(midScan.overallFraction).toBeCloseTo(100 / 9000, 5);
  });

  test('falls back to the plan shape when the recording holds no time', () => {
    const estimator = createProgressEstimator(
      createStore([{ message: 'Scanning', durationMs: 0, items: 0 }]),
    );

    expect(estimator.update(stage('Scanning'), 0, 0.25)).toEqual({
      overallFraction: 0.25,
      etaMs: undefined,
    });
  });

  test('does not read the first instant of a counted stage as a fast run', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    // A stage can report most of its items immediately. Judging the run's pace
    // from a few milliseconds against that would quarter the estimate.
    const opening = estimator.update(stage('Building', 9, 10), 3, 0.4);

    expect(opening.etaMs).toBeCloseTo(9000 - 7200, 5);
  });

  test('never claims to be finished before it is', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Scanning'), 0, 0.33);
    estimator.update(stage('Building', 10, 10), 8200, 0.9);
    const atEnd = estimator.update(stage('Writing'), 8200, 0.99);

    expect(atEnd.overallFraction).toBeLessThanOrEqual(0.99);
    expect(atEnd.etaMs).toBeGreaterThanOrEqual(0);
  });

  test('follows a run many times faster than the recording', () => {
    // The case a fixed correction floor could never express: the recording came
    // from filling an empty cache, and this run reads the answers back.
    const cold: RecordedStage[] = [
      { message: 'Scanning', durationMs: 400, items: 0 },
      { message: 'Building', durationMs: 60_000, items: 100 },
      { message: 'Writing', durationMs: 800, items: 0 },
    ];
    const estimator = createProgressEstimator(createStore(cold));

    estimator.update(stage('Scanning'), 0, 0.33);
    estimator.update(stage('Building', 0, 100), 50, 0.4);
    // 1.7s in, 80 of 100 targets done: this run is finishing in seconds, not the
    // minute the recording spent filling the cache it is now reading back.
    const warm = estimator.update(stage('Building', 80, 100), 1700, 0.5);

    expect(warm.etaMs).toBeLessThan(3000);
    expect(warm.overallFraction).toBeGreaterThan(0.4);
  });

  test('reads a stage that returns to being counted from where it left off', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    estimator.update(stage('Building', 0, 10), 0, 0.1);
    estimator.update(stage('Scanning'), 5000, 0.2);
    // Back in `Building` with 5s already spent on it, so 3s of its recorded 8s
    // are left - not the 8s a stage starting from nothing would have.
    const resumed = estimator.update(stage('Building', 5, 10), 5400, 0.5);

    expect(resumed.etaMs).toBeCloseTo(3000 + 800, 5);
  });

  test('an uncounted stage that outlives its recording still slows the estimate', () => {
    const estimator = createProgressEstimator(
      createStore([
        { message: 'Loading', durationMs: 4000, items: 0 },
        { message: 'Writing', durationMs: 1000, items: 0 },
      ]),
    );

    estimator.update(stage('Loading'), 0, 0.5);
    // Twice its recording with nothing to count. Expect the 4s it is already
    // over to happen again, on top of the stage that has not started.
    const overrun = estimator.update(stage('Loading'), 8000, 0.5);

    expect(overrun.etaMs).toBeCloseTo(4000 + 1000, 5);
  });

  test('holds steady when a command returns to a stage it already ran', () => {
    // `build` alternates script tests and script runs, once per script. Treating
    // "left this stage" as "finished with it" dropped the rest of the long one
    // out of the total and put it back a moment later, so the eta lurched by
    // tens of seconds every time the pair handed over.
    const estimator = createProgressEstimator(
      createStore([
        { message: 'Testing', durationMs: 600, items: 3 },
        { message: 'Generating', durationMs: 30_000, items: 3 },
        { message: 'Writing', durationMs: 1000, items: 0 },
      ]),
    );

    estimator.update(stage('Testing', 1, 3), 0, 0.1);
    estimator.update(stage('Generating', 1, 3), 200, 0.2);
    const inGenerating = estimator.update(stage('Generating', 1, 3), 10_000, 0.3);
    const backInTesting = estimator.update(stage('Testing', 2, 3), 10_200, 0.3);

    // Two of the three generators are still owed. Leaving the stage for a moment
    // must not take them out of the total.
    expect(backInTesting.etaMs).toBeGreaterThan(19_000);
    expect(Math.abs((backInTesting.etaMs ?? 0) - (inGenerating.etaMs ?? 0))).toBeLessThan(1000);
  });

  test('counts every stage still owed, not only the one running', () => {
    const estimator = createProgressEstimator(createStore(RECORDED));

    // The first frame of the run already answers for the whole command, not for
    // the step it happens to be starting.
    const opening = estimator.update(stage('Scanning'), 0, 0.1);

    expect(opening.etaMs).toBeCloseTo(200 + 8000 + 800, 5);
  });
});

describe('eta formatting', () => {
  test('reads as a duration a person can act on', () => {
    expect(formatEtaMs(0)).toBe('<1s');
    expect(formatEtaMs(999)).toBe('<1s');
    expect(formatEtaMs(1000)).toBe('1s');
    expect(formatEtaMs(4200)).toBe('5s');
    expect(formatEtaMs(9999)).toBe('10s');
    expect(formatEtaMs(45_510)).toBe('45.51s');
    expect(formatEtaMs(Number.POSITIVE_INFINITY)).toBe('<1s');
  });
});
