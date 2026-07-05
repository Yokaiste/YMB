import type { WriteStream } from 'node:tty';
import { formatDurationMs } from '../engine/command-output.ts';
import { createEtaEstimator } from './progress-eta.ts';
import { createProgressSnapshot, getProgressModel } from './progress-model.ts';
import type {
  ProgressCommandName,
  ProgressDisplayEvent,
  ProgressSnapshot,
} from './progress-types.ts';

export function createProgressDisplay(commandName: ProgressCommandName) {
  if (!process.stderr.isTTY) {
    return undefined;
  }

  const progressModel = getProgressModel(commandName);
  const defaultEvent: ProgressDisplayEvent = {
    message: `Starting ${commandName}`,
    detail: undefined,
    current: undefined,
    total: undefined,
  };
  let frameIndex = 0;
  let latestEvent = defaultEvent;
  let highestOverallFraction = 0;
  const startedAt = performance.now();
  let lastRenderedAt = 0;
  let hasRenderedRows = false;
  const etaEstimator = createEtaEstimator();
  const stream = process.stderr as WriteStream;
  const renderIntervalMs = 90;
  const renderedRowCount = 3;
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
    const elapsedMs = performance.now() - startedAt;
    const snapshot = createProgressSnapshot(commandName, progressModel, latestEvent);
    highestOverallFraction = Math.max(highestOverallFraction, snapshot.overallFraction);
    const eta = etaEstimator.update(highestOverallFraction, elapsedMs, latestEvent);
    const rows = buildProgressRows({
      commandName,
      frameIndex,
      elapsedMs,
      eta,
      snapshot: {
        ...snapshot,
        overallFraction: highestOverallFraction,
      },
    });
    lastRenderedAt = performance.now();
    redrawRows(rows);
  };

  render();
  const timer = setInterval(() => {
    frameIndex += 1;
    render();
  }, renderIntervalMs);

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
      if (status === 'done') {
        stream.write(
          `[ok] ${commandName} | finished in ${formatDurationMs(performance.now() - startedAt)}\n`,
        );
        return;
      }
      if (status === 'failed') {
        stream.write(
          `[x] ${commandName}: failed after ${formatDurationMs(performance.now() - startedAt)}\n`,
        );
      }
    },
  };
}

function buildProgressRows(args: {
  commandName: ProgressCommandName;
  frameIndex: number;
  elapsedMs: number;
  eta?: string | undefined;
  snapshot: ProgressSnapshot;
}): string[] {
  const { commandName, frameIndex, elapsedMs, eta, snapshot } = args;
  const headerParts = [
    formatAnimatedYmbSignature(frameIndex),
    commandName.toUpperCase(),
    snapshot.groupLabel,
    formatOverallBar(snapshot.overallFraction),
    `${Math.round(snapshot.overallFraction * 100)}%`,
  ];
  headerParts.push(`ELAPSED ${formatDurationMs(elapsedMs)}`);
  if (eta) {
    headerParts.push(`ETA ${eta}`);
  }
  return [
    headerParts.join('  '),
    `NOW  ${snapshot.groupLabel} :: ${snapshot.nowLine}`,
    snapshot.nextLine,
  ];
}

function formatAnimatedYmbSignature(frameIndex: number): string {
  const shellFrames = [
    ['{ Y }', '< M >', '( B )'],
    ['( Y )', '{ M }', '< B >'],
    ['< Y >', '( M )', '{ B }'],
  ] as const;
  const connectorFrames = ['.:.', '-=-', '===', '-=-', '.=.'] as const;
  const activeCellFrames = ['[ Y ]', '[ M ]', '[ B ]'] as const;
  const focusIndex = frameIndex % activeCellFrames.length;
  const shellFrame =
    shellFrames[Math.floor(frameIndex / activeCellFrames.length) % shellFrames.length] ??
    shellFrames[0];
  const cells: string[] = [...shellFrame];
  cells[focusIndex] = activeCellFrames[focusIndex] ?? activeCellFrames[0];

  return [
    cells[0],
    connectorFrames[frameIndex % connectorFrames.length],
    cells[1],
    connectorFrames[(frameIndex + 2) % connectorFrames.length],
    cells[2],
  ].join('');
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

function formatProgressRow(stream: WriteStream, line: string): string {
  const columns = typeof stream.columns === 'number' ? stream.columns : undefined;
  if (!columns || columns <= 0 || line.length <= columns) {
    return line;
  }

  return columns <= 3 ? '.'.repeat(columns) : `${line.slice(0, columns - 3)}...`;
}
