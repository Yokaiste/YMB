# Script Tools Reference

This document covers builder-provided utilities exposed to scripts through the `context.tools` namespace.

Use this reference when you already know how to register and run a script and want the reusable APIs that YMB injects for you.

## Scope

`context.tools` is the builder-owned namespace for script helpers.

Why it exists:

- to give scripts stable reusable utilities without importing internal builder modules directly
- to keep patch internals private while still exposing safe helpers
- to keep validation, caching, text inspection, and NDF handling consistent across mods

`context.tools.apiVersion` is `3`. The available namespaces are:

| Namespace | Purpose                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `ndf`     | Parse, validate, inspect, render, and safely update NDF text             |
| `assert`  | Produce structured script failures and run grouped self-checks           |
| `values`  | Strictly validate common configuration values                            |
| `text`    | Escape dynamic regular-expression text and inspect line-level changes    |
| `cache`   | Store integrity-checked JSON derived from script inputs and dependencies |

## Script Context

Every generation script receives a `context` object. Its fields are:

| Field or helper                       | Purpose                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `builder`                             | Resolved YMB, mod, preview, and recovery paths                                    |
| `selection`                           | Current scope, filters, cache mode, and dry-run state                             |
| `mod` / `patch`                       | Discovered source-mod owner and optional patch owner                              |
| `variables`                           | Fully resolved mod and patch template variables                                   |
| `tools`                               | Builder-owned reusable APIs described below                                       |
| `resolvePath(path)`                   | Resolve a path inside the script owner's config/patch root                        |
| `resolveModPath(path)`                | Resolve a path inside the source mod's `config` root                              |
| `readOwnedTextIfExists(path)`         | Read owner-local UTF-8 text, returning `''` when missing                          |
| `writeOwnedTextIfChanged(path, text)` | Atomically update owner-local source text only when changed                       |
| `readModTextIfExists(path)`           | Read source-mod UTF-8 text, returning `''` when missing                           |
| `writeModTextIfChanged(path, text)`   | Atomically update source-mod text only when changed                               |
| `readTarget(path)`                    | Read a text target from generated output, replace input, or the tracked game file |
| `readTargets(paths)`                  | Read multiple text targets concurrently                                           |
| `readBinaryTarget(path)`              | Read a target as `Uint8Array`                                                     |

Target reads use this precedence: already generated output, selected replace input, then the tracked live file/original backup. Game targets must remain under `GameData` or `CommonData`; owner-local paths are checked lexically and physically to prevent escaping through `..`, symlinks, or junctions.

> [!WARNING]
> Generation scripts are trusted code. `validate` and `--dry-run` prevent normal preview/live/recovery writes, but they still execute scripts. The two `write*TextIfChanged` helpers can intentionally update authored source files, caches may be refreshed, and scripts can import normal runtime APIs. Review scripts before running them.

Companion script tests receive the same fields plus `script` and `testAbsolutePath`. Their source-text writes are virtualized so tests do not modify authored files.

## NDF Tools

`context.tools.ndf` exposes helpers for scanning, reading, validating, formatting, and managing script-owned NDF text.

Available helpers:

- `validate(text, pathHint?)`
- `assertValid(text, pathHint?)`
- `findTopLevelBlocks(text)`
- `findNamedBlock(text, name)`
- `findField(blockText, fieldName)`
- `findFieldDeep(blockText, fieldName)`
- `findFieldWithComment(blockText, fieldName)`
- `findCollectionEntries(collectionText)`
- `readField(blockText, fieldName)`
- `readFieldDeep(blockText, fieldName)`
- `readPath(text, path)`
- `extractBody(text)`
- `extractCollection(text)`
- `parseValue(valueText)`
- `parseList(collectionText)`
- `primaryTypeName(typeName)`
- `listGeneratedBlocks(text)`
- `stripGeneratedBlocks(text)`
- `generatedBlockMarkers(ownerId)`
- `renderGeneratedBlock(options)`
- `upsertGeneratedBlock(text, generatedBlock, ownerId)`
- `insertIntoCollection(text, collectionPath, entry, options?)`
- `formatValue(value)`
- `stripComments(text)`

## Validation

`validate(text, pathHint?)` returns a structured result instead of throwing.

```ts
const result = context.tools.ndf.validate(source, 'Decks.ndf');
if (!result.ok) {
  throw new Error(result.error.message);
}
```

