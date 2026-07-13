# Advanced Guide

This guide covers the YMB behavior that starts to matter once your project grows beyond a small experiment.

Use it when you are dealing with multiple source mods, layered outputs, generated files, recovery edge cases, or selection and ownership problems that are no longer obvious from the basic workflow.

## 🧭 Before You Read Further

> [!NOTE]
> This page assumes the normal flow already makes sense: `doctor -> validate -> build -> sync --yes -> recover --yes`.
>
> If that flow is not comfortable yet, go back to [Workflow Guide](workflow.md) first.

## 🧠 Selection Resolution Order

At a high level, YMB and its validators resolve work in this order:

1. discover source mods
2. discover patches
3. filter source mods by enabled state and `--mod`
4. add source-mod dependencies
5. order selected source mods by dependency and priority
6. filter patches by enabled state, `--scope`, and `--patch`
7. add patch dependencies
8. validate ownership and conflicts
9. materialize patch outputs
10. run generation scripts
11. materialize replace outputs

> [!IMPORTANT]
> Replace files are copied after scripts. That means a script can update content under `config/replace`, and that updated file can still be used later in the same build.

## 🧱 Patch Layering

YMB no longer treats every shared patch target as a hard conflict.

When multiple selected patches resolve to the same output file, YMB groups them and materializes them as an ordered sequence.

The important rules are:

- same-priority source mods still use the normal merge and conflict flow
- different priorities do not automatically mean overwrite
- real overwrite layering only happens when the participating source mods opt into `allowWriteToModifiedFiles: true`
- without that opt-in, YMB keeps the normal conflict checks even if priority or dependency order exists

### Practical Meaning

Use `allowWriteToModifiedFiles: true` only when a later source mod is intentionally designed to read and layer over earlier output.

If you just want ordering for clean dependency resolution, keep it `false`.

## 📦 Replace Ownership

Replace files remain intentionally strict.

These situations are hard failures unless ordered layered writes are explicitly allowed by the involved source mods:

- two source mods replace the same target path
- a replace file collides with any selected patch target
- a script output collides with a replace target

That strictness is a feature. Whole-file ownership is easiest to reason about when it is explicit.

## 🛠 Script Merge Behavior

Scripts are more flexible than replace files, but they still have guardrails.

When a script writes a target that already exists in generated output:

- binary outputs must keep unique target paths
- text outputs may merge when the edits are disjoint
- overlap or excessive merge work produces a conflict error

In practice, same-target script edits work best when each script owns a stable generated block or a clearly separate text range.

## ⚡ Build Caches

YMB keeps patch-output and script-test caches under `YMB/.ymb-build/cache`. Three patch result kinds are cached per content state:

- single-mod patch application sequences
- per-mod previews used for cross-mod merge decisions
- the final merged result of a multi-mod target, including the remembered priority choice

Cache entries are self-validating (a content hash travels with each entry), written atomically, and keyed on the builder version, so upgrading YMB invalidates everything automatically. Exact-content NDF validation results are cached too, avoiding repeated parsing of unchanged large generated files without trusting a filename or timestamp. Old entries are pruned after each `validate`, `build`, and `sync`: anything untouched for 14 days, beyond the newest 512 entries, or beyond the 1 GiB total cache budget is deleted.

Use `--no-cache` when:

- you are debugging patch application behavior
- you suspect stale cached patch output
- you want a fully fresh timing comparison
- you want to re-answer a previously remembered patch priority choice for the same content state

`--no-cache` bypasses patch-output and script-test cache reads and writes. It does not disable discovery, replace handling, or script execution.

Generation scripts and script tests are killed after 120 seconds if they hang. A script that needs longer usually contains an unbounded wait that should be fixed in the script itself.

## 🧯 Recovery and Markers

When YMB syncs a supported text file, it wraps generated content with YMB markers and stores the original content in `YMB/.ymb-state`.

That gives YMB two important powers:

- it can recover tracked originals later
- it can reason about previously synced files more safely than blind overwrite tools

Important details:

