# Changing NDF Files

NDF is the format WARNO stores its game data in. Instead of copying a whole file and
editing it, you tell YMB **which thing to change** and **what to change it to**.

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

Read that as: _in this file, find `Descriptor_Unit_T80U`'s `FrontArmor`, set it to 7._

> **Why not just copy the file?** A copy freezes everything else in it. The next WARNO
> update silently reverts every fix the developers made. A selector re-finds its target
> in the new file.

---

## Pick your operation

| I want to…                          | Use                                                                 |
| ----------------------------------- | ------------------------------------------------------------------- |
| Change a value                      | [`modify`](#modify-change-a-value)                                  |
| Add something that is not there yet | [`add`](#add-insert-something-new)                                  |
| Delete something                    | [`remove`](#remove-delete-something)                                |
| Duplicate a unit under a new name   | [`copy`](#copy-duplicate-a-block-under-a-new-name)                  |
| Change hundreds of things at once   | [`bulk`](#bulk-change-many-blocks-at-once)                          |
| Repeat operations over a list       | [`forEach`](#foreach-the-same-operations-for-every-entry-in-a-list) |

Operations inside one target run **in order**, and each sees the previous one's result.

---

## Selectors: naming the thing to change

Every exact operation starts by pointing at something — except adding a new top-level
block, which has nothing to point at yet.

| Selector              | Points at                                 | Stability      |
| --------------------- | ----------------------------------------- | -------------- |
| `field` + `path`      | One field's value                         | 🟢 best        |
| `object` + `name`     | A named top-level object                  | 🟢 best        |
| `object` + `match`    | One top-level object, by its field values | 🟢 good        |
| `collection` + `path` | A list, for inserting into                | 🟢 good        |
| `object` + `index`    | A top-level block by position             | 🔴 last resort |

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

> **Selectors never guess.** An ambiguous match is always an error — YMB will not pick
> one of two candidates for you. Zero matches is an error too, except where finding
> nothing is the result the operation wanted; see
> [when the game already says it](#when-the-game-already-says-it).

### Finding the name to select

You cannot select what you cannot name, and the generated files are far too large to
read. `find` searches them for you:

```text
find --name T80U
find --type TAmmunitionDescriptor
find --field Nationalite=USSR
```

Each match prints as `name | type | file`, so the first column pastes straight into a
selector. A block with no name shows as `@type:TypeName` there — the form a
[path](#path-syntax) starts with instead. A `template` in the type column is a reusable
declaration such as `template PylonDepictionCommon [ ModelResource ] is TDepictionDescriptor`;
its name selects it exactly like any other:

```text
Descriptor_Unit_T80U_CMD_SOV | TEntityDescriptor | GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf
PylonDepictionCommon | template | GameData/Gameplay/Gfx/Units/Pylons.ndf
```

Matching is partial and case-insensitive, and the filters combine. By default it searches
the files your patches already target — add `--file GameData/...` to look somewhere else,
and `--limit` to see more than the first 50. It changes nothing.

### Path syntax

Paths walk from a top-level block down into nested data:

```text
Descriptor_Unit_T80U.FrontArmor
@0.DivisionIds
@type:TUISpecificCountriesInfos.CountriesInfos
Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TSupplyModuleDescriptor].SupplyCapacity
InGameMainContainerResource.ForegroundComponents.Components.[UniqueName="barre_du_haut"].HasBackground
Descriptor_Unit_FOB_US.ModulesDescriptors.[value=~/BuildingOrderConfigModuleDescriptor]
```

| Piece             | Means                                                 |
| ----------------- | ----------------------------------------------------- |
| `Name.Field`      | Start at a named top-level object                     |
| `@0`              | Start at an unnamed block by index — avoid if you can |
| `@type:TypeName`  | Start at the one unnamed block of that type           |
| `[TypeName]`      | The list entry of that type                           |
| `[Field="value"]` | The list entry whose field equals that value          |
| `[value=...]`     | A plain list entry equal to that value                |
| `[TypeName#1]`    | The second entry of that type, when several exist     |

**Prefer names, types, and field matches over indexes.** Indexes shift when WARNO adds
anything above your target.

---

## Modify: change a value

Change one field:

```yaml
- op: modify
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.FrontArmor
  value: 7
```

Change several fields on one object at once:

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

Field form needs `value`. Object form needs `changes`, and accepts `leadingComment`.

> **Writing a value the file already holds is not an error.** Usually it means WARNO
> shipped the change, or another patch got there first. The build carries on and reports
> a warning naming the field — one of several cases covered under
> [when the game already says it](#when-the-game-already-says-it).

### When a block is written on one line

Most WARNO files give every field its own line. A few pack a whole block into one:

```ndf
CurrentVideoLogo is template_VideoLogo(VideoFile = 'intro.webm' SubtitleComponent = nil)
```

**Use the object form for these.** It marks the whole block, so it can change any
number of fields at once and keep the line intact.

The field form cannot. It marks the one field it edits, and a marker is a whole line —
written in front of a field that is not first on its line, it would comment out the block
header sitting before it. So YMB stops and tells you to use the object form instead of
producing a file that still parses but no longer says what it did.

---

## Add: insert something new

**A new top-level object.** There is **no selector** — the block does not exist yet, so
there is nothing to select:

```yaml
- op: add
  value:
    $raw: |
      MatrixCostName_Custom is MAP
      [
          (Factory/Logistic, [1, 1, 1]),
      ]
```

That lands at the end of the file. To place it somewhere specific, use `position`, where
`anchor` is the name of an **existing** block to sit beside:

```yaml
- op: add
  position:
    mode: after
    anchor: MatrixCostName_Base # a block already in the file
  value:
    $raw: MatrixCostName_Custom is MAP [ (Factory/Logistic, [1, 1, 1]), ]
```

| `position.mode`   | Puts the block       |
| ----------------- | -------------------- |
| `end` _(default)_ | last in the file     |
| `start`           | first in the file    |
| `before`          | just before `anchor` |
| `after`           | just after `anchor`  |

> **`anchor` is never the block you are adding.** If YMB reports that an anchor block
> was not found, and the name it prints is your new block's own name, delete the
> `position` block — you wanted the default.

Adding a block whose name is already in the file, holding **something else**, is an
error. NDF parses happily with two definitions of one name and the game quietly picks
one, so YMB refuses rather than let that reach you as a mystery in-game.

A block already in the file that **matches what you are adding** is the opposite case:
adding it again could only duplicate it. YMB leaves the file alone and reports a warning.
Comments and layout are ignored in that comparison, so a block YMB itself added on an
earlier run still matches.

**A field that does not exist yet:**

```yaml
- op: add
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.NewField
  value: 5
```

**An entry inside a list:**

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

| `position.mode`   | Puts the entry  |
| ----------------- | --------------- |
| `end` _(default)_ | last            |
| `start`           | first           |
| `before`          | before `anchor` |
| `after`           | after `anchor`  |

`before` and `after` require `anchor`. A collection `anchor` that matches nothing is not
an error the way a missing top-level anchor block is — the entry lands at the end
instead. If an added entry keeps turning up last, check the anchor text against the file.

Inserting an entry the list already holds adds nothing and reports a warning.

Object and collection adds accept `leadingComment`; field adds do not.

---

## Remove: delete something

```yaml
- op: remove
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.ObsoleteField
```

```yaml
- op: remove
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_Obsolete
```

Removing something that is already gone is **not** an error — that is the result the
operation was asking for. The build carries on and reports a warning naming what it could
not find, so a stale `remove` after a WARNO update is something you notice and delete
rather than something that stops you mid-build.

A selector that matches **several** things is still an error. That is a patch that cannot
say what it means, not a game that already agrees with it.

---

## Copy: duplicate a block under a new name

Clone a unit, then edit the clone:

```yaml
- op: copy
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_T80U
  destination:
    name: Descriptor_Unit_T80UM

- op: modify
  selector:
    kind: object
    by: name
    value: Descriptor_Unit_T80UM
  changes:
    FrontArmor: 12
```

The copy lands at the end of the file, and every mention of the old name inside it is
renamed. Copying onto an existing name is a conflict, not an overwrite — unless what is
already there **is** that copy, which is a warning and a file left alone.

---

## Bulk: change many blocks at once

When one rule should touch hundreds of blocks — _"every missile gets 20% more range"_ —
`bulk` matches blocks and edits them together.

Three parts:

1. **`match`** picks the blocks.
2. **`edits`** changes fields, MAP entries, or lists.
3. **`expect` / `minChanges`** fail the build if the rule stops reaching enough data.

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
      trailingComment: My Pack - range increased 20%
      minChanges: 80
    - mapEntry: EVisionRange/Standard
      set: 5000.0
      minChanges: 5
```

> **`expect.minBlocks` and `minChanges` are the safety net.** `minBlocks` is `1` unless
> you raise it, so a rule that stops matching anything already fails the build. Set both
> to the numbers you actually expect and a WARNO update that halves your matches fails
> too, instead of quietly applying to a fraction of what it used to.

`minChanges` is about a rule losing its target, not about how much work it had to do. A
value that is already what the edit writes still counts towards it: the rule found what
it was looking for and had nothing left to change. When that is what keeps an edit under
`minChanges`, the build reports a warning saying how many were already set, and carries
on. An edit that falls short with nothing already set still fails.

**An edit that changes nothing is reported whether or not it set `minChanges`**, because
otherwise the only edits YMB could vouch for are the ones you already thought to guard.
The two reasons read differently, and are fixed differently:

| The warning says                           | It means                                         |
| ------------------------------------------ | ------------------------------------------------ |
| none of the matched blocks have `field: X` | the target name is wrong, or `match` is too wide |
| all targets already hold this value        | the game data caught up; the edit is redundant   |

The same holds one level up: when every operation on a target applies and leaves the file
byte for byte as it was, YMB says so once for the target. That last line only appears when
no operation already explained itself, so one dead target is one warning, not one per
operation — and an operation carrying `expect.minBlocks: 0` is exempt, since it already
said it may reach nothing.

### Matching

`mode` is `all` (default) or `any`. Each condition's `value` takes one string or a list
of alternatives.

| `on`    | Looks at                                             |
| ------- | ---------------------------------------------------- |
| `name`  | The block's name                                     |
| `type`  | The block's type                                     |
| `text`  | The whole block text                                 |
| `field` | The first nested value of the field named by `field` |

`on: field` is the only condition that takes a `field` key, and it needs one:

```yaml
- on: field
  field: Nationalite
  is: contains
  value: USSR
```

| `is`          | Matches when the subject…      |
| ------------- | ------------------------------ |
| `startsWith`  | begins with any supplied value |
| `endsWith`    | ends with any supplied value   |
| `contains`    | contains any supplied value    |
| `notContains` | contains none of them          |

> **A value list is an `or`, so `minBlocks` cannot see a single bad entry.** One misspelled
> name reaches nothing while its neighbours keep the count up. YMB warns for any value in a
> `startsWith`, `endsWith`, or `contains` condition that no block in the file matched, and
> names it. A `notContains` value is never reported — matching nothing is what it is for.
>
> Set `expect.minBlocks: 0` when a pass is genuinely allowed to match nothing, such as one
> reaching blocks another mod contributes only when it happens to be layered. That turns
> the warning off for the whole operation, so keep those values in an operation of their
> own rather than mixing them with ones you expect to match.

### Editing

Each edit has exactly one target and one action:

| Target     | Actions                             | Applies to                           |
| ---------- | ----------------------------------- | ------------------------------------ |
| `field`    | `set`, `multiply`                   | every nested field with that name    |
| `mapEntry` | `set`, `multiply`                   | every MAP tuple with that exact key  |
| `list`     | `insert`, `removeEntry`, `setEntry` | the first nested list with that name |

`multiply` only touches numbers, keeps integer or decimal style, and leaves anything
non-numeric alone. `trailingComment` records the original value in a `//` note beside the
change, and belongs to `field` and `mapEntry` edits only.

Both comment keys say where the comment lands: `leadingComment` goes on its own line above
what the operation wrote, `trailingComment` goes after the value it changed.

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
      index: -1 # negative counts back from the end
      value: 3
```

Insertion is idempotent — an identical entry is never added twice — and `insert.position`
is `start` or `end`. `removeEntry` drops every entry matching the text you give it, and
`setEntry` uses a zero-based index.

### One rule at a time

All edits in one `bulk` see the same original block. Overlapping edits are rejected. If
one edit must consume another's result, put it in a **later** `bulk` operation.

---

## forEach: the same operations for every entry in a list

When one block of operations differs only by a name, write it once:

```yaml
variables:
  roles: [Swarm, Breaker, Stalker]

targets:
  - file: GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf
    operations:
      - forEach: ${roles}
        as: role
        do:
          - op: copy
            selector: { kind: object, by: name, value: Descriptor_Unit_Template }
            destination: { name: Descriptor_Unit_${role} }
          - op: modify
            selector: { kind: object, by: name, value: Descriptor_Unit_${role} }
            changes:
              Name: { $string: '${role}' }
```

That expands to six operations, in list order, exactly as if you had typed them out.

| Field     | Means                                        |
| --------- | -------------------------------------------- |
| `forEach` | A list, or a variable holding one.           |
| `as`      | The name each entry is bound to inside `do`. |
| `do`      | The operations to repeat. At least one.      |

Two variables exist inside `do`: **`${role}`** (whatever you named in `as`) and
**`${roleIndex}`**, its position starting at `0`.

### Rules worth knowing

- **Loops nest.** An inner `forEach` can use the outer binding.
- **Order is preserved.** Operations before and after the loop stay where they are, and
  each expanded operation still sees the previous one's result.
- **An empty list expands to nothing.** That is not an error.
- **`forEach` must resolve to a list.** A scalar, or a variable name you mistyped, stops
  the build and says so — it never silently expands zero times.
- **One target may not expand past 10,000 operations.** A loop over the wrong variable
  fails loudly instead of appearing to hang.

> **Reach for [`bulk`](#bulk-change-many-blocks-at-once) instead when you are matching
> blocks by pattern.** `forEach` is for a list you wrote down; `bulk` is for "everything
> that looks like this".

---

## Writing values

| You write                    | YMB emits                            |
| ---------------------------- | ------------------------------------ |
| `7`, `2.5`, `true`           | NDF number or `True`                 |
| `PACT`, `~/Foo`, `$/Gfx/Bar` | unquoted — it looks like a reference |
| `Some text`                  | quoted                               |
| `{ $string: Infantry }`      | quoted, always                       |
| `{ $raw: '...' }`            | exactly what you wrote               |

YMB picks the quote style that needs no escaping, and falls back to backslash escaping
when a value contains both `'` and `"`. Backslashes in a quoted value are always
escaped, so a Windows-style path keeps its closing quote.

```yaml
changes:
  Faction: PACT # unquoted reference
  Name:
    $string: Infantry # forced string
  ModulesDescriptors:
    $raw: | # raw NDF
      [
          ~/Original,
          TSupplyModuleDescriptor(SupplyCapacity = 2000000.0)
      ]
```

Prefer normal values. Reach for `$raw` only when you need real NDF syntax — YMB cannot
check inside it beyond confirming the file still parses.

---

## Operation shapes at a glance

| Shape            | Required                  | Optional                     |
| ---------------- | ------------------------- | ---------------------------- |
| `copy`           | `selector`, `destination` | `leadingComment`             |
| object `modify`  | `selector`, `changes`     | `leadingComment`             |
| field `modify`   | `selector`, `value`       | —                            |
| top-level `add`  | `value` (**no selector**) | `position`, `leadingComment` |
| collection `add` | `selector`, `value`       | `position`, `leadingComment` |
| field `add`      | `selector`, `value`       | —                            |
| object `remove`  | `selector`                | `leadingComment`             |
| field `remove`   | `selector`                | —                            |
| `bulk`           | `match`, `edits`          | `expect`, `leadingComment`   |
| `forEach`        | `forEach`, `as`, `do`     | —                            |

Unknown or misplaced keys are errors, so a typo fails loudly.

---

## What gets checked

On every `validate` and `build`:

- target paths stay under `GameData` or `CommonData`
- the file parses as NDF **before** your changes
- every selector resolves to no more than one thing
- no `add` creates a second block of an existing name
- the result parses as NDF **after** your changes
- no two patches produce conflicting output

---

## When the game already says it

An operation can turn out to have nothing left to do. WARNO ships the value you were
setting, retires the block you were deleting, or another patch in the build gets there
first. None of that is a broken patch, so none of it stops the build:

| The operation wanted               | And found                            | Result     |
| ---------------------------------- | ------------------------------------ | ---------- |
| a field set to a value             | that value already there             | ⚠️ warning |
| a block, entry, or copy added      | exactly that already there           | ⚠️ warning |
| a block, field, or entry removed   | nothing to remove                    | ⚠️ warning |
| a `bulk` edit meeting `minChanges` | the shortfall already at the value   | ⚠️ warning |
| a block added                      | that name holding **something else** | ❌ error   |
| a selector resolving to one thing  | **several** things                   | ❌ error   |

The run's details group these by the fix they share, so the advice is written once no
matter how many operations earned it, and each one is listed under it with its patch, the
`ymb.patch.yaml` line it was written on, and what it found:

```text
warning  3 patch operations: Delete the operation if it is finished, or set the value you actually want.
           my_pack.armor  my_pack/config/patch/armor/ymb.patch.yaml:41  `Descriptor_Unit_T80U.FrontArmor` is already `5`, so this operation changed nothing.
           my_pack.armor  my_pack/config/patch/armor/ymb.patch.yaml:48  `Descriptor_Unit_T80U.Availability` is already `2`, so this operation changed nothing.
           my_pack.speed  my_pack/config/patch/speed/ymb.patch.yaml:12  `Descriptor_Unit_T80U.MaxSpeed` is already `60`, so this operation changed nothing.
```

When many of them found the _same_ thing, that sentence is written once too, with a count
and the list of what it applies to underneath:

```text
note     12 marker preview targets: Preview output will not show in-file ownership markers for this file.
           11x Binary output; YMB cannot embed in-file comment markers.
             GameData/Assets/2D/Interface/Common/UnitsIcons/NATO/my-icon.png
             ...
           GameData/Localisation/my_pack/INTERFACE.csv  This file type does not support YMB comment markers.
```

The summary counts them. Open the line and delete the operation.

> **This is always judged against the untouched game file.** A patch YMB already synced
> never makes its own operations look finished: YMB keeps the original bytes of every
> tracked file and rebuilds from those, so the second `build` sees exactly what the first
> one did. A warning here means the **game** already says it, not that you ran YMB twice.

---

## See also

- [Configuration](configuration.md#ndf-targets) — where targets are declared
- [Variables](template-expressions.md) — reuse values across operations
- [Advanced topics](advanced.md#multiple-contributors-to-one-file) — when two mods edit one file
