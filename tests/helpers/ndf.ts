import { expect } from 'bun:test';
import { createCooperativeYieldController } from '../../src/async.ts';
import { YmbError } from '../../src/errors.ts';
import {
  type ApplyPatchTargetOptions,
  applyPatchTargetCooperative,
} from '../../src/patch/ndf/core.ts';
import type {
  AuthoredOperation,
  NdfOperation,
  PatchApplication,
  PatchTarget,
} from '../../src/types.ts';

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
    configDirectoryPath: 'C:/fixture/YMB/mods/sample-pack/config',
    relativePathFromMods: 'sample-pack',
    configFilePath: 'C:/fixture/YMB/mods/sample-pack/config/ymb.mod.yaml',
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
      files: [],
      targets: [],
      optional: false,
      scripts: [],
      tempPaths: [],
    },
    absolutePath: 'C:/fixture/YMB/mods/sample-pack/config/patch/armor',
    relativePathInMod: 'config/patch/armor',
    configFilePath: 'C:/fixture/YMB/mods/sample-pack/config/patch/armor/ymb.patch.yaml',
  },
};

/** The builder only patches cooperatively, so a test supplies the yield controller. */
export function applyPatchTarget(
  currentText: string,
  target: PatchTarget,
  patchApplication: PatchApplication,
  absolutePath: string,
  options?: ApplyPatchTargetOptions,
): Promise<string> {
  return applyPatchTargetCooperative(
    currentText,
    target,
    patchApplication,
    absolutePath,
    createCooperativeYieldController(),
    options,
  );
}

export async function expectYmbError(
  action: () => unknown,
  category: YmbError['category'],
  reasonIncludes?: string,
): Promise<YmbError> {
  let thrown: unknown;

  try {
    await action();
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

/**
 * Narrows an authored operation to a plain one. Fixtures write operations
 * directly, so a `forEach` here means the fixture itself is wrong.
 */
export function asOperation(entry: AuthoredOperation | undefined): NdfOperation {
  if (!entry || 'forEach' in entry) {
    throw new Error('Expected a plain operation, not a `forEach` block.');
  }
  return entry;
}
