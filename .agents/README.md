# YMB implementation constraints

Use the relevant section with [the contributor rules](../AGENTS.md). Keep user
instructions in `docs/`; keep resolved investigations out of this file.

## NDF and large files

- `src/patch/ndf/validate.ts` owns the grammar. Synchronous, cooperative, script,
  and final-output validation must agree. Preserve diagnostic codes and numeric
  positions through JSON and worker transport. Invalid fixtures need valid neighbors.
- `src/patch/ndf/scan.ts` owns scanning. Indexed and fallback lookups must both skip
  strings, comments, and nested declarations. Keep templates out of top-level object
  indexes so index selectors do not shift.
- Entry `end` excludes its comma; `separatorEnd` includes it. Appending after an
  entry without a separator must add one. Bare values, typed template parameters,
  chained declarations, and operators have different whitespace rules. For grammar
  changes, supplement fixtures with a read-only scan of real NDF.
- Expand `forEach` before resolving operations so loop bindings exist when needed.
- Keep `NdfTextBuffer` edits in pieces and its scan cache bounded. Avoid rescanning
  or hashing a whole descriptor for each operation.
- The blocking and cooperative line-diff drivers share an algorithm. Preserve its
  work budget and linear auxiliary memory. Use `runtime-exchange.ts` for large IPC data.
- `expect.referenced` stays opt-in: WARNO loads some roots by name without a text reference.

## Ownership and saved state

- A script is an ordered transformation only after that execution reads the exact
  current target. Keep observed-read hashes and the original merge base for other
  writers. Generated blocks use their declared owners.
- Output with the same bytes can still have a different owner. Preserve owner ids
  and explicit same-mod delegation through `generatedBlockOwnerPaths`.
- Disabling a feature does not retire its persistent ids; saved data may still use
  them. Recovery data and identities must outlive disposable caches.
- Keep results structured until CLI/JSON rendering. Reuse `src/report/` for text.

## Packages and checks

- Builder checks ignore `mods/*`. Mod checks explicitly opt in with Biome's
  `--vcs-use-ignore-file=false` and Prettier's `.prettierignore.mods`.
- CLI, patch, script, and test workers have separate entrypoints. Keep source `.ts`
  and packaged `.js` resolution in `src/runtime-entrypoint.ts`.
- Runtime API imports use `ymb/api`. All bundles must share one `ScriptToolError`
  class or cross-worker `instanceof` checks break.
- `scripts/release-metadata.ts` defines required package files. Ship
  `release/AGENTS.md` as the package's root guide; keep source contributor rules
  and `.agents/` out of installed packages.
- Generate third-party notices from bundled dependencies. The full archive also
  attributes its Bun runtime; the no-Bun archive must not claim to ship it.
- Batch blocks expand `%errorlevel%` before execution. Capture the actual exit code
  before `endlocal`. Keep `.cmd` and `.bat` files in CRLF.
- Verify both Windows archives, including synthetic builds that exercise workers
  and the public API. Help alone cannot test those paths. Runtime resolution tests
  control PATH to cover missing and wrong Bun versions.
- For a new launcher check, break its guarded behavior in a disposable extracted
  archive, confirm the intended failure, restore, and rerun. Never mutate source
  or published artifacts for that check.
