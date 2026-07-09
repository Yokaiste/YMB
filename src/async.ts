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
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}
