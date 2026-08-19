# YMB Agent Guide

This guide applies to the YMB builder repository. A deeper `AGENTS.md` can add guidance for a
nested checkout, but nesting alone never makes that checkout part of the builder repository.

## Boundaries

YMB and each `mods/<mod>/` checkout are separate projects and separate repositories.

- Treat builder and mod work as separate change, test, and reporting scopes.
- Do not edit a mod during a builder task, or the builder during a mod task, unless the user
  explicitly includes both.
- Run git status, diff, history, branching, and commits separately in each repository.
- Do not depend on a mod checkout being present. Builder code, tests, and docs must stay valid
  without any specific mod under `mods/`.

## Priorities

When tradeoffs appear, prefer:

1. Correctness, safety, and a clean design.
2. Low complexity and little repetition.
3. A friendly experience for modders who are not programmers.
4. Compatibility only when it does not preserve a worse design.

Prefer a small clean break over permanent compatibility machinery, but follow the breaking-change
protocol below instead of deciding that silently.

## Repository map

Run project commands from `YMB/`.

- `index.ts`: executable entrypoint.
- `src/`: builder implementation.
- `tests/`: builder test suite. Keep it independent of real mods and machine paths.
- `scripts/`: release build, verification, notice generation, and publish entrypoints.
- `release/`: authored Windows launcher files copied into the portable release.
- `ymb.config.yaml`: builder settings, shipped in every release with everything commented out.
  Keep it inert; `tests/release-assets.test.ts` fails if a value is enabled.
- `LICENSE`, `NOTICE`: authored legal text. `THIRD-PARTY-NOTICES.md` is generated per release.
- `.github/workflows/ci.yml`: check and tagged-release automation.
- `dist/`, `.ymb-build/`, `.ymb-state/`, and other `.ymb*` paths: generated output, caches, locks,
  or recovery state. Never treat them as authored source.
- `docs/`: user-facing builder documentation.
- `mods/AGENTS.md`: rules for source-mod checkouts. Read it before any mod task.
- `.agents/`: guidance for future agents — `memories/`, `skills/`, and `suggestions/`.
  `.agents/README.md` defines all three formats and the bar for adding one.
- Parent `GameData/` and `CommonData/`: live WARNO files, not authored builder source.

Never implement features by editing generated output. Do not run `sync`, `recover`,
`bun run publish:release`, native WARNO generation/update scripts, or any other live-write
operation unless the user explicitly asks.

## Read before changing behavior

Start with `README.md` and `docs/README.md`, then read only the references relevant to the task:

- `docs/workflow.md`: command flow and safety model.
- `docs/configuration.md`: source-mod, patch, and builder schemas; scripts, replace files, tests.
- `docs/ndf-operations.md`: supported structural NDF operations and selectors.
- `docs/script-tools.md`: public script APIs exposed as `context.tools`.
- `docs/template-expressions.md`: variables, the expression language, and its helpers.
- `docs/advanced.md`: ownership, layering, caching, locking, recovery, and edge cases.
- `scripts/release-metadata.ts`, `scripts/build-release.ts`, `scripts/verify-release.ts`,
  `scripts/publish-release.ts`, `release/`, and `.github/workflows/ci.yml`: portable release and
  tagged deployment behavior.
- `mods/<mod>/README.md`: mod-specific hazards and prerequisites when a task explicitly includes a mod.

## Choose the change category first

| Change                                | Authored area                                | Required final verification                                         |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Builder behavior, API, CLI, or schema | `src/`, `index.ts`, builder tests/docs       | `bun run fix`, then `bun run check`                                 |
| Builder docs/instructions only        | root/docs metadata and Markdown              | `bun run fix`, then `bun run lint`                                  |
| Release, launcher, or CI change       | `scripts/`, `release/`, `.github/workflows/` | the builder gate, then `bun run build` and `bun run verify:release` |
| Declarative or asset-only mod change  | `mods/<mod>/` with no script change          | `bun run fix:mods`, then `bun run ymb build --mod <id>`             |
| Mod TypeScript/script change          | `mods/<mod>/**/*.ts`                         | `bun run fix:mods`, then `bun run check:mods` and the mod build     |
| Cross-project builder and mod change  | both repositories                            | verify the builder, then verify each affected mod separately        |

`check`, `check:mods`, `fix`, and `fix:mods` are the composed gates, and the only ones a change
has to pass. The narrower scripts behind them — `typecheck`, `lint`, `test`, `prettier`, `biome`,
and their `:mods` and `:fix` variants — exist to narrow down a single failure while you work, not
to replace the gate.

`bun run check` is the builder gate: typecheck, lint, and the suite in `tests/`. It reads only
builder paths, so a mod can never fail it and it passes with `mods/` empty.

