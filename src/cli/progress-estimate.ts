import { formatDurationMs } from '../report/text.ts';
import type { ProgressTimingStore, RecordedStage } from './progress-timings.ts';
import type { ProgressDisplayEvent } from './progress-types.ts';

/** Below this the measured/expected ratio is noise, so the run is assumed on pace. */
const RATE_EVIDENCE_FLOOR_MS = 400;
/** Rails, not policy: cold and warm differ by an order of magnitude and must be free to say so. */
const MIN_RATE = 0.01;
const MAX_RATE = 100;
/** Share of its budget a stage must have spent before its pace means anything. */
const MIN_SETTLED_SHARE = 0.05;

interface RunEstimate {
  /**
   * Weighted by measured stage durations once this command has run before, falling
   * back to the plan's shape on a first run.
   */
  overallFraction: number;
  /** Remaining milliseconds, or `undefined` while the run is only being measured. */
  etaMs: number | undefined;
}

interface ProgressEstimator {
  update(event: ProgressDisplayEvent, elapsedMs: number, structuralFraction: number): RunEstimate;
  /** Whether the estimate came from a previous run rather than this one. */
  isCalibrated(): boolean;
  /** Stage durations measured this run, for the store to keep. */
  finish(elapsedMs: number): RecordedStage[];
}

interface ObservedStage {
  durationMs: number;
  items: number;
}

export function createProgressEstimator(store: ProgressTimingStore): ProgressEstimator {
  /** Time already closed out per stage. The running stage is tracked separately. */
  const observed = new Map<string, ObservedStage>();
  /**
   * Finished with, not merely left: a command alternating between two stages leaves
   * each many times, and reading that as finished made the pace lurch.
   */
  const finished = new Set<string>();
  let currentMessage: string | undefined;
  let currentStartedAtMs = 0;
  let currentItems = 0;
  let currentIsFinished = true;

  const closeCurrentStage = (elapsedMs: number) => {
    if (currentMessage === undefined) {
      return;
    }
    const existing = observed.get(currentMessage);
    const durationMs = Math.max(0, elapsedMs - currentStartedAtMs);
    observed.set(currentMessage, {
      durationMs: (existing?.durationMs ?? 0) + durationMs,
      items: Math.max(existing?.items ?? 0, currentItems),
    });
    if (currentIsFinished) {
      finished.add(currentMessage);
    } else {
      finished.delete(currentMessage);
    }
  };

  /** Counts a stage reported, taking the running one's live total into account. */
  const resolveStageItems = (message: string): number => {
    const seen = observed.get(message)?.items ?? 0;
    return message === currentMessage ? Math.max(seen, currentItems) : seen;
  };

  /** Time this run has spent in a stage, including the segment running now. */
  const resolveStageSpentMs = (message: string, elapsedMs: number): number =>
    (observed.get(message)?.durationMs ?? 0) +
    (message === currentMessage ? Math.max(0, elapsedMs - currentStartedAtMs) : 0);

  return {
    isCalibrated() {
      return store.previousRun() !== undefined;
    },
    update(event, elapsedMs, structuralFraction) {
      if (event.message !== currentMessage) {
        closeCurrentStage(elapsedMs);
        currentMessage = event.message;
        currentStartedAtMs = elapsedMs;
        currentItems = 0;
      }
      if (event.total !== undefined && event.total > currentItems) {
        currentItems = event.total;
      }
      // A stage with nothing to count is finished the moment the run leaves it.
      // A counted one has only finished when its counter says so, which is what
      // keeps an alternating pair out of the pace evidence until it really ends.
      currentIsFinished = currentItems <= 0 || (event.current ?? 0) >= currentItems;

      const expected = store.previousRun();
      // A recording holding no time predicts nothing, so the bar keeps the plan's
      // shape and the run says nothing about an eta it cannot know.
      if (!expected || expected.reduce((total, stage) => total + stage.durationMs, 0) <= 0) {
        return { overallFraction: structuralFraction, etaMs: undefined };
      }

      const countedFraction = resolveStageFraction(event);
      // Every stage is measured the same way -- how much of its budget this run has spent
      // -- because sorting into done and still-to-come cannot survive a command that
      // returns to a stage it already visited.
      const budgets = expected.map((stage) => ({
        message: stage.message,
        budgetMs: scaleExpectedMs(stage, resolveStageItems(stage.message)),
        spentMs: resolveStageSpentMs(stage.message, elapsedMs),
      }));

      // Read only from finished stages. The one running now has its budget consumed by
      // the clock that would be measuring it, so it reports every run as exactly on pace.
      let settledActualMs = 0;
      let settledBudgetMs = 0;
      for (const stage of budgets) {
        if (stage.message === currentMessage || !finished.has(stage.message)) continue;
        // A stage left in a sliver of its budget was more likely passed through than
        // genuinely that fast -- YMB announces a phase before its first counted step.
        if (stage.spentMs < stage.budgetMs * MIN_SETTLED_SHARE) continue;
        settledActualMs += stage.spentMs;
        settledBudgetMs += stage.budgetMs;
      }
      const rate = resolveRate(settledActualMs, settledBudgetMs);

      // Item counts say what a stage works on, not what it spent, and WARNO work is
      // wildly uneven. The clock is the honest measure; the counter only shortens it.
      let remainingMs = 0;
      for (const stage of budgets) {
        const budgetMs = stage.budgetMs * rate;
        if (stage.message !== currentMessage) {
          remainingMs += Math.max(0, budgetMs - stage.spentMs);
          continue;
        }
        if (countedFraction >= 1) continue;
        remainingMs +=
          stage.spentMs > budgetMs
            ? // Past its budget there is nothing left to measure the stage
              // The overrun stands in for itself: expect at least as much again, so the eta stays
              // alive through a stall instead of resting on zero.
              stage.spentMs - budgetMs
            : Math.min(budgetMs - stage.spentMs, budgetMs * (1 - countedFraction));
      }
      const totalMs = elapsedMs + remainingMs;

      return {
        // Time already spent out of time this run will take. That keeps the bar
        // and the eta telling the same story instead of drifting apart.
        overallFraction: totalMs > 0 ? clamp(elapsedMs / totalMs, 0, 0.99) : structuralFraction,
        etaMs: remainingMs,
      };
    },
    finish(elapsedMs: number) {
      closeCurrentStage(elapsedMs);
      currentMessage = undefined;
      return [...observed.entries()].map(([message, stage]) => ({
        message,
        durationMs: Math.round(stage.durationMs),
        items: stage.items,
      }));
    },
  };
}

/** 32 targets last time and 30 this time is the same rate, not the same duration. */
function scaleExpectedMs(stage: RecordedStage, items: number): number {
  if (stage.items <= 0 || items <= 0) {
    return stage.durationMs;
  }
  return (stage.durationMs / stage.items) * items;
}

function resolveRate(actualMs: number, expectedMs: number): number {
  if (expectedMs < RATE_EVIDENCE_FLOOR_MS) {
    return 1;
  }
  return clamp(actualMs / expectedMs, MIN_RATE, MAX_RATE);
}

function resolveStageFraction(event: ProgressDisplayEvent): number {
  if (event.current === undefined || event.total === undefined || event.total <= 0) {
    return 0;
  }
  return clamp(event.current / event.total, 0, 1);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function formatEtaMs(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs < 1000) {
    return '<1s';
  }
  if (remainingMs < 10_000) {
    return `${Math.ceil(remainingMs / 1000)}s`;
  }
  return formatDurationMs(remainingMs);
}
