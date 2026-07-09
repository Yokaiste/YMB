# NDF Operations Reference

This page covers the practical NDF patch operations supported inside `ymb.patch.yaml`.

## 🧭 What This Page Is For

YMB is not trying to implement every possible NDF editing pattern. It focuses on the subset that matters most for maintainable WARNO modding:

- targeted edits
- insertions
- removals
- cloning

> [!WARNING]
> Resilience is not magic. If you use `modify` to overwrite massive chunks of NDF code instead of using surgical edits, your mod will still break when the game updates. Keep your patches as small and targeted as possible.

If you keep patches focused and selectors stable, YMB and your AI agents stay much easier to maintain across game updates.

## 🎯 How To Think About a Target

Each target points at one game-relative file and applies one or more operations.

```yaml
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: 7
```

A strong target usually:

- touches one source file
- groups closely related changes
- avoids mixing unrelated gameplay and UI concerns

## ✅ Supported Operations

YMB supports these `op` values:

- `modify`
- `add`
- `remove`
- `copy`

## 🔎 Selector Basics

A selector tells YMB what to operate on.

```yaml
selector:
  kind: field
  by: path
  value: Descriptor_Unit_T80U.FrontArmor
```

### Selector Keys

| Key     | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| `kind`  | Required selector family: `field`, `object`, or `collection`         |
| `by`    | Required lookup mode: `path`, `name`, `match`, or `index`            |
| `value` | Required for `path`, `name`, and `index` selectors                   |
| `where` | Required for `by: match`; maps direct field names to expected values |

### Selector `kind`

| Kind         | Meaning                                     |
| ------------ | ------------------------------------------- |
| `field`      | Target one field value                      |
| `object`     | Target one top-level object or block        |
| `collection` | Target a collection container for insertion |

### Selector `by`

| Mode    | Meaning                                                    |
| ------- | ---------------------------------------------------------- |
| `path`  | Follow a path through fields and collections               |
| `name`  | Match a top-level object by exact name                     |
| `match` | Match a top-level object by direct field values in `where` |
| `index` | Select a top-level block by zero-based index               |

> [!TIP]
> Choose the most stable selector you can. Names and field matches usually survive game updates better than raw indexes.

## ✏ `modify`

Use `modify` when the target already exists and only needs a focused change.

Simple field update:

```yaml
- op: modify
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.FrontArmor
  value: 7
```

Object field rewrite:

```yaml
- op: modify
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_T80UM
  changes:
    Availability: 4
    FrontArmor: 9
```

Rules:

- `modify` must include `value` or `changes`
- `value` replaces the selected field value
- `changes` updates direct fields inside the selected object
- `leadingComment` is supported for object `modify`
- `leadingComment` is not supported for field-path `modify`

## 📋 `copy`

Use `copy` when you want to clone an existing object and then modify the clone with later operations.

```yaml
- op: copy
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_T80U
  destination:
    kind: sibling
    name: Descriptor_Unit_T80UM
```

### Destination Keys

| Key    | Meaning                                         |
| ------ | ----------------------------------------------- |
| `kind` | Destination mode, currently `sibling` or `name` |
| `name` | Required object name for the copied result      |

Rules:

- `copy` requires `destination`
- supported destination kinds are `sibling` and `name`
- `leadingComment` is supported for `copy`

This is often cleaner than rewriting a full descriptor block from scratch.

## 🗑 `remove`

Use `remove` when something already exists and should disappear from the generated result.

```yaml
- op: remove
  selector:
    kind: field
    by: path
    value: InGameMainContainerResource.ForegroundComponents.Components.[UniqueName="barre_du_haut"].HasBackground
```

## ➕ `add`

Use `add` when the new content does not exist yet and should be inserted relative to something stable.

Add a top-level block:

```yaml
- op: add
  selector:
    kind: object
    by: name
    value: MatrixCostName_Base
  value:
    $raw: |
      MatrixCostName_Custom is MAP
      [
          (Factory/Logistic, [1, 1, 1]),
      ]
```

Add a collection entry:

```yaml
- op: add
  selector:
    kind: collection
    by: path
    value: '@0.TimeLimitTable'
  position:
    mode: before
    anchor: '20,'
  value:
    $raw: '5,'
```

Position modes:

