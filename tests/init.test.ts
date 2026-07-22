import { describe, expect, test } from 'bun:test';
import { deriveInitId } from '../src/init.ts';

describe('init helpers', () => {
  test('returns undefined when neither a name nor an explicit id is available', () => {
    expect(deriveInitId(undefined, undefined)).toBeUndefined();
    expect(deriveInitId('', '')).toBeUndefined();
  });

  test('derives a stable id from the display name when no explicit id is provided', () => {
    expect(deriveInitId('My First Pack', undefined)).toBe('my_first_pack');
    expect(deriveInitId('  My First Pack  ', '   ')).toBe('my_first_pack');
  });

  test('prefers an explicit id over the derived slug', () => {
    expect(deriveInitId('My First Pack', 'custom.pack')).toBe('custom.pack');
  });
});
