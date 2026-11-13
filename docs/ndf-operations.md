# Unit health and NDF operations

[Docs](README.md) / Lesson 2 · [Previous: your first mod](getting-started.md) · [Next: settings](configuration.md)

Your `first_mod` project already puts its name on WARNO's welcome screen. Keep that feature. Now give one M1A1 Abrams more health, extend the change to two tanks, then try a rule covering every unit.

These lessons use real game data and the same project throughout. You will edit one health patch as the lesson grows.

## Try a complete example

Finish [the first-build guide](getting-started.md) first. You should have `YMB/mods/first_mod/config/ymb.mod.yaml` and the generated welcome-screen patch.

The relevant game file is:

```text
GameData/Generated/Gameplay/TacticalUnits.ndf
```

In the game data used for this guide, `Descriptor_Unit_M1A1_Abrams_US` has `MaxPhysicalDamages = 10`. We will set it to `20`. Despite its name, this field is the unit's damage capacity: its health. It does not change armor or outgoing damage. More HP does not make a shell stop penetrating.

Create `YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml`. Put this **whole file** in it:

```yaml
version: 1
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
        value: ${health}
```

Run this in the [YMB shell](getting-started.md#where-to-type-commands):

```text
build --mod first_mod
```

Open `YMB/.ymb-build/output/GameData/Generated/Gameplay/TacticalUnits.ndf`. Search for `export Descriptor_Unit_M1A1_Abrams_US is`, then its `MaxPhysicalDamages` line. The **active line**, outside YMB's original-value comments, should say `20`.

Check `Descriptor_Unit_M1IP_Abrams_US` too. Its health should still be `10` on the data used here. Your welcome-screen title and localisation files should still appear in the same preview.

### Apply a lesson and try it in WARNO

Each health variant below uses the same commands:

```text
build --mod first_mod
sync --mod first_mod --yes
```

Inspect the preview before syncing. Then run `GenerateMod.bat` in the WARNO mod folder, enable the mod, and check the affected unit in the armory and a fresh skirmish. Use a deck containing the regular M1A1 Abrams; command, recon, and heavy-armor variants have different descriptor names.

YMB's preview is not the compiled mod. Skipping WARNO's compilation step is an excellent way to test yesterday's changes again.

Game updates can change names and values. If a selector stops matching, [find the current object](#finding-the-name-to-select) before changing the patch. Do not edit the generated preview to repair it.

## Modify: change a value

Read the health selector from left to right:

| Part                             | What it selects                         |
| -------------------------------- | --------------------------------------- |
| `Descriptor_Unit_M1A1_Abrams_US` | The regular US M1A1 Abrams descriptor   |
| `ModulesDescriptors`             | Its list of gameplay modules            |
| `[TBaseDamageModuleDescriptor]`  | The damage-capacity module in that list |
| `MaxPhysicalDamages`             | The health value inside the module      |

The field form of `modify` takes `value`. Here `${health}` reads the patch's setting, so changing `health: 20` to `health: 30` changes the result without rewriting the selector. Keep health values as positive integers.

The object form takes `changes`, a map of direct field names to new values. It is useful when several fields belong directly to one named object. The health field is nested inside a module, so the field selector is the precise choice here.

Object modifications can also add `leadingComment` above the object. Use that form for objects whose fields share a line with their header: field-level ownership comments need their own line, and YMB rejects placement that would comment out surrounding NDF.

## forEach: the same operations for every entry in a list

Now give the regular M1A1 and M1IP Abrams `20` HP each.

**Replace the entire contents of the same health patch** with this version. Keep the welcome-screen patch. Do not add a second health patch alongside the first.

```yaml
version: 1
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - forEach:
          - Descriptor_Unit_M1A1_Abrams_US
          - Descriptor_Unit_M1IP_Abrams_US
        as: unit
        do:
          - op: modify
            selector:
              kind: field
              by: path
              value: '${unit}.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages'
            value: ${health}
```

Build again. Both named tanks should show `20`; other unit descriptors should be unchanged. These two units started at `10` in the data used for this guide.

`${unit}` is the current list item. `${unitIndex}` is its zero-based position: `0` for M1A1, `1` for M1IP. The loop expands into two normal `modify` operations, so a missing named unit fails the build.

`forEach` accepts a literal list or a variable resolving to one. Loops can nest, and inner loops can use outer bindings. An empty list runs nothing; a non-list value fails. Expansion is limited to 10,000 operations per target.

## Bulk: change many blocks at once

`forEach` repeats instructions for a list you supply. `bulk` searches for matching objects and applies edits within them. Start with the same two tanks so you can compare the result.

### Match the two named tanks

Replace the whole health patch with:

```yaml
version: 1
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: bulk
        match:
          conditions:
            - on: type
              is: equals
              value: TEntityDescriptor
            - on: name
              is: equals
              value:
                - Descriptor_Unit_M1A1_Abrams_US
                - Descriptor_Unit_M1IP_Abrams_US
        expect:
          minBlocks: 2
        edits:
          - field: MaxPhysicalDamages
            set: ${health}
            minChanges: 2
```

Build and inspect the same two descriptors. The result should match the loop version: `20` HP on each tank, with other units untouched.

The two conditions must both match: the object has the right type **and** one of the exact names. `field: MaxPhysicalDamages` edits that field wherever it appears inside each selected object. Unlike a field selector, a bulk field edit uses the field name, not the full dotted path.

`minBlocks: 2` requires at least two matching objects. `minChanges: 2` requires at least two matching health values to be changed or already equal to the requested value. These are minimums, not a cap on how much a broad rule can change.

### Give every eligible unit 20 HP

For the wider experiment, replace the whole health patch again:

```yaml
version: 1
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: bulk
        match:
          conditions:
            - on: type
              is: equals
              value: TEntityDescriptor
            - on: name
              is: startsWith
              value: Descriptor_Unit_
        expect:
          minBlocks: 1
        edits:
          - field: MaxPhysicalDamages
            set: ${health}
            minChanges: 1
```

This changes `MaxPhysicalDamages` inside every matching unit descriptor in this file. That includes infantry, transports, aircraft, command units, and other variants, not just tanks. A matched object without that field is left unchanged.

The pristine data used to check this guide contained **3,341** matching units with that field. Your game version may differ. Inspect several unrelated units in the preview, including one whose original health was below `10`. They should now all have `20`; unrelated fields should stay the same.

> [!WARNING]
> This is a broad balance experiment. Equal HP does not mean equal survivability, and changing infantry health can interact with squad behavior. Check the result in game before keeping or sharing it. The name prefix is doing the selecting; the minimum count is not an emergency brake.

### Return to one tank before the next lesson

Restore the [first complete patch](#try-a-complete-example), with `health: 20` and the single M1A1 selector. Build again. M1A1 should have `20`; M1IP and other units should return to their original preview values.

If you applied a broader version, sync this restored version and compile again to replace it in WARNO. Continue with [local settings](configuration.md) using this same `first_mod` project. That lesson also includes the complete single-unit patch if you need to reset your starting point.

The rest of this page is reference and optional experiments. You do not need to complete them before moving on.

## Pick an operation

| Change                                         | Operation                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Set a field or direct fields of an object      | [`modify`](#modify-change-a-value)                                  |
| Insert a field, object, or list entry          | [`add`](#add-insert-something-new)                                  |
| Delete a field, object, or list entry          | [`remove`](#remove-delete-something)                                |
| Clone a named block                            | [`copy`](#copy-duplicate-a-block-under-a-new-name)                  |
| Edit objects selected by a rule                | [`bulk`](#bulk-change-many-blocks-at-once)                          |
| Repeat operations for supplied names or values | [`forEach`](#foreach-the-same-operations-for-every-entry-in-a-list) |

Operations run in order. Each operation sees the result of the preceding one.

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

Run these from the YMB shell:

```text
find --mod first_mod --name M1A1_Abrams_US --file GameData/Generated/Gameplay/TacticalUnits.ndf
find --mod first_mod --type TEntityDescriptor --field MaxPhysicalDamages=10 --file GameData/Generated/Gameplay/TacticalUnits.ndf --limit 20
```

Filters combine and match partially without case sensitivity. `--field FieldName=Value` matches a field value. The default search uses files targeted by selected patches; `--file` chooses a specific file. The default limit is 50 matches.

Results give the name, type, and file. Named templates appear too. Copy the full name, including the country and variant suffix. `M1A1_Abrams_US` and `M1A1_Abrams_CMD_US` are separate units.

### Path syntax

| Path                                                                                                 | Meaning                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Descriptor_Unit_M1A1_Abrams_US.ClassNameForDebug`                                                   | A direct field                                        |
| `Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages` | A field in a typed list entry                         |
| `UISpecificOutGameWelcomeDescriptor.Components.[ElementName="MainMenuTitlefirst_mod"].TextSize`      | The starter title, selected by its name               |
| `UISpecificOutGameWelcomeDescriptor.Components.[value=~/UIWelcomeQuitButton]`                        | A list entry containing that reference                |
| `@0.ModulesDescriptors`                                                                              | The list in top-level object 0, if that object has it |

Positions start at zero. `[TBaseDamageModuleDescriptor#1]` would select the second entry of that type. `@type:TypeName.Field` selects a field in the one unnamed top-level object of that type; substitute an actual type from `find`. Prefer a stable name when one exists.

## Add: insert something new

The title generated by `init` is already a working `add` example: it appends a `BUCKTextDescriptor` to the welcome screen's `Components` list. Its fields, frame, and localisation token all come together to make visible text.

For a smaller experiment, open:

```text
mods/first_mod/config/patch/ui/branding/welcome-view/ymb.patch.yaml
```

Append this operation **after the existing title-add operation**, at the same indentation as its `- op: 'add'` line. It belongs in the welcome-screen target, not the health patch:

```yaml
- op: add
  selector:
    kind: field
    by: path
    value: UISpecificOutGameWelcomeDescriptor.Components.[ElementName="MainMenuTitlefirst_mod"].HorizontalFitStyle
  value: ~/FitStyle/FitToContent
```

Build `first_mod`. The title now has an explicit instruction to fit its width to its content. To undo this experiment, remove the appended operation and rebuild; leave the original title-add operation in place.

A top-level `add` uses `value: { $raw: ... }` without a selector. A collection `add` uses a collection selector and a raw NDF entry. Copy a supported shape from the real file, as the starter title does. Adding a field the game type does not support can pass YMB's syntax check and still fail WARNO's compiler.

`position.mode` accepts `start`, `end`, `before`, and `after`; the default is `end`. `before` and `after` need an `anchor`. Top-level anchors name an existing block. Collection anchors match entry text. A missing collection anchor appends; a missing top-level anchor fails. A new object cannot be its own anchor. It has not arrived yet.

Identical blocks or entries are left alone with a warning. A block name already used for different content is a conflict. Object and collection adds accept `leadingComment`; field adds do not.

## Remove: delete something

This optional welcome-screen edit removes the starter title's hover hint while keeping its text. Append it after the original title-add operation in the same welcome patch:

```yaml
- op: remove
  selector:
    kind: field
    by: path
    value: UISpecificOutGameWelcomeDescriptor.Components.[ElementName="MainMenuTitlefirst_mod"].Components.[BUCKSpecificHintableArea]
```

Build and inspect the title's `Components` list: the hint entry should be gone. Remove this appended operation to bring it back on the next build.

Field selectors can delete a field or a selected list entry. Object selectors can delete a whole top-level block. Before deleting a block, check who references it; a dangling reference is not a new feature.

A missing removal target produces a warning because it is already absent. An ambiguous selector still fails. [Bulk list edits](#editing) can remove matching entries from many objects.

## Copy: duplicate a block under a new name

A copied definition needs something to use it. Cloning a unit descriptor alone does not add a selectable unit to a deck: that also involves identities, roster entries, localisation, and other references.

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
    value: FirstModWelcomeDescriptor.Components.[ElementName="MainMenuTitlefirst_mod"].TextSize
  value:
    $string: '60'
```

The copy includes your added title. The second operation makes the actual welcome view use the copy; the third enlarges its title from `"50"` to `"60"`. Build and check all three results before syncing and compiling. Remove these three operations to return to the original welcome container.

`copy` appends its result and renames mentions of the old name inside the copied block. An identical existing copy produces a warning; a different block using the destination name is a conflict.

For descriptors with unique identities, `reidentify: true` assigns deterministic GUIDs to literal `DescriptorId` fields throughout the copied subtree, including anonymous objects. The same source identity, destination, project, patch, and target produce the same GUIDs on rebuild. Other GUID-valued fields and named references keep their values. This option does not create the roster or resource links a new playable unit needs.

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

Bulk text/name/type comparisons are case-sensitive. Exact field comparisons ignore comments and compare scalar values: `'10'` matches numeric `10` and `10.0`, not `100`. Quoted NDF strings compare by their contents. Missing fields match neither `equals` nor `notEquals`. Quote numeric condition values in YAML; this setting takes strings.

`expect.minBlocks` defaults to `1`. YMB also warns if an individual positive condition alternative matches nothing; successful neighboring alternatives cannot hide a typo. Set `expect.minBlocks: 0` only for a rule allowed to find nothing. That also suppresses unmatched-alternative warnings for that operation. Keep optional and required matches in separate rules.

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

A `10`-HP tank becomes `20`; a `6`-HP unit becomes `12`. Only use this inside one of the bulk versions. Bulk multiplication rounds integer fields to the nearest whole number, so fractional multipliers also work for HP. Use [a script](script-tools.md) when different units need different limits or more complex rules. Restore the single-tank patch before following the settings lesson.

`multiply` changes numeric values and preserves integer or decimal style. Non-numeric targets are left alone. Multiplying by `1.0` preserves numeric text without a redundant-value warning; match checks still run.

`minChanges` is a non-negative minimum. Values already equal to a requested setting count toward it. `leadingComment` goes above a changed object. `trailingComment` adds a comment beside numeric or MAP edits, including the original value; it is unsupported on list edits.

For lists, `insert` takes `value` and `position: start` or `end`. Identical entries are not inserted twice. `removeEntry` removes entries matching its text. `setEntry` takes `index` and `value`; the index is zero-based, and negative indexes count from the end. Use the [path syntax](#path-syntax) and real file to identify the list before editing it.

All edits inside one bulk operation see the same input. If they overlap or one needs another's result, use separate bulk operations.

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
| A field already has the requested value           | Warning  |
| An identical block, copy, or entry already exists | Warning  |
| A removal target is already absent                | Warning  |
| A bulk edit reaches only already-correct values   | Warning  |
| A block name exists with different content        | Conflict |
| An exact selector matches several candidates      | Error    |

Warnings point to the authored operation and group repeated findings. Check whether the game changed, an earlier operation already handled it, or the selector is wrong. Remove redundant operations only after confirming the intended result remains.

Rebuilds use saved originals for previously synced files. A multiply rule therefore does not keep doubling health each time you run YMB. A bulk warning about a field absent from every matched object means you should check the field name or narrow the match.

## What a passing build proves

YMB checks paths, NDF syntax, selectors, ownership, and conflicting output. The examples above were built against pristine WARNO data, with unrelated descriptor values checked for changes. WARNO's compiler and an in-game check are still required to verify game types, resources, and gameplay behavior.

Before continuing, restore the original single-tank health patch. If you tried the optional menu operations, remove those appended operations from `mods/first_mod/config/patch/ui/branding/welcome-view/ymb.patch.yaml`. Keep the original `add` operation created by `init`; it supplies the title used in later lessons. If you synced an experiment, sync the restored project and compile again.

Continue with [settings and local overrides](configuration.md) in this same `first_mod` project.
