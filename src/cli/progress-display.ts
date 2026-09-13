import type { WriteStream } from 'node:tty';
import { formatDurationMs } from '../report/text.ts';
import { createProgressEstimator, formatEtaMs } from './progress-estimate.ts';
import { createProgressSnapshot, getProgressModel } from './progress-model.ts';
import type { ProgressTimingStore } from './progress-timings.ts';
import type {
  ProgressCommandName,
  ProgressDisplay,
  ProgressDisplayEvent,
  ProgressSnapshot,
} from './progress-types.ts';

/** A first run shows no estimate rather than a placeholder; this says the silence was temporary. */
const FIRST_RUN_NOTE = '  first run measured; the next one can show an eta\n';

interface ProgressState {
  elapsedMs: number;
  eta: string | undefined;
  snapshot: ProgressSnapshot;
}

/**
 * Ticks on every redraw so a long silent stage does not look like a hang. The bar
 * only moves on new counts. ASCII only: the launcher runs a legacy `cmd.exe` code page.
 */
const SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;

export function createProgressDisplay(
  commandName: ProgressCommandName,
  timingStore?: ProgressTimingStore,
): ProgressDisplay {
  const progressModel = getProgressModel(commandName);
  const defaultEvent: ProgressDisplayEvent = {
    message: `Starting ${commandName}`,
    detail: undefined,
    current: undefined,
    total: undefined,
  };
  let latestEvent = defaultEvent;
  let highestOverallFraction = 0;
  const startedAt = performance.now();
  const store = timingStore ?? createInertTimingStore();
  const estimator = createProgressEstimator(store);
  const stream = process.stderr as WriteStream;
  const trackProgressState = (event: ProgressDisplayEvent): ProgressState => {
    const elapsedMs = performance.now() - startedAt;
    const snapshot = createProgressSnapshot(commandName, progressModel, event);
    const estimate = estimator.update(event, elapsedMs, snapshot.overallFraction);
    // The bar never walks backwards, whichever fraction it came from.
    highestOverallFraction = Math.max(highestOverallFraction, estimate.overallFraction);
    return {
      elapsedMs,
      eta: estimate.etaMs === undefined ? undefined : formatEtaMs(estimate.etaMs),
      snapshot: { ...snapshot, overallFraction: highestOverallFraction },
    };
  };
  /**
   * Only a run that reached the end is kept: a failed one's stage durations describe a
   * shorter command. Reports whether to close with the first-run note, so a command
   * keeping no timings never promises an eta that cannot arrive.
   */
  const recordRun = (elapsedMs: number, status: 'done' | 'failed') => {
    const measured = estimator.finish(elapsedMs);
    const wasCalibrated = estimator.isCalibrated();
    if (status === 'done') {
      store.save(measured);
    }
    return status === 'done' && timingStore !== undefined && !wasCalibrated;
  };
  if (!supportsLiveProgressDisplay(stream)) {
    return createPlainProgressDisplay({
      commandName,
      stream,
      startedAt,
      trackProgressState,
      recordRun,
    });
  }

  let lastRenderedAt = 0;
  let hasRenderedRows = false;
  let frameIndex = 0;
  const renderIntervalMs = 90;
  const renderedRowCount = 4;
  const moveToFirstProgressRow = () => {
    if (renderedRowCount <= 1) {
      return;
    }

    stream.write(`\u001B[${renderedRowCount - 1}F`);
  };
  const clearVisibleRow = () => {
    if (typeof stream.clearLine === 'function' && typeof stream.cursorTo === 'function') {
      stream.clearLine(0);
      stream.cursorTo(0);
      return;
    }

    stream.write('\u001B[2K\r');
  };
  const redrawRows = (rows: string[]) => {
    if (hasRenderedRows) {
      moveToFirstProgressRow();
    }
    for (const [rowIndex, row] of rows.entries()) {
      clearVisibleRow();
      stream.write(formatProgressRow(stream, row));
      if (rowIndex < rows.length - 1) {
        stream.write('\n');
      }
    }
    hasRenderedRows = true;
  };
  const clearRenderedRows = () => {
    if (!hasRenderedRows) {
      return;
    }

    moveToFirstProgressRow();
    for (let rowIndex = 0; rowIndex < renderedRowCount; rowIndex += 1) {
      clearVisibleRow();
      if (rowIndex < renderedRowCount - 1) {
        stream.write('\n');
      }
    }
    moveToFirstProgressRow();
    clearVisibleRow();
  };
  const render = () => {
    const { elapsedMs, eta, snapshot } = trackProgressState(latestEvent);
    const rows = buildProgressRows({
      commandName,
      elapsedMs,
      eta,
      snapshot,
      spinner: SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0],
      columns: resolveRowWidth(stream),
    });
    frameIndex += 1;
    lastRenderedAt = performance.now();
    redrawRows(rows);
  };

  render();
  const timer = setInterval(render, renderIntervalMs);

  return {
    update(event: ProgressDisplayEvent) {
      const messageChanged = latestEvent.message !== event.message;
      latestEvent = event;
      if (messageChanged || performance.now() - lastRenderedAt >= renderIntervalMs) {
        render();
      }
    },
    stop(status: 'done' | 'failed') {
      clearInterval(timer);
      clearRenderedRows();
      const elapsedMs = performance.now() - startedAt;
      writeProgressClosing(stream, status, elapsedMs, recordRun);
    },
  };
}

