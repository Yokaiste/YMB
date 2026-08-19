# How a Build Works

Four commands, always in this order:

```mermaid
flowchart LR
    A["<b>doctor</b><br/>right folders?"] --> B["<b>validate</b><br/>any mistakes?"]
    B --> C["<b>build</b><br/>write a preview"]
    C --> D["<b>sync --yes</b><br/>install it"]
    D -.->|changed your mind| E["<b>recover --yes</b><br/>put it back"]
```

> **Your game is safe until step 4.** `doctor`, `validate`, and `build` never touch
> `GameData` or `CommonData`. Only `sync` does, and it saves the originals first.

## The four commands

### 1. `doctor` — am I pointed at the right place, and what is installed?

Prints every folder YMB will read from and write to. If a path looks wrong, stop here;
nothing else will make sense until it is right.

It also reports the state of what you have already installed:

| Line                 | Means                                                             |
| -------------------- | ----------------------------------------------------------------- |
| `installed`          | How many files are synced, and which mods own them.               |
| `changed since sync` | A synced file holds content YMB cannot account for.               |
| `back to original`   | A synced file is back at its untouched game bytes.                |
| `missing backup`     | A tracked original is gone, so `recover` cannot restore that one. |
| `bun`                | The runtime in use, and whether it satisfies this build.          |

`changed since sync` is the one to read carefully: it stops the next `sync` until you
either preserve the edits or run `sync --yes --reset-changed`. `back to original` needs
nothing from you — that is usually `GenerateMod.bat` or a WARNO update rewriting a file
it owns, and the next `sync` applies over it again. **Run `doctor` first when something
refuses to sync** — it names the files before anything else does.

### 2. `validate` — is anything broken?

Reads your configs, applies your patches in memory, runs your script tests, and checks
the result is valid NDF. **Writes nothing.** This is the fast way to catch mistakes.

### 3. `build` — show me the finished files

Produces exactly what would be installed, in a folder you can open:

```text
YMB/.ymb-build/output
```

Open it. Read the files you changed. This is your review step.

When a patch removes live files, the preview includes `.ymb-deletions.json` with the
exact sorted paths. No live file is removed until `sync --yes`.

### 4. `sync --yes` — install it

Copies the reviewed result into `GameData` and `CommonData`, applies reviewed deletions,
and saves the untouched originals under `YMB/.ymb-state`.

`--yes` is required, because this is the one command that changes your game.

## Undo a sync

```text
recover --yes
```

Puts the original files back and removes files YMB created.

> **Keep `YMB/.ymb-state`.** That folder is the undo history. Deleting it means
> `recover` can no longer restore anything.

Recover only part of a build:

```text
recover --mod my_pack --yes
recover --patch ui.branding --yes
```

## Working on part of a project

| Option            | What it does                                                                | Available on                          |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| `--mod <id>`      | Only this mod. Repeat for several.                                          | every command except `init`           |
| `--patch <id>`    | Only this patch. Repeat for several.                                        | every command except `init`           |
| `--scope dev`     | Include development patches as well as normal ones.                         | every command except `init`           |
| `--verbose`       | List every line, not only the ones worth acting on.                         | every command except `init`           |
| `--no-cache`      | Redo all work instead of reusing cached results.                            | `validate`, `build`, `sync`           |
| `--require-all`   | Hold optional patches to the same standard as the rest.                     | `validate`, `build`, `sync`           |
| `--dry-run`       | Show what would happen without writing anything.                            | `build`, `sync`, `recover`, `cleanup` |
| `--yes`           | Confirm a command that changes files.                                       | `sync`, `recover`, `cleanup --all`    |
| `--reset-changed` | Put the saved original back over any tracked file that changed outside YMB. | `sync`, `recover`                     |
| `--ymb-path <p>`  | Work on a YMB folder other than the one you are in.                         | every command, including `init`       |
| `--json`          | Print one JSON result instead of readable text.                             | every command, including `init`       |

```text
validate --mod my_pack
build --patch ui.branding
build --scope dev --verbose
```

`--mod` and `--patch` match an id or a display name exactly, so a near miss selects nothing
rather than something smaller. When a value matches nothing, the command says so and names
what it did find. It is a warning, not a failure: one command line reused across installs
may legitimately name a mod that is not on all of them.

`init` takes none of the selection filters — it creates a mod rather than selecting one.
It accepts `--id`, `--name`, `--description`, `--ymb-path`, and `--json`.

