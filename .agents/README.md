# Implementation constraints

The root Cargo.toml owns application, minimum compiler, edition, and format versions. Derive requirements and release metadata from it. Keep Cargo.lock. Package consumers can use precompiled generators without a toolchain; source authors use the declared compiler.

## NDF and text

Use the shared grammar for syntax, top-level blocks, nested objects, fields, and lists. Ignore comments and string contents during structural reads. Exclude template roots from object indexes while retaining genuine nested objects. Collection entry spans exclude their separator; edits needing removal also account for separator_end.

Keep ownership-marker comments on complete lines so adjacent declarations
remain active. Collection identity ignores comments and optional final commas.
Compose actions on the same bulk list in order; retain scalar overlap errors.
Preserve decimal multiplication precision and the shared rounding rules.

Expand forEach before resolving its bound variables. Preserve raw versus quoted values and deterministic descriptor reidentification. Prefer one indexed scan over scans inside loops. Keep changed-text comparison budgets and bounded cache payloads. A large unchanged prefix must not consume the diff budget.

## Generation and ownership

The SDK is the only mod-facing API. Feature policy stays in mod projects. Keep generators deterministic and preserve stable project, patch, generator, region, GUID, and localisation identities.

A sequential generator must read the exact target it transforms. Cross-project transformations also require ordering and write permission. Keep the original merge base. Declare only registered same-project generated owners; preserve other contributors' regions.

Use staged SDK authored writes for identity registries. Companion tests and validation cannot commit them. Failure must preserve game data, recovery records, and authored identities. A real build discards old build work before generation; validation and dry runs retain the existing preview.

## Files and recovery

Reject traversal, symlinks, junctions, Windows device names, case aliases, and file/directory ownership collisions at boundaries. Capture immutable payloads once and pass file-backed descriptors for large content. Validate hash, length, kind, token, and output syntax before publication.

Read and write limits for manifests and journals must agree. Validate every rollback snapshot before restoring the first file. Preserve legacy originals and marker identities when recovering installed output. Never infer that an edited live file is safe to overwrite.

## Documentation and releases

Keep these storage boundaries:

| Content | Location and lifetime |
| --- | --- |
| Shared, commented defaults | Root ymb.config.yaml |
| Installation overrides | Builder .ymb/config.yaml |
| Portable executable, SDK, legal files | Outside .ymb |
| Compiler objects, executables, result caches, package verification | Builder .ymb; reuse across commands and failures |
| Optional portable Rust | Builder .ymb/engine; retain during normal cleanup and updates |
| Compact reusable installation data | Mod-level .ymb; no compiler trees or shipped caches |
| Authored identities | config; outside disposable paths |

Replace superseded output and remove completed transaction or verification scratch.
Keep reusable caches unless reclaiming space explicitly. Do not run cargo clean
as routine maintenance. Result caches evict least-recently-used entries only to
meet count and byte limits. Never discard saved originals or pending recovery
during routine cleanup.

Teach through first_mod: title, real Abrams health, multiple units, bulk edits,
settings, calculations, and feature-owned assets without programming. Keep generator
and coding lessons optional in docs/advanced; later beginner lessons must not depend
on them. Use a separate
dependent project only for the layering lesson. Give complete edits, exact paths,
expected results, and reset instructions. Invent inputs only for isolated tests.

Source AGENTS.md holds agent rules. resources/release/structure/AGENTS.md describes installed mod authoring. README introduces the product and links to docs/README.md, which indexes every lesson and guide. Do not duplicate that index. Verify examples against the actual CLI, schema, SDK, archive layout, and game data.

Run formatting, Clippy, locked tests, packaging, and extraction verification when their scope changes. Test the extracted executable with Cargo and runtimes absent from PATH, real batch exit codes, Unicode paths, checksums, preserved configuration, and precompiled generators. Do not publish artifacts without the user's request.
