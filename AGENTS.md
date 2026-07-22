# YMB Agent Guide

This file applies to the YMB builder repository. A deeper `AGENTS.md` may provide integration
guidance for a checkout located beneath this directory, but directory nesting does not make that
checkout part of the builder project or repository.

## Project and repository boundaries

The YMB builder and every source mod are independent projects in independent repositories. The
`mods/` directory is only a convenient location in which separately versioned mod repositories
may be checked out so the builder can discover and build them. A mod is a consumer of YMB, not a
component, package, or subtree of the YMB builder repository.

- Treat `YMB/` and each `mods/<mod>/` checkout as separate version-control and change scopes.
- Never assume that a builder task authorizes edits to a mod, or that a mod task authorizes edits
  to the builder. Cross-project changes require explicit task scope covering both projects.
- Run status, diff, commit, branch, and history operations separately in each repository. Do not
  describe or commit their changes as one repository change.
- Do not create dependencies on their incidental directory nesting. Builder behavior, tests, and
  documentation must remain valid without any particular mod checkout present.
- When a requested change affects both projects, keep the implementations and verification flows
  distinct and report the results for each repository separately.

## Goal and priorities

Build a compact, reliable, approachable WARNO mod builder. When a task explicitly includes an
independent source mod, help keep that mod resilient without collapsing its design or ownership
into the builder project. Use these priorities when requirements compete:

1. Correctness, safety, and a clean design.
2. Low complexity, little repetition, and efficient execution.
3. A welcoming experience for modders who are not experienced programmers.
4. Compatibility only where it does not preserve a worse design.

Prefer a small breaking design over permanent compatibility machinery when that is the clean
solution. Do not silently make that decision for the user: follow the breaking-change protocol
below.

## Repository map

Run project commands from this `YMB/` directory.

- `index.ts`: executable entry point.
- `src/`: builder implementation. Major areas are CLI, discovery, planning, patching, script
  runtime, and materialization.
- `tests/`: builder tests. These test YMB itself and must not depend on a real source mod.
- `scripts/`: maintainer-only production build and release verification entrypoints.
- `release/`: authored Windows launcher templates copied into the portable distribution.
- `dist/YMB/`: generated portable release folder; never edit it as source.
- `mods/<mod>/`: optional checkouts of independent source-mod projects and repositories. Their
  location under `YMB/` is operational convenience only; they are not part of the YMB repository
  and have a different test flow from the builder.
- `docs/`: user-facing YMB documentation.
- `.agents/memories/`: concise, durable findings for future agents.
- `.agents/skills/`: reusable procedures learned while doing difficult work.
- `.ymb-build/`, `.ymb-state/`, and other `.ymb*` paths: generated output, cache, locks, or
  recovery state. They are not source code.
- The parent mod root's `GameData/` and `CommonData/`: live WARNO inputs and outputs. Do not
  treat them as authored source-mod files.

Never edit generated output to implement a feature. Change the authorized project that produces
it; do not cross the builder/mod repository boundary unless the task explicitly includes both.
Do not run `sync`, `recover`, native WARNO update/generation scripts, or otherwise write live
WARNO files unless the user explicitly asks for that operation.

## Read before changing behavior

Start at `README.md` and `docs/README.md`, then read only the references relevant to the task:

- `docs/workflow.md`: command lifecycle and safe operational flow.
- `docs/configuration.md`: source-mod and patch schemas, scripts, replace files, and tests.
- `docs/ndf-operations.md`: supported structural NDF operations.
- `docs/script-tools.md`: stable builder APIs exposed as `context.tools`.
- `docs/template-expressions.md`: expression language and evaluation behavior.
- `docs/advanced.md`: ownership, caching, locking, recovery, and edge cases.
- `docs/distribution.md`: portable release contents, production build, and tagged deployment.
- `mods/<mod>/README.md`: mod-specific structure, prerequisites, and hazards.

Documentation is part of the implementation. Update the relevant document in the same change
when a command, public API, schema, workflow, error contract, directory layout, or meaningful
mod behavior changes. Examples and command lines must remain executable. Remove outdated
instructions rather than stacking a newer explanation on top of them.

Builder documentation and builder tests must stay generic. Never use YSM or another concrete
mod as the explanation or fixture for a builder contract. Use small neutral examples such as
`sample_mod`, `base`, or `addon`.

## Choose the change category first

Builder and mod verification are deliberately different. Classify the work before editing:

| Change                                | Authored area                          | Required final verification                                                                 |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Builder behavior, API, CLI, or schema | `src/`, `index.ts`, builder tests/docs | `bun run fix`, then `bun run check`                                                         |
| Builder docs/instructions only        | root/docs metadata and Markdown        | `bun run fix`, then `bun run lint`                                                          |
| Declarative or asset-only mod change  | `mods/<mod>/` with no script change    | `bun run fix`, then `bun run ymb build --mod <id>`                                          |
| Mod TypeScript/script change          | `mods/<mod>/**/*.ts`                   | `bun run fix`, then `bun run typecheck`, `bun run lint`, and `bun run ymb build --mod <id>` |
| Cross-project builder and mod change  | both independent repositories          | verify the builder, then verify each affected mod separately                                |

