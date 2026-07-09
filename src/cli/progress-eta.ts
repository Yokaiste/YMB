import { formatDurationMs } from '../engine/command-output.ts';
import type { ProgressDisplayEvent, ProgressEtaPhaseState } from './progress-types.ts';

export function createEtaEstimator(): {
  update(
    overallFraction: number,
    elapsedMs: number,
    event: ProgressDisplayEvent,
  ): string | undefined;
} {
  let smoothedTotalDurationMs: number | undefined;
  let lastMeasuredFraction = 0;
  let trackedPhase: ProgressEtaPhaseState | undefined;

  return {
    update(overallFraction: number, elapsedMs: number, event: ProgressDisplayEvent) {
      updateTrackedPhase(event, elapsedMs);

      if (overallFraction > 0 && elapsedMs >= 500) {
        const instantaneousTotalDurationMs = elapsedMs / overallFraction;
        if (Number.isFinite(instantaneousTotalDurationMs) && overallFraction >= 0.02) {
          if (smoothedTotalDurationMs === undefined) {
            smoothedTotalDurationMs = instantaneousTotalDurationMs;
            lastMeasuredFraction = overallFraction;
          } else if (overallFraction > lastMeasuredFraction) {
            const smoothingFactor = overallFraction < 0.12 ? 0.35 : 0.18;
            smoothedTotalDurationMs =
              smoothedTotalDurationMs * (1 - smoothingFactor) +
              instantaneousTotalDurationMs * smoothingFactor;
            lastMeasuredFraction = overallFraction;
          }
        }
      }

      const phaseEta = estimateTrackedPhaseEta(event, elapsedMs);
      if (phaseEta) {
        return phaseEta;
      }

      if (smoothedTotalDurationMs === undefined || overallFraction >= 0.995) {
        return undefined;
      }

      const remainingMs = Math.max(0, smoothedTotalDurationMs - elapsedMs);
      return formatEtaDuration(remainingMs);
    },
  };

  function updateTrackedPhase(event: ProgressDisplayEvent, elapsedMs: number): void {
    if (
      !isPhaseEtaCandidate(event.message) ||
      event.current === undefined ||
      event.total === undefined
    ) {
      trackedPhase = undefined;
      return;
    }

    if (
      !trackedPhase ||
      event.message !== trackedPhase.message ||
      event.total !== trackedPhase.total
    ) {
      trackedPhase = {
        message: event.message,
        total: event.total,
        current: event.current,
        itemStartedAt: elapsedMs,
      };
      return;
    }

    if (event.current > trackedPhase.current) {
      const completedItemCount = event.current - trackedPhase.current;
      const completedItemDurationMs = Math.max(1, elapsedMs - trackedPhase.itemStartedAt);
      const averageForCompletedItems = completedItemDurationMs / completedItemCount;
      trackedPhase.averageItemDurationMs =
        trackedPhase.averageItemDurationMs === undefined
          ? averageForCompletedItems
          : trackedPhase.averageItemDurationMs * 0.65 + averageForCompletedItems * 0.35;
      trackedPhase.current = event.current;
      trackedPhase.itemStartedAt = elapsedMs;
      return;
    }

    trackedPhase.current = event.current;
  }

  function estimateTrackedPhaseEta(
    event: ProgressDisplayEvent,
    elapsedMs: number,
  ): string | undefined {
    if (
      !trackedPhase ||
      event.message !== trackedPhase.message ||
      event.current === undefined ||
      event.total === undefined ||
      event.total !== trackedPhase.total
    ) {
      return undefined;
    }

    const currentItemElapsedMs = Math.max(0, elapsedMs - trackedPhase.itemStartedAt);
    if (trackedPhase.averageItemDurationMs === undefined) {
      if (currentItemElapsedMs < 1200 || event.total <= 1) {
        return undefined;
      }

      const bootstrapAverageItemDurationMs = currentItemElapsedMs * 1.35;
      const effectiveCompletedItems = Math.min(
        event.total - 0.1,
        Math.max(0, event.current - 1 + 0.35),
      );
      const remainingItems = Math.max(0, event.total - effectiveCompletedItems);
      return formatEtaDuration(remainingItems * bootstrapAverageItemDurationMs);
    }

    const currentItemFraction = Math.min(
      0.95,
      currentItemElapsedMs / Math.max(1, trackedPhase.averageItemDurationMs),
    );
    const effectiveCompletedItems = Math.min(
      event.total - 0.05,
      Math.max(0, event.current - 1 + currentItemFraction),
    );
    const remainingItems = Math.max(0, event.total - effectiveCompletedItems);
    const remainingMs = remainingItems * trackedPhase.averageItemDurationMs;
    return formatEtaDuration(remainingMs);
  }
}

function formatEtaDuration(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }
  if (durationMs < 1000) {
    return '<1s';
  }
  if (durationMs < 10_000) {
    return `${Math.ceil(durationMs / 1000)}s`;
  }
  return formatDurationMs(durationMs);
}

function isPhaseEtaCandidate(message: string): boolean {
  return (
    message === 'Running generation script tests' ||
    message === 'Running generation scripts' ||
    message === 'Materializing patch outputs' ||
    message === 'Materializing replace outputs' ||
    message === 'Writing preview output files' ||
    message === 'Preparing preview output files' ||
    message === 'Syncing live files' ||
    message === 'Recovering tracked files' ||
    message === 'Removing YMB temp artifacts'
  );
}
