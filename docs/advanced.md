# Advanced workflows

[Docs](README.md) / Advanced workflows · [Generation scripts](script-tools.md)

Continue after the health script lesson. Your `first_mod` project should show its menu title and give the M1A1 and M1IP Abrams 15 HP from original values of 10. This page adds a second project that deliberately builds on those changes.

> [!CAUTION]
> Layering makes order part of the result. Check the combined preview before syncing, and keep saved originals and persistent identities backed up. A successful merge cannot tell you whether your balance is sensible.

## Keep features separate

The tutorial now has two independent features:

```text
mods/first_mod/config/
├── ymb.mod.yaml
├── generate-build-info.ts
├── replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
└── patch/
    ├── gameplay/health/
    │   ├── ymb.patch.yaml
    │   ├── scale-health.ts
    │   └── scale-health.test.ts
    └── ui/branding/welcome-view/ymb.patch.yaml
```

The welcome patch owns the menu title; `gameplay.health` owns HP changes. Leave them independent: changing a tank's health should not require a new title. The generated project information is registered in `ymb.mod.yaml` and remains a separate script.

If you moved the title CSV into the welcome patch's `assets/` folder in the configuration lesson, keep it there. That optional file move does not affect these health rules.

Put user choices in variables. Keep fixed file paths, format limits, and calculated values beside the code using them. Share a helper only when independent features need the same operation.

## Why something is in the build

Run:

```text
explain --mod first_mod
```

Selection filters are a starting point. YMB includes required dependencies, then orders projects and patches. Missing, disabled, and circular dependencies fail. Priority changes order; it cannot supply a missing prerequisite.

## Layering one mod over another

Create a small training add-on that increases only the M1A1's HP by another 20%. It will consume `first_mod`'s result: `10 × 1.5 × 1.2 = 18`. The M1IP stays at `15`.

### 1. Start from the tested health script

In `YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml`, set `healthPercent: 150` and `healthCap: 18`, with both Abrams names from the script lesson. That file must contain the script registration and no earlier YAML `targets` list.

Remove the tutorial's `mods.first_mod` and `mods.tank_training` entries from personal `YMB/ymb.config.yaml` overrides if present. Keep unrelated settings. This makes the project files below control the lesson.

### 2. Create the dependent project

Create `YMB/mods/tank_training/config/ymb.mod.yaml`:

```yaml
version: 1
id: tank_training
name: Tank Training
priority: 1
dependsOn:
  - first_mod
allowWriteToModifiedFiles: true
```

`dependsOn` brings `first_mod` into the selection. The higher priority puts this add-on later, and `allowWriteToModifiedFiles` lets it transform that project's output. It does not grant permission to edit the other project's source files.

Create `YMB/mods/tank_training/config/patch/health/ymb.patch.yaml`:

```yaml
version: 1
id: gameplay.training_health
name: Extra M1A1 health
scope: prod
dependsOn:
  - first_mod:gameplay.health
variables:
  trainingMultiplier: 1.2
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: bulk
        match:
          conditions:
            - on: name
              is: equals
              value: Descriptor_Unit_M1A1_Abrams_US
        edits:
          - field: MaxPhysicalDamages
            multiply: ${trainingMultiplier}
            minChanges: 1
        expect:
          minBlocks: 1
```

This patch requires the specific health feature, not just the presence of the project folder. A disabled prerequisite is an error; YMB will not silently calculate from a different starting point.

### 3. Check the combined result

```text
explain --mod tank_training
build --mod tank_training
```

The explanation should include `first_mod:gameplay.health` before `tank_training:gameplay.training_health`. In `.ymb-build/output/GameData/Generated/Gameplay/TacticalUnits.ndf`, check the `TBaseDamageModuleDescriptor` inside each exact unit block:

| Unit descriptor                  | Original HP | After `first_mod` | After `tank_training` |
| -------------------------------- | ----------: | ----------------: | --------------------: |
| `Descriptor_Unit_M1A1_Abrams_US` |          10 |                15 |                    18 |
| `Descriptor_Unit_M1IP_Abrams_US` |          10 |                15 |                    15 |

