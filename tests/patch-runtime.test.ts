import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPatchGroupInSubprocess } from '../src/engine/patch-runtime.ts';
import type { ResolvedPatchContribution } from '../src/engine/types.ts';
import { YmbError } from '../src/errors.ts';
import type { BuildPlan, DiscoveredMod, DiscoveredPatch, PatchTarget } from '../src/types.ts';
import { createTestBuilderContext, createTestBuildPlan } from './helpers/planner.ts';

const sourceNdf = `export Descriptor_Unit_Worker is TEntityDescriptor
(
    FrontArmor = 1
)
`;

describe('patch worker subprocess', () => {
  test('returns the materialized target from a worker process', async () => {
    const { root, plan } = await createWorkerFixture();

    try {
      const response = await runPatchGroupInSubprocess({
        plan,
        patchGroup: [
          createContribution({
            file: 'GameData/Generated/Gameplay/Worker.ndf',
            operations: [
              {
                op: 'modify',
                selector: {
                  kind: 'field',
                  by: 'path',
                  value: 'Descriptor_Unit_Worker.FrontArmor',
                },
                value: 2,
              },
            ],
          }),
        ],
      });

      expect(response.writtenFile.targetRelativePath).toBe(
        'GameData/Generated/Gameplay/Worker.ndf',
      );
      expect(String(response.writtenFile.content)).toContain('FrontArmor = 2');
      expect(response.writtenFile.contributors).toEqual([
        { modId: 'worker_mod', modName: 'Worker Mod', patchId: 'worker.patch' },
      ]);
      expect(response.metrics.patchCacheBypassed).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('carries back what an operation noticed but did not fail on', async () => {
    const { root, plan } = await createWorkerFixture();

    try {
      const response = await runPatchGroupInSubprocess({
        plan,
        patchGroup: [
          createContribution({
            file: 'GameData/Generated/Gameplay/Worker.ndf',
            operations: [
              {
                op: 'modify',
                selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_Worker.FrontArmor' },
                value: 1,
              },
            ],
          }),
        ],
      });

      expect(response.writtenFile.notices).toHaveLength(1);
      expect(response.writtenFile.notices?.[0]?.reason).toContain(
        '`Descriptor_Unit_Worker.FrontArmor` is already `1`',
      );
      expect(response.writtenFile.notices?.[0]?.patchId).toBe('worker.patch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports a worker failure as the original YMB error', async () => {
    const { root, plan } = await createWorkerFixture();

    try {
      const failure = await runPatchGroupInSubprocess({
        plan,
        patchGroup: [
          createContribution({
            file: 'GameData/Generated/Gameplay/Missing.ndf',
            operations: [
              {
                op: 'modify',
                selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_Worker.FrontArmor' },
                value: 2,
              },
            ],
          }),
        ],
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(YmbError);
      expect((failure as YmbError).category).toBe('IoError');
      expect((failure as YmbError).context.reason).toContain('does not exist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createWorkerFixture(): Promise<{ root: string; plan: BuildPlan }> {
  const root = await mkdtemp(path.join(tmpdir(), 'ymb-patch-worker-'));
  const modRoot = path.join(root, 'mod-root');
  const ymbRoot = path.join(modRoot, 'YMB');
  await mkdir(ymbRoot, { recursive: true });
  await Bun.write(path.join(modRoot, 'GameData', 'Generated', 'Gameplay', 'Worker.ndf'), sourceNdf);
  return {
    root,
    plan: createTestBuildPlan(createTestBuilderContext(modRoot, ymbRoot), {
      dryRun: false,
      useCache: false,
    }),
  };
}

function createContribution(target: PatchTarget): ResolvedPatchContribution {
  const mod: DiscoveredMod = {
    config: {
      version: 1,
      id: 'worker_mod',
      name: 'Worker Mod',
      dependsOn: [],
      priority: 0,
      allowWriteToModifiedFiles: false,
      enabled: true,
      scripts: [],
      tempPaths: [],
    },
    absolutePath: path.resolve('mods', 'worker_mod'),
    configDirectoryPath: path.resolve('mods', 'worker_mod', 'config'),
    relativePathFromMods: 'worker_mod',
    configFilePath: path.resolve('mods', 'worker_mod', 'config', 'ymb.mod.yaml'),
    patches: [],
  };
  const patch: DiscoveredPatch = {
    config: {
      version: 1,
      id: 'worker.patch',
      name: 'Worker Patch',
      enabled: true,
      scope: 'prod',
      dependsOn: [],
      files: [],
      targets: [target],
      optional: false,
      scripts: [],
      tempPaths: [],
    },
    absolutePath: path.resolve('mods', 'worker_mod', 'config', 'patch', 'worker'),
    relativePathInMod: 'config/patch/worker',
    configFilePath: path.resolve(
      'mods',
      'worker_mod',
      'config',
      'patch',
      'worker',
      'ymb.patch.yaml',
    ),
  };

  return {
    application: { mod, patch },
    target,
    targetRelativePath: target.file,
    hasScripts: false,
    patchOrder: 0,
  };
}
