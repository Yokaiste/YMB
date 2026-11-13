# 3. Make the health change adjustable

[Docs](README.md) / Configuration · [Previous: change tank health](ndf-operations.md) · [Next: calculate health](template-expressions.md)

Continue with `MyFirstMod` and its `first_mod` project. You'll set the M1A1 Abrams to 30 health through a local override, then turn that feature off and back on.

If you tried the optional menu add/remove/copy experiments, remove those appended operations before continuing. Keep the original title-add operation from `init`; the title-size example below edits that original welcome container.

## Start from the single-tank patch

If you tried the loop or bulk versions in the NDF lesson, replace the contents of this file with the single-tank version below:

```text
MyFirstMod/YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml
```

```yaml
version: 1
id: gameplay.health
name: M1A1 health
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

Run `build --mod first_mod`. In the preview's `GameData/Generated/Gameplay/TacticalUnits.ndf`, find `Descriptor_Unit_M1A1_Abrams_US`. Its `TBaseDamageModuleDescriptor` should contain `MaxPhysicalDamages = 20`.

## Change it without editing the patch

Open `MyFirstMod/YMB/ymb.config.yaml`. For the tutorial installation, use:

```yaml
version: 1
mods:
  first_mod:
    patches:
      gameplay.health:
        variables:
          health: 30
```

If that file already contains settings you need, keep them and add this project under its existing `mods` entry. Do not create a second `version` or `mods` key.

Build again:

```text
build --mod first_mod
```

The M1A1's preview value should now be `30`, while the patch file still says `health: 20`. Your local override wins.

To try it in WARNO, run `sync --mod first_mod --yes`, run `MyFirstMod/GenerateMod.bat`, and enable `MyFirstMod`. The same M1A1 Abrams now has a maximum of 30 health. Its armor and weapons are unchanged; extra health is not extra armor.

## Turn the feature off

Keep the local value and add `enabled: false` to the patch override:

```yaml
version: 1
mods:
  first_mod:
    patches:
      gameplay.health:
        enabled: false
        variables:
          health: 30
```

Run `build --mod first_mod`. The report should exclude `gameplay.health`. With only the starter and this health patch installed, `TacticalUnits.ndf` is now absent from the preview because nothing selected changes it. The welcome-screen title remains.

`sync --mod first_mod --yes` restores the previously applied health file when it is no longer part of this project's output. Compile again to return the tank to its original health in game.

Change `enabled` to `true` and build again. The health patch returns with the local value `30`.

## Keep experiments out of normal builds

In the health patch file, change `scope: prod` to `scope: dev`. Then compare:

```text
build --mod first_mod
build --mod first_mod --scope dev
```

The first command leaves out the health patch. The second includes both production and development patches.

Put `scope: prod` back before continuing. Leave the local override at `health: 30` and `enabled: true`. [Lesson 4](template-expressions.md) starts by removing that fixed override, then calculates health from the game's original value.

## Customizing installed mods

The same local-override workflow works with downloaded mod projects. Put the editable project folder under `YMB/mods/`, with `config/ymb.mod.yaml` inside it. Use `list` to find its id and patch ids, then read its supported variables.

For this tutorial, those are `first_mod`, `gameplay.health`, and `health`. Another project may expose different names. An unknown project or patch id is an error; a variable nobody reads has no effect.

Remove an override to return to the project's default. Keep `ymb.config.yaml` backed up when updating YMB because release archives include a default copy. Keeping local choices here also avoids editing defaults every time a downloaded project is updated.

### Where a value comes from

Later entries win:

1. Variables in `ymb.mod.yaml`.
2. Variables in the current `ymb.patch.yaml`.
3. Top-level `variables` in `ymb.config.yaml`.
4. `mods.<id>.variables`.
5. `mods.<id>.patches.<patch-id>.variables`.

The tutorial uses the last form so its health setting affects only `gameplay.health`.

Objects merge recursively. Lists replace the whole list; `[]` clears it. Numbers, strings, booleans, and `null` replace the previous value. Expressions resolve after merging. Built-ins such as `modId` are reserved.

Patch variables do not affect the project's other patches, mod-wide scripts, or replacement files. Folder nesting organizes patches; it does not create variable inheritance.

## Project layout

After the first two lessons, the files you edit are here:

```text
YMB/mods/first_mod/
├── README.md
└── config/
    ├── ymb.mod.yaml
    ├── generate-build-info.ts
    ├── generate-build-info.test.ts
    ├── patch/
    │   ├── gameplay/health/ymb.patch.yaml
    │   └── ui/branding/welcome-view/ymb.patch.yaml
    └── replace/
        └── GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