/** Used when no project is in play, such as the display tests. */
function createInertTimingStore(): ProgressTimingStore {
  return {
    previousRun: () => undefined,
    useProjectRoot: () => undefined,
    useMeasuredVariant: () => undefined,
    save: () => undefined,
  };
}

interface PlainPhase {
  id: string;
  label: string;
  index: number;
  count: number;
  startedAtMs: number;
  lastNoticeAtMs: number;
  work: Map<string, number>;
}

const PLAIN_HEARTBEAT_MS = 15_000;

/**
 * The plain display writes each phase as it ends, so this column cannot be measured
 * from the finished set. Both widths are named here rather than in the template.
 */
const PLAIN_PHASE_LABEL_WIDTH = 20;
const PLAIN_PHASE_DURATION_WIDTH = 7;

/** One line per finished phase, so hundreds of near-identical frames do not scroll past. */
function createPlainProgressDisplay(args: {
  commandName: ProgressCommandName;
  stream: WriteStream;
  startedAt: number;
  trackProgressState: (event: ProgressDisplayEvent) => ProgressState;
  /** Records the finished run and reports whether to close with the first-run note. */
  recordRun: (elapsedMs: number, status: 'done' | 'failed') => boolean;
}): ProgressDisplay {
  const { commandName, stream, startedAt, trackProgressState, recordRun } = args;
  let phase: PlainPhase | undefined;
  stream.write(`YMB ${commandName}\n`);

  const closePhase = (endedAtMs: number) => {
    if (!phase) {
      return;
    }
    const work = [...phase.work.entries()]
      .filter(([, total]) => total > 0)
      // Stage messages are already plural, so a single item needs trimming back.
      .map(([label, total]) => `${total} ${total === 1 ? label.replace(/s$/, '') : label}`)
      .join(', ');
    const position = `[${phase.index + 1}/${phase.count}]`;
    const duration = formatDurationMs(endedAtMs - phase.startedAtMs).padStart(
      PLAIN_PHASE_DURATION_WIDTH,
    );
    stream.write(
      formatProgressRow(
        stream,
        `  ${position} ${phase.label.padEnd(PLAIN_PHASE_LABEL_WIDTH)}${duration}${work ? `   ${work}` : ''}`,
      ),
    );
    stream.write('\n');
    phase = undefined;
  };

  return {
    update(event: ProgressDisplayEvent) {
      const { elapsedMs, eta, snapshot } = trackProgressState(event);
      if (phase && phase.id !== snapshot.groupId) {
        closePhase(elapsedMs);
      }
      phase ??= {
        id: snapshot.groupId,
        label: snapshot.groupLabel,
        index: snapshot.groupIndex,
        count: snapshot.groupCount,
        startedAtMs: elapsedMs,
        lastNoticeAtMs: elapsedMs,
        work: new Map(),
      };

      // Remember the largest run of each counted stage so the closing line can
      // say how much work the phase actually covered.
      if (event.total !== undefined && event.total > 0) {
        const label = describeWorkUnit(event.message);
        phase.work.set(label, Math.max(phase.work.get(label) ?? 0, event.total));
      }

      // A long silent phase looks like a hang, so break the silence on a timer.
      // Without a redrawn frame this line is the only place a reader without a
      // cursor-controlled terminal learns how far along the run is.
      if (elapsedMs - phase.lastNoticeAtMs >= PLAIN_HEARTBEAT_MS) {
        phase.lastNoticeAtMs = elapsedMs;
        stream.write(
          `        still working on ${phase.label.toLowerCase()}...` +
            ` ${formatDurationMs(elapsedMs)} elapsed${eta ? `, eta ${eta}` : ''}\n`,
        );
      }
    },
    stop(status: 'done' | 'failed') {
      const elapsedMs = performance.now() - startedAt;
      closePhase(elapsedMs);
      writeProgressClosing(stream, status, elapsedMs, recordRun);
    },
  };
}

