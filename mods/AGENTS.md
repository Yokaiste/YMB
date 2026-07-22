# Source-Mod Agent Guide

This file governs source-mod checkouts placed under `mods/`. The YMB builder and each source mod
are independent projects in independent repositories. Their directory nesting exists only so YMB
can discover and build a mod; it does not make a mod part of the YMB project or repository.

Use the root `AGENTS.md` only as builder integration and safety guidance. Treat each
`mods/<mod>/` checkout as its own version-control, change, test, and release scope. A task for a
mod does not authorize builder edits, and a builder task does not authorize mod edits. Only make
cross-project changes when the user explicitly scopes the task to both, and keep their diffs,
commits, verification, and reporting separate.

## Work in source, test through YMB

- Read the target mod's `README.md` and its `config/ymb.mod.yaml` before editing.
- Author changes only in the target mod. Never implement a mod feature by editing
  `.ymb-build/output`, live `GameData/` or `CommonData/`, caches, or recovery state.
- Prefer focused YMB patch operations, template expressions, and the public `context.tools` API
  over replacement files or custom parsing/generation code.
- Keep modules feature-focused. Shared modules must have one named responsibility and genuine
  reuse; do not create generic dumping grounds.
- Preserve documented identity stores and generated ownership markers. They may be authored
  state even when their names contain `generated`.

If a missing capability belongs naturally in the builder, treat that as a separate builder
change; do not make it during a mod-only task. When the user has explicitly authorized work in
both projects and the capability would simplify multiple call sites, add it generically to YMB
with neutral builder tests and user documentation, then consume its public API from the mod.
Never reach into `src/` from a mod script. Apply the root breaking-change protocol if that
separate builder change breaks an existing contract.

## Tests and final commands

Mod tests are companion tests registered by `ymb.mod.yaml` or `ymb.patch.yaml`; they are not the
builder suite in `tests/`. Keep them next to the script they protect. Cover the mod's output and
invariants without duplicating the whole generator.

After all edits, run from `YMB/`:

- Every mod change: `bun run fix`, then `bun run ymb build --mod <id>`.
- If any TypeScript/script changed: after `bun run fix`, also run `bun run typecheck` and
  `bun run lint` before the mod build.
- If builder code changed too: run the root builder flow (`bun run check`) as well as the mod
  build.

Build is the required mod behavioral gate even when `validate` passes. Do not substitute the
builder's `bun run test` for a mod build, and do not run live `sync` unless the user explicitly
asks.

Update the target mod README when behavior, prerequisites, special state, compatibility, build
steps, or troubleshooting changes. Public builder documentation must remain independent of this
or any other specific mod.
