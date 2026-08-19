# Configuration

Everything you can put in a config file, with an example of each.

---

## How a mod is laid out

YMB looks for folders directly under `YMB/mods`. A folder becomes a mod when it contains
`config/ymb.mod.yaml`:

```text
YMB/mods/my_pack/
└── config/
    ├── ymb.mod.yaml          ← required: the mod itself
    ├── generate-output.ts    ← optional: a script
    ├── generate-output.test.ts
    ├── patch/                ← optional: one folder per patch
    │   └── ui/branding/
    │       ├── assets/       ← optional: files owned by this patch
    │       └── ymb.patch.yaml
    └── replace/              ← optional: whole files you provide
        ├── GameData/
        └── CommonData/
```

Only `config/`, `config/patch/`, and `config/replace/` take part in a build. Anything
else in the folder — notes, art sources, a README — is ignored.

---

## The mod file: `ymb.mod.yaml`

```yaml
version: 1
id: my_pack
name: My Pack
description: Example source mod
enabled: true
dependsOn: []
priority: 0
allowWriteToModifiedFiles: false
variables:
  titleToken: MY_PACK_TITLE
scripts:
  - path: generate-output.ts
    tests:
      - generate-output.test.ts
```

| Field                       | Required | Meaning                                                                                                  |
| --------------------------- | :------: | -------------------------------------------------------------------------------------------------------- |
| `version`                   |   yes    | Config format. Must be exactly `1`.                                                                      |
| `id`                        |   yes    | Permanent id. Letters, numbers, `.`, `_`, `-`.                                                           |
| `name`                      |   yes    | Readable name.                                                                                           |
| `description`               |    no    | One line about the mod.                                                                                  |
| `enabled`                   |    no    | Set `false` to skip the whole mod. Defaults to `true`.                                                   |
| `dependsOn`                 |    no    | Ids of mods that must be built first.                                                                    |
| `priority`                  |    no    | Build order. Lower builds first. Defaults to `0`.                                                        |
| `allowWriteToModifiedFiles` |    no    | Let this mod write over another mod's output. See [layering](advanced.md#layering-one-mod-over-another). |
| `variables`                 |    no    | Values usable in every patch of this mod.                                                                |
| `readValues`                |    no    | Game values read at build time and handed to templates as variables.                                     |
| `scripts`                   |    no    | Generation scripts owned by the mod.                                                                     |
| `tempPaths`                 |    no    | Disposable files this mod creates.                                                                       |

> **Never change `id` after release.** It is how YMB tracks which mod owns which file,
> including for `recover`. Rename `name` freely; leave `id` alone.

---

## The patch file: `ymb.patch.yaml`

Every `ymb.patch.yaml` under `config/patch/` is one patch you can enable, disable, or
build on its own. The folder structure is yours to organise:

```text
config/patch/
├── gameplay/units/ymb.patch.yaml
├── gameplay/decks/ymb.patch.yaml
└── ui/branding/ymb.patch.yaml
```

```yaml
version: 1
id: gameplay.armor
name: Armor changes
scope: prod
enabled: true
dependsOn: []
variables:
  frontArmor: 7
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: ${frontArmor}
```

| Field         | Required | Meaning                                                |
| ------------- | :------: | ------------------------------------------------------ |
| `version`     |   yes    | Config format. Must be exactly `1`.                    |
| `id`          |   yes    | Patch id, used by `--patch` and `dependsOn`.           |
| `name`        |   yes    | Readable name.                                         |
| `description` |    no    | One line about the patch.                              |
| `scope`       |   yes    | `prod` for normal patches, `dev` for work in progress. |
| `enabled`     |    no    | Set `false` to skip it. Defaults to `true`.            |
| `dependsOn`   |    no    | Patches that must run first.                           |
| `variables`   |    no    | Values for this patch. These win over mod variables.   |
| `readValues`  |    no    | Game values read at build time, usable as variables.   |
| `files`       |    no    | Add, copy, replace, or remove files and directories.   |
| `targets`     |    no    | Game files to change, and how.                         |
| `optional`    |    no    | Skip this patch when the game data it needs is absent. |
| `scripts`     |    no    | Generation scripts owned by this patch.                |
| `tempPaths`   |    no    | Disposable files this patch creates.                   |

A patch needs **at least one** file operation, target, or script. Unknown keys are
rejected rather than ignored, so a typo fails loudly instead of doing nothing.

### `optional`: features built on game data that may not be there

By default a target naming a file that is not there, or a selector that matches nothing,
stops the build — because that is almost always a typo. Set `optional: true` when the
feature genuinely depends on game data this install might not have: a file that only ships
with some DLC, or a vanilla block a WARNO update can rename or remove.

