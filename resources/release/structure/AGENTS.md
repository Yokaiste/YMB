# Mod authoring rules

Read the selected project's AGENTS.md, configuration, and license. Each folder
under mods/ is independent. Edit authored inputs and use YMB's public SDK.

## Scope and data

- Keep gameplay policy in the mod. Change another project or YMB itself only when
  the task includes it. Authorized builder work follows its source agent rules.
- Preserve existing work, attribution, project ids, GUIDs, localisation tokens,
  generated owners, and identity stores. Identities belong in config, outside caches.
- Fix authored inputs, not previews or live GameData/CommonData. Sync, recovery,
  compilation, publication, and discarding data require authorization from the task;
  do not request the same authorization again.
- Follow each project's license. YMB permits use and private modification;
  redistribution needs the permission in LICENSE. Public mods must credit
  [YMB](https://github.com/Yokaiste/YMB) with a working link. Contributor authorization
  does not waive third-party terms.

## Implementation: Ponytail

Trace affected callers, settings, tests, and output. Use the smallest complete
change: remove needless work, reuse project helpers or the SDK, then use the
standard library or an installed dependency. Share mechanisms only when independent
callers need them. Keep policy with its feature.

Fix the shared cause and update all affected examples and callers. Preserve input
validation, error handling, stable identities, recovery, and resource bounds.
Test nontrivial logic with a focused behavior check; do not snapshot prose or
repeat configuration values. Comment only a hidden constraint. Record a deliberate
limit as `shortcut: <limit>, <when to upgrade>`.

## Writing: Humanizer

Read the affected text completely. Remove filler, invented contrasts, repeated
closers, inflated claims, and decorative formatting. Verify facts and examples.
Use plain verbs, sentence case, varied sentences, and no em or en dashes in prose.
Keep identifiers, commands, paths, schema fields, and message codes literal.

READMEs showcase the player experience; guides teach reproducible tasks; references
specify contracts; agent files hold policy. Keep jokes out of agent files. Elsewhere,
use occasional humor without hiding the failed input or next action. Preserve brands.
Use diagrams, tables, and file trees when they explain something; give images alt text.
Link product READMEs to docs/README.md. Keep its complete index there; do not add
section READMEs or moved-page stubs that repeat it.
Keep navigation tables out of showcase READMEs; place links beside relevant text.
Store documentation media in each project's docs/assets.

Teach through a real playable project. Name the file, give a complete edit, state
which previous version to replace, and show the expected result. Keep named
previous/current/next links at both ends of lessons and guides. Separate lessons
from internals. Keep generator and coding lessons advanced and optional; the
beginner route must work without them.

## Check and report

From the YMB folder, use `.\YMB.exe doctor --json`, `list --mod ID --json`,
`explain --mod ID --json`, and `build --mod ID --json` as needed. Use `find --json`
for objects and `<command> --help` for options. Build includes validation and tests;
inspect its preview before an authorized sync. WARNO's tools compile after sync.

Check exit status, JSON status, and diagnosticCounts.error. A completed command can
contain ineffective-operation findings. JSON mode never prompts; add --yes only
for authorized writes. SDK validation, dry runs, and tests discard staged authored
writes; trusted generators can still write directly outside those helpers.

Shared defaults belong in ymb.config.yaml; local overrides in .ymb/config.yaml.
The mod config directory is its operational root. Use SDK persistent helpers for
generated identities in its .ymb folder; use SDK cache helpers and modSessionRoot
for temporary data under YMB/.ymb/mods/ID. Do not hardcode storage paths. Mod dist
belongs beside ymb.mod.yaml. Package extras through release.include; download links
must point directly to HTTPS archives. Use src for Rust source directories.
Keep .ymb/state until recovery is complete. Start with [the documentation map](docs/README.md).

For a likely builder defect, offer a report for the
[YSM Community troubleshooting forum](https://discord.gg/33Sqn6dTjf): version,
command, expected/actual result, diagnostic, and minimal reproduction. Remove
personal paths and secrets. Do not post without authorization.

Finish with changed behavior, checks run, unverified work, and remaining risk.
