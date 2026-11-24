# NDF selectors and operations

[All documentation](../README.md#reference)

| Previous | You are here | Next |
| --- | --- | --- |
| [Configuration and API reference](../README.md#reference) | Reference · 1/7 · NDF selectors and operations | [Project files, settings, and assets](configuration.md) |

For a complete patch you can play, start with [unit health](../learn/02-unit-health.md).

| You need to… | Go to |
| --- | --- |
| Choose an action | [Operations](#pick-an-operation), [required keys](#operation-shapes-at-a-glance), [modify and loops](#modify-repeat-or-match) |
| Locate a target | [Selectors](#selectors-naming-the-thing-to-change), [search](#finding-the-name-to-select), [paths](#path-syntax) |
| Write a bulk rule | [Matching](#matching), [edits](#editing) |
| Check values or results | [Value types](#writing-values), [no-change findings](#when-the-game-already-says-it), [validation limits](#what-a-passing-build-proves) |

## Pick an operation

| Change                                         | Operation                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Set a field or direct fields of an object      | [`modify`](../learn/02-unit-health.md#modify-change-a-value)                                  |
| Insert a field, object, or list entry          | [`add`](#add-insert-something-new)                                  |
| Delete a field, object, or list entry          | [`remove`](#remove-delete-something)                                |
| Clone a named block                            | [`copy`](#copy-duplicate-a-block-under-a-new-name)                  |
| Edit objects selected by a rule                | [`bulk`](../learn/02-unit-health.md#bulk-change-many-blocks-at-once)                          |
| Repeat operations for supplied names or values | [`forEach`](../learn/02-unit-health.md#foreach-the-same-operations-for-every-entry-in-a-list) |

Operations run in order. Each operation sees the result of the preceding one.

## Modify, repeat, or match

| Form | Input and behavior |
| --- | --- |
| Field `modify` | Selector and `value` |
| Object `modify` | Selector and `changes`, a map of direct fields |
| `forEach` | Expand `do` for each item; bind the named variable and its zero-based `Index` companion |
| `bulk` | Match objects by conditions, then edit inside them |

Use [lesson 2](../learn/02-unit-health.md) for complete versions of each patch.

## Selectors: naming the thing to change

| Selector                                                                                           | Finds                                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `{ kind: object, by: name, value: Descriptor_Unit_M1A1_Abrams_US }`                                | One named top-level block               |
| `{ kind: object, by: match, where: { ClassNameForDebug: Unit_M1A1_Abrams_US } }`                   | A top-level object with matching fields |
| `{ kind: object, by: index, value: 0 }`                                                            | A top-level object by position          |
| `{ kind: field, by: path, value: UISpecificOutGameWelcomeViewDescriptor.MainComponentDescriptor }` | One field                               |
| `{ kind: collection, by: path, value: UISpecificOutGameWelcomeDescriptor.Components }`             | A list to insert into                   |

Use selectors in the file that contains their object: the unit examples use `TacticalUnits.ndf`; the welcome examples use `GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf`.

Prefer names and field matches. Indexes can move when the game inserts an earlier object. An exact selector matching several objects fails; YMB cannot decide which one you meant.

### Finding the name to select

Run these from the PowerShell terminal in YMB/:

```text
.\YMB.exe find --mod first_mod --name M1A1_Abrams_US --file GameData/Generated/Gameplay/TacticalUnits.ndf
.\YMB.exe find --mod first_mod --type TEntityDescriptor --field ClassNameForDebug=Unit_M1A1 --file GameData/Generated/Gameplay/TacticalUnits.ndf --limit 20
```

| Search rule | Behavior |
| --- | --- |
| Filters | Combine; partial matches ignore case |
| `--field FieldName=Value` | Direct fields only; cannot reach health inside a module |
| Files | Selected patches' targets by default; `--file` chooses one |
| Results | Name, type, and file for top-level objects; template roots excluded |
| Default limit | 50 matches |

Copy the full name, country and variant suffix included. `M1A1_Abrams_US` and `M1A1_Abrams_CMD_US` are different units. The command tank will not accept the regular tank's homework.

### Path syntax

| Path                                                                                                 | Meaning                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Descriptor_Unit_M1A1_Abrams_US.ClassNameForDebug`                                                   | A direct field                                        |
| `Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages` | A field in a typed list entry                         |
| `UISpecificOutGameWelcomeDescriptor.Components.[ElementName="YmbTitlefirst_mod"].TextSize`      | The starter title, selected by its name               |
| `UISpecificOutGameWelcomeDescriptor.Components.[value=~/UIWelcomeQuitButton]`                        | A list entry containing that reference                |
| `@0.ModulesDescriptors`                                                                              | The list in top-level object 0, if that object has it |

Positions start at zero. `[TBaseDamageModuleDescriptor#1]` would select the second entry of that type. `@type:TypeName.Field` selects a field in the one unnamed top-level object of that type; substitute an actual type from `find`. Prefer a stable name when one exists.

Nested predicates can select through another entry: `[Modules.[TModule#0].Name=~/Example]`. An occurrence suffix belongs to its own typed selector. Equals signs and hash characters inside nested paths or quoted values keep their meaning.

## Add: insert something new

| Add form | Shape |
| --- | --- |
| Top-level object | `value: { $raw: ... }`, no selector |
| Collection entry | Collection selector and raw NDF entry |
| Field | Field selector and `value` |

Copy a supported NDF shape from the real file. A field the game type does not support can pass YMB syntax checks and fail WARNO compilation.

| `position.mode` | Placement |
| --- | --- |
| `end` | Default; append |
| `start` | Prepend |
| `before`, `after` | Require an `anchor`: a block name at top level, entry text in a collection |

Missing or ambiguous anchors fail. A collection anchor must identify one entry. A new object cannot anchor itself.

Identical blocks or entries stay unchanged and report `W8`. An addition mixing existing and new entries fails; add only the missing entries. Empty additions also fail. A block name with different content is a conflict. Object and collection adds accept `leadingComment`; field adds do not.

<details>
<summary>Example: add a layout field to the starter title</summary>

The starter's `add` appends a complete `BUCKTextDescriptor` to the welcome screen's `Components` list, with its frame and localisation token.

For a runnable experiment, use [lesson 5](../learn/05-menu-and-assets.md#add-a-field). The operation below belongs in this welcome patch:

```text
mods/first_mod/config/patch/welcome/ymb.patch.yaml
```

Append it after the existing title-add operation in the commented YAML starter, at the same indentation.

```yaml
- op: add
  selector:
    kind: field
    by: path
    value: UISpecificOutGameWelcomeDescriptor.Components.[ElementName="YmbTitlefirst_mod"].HorizontalFitStyle
  value: ~/FitStyle/FitToContent
```

Build `first_mod`. The title now has an explicit instruction to fit its width to its content. To undo this experiment, remove the appended operation and rebuild; leave the original title-add operation in place.

</details>

## Remove: delete something

Field selectors remove fields or selected list entries. Object selectors remove top-level blocks. Check incoming references before deleting a block; a dangling reference is not a new feature.

A missing removal target produces `W9`; the command can still complete, so review its warnings. Ambiguous selectors fail. [Bulk list edits](#editing) remove matching entries from many objects.

<details>
<summary>Example: remove the title's hover hint</summary>

This optional welcome-screen edit removes the starter title's hover hint while keeping its text. Append it after the original title-add operation in the same welcome patch:

```yaml
- op: remove
  selector:
    kind: field
    by: path
    value: UISpecificOutGameWelcomeDescriptor.Components.[ElementName="YmbTitlefirst_mod"].Components.[BUCKSpecificHintableArea]
```

Build and inspect the title's `Components` list: the hint entry should be gone. Remove this appended operation to bring it back on the next build.

</details>

## Copy: duplicate a block under a new name

`copy` appends a renamed block and updates mentions of the old name inside it. An identical destination produces `W8`; different content using that name conflicts.

A copied definition needs something to reference it. A selectable unit also needs identities, roster entries, localisation, and other links.

### Identity when copying descriptors

`reidentify: true` assigns deterministic GUIDs to literal `DescriptorId` fields throughout the copied subtree, including anonymous objects.

- The same source identity, destination, project, patch, and target produce the same GUIDs on rebuild.
- Other GUID fields and named references keep their values.
- Roster and resource links still need to be created for a playable unit.

<details>
<summary>Example: copy a welcome container and make the screen use it</summary>

Try a complete copy on the welcome screen instead. Starting with its original title-add operation, append these three operations to the same welcome patch:

```yaml
- op: copy
  selector:
    kind: object
    by: name
    value: UISpecificOutGameWelcomeDescriptor
  destination:
    name: FirstModWelcomeDescriptor
- op: modify
  selector:
    kind: field
    by: path
    value: UISpecificOutGameWelcomeViewDescriptor.MainComponentDescriptor
  value: ~/FirstModWelcomeDescriptor
- op: modify
  selector:
    kind: field
    by: path
    value: FirstModWelcomeDescriptor.Components.[ElementName="YmbTitlefirst_mod"].TextSize
  value:
    $string: '60'
```

The copy includes your added title. The second operation makes the actual welcome view use the copy; the third enlarges its title from `"50"` to `"60"`. Build and check all three results before syncing and compiling. Remove these three operations to return to the original welcome container.

</details>

## Matching

Bulk candidates are top-level blocks by default. `recursive: true` also considers typed objects inside fields and lists. Match a specific type so a parent and its child are not both selected; overlapping candidates fail.

`match.mode` is `all` by default, or `any`. Each condition's `value` is a string or a list of alternatives.

| `on`    | Subject                                          |
| ------- | ------------------------------------------------ |
| `name`  | Block name                                       |
| `type`  | Block type                                       |
| `text`  | Complete block text                              |
| `field` | First nested value of the field named by `field` |

For example, this condition matches units whose first `MaxPhysicalDamages` value is `10`. Add it to a bulk rule's `conditions` list to narrow that rule:

```yaml
- on: field
  field: MaxPhysicalDamages
  is: equals
  value: '10'
```

| `is`                                 | Matches                              |
| ------------------------------------ | ------------------------------------ |
| `startsWith`, `endsWith`, `contains` | Any supplied alternative             |
| `equals`                             | Any complete supplied value          |
| `notContains`                        | None of the supplied fragments       |
| `notEquals`                          | None of the supplied complete values |

### Comparison rules

| Compared value | Rule |
| --- | --- |
| Text, name, type | Case-sensitive |
| Exact scalar field | Ignore comments; `'10'` matches numeric `10` and `10.0`, not `100` |
| Quoted NDF string | Compare its contents |
| Missing field | Matches neither `equals` nor `notEquals` |
| List field | `is: hasEntry` or `is: lacksEntry`; compare NDF values, ignoring quote style, comments, and optional final commas |

Quote numeric condition values in YAML: conditions take strings. List conditions inspect only the selected field; cargo tags do not classify the vehicle carrying them.

### Expected matches

`expect.minBlocks` defaults to `1`. A positive condition alternative matching nothing also produces an ineffective-operation finding. A working neighboring name cannot hide a typo.

Use `expect.minBlocks: 0` only when finding nothing is acceptable. It also suppresses unmatched-alternative findings for that operation. Keep required and optional matches in separate rules.

## Editing

Each bulk edit has one target and one action:

| Target     | Actions                             | Scope within each matched object |
| ---------- | ----------------------------------- | -------------------------------- |
| `field`    | `set`, `multiply`                   | Every nested field of that name  |
| `mapEntry` | `set`, `multiply`                   | MAP tuples with that exact key   |
| `list`     | `insert`, `removeEntry`, `setEntry` | First nested list of that name   |

To double original health instead of setting every value to `20`, replace the health rule's `edits` list with:

```yaml
edits:
  - field: MaxPhysicalDamages
    multiply: 2
    minChanges: 1
```

A `10`-HP tank becomes `20`; a `6`-HP unit becomes `12`. Only use this inside one of the bulk versions. Bulk multiplication rounds integer fields to the nearest whole number, so fractional multipliers also work for HP. Use [a generator](generators.md) when different units need different limits or more complex rules. Restore the single-tank patch before following the settings lesson.

### Numbers, counts, and comments

| Setting or value | Behavior |
| --- | --- |
| Integer multiplication | Round to nearest whole number |
| Fixed decimal multiplication | Keep original precision, bounded to one through six decimal places |
| Exponent notation | Keep the calculated value without fixed-decimal rounding |
| Non-numeric target | Leave unchanged |
| Multiply by `1.0` | Preserve numeric text; no redundant-value finding, but match checks still run |
| `minChanges` | Non-negative minimum; already-equal values count |
| `leadingComment` | Above a changed object |
| `trailingComment` | Beside numeric or MAP edits, including the original value; unsupported on lists |

### List actions

| Action | Input and behavior |
| --- | --- |
| `insert` | `value` and `position: start` or `end`; identical entries are not inserted twice |
| `removeEntry` | Remove entries matching its text |
| `setEntry` | `index` and `value`; zero-based index, with negative indexes counting from the end |

Identify the list using the [path syntax](#path-syntax) and real file before editing it.

Edits to the same list run in their declared order: removing an entry, inserting
another, then setting its last entry can share one bulk operation. Scalar and
MAP edits use the original matched object. Overlapping scalar edits, or editing
a list both as a whole field and through list actions, fail; use separate bulk
operations for those dependencies.

## Writing values

| YAML value                                                           | NDF output                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `20`, `1.5`                                                          | Numbers                                                |
| `true`, `false`                                                      | `True`, `False`                                        |
| `~/FirstModWelcomeDescriptor`                                        | A reference                                            |
| `My First Mod`                                                       | A quoted string                                        |
| `{ $string: '60' }`                                                  | A quoted string, even though the contents look numeric |
| `{ $raw: 'TUIFramePropertyRTTI(RelativeWidthHeight = [1.0, 1.0])' }` | Literal NDF                                            |

Use `$string` when the game expects text, such as the title's `TextSize`. Use `$raw` for an NDF structure such as its `ComponentFrame`. Follow the field's existing type; a syntactically valid value can still be wrong for WARNO.

String formatting chooses a usable quote style and escapes backslashes and embedded quotes as needed. Bare token-like words may be emitted as references; use `$string` when you mean literal text.

## Operation shapes at a glance

| Operation        | Required                           | Optional                                |
| ---------------- | ---------------------------------- | --------------------------------------- |
| `copy`           | Object `selector`, `destination`   | `leadingComment`, `reidentify`          |
| Object `modify`  | Object `selector`, `changes`       | `leadingComment`                        |
| Field `modify`   | Field `selector`, `value`          | None                                    |
| Top-level `add`  | Raw `value`, no selector           | `position`, `leadingComment`            |
| Collection `add` | Collection `selector`, raw `value` | `position`, `leadingComment`            |
| Field `add`      | Field `selector`, `value`          | None                                    |
| Object `remove`  | Object `selector`                  | `leadingComment`                        |
| Field `remove`   | Field `selector`                   | None                                    |
| `bulk`           | `match`, `edits`                   | `expect`, `leadingComment`, `recursive` |
| `forEach`        | `forEach`, `as`, `do`              | None                                    |

## When the game already says it

| Situation                                         | Result   |
| ------------------------------------------------- | -------- |
| A field already has the requested value           | Error finding |
| An identical block, copy, or entry already exists | Error finding |
| A removal target is already absent                | Error finding |
| A bulk edit reaches only already-correct values   | Error finding |
| A block name exists with different content        | Conflict |
| An exact selector matches several candidates      | Error    |

No-change findings point to the authored operation and group repeats. They can appear in a completed command. Check the intended result before removing a redundant operation: the game may have changed, an earlier operation may have handled it, or the selector may be wrong.

Use `allowNoChange` with a specific reason for an expected no-op; it becomes `I4`.

Rebuilds use saved originals for previously synced files. A multiply rule therefore does not keep doubling health each time you run YMB. A bulk finding about a field absent from every matched object means you should check the field name or narrow the match.

## What a passing build proves

YMB checks paths, NDF syntax, selectors, ownership, and conflicting output. WARNO's compiler and an in-game check are still required to verify game types, resources, and gameplay behavior.

Restore the original welcome operations after experiments unless you intend to keep them. Rebuild, sync, and compile to update an experiment already applied.

| Previous | You are here | Next |
| --- | --- | --- |
| [Configuration and API reference](../README.md#reference) | Reference · 1/7 · NDF selectors and operations | [Project files, settings, and assets](configuration.md) |