```

YMB discovers project folders through `config/ymb.mod.yaml`. It finds patch configs recursively under `config/patch/` and copies replacement files from `config/replace/`. Scripts run only when registered. A README or an art-source folder is not automatically included in the mod.

## The mod file: `ymb.mod.yaml`

The starter's `config/ymb.mod.yaml` already declares its welcome-text variables and generator. Keep those entries when adding project-wide settings.

| Field                       | Required | Meaning and default                                                             |
| --------------------------- | :------: | ------------------------------------------------------------------------------- |
| `version`                   |   Yes    | Config format; use `1`                                                          |
| `id`                        |   Yes    | Permanent project id, `first_mod` here                                          |
| `name`                      |   Yes    | Display name; also used by the starter's menu title                             |
| `description`               |    No    | Short description; used by the starter's title tooltip                          |
| `enabled`                   |    No    | `true`; `false` excludes the project                                            |
| `dependsOn`                 |    No    | `[]`; project ids that must run first                                           |
| `priority`                  |    No    | `0`; lower values run earlier, subject to dependencies                          |
| `allowWriteToModifiedFiles` |    No    | `false`; opt into [ordered layering](advanced.md#layering-one-mod-over-another) |
| `variables`                 |    No    | Values available throughout this project                                        |
| `readValues`                |    No    | Values read from game data before patches run                                   |
| `scripts`                   |    No    | Registered generation scripts                                                   |
| `tempPaths`                 |    No    | Working files that cleanup may remove                                           |

Keep `id` stable after use because ownership and recovery depend on it. Rename `name` when you want different display text.

Ids use letters, numbers, dots, underscores, and hyphens. Windows device names such as `CON` and `NUL`, `.`, `..`, and trailing dots are invalid. Recover installed output before migrating an old unsupported id.

## The patch file: `ymb.patch.yaml`

The health patch at the top of this page is a complete patch file.

| Field         | Required | Meaning and default                                       |
| ------------- | :------: | --------------------------------------------------------- |
| `version`     |   Yes    | `1`                                                       |
| `id`          |   Yes    | Stable id, unique within this project                     |
| `name`        |   Yes    | Name shown in YMB's reports                               |
| `scope`       |   Yes    | `prod` or `dev`                                           |
| `description` |    No    | Short description                                         |
| `enabled`     |    No    | `true`                                                    |
| `dependsOn`   |    No    | `[]`; prerequisite patches                                |
| `variables`   |    No    | Defaults for this patch                                   |
| `readValues`  |    No    | Values read before patching                               |
| `files`       |    No    | File and directory operations                             |
| `targets`     |    No    | NDF files and their operations                            |
| `optional`    |    No    | `false`; skip the patch if required target data is absent |
| `scripts`     |    No    | Generation scripts owned by this patch                    |
| `tempPaths`   |    No    | Declared working files                                    |

A patch needs at least one entry in `files`, `targets`, or `scripts`. Unknown keys and misplaced settings are errors.

### Scope: prod and dev

`prod` patches are included by default. `--scope dev` includes both `prod` and `dev` patches. The local `enabled` setting still applies in either scope.

### dependsOn between patches

Use a dependency when a patch needs something an earlier patch creates. The health patch edits an existing game unit, so it needs no dependency on the title.

For example, a later patch that resizes the title added by `init` must depend on `ui.branding.welcome_view`. To try it, create `config/patch/ui/title-size/ymb.patch.yaml` inside `first_mod`:

```yaml
version: 1
id: ui.title_size
name: Smaller welcome title
scope: prod
dependsOn:
  - ui.branding.welcome_view
targets:
  - file: GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: UISpecificOutGameWelcomeDescriptor.Components.[ElementName="MainMenuTitlefirst_mod"].TextSize
        value:
          $string: '40'
