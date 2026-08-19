<div align="center">

# YMB — Yokaiste's Mod Builder

### Build ambitious WARNO mods without redoing your work after every game update.

[![Download](https://img.shields.io/badge/⬇_Download-Latest_Release-16a34a?style=for-the-badge)](https://github.com/Yokaiste/YMB/releases/latest)
[![Docs](https://img.shields.io/badge/📖_Read-The_Guide-f59e0b?style=for-the-badge)](docs/README.md)
[![WARNO](https://img.shields.io/badge/🎮_For-WARNO-6d28d9?style=for-the-badge)](https://store.steampowered.com/app/1611600/)
[![License](https://img.shields.io/badge/⚖_License-Source_Available-2563eb?style=for-the-badge)](LICENSE)
[![Toolkit](https://img.shields.io/badge/🧰_Restore_Decks_&_Combine_Mods-Yuri's_WARNO_Toolkit-15803d?style=for-the-badge)](https://github.com/dary1337/yuri-warno-toolkit)

**No coding required to start.** &nbsp;•&nbsp; **Your game is never touched until you say so.** &nbsp;•&nbsp; **One command to undo everything.**

</div>

---

## The problem

You edit WARNO's generated files directly. It works — until it doesn't.

| Editing files directly              | With YMB                                       |
| ----------------------------------- | ---------------------------------------------- |
| 😖 A game update wipes your work    | ✅ Your changes re-apply to the new files      |
| 😖 "What did I even change?"        | ✅ Every change is one readable line of config |
| 😖 Two features fight over one file | ✅ Conflicts are detected and explained        |
| 😖 One typo breaks the whole mod    | ✅ Checked before anything is installed        |
| 😖 No way back                      | ✅ `recover --yes` restores the originals      |

**YMB never edits the game directly.** You describe _what_ to change; YMB works out _how_,
shows you the result, and only installs it once you approve.

---

## How it works

```mermaid
flowchart LR
    A["✍️ You write<br/><b>one small change</b>"] --> B["🔍 <b>validate</b><br/>catches mistakes"]
    B --> C["📦 <b>build</b><br/>preview you can read"]
    C --> D["🚀 <b>sync</b><br/>installs it"]
    D -.->|any time| E["↩️ <b>recover</b><br/>undoes it"]
    style A fill:#1e293b,color:#fff
    style D fill:#166534,color:#fff
    style E fill:#7c2d12,color:#fff
```

Instead of rewriting a 27 MB game file, you say which value to change:

```yaml
- op: modify
  selector:
    kind: field
    by: path
    value: Descriptor_Unit_T80U.FrontArmor
  value: 7
```

When WARNO updates, that instruction still finds the right unit. **A copied file would not.**

---

## Install

> **Requires:** Windows and a WARNO mod folder made with the game's `CreateNewMod.bat`.

1. **Download** the [latest release](https://github.com/Yokaiste/YMB/releases/latest).
2. **Extract** the `YMB` folder into your mod, beside `CommonData` and `GameData`.
3. **Double-click** `YMB/YMB.bat`.
4. **Type** `doctor` and check the folders it lists.

```text
<WARNO>/Mods/YourMod/
├── CommonData/
├── GameData/
└── YMB/          ← extract here
    ├── YMB.bat   ← double-click this
    └── mods/     ← your work goes here
```

---

## Your first mod, in three minutes

Inside `YMB.bat`:

```text
init --id my_pack --name "My Pack"
```

That writes a small **working** example — a patch, a replaced file, a script, and a test —
so you can see every piece in context. Then:

```text
validate --mod my_pack     # anything broken?
build --mod my_pack        # write a preview you can read
sync --mod my_pack --yes   # install it
```

Changed your mind?

```text
recover --mod my_pack --yes
```

👉 **[Full walkthrough, no coding needed →](docs/getting-started.md)**

---

## What you can build with

<table>
<tr>
<td width="50%" valign="top">

### 🎯 Focused patches

Change one field, add one list entry, remove one block. Survives game updates.

</td>
<td width="50%" valign="top">

### 🔁 Bulk rules

"Every missile gets double range." One rule, hundreds of blocks, with safety limits.

</td>
</tr>
<tr>
<td valign="top">

### 📁 File operations

Add, copy, refresh, or remove files and directories. `config/replace` remains the
short mod-wide form.

</td>
<td valign="top">

### ⚙️ Generation scripts

Write TypeScript when config is not enough. Ships with NDF tools and caching.

</td>
</tr>
<tr>
<td valign="top">

### 🧩 Variables

Define a number once, use it across every patch and file.

</td>
<td valign="top">

### 🧪 Script tests

Companion tests run automatically on every validate, build, and sync.

</td>
</tr>
</table>

---

## Safety, in plain terms

| ✅ Guaranteed                     | Detail                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| **Nothing installs by surprise**  | `sync` and `recover` refuse to run without `--yes`.                  |
| **You review before you install** | `build` writes a preview you can open and read.                      |
| **Originals are kept**            | `sync` saves every file it replaces, so `recover` can restore them.  |
| **Your manual edits are noticed** | YMB refuses to overwrite a synced file you changed by hand.          |
| **Broken output never ships**     | NDF is checked before and after every patch.                         |
| **Interruptions roll back**       | A crashed sync is undone on the next command, not left half-applied. |
| **Writes stay inside the mod**    | Output can only land under `GameData` or `CommonData`.               |

> ⚠️ **One thing YMB cannot check for you:** generation scripts are real programs and run
> on your machine. Only use source mods you trust.

---

## Commands

| Command         | What it does                                       |
| --------------- | -------------------------------------------------- |
| `doctor`        | Check the folders, and what is currently installed |
| `init`          | Create a starter mod to learn from                 |
| `list`          | Show the mods and patches YMB can see              |
| `explain`       | Say why a patch was included or skipped            |
| `find`          | Search the game files for a block to target        |
| `validate`      | Check for mistakes. Changes nothing                |
| `build`         | Write the finished files to a preview folder       |
| `sync --yes`    | Install the built files into your game mod         |
| `recover --yes` | Undo a sync and restore the originals              |
| `cleanup`       | Delete temporary files, keep the undo data         |

Add `--mod`, `--patch`, `--scope dev`, or `--verbose` to any of them except `init`.
`--dry-run` and `--no-cache` apply to the commands that would write or cache — run
`help` or `<command> --help` for the exact list.

Scripting something? **`--json`** works on every command and prints one machine-readable
result instead of text. See [How a build works → Scripting YMB](docs/workflow.md#scripting-ymb).

---

## Documentation

|                                                     |                                               |
| --------------------------------------------------- | --------------------------------------------- |
| 🚀 **[Getting started](docs/getting-started.md)**   | Install and ship your first change, no coding |
| 🔄 **[How a build works](docs/workflow.md)**        | The four commands and the safety model        |
| ⚙️ **[Configuration](docs/configuration.md)**       | Every setting, explained                      |
| 🎯 **[Changing NDF files](docs/ndf-operations.md)** | Selectors and operations                      |
| 🧩 **[Variables](docs/template-expressions.md)**    | `${...}` expressions and helpers              |
| 📜 **[Generation scripts](docs/script-tools.md)**   | The `ymb/api` reference                       |
| 🧠 **[Advanced topics](docs/advanced.md)**          | Layering, caching, recovery internals         |

---

## License

Source-available under a custom license — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

**In plain language:**

- ✅ Use YMB for what it is for, including mods you sell
- ✅ Build and publish whatever you like with it
- ✅ Modify your own copy, and modify it to send a contribution back
- ❌ Do not redistribute YMB itself, or modified copies, without written permission
- 📣 If you publish a mod built with YMB, credit YMB visibly with a working link
- 🤝 Contributions you submit may be used and relicensed as part of YMB

> This list is a summary. The [LICENSE](LICENSE) is what actually applies.

**Third-party software.** YMB bundles [commander](https://github.com/tj/commander.js),
[yaml](https://github.com/eemeli/yaml), and [zod](https://github.com/colinhacks/zod), and the
full archive also ships the [Bun](https://bun.sh) runtime. Each stays under its own license,
listed with a link to its terms in `THIRD-PARTY-NOTICES.md` inside every release.

<div align="center">
<br>

**Questions, bugs, or ideas → [Discord](https://discord.gg/33Sqn6dTjf)**

</div>
