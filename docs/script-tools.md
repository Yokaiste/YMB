# Generation Scripts

Most changes need no code — a patch and a selector are enough. Reach for a script when
the output has to be **computed**: read several files, count things, generate a hundred
similar entries.

```ts
import type { BuildScript } from 'ymb/api';

const generate: BuildScript = async (context) => {
  const units = await context.readTarget('GameData/Generated/Gameplay/Units.ndf');
  const names = context.tools.ndf.findTopLevelBlocks(units).map((block) => block.name);

  return {
    targetRelativePath: 'GameData/Generated/Gameplay/MyPack/Index.ndf',
    content: names.map((name) => `// ${name}`).join('\n'),
  };
};

export default generate;
```

> **Use a patch when a selector and a value would do.** A script is more power and more
> maintenance. See [Changing NDF files](ndf-operations.md).

---

## Register it

In `ymb.mod.yaml` (whole mod) or `ymb.patch.yaml` (one feature):

```yaml
scripts:
  - path: generate-output.ts
    tests:
      - generate-output.test.ts
```

Paths are relative to the config file that declares them. Scripts run in the order
listed, and a later one can read what an earlier one produced.

---

## What a script returns

Export a `default` or a named `generate` function. Return one file, or an array of them:

```ts
return {
  targetRelativePath: 'GameData/Generated/Gameplay/MyPack/Summary.ndf',
  content: source,
};
```

| Field                      | Meaning                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `targetRelativePath`       | Where it lands. Must be under `GameData` or `CommonData`.                                     |
| `content`                  | Text or `Uint8Array`.                                                                         |
| `generatedBlockOwnerPaths` | Optional. Marked regions this script claims — see [generated blocks](#owning-part-of-a-file). |

---

## The context

Everything a script is allowed to touch arrives as `context`. It is read-only apart from
the explicit write helpers.

**Where things are**

| Member      | Holds                                                       |
| ----------- | ----------------------------------------------------------- |
| `builder`   | Resolved paths — YMB root, game data, preview, state        |
| `selection` | `scope`, filters, `dryRun`, `verbose`, `useCache`           |
| `mod`       | The owning mod's id, name, and paths                        |
| `patch`     | The owning patch, when the script belongs to one            |
| `variables` | Resolved mod and patch [variables](template-expressions.md) |

**Reading game data**

| Call                     | Reads                                                         |
| ------------------------ | ------------------------------------------------------------- |
| `readTarget(path)`       | One text target — live game data, or earlier generated output |
| `readTargets(paths)`     | Several at once. Prefer this over a loop.                     |
| `readBinaryTarget(path)` | One file as bytes                                             |

> **Scripts run before file operations and replace files are materialized.** A script can
> read live game data and the output of an earlier script, but **not** a file that a
> `files:` operation or `config/replace` will place in this same build — that has not been
> written yet. If a script needs such a file, read it from its source location with
> `readOwnedTextIfExists` or `readModTextIfExists` instead.

**Reading and writing your own files**

| Call                                                            | Scope                                          |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `resolvePath(p)` / `resolveModPath(p)`                          | Absolute path inside the config root / the mod |
| `readOwnedTextIfExists(p)` / `writeOwnedTextIfChanged(p, text)` | Files under the owning config root             |
| `readModTextIfExists(p)` / `writeModTextIfChanged(p, text)`     | Files under the source mod                     |

The `IfExists` readers return `''` when the file is absent. The `IfChanged` writers skip
identical content and return whether they wrote.

> **Authored state belongs here, never in the cache.** ID registries and allocation
> tables must survive a `cleanup`.

---

## NDF tools

`context.tools.ndf` — use these instead of writing your own parser.

| Group            | Calls                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Validate         | `validate`, `assertValid`                                                                                              |
| Find blocks      | `findTopLevelBlocks`, `findNamedBlock`                                                                                 |
| Find fields      | `findField`, `findFieldDeep`, `findFieldWithComment`                                                                   |
| Read fields      | `readField`, `readFields`, `readFieldDeep`, `readFieldsDeep`, `readPath`                                               |
| Parse values     | `parseValue`, `parseList`, `primaryTypeName`                                                                           |
| Lists            | `findCollectionEntries`, `extractCollection`, `insertIntoCollection`                                                   |
| Bodies           | `extractBody`                                                                                                          |
| Generated blocks | `listGeneratedBlocks`, `stripGeneratedBlocks`, `generatedBlockMarkers`, `renderGeneratedBlock`, `upsertGeneratedBlock` |
| Formatting       | `formatValue`, `stripComments`                                                                                         |

`Deep` variants search nested modules, not just the top level of the block.

```ts
const block = context.tools.ndf.findNamedBlock(units, 'Descriptor_Unit_T80U');
const armor = block && context.tools.ndf.readFieldDeep(block.text, 'FrontArmor');
```

**Always validate before returning:**

```ts
context.tools.ndf.assertValid(output, 'MyPack/Index.ndf');
```

---

## Failing usefully

`context.tools.assert` produces the same structured errors the builder uses — a reason,
a fix, and the file it happened in.

```ts
context.tools.assert.textIncludes(source, 'Descriptor_Expected', {
  reason: 'Units.ndf no longer contains Descriptor_Expected.',
  suggestion: 'A WARNO update renamed it. Update the name in generate-output.ts.',
});
```

| Helper                              | Fails when                 |
| ----------------------------------- | -------------------------- |
| `ok(condition, options)`            | the condition is falsy     |
| `textPresent(text, options)`        | the text is empty or blank |
| `textIncludes(text, part, options)` | the fragment is missing    |
| `textMatches(text, regex, options)` | the pattern does not match |
| `all(checks)`                       | any named check throws     |

> **Write the `suggestion` for the person who hits it in six months.** "Update the
> selector" helps; "assertion failed" does not.

Every failure from `assert` and from `values` is a `ScriptToolError`, and so is anything
you throw yourself. Catch one when a script or a script test wants to check that bad input
is rejected with guidance rather than by an accident:

```ts
import { ScriptToolError } from 'ymb/api';