```

Build `first_mod` and find `MainMenuTitlefirst_mod` in the preview's welcome-screen NDF. Its active `TextSize` line should now contain `'40'`; the original `"50"` remains in a comment. After sync and compilation, the same title appears smaller.

This optional patch can stay in the project. Dependencies within a project use patch ids; dependencies on another project's patch use `modId:patchId`. Missing, disabled, or circular dependencies fail. Disabling a prerequisite does not automatically disable its dependents.

### Optional: features built on game data that may not be there

`optional: true` allows a patch with NDF targets to be skipped if a target file or selected object is absent. Leave it off for the health lesson so a broken unit selector is reported.

The whole patch is skipped, with its reason. Invalid paths, syntax errors, conflicts, script failures, and bad configuration still fail the build. Scripts may have run during the attempt, so their persistent writes need the same care as any other run.

`optional` requires a `targets` entry. Use `enabled: false` to turn off a feature deliberately. A `remove` operation already warns if its target is gone.

Use `build --require-all` for release checks so optional features must apply successfully.

## Replace files

The starter already supplies a file this way:

```text
YMB/mods/first_mod/config/replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
```

Open it. Its title entry uses `${welcomeTitleToken}` and `${modName}`. The built file lands at:

```text
MyFirstMod/GameData/Localisation/MyFirstMod/INTERFACE_OUTGAME.csv
```

During a preview, the same target path is under `YMB/.ymb-build/output/`. Changes belong in the source template.

To customize the title's tooltip, add a `description` beside `name` in `ymb.mod.yaml`:

```yaml
description: The Abrams can take a little more punishment.
```

Build again. The preview CSV entry `FIRST_MO_I` should contain that sentence. After sync and compilation, hovering over the welcome title should show it.

Whole-file replacements supply every byte at their target path. Use them for files your project owns. Replacing a game's full `TacticalUnits.ndf` would freeze every other unit too, so the health lesson uses a patch.

Text substitution covers `.csv`, `.ini`, `.json`, `.md`, `.ndf`, `.txt`, `.xml`, `.yaml`, and `.yml`. Other extensions are copied as bytes. Paths also accept variables.

## File operations

Patch-level `files` entries let an asset follow a feature's selection. For a working example using the starter's existing text, you can move its localisation CSV into the welcome patch:

1. Create `config/patch/ui/branding/welcome-view/assets/`.
2. Move `config/replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv` to that folder.
3. Add this top-level block to the existing welcome patch, alongside `targets`:

```yaml
files:
  - op: copy
    source:
      root: patch
      path: assets/INTERFACE_OUTGAME.csv
    destination: GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
    expect:
      files: 1
```

Build `first_mod`. The same preview CSV should contain the same title and tooltip. Move the original; leaving a second copy under `config/replace` creates two owners of one output.

This is an optional reorganization. The remaining lessons work with either location because the target path and variable names stay the same.

| Operation | Destination requirement                            |
| --------- | -------------------------------------------------- |
| `add`     | Must not exist                                     |
| `copy`    | May exist; creates or refreshes it                 |
| `replace` | Must exist                                         |
| `remove`  | May be absent; warns if there is nothing to remove |

Write operations use `source` and `destination`. Removal uses `target`. A directory source copies its contents below the destination; a file source writes exactly to it. Directory removal affects its regular files. `expect.files` requires an exact positive count.

### Source roots

| `source.root`   | `source.path` starts at             |
| --------------- | ----------------------------------- |
| `patch`         | Folder containing the patch config  |
| `mod`           | Project's `config/` folder          |
| `game`          | Configured WARNO mod folder         |
| `exampleAssets` | WARNO's `Mods/ExampleAssets` folder |

Paths support variables. Text from `patch` and `mod` sources also supports content substitution. `game` sources read saved original bytes for tracked files. Sources from `game` and `exampleAssets` remain byte-exact, including text.

Operations within a patch run in order. Declare dependencies when different patches share a target; use [ordered layering](advanced.md#layering-one-mod-over-another) across projects.

Targets must stay below `GameData/` or `CommonData/`, with that capitalization. Targeting either root itself, following symlinks or junctions, escaping roots, and using invalid Windows names are rejected. An output file cannot also be another output's parent directory.

Preview removals appear in `.ymb-deletions.json`. Sync saves originals before deleting files, and recovery restores those originals.

## NDF targets

The health patch targets `GameData/Generated/Gameplay/TacticalUnits.ndf`. The welcome patch targets `GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf`. Each target declares an ordered `operations` list; later operations see earlier results.

See [NDF operations](ndf-operations.md) for the single-unit, loop, and bulk versions of the health change.

### Blocks that must stay reachable

`targets[].expect.referenced` takes a list of block names that must be referenced in the finished project, including from other files. Use it for generated objects whose behavior depends on such a reference.

Do not add it to every block. WARNO loads some roots by name; an absent textual reference does not prove they are unused. The health and welcome patches do not need this extra check.

An unmet required reference fails the build. An optional patch can be skipped for this missing-target condition.

## Scripts and tests

The starter already registers this script in `config/ymb.mod.yaml`:

```yaml
scripts:
  - path: generate-build-info.ts
    tests:
      - generate-build-info.test.ts
