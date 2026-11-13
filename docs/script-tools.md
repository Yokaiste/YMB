# Generation scripts

[Docs](README.md) / Generation scripts · [Advanced workflows](advanced.md)

Continue with `first_mod` from [your first playable mod](getting-started.md) and the [health patch](ndf-operations.md). You will keep its menu title and give two Abrams variants 50% more HP, capped at 18. This changes the units WARNO actually loads.

The previous YAML lesson can already calculate health and apply a cap. This optional lesson implements that rule in TypeScript to teach game-file readers, input checks, and tests. Keep the YAML version when it covers your needs; scripts become useful as your rules need more per-unit inputs or branching logic.

> [!CAUTION]
> Scripts execute code on your machine. Use projects you trust. Validation and dry runs can execute scripts, including their project-file writes.

## 1. Start with the script you already have

Open `YMB/mods/first_mod/config/generate-build-info.ts`, created by `init`. It reads `generatedInfoTarget`, uses the project's id, name, and description, then returns a file. Its companion test checks the destination and text escaping.

That script writes `GameData/Generated/Gameplay/first_mod/StarterInfo.ndf`. It records project information; it does not create the menu title. The title comes from the welcome-screen patch and its localisation template. Keep the starter files and their registration in `config/ymb.mod.yaml` unchanged for this lesson.

Our new script will follow the same return-file pattern, but read and change existing game data first.

## 2. Replace the earlier health rule

If you used personal overrides in `YMB/ymb.config.yaml`, remove the tutorial's `mods.first_mod` entry before continuing. Keep unrelated projects and path settings. Otherwise an old override can disable this patch or replace the values below.

Replace the **whole contents** of `YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml` with:

```yaml
version: 1
id: gameplay.health
name: Capped tank health
scope: prod
variables:
  healthUnits:
    - Descriptor_Unit_M1A1_Abrams_US
    - Descriptor_Unit_M1IP_Abrams_US
  healthPercent: 150
  healthCap: 18
scripts:
  - path: scale-health.ts
    tests:
      - scale-health.test.ts
```

This replaces the previous `targets` list, including any `modify`, `forEach`, or `bulk` variant you tried. Do not keep both versions active: scaling a value already changed by your YAML patch would produce a different result. The patch id stays `gameplay.health`, so its selection commands still work.

## 3. Read, calculate, return

Create `scale-health.ts` beside that patch config:

```ts
import type { BuildScriptContext } from 'ymb/api';

const FILE = 'GameData/Generated/Gameplay/TacticalUnits.ndf';
const HEALTH = 'ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages';

export default async function scaleHealth(context: BuildScriptContext) {
  const { values, ndf } = context.tools;
  const names = values.stringArray(context.variables.healthUnits, 'healthUnits');
  const percent = values.positiveInteger(context.variables.healthPercent, 'healthPercent');
  const cap = values.positiveInteger(context.variables.healthCap, 'healthCap');
  context.tools.assert.ok(names.length > 0, {
    reason: 'healthUnits is empty.',
    suggestion: 'Add at least one unit descriptor name to the health patch variables.',
  });

  const source = await context.readTarget(FILE);
  const blocks = new Map(ndf.findTopLevelBlocks(source).map((block) => [block.name, block]));
  const operations = names.map((name) => {
    const block = blocks.get(name);
    const raw = block && ndf.readPath(block.text, HEALTH);
    const hp = raw === undefined ? undefined : ndf.parseValue(raw);
    context.tools.assert.ok(
      (hp?.kind === 'int' || hp?.kind === 'float') && Number.isFinite(hp.value) && hp.value > 0,
      {
        reason: `${name} has no positive numeric MaxPhysicalDamages value.`,
        suggestion: 'Check the unit name and damage module in TacticalUnits.ndf.',
      },
    );
    return {
      op: 'modify',
      selector: { kind: 'field', by: 'path', value: `${name}.${HEALTH}` },
      value: Math.max(1, Math.min(cap, Math.round((hp.value * percent) / 100))),
    };
  });

  return {
    targetRelativePath: FILE,
    content: await context.tools.patch(source, { file: FILE, operations }),
  };
}
```

