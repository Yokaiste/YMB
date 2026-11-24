# Layering, ownership, and large projects

[All documentation](../README.md#advanced)

| Previous | You are here | Next |
| --- | --- | --- |
| [Advanced workflows and system behavior](../README.md#advanced) | Advanced · 1/3 · Layering, ownership, and large projects | [Recovery records and interrupted writes](recovery.md) |

| You need to… | Go to |
| --- | --- |
| Combine changes | [Order](#dependencies-and-priorities), [contributors](#multiple-contributors-to-one-file), [generator reads](#how-generators-see-each-other), [replacements](#replace-ownership) |
| Manage stored data | [Caches and identities](#cache-and-persistent-state), [recovery](#what-recovery-protects) |
| Prepare a larger project | [Performance](#keeping-large-projects-fast), [release checks](#automate-a-release-check), [further reading](#learn-more) |

Use [lesson 6](../learn/06-combine-projects.md) for a complete two-project example. The rules here explain what happens when contributors share targets.

## Dependencies and priorities

| Need | Setting |
| --- | --- |
| Require another project | Mod `dependsOn` with project ids, such as `first_mod` |
| Require a local feature | Patch `dependsOn`, such as `gameplay.health` |
| Require another project's feature | Patch `dependsOn` with `modId:patchId` |
| Order independent projects | Different `priority` values; lower first |
| Transform earlier project output | Later project sets `allowWriteToModifiedFiles: true` |

Use dependencies for required output. Equal priorities without a dependency establish no order. Only the later writer needs permission, but successful layering does not prove gameplay compatibility. Two mods can agree on a file and still disagree spectacularly about a tank.

## Multiple contributors to one file

The health lesson gives one feature clear ownership of HP changes. As a project grows:

- Order dependent file operations with patch dependencies.
- Use explicit layering when one project changes another's result.
- Use [generated blocks](../references/generators.md#owning-part-of-a-file) when a generator adds a region to a shared file.
- Give a whole-file replacement one clear owner.

YMB can combine non-overlapping text changes. Conflicting edits stop the command and save comparison files; adjust the selection or declare explicit layering before rerunning. Ambiguous generated ownership, unordered file-operation owners, and incompatible binary output fail.

Keep all contributors selected when syncing a shared tracked file. A partial sync that would erase an excluded contributor stops before writing. To install a different combination, recover the shared files first, then build and sync the desired selection.

For broad balance rules, one narrowly matched `bulk` is usually cheaper than repeated scans. Set counts that catch meaningful omissions. Dependent scalar edits need separate operations; [list actions can run in order within one bulk operation](../references/ndf-patches.md#editing).

## How generators see each other

Generators run in build order. Target readers see earlier generated output and eligible prepared replacements or file operations. The health generator reads `TacticalUnits.ndf` and writes that same path; YMB records the read.

| Generator behavior | Treatment |
| --- | --- |
| Read the exact target, then write it | Sequential transformation; across projects, also needs ordered layering |
| Write a target it did not read | Independent contribution |
| Transform a lower project's replacement | Allowed with ordered layering |
| Write over a same-layer or later replacement | Target remains reserved |

Keep output deterministic. Sort data whose order is otherwise unstable, and keep random or time-based values out of persistent identities.

## Cache and persistent state

| Disposable cache                 | Persistent project data                      |
| -------------------------------- | -------------------------------------------- |
| Parsed indexes                   | Allocated ids and GUID registries            |
| Computed analysis                | User-authored choices                        |
| Rebuildable intermediate results | Data needed to keep saved content compatible |

Use the SDK cache helpers for derived results in `YMB/.ymb/mods/ID/`. Include every input affecting the result in the key and validate the loaded shape. Use persistent-file helpers for generated identities in the mod's `config/.ymb/`; that storage ships with the mod and survives cleanup. Keep authored settings in their configuration files.

Deleting a cache should affect build time only. Deleting an identity registry can reuse saved references for new units or decks. Back up registries even when the filename says "generated".

To rule out cached work:

```text
.\YMB.exe build --mod tank_training --no-cache --verbose
```

This recomputes cached work. It does not reset persistent project files.

## Replace ownership

Mod-level replacement files are copied after generators run, so a generator can update an owned file under `config/replace/` for that build. Returning output directly is simpler when the file does not need to persist as authored state.

Two replacements of one target conflict unless explicit layering resolves their order. Review replacements after game updates: they carry the whole file. The starter localisation template uses a replacement by default, or a patch-owned copy if you moved it in the configuration lesson. The HP generator does not touch it.

## What recovery protects

The first sync saves original bytes for each target. Later builds use those originals instead of repeatedly scaling their installed output. Backup checksums detect damaged copies.

Recovery is file-based. Both tutorial health features share `TacticalUnits.ndf`. Recovering either contributor restores the whole file, including the other feature's changes. Preview recovery first; sync the remaining project afterward if you want to keep its changes.

Keep the state folder until its tracked changes have been recovered. If its manifest is missing or damaged, restore a trusted copy. `manifest.json.bak` may describe an earlier sync and omit newer files; it is not automatically safe to promote.

If YMB reports a stale `.reclaim` directory, confirm that every YMB command has stopped before removing the exact directory it names. Never clear a lock to make a second active build proceed.

## Keeping large projects fast

1. Narrow the build to the feature being edited.
2. Read each target once, pass text to helpers, and batch independent reads with `read_targets`.
3. Keep large-file parsing outside loops. Measure before adding a cache.

Read [configuration limits](../references/configuration.md#builder-settings-ymbconfigyaml) before raising a ceiling. The memory budget bounds target worker count and each generator process. Generator timeouts, cache budgets, and changed-text diff limits have distinct purposes.

Merge limits apply after common text is stripped, so an unchanged large file does not require a proportionally large comparison budget. An independent merge exceeding its budget needs smaller edits or deliberate layering. Keep limits finite and measure the result.

## Automate a release check

Build the selection you intend to ship with `--require-all`. Inspect its structured [JSON results](automation.md), then compile and test the playable mod. For this lesson, select `tank_training` to include its `first_mod` dependency.

Test risky generation rules with small invented inputs. Useful checks cover stable ids, missing objects, malformed settings, and preserving another feature's data. Avoid tests that merely repeat implementation details or freeze descriptive text.

Share the mod project and installation instructions according to its license. Credit dependencies where required. YMB and individual mod projects have separate licenses; distributing one does not grant rights to redistribute the others.

## Learn more

- [The Rust book](https://doc.rust-lang.org/book/) covers the language used by generators.
- [Cargo documentation](https://doc.rust-lang.org/cargo/) explains standalone projects, dependencies, locked builds, and binary targets.
- [The YAML overview](https://yaml.org/spec/1.2.2/#chapter-2-language-overview) explains mappings, sequences, and scalar values.
- WARNO ships Mods/modding_manual.pdf and Mods/ndf_reference_manual.pdf for compilation and NDF.

| Previous | You are here | Next |
| --- | --- | --- |
| [Advanced workflows and system behavior](../README.md#advanced) | Advanced · 1/3 · Layering, ownership, and large projects | [Recovery records and interrupted writes](recovery.md) |