`bun run check:mods` is the source-mod gate. It applies the **same** rules — the same
`biome.json`, `.prettierrc.json`, and compiler options — to `mods/` instead, so a mod needs no
tool config of its own. `tsconfig.mods.json` only redirects the shared `tsconfig.json` at
different files; adding `compilerOptions` there would let mod code drift and
`tests/project-gates.test.ts` fails if it appears. `check:all` and `fix:all` run both gates.

Both tools honour `.gitignore`, which hides `mods/*`, so the mod gate has to opt back out: Biome
with `--vcs-use-ignore-file=false`, Prettier — which has no such flag — with
`--ignore-path .prettierignore.mods`. Never add a `mods` rule to that file; it would make the
gate report success over zero files, and `tests/project-gates.test.ts` fails if one appears.

`validate`, `build`, and `sync` all drive the same underlying patch/script/materialization pipeline
at different stopping points. Do not stack them together for one final verification run.

- If you only need validation, run `validate`.
- If you want validation and preview output, run `build` instead of `validate` + `build`.
- If you want validation, preview generation, and live application, run `sync` instead of
  `validate` + `build` + `sync`.

`bun run ymb build --mod <id>` is the normal mod gate because it already includes the same
validation path as `validate` and adds preview materialization. Use `validate` for diagnosis,
validation-only requests, or when you deliberately do not want preview output.

Always run the matching `fix` after editing — `bun run fix` for builder paths, `bun run fix:mods`
for a source mod. Run the applicable final checks after that because automatic fixes can change
source. If a check requires another edit, repeat `bun run fix` and the affected
final checks. Report every check you could not run and why.

For release, launcher, bundling, or workflow changes, also run `bun run build` and
`bun run verify:release` on Windows. Both work from any shell; archive steps pin the Windows
`tar.exe` rather than resolving it through `PATH`.

`bun run publish:release` is **not** part of verifying anything. It deletes and recreates the
published GitHub release for the current version and force-pushes its tag, so run it only when the
user explicitly asks to publish. `build` and `verify:release` write only inside `dist/` and
short-lived directories under the OS temp folder, so both are safe to run for verification.

`RELEASE_REQUIRED_FILES` in `scripts/release-metadata.ts` is the single source of truth for archive
contents, and `scripts/verify-release.ts` enforces it. Add to that list rather than restating it
here.

Both archives ship the byte-identical `resolve-bun.cmd`; the full ZIP differs only by carrying
`runtime/bun.exe` and by attributing that runtime in `THIRD-PARTY-NOTICES.md`. The verifier
exercises both halves of that shared resolver against a `PATH` holding no usable Bun: the full ZIP
must still resolve its own bundled runtime, and the no-Bun ZIP must refuse and point at the full
archive. Neither half can be observed on a machine that simply has Bun installed, which is why the
check builds the `PATH` itself. Smoke-test both packaged launchers, not only the source entrypoint.

## Builder development

### Build the least that works

**Every line is a liability, so the change that ships is the smallest one that makes the behavior
correct and provable.** An abstraction earns its place when a second real caller exists, not when a
second one is imaginable. Ask, in order, before writing anything:

1. **Does this need to exist?** A request for an option, a hook, or a layer is usually a request for
   a behavior. Ship the behavior.
2. **Does the platform already do it?** `RegExp.escape`, `Object.groupBy`, `structuredClone`,
   `node:crypto`, `Bun.file`, `Bun.Glob`, `Bun.YAML`. A hand-rolled copy of something the runtime
   ships is a defect, not a preference.
3. **Does this repository already do it?** See **One vocabulary per idea**.
4. **What is the shortest version a test can fail on?** Write that one.

Concretely, this forbids:

- **A knob nobody sets.** A setting belongs in `ymb.config.yaml` once a real project has hit the
  limit, not because a limit exists. Hard-code it until then.
- **An interface, factory, or base class with one implementation.** Name the concrete thing.
- **A wrapper that only forwards.** Export what it forwards to and delete the wrapper.
- **A parameter that is always passed the same value**, and the branch behind it.
- **A guard for a case no input reaches.** Untested code that reads as a claim the case is real.
- **Duplicated parsing, boolean-flag mazes, and catch-all utility modules.**
- **Compatibility machinery for a break nobody asked to soften.** See **Breaking changes**.

Deletion is part of the change, never follow-up work. When a replacement lands, the dead branches,
superseded tests, stale docs, and now-unreferenced exports go in the same diff. An export nothing
imports is dead even when it looks useful, and an export only its own tests import means either the
behavior has a real caller or the test proves nothing that ships — decide which, in that change.

### One vocabulary per idea

