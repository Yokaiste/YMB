# 7. Rebuild, recover, and share your mod

[All documentation](../README.md#beginner-course)

| Previous | You are here | Next |
| --- | --- | --- |
| [6. Add an optional training project](06-combine-projects.md) | Learn · 7. Rebuild, recover, and share your mod | [Documentation](../README.md) |

You now own a working project with a title, feature-owned text, adjustable health, and a separate training add-on. Finish by proving you can undo it and explaining how someone else can build it.

## Check the complete selection

From PowerShell inside YMB:

```powershell
.\YMB.exe list --mod tank_training
.\YMB.exe explain --mod tank_training
.\YMB.exe build --mod tank_training --require-all
```

On the tutorial data, the preview should contain a smaller title with its hint, M1A1 health of 18, and M1IP health of 15. Unrelated units retain their originals. Run `sync --mod tank_training --yes`, compile with `GenerateMod.bat`, and check the title and both regular tank variants in a fresh game.

## Undo and rebuild once

Preview recovery first:

```powershell
.\YMB.exe recover --mod first_mod --mod tank_training --dry-run
```

Read the listed paths. Recovery works on whole files, so the shared unit file loses both projects' changes. When that is the result you want:

```powershell
.\YMB.exe recover --mod first_mod --mod tank_training --yes
```

Check that the original unit file is restored. Compile to see the original behavior in WARNO. Then build and sync `tank_training` again and recompile. Your authored project survives recovery; you do not have to redo the lessons.

To keep only the base project, recover both projects, then build and sync `first_mod` and compile. The menu remains and both tanks return to 15 HP on the tutorial originals.

## Maintain it after a game update

Follow [update and recovery](../guides/update-and-recover.md#after-a-warno-update):

1. Back up the project and state; recover before refreshing game data.
2. Run WARNO's update script.
3. Build, inspect, sync, and compile. If a name changes, locate it with `find` and repair the authored rule.

For diagnosis, `validate` checks the project while keeping the existing preview. `build --no-cache` bypasses result caches. `cleanup --dry-run` lists disposable paths; it is not an undo command. A cache can be rebuilt. Your saved originals would prefer not to be treated as one.

## Hand someone a reproducible project

Ship both project folders for the add-on: config, assets, and a short README with the YMB requirement and exact selection. Exclude disposable caches; back up persistent identity stores if you add them later.

These YAML rules need no Rust. Direct users to the official YMB download; the builder has its own redistribution license.

For a playable Workshop release, use WARNO's manual and upload tools when ready to publish. Editable projects and compiled Workshop mods are separate deliverables. For automated installation, see the [native installer guide](../advanced/mod-releases.md).

Write these facts in your README:

| Reader's question | Your answer should include |
| --- | --- |
| What changes? | The title and the exact tanks affected; armor and weapons stay unchanged |
| Which version do I choose? | `first_mod` for base health, `tank_training` for the add-on |
| Where do I change health? | The base patch's `healthMultiplier` and the add-on's `trainingMultiplier` |
| How do I apply it? | Build, inspect, sync, compile, enable |
| How do I undo it? | Recover both contributing projects, then compile |

Credit [YMB](https://github.com/Yokaiste/YMB) with a working link and preserve the terms of any other material you include.

## Your next feature

Choose a third real unit with `find`. Inspect its original damage module. Add a named read under `readValues` and an entry under `variables.units`, following [the two-tank example](04-calculations.md#apply-the-calculation-to-two-tanks). Predict its original health × `1.5`, then build and check the preview. Then give your project a display name and description that explain what it actually does.

Look up new operations in [reference](../README.md#reference). Keep changes small enough to compare in the next match. Continue with YAML, or use the optional [advanced track](../README.md#advanced) for Rust generators and scripts.

### Keep learning

Use the installed game manual's **Uploading a mod** section when you choose to publish. For questions about game data, visit [WARNO's Steam modding forum](https://steamcommunity.com/app/1611600/discussions/1/). The [reading list](../resources.md) separates game references from optional programming material.

| Previous | You are here | Next |
| --- | --- | --- |
| [6. Add an optional training project](06-combine-projects.md) | Learn · 7. Rebuild, recover, and share your mod | [Documentation](../README.md) |
