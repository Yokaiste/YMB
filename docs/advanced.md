# Advanced Usage

This guide covers user-facing behavior that matters in large source mods and combined projects.

## Design around ownership

Keep one exact concern per patch. A useful boundary is something that can be enabled, tested, and repaired independently.

```text
config/patch/
  gameplay/decks/
  gameplay/units/
  ui/branding/
  ui/layout/
```

Prefer shared modules for repeated parsing or generation logic. Keep persistent identity stores separate from disposable build caches.

## Selection order

YMB resolves a build in this order:

1. discover immediate source mods under `YMB/mods`
2. apply enabled state and `--mod` filters
3. add source-mod dependencies
4. order source mods by dependencies and priority
5. apply scope and `--patch` filters
6. add patch dependencies
7. validate ownership and conflicts
8. apply patches and scripts in resolved order
9. materialize replace files

Dependencies may cause a source mod or patch to appear even when it was not named directly. Use `explain` to inspect the reason.

## Dependencies

Source-mod dependencies use stable source-mod IDs:

```yaml
dependsOn:
  - shared_foundation
```

Patch dependencies can be local or qualified:

```yaml
dependsOn:
  - gameplay.units
  - shared_foundation:gameplay.identities
```

Use qualified `modId:patchId` references across source mods. Missing, disabled, circular, or incorrectly ordered dependencies fail validation.

## Priority and layered output

`priority` controls source-mod order but does not grant permission to overwrite earlier output.

Set `allowWriteToModifiedFiles: true` only when a source mod is explicitly designed to consume or extend earlier generated files. All participating layers must have a valid dependency or priority order and compatible ownership.

Without that opt-in, normal conflict checks remain active. Same-priority contributors still use merge and collision rules.

Use layering for deliberate extension, not to hide overlapping ownership. If two source mods continually rewrite the same feature, give one of them clear ownership or extract a shared dependency.

## Multiple contributors to one file

YMB can combine non-overlapping text changes and ordered patch operations. It rejects overlapping edits, competing replacements, ambiguous generated blocks, and unsafe binary collisions.

For broad data rules, prefer one `bulk` operation with several edits over repeating the same scan in many operations. Use selective conditions first, set meaningful block and change minimums, and split dependent edits into separate ordered operations. Edits within one bulk operation must not target overlapping values.

A higher-priority script may transform a lower-priority replacement when both source mods enable `allowWriteToModifiedFiles`. The script reads the materialized lower layer and returns the same target path. Replacements in the script's own or a later layer remain reserved, preventing a replacement from silently overwriting generated output.

Generated scripts should use builder-generated block helpers when they own only part of a text file. Stable owner IDs allow later builds to replace the correct block without changing surrounding content.

## Script execution

Scripts execute sequentially in configured build order. A later script may read selected live input or output generated earlier in the same build.

Keep scripts deterministic:

- derive output from declared targets, variables, and authored state
- sort unordered input before rendering
- keep mutable analysis local to one run
- validate NDF before returning it
- return the same bytes for the same inputs

Use the public `ymb/api` types and `context.tools`. Do not depend on builder implementation files.

## Script tests

Companion tests should cover observable behavior:

- required source objects and fields
- parsing failures and missing anchors
- empty, minimum, and maximum inputs
- stable output IDs and tokens
- independent mutable views when analysis is reused
- generated-file integrity and category limits

Tests run in the normal validation and build flow. Keep them focused; avoid repeating the implementation inside the test.

## Cache and persistent state

YMB caches patch and script-test results to speed up repeated builds. Script caches are disposable and may be invalidated, compressed, or pruned.

Use `context.tools.cache` only for derived data that can be recreated. Include every relevant source and setting in the cache key and validate data when reading it.

Do not store persistent IDs, allocation registries, user choices, or authored configuration in cache folders. Keep that state in the source mod and update it through owned-file helpers.

Bypass caches while diagnosing changes:

```text
validate --no-cache --verbose
build --no-cache
```

## Generated blocks

Generated blocks let a script own a marked region instead of a complete text file. Use stable owner IDs and the NDF generated-block tools to render and update them.

When several scripts contribute to one target, declare the relevant generated-block owner paths in the script result. YMB will allow only the ownership explicitly granted to that result.

If edits occur outside owned blocks or another owner's block changes, the build falls back to normal conflict checks.

## Replace ownership

Replace files materialize after patch scripts. A script can update an authored file under `config/replace`, and the updated file can be copied later in the same build.

Replacement means complete ownership. Two selected replacements for the same path are a conflict unless resolved by deliberate source-mod layering. Prefer structural NDF operations for shared game files.

## Updating after a WARNO patch

Recommended order:

1. recover synced files with `recover --yes`
2. update the generated WARNO mod with its native tools
3. run `doctor`
4. run `validate --no-cache --verbose`
5. repair missing targets or selectors
6. build and inspect the full preview
7. sync only after review

Do not treat a successful build as proof that gameplay behavior is correct. Test the synced mod in WARNO.

## Recovery details

The first sync stores original tracked bytes under `YMB/.ymb-state`. Later syncs continue to protect those originals rather than treating earlier generated output as the base.

Recovery can be filtered by source mod and patch. Keep the state directory until all tracked changes have been restored.

If sync or recovery is interrupted, YMB uses its operation journal to roll back live files and state together. Review the reported rollback before retrying.

## Debugging selection

```text
list
explain --scope dev
explain --mod my_pack
explain --patch gameplay.units
```

Check enabled state, scope, exact IDs, dependency qualification, source-mod priority, and command filters.

## Debugging output

```text
validate --no-cache --verbose
build --dry-run --verbose
build --no-cache --verbose
```

Fix the earliest structured error first. Later failures often follow from the same missing target or invalid selector.

Never edit `.ymb-build/output` as a fix; it is regenerated. Change the source patch, script, variable, or replacement.

## Keeping large projects fast

- read shared targets once when several generators use them
- cache immutable derived analysis, not mutable selection state
- batch target reads with `readTargets`
- keep patch selectors narrow
- avoid repeated full-file parsing in inner loops
- use script caches only when recomputation is measurably expensive
- split unrelated features so filtered builds remain small

Remove an optimization if it adds complexity without a measured improvement or changes output unexpectedly.
