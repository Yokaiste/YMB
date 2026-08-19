import { describe, expect, test } from 'bun:test';
import { classifyTrackedTarget } from '../src/engine/recovery.ts';
import type { SyncManifestEntry } from '../src/types.ts';

const SYNCED_HASH = 'a'.repeat(64);
const ORIGINAL_HASH = 'b'.repeat(64);
const FOREIGN_HASH = 'c'.repeat(64);

function presentEntry(overrides: Partial<SyncManifestEntry> = {}): SyncManifestEntry {
  return {
    targetRelativePath: 'GameData/Generated/Gameplay/Units.ndf',
    backupFileName: `${ORIGINAL_HASH}.ndf`,
    originalExists: true,
    expectedState: 'present',
    originalContentHash: ORIGINAL_HASH,
    syncedContentHash: SYNCED_HASH,
    contributors: [{ modId: 'sample_pack', modName: 'Sample Pack' }],
    ...overrides,
  };
}

function absentEntry(overrides: Partial<SyncManifestEntry> = {}): SyncManifestEntry {
  return {
    targetRelativePath: 'GameData/remove.txt',
    backupFileName: `${ORIGINAL_HASH}.bin`,
    originalExists: true,
    expectedState: 'absent',
    originalContentHash: ORIGINAL_HASH,
    contributors: [{ modId: 'sample_pack', modName: 'Sample Pack' }],
    ...overrides,
  };
}

describe('tracked target classification', () => {
  test('a file still holding what YMB wrote is synced', () => {
    expect(classifyTrackedTarget(presentEntry(), true, SYNCED_HASH)).toBe('synced');
  });

  test('a file back at its untouched game bytes is original, not a problem', () => {
    expect(classifyTrackedTarget(presentEntry(), true, ORIGINAL_HASH)).toBe('original');
  });

  test('a file holding anything else is changed', () => {
    expect(classifyTrackedTarget(presentEntry(), true, FOREIGN_HASH)).toBe('changed');
  });

  test('a tracked file that went missing is changed when it existed before YMB', () => {
    expect(classifyTrackedTarget(presentEntry(), false, undefined)).toBe('changed');
  });

  test('a file YMB created and something deleted is back to the pre-YMB state', () => {
    expect(classifyTrackedTarget(presentEntry({ originalExists: false }), false, undefined)).toBe(
      'original',
    );
  });

  test('a target YMB deleted stays synced while it is absent', () => {
    expect(classifyTrackedTarget(absentEntry(), false, undefined)).toBe('synced');
  });

  test('a deleted target recreated with its original bytes is original', () => {
    expect(classifyTrackedTarget(absentEntry(), true, ORIGINAL_HASH)).toBe('original');
  });

  test('a deleted target recreated with other content is changed', () => {
    expect(classifyTrackedTarget(absentEntry(), true, FOREIGN_HASH)).toBe('changed');
  });

  test('an untracked target has nothing to compare and never blocks a run', () => {
    expect(classifyTrackedTarget(undefined, true, FOREIGN_HASH)).toBe('synced');
    expect(
      classifyTrackedTarget(presentEntry({ syncedContentHash: undefined }), true, FOREIGN_HASH),
    ).toBe('synced');
  });
});