You do not need `optional` for an operation that only wanted something **gone**; a
`remove` that finds nothing is [a warning either way](ndf-operations.md#when-the-game-already-says-it).

```yaml
id: sandbox.supply_units
optional: true
targets:
  - file: GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf
    operations:
      - op: copy
        selector: { kind: object, by: name, value: Descriptor_Unit_T80U }
        destination: { name: Descriptor_Unit_My_Supply_Tank }
```

`validate`, `build`, and `sync` then leave that patch out, count it under
`skipped optional patches`, and list it as `skipped` with the reason. **The whole patch
goes, not the operation that failed** — a feature that adds a unit in one file and its
texture in another is not something to half-apply.

Two things are forgiven, and only those:

| Skipped                                | Still fails                                            |
| -------------------------------------- | ------------------------------------------------------ |
| The target file is not in this install | A path outside `GameData/`/`CommonData/`               |
| A selector matched nothing             | A folder where the target file belongs                 |
|                                        | Broken NDF, a failing script, a conflict, a bad config |

A selector can only be found wanting by trying, so YMB runs the build, sees which optional
features could not apply, and plans again without them. Nothing is written before that is
settled.

> **`optional` is not an off switch.** Use `enabled: false` to turn a feature off. YMB
> rejects `optional` on a patch with no `targets`, so it cannot sit in a config doing
> nothing.

Run `validate --require-all` (also on `build` and `sync`) to hold every optional patch to
the same standard as the rest. Nothing is skipped, and missing game data fails the run with
its normal error — which is what you want in CI, and when checking whether a feature has
quietly stopped applying.

### `scope`: prod vs dev

| Scope  | Built by      | Use it for                          |
| ------ | ------------- | ----------------------------------- |
| `prod` | every build   | finished work                       |
| `dev`  | `--scope dev` | experiments, debug tools, test data |

### `dependsOn` between patches

```yaml
dependsOn:
  - gameplay.units # a patch in this same mod
  - shared_pack:gameplay.ids # a patch in another mod
```

Use the qualified `modId:patchId` form across mods, and whenever a patch id might not be
unique. A missing, disabled, or circular dependency stops the build and names it.

---

## File operations

Use patch-level `files` when assets belong to one feature, when you need to copy a
directory, or when a build must remove a file:

```yaml
files:
  - op: copy
    source:
      root: exampleAssets
      path: Meshes/GreenBeret
    destination: GameData/Assets/3D/MyPack/GreenBeret
    expect: { files: 13 }

  - op: remove
    target: GameData/Assets/3D/MyPack/GreenBeret/GreenBeret_1.blend
    expect: { files: 1 }

  - op: replace
    source:
      root: patch
      path: assets/GreenBeret_1.png
    destination: GameData/Assets/3D/MyPack/GreenBeret/GreenBeret_1.png
```

Operations run in order. A directory source copies its contents below `destination`; a
file source writes exactly to `destination`. Directories are expanded in stable path
order, and `expect.files` fails if the number of matched files changes. YMB tracks files,
not empty directories: removing a directory means removing every regular file below it.

| Operation | Destination rule     | Typical use                                     |
| --------- | -------------------- | ----------------------------------------------- |
| `add`     | must not exist       | Create a new owned file                         |
| `copy`    | may exist or not     | Copy/refresh a file or merge a directory        |
| `replace` | must exist           | Deliberately overwrite an existing file         |
| `remove`  | already gone is fine | Delete one file or every file below a directory |

`add` and `replace` state what they expect the destination to be, and say so when it is
the other one — use `copy` when either is fine. `remove` is different: a target that is
already gone is what it was asking for, so the build carries on and reports a warning
naming the path. `expect.files` still applies, so a removal that must match a set number
of files fails when it does not.

Write sources use `source.root`:

| Root            | `source.path` starts from                   |
| --------------- | ------------------------------------------- |
| `patch`         | the folder containing this `ymb.patch.yaml` |
| `mod`           | this source mod's `config/` folder          |
| `game`          | the configured live mod root                |
| `exampleAssets` | WARNO's sibling `Mods/ExampleAssets` folder |

`game` sources always read the untouched original bytes kept by YMB, not an earlier
synced output. Source and destination paths support variables. Text from `patch` and
`mod` sources also supports content variables. `game` and `exampleAssets` sources remain
byte-exact, including text files, so YMB does not add in-file ownership markers to them.

File operations never follow symbolic links or junctions. Targets must stay below
`GameData/` or `CommonData/`, and targeting either root itself is rejected. Windows
device names, alternate-stream colons, invalid characters, and trailing dots or spaces
are rejected too. A planned file can never also be another target's parent directory.
Within one patch, later operations may intentionally build on earlier ones. Across
patches, target the same path only through an explicit patch dependency (or deliberate
ordered mod layering).

`build` writes normal outputs to the preview and records removals in
`.ymb-deletions.json`. `sync --yes` backs up files before deleting them. `recover --yes`
restores deleted originals and removes files that YMB added.

---

## NDF targets

Targets name a game file and list what to do to it:

```yaml
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        # ...
      - op: add
        # ...
```

- Paths must start with `GameData/` or `CommonData/`, exactly capitalized.
- Operations run **in the order written**. A later one sees the earlier one's result.
- A `forEach` block in `operations` repeats its `do` list once per entry, in place. See
  [forEach](ndf-operations.md#foreach-the-same-operations-for-every-entry-in-a-list).

### Blocks that must stay reachable

Some blocks only do anything because another block names them — a panel inside a screen,
a weapon a unit points at. Replacing one of those succeeds whether or not anything still
points at it: the operation found its target, so nothing looks wrong, and the block is
built into the mod and used by nobody.

`expect.referenced` says which blocks are that kind, and YMB checks them after the target
applies:

```yaml
targets:
  - file: GameData/UserInterface/Use/MyScreen.ndf
    expect:
      referenced: [MyPanel, MyPanelContent]
    operations:
      - op: remove
        selector: { kind: object, by: name, value: MyPanel }
      - op: add
        value:
          $raw: 'MyPanel is BUCKListDescriptor( ... )'
```

Only list blocks you know something should point at. Plenty of top-level blocks are
referenced by nothing and work perfectly, because the game reads them by name rather than
through NDF — a screen-wide constant like `MaxUnitsPerCategory` is one. YMB cannot tell
those apart from an orphan, which is why it checks what you name and nothing else.

A failure names the block and stops the run. On an `optional` patch it skips the patch
instead, like any other selector that stopped matching. The check reads the finished
project once, so a block referenced from its own file costs nothing measurable and one
referenced from elsewhere costs a pass over the game files.

Full reference: **[Changing NDF files](ndf-operations.md)**.

---

## Replace files

Anything under `config/replace/` is copied to the same path in the game:

```text
config/replace/GameData/Assets/MyPack/logo.png
   → GameData/Assets/MyPack/logo.png
```

Use replace files for:

- ✅ new assets — icons, textures, videos
- ✅ localization tables your mod owns
- ✅ files that are entirely yours

`config/replace/` remains a concise mod-wide shorthand. Prefer patch-level file
operations when the asset should be enabled, filtered, and recovered with one feature,
or when you need directory copy/remove behavior.

Avoid them for existing game files. A replaced file is a **full copy**, so the next WARNO
update silently reverts everything the game changed in it. A patch survives that; a copy
does not.

Both the **path** and the **text content** support [variables](template-expressions.md):

```text
config/replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
```

```csv
"TOKEN";"REFTEXT"
"MY_TITLE";"${modName}"
```

Text substitution applies to `.csv`, `.ini`, `.json`, `.md`, `.ndf`, `.txt`, `.xml`,
`.yaml`, and `.yml`. Every other file is copied byte for byte, so images and videos are
never corrupted.

---

## Scripts and tests

When config is not enough, generate output with code:

```yaml
scripts:
  - path: generate-output.ts
    enabled: true
    tests:
      - generate-output.test.ts
      - path: check-generated-output.test.ts
        when: after
```

- Paths are relative to the config file that declares them.
- Tests run automatically during `validate`, `build`, and `sync`.
- A bare path runs **before** its script, so a failure costs nothing. `when: after` runs
  it once the script has produced its output — see
  [before or after the script](script-tools.md#before-or-after-the-script).
- Declare scripts on the **mod** for whole-project output, on a **patch** for output that
  belongs to that feature.

Reach for a script when output depends on reading several files, or on data you have to
compute. Use a plain patch when one selector and one value would do.

Full reference: **[Generation scripts](script-tools.md)**.

---

## Variables

Declare on the mod, the patch, or both:

```yaml
variables:
  frontArmor: 7
  gfx: GameData/Generated/Gameplay/Gfx
```

Then use them anywhere in that scope:

```yaml
file: ${gfx}/Ammunition.ndf
value: ${frontArmor}
```

Patch variables override mod variables of the same name. Built-ins like `${modId}` are
always available.

Full reference: **[Variables](template-expressions.md)**.

---

## Reading values out of the game

Some numbers you need are already in the game, and copying them into your config means the
copy goes stale the moment a WARNO patch — or another mod you are built on top of — changes
them. `readValues` reads them instead, every build:

```yaml
readValues:
  conversionFactor:
    file: CommonData/Gameplay/Constantes/SomeConstants.ndf
    path: '@type:TSomeConstants.ConversionFactor'
  unitArmor:
    file: GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf
    path: 'Descriptor_Unit_T80U.ModulesDescriptors.[TDamageModuleDescriptor].FrontArmor'
```

Each entry becomes a variable of that name, usable anywhere a variable is:

```yaml
variables:
  blastRadius: ${conversionFactor * 500}
```

| Field  | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `file` | Game file to read, under `GameData/` or `CommonData/`.                        |
| `path` | Which field, using the same path syntax a `modify` selector targets one with. |

Notes:

- `path` starts with a top-level block and names at least one field. Use `@type:TSomeType`
  when the block has no name, exactly as a selector would.
- A value that reads as a number becomes one, so arithmetic works on it. Anything else —
  a token, a quoted string, a list — arrives as written.
- A variable you declare yourself wins over a read value of the same name.
- A missing file, a missing field, or a path naming no field stops the build and says which
  entry, block, and file it was looking at. Nothing is guessed or defaulted.

Reads happen once, before any patch runs, so they see the game as it was — not what an
earlier patch in the same build did to it. To act on your own output, use a script instead.

---

## Temporary paths

If your mod or script writes working files, declare them so `cleanup` can find them:

```yaml
tempPaths:
  - .cache/generated.json
  - path: .cache/important.json
    unsafeToRemove: true
```

| Form                   | Removed by `cleanup` | Removed by `cleanup --all --yes` |
| ---------------------- | :------------------: | :------------------------------: |
| plain string           |         yes          |               yes                |
| `unsafeToRemove: true` |          no          |               yes                |

Use `unsafeToRemove` for anything expensive or awkward to regenerate.

> Temp paths must name something **inside** the mod or patch folder that declares them. `.`,
> an empty value, and any `..` that climbs out are rejected, so `cleanup` can never be pointed
> at the declaring folder itself.

---

## Builder settings: `ymb.config.yaml`

Every install ships one at the YMB root, with everything commented out. As shipped it
changes nothing — uncomment a line only to move a folder or tune a limit:

```yaml
version: 1

# paths:
#   gameRoot: ..
#   sourceMods: mods
#   workRoot: .ymb-build
#   recoveryRoot: .ymb-state

# settings:
#   scriptTimeoutSeconds: 120
#   mergeMaxTextBytesPerSide: 4000000
```

> **Leave `version: 1` uncommented.** A file with nothing active parses as empty and
> fails, instead of falling back to defaults. Uncomment the `paths:` or `settings:` line
> above any value you enable.

The file also pins the builder root: YMB uses the nearest `ymb.config.yaml` at or above
the folder you run it from.

| Path setting   | Default      | Points at                          |
| -------------- | ------------ | ---------------------------------- |
| `gameRoot`     | `..`         | Folder holding GameData/CommonData |
| `sourceMods`   | `mods`       | Where your mods live               |
| `workRoot`     | `.ymb-build` | Previews and caches                |
| `recoveryRoot` | `.ymb-state` | Undo data — keep this              |

Paths may be relative to the YMB folder or absolute. They must not overlap each other or
the live game data; YMB checks this at startup and explains any clash.

Useful `settings`: `scriptTimeoutSeconds` (raise for slow generators), `cacheMaxBytes`
and `cacheMaxAgeDays` (cache size), `scriptTargetReadConcurrency` (parallel file reads).

### Very large generated files

Two jobs diff a file line by line, and both cost far more than twice as much on a file
twice the size. Each has a ceiling, and going over one is a fallback rather than a failure:

| Setting group | Guards                                            | Over the ceiling                                         |
| ------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `merge*`      | combining two mods' versions of the same file     | their changes are applied in priority order instead      |
| `marker*`     | the inline markers showing exactly what YMB added | the file keeps its whole-file markers and no inline ones |

Each group has three values — `MaxTextBytesPerSide` and `MaxTextBytesCombined` for how much
text, `MaxEstimatedDiffWork` for how much comparing. The defaults suit a normal file. A
project generating one very large file (a script that writes a 50 MB `.ndf`, say) raises
them rather than accepting the fallback:

```yaml
settings:
  mergeMaxTextBytesPerSide: 60000000
  mergeMaxTextBytesCombined: 120000000
```

Raise only what the message you actually saw points at, and keep the values finite — the
ceiling is what stops one runaway file from taking the whole machine with it.

Run `doctor` to see the resolved values.

---

## See also

- [Changing NDF files](ndf-operations.md) — every operation and selector
- [Variables](template-expressions.md) — expressions and helpers
- [Generation scripts](script-tools.md) — the script API
- [Advanced topics](advanced.md) — layering, ownership, caching