Your custom welcome title remains. `bulk` rounds an integer field's multiplied value to a whole number; keep the result positive when changing the multiplier. The 18-HP cap belongs to `first_mod`'s script, so a later writer can exceed it. For example, `trainingMultiplier: 2` produces 30 HP. A cap does not get the last word unless it runs last.

When the preview matches:

```text
sync --mod tank_training --yes
```

Run `GenerateMod.bat` in `WARNO/Mods/MyFirstMod`, then enable `MyFirstMod` in WARNO and check its M1A1. Both mod projects are compiled into that one WARNO mod folder. `tank_training` is not a second in-game checkbox.

To remove this add-on's extra HP, build and sync `first_mod` alone, then compile again. That rebuilds the shared `TacticalUnits.ndf` without the extra multiplier, returning the M1A1 to 15 HP. This works for this add-on because it changes only that shared file; it is not a general uninstall procedure for arbitrary projects.

## Dependencies and priorities

At mod level, `dependsOn` contains project ids, such as `first_mod`. At patch level, use a local patch id such as `gameplay.health`, or `modId:patchId` for another project, as above.

Use dependencies when a feature requires another feature's output. Use different `priority` values when independent projects need an explicit order. Lower priorities build first. The later writer still needs `allowWriteToModifiedFiles: true`; equal priorities without a dependency do not establish an order.

Only the later project needs the opt-in. It permits layering, not compatibility with every change. Inspect overlapping gameplay rules even when the files merge successfully.

## Multiple contributors to one file

The health lesson gives one feature clear ownership of HP changes. As a project grows:

