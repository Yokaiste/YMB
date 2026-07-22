# Generation Scripts

Use scripts when output must be derived from several inputs or cannot be expressed clearly as NDF operations. Register them in `ymb.mod.yaml` or `ymb.patch.yaml`:

```yaml
scripts:
  - path: generate-output.ts
    tests:
      - generate-output.test.ts
```

Import script contracts from the supported public API:

```ts
import type { BuildScript, GeneratedScriptFile } from 'ymb/api';
```

## Script result

A script exports a default function or named `generate` function and returns one generated file or an array:

```ts
import type { BuildScript, GeneratedScriptFile } from 'ymb/api';

const generate: BuildScript = async (context) => {
  const source = await context.readTarget('GameData/Generated/Gameplay/Units.ndf');
  context.tools.ndf.assertValid(source, 'Units.ndf');

  const output: GeneratedScriptFile = {
    targetRelativePath: 'GameData/Generated/Gameplay/MyPack/Summary.ndf',
    content: source,
  };
  return output;
};

export default generate;
```

`targetRelativePath` must remain under `GameData` or `CommonData`. `content` may be text or `Uint8Array`.

## Context

The context is readonly except for explicit file-writing helpers.

| Member                                                  | Purpose                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `builder`                                               | YMB, WARNO, preview, and recovery paths                         |
| `selection`                                             | Scope, filters, cache, dry-run, and verbose settings            |
| `mod`                                                   | Owning source-mod information                                   |
| `patch`                                                 | Owning patch information, when the script belongs to a patch    |
| `variables`                                             | Resolved source-mod and patch variables                         |
| `resolvePath()`                                         | Resolve a path inside the owning configuration root             |
| `resolveModPath()`                                      | Resolve a path inside the owning source mod                     |
| `readTarget()`                                          | Read one selected WARNO or earlier generated text target        |
| `readTargets()`                                         | Read several text targets                                       |
| `readBinaryTarget()`                                    | Read one binary target                                          |
| `readOwnedTextIfExists()` / `writeOwnedTextIfChanged()` | Read or update an authored file owned by the configuration root |
| `readModTextIfExists()` / `writeModTextIfChanged()`     | Read or update an authored file owned by the source mod         |

Scripts run in configured order. A later script may read output produced earlier in the same build.

## NDF tools

`context.tools.ndf` provides:

- validation: `validate`, `assertValid`
- top-level blocks: `findTopLevelBlocks`, `findNamedBlock`
- fields: `findField`, `findFieldDeep`, `findFieldWithComment`, `readField`, `readFields`, `readFieldDeep`, `readFieldsDeep`
- paths and values: `readPath`, `parseValue`, `parseList`, `primaryTypeName`
- collections: `findCollectionEntries`, `extractCollection`, `insertIntoCollection`
- object bodies: `extractBody`
- generated blocks: `listGeneratedBlocks`, `stripGeneratedBlocks`, `generatedBlockMarkers`, `renderGeneratedBlock`, `upsertGeneratedBlock`
- formatting: `formatValue`, `stripComments`

Use these tools instead of duplicating NDF parsing or generated-block marker logic.

## Assertions

`context.tools.assert` creates structured failures:

```ts
context.tools.assert.textIncludes(source, 'Descriptor_Expected', {
  reason: 'The expected descriptor is missing.',
  suggestion: 'Update the source data or selector.',
});
```

Available helpers:

- `ok`
- `textPresent`
- `textIncludes`
- `textMatches`
- `all` for named synchronous or asynchronous checks

## Configuration values

Use `context.tools.values` to validate unknown configuration values:

```ts
const settings = context.tools.values.record(context.variables.settings, 'settings');
const enabled = context.tools.values.boolean(settings.enabled, 'settings.enabled');
const mode = context.tools.values.oneOf(settings.mode, 'settings.mode', ['safe', 'fast']);
```

Helpers:

- `record`
- `string`
- `optionalString`
- `boolean`
- `stringArray`
- `oneOf`
- `positiveInteger`

Defaults remain the script's responsibility.

## Text and cache tools

`context.tools.text.escapeRegExp()` escapes dynamic regular-expression text. `describeChanges()` reports changed ranges or a protected diff-budget failure.

`context.tools.cache` stores disposable derived JSON:

```ts
const key = await context.tools.cache.createKey({ source, settings });
const cached = await context.tools.cache.readJson('analysis', key, isAnalysis);
if (!cached) {
  await context.tools.cache.writeJson('analysis', key, analysis);
}
```

Always validate cached data. Never store persistent IDs or authored state in the disposable cache.

## Script tests

Tests receive a `BuildScriptTestContext` and return a report:

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
        reason: found ? undefined : 'Descriptor_Expected is missing.',
        suggestion: found ? undefined : 'Update the parser or source-data requirement.',
      },
    ],
  };
};

export default test;
```

Tests run during `validate`, `build`, and `sync`. Cover parsing assumptions, missing anchors, invalid configuration, generated output, and important boundary cases.

## Safety

- Only run scripts you trust.
- Keep output deterministic for the same inputs.
- Validate generated NDF before returning it.
- Keep persistent authored data outside disposable caches and previews.
- Prefer builder tools over custom parsing and marker implementations.
