# Configuration Reference

This guide maps how YMB sees your source mods and how to shape configs so the planner, builder, script runtime, and AI coding agents behave exactly the way you expect.

## 🧭 Start With the Model

> [!IMPORTANT]
> YMB is easiest to maintain when you think in three layers:
>
> 1. a source mod
> 2. one or more patches or scripts inside it
> 3. a resolved build result

That structure is what keeps a large WARNO project readable instead of collapsing into one giant pile of edits.

## 🗂 Recommended Layout

```text
YMB/
  mods/
    my_pack/
      config/
        ymb.mod.yaml
        generate-build-info.ts
        generate-build-info.test.ts
        patch/
          ui/
            branding/
              welcome-view/
                ymb.patch.yaml
        replace/
          GameData/
            Localisation/
              ${modRootName}/
                INTERFACE_OUTGAME.csv
      README.md
```

> [!TIP]
> Keep planning notes, screenshots, exports, and scratch files beside the config if you want. YMB only scans specific config roots and build-owned folders.

## 🔎 Source Mod Discovery

YMB discovers source mods only from the immediate child folders under `YMB/mods`.

A folder counts as a source mod when it contains `ymb.mod.yaml`:

- at the source-mod root
- or inside a nested `config/` folder

Once YMB finds the config root, it only scans:

- the config root itself
- `patch/`
- `replace/`

That boundary is intentional. It keeps the build predictable.

## 📄 `ymb.mod.yaml`

This file defines the source mod itself.

Minimal example:

```yaml
version: 1
id: my_pack
name: My Pack
description: My first YMB source mod
dependsOn: []
priority: 0
allowWriteToModifiedFiles: false
variables:
  welcomeTokenPrefix: 'MY_PACK'
  welcomeTitleToken: '${welcomeTokenPrefix}_T'
  welcomeInfoToken: '${welcomeTokenPrefix}_I'
  generatedInfoTarget: 'GameData/Generated/Gameplay/${modId}/StarterInfo.ndf'
enabled: true
scripts:
  - path: generate-build-info.ts
    tests:
      - generate-build-info.test.ts
```

### Field Reference

| Field                       | Meaning                                      |
| --------------------------- | -------------------------------------------- |
| `version`                   | Required positive integer                    |
| `id`                        | Required stable source-mod id with no spaces |
| `name`                      | Required display name                        |
| `description`               | Optional text description                    |
| `dependsOn`                 | Optional source-mod dependencies             |
| `priority`                  | Optional integer ordering value, default `0` |
| `allowWriteToModifiedFiles` | Optional layering opt-in, default `false`    |
| `variables`                 | Optional shared template variables           |
| `enabled`                   | Optional, default `true`                     |
| `scripts`                   | Optional list of source-mod-level scripts    |
| `tempPaths`                 | Optional list of owned temp artifacts        |

### Practical Guidance

- keep `id` stable once other patches or tooling depend on it
- use `priority` only when ordering between source mods actually matters
- enable `allowWriteToModifiedFiles` only when later mods are intentionally designed to layer over earlier output
- put source-mod-wide generation logic in `scripts`, not inside unrelated patches

## 🩹 `ymb.patch.yaml`

This file defines one selectable patch.

Minimal example:

```yaml
version: 1
id: ui.branding.welcome_view
name: Welcome View Demo
description: Adds a small starter title to the out-of-game welcome view
enabled: true
scope: prod
dependsOn: []
variables:
  welcomeTitleToken: '${welcomeTokenPrefix}_T'
targets:
  - file: GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf
    operations:
      - op: add
        selector:
          kind: collection
          by: path
          value: UISpecificOutGameWelcomeDescriptor.Components
        value:
          $raw: |-
            BUCKTextDescriptor
            (
                TextToken = "${welcomeTitleToken}"
            )
```

### Field Reference

