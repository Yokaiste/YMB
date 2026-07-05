export interface ProgressEvent {
  message: string;
  detail?: string | undefined;
  current?: number | undefined;
  total?: number | undefined;
}

type ProgressReporter = (event: ProgressEvent) => void;

let activeProgressReporter: ProgressReporter | undefined;
let lastProgressMessage: string | undefined;
let lastProgressDetail: string | undefined;
let lastReportedAt = 0;
const progressThrottleMs = 150;

export function setCommandProgressReporter(reporter: ProgressReporter | undefined): void {
  activeProgressReporter = reporter;
  lastProgressMessage = undefined;
  lastProgressDetail = undefined;
  lastReportedAt = 0;
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
    now - lastReportedAt < progressThrottleMs
  ) {
    return;
  }

  lastProgressMessage = message;
  lastProgressDetail = detail;
  lastReportedAt = now;
  activeProgressReporter({
    message,
    detail,
    current: counts?.current,
    total: counts?.total,
  });
}

export function abbreviateProgressPath(pathLike: string, maxSegments = 3): string {
  const normalizedPath = pathLike.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= maxSegments) {
    return normalizedPath;
  }

  return `.../${segments.slice(-maxSegments).join('/')}`;
}
