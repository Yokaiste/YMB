# Commands and JSON output

[All documentation](../README.md#reference)

| Previous | You are here | Next |
| --- | --- | --- |
| [Generator SDK and execution](generators.md) | Reference · 5/7 · Commands and JSON output | [Errors, warnings, and message codes](message-codes.md) |

Run ymb --help or ymb COMMAND --help for current options.

[Commands](#commands) · [Filters and write options](#filters-and-write-options) · [Interactive menu](#interactive-menu) · [Rust setup](#rust-setup) · [JSON contract](#json-contract) · [Option availability](#option-availability)

## Commands

| Command                  | Result                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| init --id ID --name NAME | Creates a starter project without overwriting an existing folder                                                       |
| doctor                   | Inspects roots, tracked files, checksums, locks, and pending recovery                                                  |
| list                     | Lists selected projects and patches; add `--verbose` for generator details                                             |
| explain                  | Explains enabled states, scope, filters, and required dependencies                                                     |
| find                     | Searches NDF objects in selected targets                                                                               |
| validate                 | Runs patches, generators, tests, and final syntax checks without saving authored writes                                |
| build                    | Saves a complete local preview and successful generator-owned writes                                                   |
| release                  | Saves project archives and eligible deploy EXEs in each project's dist folder                                          |
| sync                     | Saves the local preview and originals, then applies files and deletions                                                |
| recover                  | Restores selected whole files from saved originals                                                                     |
| cleanup                  | Deletes disposable work, selected mods' session caches, and configured temporary paths; retains mod persistent storage |
| install-rust             | Downloads and verifies portable Rust from official sources in .ymb/engine                                              |

Release files stay in local `dist` folders. YMB never uploads files, pushes Git changes, or creates GitHub releases. The separate GitHub workflow handles uploads.

Doctor reports external edits and pending recovery as error findings. It inspects without restoring files. Check `diagnosticCounts.error` as well as command status when using JSON.

## Filters and write options

| Option          | Behavior                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------- |
| --mod           | Id or project name; repeat to select several                                                   |
| --patch         | Id, name, or modId:patchId; repeat to select several                                           |
| --scope prod    | Normal patches                                                                                 |
| --scope dev     | Normal and development patches                                                                 |
| --ymb-path PATH | Another builder installation                                                                   |
| --verbose       | Detailed human reports; plain progress on stderr when combined with `--json`                   |
| --no-cache      | Bypass result-cache reads and writes; Cargo still reuses compilation                           |
| --require-all   | Fail if an optional patch is missing                                                           |
| --dry-run       | Run checks without saving a preview, authored files, or game changes; generators still execute |

Filters ignore case. Configuration keys under `mods` and `patches` use the exact authored ids. Required dependencies are included even when a filter omits them.

Build, validate, sync, release, cleanup, and searches of selected targets reject unknown filters with E1 and keep the previous preview. A patch filter must match a patch in the selected projects or their required dependencies. List and explain warn about unmatched filters and expose `unmatchedFilters` in JSON. An explicit `find --file` searches those files without project discovery.

Recovery matches filters against the contributors saved when files were synced. It rejects unknown filters and combinations that match no tracked files before restoring selected files. With no tracked files, recovery succeeds without changes. Run `doctor --verbose` to see file paths and contributor ids. Patch names work for records saved by this version; older records support patch ids and `modId:patchId`.

Sync refuses to remove excluded contributors from a shared tracked file. Include every contributor in the sync selection, or recover the shared files before syncing a different combination. Disabling a feature and syncing its whole project still removes that feature's output.

Sync, recover, and cleanup require --yes outside an interactive session. Interactive confirmation lists the effects first. Its [Y/N] prompt accepts Y or yes, ignoring case; any other answer, empty line, or closed input cancels.

Dry runs show affected files and folders. Compact reports show up to eight paths per group; use `--verbose` for the complete list.

> [!WARNING]
> --reset-changed discards external edits to tracked targets. Save them first. Cleanup --all also removes recovery data and refuses while tracked files still need their originals.

## Interactive menu

Run YMB without arguments in a terminal. Choose a command by name, shortcut, or unique prefix, then press Enter. Projects and scope stay selected until changed.

| Input                         | Result                                             |
| ----------------------------- | -------------------------------------------------- |
| 1 through 9, then letters     | Listed shortcuts; letters ignore case              |
| H / 0                         | Help / exit                                        |
| `b` / `bu`                    | Project selection / build; shortcuts take priority |
| Project id                    | Select a project; letter choices after 9 skip H    |
| `1 --mod wto --dry-run`       | Run a shortcut with options                        |
| `build --mo wto --sc dev`     | Use unique command and long-option prefixes        |
| `build --help`                | Command help                                       |
| `find`                        | Prompt for search filters                          |
| `find --name tank --limit 10` | Search with supplied filters                       |

Action options apply once; the next action keeps the menu preferences. Ambiguous prefixes ask for more letters. Invalid commands, options, and fixed-choice values suggest matching prefixes first, then closest spellings. Suggestions never start work.

Quote values with spaces: `init --id sample --name "Sample mod"`. Single and double quotes work; Windows backslashes stay intact. Double a quote inside a quoted value to include it literally.

### Reading the display

The dashboard shows your selection, applied file count, saved preview, next action, preferences, and object search. Reports end with the outcome and error/warning totals.

| Progress mark | Meaning                      |
| ------------- | ---------------------------- |
| `[OK]`        | Stage completed successfully |
| `[/]`         | Current stage                |
| `[!]`         | Failed attempt               |
| `[ ]`         | Work still to do             |

Progress shows the stage's [X/X] position, elapsed time, and surrounding steps. Discovery adds needed steps, dry runs omit writes, and retries reset affected markers.

Normal reports group problems, show the affected feature or location and a suggested fix when available, and give the next action. Skipped features include their cause; merge conflicts include the comparison folder. Successful builds show the saved preview path. List includes selected patch ids; use [D] or --verbose for generator ids, all affected targets, file inventories, storage paths, and performance details.

`NO_COLOR` disables colors; `TERM=dumb` disables decoration. Redirected output stays plain.

## Rust setup

Use `[R] install-rust` to check or set up Rust. If a generator needs a compiler and YMB cannot find one, the menu offers automatic setup, manual installation, or cancellation. Patches and precompiled generators work without Rust.

| Invocation                      | Effect                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `--install-rust` with an action | Permit portable setup if compilation needs it; works in scripts and JSON mode |
| `--install-rust` alone          | Install directly                                                              |
| `install-rust --json`           | Install directly without prompts                                              |
| `--yes` alone                   | Confirm writes; does not authorize installing Rust                            |

Setup leaves system PATH and the default Rust toolchain unchanged. Explicit installation rejects `--dry-run`. A dry-run build with `--install-rust` can install Rust to run its checks.

```powershell
.\YMB.exe install-rust --json
.\YMB.exe build --mod my_mod --install-rust --json
```

## Command examples

    .\YMB.exe find --file GameData/Generated/Gameplay/TacticalUnits.ndf --name infantry --limit 20
    .\YMB.exe find --file GameData/Generated/Gameplay/TacticalUnits.ndf --type TEntityDescriptor --field ClassNameForDebug=Unit_M1A1
    .\YMB.exe sync --mod pack_a --mod pack_b --dry-run --json

An explicit find --file skips unrelated project discovery. Doctor works with broken project configuration too.

`find --field "Name=Text"` matches the exact direct field name and searches its written value for text, ignoring case. Spaces around `=` are allowed. It does not search nested fields.

Each file is searched once, including when repeated paths differ in letter case or use `./`.

## JSON contract

`--json` writes one document to stdout and disables prompts. It works before or after the command, with help, and with parse errors. Add `--verbose` to show plain progress on stderr. Build, validate, and sync also show NDF targets and generator work. Parse stdout for the result.

Reported Windows paths omit the extended-length prefix when an ordinary path has the same meaning and fits the Windows path limit. Long paths and names that require the prefix retain it. Internal file operations continue to use the resolved paths.

When compilation needs Rust, unattended commands return E38, exit code 1, and
`status: error`, with requiredVersion, installCommand, and installOption in the
diagnostic. `--install-rust` installs and retries the same action. Installation
failure returns E39. The previous preview remains available in either case.

| Envelope field                             | Contents                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| schemaVersion, ymbVersion, command, status | Contract version, app version, command, outcome                                                      |
| durationMs, selection                      | Timing and selection for executed commands                                                           |
| data                                       | Successful results                                                                                   |
| errors                                     | category, reason, suggestion; available path, source location, owner, operation, and related details |

| Exit status | Meaning               |
| ----------- | --------------------- |
| 0           | Success               |
| 1           | Execution failure     |
| 2           | Invalid CLI arguments |

Versions come from root Cargo.toml. Use status and exit status for automation. Human summary text can change; your script should survive a rewritten sentence.

Parse errors include the rejected `input` and a ranked `suggestions` array on
the error when matching candidates are available. `--json` and its unambiguous
prefixes also work for invalid input; stdout remains one JSON document and no
confirmation prompt is shown.

### Command result fields

| Commands              | Fields                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Build, validate, sync | data.outputs; changedFiles, warnings, notices, tests, skippedPatches, metrics, previewPath, recoveredInterruptedOperation |
| Each output           | targetRelativePath, state (present or absent), contentHash, bytes, sourceType, contributors                               |
| List, explain         | projects, explanations, unmatchedFilters                                                                                  |
| Find                  | totalMatches, matches; compare total with array length to detect the display limit                                        |
| Recover               | Restored paths in files                                                                                                   |
| Doctor                | `trackedFiles` maps paths to their state; `trackedContributors` maps paths to saved project and patch identities           |
| Release               | `data.releases`: `modId`, `version`, `dist`, `archive`, nullable `deploy`                                                 |

`previewPublished` means the preview was saved locally.

Every result also includes a [message-code dictionary](message-codes.md) in
`diagnostics`, keyed by identifiers such as `W9`. Repeated messages share a
heading and retain every affected target. `diagnosticCounts` counts error,
warning and information occurrences. See the dictionary for the schema and
the distinction between a failed command and a warning in completed output.

Conflicting contributions stop the command and save comparison files. Fix the
selection or ordering and rerun; commands do not request conflict choices during work.

For release, `deploySkippedReason` explains a missing installer when its link exists but Rust is unavailable. `release --dry-run` only reports plans: no compilation, Rust installation, or `dist` replacement. Release rejects `--patch` and packages all feature code, including development and disabled features.

## Option availability

| Option              | Available on                                                 | Use                                                           |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `--mod <id>`        | All project commands                                         | Narrow the project selection                                  |
| `--patch <id>`      | Project commands except `release`                            | Narrow selected features                                      |
| `--scope dev`       | All commands except `init`                                   | Include development patches                                   |
| `--verbose`         | All commands except `init`                                   | Show the full human report; add stderr progress with `--json`  |
| `--no-cache`        | `validate`, `build`, `sync`                                  | Recompute cached work                                         |
| `--require-all`     | `validate`, `build`, `sync`                                  | Fail if an optional patch cannot apply                        |
| `--dry-run`         | `validate`, `build`, `sync`, `recover`, `cleanup`, `release` | Review without replacing previews, release files or game data |
| `--yes`             | `sync`, `recover`, `cleanup`                                 | Confirm the write; required for `cleanup --all`               |
| `--reset-changed`   | `sync`, `recover`                                            | Discard external edits to tracked files using saved originals |
| `--ymb-path <path>` | All commands                                                 | Choose a different YMB folder                                 |
| `--json`            | All commands                                                 | Return structured output for programs and agents              |

`init` accepts `--id`, `--name`, and `--description` instead of selection filters. A sole starter example is selected automatically. With several installed examples, choose one at the prompt or pass `--example NAME`; scripts must pass that option. With no examples installed, init fails without creating a project. `find` also has `--name`, `--type`, `--field`, `--file`, and `--limit`.

| Previous | You are here | Next |
| --- | --- | --- |
| [Generator SDK and execution](generators.md) | Reference · 5/7 · Commands and JSON output | [Errors, warnings, and message codes](message-codes.md) |