| Field         | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `version`     | Required positive integer                                |
| `id`          | Required globally unique patch id among selected patches |
| `name`        | Required patch name                                      |
| `description` | Optional description                                     |
| `enabled`     | Optional, default `true`                                 |
| `scope`       | Required, `prod` or `dev`                                |
| `dependsOn`   | Optional patch dependency list                           |
| `variables`   | Optional patch-local variables                           |
| `targets`     | Optional NDF patch targets                               |
| `scripts`     | Optional patch-level scripts                             |
| `tempPaths`   | Optional owned temp artifacts                            |

A patch must provide at least one `targets` or `scripts` entry.

## 🎯 Selection and Scope

Selection starts with enabled state and filters. Dependencies are resolved after that.

Scope rules:

- `prod` includes only patches with `scope: prod`
- `dev` includes both `prod` and `dev`

Dependency rules to remember:

- missing source-mod dependencies are hard errors
- missing patch dependencies are hard errors
- a patch dependency may use plain `patchId` or qualified `modId:patchId`
- cross-mod dependencies should use `modId:patchId`

> [!NOTE]
> A source mod or patch can still appear in the final plan even if you did not name it directly, because dependencies are added after the first filter pass.

## 🧱 Patch Targets

Each patch target points at one WARNO-relative file and applies one or more NDF operations.

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

Key rules:

- target paths must stay inside `GameData/` or `CommonData/`
- template expressions are allowed in paths and values
- operations run in order inside the target
- multiple selected patches may target the same output file

Read [NDF Operations Reference](ndf-operations.md) for the operation syntax.

## 📦 Replace Files

Anything under `config/replace/` is copied into output using the same relative path after template expansion.

Example source path:

```text
mods/my_pack/config/replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
```

Use replace files when you intentionally want whole-file ownership (like for brand new textures or entirely custom UI layout files).

> [!WARNING]
> Replacing whole files destroys your mod's update resilience. If you replace a core game file, you will be forced to manually resolve merge conflicts every time Eugen updates that file.

Prefer a patch instead when:

- you only need a focused change
- the target file moves often in game updates
- several features need to touch the same file safely over time

## 🛠 Scripts

Scripts can live at the source-mod level or the patch level.

```yaml
scripts:
  - path: generate-output.ts
    tests:
      - generate-output.test.ts
```

A script module must export either:

- a default function
- or a named `generate` function

It must return one object or an array of objects shaped like this:

```ts
{
  targetRelativePath: string;
  content: string | Uint8Array;
}
```

### Use a Script When

- the output is assembled from multiple inputs
- you need derived summary files
- you need binary output generation
- the result depends on earlier generated targets

### Prefer a Normal Patch When

- one selector and one value solve the problem cleanly
- a normal patch is easier to read and maintain

## ✅ Script Tests

YMB can run config-driven tests for source-mod and patch scripts.

They run automatically during:

- `validate`
- `build`
- `sync`

Use them to catch breakage from game updates, missing anchors, changed target paths, and invalid assumptions in your generation logic.

## 🧠 Variable Substitution

Template expressions using `${...}` work in:

- target paths
- target values
- nested `changes`
- replace paths
- supported replace-file content
- script config paths

Built-in variables always available:

- `modRootName`
- `modId`
- `modName`
- `modDescription`
- `patchId`
- `patchName`
- `patchDescription`

Read [Template Expressions Reference](template-expressions.md) for the full expression language.

## 🧹 Temp Artifacts

Mods and patches can declare owned temp artifacts through `tempPaths`.

Simple form:

```yaml
tempPaths:
  - .ymb-cache.json
```

Structured form:

```yaml
tempPaths:
  - path: .ymb-cache.json
    unsafeToRemove: true
```

Use `unsafeToRemove: true` for files that are rebuildable but important enough that safe cleanup should not remove them by accident.

## ✅ Recommended Conventions

- keep one logical concern per patch
- prefer many focused patches over one giant patch
- give source mods stable ids such as `my_pack`
- give patches descriptive ids such as `ui.branding.welcome_view`
- keep script tests near the script they protect
- run `validate` before every `sync --yes`
