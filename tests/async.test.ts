import { describe, expect, test } from 'bun:test';
import { mapConcurrent } from '../src/async.ts';

describe('bounded concurrency', () => {
  test('caps active work and preserves input order', async () => {
    let active = 0;
    let peakActive = 0;
    const results = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Bun.sleep(value);
      active -= 1;
      return value * 10;
    });

    expect(peakActive).toBe(2);
    expect(results).toEqual([40, 30, 20, 10]);
  });
});
