# `findNamedBlockByName` answers from four readers that must agree

Last verified: 2026-08-01
Relevant paths: `src/patch/ndf/scan.ts`

## Finding

Resolving one top-level block by name tries four readers in order, and only the first is the
indexed scan:

- `findTopLevelBlocks`, the cached single pass that also defines the order `@<index>` counts;
- `findTemplateBlockByName`, for `template Name [ parameters ] is TypeName ( body )`;
- `findBareNamedCollectionBlock`, for `Name is` followed by `[ ... ]`;
- `findBareNamedScalarBlock`, for `Name is <value>` on one line.

The last three find their candidate with a line-anchored regex, which knows where a line begins
and nothing else. `createTopLevelOffsetTracker` is what turns a candidate into a block: it walks
the text once, carrying depth, string, and line-comment state, so a declaration nested inside
another block, spelled inside a string, or commented out is skipped rather than returned. Any
rule added to the indexed scan has to hold for that tracker too, or the same file resolves
differently depending on which reader answers.

Templates deliberately stay out of `findTopLevelBlocks`, because adding them would renumber every
`@<index>` selector already written against a file. `findTemplateBlocks` exists for the callers
that want them anyway - the `add` name-conflict checks, where a name is taken whichever form
declares it.

## Why it matters

A wrong answer here is not a failed build. The patch applies cleanly to the wrong range and
rewrites a comment line, or reports "block not found" for a block that is plainly in the file.
Over half of the 1036 templates WARNO ships were unreachable while the template reader accepted
only one of the header spellings the game data uses.

## How to verify

`tests/ndf-scan-cache.test.ts` ("skips a commented-out header whether or not the file is
indexed yet") applies the same single-operation target twice and asserts both outputs match.
`tests/ndf-reader.test.ts` ("template header spellings", "names that only look top-level") pins
the fallback readers against every arrangement the game data uses.

See also [one implementation per scanner](2026-07-27-one-implementation-per-scanner.md) and
[collection separator validation](2026-07-28-collection-separator-validation.md).
