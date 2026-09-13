# YMB Agent Guide

YMB makes WARNO mods maintainable through game updates by keeping authored changes
separate from generated game files. Structural NDF patches, bulk rules, shared settings,
file operations and scripts compose modular source packs into checked output. Preserve
mod layering, conflict diagnostics, recovery, efficient rebuilds and machine-readable
automation while keeping the entry point accessible without programming knowledge.

## Scope and safety

- YMB and each `mods/<mod>/` checkout are separate repositories. Check status and diffs
  in each affected repository. Work across them only when the request includes them.
- Preserve existing staged and unstaged work. Do not stage or commit unless asked.
- Edit authored source, never `.ymb-build`, `.ymb-state`, or live `GameData`/`CommonData`.
  Persistent mod identity stores are authored state even when named `generated`.
- Do not run `sync`, `recover`, game generation/update scripts, or `publish:release`
  without explicit authorization. Preview builds are the normal behavioral check.
- Leave `LICENSE` and `NOTICE` unchanged unless the task concerns those files.

## Find the owner

Start with `README.md`, [development principles](docs/development.md), the relevant
page under `docs/`, and the affected code. Read
`mods/AGENTS.md` and the mod README for mod work. `.agents/README.md` records the few
implementation constraints that are easy to miss.

| Area                     | Source                                                     |
| ------------------------ | ---------------------------------------------------------- |
| CLI and help             | `src/cli.ts`, `src/cli-guide.ts`, `src/cli/`               |
| Config and customization | `src/config/`, `src/templates.ts`, `src/builder-config.ts` |
| Discovery and selection  | `src/discovery/`, `src/planner/` and their root modules    |
| Build, sync, recovery    | `src/engine/`                                              |
| NDF parsing and editing  | `src/patch/ndf/`                                           |
| Public script API        | `src/api.ts`, `src/scripts/`                               |
| Shared report formatting | `src/report/`                                              |
| Portable release         | `scripts/`, `release/`, `.github/workflows/ci.yml`         |

## Design judgment

- Start from the behavior and its audience. Name the decision being changed and its
  owner before choosing files, settings, validators, or abstractions. Examples in a
  request reveal a pattern to investigate; they are not a list of strings to replace.
- Organize by responsibility and reason to change. A feature owns its rules, content,
  assets, validation, and tests. Shared code owns a demonstrated common mechanism;
  orchestration only connects owners. Folder placement alone does not establish this.
- Keep YMB independent of mod policy. Its parsers, composition, ownership, recovery,
  and script API must work with invented mods. Specific factions, unit rosters,
  balance choices, and presentation belong to the source mod that defines them.
- Configuration is an intentional interface. Expose a value only for a meaningful
  supported choice. Put a feature's defaults with that feature; promote a value only
  when actual consumers must agree. Derive formatting and dependent values once.
  Literals, protocol constants, and authored content do not automatically need knobs.
- Remove duplicated decisions, not every repeated shape. A shared abstraction must
  reduce knowledge at its callers. Avoid registries, feature frameworks, forwarding
  wrappers, and new config formats introduced merely to make a cleanup look general.
- Fix the cause of a defect. Put regression coverage with its owner; validate an
  actual invariant where it is established. Do not turn one incident into a global
  checker that recognizes a growing list of feature names.
- Write for the decision at the current surface. Player descriptions convey identity
  and experience; configuration explains choices; diagnostics explain failures.
  Accurate internal facts still need a user purpose before appearing in the product.
- Treat existing code and docs as evidence, not automatic precedent. Apply these
  principles across callers and finish each migration without expanding unrelated
  scope. Preserve documented contracts and identity while reducing accidental coupling.

## Make the change

- Prefer deletion, existing helpers, and the runtime over new abstractions or dependencies.
  Trace callers before removing code; preserve validation, ownership and recovery guarantees.
- Keep meaningful tunable defaults at their owning config scope. Use builder overrides
  for local customization and patch variables for needed derived values. Do not turn
  implementation constants into settings or create another configuration format.
- Finish migrations in the same change: callers, current mods, tests and docs. Explain
  any changed public config/API and its migration. Ask only when the requested scope
  leaves a consequential consumer decision unresolved.
- Comments explain a non-obvious constraint in one or two lines. Remove narration and
  history. User docs explain what to edit, run and expect, with small working examples.
- Keep terminal text ASCII for Windows launchers. Markdown may use Unicode.
- Errors identify the bad input or path and provide a practical next step.

## User experience and machine interface

- READMEs are project showcases: lead with a strong visual, a clear promise, real
  capabilities, and links to play/download/learn. Keep tutorials and configuration
  reference in docs. Use each project's own identity; do not turn every README into
  the same installation checklist.
- Preserve the project's purpose when shortening its presentation. For YMB, explain
  update resilience and how its authoring, composition, checking and automation tools
  support that goal. Give each section a distinct capability and concrete benefit;
  do not replace substance with repeated slogans about customization or previewing.
- Docs should be attractive and approachable: clear navigation, short sections,
  useful diagrams, examples, and whitespace. Explain unfamiliar terms when introduced.
  Visuals must communicate something; use accessible alt text and readable contrast.
- Link workspace files, images and doc pages with relative paths, including generated
  starter READMEs. Keep external project, release-download and community URLs external.
- Preserve the symbol-based YMB logo in human CLI output. Suppress decoration only in
  machine-readable mode; both stdout and stderr must stay clean there.
- CLI output leads with the outcome and useful counts, then issues and a concrete
  next step. Preserve the user's selection in suggested commands. Distinguish YMB
  source generation from WARNO compilation. Do not promise that scripts write nothing.
- Machine output is a versioned JSON document with stable fields, native numbers and
  booleans, structured paths/results, and explicit truncation. Never require parsing
  decorative lines or prose. Keep JSON mode noninteractive and stdout free of chatter.
  Keep existing fields compatible unless a migration is explicitly documented.

## Tests

Use small invented fixtures and assert observable behavior: parsed output, selection,
error category/location, preservation of bytes, and recovery. Test rejection with a
valid neighboring case so an unrelated failure cannot make the test pass.

Do not inspect implementation text or pin help wording, product names, production tuning,
key order, or entire generated files. Import the code under test; keep inputs independent
of real mod configs and machine paths. Actual protocol fields still need coverage.
Companion tests must use in-memory fixtures or temporary files, not rewrite mod sources.

## Finish

| Changed area            | Checks, in order                                                     |
| ----------------------- | -------------------------------------------------------------------- |
| Builder code or tests   | `bun run fix`, `bun run check`                                       |
| Builder docs only       | `bun run fix`, `bun run lint`                                        |
| Release, launcher or CI | Builder checks, `bun run build`, `bun run verify:release` on Windows |
| Mod config/assets       | `bun run fix:mods`, `bun run ymb build --mod <id>`                   |
| Mod scripts             | `bun run fix:mods`, `bun run check:mods`, then the mod build         |

A build includes validation; do not also run validate for the same final check. When
multiple mods are intended to layer, verify that selection together. Builder checks must
work without mod checkouts; `check:mods` uses the shared rules on those checkouts.

Review each repository's final diff for accidental changes, generated files, stale docs
and duplicated logic. Report what changed, the checks run, and any remaining limitation.
