# Configuration

YMB discovers source mods from immediate folders under `YMB/mods`. A source mod must contain `config/ymb.mod.yaml`.

```text
YMB/mods/my_pack/
  config/
    ymb.mod.yaml
    generate-output.ts
    generate-output.test.ts
    patch/
      ui/branding/
        ymb.patch.yaml
    replace/
      GameData/
      CommonData/
```

Only the config root, `config/patch`, and `config/replace` participate in builds.

## Source-mod configuration

`config/ymb.mod.yaml` defines the source mod:

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

| Field                       | Required | Meaning                                                    |
| --------------------------- | -------- | ---------------------------------------------------------- |
| `version`                   | yes      | Configuration format; currently `1`                        |
| `id`                        | yes      | Stable ID using letters, numbers, `.`, `_`, or `-`         |
| `name`                      | yes      | Display name                                               |
| `description`               | no       | Display description                                        |
| `enabled`                   | no       | Enables discovery; defaults to `true`                      |
| `dependsOn`                 | no       | Source-mod IDs that must be built first                    |
| `priority`                  | no       | Integer ordering value; defaults to `0`                    |
| `allowWriteToModifiedFiles` | no       | Allows intentional layering over earlier source-mod output |
| `variables`                 | no       | Values available to templates and scripts                  |
| `scripts`                   | no       | Source-mod generation scripts                              |
| `tempPaths`                 | no       | Disposable paths owned by the source mod                   |

Keep IDs stable. Use dependencies for required ordering. Enable `allowWriteToModifiedFiles` only when source mods are deliberately designed to write in sequence.

## Patch configuration

Every file named `ymb.patch.yaml` under `config/patch` defines one selectable patch:

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

| Field         | Required | Meaning                               |
| ------------- | -------- | ------------------------------------- |
| `version`     | yes      | Configuration format; currently `1`   |
| `id`          | yes      | Patch ID                              |
| `name`        | yes      | Display name                          |
| `description` | no       | Display description                   |
| `enabled`     | no       | Enables the patch; defaults to `true` |
| `scope`       | yes      | `prod` or `dev`                       |
| `dependsOn`   | no       | Patch dependencies                    |
| `variables`   | no       | Patch-local template values           |
| `targets`     | no       | NDF targets and operations            |
| `scripts`     | no       | Patch generation scripts              |
| `tempPaths`   | no       | Disposable paths owned by the patch   |

A patch must contain at least one target or script. Unknown keys and unsupported operation shapes are rejected.

Patch dependencies may use `patchId` within an unambiguous selection or `modId:patchId` across source mods. `prod` selects production patches; `dev` selects both production and development patches.

## NDF targets

Targets use WARNO-relative paths under `GameData` or `CommonData`:

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

Operations run in listed order. Exact `copy`, `modify`, `add`, and `remove` operations use selectors. A `bulk` operation instead matches a set of top-level blocks and applies checked edits across them. See [NDF operations](ndf-operations.md) for every shape.

## Replace files

Files under `config/replace` are copied to the matching output path:

```text
config/replace/GameData/Assets/MyPack/logo.png
```

Use replacement for new assets or files the source mod intentionally owns in full. Prefer NDF operations for focused changes to existing game files.

Replace paths and supported text content can contain [template expressions](template-expressions.md).

## Scripts and tests

Register scripts at source-mod or patch level:

```yaml
scripts:
  - path: generate-output.ts
    enabled: true
    tests:
      - generate-output.test.ts
```

Paths are relative to the owning configuration file. Tests run during `validate`, `build`, and `sync`. Use scripts for derived or multi-file output; use a normal patch when one selector and value are sufficient.

See [generation scripts](script-tools.md) for the public API.

## Variables

Variables work in target paths, operation values, nested changes, replace paths and supported text, and script paths.

Built-in values:

| Variable           | Value                                       |
| ------------------ | ------------------------------------------- |
| `modRootName`      | WARNO mod folder name                       |
| `modId`            | Source-mod ID                               |
| `modName`          | Source-mod name                             |
| `modDescription`   | Source-mod description                      |
| `patchId`          | Patch ID, or empty outside a patch          |
| `patchName`        | Patch name, or empty outside a patch        |
| `patchDescription` | Patch description, or empty outside a patch |

Patch variables override source-mod variables. Built-in values remain available. See [template expressions](template-expressions.md).

## Temporary paths

Declare disposable files created by a source mod or patch:

```yaml
tempPaths:
  - .cache/generated.json
  - path: .cache/important.json
    unsafeToRemove: true
```

Normal `cleanup` preserves entries marked `unsafeToRemove`. `cleanup --all --yes` may remove them along with recovery data.
