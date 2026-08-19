# Generated-block ownership survives byte-identical output

Last verified: 2026-07-23
Relevant paths: `src/scripts/materialize.ts`, `src/generated-blocks.ts`, `src/api.ts`

## Finding

YMB block markers record every contributing script, not just the produced text. So when
one script takes over generating blocks that previously came from several, returning the
same bytes still changes marker hashes.

The coordinator must set `generatedBlockOwnerPaths` to the same-mod scripts whose blocks
it produced. YMB validates that delegation and rejects arbitrary or cross-mod owners.

## Why it matters

Merging generators looks like a pure refactor: the NDF output is identical, so a preview
diff shows nothing. The markers still change, and without the delegation the next build
reattributes those blocks to the wrong script.

## How to verify

Compare generated output hashes _and_ any persistent store hashes against a clean
baseline, with `--no-cache` on both runs. Preview text alone cannot show this.