**This is the rule that outranks convenience.** If two places in the codebase express the same
idea, they express it through the same module, under the same name, in the same shape. A second
spelling of an existing idea is a defect even when it works, because the two copies drift and the
drift is only ever noticed by a user.

Before writing a line that formats, names, validates, or classifies anything, find the module that
already owns that idea and use it. Add to that module rather than beside it.

| Idea                                               | The one owner                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `status  subject (note)` file result lines         | `src/report/detail.ts` — statuses, column width, routine/notable   |
| A list sharing one explanation and one fix         | `src/report/findings.ts` — never one labelled line per member      |
| A named value under a headline                     | `src/report/facts.ts` — `Fact`, counts, timings, the padded column |
| What a finished command hands back                 | `src/report/output.ts` — `toCommandOutput`                         |
| `name -> value`, `a \| b \| c`, plurals, durations | `src/report/text.ts`                                               |
| Where a patch operation was written                | `describeOperationLocation` in `src/errors.ts`                     |
| A path as output should spell it                   | `toDisplayPath` / `abbreviateDisplayPath` in `src/path-utils.ts`   |
| A loop reporting progress over N items             | `trackProgress` in `src/engine/progress.ts`                        |
| Every `//` inside an NDF file                      | `src/patch/ndf/comments.ts`                                        |
| NDF character-level scanning primitives            | `src/patch/ndf/chars.ts`                                           |
| A schema fragment two configs both need            | `src/config/shared-schemas.ts`                                     |

Concretely, this forbids:

- A literal `'ok       '`, a `.padEnd(9)`, or a hand-aligned column anywhere outside the module
  that owns the column. Widths are derived, never typed.
- A second list restating what a first list already knows — a table of prefixes beside the table of
  statuses they came from. Classify from the source, so a new entry cannot go unclassified.
- Formatting structured data into text that another layer then parses back apart. Facts stay a
  label and a value until something prints them; `--json` and the terminal read the same data.
- The same concept offered to a modder under two names. Authored keys are named for what they do:
  `leadingComment` and `trailingComment`, not one of them called `comment`.
- Printing shared advice once per subject. If a loop is about to write `<same words> -> <subject>`,
  it wants a `ReportFinding`.

Tests assert through the vocabulary too — `formatDetailLine('kept', path)`, not `'kept       ' +
path`. A test that re-spells the format is a third copy, and it is the copy that makes the other
two look correct.

When an idea genuinely has no owner yet, create one module for it and move every existing copy
into it in the same change. Leaving one behind is how this list got written.

### Comments

**Default to no comment.** Code says what it does; a comment only earns its place when the code
cannot say why. Applies to every `.ts`, `.yaml`, and `.yml` file in this repository and in `mods/`.

- **One or two short lines.** No paragraphs, no essays, no measurements, no history of what was
  tried before. If a rationale needs more than that, the code needs the work, not the prose.
- **Write the why, never the what.** `// Bump on every schema change` earns its place. `// Loop over
the entries` does not, and neither does a JSDoc that restates the signature in sentences.
- **Delete on sight:** section banners, `// ---- helpers ----` dividers, changelog and TODO notes,
  restated parameter and return docs, and any comment that repeats the name below it.
- **Keep only:** a non-obvious constraint or invariant, a deliberate deviation a reader would
  otherwise call a bug, an external quirk (a WARNO data shape, a Bun behavior), and units or
  encodings a type cannot carry.
- A stale comment is a defect. Update it with the code or delete it; never leave both.

A YAML key is named for what it does and its value shows the shape, so the same bar applies: one
short line for a knob whose consequence is not obvious, nothing for the rest. The one thing that is
not a comment is a **commented-out setting** — `ymb.config.yaml` ships every default that way, and a
patch config lists the keys it leaves unset the same way. Those lines are inert configuration a
reader uncomments, so they stay; only the prose around them is trimmed.

Documentation prose belongs in `docs/`, which this rule does not cover.

### Tests

Every behavior change adds or updates a test, and the test has to be able to fail. A gate that
passes because it inspects nothing is worse than no gate.

- **Fixtures are abstract.** Invent the smallest NDF, config, or mod that shows the behavior:
  `sample_mod`, `base`, `addon`, `Descriptor_Unit_A`, `Module_B`. Never copy identifiers, ids, or
  file content out of a real mod under `mods/`, and never make a builder test depend on one being
  checked out.
- **Cover the corner, not just the happy path.** The interesting cases are empty input, one entry,
  the last entry, a missing trailing separator, a comment or string holding something that looks
  like syntax, CRLF, and the case the previous bug produced. A fix without the input that used to
  break it is not covered.