- unchanged files are skipped on later sync runs
- re-syncing does not replace the saved original backup with generated output
- files that did not exist before sync can be deleted during recovery
- malformed marker envelopes are treated as real errors
- missing backups are treated as real errors
- orphan cleanup removes only YMB-shaped hash backup names; unrecognized files in the recovery folder are preserved and reported

`sync` and `recover` are protected by a durable state transaction. YMB snapshots each live target before its first write and copies the pre-command `.ymb-state` directory. An ordinary error restores both immediately. A process or machine interruption leaves the transaction journal in `YMB/.ymb-state-transaction`; the next mutating command rolls it back under the exclusive operation lock, reports the recovered command and start time, and stops so you can review before retrying.

Do not manually edit or remove an unfinished transaction journal. If its metadata or snapshots are damaged, YMB fails closed instead of guessing which live or recovery state is authoritative.

## 📖 Reading Tracked Targets

One subtle but important behavior: when YMB reads a tracked text target from the live mod root, it can unwrap builder markers and work from the stored original content.

That prevents repeated sync cycles from stacking edits on top of already marked generated output.

For scripts and layered source mods, `readTarget()` behaves like this:

- without `allowWriteToModifiedFiles`, a script only sees same-layer generated outputs
- with `allowWriteToModifiedFiles`, a script may also see earlier selected source-mod output from lower-priority or dependency-ordered layers

## 🔒 Concurrent Commands

`init`, `validate`, `build`, `sync`, `recover`, and `cleanup` take an exclusive lock for the builder. This protects source scaffolds, shared caches, generated source-helper writes, previews, recovery manifests, backups, and live files from overlapping command processes. Interactive `init` questions are completed before it takes the lock.

`init` builds a new source mod in a unique sibling staging directory and publishes the finished scaffold with one rename. If any file write fails, the staging directory is removed and the requested final mod folder remains absent, so retrying does not require repairing a partial scaffold.

If a second mutating command starts while one is active, it stops with the owning command, process ID, and start time. Wait for the first command instead of deleting the lock. When the recorded local process no longer exists, YMB safely reclaims the stale lock itself. `cleanup` deliberately preserves its own active lock.

## 🔄 Upgrade Strategy

WARNO updates can move blocks, rename fields, or reorder collections. Relying on the game's native update scripts often mangles files and introduces severe conflicts. Because YMB uses structural patching, many updates will instead merge cleanly without any work.

> [!WARNING]
> Resilience is not automatic—it requires discipline. If you use YMB to replace entire files or massive chunks of code, you destroy this advantage and will face the exact same merge conflicts as before.

To maximize this resilience:

- prefer name-based and field-match selectors over raw indexes
- keep patches small so breakage is easy to isolate
- convert fragile replace files into targeted patches when possible
- avoid overwriting large blocks of NDF unless absolutely necessary
- run `build --dry-run` after game updates to check what still applies cleanly
- use `explain` when dependency behavior changes

## 🩺 Debugging Selection Problems

If a build is missing a patch or includes one unexpectedly, check in this order:

1. run `list`
2. run `explain`
3. check `enabled`
4. check `scope`
5. check `--mod` and `--patch`
6. check `dependsOn`

Remember that dependencies are added after filtering, so a patch may appear because another selected patch requires it.

## 🧪 Debugging Output Problems

If generated output is surprising, check:

- whether the path is owned by a patch, script, or replace file
- whether multiple patches are contributing to the same target
- whether a script is reading generated output instead of raw live content
- whether replace files are overwriting earlier generated output
- whether cached patch output is hiding a bad assumption during debugging

## 🧯 Debugging Sync Problems

If `sync --yes` is not doing what you expect, check:

- whether the file was selected in the current plan
- whether the output is unchanged from the last sync
- whether the target file type supports visible markers
- whether another owner is colliding on the same path
- whether the file existed before the first sync

## ✂ When To Split a Source Mod

Split one large source mod into multiple source mods when:

- the features are unrelated
- the dependencies are becoming hard to explain
- only some parts should be selectable together
- priority and ownership rules are getting confusing

A good source mod usually represents one coherent package, not every idea you have ever tried.