Returned shape:

```ts
{
  ok: true;
}
```

or

```ts
{
  ok: false,
  error: {
    category: string,
    message: string,
    absolutePath: string,
    reason: string,
    suggestion: string,
    details: string[],
  },
}
```

`assertValid(text, pathHint?)` is the throwing version for simple script flows.

## Scanning

`findTopLevelBlocks(text)` returns the top-level NDF blocks with their names, type names, raw text, and offsets.

`findNamedBlock(text, name)` resolves one named top-level block.

`findField(blockText, fieldName)` returns the direct field range inside a block:

```ts
const block = context.tools.ndf.findNamedBlock(source, 'Descriptor_Unit_Test');
const field = context.tools.ndf.findField(block?.text ?? '', 'ModulesDescriptors');
```

`findFieldDeep(blockText, fieldName)` returns the first matching field anywhere inside the block, including nested module descriptors:

```ts
const block = context.tools.ndf.findNamedBlock(source, 'Descriptor_Unit_Test');
const motherCountry = context.tools.ndf.findFieldDeep(block?.text ?? '', 'MotherCountry');
```

`findCollectionEntries(collectionText)` splits a collection into bracket-aware entries:

```ts
const entries = context.tools.ndf.findCollectionEntries(field?.valueText ?? '');
```

## Path Reads

`readPath(text, path)` reads nested values from NDF text.

You can pass either a dotted string path or a path segment array.

Examples:

```ts
context.tools.ndf.readPath(blockText, 'DeckName');
context.tools.ndf.readPath(blockText, ['ModulesDescriptors', '[Value=2]', 'Value']);
```

Collection selectors follow the same style as YMB's NDF selector logic:

- `[0]`
- `[index:0]`
- `[type:TModuleFoo]`
- `[Value=2]`

`readField(blockText, fieldName)` / `readFieldDeep(blockText, fieldName)` return a field's raw value text (direct child, or first match at any depth) without building a range object. A scalar value keeps its trailing line comment, if any — use `findFieldWithComment` or `stripComments` when you need the value and comment separated.

`extractBody(text)` returns the range of the first parenthesized `( ... )` body; `extractCollection(text)` returns the first `[ ... ]` collection range. Both give `{ start, end, text }`.

## Value Parsing

`parseValue(valueText)` turns one NDF value into a typed JS value:

```ts
context.tools.ndf.parseValue('7'); // { kind: 'int', value: 7, raw: '7' }
context.tools.ndf.parseValue('True'); // { kind: 'bool', value: true, raw: 'True' }
context.tools.ndf.parseValue("'Infantry'"); // { kind: 'string', value: 'Infantry', ... }
context.tools.ndf.parseValue('~/Descriptor_Unit'); // { kind: 'reference', ... }
```

`kind` is one of `int`, `float`, `bool`, `string`, `reference`, or `raw` (anything the parser does not recognize, returned verbatim). Strip a trailing comment first — `parseValue('5 // note')` is `raw`, not `int`.

`parseList(collectionText)` runs `parseValue` over each entry of a collection or tag list and returns the array.

`primaryTypeName(typeName)` returns the first type token from a top-level block type declaration. Use it instead of duplicating whitespace splitting in scripts.

## Comments

`findFieldWithComment(blockText, fieldName)` is a comment-aware field read. It returns the usual field range with `valueText` holding only the code (the trailing `// comment` removed), plus `trailingComment` when one is present. Slashes inside strings are not treated as comments.

```ts
const field = context.tools.ndf.findFieldWithComment(blockText, 'FrontArmor');
if (field?.trailingComment === 'ysm-ignore') {
  // honor the directive
}
```

## Generated Blocks

`listGeneratedBlocks(text)` returns the YMB generated blocks in a file — each with `id`, `innerText`, `fullText`, optional `sourcePath`, and offsets. `stripGeneratedBlocks(text)` returns the file with those blocks removed.

Use `renderGeneratedBlock({ ownerId, blocks, title?, sourcePath? })` to render a complete owned block, then `upsertGeneratedBlock(text, block, ownerId)` to replace the prior block or append it when absent. `generatedBlockMarkers(ownerId)` returns the canonical start and end markers for specialized embedded sections. These helpers keep scripts aligned with the builder's marker format and make repeated generation idempotent.

## Collection Mutation

