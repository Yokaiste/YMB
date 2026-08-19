# An unreferenced NDF block is not a broken one

Last verified: 2026-08-02
Relevant paths: `src/engine/block-references.ts`, `src/config/schemas.ts`, `docs/configuration.md`

## Finding

Reference counting cannot decide whether a top-level NDF block is live. Measured over one
real WARNO install (4517 `.ndf` files, 199 MB, `GameData` + `CommonData`): **80831
declared top-level blocks, of which 7847 — 9.7% — are referenced by no other block**, and
they work. WARNO reads plenty of them by name from the engine rather than through NDF;
`DeckCreatorMaxUnitsInDeckPerCategory` is one, and a source mod legitimately patches it.

So a warning of the form "this patched block has no references left" is wrong about one
block in ten, and nothing in the text separates an engine-read root from a block a
generator orphaned. The only party that knows is the patch author, which is why
`expect.referenced` is opt-in and names blocks one at a time.

Two details the check depends on:

- **String literals must not count as references.** A UI block carries its own name again
  as `ElementName = "Name"`, and an inlined copy of it carries the same, so counting
  quoted occurrences reports every orphan as reachable. Everything else is counted,
  comments included: over-counting costs a warning nobody gets, under-counting fails a
  working build.
- **A declaration is not a reference.** `Name is Type` is excluded, or every block would
  reference itself.

## Why it matters

It settles a rejected design. The obvious version of this feature — warn automatically
whenever a patched block ends up unreferenced — was measured before being built and does
not survive contact with real game data, in-file or tree-wide. Anyone proposing it again
can re-run the numbers below instead of shipping it.

## How to verify

Collect declarations with `/^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)[ \t]+is[ \t\r\n]/gm` and
references with `/(?<![\w"'])([A-Za-z_]\w*)(?![\w"'])(?![ \t]+is[ \t\r\n])/g` over every
`.ndf` under the game root, then subtract. One pass, about 5 s.
