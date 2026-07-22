export interface CooperativeYieldController {
  maybeYield(): Promise<void>;
}

export function createCooperativeYieldController(intervalMs = 16): CooperativeYieldController {
  let lastYieldAt = performance.now();

  return {
    async maybeYield() {
      const now = performance.now();
      if (now - lastYieldAt < intervalMs) {
        return;
      }

      lastYieldAt = now;
      // `setImmediate` yields to timers and terminal rendering without the
      // minimum-delay penalty that thousands of `setTimeout(0)` calls incur on
      // Windows during large NDF scans.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

/** Run independent async work with a fixed upper bound and stable result order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const entries = items.entries();
  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.max(1, Math.min(requestedConcurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (let next = entries.next(); !next.done; next = entries.next()) {
        const [index, item] = next.value;
        results[index] = await run(item, index);
      }
    }),
  );
  return results;
}
