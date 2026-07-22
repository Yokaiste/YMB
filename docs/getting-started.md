# Getting Started Without Coding

This guide takes you from an empty generated WARNO mod to a safe YMB preview. You do not need programming experience.

## What YMB changes

YMB keeps two kinds of files separate:

- **source files** under `YMB/mods`, which describe your intended changes
- **generated files** under `YMB/.ymb-build/output` and the WARNO mod's `GameData` and `CommonData`

Edit source files, not generated preview files. When the source changes, build a new preview.

## 1. Create a WARNO mod

Open WARNO's installation folder, enter `Mods`, and run:

```text
CreateNewMod.bat YourModName
```

The created folder must contain `GameData` and `CommonData`.

## 2. Install YMB

1. Download the [latest YMB release](https://github.com/Yokaiste/YMB/releases/latest).
2. Extract its `YMB` folder into the generated WARNO mod.
3. Double-click `YMB/YMB.bat`.
4. Run:

```text
doctor
```

Read every path. The live paths must point to the WARNO mod you intend to change.

## 3. Create a starter source mod

In the YMB window, run:

```text
init --id my_pack --name "My Pack"
```

Use a short stable ID without spaces. YMB creates:

```text
YMB/mods/my_pack/
  README.md
  config/
    ymb.mod.yaml
    generate-build-info.ts
    generate-build-info.test.ts
    patch/
      ui/branding/welcome-view/
        ymb.patch.yaml
    replace/
      GameData/
```

The starter already contains examples. You can build it before editing anything.

## 4. Validate and build

```text
validate --mod my_pack
build --mod my_pack
```

If both commands succeed, open:

```text
YMB/.ymb-build/output
```

This is a preview. WARNO's live files have not changed.

Compare the preview with `GameData` and `CommonData`. Check that only the expected files and sections changed.

## 5. Apply or discard the preview

Apply the reviewed source mod:

```text
sync --mod my_pack --yes
```

Restore the originals later:

```text
recover --mod my_pack --yes
```

Keep `YMB/.ymb-state`; it contains the recovery information created by sync.

## Editing YAML safely

YMB configuration uses YAML. The important rules are:

- indentation uses spaces, not tabs
- items beginning with `-` belong to a list
- text containing punctuation is safest inside quotes
- names and IDs are case-sensitive unless a command says otherwise
- unknown fields are errors, so spelling mistakes are reported

Example:

```yaml
version: 1
id: gameplay.armor
name: Armor changes
scope: prod
enabled: true
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Name.FieldName
        value: 7
```

Read it from top to bottom:

1. define one patch
2. choose one WARNO file
3. select one field
4. replace its value with `7`

The example names are illustrative. Copy exact object and field names from the generated WARNO source file you are targeting.

## Changes that do not require scripts

Most small mods can use configuration only.

### Change an existing NDF value

Use a `modify` operation with a field path. See [NDF operations](ndf-operations.md).

### Clone an existing object

Use `copy`, then apply `modify` operations to the copied name.

### Insert or remove data

Use `add` or `remove` with a stable object, field, or collection selector.

### Apply one rule to many objects

Use `bulk` when the same field, MAP, or list change belongs on many blocks. Always add realistic `expect.minBlocks` and `minChanges` checks so a WARNO update cannot silently make the rule match too little data. Start with a normal operation when you only need to change one known object.

### Add an asset or own a complete file

Place it under `config/replace` using its intended `GameData` or `CommonData` path.

```text
config/replace/GameData/Assets/MyPack/logo.png
```

Do not replace a complete game file when a small NDF operation can express the same change.

### Reuse values

Put shared values in `variables` and reference them with `${name}`. See [template expressions](template-expressions.md).

## Organizing features

Give each feature its own patch folder:

```text
config/patch/
  gameplay/armor/ymb.patch.yaml
  gameplay/availability/ymb.patch.yaml
  ui/branding/ymb.patch.yaml
```

This makes features easy to select, test, disable, and repair after WARNO updates.

Use `scope: prod` for normal output. Use `scope: dev` for optional experiments or diagnostic content.

## Common problems

### YMB cannot find the source mod

Confirm this exact file exists:

```text
YMB/mods/my_pack/config/ymb.mod.yaml
```

Run `list` to see what YMB discovered.

### A patch is missing from the build

Run:

```text
explain --mod my_pack
```

Check `enabled`, `scope`, filters, and dependencies.

### A selector matches nothing

The WARNO file probably changed or the path was copied incorrectly. Open the target file, find the current object and field names, and update the selector.

### A selector matches more than one object

Use a more precise name, path, type, or `where` match. YMB refuses to guess.

### Generated NDF is invalid

Review the operation value and any `$raw` block. Prefer normal YAML values when possible.

### Sync rejects a live file

Do not force an overwrite. Recover or review the external edit, rebuild, and sync only after the live state is understood.

## Where to continue

- [Workflow and safety](workflow.md) for every command and filter
- [Configuration](configuration.md) for all source-mod and patch fields
- [NDF operations](ndf-operations.md) for selectors and edits
- [Template expressions](template-expressions.md) for reusable values
- [Generation scripts](script-tools.md) when configuration is no longer enough
- [Advanced usage](advanced.md) for large modular projects, layering, caching, and upgrades
