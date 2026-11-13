# 1. Put your name in WARNO

[Docs](README.md) / First mod · [Next: change a tank's health](ndf-operations.md)

You'll build one mod called `MyFirstMod` and add your own title to its welcome screen. Keep that project for the next lessons, where you'll change tank health and make it adjustable.

## Create the WARNO mod folder

In Steam, open WARNO's local files, then open `Mods`. Read `ReadMe.txt` and `modding_manual.pdf` there for the game's tool requirements. The Windows scripts use `python3`; the runtime bundled with YMB does not replace Python.

Open PowerShell in that `Mods` folder and run:

```powershell
.\CreateNewMod.bat MyFirstMod
```

The new `MyFirstMod` folder should contain `GameData`, `CommonData`, and `GenerateMod.bat`. If creation fails, fix the reported problem before continuing. Keep your work out of `Mods/ModData`, which is the game's clean template.

## Install YMB inside it

Download the full Windows archive from [YMB releases](https://github.com/Yokaiste/YMB/releases/latest). It is the archive whose name ends in `windows-x64.zip` and includes Bun, the runtime YMB needs.

The smaller `windows-x64-no-bun.zip` is for people who already manage Bun. It requires the exact version listed in the release on your `PATH`.

Extract the archive's `YMB` folder inside `MyFirstMod`:

```text
WARNO/
└── Mods/
    └── MyFirstMod/
        ├── CommonData/
        ├── GameData/
        ├── GenerateMod.bat
        └── YMB/
            ├── YMB.bat
            ├── ymb.config.yaml
            └── mods/
```

Double-click `YMB/YMB.bat`. Type the next commands in that window.

## Create the editable project

```text
init --id first_mod --name "My First Mod"
```

This creates `YMB/mods/first_mod/` with a working welcome-screen patch. Now run:

```text
doctor
```

Confirm that the reported WARNO mod folder is `MyFirstMod`. If it points elsewhere, correct the installation location or [`paths.gameRoot`](configuration.md#builder-settings-ymbconfigyaml) before continuing.

There are two names to keep straight:

| Name         | Where it belongs                                                    |
| ------------ | ------------------------------------------------------------------- |
| `MyFirstMod` | The WARNO mod folder; this is the mod you enable in game            |
| `first_mod`  | The editable project under `YMB/mods/`; use this id in YMB commands |

Keep the id `first_mod` throughout the lessons. Changing its display name is fine.

## Build the welcome screen

```text
build --mod first_mod
```

YMB checks the project and writes a preview. Open this file in a text editor:

```text
MyFirstMod/YMB/.ymb-build/output/GameData/Localisation/MyFirstMod/INTERFACE_OUTGAME.csv
```

You should find:

```csv
"FIRST_MO_T";"My First Mod"
```

The title comes from your project settings. Open:

```text
MyFirstMod/YMB/mods/first_mod/config/ymb.mod.yaml
```

Change the existing `name` line, leaving the other settings in place:

```yaml
name: My Very Serious Mod
```

Save and run `build --mod first_mod` again. The same preview CSV should now contain:

```csv
"FIRST_MO_T";"My Very Serious Mod"
```

Edit the file under `mods/`. A preview is regenerated on each build, so editing it is a reliable way to watch your work disappear.

YAML uses spaces to group settings. Keep the colon in `name: value` and use spaces for indentation. Tabs may look innocent; YAML remains unconvinced.

## Apply it and launch the game

When the preview contains your new title:

```text
sync --mod first_mod --yes
```

YMB rebuilds and applies the files to `MyFirstMod/GameData` and `CommonData`. It saves originals in `YMB/.ymb-state` so you can recover them later.

Open PowerShell in `MyFirstMod` and run:

```powershell
.\GenerateMod.bat
```

Wait for WARNO's compiler to finish successfully. Launch WARNO, open its mod menu, and enable `MyFirstMod`. Follow any restart prompt, then return to the main menu. The welcome screen should show **My Very Serious Mod**.

If the title is missing, check these in order:

1. The preview CSV contains the new title.
2. `sync --mod first_mod --yes` completed.
3. `GenerateMod.bat` completed after that sync.
4. `MyFirstMod` is the enabled mod.

YMB builds editable game files. `GenerateMod.bat` compiles them for WARNO. A successful preview alone won't change the game.

## Continue with the same project

Leave `first_mod` installed and `MyFirstMod` enabled. In [lesson 2, change the M1A1 Abrams' health](ndf-operations.md), you'll add a gameplay patch beside the welcome-screen patch.

Keep `YMB/.ymb-state`. If you want to stop and undo the changes, use the [recovery instructions](workflow.md#undo-a-sync); recovery is optional, not a step between lessons.

## Where the starter files live

| File under `YMB/mods/first_mod/config/`                              | What it does                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `ymb.mod.yaml`                                                       | Sets the project name and variables                       |
| `patch/ui/branding/welcome-view/ymb.patch.yaml`                      | Adds the title to the welcome screen                      |
| `replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv` | Supplies the title and tooltip text                       |
| `generate-build-info.ts`                                             | Generates a small NDF file recording the project identity |
| `generate-build-info.test.ts`                                        | Checks the generator's destination and text escaping      |

The `${modRootName}` folder is literally named that in the project. During a build, YMB replaces it with `MyFirstMod`. You'll use this existing text template in the configuration lesson.

### Where to type commands

| Location                                        | Example                             |
| ----------------------------------------------- | ----------------------------------- |
| Shell opened by `YMB.bat`                       | `build --mod first_mod`             |
| PowerShell inside `YMB/`                        | `.\YMB.bat build --mod first_mod`   |
| YMB source checkout with dependencies installed | `bun run ymb build --mod first_mod` |

Launcher shortcuts work interactively. Batch files and other programs should call `YMB.bat` with arguments. Type `exit` to close the YMB shell.

## If a command fails

Read the named file and suggested fix. `list` shows discovered projects; `explain --mod first_mod` explains why a patch is included or skipped. The [troubleshooting guide](workflow.md#when-something-goes-wrong) covers selectors, changed files, and recovery problems.

For help, post in the troubleshooting forum in [YSM Community Discord](https://discord.gg/33Sqn6dTjf), with the command and its error output.
