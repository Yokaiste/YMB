# Pointing a formatter at `mods` is not an opt-out from `.gitignore`

Last verified: 2026-07-28
Relevant paths: `package.json`, `.gitignore`, `.prettierignore.mods`, `tests/project-gates.test.ts`

## Finding

`mods/*` in `.gitignore` keeps a source-mod checkout out of three things at once: the builder's
`git status`, Prettier (which defaults `--ignore-path` to `.gitignore`), and Biome
(`vcs.useIgnoreFile`).

Each `:mods` script therefore has to opt back out of it, and naming `mods` as the target is not
an opt-out - both tools still consult the ignore file for every path they walk. Biome takes
`--vcs-use-ignore-file=false`; Prettier has no such flag, so it gets a separate
`--ignore-path .prettierignore.mods`. `prettier:mods` shipped without that and reported
"All matched files use Prettier code style!" over zero files.

## Why it matters

The failure is silent in both directions. A broken opt-out checks nothing and passes every test
that only asserts a clean exit, and uncommenting the `.gitignore` line looks like pure git
hygiene while quietly moving which project a lint failure belongs to.

## How to verify

`prettier --ignore-path .prettierignore.mods --file-info mods/<mod>/<any>.ts` must report
`"ignored": false`. Then drop a badly formatted `.ts` under `mods/` and confirm `bun run check:mods`
actually fails - a gate that checks nothing passes everything else you can write for it.