Anything your selection depends on is added automatically. A missing or disabled
dependency stops the build with an error naming it.

## Reading the progress line

The first time you run a command with a given selection, YMB has nothing to go on, so it
measures instead of guessing. There is no estimate on that run — only what is actually
known, which is how long it has been going:

```text
YMB build  [====>.........]  28%  12.30s
```

It remembers how long each step took. From the next run of that same command and
selection the bar is weighted by those measurements, so it spends its time where the work
is, and the estimate is a real one:

```text
YMB build  [=========>....]  61%  19.80s  eta 12s
```

If a run turns out slower or faster than the one before it — a busy machine, or a cache
that now answers most of the work — the estimate moves to match while the run is still
going, however large the difference.

Terminals that cannot redraw a line get one line per finished step instead, plus the
elapsed time and estimate while a long step is still running.

A different command, a different selection, `--no-cache`, and a first build into an empty
cache are all different amounts of work, so each measures itself once before it can
estimate. Only runs that finish are recorded; a run you interrupt or that fails partway
never becomes the estimate for the next one. The measurements live under `.ymb-build` and
are safe to delete — the next run measures again.

## Scripting YMB

`--json` prints exactly one JSON document on stdout and nothing else: no banner, no
progress animation, and no truncation. Every command uses the same envelope, so a caller
can check `ok` before knowing anything else:

```json
{
  "ymb": "<the version you are running>",
  "command": "build",
  "ok": true,
  "selection": {
    "scope": "prod",
    "mods": ["my_pack"],
    "patches": [],
    "dryRun": false,
    "useCache": true
  },
  "summary": { "wrote": "12 files, 4 patched files", "took": "2.7s" },
  "locations": [{ "label": "preview", "path": "...\\.ymb-build\\output" }],
  "nextSteps": ["Open the preview folder and inspect the files you changed."],
  "details": ["patched  GameData/Generated/Gameplay/Units.ndf"]
}
```

A failure is the same shape with `"ok": false`, an `errors` array, and `errorCount`. Each
entry holds `category`, `reason`, `suggestion`, and the file, mod, patch, and operation it
came from. It is always an array, even for a single problem, so a caller never has to
branch on the shape; `errorCount` is higher than `errors.length` only when a run found
more problems than one report prints. **The exit code still says whether it worked** —
`0` or `1` — so a script can branch on that and read the document for detail.

`details` is always complete under `--json`. `--verbose` affects readable output only.

## Other commands

| Command               | Use it to                                                       |
| --------------------- | --------------------------------------------------------------- |
| `list`                | See the mods and patches YMB found.                             |
| `explain`             | Find out why a patch was skipped.                               |
| `find`                | Search the game files for a block, to write a selector for it.  |
| `init`                | Create a starter mod to learn from.                             |
| `cleanup`             | Delete previews and caches. Keeps your undo data.               |
| `cleanup --all --yes` | Also delete the undo data. Only when you are done with the mod. |

## After a WARNO update

A game update replaces the files your patches change, so put the originals back first:

```text
recover --yes
```

Update the WARNO mod with the game's own tools, then:

```text
doctor
validate
build
```

Features marked [`optional`](configuration.md#optional-features-built-on-game-data-that-may-not-be-there)
drop out on their own when the game data they were built on is gone, and the run says which
ones. Add `--require-all` when you want to see those as failures instead.

If a selector no longer matches, `validate` names the patch and the target. It keeps going
after the first problem and reports **every** independent one it found — numbered, each
with its own reason, fix, file, mod, and patch — so a game update that moved several files
is one round of edits rather than one run per file. Focused patches usually survive
updates; whole-file replacements usually do not.

An update can also make a patch redundant rather than broken — it ships the value the patch
was setting, or retires the block it was deleting. That is not a failure, so the run
finishes and counts a `warning` for each one, naming the `ymb.patch.yaml` line to open.
Those are the operations you can now delete. See
[when the game already says it](ndf-operations.md#when-the-game-already-says-it) for the
full list, and for why a patch you have already synced never triggers one.

## When something goes wrong

Work through [if you are stuck](getting-started.md#if-you-are-stuck), then fix your
**source mod** and build again — never the preview, which is regenerated every build.

If YMB reports that it rolled back an interrupted operation, your files were restored to
their previous state. Read the listed files, then run the command again.