function writeProgressClosing(
  stream: WriteStream,
  status: 'done' | 'failed',
  elapsedMs: number,
  recordRun: (elapsedMs: number, status: 'done' | 'failed') => boolean,
): void {
  const showFirstRunNote = recordRun(elapsedMs, status);
  stream.write(formatClosingLine(status, elapsedMs));
  if (showFirstRunNote) {
    stream.write(FIRST_RUN_NOTE);
  }
}

/** The following error block owns the `[x]`; repeating it printed two at two indents. */
function formatClosingLine(status: 'done' | 'failed', elapsedMs: number): string {
  return status === 'done'
    ? `  done in ${formatDurationMs(elapsedMs)}\n`
    : `  stopped after ${formatDurationMs(elapsedMs)}\n`;
}

/** Turn a stage message into the noun it counts, for the phase summary. */
function describeWorkUnit(message: string): string {
  const cleaned = message
    .replace(
      /^(Validating|Materializing|Writing|Preparing|Running|Syncing|Recovering|Removing)\s+/i,
      '',
    )
    .replace(/^YMB\s+/i, '')
    .trim();
  return cleaned.length > 0 ? cleaned.toLowerCase() : message.toLowerCase();
}

function buildProgressRows(args: {
  commandName: ProgressCommandName;
  elapsedMs: number;
  eta?: string | undefined;
  snapshot: ProgressSnapshot;
  spinner: string;
  columns?: number | undefined;
}): string[] {
  const { commandName, elapsedMs, eta, snapshot, spinner, columns } = args;
  const headerParts = [
    `YMB ${commandName}`,
    formatOverallBar(snapshot.overallFraction, resolveBarWidth(columns)),
    `${Math.round(snapshot.overallFraction * 100)}%`.padStart(4),
    formatDurationMs(elapsedMs),
  ];
  if (eta) {
    headerParts.push(`eta ${eta}`);
  }
  return [
    headerParts.join('  '),
    `  step ${snapshot.groupIndex + 1}/${snapshot.groupCount}  ${snapshot.groupLabel}`,
    `  ${spinner}  ${snapshot.nowLine}`,
    `     ${snapshot.nextLine}`,
  ];
}

function supportsLiveProgressDisplay(stream: WriteStream): boolean {
  return (
    stream.isTTY === true &&
    process.env.TERM !== 'dumb' &&
    typeof stream.clearLine === 'function' &&
    typeof stream.cursorTo === 'function'
  );
}

/** A narrow terminal shrinks the bar rather than pushing the elapsed time off the edge. */
function resolveBarWidth(columns: number | undefined): number {
  if (columns === undefined) {
    return 18;
  }

  return Math.max(6, Math.min(18, columns - 34));
}

function formatOverallBar(overallFraction: number, width = 18): string {
  const clampedFraction = Math.max(0, Math.min(1, overallFraction));
  const scaled = clampedFraction * width;
  const completed = Math.floor(scaled);
  const hasHead = clampedFraction < 1;
  const head = hasHead ? '>' : '=';
  const left = `${'='.repeat(Math.max(0, completed - (hasHead ? 0 : 1)))}${head}`.slice(0, width);
  return `[${left}${'.'.repeat(Math.max(0, width - left.length))}]`;
}

/**
 * One column short of the width: a row that fills the terminal exactly wraps, and
 * the redraw counts rows to find the top of the frame.
 */
function resolveRowWidth(stream: WriteStream): number | undefined {
  const columns = typeof stream.columns === 'number' ? stream.columns : undefined;
  if (!columns || columns <= 0) {
    return undefined;
  }

  return Math.max(1, columns - 1);
}

function formatProgressRow(stream: WriteStream, line: string): string {
  const width = resolveRowWidth(stream);
  if (width === undefined || line.length <= width) {
    return line;
  }

  return truncateProgressRow(line, width);
}

/** Rows end in the file being worked on, so drop from the middle and keep both ends. */
function truncateProgressRow(line: string, width: number): string {
  if (width <= 3) {
    return '.'.repeat(width);
  }

  const tailWidth = Math.floor((width - 3) / 2);
  const headWidth = width - 3 - tailWidth;
  return `${line.slice(0, headWidth)}...${line.slice(line.length - tailWidth)}`;
}
