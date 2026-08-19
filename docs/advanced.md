# Advanced Topics

For when a project grows past a handful of patches, or two mods have to share the same
game files.

---

## Design around ownership

One clear concern per patch. A good boundary is something you can enable, test, and fix
on its own:

```text
config/patch/
├── gameplay/decks/
├── gameplay/units/
├── ui/branding/
└── ui/layout/
```

That way `--patch ui.branding` builds exactly one feature, and a broken selector names
the feature it broke.

Put repeated parsing or generation logic in a shared module the scripts import.

---

## Why something is in the build

Your `--mod` and `--patch` filters are a starting point, not the final list. YMB adds
whatever the selection depends on, so a mod or patch can appear even though you never
named it — and a disabled or missing dependency stops the build instead.

Mods build in dependency order, then by `priority`. Patches build in dependency order
within that. When the selection surprises you, ask:

```bat
YMB\YMB.bat explain --mod my_pack
```

---

## Dependencies

Between mods, by mod id:

```yaml
dependsOn:
  - shared_foundation
```

Patches use the same key, in the form
[`dependsOn` between patches](configuration.md#dependson-between-patches) describes.

---

## Layering one mod over another

Two mods can edit the same files, if you say which one wins.

Layering needs **both** of these:

1. **An order.** Give the later mod a higher `priority`, or a `dependsOn` naming the
   earlier one. Two mods at the same priority with no dependency between them are
   unordered and cannot layer.
2. **Permission, on the later mod only:**

   ```yaml
   allowWriteToModifiedFiles: true
   ```

> **Only the mod on top declares it.** A mod applied first never sees another mod's
> output — it writes over untouched game files, so it needs nothing. The mod that
> consumes or extends that output is the one opting in.

Everything else stays strict. Without the opt-in, normal conflict checks apply; at equal
priority the usual merge and collision rules apply.

Use layering for deliberate extension. If two mods keep rewriting the same feature, that
is not layering — give one of them ownership, or split the shared part into a dependency
both use.

---

## Multiple contributors to one file

YMB merges what it can prove is safe: non-overlapping text edits and ordered operations
inside one patch. It rejects overlapping edits, unordered file-operation owners, two
replacements of one file, ambiguous generated blocks, and binary collisions.

For broad rules, one [`bulk`](ndf-operations.md#bulk-change-many-blocks-at-once)
operation with several edits beats many operations repeating the same scan. Filter
narrowly, set real `minBlocks` and `minChanges`, and split dependent edits into separate,
later operations — edits inside one bulk must not touch overlapping values.

A higher-priority script may transform a lower layer's replacement: it reads the
materialized file and returns the same target path. That requires
`allowWriteToModifiedFiles`. Replacements in the script's own layer or later stay
reserved, so a plain file copy can never silently bury generated output.

When a script owns only part of a file, use
[generated blocks](script-tools.md#owning-part-of-a-file) with stable owner ids. Later
builds then replace the right region and leave neighbours alone.

---

## How scripts see each other

Scripts run one after another in build order, and a later one can read what an earlier one
produced.

**Read the file you intend to rewrite.** A script that reads a target and returns it is
treated as transforming exactly what it saw, so chains of generators stay in order. A
script that writes a target it never read is an independent contributor instead: its
edits merge only if they do not overlap another writer's, and overlapping ownership is
rejected.

Every script in a chain has to be deterministic for that ordering to mean anything — see
[rules for well-behaved scripts](script-tools.md#rules-for-well-behaved-scripts).

---

## Cache and persistent state

YMB caches patch results and script-test results so repeated builds stay fast. Those
caches are **disposable** — they can be invalidated, compressed, or pruned at any time.

| Belongs in the cache               | Belongs in the mod            |
| ---------------------------------- | ----------------------------- |
| derived analysis you can recompute | id registries and allocations |
| parsed indexes                     | user choices                  |
| expensive intermediate results     | anything authored by hand     |

Use `context.tools.cache` with a key containing every relevant input, and validate what
you read back. Write persistent data with `writeModTextIfChanged`.

A script test answered from cache is listed as `test ok*` rather than `test ok`, so a run
always says which of its checks it actually ran.

When a result looks wrong, take the cache out of the picture:

```bat
YMB\YMB.bat validate --no-cache --verbose
```

---

## Replace ownership

Replace files are copied after scripts run, so a script can update an authored file under
`config/replace` and have the updated version copied in the same build.

A replacement means total ownership of that path. Two selected replacements of one file
are a conflict, unless deliberate layering resolves it.

---

## What recovery protects

The first `sync` stores the original bytes of every file it touches. Later syncs keep
protecting those same originals — they never treat earlier generated output as the
original. YMB records a checksum with each one and refuses to restore or reuse a backup
that no longer matches, rather than putting back something it cannot vouch for.

Recovery can be filtered by `--mod` and `--patch`, so you can undo one feature and leave
the rest installed. Keep the state folder until everything it tracks has been restored.

> **A green build is not proof the game plays correctly.** It proves the files are valid.
> Launch WARNO and check.

---

## Keeping large projects fast

- read a shared target once and pass it around
- batch reads with `readTargets`
- keep selectors narrow — a tight `bulk` filter beats a wide one
- avoid re-parsing a whole file inside a loop
- cache only what is measurably expensive to recompute
- split unrelated features so `--patch` builds stay small

Measure before and after. Remove any optimisation that adds complexity without a
measured win, or that changes output unexpectedly.

---

## See also

- [Configuration](configuration.md) — every field, including `priority` and `dependsOn`
- [Generation scripts](script-tools.md) — the script API
- [How a build works](workflow.md) — the commands these sections assume