- **Assert the behavior, not the formatting.** Compare the parsed result or the specific line that
  matters. A whole-file snapshot fails on every unrelated whitespace change and hides the one that
  mattered.
- **Keep them cheap and readable.** No sleeps, no shared mutable state between tests, no helper
  that only one test uses, no assertion that cannot fail. Delete a test the moment its behavior is
  gone.
- When a rule is hard to state in a fixture, state it against real game data instead — see the
  `.ndf` sweep in `.agents/memories/2026-07-28-collection-separator-validation.md`.

### Text that YMB prints

Terminal output and Markdown have opposite rules. Do not carry one style into the other.

- **Everything printed by `src/` must be pure ASCII.** The packaged launcher opens a legacy
  `cmd.exe` that does not render UTF-8 in its default code page. No arrows, dashes, bullets,
  emoji, or box drawing. `tests/terminal-output-ascii.test.ts` enforces this and names the file,
  line, and codepoint on failure.
- **`docs/` and every README are the opposite:** GitHub-rendered, so tables, emoji, badges,
  collapsible sections, and mermaid are wanted there.
- Every error carries a plain-language reason and an actionable `suggestion`. Name the bad value
  or path, and give a safe next step.
- CLI wording is a tested contract. Changing a message means updating the assertions that pin it,
  usually in `tests/cli.test.ts`, `tests/report.test.ts`, or `tests/workflow.test.ts`.
  `scripts/verify-release.ts` also pins a few strings from the root help.
- Every printed line comes from `src/report/`. See **One vocabulary per idea** above before adding
  a format; a command should be choosing which shape its result is, never inventing a new one.

### Documentation

`README.md` and `docs/` are written for one reader: someone building a WARNO mod. They are not a
description of how the builder works.

- **No builder internals.** Cache keys, scan indexes, worker scheduling, transaction journals,
  module names, and `src/` paths do not appear. Write what the modder decides, types, and sees.
  If a fact only matters to someone editing `src/`, it belongs in this file or in `.agents/`.
- **Say it once.** Each page owns its topic and links elsewhere instead of restating. `README.md`
  is a showcase — what YMB is, why it helps, install, and links out. It is not a reference, and it
  does not duplicate a page under `docs/`.
- **Examples are abstract.** `my_pack`, `gameplay.armor`, `Descriptor_Unit_T80U` — vanilla WARNO
  names are fine because the reader patches them, but no identifier, id, or snippet from a real
  mod under `mods/`. The one exception is the starter mod `init` writes: docs describing it must
  match what `src/init.ts` actually generates.
- **Update docs in the same change** as the command, config, schema, error contract, or layout
  they describe. A doc that disagrees with the build is a bug report waiting to happen.

### Dependencies and licensing

`Bun.build` inlines every entry of `dependencies` into the shipped `app/*.js`, and the full archive
ships `runtime/bun.exe`. Adding a runtime dependency therefore changes what YMB redistributes.

- `THIRD-PARTY-NOTICES.md` is generated from installed manifests at build time. It needs no manual
  edit, but the build fails if a package declares no version or license.
- Do not edit `LICENSE` or `NOTICE` as a side effect of another change. They are versioned legal
  text; treat a change to them as its own task and say what changed and why.
- Prefer no new dependency. Reuse what is already bundled before adding one.

### Breaking changes

A builder change is breaking if an existing command, config, script API, generated contract, import,
or source mod must change to keep working.

Before implementing one, summarize:

1. what breaks and why the cleaner design is worth it;
2. which callers, docs, tests, and mods are affected;
3. whether the user wants affected consumers migrated or intentionally left incompatible.

Ask the user to choose unless the request already made that choice explicit. Then implement the clean
end state completely. Do not leave deprecated aliases, silent fallbacks, dual formats, or temporary
branches unless the user explicitly asks for a compatibility period.

## Source-mod work

For mod work, the authored truth is `mods/<mod>/config`; build output is only evidence.
`mods/AGENTS.md` has the rules — read it before touching a mod.

## Clean changes and durable notes

Leave touched areas simpler or no more complex than before. Keep diffs scoped, preserve unrelated
user changes, and review for generated files, machine paths, secrets, accidental broad replacements,
and duplicated functionality.

Before calling a change done, grep for what you just wrote. If the string, the shape, or the
concept appears anywhere else in the repository, one of the two is wrong — see **One vocabulary per
idea**. Fixing the area you touched while leaving an identical copy elsewhere is not a finished
change, it is a third variant waiting to be discovered.

**Fix, do not document.** A bug you can fix and cover with a test gets fixed in that change, not
written down as a hazard for the next agent. The same goes for an improvement that breaks nothing:
implement it, test it, and move on. `.agents/` records only what survives the fix, and
`.agents/README.md` is the bar for putting anything there.