The script reads the file once and indexes its named blocks once. Each selected unit keeps at least 1 HP; the scaled value is rounded to a whole number and capped at `healthCap`. A mistyped unit name fails with a useful error instead of quietly skipping half your mod.

`context.tools.patch` uses the same operations as YAML. It checks operation shapes and NDF syntax, resolves templates, and expands `forEach`. It only changes the supplied text. Reading the target and returning the result are the script's job.

## 4. Check the rule with small inputs

Create `scale-health.test.ts` beside the script:

```ts
import assert from 'node:assert/strict';
import type { BuildScriptTest } from 'ymb/api';
import scaleHealth from './scale-health.ts';

const HEALTH = 'ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages';

const test: BuildScriptTest = async (context) => {
  const fixture = [
    ['Sample_A', 10],
    ['Sample_B', 14],
    ['Untouched', 8],
  ]
    .map(
      ([name, hp]) => `${name} is TEntityDescriptor
(
  ModulesDescriptors = [
    TBaseDamageModuleDescriptor
    (
      MaxPhysicalDamages = ${hp}
    ),
  ]
)
`,
    )
    .join('\n');
  const sample = {
    ...context,
    variables: {
      healthUnits: ['Sample_A', 'Sample_B'],
      healthPercent: 150,
      healthCap: 18,
    },
    readTarget: async () => fixture,
  };
  const output = await scaleHealth(sample);
  for (const [name, expected] of [
    ['Sample_A', 15],
    ['Sample_B', 18],
    ['Untouched', 8],
  ]) {
    const block = context.tools.ndf.findNamedBlock(output.content, String(name));
    assert.ok(block);
    assert.equal(context.tools.ndf.readPath(block.text, HEALTH), String(expected));
  }
  await assert.rejects(() =>
    scaleHealth({ ...sample, variables: { ...sample.variables, healthUnits: ['Missing'] } }),
  );
  return {
    results: [{ name: 'Health scaling, cap, selection, and missing unit', status: 'passed' }],
  };
};

export default test;
```

These invented unit names belong only to the test. The normal build still reads the real Abrams definitions. The test covers the calculation, the cap, an untouched neighbor, and a missing unit without copying a giant game file into your project.

## 5. Build it, then play it

In the YMB shell, run:

```text
build --mod first_mod
```

Open `.ymb-build/output/GameData/Generated/Gameplay/TacticalUnits.ndf` and search for each exact descriptor name. Inside its `TBaseDamageModuleDescriptor`, `MaxPhysicalDamages` should be `15` when the original value is `10`. Other units keep their original values. The preview also retains your welcome-screen title.

