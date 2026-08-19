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

  test('stops scheduling after a failure and drains work already in flight', async () => {
    const started: number[] = [];
    let active = 0;

    await expect(
      mapConcurrent([0, 1, 2, 3], 2, async (value) => {
        started.push(value);
        active += 1;
        try {
          if (value === 1) throw new Error('worker failed');
          await Bun.sleep(20);
          return value;
        } finally {
          active -= 1;
        }
      }),
    ).rejects.toThrow('worker failed');

    expect(started).toEqual([0, 1]);
    expect(active).toBe(0);
  });

  test('preserves a thrown undefined value instead of treating it as success', async () => {
    let rejected = false;
    try {
      await mapConcurrent([1], 1, async () => {
        throw undefined;
      });
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
  });
});