- `start`
- `end`
- `before`
- `after`

### Position Keys

| Key      | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| `mode`   | Required insertion mode: `start`, `end`, `before`, or `after` |
| `anchor` | Required when `mode` is `before` or `after`                   |

Rules:

- `before` and `after` require `anchor`
- collection insertion treats the raw snippet as one entry and auto-appends a trailing comma when missing
- `leadingComment` is supported for object `add` and collection-path `add`
- `leadingComment` is not supported for field-path `add`

## 🧾 Operation Key Matrix

Use this as the quick reference for which config keys belong to which operation shapes.

| Shape                 | Required keys                   | Optional keys                | Rejected keys                                          |
| --------------------- | ------------------------------- | ---------------------------- | ------------------------------------------------------ |
| object `add`          | `op`, `selector`, `value`       | `leadingComment`             | `changes`, `destination`, `position`                   |
| collection-path `add` | `op`, `selector`, `value`       | `position`, `leadingComment` | `changes`, `destination`                               |
| field-path `add`      | `op`, `selector`, `value`       | none                         | `changes`, `destination`, `position`, `leadingComment` |
| object `modify`       | `op`, `selector`, `changes`     | `leadingComment`             | `value`, `destination`, `position`                     |
| field-path `modify`   | `op`, `selector`, `value`       | none                         | `changes`, `destination`, `position`, `leadingComment` |
| object `remove`       | `op`, `selector`                | `leadingComment`             | `value`, `changes`, `destination`, `position`          |
| field-path `remove`   | `op`, `selector`                | `leadingComment`             | `value`, `changes`, `destination`, `position`          |
| `copy`                | `op`, `selector`, `destination` | `leadingComment`             | `value`, `changes`, `position`                         |

If a config uses a rejected key or an unsupported selector shape, YMB now fails during config validation with a structured error message.

## 🎯 Match Selectors

`by: match` uses a `where` object and expects exactly one top-level object to match.

```yaml
selector:
  kind: object
  by: match
  where:
    Availability: 2
    Nationalite: USSR
```

If the selector matches zero objects or more than one object, YMB fails with a selector error.

## 🛣 Path Syntax

Practical path selector examples:

Named top-level block:

```text
Descriptor_Unit_T80U.FrontArmor
```

Unnamed top-level block by index:

```text
@0.DivisionIds
```

Collection entry by contained type:

```text
Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TSupplyModuleDescriptor].SupplyCapacity
```

Collection entry by nested field match:

```text
InGameMainContainerResource.ForegroundComponents.Components.[UniqueName="barre_du_haut"].HasBackground
```

## 🧪 Raw Snippets With `$raw`

Use `$raw` when a value should be treated as literal NDF instead of a quoted string or basic scalar.

```yaml
changes:
  DescriptorId: 'GUID:{22222222-2222-2222-2222-222222222222}'
  ModulesDescriptors:
    $raw: |
      [
          ~/Original,
          TSupplyModuleDescriptor
          (
              SupplyCapacity = 2000000.0
          )
      ]
```

Use `$raw` for real NDF-shaped content. Prefer normal scalar values when possible.

## 🔤 String Values and `$string`

Plain YAML strings are rendered with a heuristic: values that look like NDF identifiers, references, or GUIDs (`PACT`, `~/Descriptor_X`, `GUID:{...}`) stay unquoted, everything else becomes a quoted NDF string. When you need an identifier-looking value to be a real NDF _string_ (for example the literal text `Infantry`), force quoting with `$string`:

```yaml
changes:
  Faction: PACT # rendered as the bareword PACT
  Name:
    $string: Infantry # rendered as 'Infantry'
```

## ✅ Validation Behavior

`validate` and `build` both check that:

- the source file exists
- the target path stays inside `GameData/` or `CommonData/`
- the source NDF passes parsing checks
- the selector resolves correctly
- the final generated NDF still parses after patch application

Common error categories include:

- `ConfigError`
- `ParserError`
- `SelectorError`
- `ConflictError`
- `IoError`

## ✅ Best Practices

- keep each patch focused on one file whenever possible
- prefer `copy` plus `modify` for descriptor variants
- use `$raw` for complex NDF literals, not every simple value
- favor stable selectors over positional ones
- run `validate`, `explain`, and `build --dry-run` before `sync --yes`
