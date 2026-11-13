# YMB contributor rules

This is the source checkout of Yokaiste's Mod Builder. Work here improves the tool.
`mods/*` contains independent projects with their own repositories and agent rules.
Read their instructions and inspect their Git status before changing them.

## Before editing

1. Read the affected code, its callers, and the relevant user contract in `docs/`.
2. Identify every affected caller, config, fixture, export, generated template, and release file.
3. Check each affected repository's status. Preserve existing work; stage, commit, or
   publish only when requested. Keep license texts and notices intact.
4. Use the relevant section of [.agents/README.md](.agents/README.md) for implementation
   constraints. Do not load unrelated files just to build context.

## Code: Ponytail

- Make the smallest complete change. Prefer deletion, an existing helper, the runtime,
  then an installed dependency. Add a dependency only when that order cannot solve the task.
- Fix a defect once at its owner after tracing callers. Finish any required migration
  across code, tests, docs, and generated projects in the same change.
- Keep modules together by responsibility. Share a mechanism when independent callers
  need it; avoid forwarding wrappers, registries, and speculative configuration.
- Keep game balance, factions, rosters, and mod-specific policy in the mod project.
  YMB must work with invented projects and independent authoring conventions.
- Optimize repeated work and expensive paths when the task exposes them. Preserve
  bounded memory, cooperative yielding, caching, and useful error handling.
- Keep validation at input boundaries and preserve ownership, recovery, and identity.
  Persistent identity stores are authored data even if their filename says `generated`.
- Explain only a non-obvious reason in comments. A deliberate limit uses
  `shortcut: <limit>, <when to upgrade>`.

## Text: Humanizer

Read each affected text surface in full. Mark filler, invented contrasts, repeated
closers, forced three-part lists, vague claims, excessive bold, and chat residue.
Rewrite for its reader; check facts, names, examples, links, and behavior against the
code. Read the result again and remove the remaining tells. Use direct verbs, sentence
case, varied sentence lengths, and no em or en dashes in prose. Keep useful humor
occasional; never let a joke replace a recovery step.

Beginner YMB guides extend the same `init` project into a playable mod: menu title,
one real unit's health, then groups and bulk edits. Use verified WARNO targets,
complete edits, expected results, and a clear next lesson. Keep invented game types
in test fixtures; tutorial changes must be usable in the game. Explain when a new
example replaces an earlier one so readers do not stack conflicting patches.

| Surface                        | Reader and purpose                                                        |
| ------------------------------ | ------------------------------------------------------------------------- |
| Root README and product images | A curious user: benefits, visuals, download, basic setup, links           |
| `docs/`                        | A learner: reproducible examples, expected results, task order, reference |
| CLI output                     | A person doing one task: outcome, location, next action                   |
| `--json`                       | A program or agent: stable structured fields, no decoration or prompts    |
| This file and `.agents/`       | YMB contributors: decisions and constraints                               |
| `release/AGENTS.md`            | Installed-release agents: using YMB to develop mod projects               |

Use **mod project** for editable files in `mods/<id>`, **WARNO mod folder** for the
target with `GameData` and `CommonData`, **patch** for a selectable set of changes,
and **preview** for build output. Keep command names and schema keys literal:
`paths.sourceMods` remains the setting for the mod projects folder.

Markdown links within the project are relative. Images need descriptive alt text.
Use [YSM Community Discord](https://discord.gg/33Sqn6dTjf) for community, support,
feedback, and bug-report links. Keep GitHub links for source code and downloads.
Keep terminal text ASCII and preserve the symbol-based YMB logo in human output.
Machine mode must keep stdout and stderr free of human chatter. Keep JSON field
types, diagnostic codes, numeric locations, and truncation explicit; document any
intentional protocol break with a migration.

## Find the implementation

| Responsibility                      | Files                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Commands, help, progress, JSON      | `src/cli.ts`, `src/cli-guide.ts`, `src/cli/`                              |
| Config, variables, starter projects | `src/config/`, `src/templates.ts`, `src/init.ts`, `src/builder-config.ts` |
| Discovery and selection             | `src/discovery/`, `src/planner/`, their root modules                      |
| Preview, sync, recovery, ownership  | `src/engine/`, state and merge modules                                    |
| NDF syntax and edits                | `src/patch/ndf/`                                                          |
| Public script API                   | `src/api.ts`, `src/scripts/`                                              |
| Report formatting                   | `src/report/`                                                             |
| Portable packages and publishing    | `scripts/`, `release/`, `.github/workflows/ci.yml`                        |

## Checks and delivery

Install checkout dependencies with `bun install --frozen-lockfile`. Run source
commands with `bun run ymb <command>`; `bun run build` packages YMB itself.

Use small invented fixtures. Test observable behavior and real failure boundaries,
with a valid neighboring case for rejection tests. New branches, parsers, loops,
or scripts need a focused test or assert-based check. Prose-only edits need no new
test. Avoid snapshots of help wording, implementation-text assertions, production
balance values, and tests that repeat the code. Builder checks must run without mods.

| Change                | Required checks                                                      |
| --------------------- | -------------------------------------------------------------------- |
| Builder docs          | `bun run fix`, `bun run lint`                                        |
| Builder code or tests | `bun run fix`, `bun run check`                                       |
| Release, launcher, CI | Builder checks, `bun run build`, `bun run verify:release` on Windows |
| Mod project           | Its own agent guide and checks                                       |

A preview build includes validation. Use it for mod integration checks; do not also
validate the same selection. `sync`, `recover`, WARNO compilation, and publishing
change installed or public state, so use them when the task authorizes that outcome.
Do not edit live game data or disposable build output as a fix.

Review each repository's diff and generated release contents. Report the result,
checks, migrations, and any limitation. End with what was skipped or unverified and
any remaining risk.