```

Paths are relative to the declaring config. A bare test path runs before its script. A test object with `path` and `when: after` sees that run's output. Tests participate in validation, build, and sync.

Use mod-level scripts for project-wide output and patch-level scripts for feature output. [The script lesson](script-tools.md) continues from this project.

## Variables

The health lesson uses `variables.health` and `value: ${health}`. [Lesson 4](template-expressions.md) adds calculations and reads the original game value.

Keep feature-specific defaults in the feature's patch. Put a variable in `ymb.mod.yaml` when several parts of the project need it.

## Reading values out of the game

The original M1A1 health is available through:

```yaml
readValues:
  baseHealth:
    file: GameData/Generated/Gameplay/TacticalUnits.ndf
    path: Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
```

Each entry has `file` and `path`. It becomes a variable, `baseHealth` here. [The next lesson](template-expressions.md) provides a complete health patch that uses this read.

Numeric values become numbers. Other values arrive as written, including quotes or list syntax. An explicit variable with the same name wins. Missing inputs fail with their location.

Reads happen before patches and use original game data. They cannot read a file first created by the same build. Use script target readers when you need earlier generated output.

## Temporary paths

The starter writes no temporary files inside its project, so it needs no `tempPaths` entry. Later generators can declare working paths for `cleanup`.

A plain path is disposable. An object with `path` and `unsafeToRemove: true` survives normal cleanup but can be deleted by `cleanup --all --yes`. Normal cleanup also preserves its contents and parents.

Paths are relative to the declaring config folder and must stay inside it. The declaring folder itself cannot be disposable. Keep persistent identities and user-authored data out of temporary-path declarations.

## Builder settings: `ymb.config.yaml`

The tutorial uses YMB's default locations. Keep `version: 1` active; a blank or fully commented file is invalid.

```yaml
version: 1
paths:
  gameRoot: ..
  sourceMods: mods
  workRoot: .ymb-build
  recoveryRoot: .ymb-state
```

`sourceMods` is the config key for the mod projects folder. Use that exact spelling.

| Path                   | Default                  | Purpose                                           |
| ---------------------- | ------------------------ | ------------------------------------------------- |
| `gameRoot`             | `..`                     | `MyFirstMod`, holding `GameData` and `CommonData` |
| `sourceMods`           | `mods`                   | Editable projects, including `first_mod`          |
| `workRoot`             | `.ymb-build`             | Preview and caches                                |
| `recoveryRoot`         | `.ymb-state`             | Saved originals and recovery records              |
| `operationLockRoot`    | `.ymb-operation-lock`    | Prevents overlapping protected commands           |
| `stateTransactionRoot` | `.ymb-state-transaction` | Records interrupted writes for rollback           |

Paths may be absolute or relative to YMB. Keep their contents separate; YMB rejects overlapping layouts. Run `doctor` after changing them.

Without `--ymb-path`, YMB looks for the nearest `ymb.config.yaml` at or above the working directory. Advanced limits live under `settings`; see their [defaults and tradeoffs](advanced.md#keeping-large-projects-fast) when a real workload reaches them.
