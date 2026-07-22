# Portable release worker entrypoints (2026-07-23)

YMB is not a single-entry CLI bundle. Patch materialization, generation scripts, and companion
tests spawn three independent Bun subprocess entrypoints. Source execution locates sibling `.ts`
files, while the portable release locates minified sibling `.js` bundles. Any release layout
change must preserve this relationship through `resolveRuntimeEntrypoint` and must smoke-test a
real build with the packaged CLI; `--help` alone cannot detect missing worker bundles.

Source-mod scripts resolve `ymb/api` through the nearest YMB `package.json`. The portable package
therefore needs a runtime export to `app/api.js` and a type export to `types/api.d.ts`, even though
the CLI's production dependencies are otherwise bundled.

Windows batch blocks expand `%errorlevel%` before commands inside the block execute. Keep direct
launcher execution outside a parenthesized block and capture its exit code before `endlocal`, or
`YMB.bat` may incorrectly report a failed CLI command as successful.

The no-Bun archive uses the same launcher and production files but omits `runtime/bun.exe`.
`app/resolve-bun.cmd` must then resolve `bun.exe` from `PATH`, require the exact version from
generated `release-info.cmd`, and fail with the versioned complete-archive URL. Verify valid,
missing, and mismatched system-runtime paths; checking only archive contents is insufficient.
