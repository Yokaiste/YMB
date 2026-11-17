# 1. Put your title in WARNO

[All documentation](../README.md#beginner-course)

| Previous | You are here | Next |
| --- | --- | --- |
| [0. Meet your mod folder](00-warno-basics.md) | Learn · 1. Put your title in WARNO | [2. Change unit health](02-unit-health.md) |

Build one mod called MyFirstMod and add your title to its welcome screen. Keep the project for the next lessons, where you will change tank health and make it adjustable.

## Create the WARNO mod folder

1. In Steam, open WARNO's local files, then Mods. Read ReadMe.txt and modding_manual.pdf for the game tools.
2. Run `python3 --version` in PowerShell. WARNO's scripts need Python; YMB does not supply it.
3. If Windows opens the Store or cannot find Python, follow the game manual's Python 3 setup and reopen PowerShell.

Open PowerShell in Mods and run:

~~~powershell
.\CreateNewMod.bat MyFirstMod
~~~

The new MyFirstMod folder should contain GameData, CommonData, and GenerateMod.bat. Fix any creation error before continuing. Keep your work out of Mods/ModData, the game's clean template.

## Install YMB

Download the Windows x64 ZIP from [YMB releases](https://github.com/Yokaiste/YMB/releases/latest). Extract it into MyFirstMod. The archive contains the YMB folder, so the result should look like this:

~~~text
MyFirstMod/
├── CommonData/
├── GameData/
├── GenerateMod.bat
└── YMB/
    ├── YMB.exe
    ├── ymb.config.yaml
    ├── docs/
    ├── sdk/
    └── mods/
~~~

The beginner course needs no Rust compiler or programming setup. YMB runs as the downloaded executable; WARNO's own tools still compile the game data. Projects with precompiled generators can also run without Rust. Writing a generator is an optional [advanced lesson](../advanced/health-generator.md).

YMB creates `.ymb/` for installation data: build work, bounded caches, local overrides, and recovery records. The executable, SDK, projects, and commented root configuration stay outside it. Keep its state folder while files are synced. See [update and recovery](../guides/update-and-recover.md) before resetting installation data.

Open PowerShell inside YMB. Run:

~~~powershell
.\YMB.exe init --id first_mod --name "My First Mod"
.\YMB.exe doctor
~~~

Init creates mods/first_mod with a working welcome-screen patch. Doctor should report MyFirstMod as the WARNO mod folder. Correct the location or [paths.gameRoot](../references/configuration.md#builder-settings-ymbconfigyaml) if it reports another folder.

| Name | Meaning |
| --- | --- |
| MyFirstMod | WARNO's mod folder, which you enable in game |
| first_mod | The editable project under YMB/mods; use its id in commands |

Keep the id first_mod throughout the lessons. You can change the display name.

## Build the welcome screen

~~~powershell
.\YMB.exe build --mod first_mod
~~~

Open the preview CSV:

~~~text
YMB/.ymb/build/output/GameData/Localisation/MyFirstMod/INTERFACE_OUTGAME.csv
~~~

Its title row contains My First Mod. The key comes from titleToken in mods/first_mod/config/ymb.mod.yaml. Init assigns stable keys of at most ten characters; keep them when renaming your project.

Open `mods/first_mod/config/ymb.mod.yaml`. Init includes comments explaining its supported settings. Change the existing `name` entry, leaving the other settings in place:

~~~yaml
name: My Very Serious Mod
~~~

Keep indentation and localisation tokens unchanged. Build again. The same title row should now contain My Very Serious Mod.

Edit the source under mods. Rebuilding replaces the preview. YAML uses spaces for indentation and a colon between a key and its value.

## Apply it and launch WARNO

When the preview contains the title you want:

~~~powershell
.\YMB.exe sync --mod first_mod --yes
~~~

Sync rebuilds and applies files to MyFirstMod/GameData and CommonData. Originals go in YMB/.ymb/state.

Open PowerShell in MyFirstMod and run:

~~~powershell
.\GenerateMod.bat
~~~

Wait for WARNO's compiler to finish successfully. Launch WARNO, enable MyFirstMod in its mod menu, and follow any restart prompt. The welcome screen should show My Very Serious Mod.

If it does not, check the preview CSV, the sync result, the compilation result, and which mod is enabled, in that order. A preview alone does not change the game.

## Checkpoint: your title is visible

Continue with [the M1A1 Abrams' health](02-unit-health.md). Keep the title and its localisation in place.

Keep YMB/.ymb/state until you have recovered every synced file. [Recovery](../guides/update-and-recover.md#undo-a-sync) is optional, not a step between lessons.

| File under mods/first_mod/config | Purpose |
| --- | --- |
| ymb.mod.yaml | Project name, description, and stable localisation keys |
| patch/welcome/ymb.patch.yaml | Welcome-screen title and hover hint |
| replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv | Text template for the title and hint |

The source folder literally includes ${modRootName}. YMB replaces it with MyFirstMod in the output.

## Where to type commands

Use PowerShell inside `MyFirstMod/YMB` for the commands in this course. The `.\YMB.exe` command runs the executable in this folder.

You can also double-click `YMB.exe` for the dashboard. Choose projects by number or id, change scope or detail level, then choose a command by name or number. The `find` command prompts for its search filters. The course uses PowerShell so each example has one exact command to copy.

## If a command fails

Read the named file and suggested fix. Use list to see projects and explain --mod first_mod to check selection. The [workflow guide](../guides/troubleshooting.md) covers missing selectors, changed files, and recovery.

For help, post the command and error output in the troubleshooting forum in [YSM Community Discord](https://discord.gg/33Sqn6dTjf).

### Try it yourself

Give the title another name, rebuild, and predict whether its localisation key changes. It should keep the same key and only change the displayed text. Keep the project id `first_mod`.

- [ ] The preview CSV contains your title.
- [ ] Sync and WARNO compilation completed.
- [ ] The enabled mod shows your title on the welcome screen.

If only the first box is checked, the game is still waiting for the other two.

### If the terminal is new to you

Microsoft's [PowerShell getting-started guide](https://learn.microsoft.com/en-us/powershell/scripting/learn/ps101/01-getting-started) explains how to open it and read the prompt. The commands in this lesson are enough to continue; you do not need to learn scripting.

| Previous | You are here | Next |
| --- | --- | --- |
| [0. Meet your mod folder](00-warno-basics.md) | Learn · 1. Put your title in WARNO | [2. Change unit health](02-unit-health.md) |
