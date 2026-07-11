# Script Tools Reference

This document covers builder-provided utilities exposed to scripts through the `context.tools` namespace.

Use this reference when you already know how to register and run a script and want the reusable APIs that YMB injects for you.

## Scope

`context.tools` is the builder-owned namespace for script helpers.

Why it exists:

- to give scripts stable reusable utilities without importing internal builder modules directly
- to keep patch internals private while still exposing safe helpers
- to provide one place for future tool families beyond NDF helpers

Today, the first built-in namespace is `context.tools.ndf`.

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

`context.tools.ndf` exposes helpers for scanning, reading, validating, and formatting NDF text, plus one deliberately narrow mutation helper for appending collection entries.

`apiVersion` is `2`. Read it to feature-detect the helpers below before calling them.

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
- `listGeneratedBlocks(text)`
- `stripGeneratedBlocks(text)`
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

## Comments

`findFieldWithComment(blockText, fieldName)` is a comment-aware field read. It returns the usual field range with `valueText` holding only the code (the trailing `// comment` removed), plus `trailingComment` when one is present. Slashes inside strings are not treated as comments.

```ts
const field = context.tools.ndf.findFieldWithComment(blockText, 'FrontArmor');
if (field?.trailingComment === 'ysm-ignore') {
  // honor the directive
}
```

## Generated Blocks

`listGeneratedBlocks(text)` returns the YMB generated blocks in a file — each with `id`, `innerText`, `fullText`, optional `sourcePath`, and offsets. `stripGeneratedBlocks(text)` returns the file with those blocks removed. Use these instead of hand-rolled marker regexes so your script stays aligned with the builder's marker format.

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

This is the only mutation helper. It does not wrap entries in ownership markers and does not touch other contributors' content — it is for a script editing its own generated output, not for patching foreign blocks.

## Formatting Helpers

`formatValue(value)` renders a JS value as NDF text.

`stripComments(text)` removes line comments while preserving string content.

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

The helpers are read-only except for `insertIntoCollection`, which is a single narrow, ownership-safe append.

They do not expose:

- patch application against foreign blocks
- marker generation or ownership tagging
- conflict resolution
- arbitrary field/object mutation, removal, or copying

Structural edits to content a script does not own stay in the patch engine, where ownership markers and conflict detection apply. That boundary keeps script tooling stable and makes future builder-provided tool namespaces easier to extend safely.
