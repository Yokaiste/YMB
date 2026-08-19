# Portable release worker entrypoints

Last verified: 2026-07-23
Relevant paths: `src/runtime-entrypoint.ts`, `scripts/build-release.ts`, `scripts/release-metadata.ts`, `release/YMB.bat`, `release/resolve-bun.cmd`

## Finding

YMB is not a single-entry CLI bundle. Patch materialization, generation scripts, and
companion tests each spawn their own Bun subprocess entrypoint. Source execution locates
sibling `.ts` files; the portable release locates minified sibling `.js` bundles. Any
release layout change must preserve that relationship through `resolveRuntimeEntrypoint`.

Source-mod scripts resolve `ymb/api` through the nearest YMB `package.json`, so the
portable package needs a runtime export to `app/api.js` and a type export to
`types/api.d.ts` even though the CLI's dependencies are otherwise bundled.

Windows batch blocks expand `%errorlevel%` before the commands inside the block run. Keep
direct launcher execution outside a parenthesized block and capture its exit code before
`endlocal`, or `YMB.bat` reports a failed CLI command as successful.

The no-Bun archive uses the same launcher and app files but omits `runtime/bun.exe`.
`app/resolve-bun.cmd` must then resolve `bun.exe` from `PATH`, require the exact version
from generated `release-info.cmd`, and fail with the versioned full-archive URL.

## Why it matters

A release can pass `--help` and still be broken: missing worker bundles only surface once
something actually spawns a subprocess. Archive contents alone prove nothing about the
no-Bun path either, because its failure mode is a wrong or absent system runtime.

## How to verify

Run `bun run build`, then `bun run verify:release` on Windows. Smoke-test a real build
with the packaged launcher rather than `--help` alone, and exercise the no-Bun archive
with a valid, a missing, and a mismatched system Bun.
