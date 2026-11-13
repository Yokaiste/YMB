import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { assertRequiredBlockReferences } from '../src/engine/block-references.ts';
import { preparePlan, runValidate } from '../src/engine/commands.ts';
import type { SelectionInput } from '../src/types.ts';
import { cleanupTempRoots, createAbstractBuilderWorkspace } from './helpers/abstract-builder.ts';
import { expectYmbError } from './helpers/ndf.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

const selection: SelectionInput = {
  scope: 'prod',
  modFilters: [],
  patchFilters: ['ui.panel'],
  dryRun: true,
  verbose: false,
  yes: false,
};

const SCREEN_TARGET = 'GameData/Generated/UI/Screen.ndf';

/** The parent names its child, which is what a patch on that child relies on. */
const referencingParent = `export ScreenRoot is BUCKContainerDescriptor
(
    ElementName = "ScreenRoot"
    Components =
    [
        ~/ChildPanel,
    ]
)

export ChildPanel is BUCKListDescriptor
(
    ElementName = "ChildPanel"
    Axis = ~/ListAxis/Horizontal
)
`;

/** `ChildPanel` is named by nobody except the string the inlined copy carries, which is why a text search alone cannot answer this. */
const inliningParent = `export ScreenRoot is TBUCKContainerDescriptor
(
    ElementName = 'ScreenRoot'
    Components =
    [
        TBUCKListDescriptor
        (
            ElementName = 'ChildPanel'
        ),
    ]
)

export ChildPanel is BUCKListDescriptor
(
    ElementName = "ChildPanel"
    Axis = ~/ListAxis/Horizontal
)
`;

interface WorkspaceOptions {
  screen: string;
  expectReferenced?: string[];
  optional?: boolean;
}

async function createWorkspace(options: WorkspaceOptions): Promise<string> {
  const workspace = await createAbstractBuilderWorkspace(tempRoots);
  await Bun.write(path.join(workspace.modRootPath, ...SCREEN_TARGET.split('/')), options.screen);
  const expectBlock = options.expectReferenced
    ? `    expect:\n      referenced: [${options.expectReferenced.join(', ')}]\n`
    : '';
  await Bun.write(
    path.join(workspace.builderPath, 'mods/sample-pack/config/patch/panel/ymb.patch.yaml'),
    `version: 1
id: ui.panel
name: Panel
enabled: true
scope: prod
optional: ${options.optional ?? false}
dependsOn: []
targets:
  - file: ${SCREEN_TARGET}
${expectBlock}    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: ChildPanel.Axis
        value:
          $raw: ~/ListAxis/Vertical
`,
  );
  return workspace.builderPath;
}

describe('blocks a patch says must stay referenced', () => {
  test('a patched block the parent still names passes', async () => {
    const builderPath = await createWorkspace({
      screen: referencingParent,
      expectReferenced: ['ChildPanel'],
    });

    const lines = await runValidate(builderPath, selection);

    expect(lines.join('\n')).toContain(SCREEN_TARGET);
  });

  test('a patched block nothing names any more fails, and says what to look at', async () => {
    const builderPath = await createWorkspace({
      screen: inliningParent,
      expectReferenced: ['ChildPanel'],
    });

    const error = await expectYmbErrorAsync(
      () => runValidate(builderPath, selection),
      'SelectorError',
    );

    expect(error.context.reason).toContain('ChildPanel');
    expect(error.context.suggestion).toBeTruthy();
    expect(error.context.patchId).toBe('ui.panel');
  });

  test('a name inside a longer quoted label is still text, not a reference', async () => {
    const builderPath = await createWorkspace({
      screen: inliningParent.replace("'ChildPanel'", "'The ChildPanel label'"),
      expectReferenced: ['ChildPanel'],
    });
    const error = await expectYmbErrorAsync(
      () => runValidate(builderPath, selection),
      'SelectorError',
    );
    expect(error.context.reason).toContain('ChildPanel');
  });

  test('references in a file selected for deletion do not keep a block alive', async () => {
    const builderPath = await createWorkspace({
      screen: inliningParent,
      expectReferenced: ['ChildPanel'],
    });
    const referencePath = 'CommonData/Reference.ndf';
    await Bun.write(
      path.join(builderPath, '..', referencePath),
      'Ref is Thing(Child = ~/ChildPanel)\n',
    );
    const configPath = path.join(builderPath, 'mods/sample-pack/config/patch/panel/ymb.patch.yaml');
    await Bun.write(
      configPath,
      `${await Bun.file(configPath).text()}\nfiles:\n  - op: remove\n    target: ${referencePath}\n`,
    );
    const error = await expectYmbErrorAsync(
      () => runValidate(builderPath, selection),
      'SelectorError',
    );
    expect(error.context.reason).toContain('ChildPanel');
  });

  test('NDF returned as UTF-8 bytes can supply the reference', async () => {
    const builderPath = await createWorkspace({
      screen: inliningParent,
      expectReferenced: ['ChildPanel'],
    });
    const plan = await preparePlan(builderPath, selection);
    await assertRequiredBlockReferences(
      plan,
      [
        {
          targetRelativePath: 'CommonData/Reference.ndf',
          content: new TextEncoder().encode('Ref is Thing(Child = ~/ChildPanel)\n'),
          sourceType: 'script',
          contributors: [],
        },
      ],
      { maybeYield: async () => undefined },
    );
  });

  test('the same patch without the expectation still passes, because nothing asked', async () => {
    // The check is opt-in on purpose: roughly one top-level block in ten in real
    // game data is referenced by nothing and works, so YMB cannot decide this.
    const builderPath = await createWorkspace({ screen: inliningParent });

    const lines = await runValidate(builderPath, selection);

    expect(lines.join('\n')).toContain(SCREEN_TARGET);
  });

  test('an `optional` patch is skipped instead of stopping the run', async () => {
    const builderPath = await createWorkspace({
      screen: inliningParent,
      expectReferenced: ['ChildPanel'],
      optional: true,
    });

    const lines = await runValidate(builderPath, selection);

    expect(lines.join('\n')).toContain('skipped');
    expect(lines.join('\n')).toContain('ui.panel');
  });

  test('a name the whole project never mentions fails rather than passing quietly', async () => {
    const builderPath = await createWorkspace({
      screen: referencingParent,
      expectReferenced: ['ChildPanel', 'BlockThatIsNotThere'],
    });

    const error = await expectYmbErrorAsync(
      () => runValidate(builderPath, selection),
      'SelectorError',
    );

    expect(error.context.reason).toContain('BlockThatIsNotThere');
  });
});

async function expectYmbErrorAsync(action: () => Promise<unknown>, category: string) {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  return await expectYmbError(
    () => {
      throw thrown;
    },
    category as Parameters<typeof expectYmbError>[1],
  );
}
