import { describe, expect, test } from 'bun:test';
import { YmbError } from '../src/errors.ts';
import { detectTargetConflictsCooperative } from '../src/planner/conflicts.ts';
import type { BuilderContext, DiscoveredMod, ReplaceFile } from '../src/types.ts';

const SHARED_TARGET = 'CommonData/Text/shared.ndf';

interface ModOptions {
  priority?: number;
  dependsOn?: string[];
  allowWriteToModifiedFiles?: boolean;
}

function createMod(id: string, options: ModOptions = {}): DiscoveredMod {
  return {
    config: {
      version: 1,
      id,
      name: id,
      dependsOn: options.dependsOn ?? [],
      priority: options.priority ?? 0,
      allowWriteToModifiedFiles: options.allowWriteToModifiedFiles ?? false,
      enabled: true,
      scripts: [],
      tempPaths: [],
    },
    absolutePath: `mods/${id}`,
    configDirectoryPath: `mods/${id}/config`,
    relativePathFromMods: id,
    configFilePath: `mods/${id}/config/ymb.mod.yaml`,
    patches: [],
  };
}

function createReplaceFile(mod: DiscoveredMod): ReplaceFile {
  return {
    sourceAbsolutePath: `mods/${mod.config.id}/config/replace/${SHARED_TARGET}`,
    targetRelativePath: SHARED_TARGET,
    modId: mod.config.id,
    modName: mod.config.name,
    priority: mod.config.priority,
    allowWriteToModifiedFiles: mod.config.allowWriteToModifiedFiles,
    templateVariables: {},
    sourceType: 'replace',
    contentMode: 'exact',
  };
}

/** No patch is selected in these cases, so nothing reads the context. */
const context = {} as BuilderContext;

async function detectReplaceConflicts(mods: DiscoveredMod[]): Promise<void> {
  await detectTargetConflictsCooperative(context, mods, [], mods.map(createReplaceFile), []);
}

describe('replace ownership when several mods layer onto one target', () => {
  test('accepts three mods when each is ordered above every earlier claim', async () => {
    const base = createMod('base');
    const middle = createMod('middle', { dependsOn: ['base'], allowWriteToModifiedFiles: true });
    const top = createMod('top', {
      dependsOn: ['base', 'middle'],
      allowWriteToModifiedFiles: true,
    });

    await detectReplaceConflicts([base, middle, top]);
  });

  test('rejects a third mod ordered above only the most recent writer', async () => {
    const base = createMod('base');
    const middle = createMod('middle', { dependsOn: ['base'], allowWriteToModifiedFiles: true });
    // `top` clears `middle` but declares nothing about `base`, which still owns
    // the target. Checking against the last writer instead would accept this.
    const top = createMod('top', { dependsOn: ['middle'], allowWriteToModifiedFiles: true });

    const failure = await detectReplaceConflicts([base, middle, top]).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(YmbError);
    expect((failure as YmbError).category).toBe('ConflictError');
    expect((failure as YmbError).context.details).toContain('Existing replace owner mod: base');
    expect((failure as YmbError).context.modId).toBe('top');
  });

  test('a higher priority clears every earlier claim at once', async () => {
    const base = createMod('base', { priority: 0 });
    const middle = createMod('middle', { priority: 1, allowWriteToModifiedFiles: true });
    const top = createMod('top', { priority: 2, allowWriteToModifiedFiles: true });

    await detectReplaceConflicts([base, middle, top]);
  });

  test('rejects a layering mod that never opts in', async () => {
    const base = createMod('base');
    const middle = createMod('middle', { priority: 1, allowWriteToModifiedFiles: false });

    await expect(detectReplaceConflicts([base, middle])).rejects.toThrow(
      'Two source mods replace the same output path',
    );
  });
});

describe('a target used as another target directory', () => {
  /**
   * Paths are compared case-insensitively because WARNO is a Windows game, but
   * the reader has to go and find the file the message names. Printing the
   * folded comparison key instead of the authored spelling hands them a path
   * that does not match what they wrote.
   */
  test('names the patch target as it was authored, not as it was folded', async () => {
    const mod = createMod('base');
    const patchTarget = 'CommonData/Text/Shared.ndf';
    const application = {
      mod,
      patch: {
        config: {
          version: 1 as const,
          id: 'base.text',
          name: 'Base Text',
          enabled: true,
          scope: 'prod' as const,
          dependsOn: [],
          files: [],
          targets: [{ file: patchTarget, operations: [] }],
          optional: false,
          scripts: [],
          tempPaths: [],
        },
        absolutePath: 'mods/base/config/patch/text',
        relativePathInMod: 'config/patch/text',
        configFilePath: 'mods/base/config/patch/text/ymb.patch.yaml',
      },
    };
    const descendant: ReplaceFile = {
      ...createReplaceFile(mod),
      targetRelativePath: `${patchTarget}/nested.ndf`,
    };

    const failure = await detectTargetConflictsCooperative(
      { modRoot: 'C:/game' } as BuilderContext,
      [mod],
      [application],
      [descendant],
      [],
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YmbError);
    expect((failure as YmbError).context.reason).toContain(`\`${patchTarget}\``);
    expect((failure as YmbError).context.reason).not.toContain('commondata/text/shared.ndf');
  });
});
