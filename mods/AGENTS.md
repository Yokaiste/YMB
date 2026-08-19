# Source-Mod Agent Guide

This file governs source-mod checkouts under `mods/`. Their nesting exists only so YMB can
discover and build them; the root `AGENTS.md` owns the boundary, priority, and safety rules, and
they apply here unchanged. This page adds only what is specific to working inside a mod.

## Work in source, test through YMB

- Read the target mod's `README.md` and `config/ymb.mod.yaml` before editing.
- Author changes only in the target mod. Never implement mod behavior by editing
  `.ymb-build/output`, live `GameData/` or `CommonData/`, caches, or recovery state.
- Prefer focused YMB patch operations, template expressions, and public `context.tools` APIs over
  replacement files or custom parsing/generation code.
- Keep modules feature-focused, with companion tests close to the scripts they protect. Shared
  modules should have one clear responsibility and genuine reuse.
- Mod scripts and mod YAML both follow the root **Comments** rule: default to none, one or two short
  lines when the file cannot say why. A knob whose consequence is not obvious from its name and
  value earns one line; the keys a config lists commented out are inert configuration, not prose,
  and stay. Explain a feature in the mod README, not in a wall of `#` above its patch.
- Preserve stable identity stores, ownership markers, localization identifiers, GUIDs, serializer
  IDs, and case-sensitive source paths — even when their names contain `generated`.
- Do not weaken validation, hard-code generated output, or copy builder logic into a mod to
  bypass a failing build.

If a missing capability belongs in the builder, treat that as a separate builder change. When the
user explicitly authorizes both projects and the capability would help more than one call site,
add it generically to YMB with neutral tests and docs, then consume its public API from the mod.
Never import from `src/` inside a mod script — a mod uses only the documented public config,
patch, template, and `context.tools` APIs.

## Shared installer and workflow files

Each mod's `Deploy-<MOD>.bat` and `.github/workflows/auto-deploy.yml` are deliberately one shared
body with a small per-mod config at the top, so a file can be copied into a new mod and only the
config edited.

- In the installer, everything above `:deploy_repositories` is config, and the repository list
  inside it is per-mod. Everything below is shared.
- In the workflow, only the `env:` block and the concurrency group differ.
- Fixing a bug in the shared part means fixing it in every mod, in the same change. Diff the two
  files afterwards and confirm the only differences are the intended config.

These files live in mod repositories, so a builder task does not authorize editing them.

## Legal files

Each mod carries its own `LICENSE` and `NOTICE`. They are versioned legal text, not boilerplate to
sync from YMB, and a mod's terms differ from the builder's. Do not edit them as a side effect of
another change, and do not copy YMB's license into a mod.

## Tests and final commands

Mod tests are companion tests registered by `ymb.mod.yaml` or `ymb.patch.yaml`; they are not the
builder suite in `tests/`. Keep them close to the script they protect and cover output and
important invariants without reproducing the whole generator. The builder's own `bun run test`
proves nothing about a mod, so it never substitutes for a mod build.

The root `AGENTS.md` change-category table gives the gate: `bun run fix:mods`, then
`bun run ymb build --mod <id>`, plus `bun run check:mods` when any TypeScript changed. Build is
the behavioral gate even when `validate` passes.

Update the target mod README when behavior, prerequisites, special state, compatibility, build
steps, or troubleshooting changes. Public builder documentation must stay generic and not depend
on this or any other specific mod.
