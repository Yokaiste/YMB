# Releases redistribute their dependencies

Last verified: 2026-07-27
Relevant paths: `scripts/third-party-notices.ts`, `scripts/build-release.ts`, `scripts/verify-release.ts`, `THIRD-PARTY-NOTICES.md`

## Finding

A YMB release is not a source checkout. `Bun.build` inlines every entry of `dependencies`
into `app/*.js`, and the full archive also ships `runtime/bun.exe` verbatim. So adding a
runtime dependency changes what the project redistributes, not just what it imports.

`THIRD-PARTY-NOTICES.md` is generated at build time from the installed manifests, driven by
`dependencies` in `package.json`. The build fails if a package declares no version or
license, and `verify-release.ts` fails if the shipped notice omits any component or its
terms link. The full and no-Bun archives get different runtime sections, and neither may
claim the other's state.

By project decision the notice links to upstream license texts rather than reproducing
them.

## Why it matters

Attribution here is a property of the shipped artifact. It cannot be checked by reading
`src/`, and a hand-maintained list goes stale the first time someone adds a dependency.

## How to verify

`bun test tests/third-party-notices.test.ts`, then `bun run build` and
`bun run verify:release`. Delete a table row from `dist/YMB/THIRD-PARTY-NOTICES.md` and
re-run the verifier: it must name the missing component.
