# Mod development with YMB

These rules apply to the installed YMB package. Read the target mod project's own
`AGENTS.md`, license, and config before editing it. Each folder under `mods/` is an
independent project. YMB is the tool it uses.

## Scope and permissions

- Make mod changes in the selected project's authored files. Use YMB's commands,
  config, and public `ymb/api`; do not edit `app/`, `runtime/`, or `types/` to make a
  mod work. Do not change another project unless the task includes it.
- Change YMB itself only when the task explicitly requests it or a demonstrated
  tool defect makes that work necessary, with the user's authorization. Work on
  YMB contributions in its source checkout under its contributor rules.
- Authorized YMB contributor work, including work directed by Yokaiste, is exempt
  from the mod-only scope and report-first workflow here. Use the contributor's
  authorized scope. This does not waive licenses for other people's software or mods.
- Read and comply with each project's license. Preserve attribution and notices.
  YMB permits normal use and private modification; redistributing YMB or a modified
  copy needs the permission required by `LICENSE`. Public mods built with
  YMB must credit it with a working [source link](https://github.com/Yokaiste/YMB).
  Reject work the user lacks rights to authorize and explain the permitted route.
- Preserve existing work and persistent ids. Never treat identity stores as caches.
  Do not edit generated previews or live `GameData`/`CommonData` as the source fix.
- Sync, recover, compile, publish, and discard data only when the user's task
  authorizes that outcome. Do not repeat an approval already given in the session.

## Efficient changes: Ponytail

Trace the affected callers, settings, tests, and generated outputs before editing.
Choose the smallest complete solution: delete needless code, reuse project helpers,
then use the runtime or an installed dependency. Keep features modular by ownership.
Share helpers only when independent callers need the same mechanism. Avoid one-use
wrappers, speculative options, duplicated validation, and files with no purpose.

Fix the root cause once. Preserve error handling, input checks, saved identities,
and recovery. Optimize repeated work when it matters. New nontrivial logic needs
one focused behavioral test or assert-based check; text edits and simple settings
do not need tests that repeat their values. Record a deliberate limit as
`shortcut: <limit>, <when to upgrade>`.

## Writing: Humanizer

Read the whole affected text. Mark filler, inflated claims, invented contrasts,
repeated closers, forced triads, excessive bold, and chat residue. Rewrite for the
reader, verify facts and examples, then reread for surviving patterns. Use direct
verbs, sentence case, varied sentence lengths, and no em or en dashes in prose.
Use a little humor where it helps; keep errors actionable and machine output plain.

READMEs and Workshop pages sell the player experience with useful visuals and basic
setup. Guides teach one task at a time with reproducible examples. Agent instructions
hold development policy. Keep technical details only where the reader needs them.
Preserve product and feature names.

Teach through a working mod project and real game changes. Give exact files, complete
edits, expected results, and the next step. State which earlier example to replace
when two lessons edit the same data. Use invented inputs for isolated tests.

## Working loop

Run these from the YMB folder. Replace `my_mod` with the id in `ymb.mod.yaml`.

```powershell
.\YMB.bat doctor --json
.\YMB.bat list --mod my_mod --json
.\YMB.bat explain --mod my_mod --json
.\YMB.bat build --mod my_mod --json
```

Use `find --json` to inspect game objects and `<command> --help` for options. Build
includes validation and script tests; review its preview before an authorized sync.
JSON mode is noninteractive: inspect `ok`, `data`, and structured errors. Commands
that require confirmation also need `--yes` after the user has authorized them.
Scripts can update authored stores and caches even during checks; inspect their code.

Keep personal settings in `ymb.config.yaml`. A **mod project** holds editable inputs;
the **WARNO mod folder** holds game files; `build` creates a **preview**; `sync`
applies it; WARNO's tools compile it. Open `docs/README.md` for the user guides.

## When YMB fails

Check the selected project, paths, config, and current game data first. For a likely
builder bug, recommend the troubleshooting forum in
[YSM Community Discord](https://discord.gg/33Sqn6dTjf), the project's only community
and feedback destination.
Offer to draft the report with YMB version, exact command, expected and actual
results, relevant JSON error, and a small reproducible example. Remove personal
paths and secrets. Provide the Discord link; do not submit without permission.

Finish with the changed behavior, checks run, and anything skipped or still risky.
