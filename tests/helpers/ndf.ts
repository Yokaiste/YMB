import { expect } from 'bun:test';
import { YmbError } from '../../src/errors.ts';
import type { PatchApplication } from '../../src/types.ts';

export const application: PatchApplication = {
  mod: {
    config: {
      version: 1,
      id: 'sample_pack',
      name: 'Sample Pack',
      dependsOn: [],
      priority: 0,
      allowWriteToModifiedFiles: false,
      enabled: true,
      scripts: [],
      tempPaths: [],
    },
    absolutePath: 'C:/fixture/YMB/mods/sample-pack',
    configAbsolutePath: 'C:/fixture/YMB/mods/sample-pack/config',
    relativePathFromMods: 'sample-pack',
    absoluteConfigPath: 'C:/fixture/YMB/mods/sample-pack/config/ymb.mod.yaml',
    patches: [],
  },
  patch: {
    config: {
      version: 1,
      id: 'balance.armor',
      name: 'Armor Tweaks',
      enabled: true,
      scope: 'prod',
      dependsOn: [],
      targets: [],
      scripts: [],
      tempPaths: [],
    },
    absolutePath: 'C:/fixture/YMB/mods/sample-pack/config/patch/armor',
    relativePathInMod: 'config/patch/armor',
    absoluteConfigPath: 'C:/fixture/YMB/mods/sample-pack/config/patch/armor/ymb.patch.yaml',
  },
};

export function expectYmbError(
  action: () => unknown,
  category: YmbError['category'],
  reasonIncludes?: string,
): YmbError {
  let thrown: unknown;

  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(YmbError);
  const ymbError = thrown as YmbError;
  expect(ymbError.category).toBe(category);

  if (reasonIncludes) {
    expect(ymbError.message).toContain(reasonIncludes);
  }

  return ymbError;
}
