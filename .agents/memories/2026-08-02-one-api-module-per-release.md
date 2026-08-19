# A packaged release must hold exactly one `ymb/api`

Last verified: 2026-08-02
Relevant paths: `src/api.ts`, `scripts/release-metadata.ts`, `scripts/build-release.ts`, `scripts/verify-release.ts`

## Finding

`ymb/api` is not a types-only module: `ScriptToolError` is a class, and both sides compare
it by identity. A mod script catches what `context.tools` raises with `instanceof`, and
`src/scripts/runtime-shared.ts` reads `error.options` off what a script raises the same
way. Each release entrypoint is bundled separately, so any builder source importing the
module by a relative path gets a private copy inlined into every bundle that reaches it.
Five classes then ship, all named `ScriptToolError`, none `instanceof` any other.

Builder sources therefore import `'ymb/api'`, every bundle but `api.js` marks it external
(`resolveBundleExternals`), and the shipped `package.json` exports resolve it back to the
single `app/api.js` — the same file a mod script gets. See
[portable release worker entrypoints](2026-07-23-portable-release-workers.md) for why that
export has to exist at all.

## Why it matters

Nothing about this is visible from source, where every spelling already lands on the same
file: `bun run check`, `bun run ymb build`, and the whole test suite pass while every
packaged release silently drops the reason, suggestion, and details of any structured
error crossing between builder and mod.

## How to verify

`bun run build`, then check that `"ScriptToolError"` appears as a string literal in
`dist/YMB/app/api.js` and in no other `dist/YMB/app/*.js`. `bun run verify:release`
asserts exactly that, and a mod whose script test catches a `context.tools.values` failure
is the end-to-end version.
