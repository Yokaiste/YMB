# Implementation constraints

Read only the section relevant to the change. Keep this file for durable constraints;
put user instructions in `docs/`, and fix bugs rather than storing investigation logs.

Design decisions follow [development principles](../docs/development.md). These
implementation constraints preserve correctness; they do not justify promoting
feature policy, derived values, or incident-specific checks into shared infrastructure.

## NDF and performance

- `src/patch/ndf/validate.ts` owns syntax validation. Keep synchronous, cooperative,
  script and final-output checks on the same grammar. Preserve diagnostic codes and
  numeric positions across JSON and worker transport. Test invalid fixtures beside
  valid ones; do not weaken syntax rules to accommodate prose in `.ndf` test files.
- `src/patch/ndf/scan.ts` owns scanning. Indexed and fallback lookups must ignore strings,
  comments and nested declarations alike. Templates stay outside indexed top-level
  objects because including them would renumber index selectors.
- A collection entry's `end` excludes its comma; `separatorEnd` includes it. Appending
  after an entry without a separator must supply one. Bare values, typed template
  parameters, chained declarations and operators do not share one whitespace rule.
  When changing grammar, supplement abstract tests with a read-only sweep over real NDF.
- Expand `forEach` before resolving operations: loop bindings do not exist earlier.
- Preserve `NdfTextBuffer`'s edits in pieces and bounded scan-cache retention. Rebuilding
  or hashing a whole game file per operation becomes expensive on large descriptors.
- The line diff has blocking and cooperative drivers over one algorithm. Keep its work
  budget and linear auxiliary memory. Large IPC payloads use `runtime-exchange.ts` files.
- `expect.referenced` is opt-in. WARNO reads some roots by name, so absence of textual
  references does not establish that a block is unused.

## Ownership and state

- Script output is an ordered transformation only if that execution read the exact
  current target. Preserve observed-read hashes and the original merge base for other
  writers. Generated blocks use their owners instead of this shortcut.
- Combining generators can change ownership even when output bytes match. Preserve
  stable owner ids and explicitly declare delegated same-mod `generatedBlockOwnerPaths`.
- A disabled feature does not imply that its persistent ids can be retired. Saved decks
  may still reference them. Caches are disposable; identity stores and recovery are not.
- Keep summaries structured until the CLI/JSON renderer. Use `src/report/` for formatting.

## Checks and releases

- `mods/*` is ignored by builder checks. Mod gates must opt out: Biome uses
  `--vcs-use-ignore-file=false`; Prettier uses `.prettierignore.mods`.
- CLI, patch, script and test workers need separate release entrypoints. Preserve the
  source `.ts` and packaged `.js` resolution in `src/runtime-entrypoint.ts`.
- Import runtime API symbols through `ymb/api`. Bundles must share one `ScriptToolError`
  class; relative imports can inline distinct classes and break `instanceof` across workers.
- `scripts/release-metadata.ts` owns archive contents. Third-party notices are generated
  from bundled dependencies; the full archive also attributes its bundled Bun runtime.
- Batch blocks expand `%errorlevel%` before their commands run. Preserve the actual
  command exit code before `endlocal`, and keep `.cmd`/`.bat` files in CRLF.
- Verify both archives on Windows with `bun run build` and `bun run verify:release`.
  The resolver checks must control PATH to cover missing and mismatched Bun. Help alone
  does not exercise workers; use a synthetic packaged build too.
- When adding a launcher check, break its one guarded behavior in a disposable extracted
  archive, confirm the intended check fails, restore, and rerun. Never mutate source or
  published artifacts for this check.
