# Script output lineage for markerless targets

Last verified: 2026-07-23
Relevant paths: `src/scripts/materialize.ts`, `src/scripts/runtime-context.ts`, `src/text-merge.ts`, `tests/workflow.test.ts`

## Finding

A later script output for a markerless target is an ordered transformation only when that
execution read the exact current target content. The runtime records target reads with content
hashes, and materialization compares that observation with the current output before accepting
the new text directly. Keep the original merge base stable for scripts that did not observe the
current target so independent writers still merge or conflict. Generated-block targets remain
owner-merged and never use this shortcut.

## Why it matters

Rebasing after any full-file script output avoids an expensive cumulative diff but silently lets
an independent later writer overwrite earlier work. Re-diffing every cumulative output against
the original base preserves conflicts but can repeat worst-case diff work and lose the fact that
a script intentionally transformed the preceding output. Read lineage distinguishes those cases.

Full-file fallback diffs use a divide-and-conquer line LCS with linear auxiliary memory and an
explicit line-work budget. Do not restore a Myers implementation that retains every frontier:
large unrelated rewrites can require quadratic trace memory.

## How to verify

Run `bun test tests/workflow.test.ts --test-name-pattern "markerless|same-target scripts|independent writer"`
and `bun test tests/text-merge.test.ts tests/script-runtime.test.ts`.