Set `healthPercent` to `200` and build again. Both selected tanks should now stop at `18`, rather than reaching `20`. Then set it back to `150` and build once more. Keep that result for the [advanced layering lesson](advanced.md#layering-one-mod-over-another).

After checking the preview:

```text
sync --mod first_mod --yes
```

Run `GenerateMod.bat` in `WARNO/Mods/MyFirstMod`, enable `MyFirstMod` in WARNO, and inspect or deploy an M1A1 or M1IP Abrams in a deck that includes it. Your custom menu title confirms the mod is enabled; the chosen tanks now have the HP from your preview. After later edits, repeat build, sync, and compilation.

A game update can change a descriptor name or its original HP. Use `find --name Abrams --file GameData/Generated/Gameplay/TacticalUnits.ndf` to check names. The formula always uses the input available to this script; `15` assumes an original `10` and no earlier HP-changing contributor.

## Registering other scripts

Put `scripts` in `ymb.mod.yaml` for project-wide output or in a patch config for one feature. Paths are relative to the declaring config. Scripts run in their declared build order; later scripts can read earlier output through the target readers.

Export a default function or a named `generate` function. It may be synchronous or async and returns one file or an array of files:

| Field                      | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `targetRelativePath`       | Destination under `GameData/` or `CommonData/`                                              |
| `content`                  | Text or `Uint8Array`                                                                        |
| `generatedBlockOwnerPaths` | Optional delegation to same-project scripts for [generated regions](#owning-part-of-a-file) |

Import API types and runtime helpers from `ymb/api`. The release includes type declarations for editor completion. `context.tools.apiVersion` is `4`, separate from the CLI JSON schema version.

## The context

| Member      | Contains                                                          |
| ----------- | ----------------------------------------------------------------- |
| `builder`   | Resolved project, game, preview, cache, and recovery paths        |
| `selection` | Scope, filters, dry-run, verbosity, and cache setting             |
| `mod`       | Owning project's id, name, description, root, and config path     |
| `patch`     | Owning patch, if the script belongs to one                        |
| `variables` | Merged and resolved variables                                     |
| `tools`     | NDF operations, assertions, value checks, text helpers, and cache |

### Read target files

| Method                   | Result                               |
| ------------------------ | ------------------------------------ |
| `readTarget(path)`       | One text file                        |
| `readTargets(paths)`     | A record of text files keyed by path |
| `readBinaryTarget(path)` | One file as bytes                    |

Readers first use earlier generated output, then eligible prepared replacements or file operations, then game data. Prepared text has its variables resolved. Reading another project's generated output requires [ordered layering](advanced.md#layering-one-mod-over-another).

For previously synced files, readers use saved original bytes, including originals of deleted files. This prevents the health script from multiplying its own installed result on every build. Missing or damaged required originals stop the build.

When a script needs several independent inputs, batch them:

```ts
const inputs = await context.readTargets([
  'GameData/Generated/Gameplay/TacticalUnits.ndf',
  'GameData/Generated/Gameplay/Gfx/WeaponDescriptor.ndf',
]);
```

### Read and write project-owned files

| Method                                | Scope                                              |
| ------------------------------------- | -------------------------------------------------- |
| `resolvePath(path)`                   | Absolute path under the owning config folder       |
| `resolveModPath(path)`                | Absolute path under the project's `config/` folder |
| `readOwnedTextIfExists(path)`         | Text under the owning config folder                |
| `writeOwnedTextIfChanged(path, text)` | Write there only when content differs              |
| `readModTextIfExists(path)`           | Text under the project's `config/` folder          |
| `writeModTextIfChanged(path, text)`   | Write there only when content differs              |

Absent-file readers return `''`. Writers return whether they changed the file. Path helpers reject escapes and invalid Windows filenames.

Use these writes for persistent project state, such as an id registry. Return generated game files as output. Companion tests keep writes through these helpers in memory for that test; the same project files on disk stay unchanged. Arbitrary filesystem code is not sandboxed by this behavior.

## NDF tools

| Task                        | Methods                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Check syntax                | `validate`, `assertValid`                                                                                              |
| Find top-level blocks       | `findTopLevelBlocks`, `findNamedBlock`                                                                                 |
| Walk nested typed objects   | `findObjects`, `matcher`                                                                                               |
| Read numeric definitions    | `readNumericDefinitions`                                                                                               |
| Locate fields               | `findField`, `findFieldDeep`, `findFieldWithComment`                                                                   |
| Read fields                 | `readField`, `readFields`, `readFieldDeep`, `readFieldsDeep`, `readPath`                                               |
| Parse values                | `parseValue`, `parseList`, `primaryTypeName`                                                                           |
| Work with lists             | `findCollectionEntries`, `extractCollection`, `insertIntoCollection`                                                   |
| Extract an object body      | `extractBody`                                                                                                          |
| Work with generated regions | `listGeneratedBlocks`, `stripGeneratedBlocks`, `generatedBlockMarkers`, `renderGeneratedBlock`, `upsertGeneratedBlock` |
| Format text                 | `formatValue`, `stripComments`                                                                                         |

The `Deep` methods search nested objects. A scalar read returns NDF text; `parseValue` reports numbers as `kind: 'int'` or `kind: 'float'`, alongside string, reference, boolean, and raw-syntax variants. `readPath` accepts dotted paths or field-segment arrays relative to the supplied block. Find the named unit first, then read its damage-module path as the health script does.

`findObjects` returns top-level and nested typed objects in source order, with absolute character spans. It ignores comments and quoted text that resembles an object. `matcher` accepts the same conditions as `bulk`; for example, match type `TEntityDescriptor` when examining units.

`readNumericDefinitions` returns a record of single-line numeric definitions. Expressions and nested fields are not numeric definitions.

`assertValid(text, pathHint)` throws a useful error. `validate(text, pathHint)` returns `{ ok: true }` or `{ ok: false, error }`, with a code, line, column, offset, and suggested fix. YMB also checks combined output, including cached and binary-returned NDF. A standalone value can be one snippet; multiple top-level definitions need named `Name is Value` declarations. These checks validate syntax, not WARNO's type system or resources.

## Failing usefully

Use assertions to name the failed assumption and a possible fix, as the health script does for a missing damage value.

| Method                                  | Check                                         |
| --------------------------------------- | --------------------------------------------- |
| `ok(condition, options)`                | The condition is truthy                       |
| `textPresent(text, options)`            | Text contains something besides whitespace    |
| `textIncludes(text, fragment, options)` | A required fragment is present                |
| `textMatches(text, regex, options)`     | A regular expression matches                  |
| `all(checks)`                           | Runs named checks and collects their failures |

Options require `reason` and `suggestion`; `details` and `absolutePath` are optional. “Something went wrong” has already been established by the failed build.

Assertions and value helpers throw `ScriptToolError`, available from `ymb/api` when you need to recognize or throw a structured failure. Do not turn unrelated exceptions into successful output.

## Reading configuration safely

`context.variables` contains user input. The health lesson checks a string list and positive integers before using them. Other available checks are `record`, `string`, `optionalString`, `boolean`, and `oneOf`.

These helpers label the offending setting in their errors. Apply your own documented defaults; a validator should not invent a tuning choice. Use `assert.ok` for a constraint the value helpers do not cover, such as a finite fractional multiplier.

## Text and cache tools

`context.tools.text.escapeRegExp(value)` escapes data before it becomes part of a regex. `describeChanges(before, after)` returns edit ranges or `{ ok: false, reason: 'budget_exceeded' }` for comparisons beyond its budget.

| Cache method                          | Purpose                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `createKey(input)`                    | Build a key from JSON-compatible inputs and script dependencies |
| `hash(textOrBytes)`                   | Hash a large input for use in a key                             |
| `readJson(namespace, key, validator)` | Return a validated cached value, or `undefined`                 |
| `writeJson(namespace, key, value)`    | Store a result                                                  |
| `enabled`                             | Whether this run allows caching                                 |

Include every setting and source input that affects your result. Pass a real shape check to `readJson`. Namespaces and keys use letters, digits, dots, underscores, or hyphens; Windows device names, `.`, `..`, and trailing dots are invalid.

Under `--no-cache`, cache reads miss and writes do nothing. Use owned-file helpers for identities or anything you cannot safely recompute. The small health script does not need a custom cache.

## Script tests

A companion test receives the build context plus `script` and `testAbsolutePath`. Its default export returns `{ results: [...] }`. Each result has a `name` and `status` of `passed` or `failed`; failed results should include `reason` and `suggestion`.

A bare test path runs **before** its script. It sees prepared inputs and earlier contributions. The health test overrides its target reader with a tiny fixture, so it can check the cap without depending on the current game balance.

To test actual generated output, register a test with `{ path: check-output.test.ts, when: after }` after creating that file. An after-test sees its script's output and persistent files written during the run. Before-tests can use cached results when dependencies are unchanged; after-tests run every time. Both participate in `validate`, `build`, and `sync`.

Test contracts worth protecting: stable identities, a missing required input, a cap or rounding boundary, or preserving another feature's data. Avoid tests that only repeat the implementation or freeze descriptive text.

## Owning part of a file

The health script edits existing definitions, so it needs no generated region. When a script adds new definitions to a shared file, generated blocks can mark the region it owns. Those definitions still need real game references to do anything.

Use `renderGeneratedBlock({ ownerId, sourcePath, blocks })` and `upsertGeneratedBlock(existing, rendered, ownerId)`. Keep `ownerId` stable. Set `sourcePath` to the configured script's path relative to the YMB root, using `/` separators. Preserve other regions when rewriting the file.

A script automatically owns its own path. To deliberately update regions owned by other selected scripts from the same project, list those scripts in `generatedBlockOwnerPaths`. These are YMB-relative script paths, not region ids. Unknown scripts and other projects' scripts are rejected; normal conflict checks still apply outside owned regions.

Produce the same bytes from the same inputs. Read and write through the public context, return game output, and preserve persistent ids across updates. Continue with [advanced workflows](advanced.md) to extend this playable project from a second mod project.
