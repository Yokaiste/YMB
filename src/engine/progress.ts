import { abbreviateDisplayPath } from '../path-utils.ts';

interface ProgressEvent {
  message: string;
  detail?: string | undefined;
  current?: number | undefined;
  total?: number | undefined;
}

type ProgressReporter = (event: ProgressEvent) => void;

let activeProgressReporter: ProgressReporter | undefined;
let lastProgressMessage: string | undefined;
let lastProgressDetail: string | undefined;
let lastProgressCurrent: number | undefined;
let lastProgressTotal: number | undefined;
let lastReportedAt = 0;
const progressThrottleMs = 150;

let activeProjectRootReporter: ((buildRoot: string) => void) | undefined;
let activeRunVariantReporter: ((variant: 'warm' | 'cold') => void) | undefined;

export function setCommandProgressReporter(reporter: ProgressReporter | undefined): void {
  activeProgressReporter = reporter;
  lastProgressMessage = undefined;
  lastProgressDetail = undefined;
  lastProgressCurrent = undefined;
  lastProgressTotal = undefined;
  lastReportedAt = 0;
}

export function setCommandProjectRootReporter(
  reporter: ((buildRoot: string) => void) | undefined,
): void {
  activeProjectRootReporter = reporter;
}

export function setCommandRunVariantReporter(
  reporter: ((variant: 'warm' | 'cold') => void) | undefined,
): void {
  activeRunVariantReporter = reporter;
}

/**
 * Progress starts before anyone knows which project is being built, and the
 * recorded stage timings live with that project. This is how the engine tells
 * the display where they are, once it knows.
 */
export function reportProjectRoot(buildRoot: string): void {
  activeProjectRootReporter?.(buildRoot);
}

/** Warm and cold differ by an order of magnitude, so neither predicts from the other. */
export function reportRunVariant(variant: 'warm' | 'cold'): void {
  activeRunVariantReporter?.(variant);
}

export function reportProgress(
  message: string,
  detail?: string,
  counts?: { current?: number | undefined; total?: number | undefined },
): void {
  if (!activeProgressReporter) {
    return;
  }

  const now = performance.now();
  if (
    message === lastProgressMessage &&
    detail === lastProgressDetail &&
    counts?.current === lastProgressCurrent &&
    counts?.total === lastProgressTotal &&
    now - lastReportedAt < progressThrottleMs
  ) {
    return;
  }

  lastProgressMessage = message;
  lastProgressDetail = detail;
  lastProgressCurrent = counts?.current;
  lastProgressTotal = counts?.total;
  lastReportedAt = now;
  activeProgressReporter({
    message,
    detail,
    current: counts?.current,
    total: counts?.total,
  });
}

/**
 * The tracker owns the counter, so a call site only says which item it reached --
 * every such loop used to spell the opening, the per-item line, and the count itself.
 */
interface ProgressTracker {
  step(subject: string): void;
}

export function trackProgress(message: string, total: number): ProgressTracker {
  let current = 0;
  reportProgress(message, undefined, { current, total });
  return {
    step(subject: string): void {
      current += 1;
      reportProgress(message, abbreviateDisplayPath(subject), { current, total });
    },
  };
}