`bun run check` is the builder gate: typecheck, lint, and the builder suite in `tests/`.
`bun run ymb build --mod <id>` is the mod gate: it resolves the real mod, runs its configured
companion script tests, applies patches, and materializes preview output. A `validate` command
can be useful while diagnosing, but does not replace the final build.

Always run `bun run fix` after all edits. Run the applicable checks after it because automatic
fixes can change source. If a check forces another edit, repeat `bun run fix` and the affected
final checks. Report any check that could not run and the exact reason.

For distribution, launcher, bundling, or release-workflow changes, also run `bun run build` on
Windows and `bun run verify:release`. Both generated ZIPs must contain one top-level `YMB` folder,
minified app and worker bundles, docs, and the `mods` folder. The complete ZIP contains the pinned
portable Bun executable; the no-Bun ZIP must reject a missing or mismatched system Bun and point to
the complete archive. Smoke-test both packaged launchers, not only the source entrypoint.

## Builder development

- Add or update builder tests for every behavior change. Cover success, failure, boundaries,
  malformed input, interactions, and regression cases that are realistically distinct.
- Keep tests behavioral and compact. Prefer table-driven cases and shared neutral fixtures over
  repeated setup. A test should protect a contract, not reproduce the implementation.
- Never make builder tests read `mods/`, live `GameData/`, `CommonData/`, or machine-specific
  paths. Use isolated temporary fixtures.
- Keep modules focused on one exact responsibility. Split files when responsibilities diverge,
  not merely because a file is long. Keep orchestration thin and domain logic independently
  testable.
- Reuse existing primitives before adding another abstraction. Delete dead code, deprecated
  paths, superseded flags, compatibility shims, and obsolete tests/docs as part of a replacement.
- Avoid speculative abstraction, wrapper layers with no policy, boolean-flag mazes, duplicated
  parsing, and catch-all utility modules. Make invalid states difficult to represent.
- Optimize hot paths with evidence, while preferring simpler algorithms and bounded work by
  construction. Do not trade clarity for unmeasured micro-optimizations.
- Treat CLI wording and errors as product design. Use plain language, identify the bad value or
  path, explain the safe next action, and preserve useful context. Defaults must be safe; live
  writes must remain explicit.

### Breaking builder changes

A change is breaking if an existing command, config, script API, generated contract, import, or
source mod must change to continue working.

Before implementing a breaking builder change, summarize:

1. what contract breaks and why the cleaner design is worth it;
2. which known callers, docs, tests, and mods are affected;
3. whether the user wants this task to migrate affected consumers or intentionally leave them
   incompatible/ignored.

Ask the user to choose before proceeding unless their request already made that choice explicit.
Once chosen, implement the clean end state completely. Do not add deprecated aliases, dual
formats, silent fallback, or transitional branches unless the user specifically requests a
compatibility period. Remove the replaced design and its stale tests and documentation.

## Source-mod development

The authored truth is `mods/<mod>/config`; build output is only evidence. Prefer targeted
structural patches over full-file replacement so mods survive WARNO updates.

- Use the public config, patch, template, and `context.tools` APIs documented in `docs/`.
- Do not import builder internals from `src/` into a mod script.
- If several scripts need the same capability, use an existing builder-native API. If the
  capability is broadly useful and putting it in YMB removes meaningful repetition or
  complexity, implement a generic builder tool with generic tests and docs, then consume it.
- Organize mod code into purpose-specific modules. Keep feature configuration close to its
  feature and shared logic in a clearly named shared area.
- Put companion script tests beside the scripts/configuration they protect and register them in
  the relevant YMB YAML. Test deterministic outputs, preserved identities, idempotence,
  important invariants, empty/minimum inputs, and plausible malformed data.
- Do not add mod-specific assumptions to builder code to make one mod pass.
- Respect stable identity stores, ownership markers, localization identifiers, GUIDs, serializer
  IDs, and case-sensitive source paths. Read the mod README before changing any of them.
- Inspect build failures at their source. Do not weaken validation, hard-code generated output,
  or copy builder logic into the mod to bypass a failed build.

## Clean-change standard

Leave the touched area simpler or no more complex than before.

- Remove unused code, stale comments, obsolete branches, and superseded files.
- Prefer direct names and explicit data flow. Comments should explain non-obvious WARNO/YMB
  constraints, not restate code.
- Keep diffs scoped. Preserve unrelated user changes and do not reformat or rewrite unrelated
  work by hand.
- Review the final diff for accidental generated files, machine paths, secrets, debug output,
  broad replacements, and duplicated functionality.
- Do not declare success based only on types or lint; run the category-specific behavioral gate.

## Make difficult work easier next time

If a task exposes a surprising WARNO rule, hidden coupling, non-obvious failure mode, costly
investigation, or reusable workflow, capture it before finishing:

- Add a focused memory under `.agents/memories/` for a fact or hazard.
- Add a skill under `.agents/skills/<skill-name>/SKILL.md` for a repeatable multi-step procedure.
- Update normal `docs/` too when users or public API consumers need the information.

Do not record guesses, secrets, local-only absolute paths, or temporary incident details. Verify
the finding, link the relevant repository paths, include a detection/validation method, and keep
the entry short. Correct or delete a memory/skill as soon as it becomes stale.