- Order dependent file operations with patch dependencies.
- Use explicit layering when one project changes another's result.
- Use [generated blocks](script-tools.md#owning-part-of-a-file) when a script adds a region to a shared file.
- Give a whole-file replacement one clear owner.

YMB can combine non-overlapping text changes. Conflicting edits may need explicit layering or an interactive choice. Ambiguous generated ownership, unordered file-operation owners, and incompatible binary output fail.

For a broad balance rule, one `bulk` operation with narrow matching is usually cheaper than repeated scans. Set match counts that catch meaningful omissions. Dependent edits belong in separate operations because all edits inside one bulk operation see the same input.

## How scripts see each other

Scripts run in build order. Target readers can see earlier generated output and eligible prepared replacements or file operations. The health script reads `TacticalUnits.ndf` and returns its changed text at that same path. YMB records that read to distinguish a sequential transformation from an independent writer.

A script that writes a file it did not read contributes independent output. Across projects, reading and transforming earlier output also requires ordered layering. A higher-priority script can transform a lower project's replacement; a replacement in the same or a later layer remains reserved.

Keep output deterministic. Sort data whose order is otherwise unstable, and keep random or time-based values out of persistent identities.

## Cache and persistent state

| Disposable cache                 | Persistent project data                      |
| -------------------------------- | -------------------------------------------- |
| Parsed indexes                   | Allocated ids and GUID registries            |
| Computed analysis                | User-authored choices                        |
| Rebuildable intermediate results | Data needed to keep saved content compatible |

Use `context.tools.cache` for derived results. Include every input affecting the result in the key and validate the loaded shape. Use owned-file helpers for persistent state.

Deleting a cache should affect build time only. Deleting an identity registry can give new units or decks old saved references. Back up those registries even if their filename contains “generated.”

To rule out cached work:

```text
build --mod tank_training --no-cache --verbose
```

This recomputes cached work. It does not reset persistent project files.

## Replace ownership

Mod-level replacement files are copied after scripts run, so a script can update an owned file under `config/replace/` for that build. Returning output directly is simpler when the file does not need to persist as authored state.

Two replacements of one target conflict unless explicit layering resolves their order. Review replacements after game updates: they carry the whole file. The starter localisation template uses a replacement by default, or a patch-owned copy if you moved it in the configuration lesson. The HP script does not touch it.

## What recovery protects

The first sync saves original bytes for each target. Later builds use those originals instead of repeatedly scaling their installed output. Backup checksums detect damaged copies.

Recovery is file-based. Both tutorial health features share `TacticalUnits.ndf`. Recovering either contributor restores the whole file, including the other feature's changes. Preview recovery first; sync the remaining project afterward if you want to keep its changes.

Keep the state folder until its tracked changes have been recovered. If its manifest is missing or damaged, restore a trusted copy. `manifest.json.bak` may describe an earlier sync and omit newer files; it is not automatically safe to promote.

If YMB reports a stale `.reclaim` directory, confirm that every YMB command has stopped before removing the exact directory it names. Never clear a lock to make a second active build proceed.

## Keeping large projects fast

First narrow the build to the feature you are changing. Read a target once, pass text to helpers, and batch independent reads with `readTargets`. Avoid parsing a large file inside a loop. Measure before adding a cache.

The optional `settings` section in `ymb.config.yaml` controls runtime limits:

| Setting                             |      Default | Controls                                |
| ----------------------------------- | -----------: | --------------------------------------- |
| `cacheMaxEntries`                   |        `512` | Build-cache entry count                 |
| `cacheMaxBytes`                     | `1073741824` | Build-cache size                        |
| `cacheMaxAgeDays`                   |         `14` | Build-cache age                         |
| `scriptCacheMaxEntriesPerNamespace` |          `4` | Entries in one script cache namespace   |
| `scriptCacheMaxBytesPerNamespace`   |  `268435456` | Size of one script cache namespace      |
| `scriptTargetReadConcurrency`       |          `8` | Concurrent script target reads          |
| `scriptTimeoutSeconds`              |        `120` | Script execution time limit             |
| `mergeMaxEstimatedDiffWork`         |   `50000000` | Estimated merge comparison work         |
| `mergeMaxTextBytesPerSide`          |    `4000000` | One merge input's size                  |
| `mergeMaxTextBytesCombined`         |    `6000000` | Combined merge input size               |
| `markerMaxEstimatedDiffWork`        |    `2000000` | Estimated inline-marker comparison work |
| `markerMaxTextBytesPerSide`         |    `1000000` | One marker input's size                 |
| `markerMaxTextBytesCombined`        |    `1500000` | Combined marker input size              |

All limits must be positive integers. Check your configured values in `ymb.config.yaml`; `doctor` checks paths, runtime, and saved state.

When a comparison exceeds its merge budget, automatic merging may need explicit layering or an interactive winner selection. When inline-marker comparison exceeds its budget, output keeps whole-file markers without inline detail. Inspect the result before raising limits.

For a known large file, adjust the relevant ceiling:

```yaml
version: 1
settings:
  mergeMaxTextBytesPerSide: 60000000
  mergeMaxTextBytesCombined: 120000000
```

Larger budgets permit more memory and comparison work. Raise the limit named in the diagnostic, measure the result, and keep it finite.

## Automate a release check

Build the selection you intend to ship with `--require-all`. Inspect its structured [JSON results](workflow.md#scripting-ymb), then compile and test the playable mod. For this lesson, select `tank_training` to include its `first_mod` dependency.

Test risky generation rules with small invented inputs. Useful checks cover stable ids, missing objects, malformed settings, and preserving another feature's data. Avoid tests that merely repeat implementation details or freeze descriptive text.

Share the mod project and installation instructions according to its license. Credit dependencies where required. YMB and individual mod projects have separate licenses; distributing one does not grant rights to redistribute the others.

## Learn more

- The [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) covers the language used by generation scripts. Its introduction links beginner JavaScript material.
- The [YAML language overview](https://yaml.org/spec/1.2.2/#chapter-2-language-overview) explains mappings, sequences, and scalar values.
- [Bun's installation guide](https://bun.sh/docs/installation) covers runtime setup for the archive without Bun. Follow the YMB release's exact version requirement.
- WARNO ships `Mods/modding_manual.pdf` and `Mods/ndf_reference_manual.pdf` for compilation and NDF.
