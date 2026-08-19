# YMB Documentation

New to YMB? Read these in order. Each one builds on the last.

|  #  | Guide                                       | What you get                                                 |
| :-: | ------------------------------------------- | ------------------------------------------------------------ |
|  1  | **[Getting started](getting-started.md)**   | Install YMB and ship your first change, with no coding.      |
|  2  | **[How a build works](workflow.md)**        | The four commands, and why your game is safe until the last. |
|  3  | **[Configuration](configuration.md)**       | Every setting, plus file operations and replace files.       |
|  4  | **[Changing NDF files](ndf-operations.md)** | Pick the exact thing to change, and change it.               |
|  5  | **[Variables](template-expressions.md)**    | Write a value once and reuse it everywhere.                  |
|  6  | **[Generation scripts](script-tools.md)**   | Build output with code when config is not enough.            |
|  7  | **[Advanced topics](advanced.md)**          | Layering, caching, recovery, and the awkward edges.          |

## I just want to…

| Goal                              | Go to                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Install YMB                       | [Getting started → Install](getting-started.md#1-install-ymb)                                           |
| Make my first change              | [Getting started → First change](getting-started.md#4-make-your-first-change)                           |
| Undo what I installed             | [How a build works → Undo](workflow.md#undo-a-sync)                                                     |
| Find what a block is called       | [Changing NDF files → Finding the name](ndf-operations.md#finding-the-name-to-select)                   |
| Change one number in the game     | [Changing NDF files → Modify](ndf-operations.md#modify-change-a-value)                                  |
| Change hundreds of things at once | [Changing NDF files → Bulk](ndf-operations.md#bulk-change-many-blocks-at-once)                          |
| Repeat the same edits over a list | [Changing NDF files → forEach](ndf-operations.md#foreach-the-same-operations-for-every-entry-in-a-list) |
| Add, copy, or remove assets       | [Configuration → File operations](configuration.md#file-operations)                                     |
| Understand an error               | [Getting started → When something breaks](getting-started.md#when-something-breaks)                     |
| Combine two mods                  | [Advanced → Layering](advanced.md#layering-one-mod-over-another)                                        |

## Reading the terminal

Every command ends with the same shape, so you always know where to look:

```text
[ok] Validation complete

  Checked    8 patch targets, 1 script output, 1 script test
  Took       2.7s
  Selection  my_pack, all patches, prod patches only

Next
  Run `build` to write a preview.

Checks (1 of 10)
  skipped    ui.branding (no `GameData/Generated/UISpecificTextures.ndf` in this install)
  Re-run with --verbose to see all 10 lines.
```

| Part               | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `[ok]` / `[x]`     | Did it work.                                                     |
| The indented block | What happened, and where.                                        |
| `Next`             | What to run now.                                                 |
| The final list     | Only what is worth reading — see below. `1 of 10` says how many. |

**The final list is not a file list.** A file that was patched, replaced, generated, or
left unchanged is counted in the block above and nothing more; the list holds what you
might have to act on — a skipped patch, a warning, a file kept back or refused. A run
with nothing to report says so. `--verbose` turns the list into every line the run
produced, and neither view is ever cut short.

`list`, `explain`, `doctor`, and `find` always print their whole list, because there the
list _is_ the answer. So does any `--dry-run`, where the plan is the point.

### `warning` and `note`

A **`warning`** is something worth looking at. A **`note`** is YMB telling you it did
the only thing it could.

The common note is `output without in-file markers`. YMB normally stamps a small comment
into each file it writes so it can tell later whether you edited it by hand. A PNG, an
exact byte copy, or a file type with no comment syntax cannot hold a comment — so those
files are tracked by backup instead, and counted rather than listed. Add `--verbose` to
see which files they were.

A pack full of images will show a large note count and **zero** warnings. That is a
healthy build.

Errors use the same shape, with a **`Fix`** line telling you what to do — see
[reading an error](getting-started.md#when-something-breaks).

Run `help` or `<command> --help` in `YMB.bat` for the built-in reference.
