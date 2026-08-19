import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  assertGameRelativePath,
  assertOwnedRelativePath,
  resolveModTargetPath,
  resolveOwnedFilePath,
  toPathKey,
} from '../src/path-utils.ts';

const OWNER_ROOT = path.join('C:', 'fixture', 'YMB', 'mods', 'sample-pack', 'config');
const MOD_ROOT = path.join('C:', 'fixture', 'WARNO', 'Mods', 'MyMod');

// These guards decide where YMB is allowed to write inside a live game install.
// Every rejected shape below is a way of escaping that boundary.
const ESCAPING_PATHS = [
  ['parent traversal only', '..'],
  ['leading traversal', '../outside.ndf'],
  ['leading traversal with backslashes', '..\\outside.ndf'],
  ['embedded traversal', 'GameData/../../outside.ndf'],
  ['traversal that lands above the root', 'a/../../b.ndf'],
  ['posix absolute path', '/etc/passwd'],
  ['windows drive path', 'C:/Windows/System32/drivers/etc/hosts'],
  ['windows drive path with backslashes', 'C:\\Windows\\System32\\config'],
  ['unc share path', '//attacker/share/payload.ndf'],
  ['unc share path with backslashes', '\\\\attacker\\share\\payload.ndf'],
] as const;

describe('owned relative path guard', () => {
  for (const [label, candidate] of ESCAPING_PATHS) {
    test(`rejects ${label}`, () => {
      expect(() =>
        assertOwnedRelativePath(candidate, OWNER_ROOT, 'source mod config root'),
      ).toThrow('must stay inside its source mod config root');
    });
  }

  test('accepts nested paths and normalizes separators and no-op segments', () => {
    expect(assertOwnedRelativePath('scripts/generate.ts', OWNER_ROOT, 'patch root')).toBe(
      'scripts/generate.ts',
    );
    expect(assertOwnedRelativePath('scripts\\nested\\generate.ts', OWNER_ROOT, 'patch root')).toBe(
      'scripts/nested/generate.ts',
    );
    expect(assertOwnedRelativePath('scripts/./generate.ts', OWNER_ROOT, 'patch root')).toBe(
      'scripts/generate.ts',
    );
  });

  // `''`, `.`, and `a/..` all collapse to the owner root itself. Returning it
  // would let one configured temp path hand cleanup the whole root to delete.
  for (const [label, candidate] of [
    ['an empty path', ''],
    ['a bare dot', '.'],
    ['traversal back to the root', 'a/..'],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(() => assertOwnedRelativePath(candidate, OWNER_ROOT, 'patch root')).toThrow(
        'must name something inside its patch root',
      );
    });
  }

  test('accepts traversal that still resolves inside the root', () => {
    // `a/../b` never leaves the owner root, so collapsing it is safe.
    expect(assertOwnedRelativePath('a/../b.ndf', OWNER_ROOT, 'patch root')).toBe('b.ndf');
  });
});

describe('game relative path guard', () => {
  test('accepts the two writable game roots', () => {
    expect(assertGameRelativePath('GameData/Generated/Gameplay/Units.ndf', MOD_ROOT)).toBe(
      'GameData/Generated/Gameplay/Units.ndf',
    );
    expect(assertGameRelativePath('CommonData/Text/strings.csv', MOD_ROOT)).toBe(
      'CommonData/Text/strings.csv',
    );
  });

  test('rejects any target outside GameData and CommonData', () => {
    for (const candidate of [
      'Mods/other-mod/GameData/Units.ndf',
      'GameDataExtra/Units.ndf',
      'Units.ndf',
      'GameData/',
      'CommonData/',
      '',
    ]) {
      expect(() => assertGameRelativePath(candidate, MOD_ROOT)).toThrow();
    }
  });

  test('rejects a traversal that would climb out of the mod root', () => {
    expect(() => assertGameRelativePath('GameData/../../Steam.exe', MOD_ROOT)).toThrow(
      'must stay inside its mod root',
    );
  });

  test('requires the documented capitalization of the game roots', () => {
    // WARNO ships these folders capitalized. Accepting other spellings would let
    // two targets disagree about the same file on a case-sensitive checkout.
    expect(() => assertGameRelativePath('gamedata/Units.ndf', MOD_ROOT)).toThrow(
      'must stay inside GameData or CommonData',
    );
  });

  test.each([
    'GameData/file.txt:stream',
    'GameData/CON',
    'GameData/nul.txt',
    'GameData/folder./file.txt',
    'GameData/trailing /file.txt',
    'GameData/bad?.txt',
  ])('rejects Windows-unsafe target path %s', (target) => {
    expect(() => assertGameRelativePath(target, 'C:/mod')).toThrow();
  });

  test('resolves an accepted target under the mod root', () => {
    expect(resolveModTargetPath(MOD_ROOT, 'GameData/Generated/Units.ndf')).toBe(
      path.join(MOD_ROOT, 'GameData', 'Generated', 'Units.ndf'),
    );
  });
});

describe('owned file name guard', () => {
  test('accepts a bare recovery backup file name', () => {
    expect(resolveOwnedFilePath(OWNER_ROOT, `${'a'.repeat(64)}.ndf`, 'recovery backup')).toBe(
      path.join(OWNER_ROOT, `${'a'.repeat(64)}.ndf`),
    );
  });

  test('rejects any name carrying a directory or traversal', () => {
    for (const candidate of ['nested/backup.ndf', 'nested\\backup.ndf', '../backup.ndf', '..']) {
      expect(() => resolveOwnedFilePath(OWNER_ROOT, candidate, 'recovery backup')).toThrow();
    }
  });
});

describe('target path keys', () => {
  test('treat WARNO paths as case-insensitive and separator-insensitive', () => {
    // WARNO is a Windows game, so these three spellings address one file and must
    // collide during conflict detection even on a case-sensitive filesystem.
    const key = toPathKey('GameData/Generated/Gameplay/Units.ndf');
    expect(toPathKey('gamedata/generated/gameplay/units.ndf')).toBe(key);
    expect(toPathKey('GameData\\Generated\\Gameplay\\Units.ndf')).toBe(key);
  });

  test('keeps genuinely different targets distinct', () => {
    expect(toPathKey('GameData/A.ndf')).not.toBe(toPathKey('GameData/B.ndf'));
  });
});