`insertIntoCollection(text, collectionPath, entry, options?)` appends one entry to a named collection or `MAP` and returns the updated text.

```ts
const updated = context.tools.ndf.insertIntoCollection(
  source,
  'DivisionRules.DivisionIds',
  { $raw: '(3, "Charlie"),' },
  { position: 'end' },
);
```

- `collectionPath` is a top-level block reference (`Name` or `@<index>`) followed by one or more plain field names.
- `entry` is a raw NDF snippet, as a string or `{ $raw }`.
- `options.position` is `'start'`, `'end'`, `{ before: '<anchor>' }`, or `{ after: '<anchor>' }`.
- The insert is idempotent: if the entry already exists the text is returned unchanged.
- The result is validated before it is returned, so a malformed insert throws instead of writing broken NDF.

Collection insertion does not wrap entries in ownership markers and does not touch other contributors' content. It is for a script editing its own generated output, not for patching foreign blocks.

## Formatting Helpers

`formatValue(value)` renders a JS value as NDF text.

`stripComments(text)` removes line comments while preserving string content.

## Assertions and Self-Checks

`context.tools.assert` turns script failures into YMB errors with a reason, a concrete suggestion, and optional details:

```ts
context.tools.assert.ok(outputs.length > 0, {
  reason: 'The generator produced no outputs.',
  suggestion: 'Check the source filters and generation configuration.',
});
```

Use `textPresent`, `textIncludes`, and `textMatches` for common content checks. `all(checks)` runs named synchronous or asynchronous checks, aggregates their failures, and reports one useful error instead of stopping at the first problem.

## Strict Values

`context.tools.values.positiveInteger(value, label)` accepts a positive safe integer or an equivalent integer string. It rejects fractions, zero, negative values, unsafe integers, and ambiguous coercions. Use it for numeric script configuration instead of maintaining per-mod parsers.

## Text Tools

`context.tools.text.escapeRegExp(value)` safely embeds text in a dynamic regular expression.

`context.tools.text.describeChanges(baseText, nextText)` returns either `{ ok: true, edits }`, where each edit contains zero-based `start` and `end` line offsets, or `{ ok: false, reason: 'budget_exceeded' }` for inputs that exceed the builder's protected diff budget. It is useful in companion tests that must enforce insertion-only or tightly bounded output changes.

## Script Cache

`context.tools.cache` provides dependency-aware, integrity-checked JSON caching:

```ts
const key = await context.tools.cache.createKey({ sourceHash, options });
const cached = await context.tools.cache.readJson('deck-generation', key, isCachedResult);

if (!cached) {
  const result = generateResult();
  await context.tools.cache.writeJson('deck-generation', key, result);
}
```

- `enabled` is false when the command uses `--no-cache`.
- `hash(textOrBytes)` returns the builder's standard content hash.
- `createKey(input)` includes the input, current mod and patch identity, executing script path, and the complete local script import graph. Editing an imported helper therefore invalidates the cache automatically.
- `readJson(namespace, key, validate)` returns `undefined` for a miss, invalid schema, corrupted envelope, or disabled cache.
- `writeJson(namespace, key, value)` writes atomically and does nothing when caching is disabled.

Namespaces and keys are path-safe identifiers. Cached data lives under YMB's build cache and is disposable; persistent mod identity belongs in authored source storage, not in the cache.

## Example

```ts
export default async function generate(context) {
  const source = await context.readTarget('GameData/Generated/Gameplay/Decks/Decks.ndf');
  const block = context.tools.ndf.findNamedBlock(source, 'Descriptor_Deck_Test');
  const deckName = context.tools.ndf.readPath(block?.text ?? '', 'DeckName');

  context.tools.ndf.assertValid(source, 'Decks.ndf');

  return {
    targetRelativePath: 'CommonData/Text/deck-summary.txt',
    content: `Deck name: ${deckName ?? 'missing'}`,
  };
}
```

## Boundaries

The helpers only mutate strings or builder-owned cache files. Generated-block and collection helpers return new text; the caller still decides which script output owns that text.

They do not expose:

- patch application against foreign blocks
- conflict resolution
- arbitrary field/object mutation, removal, or copying

Structural edits to content a script does not own stay in the patch engine, where ownership markers and conflict detection apply. That boundary keeps script tooling stable and makes future builder-provided tool namespaces easier to extend safely.
