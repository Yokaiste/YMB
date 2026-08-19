# `forEach` must expand before the generic template pass

Last verified: 2026-08-03
Relevant paths: `src/patch/for-each.ts`, `src/engine/shared.ts`, `src/config/schemas.ts`

## Finding

`resolveVariablesInTarget` used to resolve a whole target with one
`resolveTemplateValue` call. That cannot work once `forEach` exists: the loop variable is
not in the surrounding scope, so resolving first reaches every `${role}` with no binding
for it.

Until 2026-08-03 that was silent: `resolveVariableReference` returned `''` for an unknown
name, so the wrong order shipped wrong NDF with a green build. `resolveVariable` now
refuses an unknown name in every spelling, so the same mistake fails loudly instead. The
ordering requirement is unchanged - only the way it announces itself is.

So expansion resolves only the `forEach` list, then resolves each repeated operation
against `{...variables, [as]: item, [`${as}Index`]: index}`. Member access works on the
binding, so a list of objects (`${ammo.id}`) collapses non-uniform repetition too.

`authoredOperationSchema` dispatches on the presence of a `forEach` key instead of using
`z.union([forEachSchema, operationSchema])`. `operationSchema` is an
`z.unknown().transform()` that matches any shape and reports through `context.addIssue`,
so inside a union every operation error became an `invalid_union` with both branches
flattened, and 28 tests pinning precise issue paths failed.

## Why it matters

The union bug is the silent one: it degrades every operation error message in the project,
not just loop ones. The resolution-order bug is now caught by the unknown-name check, but
the ordering still has to be right - a build that refuses every loop variable is not a
working alternative to one that never resolves them out of scope.

## How to verify

`bun test tests/for-each.test.ts tests/config-schema.test.ts`. For the union hazard,
swap the dispatch for a `z.union` and re-run `tests/config-schema.test.ts` - the
"rejects unsupported ... on bulk operations" cases fail.
