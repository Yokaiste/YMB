# NDF Operations

An NDF target contains an ordered list of exact operations (`copy`, `modify`, `add`, and `remove`) and rule-based `bulk` operations:

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

Use the smallest stable selector that describes the intended change.

## Selectors

| Selector              | Use                                                |
| --------------------- | -------------------------------------------------- |
| `field` + `path`      | Select one field value                             |
| `collection` + `path` | Select a collection for insertion                  |
| `object` + `name`     | Select a named top-level object                    |
| `object` + `index`    | Select a top-level block by zero-based index       |
| `object` + `match`    | Select one top-level object by direct field values |

Examples:

```yaml
selector:
  kind: object
  by: name
  value: Descriptor_Unit_T80U
```

```yaml
selector:
  kind: object
  by: match
  where:
    Availability: 2
    Nationalite: USSR
```

A selector must resolve exactly where its operation expects. Zero matches, ambiguous matches, and invalid paths fail validation.

## `modify`

Replace a field value:

```yaml
- op: modify
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.FrontArmor
  value: 7
```

Change direct fields on an object:

```yaml
- op: modify
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_T80U
  changes:
    Availability: 4
    FrontArmor: 9
```

Field modification requires `value`. Object modification requires `changes` and may include `leadingComment`.

## `copy`

Clone an object under a new name:

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

`destination.kind` accepts `sibling` or `name`. A copy may include `leadingComment`. Apply later operations to modify the new object.

## `add`

Add a top-level object:

```yaml
- op: add
  selector:
    kind: object
    by: name
    value: MatrixCostName_Custom
  value:
    $raw: |
      MatrixCostName_Custom is MAP
      [
          (Factory/Logistic, [1, 1, 1]),
      ]
```

Add a missing field:

```yaml
- op: add
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.NewField
  value: 5
```

Insert a collection entry:

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

Collection positions are `start`, `end`, `before`, or `after`. `before` and `after` require `anchor`. If omitted, the position defaults to the end.

Object and collection additions may include `leadingComment`. Field additions may not.

## `remove`

Remove a field:

```yaml
- op: remove
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.ObsoleteField
```

Remove an object:

```yaml
- op: remove
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_Obsolete
```

Object removal may include `leadingComment`. Field removal has no optional operation fields.

## `bulk`

Use `bulk` when one rule must change many top-level blocks. It has three parts:

1. `match` selects blocks.
2. `edits` changes matching fields, MAP entries, or lists.
3. `expect` and `minChanges` stop the build when the rule no longer reaches enough data.

```yaml
- op: bulk
  match:
    mode: all
    conditions:
      - on: type
        is: startsWith
        value: TAmmunitionDescriptor
      - on: name
        is: notContains
        value: [Smoke, Training]
  expect:
    minBlocks: 100
  leadingComment: My Pack - ammunition balance
  edits:
    - field: MaximumRangeGRU
      multiply: 1.2
      comment: My Pack - range increased 20%
      minChanges: 80
    - mapEntry: EVisionRange/Standard
      set: 5000.0
      minChanges: 5
```

`mode` defaults to `all`. Use `any` when one successful condition is enough. Each condition accepts one string or a list of alternatives in `value`.

| `on`    | Compared text                                   |
| ------- | ----------------------------------------------- |
| `name`  | Top-level block name                            |
| `type`  | Top-level block type                            |
| `text`  | Complete block text                             |
| `field` | First nested value of the required `field` name |

| `is`          | Match rule                                      |
| ------------- | ----------------------------------------------- |
| `startsWith`  | Subject begins with at least one supplied value |
| `endsWith`    | Subject ends with at least one supplied value   |
| `contains`    | Subject contains at least one supplied value    |
| `notContains` | Subject contains none of the supplied values    |

Every edit has exactly one target and one compatible action:

| Target     | Actions                             | Behavior                                    |
| ---------- | ----------------------------------- | ------------------------------------------- |
| `field`    | `set`, `multiply`                   | Change every nested field with that name    |
| `mapEntry` | `set`, `multiply`                   | Change every MAP tuple with that exact key  |
| `list`     | `insert`, `removeEntry`, `setEntry` | Change the first nested list with that name |

`set` accepts normal YMB values, including `$raw`. `multiply` accepts a finite number or an exact template expression that resolves to one, changes numeric values, and preserves integer or decimal style; non-numeric target values are left unchanged. A value `comment` is optional and records the original value. Existing comments are preserved.

List actions use these shapes:

```yaml
edits:
  - list: ModulesDescriptors
    insert:
      value: { $raw: TDeploymentShiftModuleDescriptor }
      position: start
  - list: ModulesDescriptors
    removeEntry: ~/FacingInfosModuleDescriptor
  - list: Salves
    setEntry:
      index: -1
      value: 3
```

Insert position is `start` or `end` and defaults to `end`. Insertion is idempotent: an equal entry is not added twice. `removeEntry` compares the complete normalized entry. `setEntry` uses a zero-based index; negative indexes count back from the end.

`expect.minBlocks` defaults to `1`. Set it to the smallest valid number of matching blocks. Each edit can set `minChanges`; use it whenever missing changes would make the mod incomplete. A value change to the value already present does not count. `leadingComment` uses the same normalized `//` comment lines as exact operations, supports multiline text, and is added only to blocks that actually change.

One bulk operation evaluates all edits against the same original matched block. Overlapping edits are rejected. If one edit must consume another edit's result, put it in a later bulk operation.

## Operation shapes

| Shape            | Required                  | Optional                     |
| ---------------- | ------------------------- | ---------------------------- |
| `copy`           | `selector`, `destination` | `leadingComment`             |
| object `modify`  | `selector`, `changes`     | `leadingComment`             |
| field `modify`   | `selector`, `value`       | none                         |
| object `add`     | `selector`, `value`       | `leadingComment`             |
| collection `add` | `selector`, `value`       | `position`, `leadingComment` |
| field `add`      | `selector`, `value`       | none                         |
| object `remove`  | `selector`                | `leadingComment`             |
| field `remove`   | `selector`                | none                         |
| `bulk`           | `match`, `edits`          | `expect`, `leadingComment`   |

Unknown and unused keys are errors.

## Path syntax

```text
Descriptor_Unit_T80U.FrontArmor
@0.DivisionIds
@type:TUISpecificCountriesInfos.CountriesInfos
Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TSupplyModuleDescriptor].SupplyCapacity
InGameMainContainerResource.ForegroundComponents.Components.[UniqueName="barre_du_haut"].HasBackground
Descriptor_Unit_FOB_US.ModulesDescriptors.[value=~/BuildingOrderConfigModuleDescriptor]
```

- `Name.Field` starts from a named top-level object.
- `@0` starts from an unnamed top-level block by index.
- `@type:TypeName` selects an unnamed top-level block by unique type.
- `[TypeName]` selects a collection object by type.
- `[Field="value"]` selects a collection object by a direct field value.
- `[value=...]` selects a scalar collection entry.

Prefer names, unique types, and field matches over indexes.

## Values

Normal YAML numbers and booleans become NDF scalars. Strings that look like NDF identifiers, references, or GUIDs remain unquoted; other strings are quoted.

Use `$string` to force a quoted NDF string:

```yaml
changes:
  Faction: PACT
  Name:
    $string: Infantry
```

Use `$raw` for complete NDF expressions or blocks:

```yaml
changes:
  ModulesDescriptors:
    $raw: |
      [
          ~/Original,
          TSupplyModuleDescriptor(SupplyCapacity = 2000000.0)
      ]
```

Prefer normal values unless raw NDF syntax is required.

## Validation

`validate` and `build` check that target paths remain under `GameData` or `CommonData`, input and output NDF parse correctly, selectors resolve safely, and patches do not create conflicting output. Fix the source configuration rather than editing generated preview files.
