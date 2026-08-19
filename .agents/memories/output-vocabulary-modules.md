# Every printed line comes from `src/report/`

Last verified: 2026-08-03
Relevant paths: `src/report/`, `src/config/shared-schemas.ts`

## Finding

The `AGENTS.md` vocabulary table lists which module owns which printed shape. Two properties of
that arrangement are not visible from the table, and both are what keep it from decaying:

- **Nothing about a detail line is typed twice.** `DETAIL_STATUSES` in `src/report/detail.ts` is
  the only place a status exists; the column width and `isRoutineDetailLine` are both derived
  from it. So a status cannot be printed without also being classified as routine or notable —
  the failure that a separate list of prefixes used to allow.
- **Facts stay structured to the last moment.** `CommandOutputLines.summary` is `Fact[]`, not
  text. The terminal renderer and `--json` read the same values; neither parses the other's
  output, so a value may contain any character.

## Why it matters

Before this, the same idea was spelled several ways at once: a literal `'ok       '` here, a
`.padEnd(9)` there, an eleven-wide `'to remove  '` in a third place, and a `label -> path` in a
fourth — with the padded prefixes restated a fifth time as `ROUTINE_DETAIL_PREFIXES` so the CLI
could classify them. That second list could drift from the lines it classified with nothing
failing. Summaries were flattened to `label: value` text and split apart again in two places, so a
value could never contain the separator.

The same drift reached authored config: the leading-comment key was unified as `leadingComment`
while the bulk-edit one stayed `comment`, offering a modder two vocabularies for one idea. It is
now `trailingComment`, named for where it lands.

## How to verify

`bun test tests/report.test.ts` — the routine-classification test walks `DETAIL_STATUSES` and
fails if any status disagrees with the table it was written from.

`rg -g '!src/report/*' "padEnd\(9\)|'ok       '|ROUTINE_DETAIL" src` should find nothing. The
exclusion is deliberate: `src/report/detail.ts` quotes those spellings in the comment explaining
why they are gone, so a grep over all of `src` matches the fix rather than a regression.