try {
  context.tools.values.string(settings.mode, 'settings.mode');
} catch (error) {
  if (!(error instanceof ScriptToolError)) throw error;
  // error.options holds the reason, suggestion, and details YMB will print.
}
```

---

## Reading configuration safely

`context.variables` is whatever the YAML said, so validate before using it:

```ts
const settings = context.tools.values.record(context.variables.settings, 'settings');
const enabled = context.tools.values.boolean(settings.enabled, 'settings.enabled');
const mode = context.tools.values.oneOf(settings.mode, 'settings.mode', ['safe', 'fast']);
```

Available: `record`, `string`, `optionalString`, `boolean`, `stringArray`, `oneOf`,
`positiveInteger`. Each throws a labelled error naming the offending key. Defaults stay
your responsibility — read with `optionalString` and fall back yourself.

---

## Text and cache tools

`context.tools.text`:

- `escapeRegExp(value)` — before building a regex from data
- `describeChanges(before, after)` — the changed ranges, or `budget_exceeded` when the
  edit is too large to describe safely

`context.tools.cache` stores derived JSON between builds:

```ts
const key = await context.tools.cache.createKey({ source, settings });
let analysis = await context.tools.cache.readJson('analysis', key, isAnalysis);
if (!analysis) {
  analysis = analyse(source);
  await context.tools.cache.writeJson('analysis', key, analysis);
}
```

`cache.hash(content)` digests a string or `Uint8Array`, for when a whole source file is
one of those inputs and you would rather key on its digest than on its text.

Rules that matter:

- put **every** input that affects the result into the key
- always pass a real validator to `readJson` — cached shapes go stale
- check `cache.enabled`; it is `false` under `--no-cache`
- store only what you can recompute

---

## Script tests

A test gets the same context plus `script` and `testAbsolutePath`, and returns a report.
Tests run automatically during `validate`, `build`, and `sync`.

```ts
import type { BuildScriptTest } from 'ymb/api';

const test: BuildScriptTest = async (context) => {
  const source = await context.readTarget('GameData/Generated/Gameplay/Units.ndf');
  const found = source.includes('Descriptor_Expected');

  return {
    results: [
      {
        name: 'required descriptor exists',
        status: found ? 'passed' : 'failed',
        reason: found ? undefined : 'Descriptor_Expected is missing from Units.ndf.',
        suggestion: found ? undefined : 'Check whether a WARNO update renamed it.',
      },
    ],
  };
};

export default test;
```

Worth covering:

- the source objects and fields your script depends on
- what happens when an anchor is missing
- empty, smallest, and largest inputs
- that generated IDs and tokens stay stable between runs
- that reused analysis is not shared mutable state

Do not re-implement the script inside its test. Test what the output must look like.

### Before or after the script

By default a test runs **before** the script it belongs to. It sees the game files and
whatever the previous run left behind, and a failure stops the build before generation
spends any time. That suits a test that drives the script's own exports, like the one
above.

Some checks only make sense on the finished run — the output it produced, or a file the
script keeps between runs. Say `when: after` for those:

```yaml
scripts:
  - path: generate-decks.ts
    tests:
      - generate-decks.test.ts # before: the script's own logic
      - path: identity-stores.test.ts
        when: after # after: what this run wrote
```

| Phase              | The test sees                                                   |
| ------------------ | --------------------------------------------------------------- |
| `before` (default) | game files and persistent files as this run found them          |
| `after`            | the same, plus this script's output and the files it just wrote |

An `after` test runs on every build. A `before` test can be answered from cache when
nothing it depends on changed, but an `after` test is a statement about what this run
produced, so it is always made fresh.

---

## Owning part of a file

When your script owns a region of a file rather than the whole thing, use generated
blocks. YMB wraps your content in markers tied to a stable owner id, so the next build
replaces exactly that region and leaves the rest alone.

```ts
const next = context.tools.ndf.upsertGeneratedBlock(existing, rendered, 'my_pack.index');

return {
  targetRelativePath: 'GameData/Generated/Gameplay/Shared.ndf',
  content: next,
  generatedBlockOwnerPaths: ['my_pack.index'],
};
```

Declare every owner path you touch. YMB grants only the ownership you asked for, and
falls back to normal conflict checks for anything outside it.

---

## Rules for well-behaved scripts

- **Deterministic.** Same inputs, same bytes. Sort anything unordered before rendering.
- **Validated.** `assertValid` before returning NDF.
- **Scoped.** Derive output from declared targets, variables, and owned files — nothing else.
- **Public API only.** Import from `ymb/api`; never reach into builder internals.
- **Trusted source.** A script is code that runs on your machine. Only run scripts you trust.

---

## See also

- [Configuration](configuration.md#scripts-and-tests) — registering scripts and tests
- [Variables](template-expressions.md) — what lands in `context.variables`
- [Advanced topics](advanced.md#keeping-large-projects-fast) — performance and caching
