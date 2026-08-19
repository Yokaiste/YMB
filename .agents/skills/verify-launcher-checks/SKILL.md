---
name: verify-launcher-checks
description: Prove that a check covering release/*.cmd or YMB.bat actually fails when the thing it guards is broken, before trusting a green verify:release.
---

# Prove a launcher check can fail

`release/YMB.bat`, `release/resolve-bun.cmd`, and `release/shell-init.cmd` are the only
executable parts of YMB the builder test suite cannot reach - `bun test` cannot run a `.cmd`.
Their behaviour is asserted from `scripts/verify-release.ts` instead, and a check written there
can pass for the wrong reason on a developer machine. This is how to find out before shipping.

## Inputs

- A built release: `bun run build` (writes `dist/YMB` and `dist/no-bun/YMB`).
- The check under test already added to `scripts/verify-release.ts`.
- Windows. The launcher checks are skipped elsewhere.

## Procedure

1. Confirm the check passes as-is: `bun run verify:release`.
2. Back up the shipped copy of the launcher file the check guards, from `dist/`, not `release/`:
   `cp dist/no-bun/YMB/app/resolve-bun.cmd /tmp/rb.bak`
3. Break exactly the behaviour the check claims to cover, by line number - to remove a decision,
   `sed '6d' /tmp/rb.bak > dist/no-bun/YMB/app/resolve-bun.cmd`; to neuter a refusal,
   `awk '/^exit \/b 1/{print "exit /b 0\r"; next} {print}' /tmp/rb.bak > ...`.
4. Print the changed region and read it. Confirm the file really changed before drawing any
   conclusion from the next step.
5. Run the verifier against that one release root, not the whole suite:
   `bun run ./scripts/verify-release.ts dist/no-bun/YMB --system-bun`
   (drop `--system-bun` for `dist/YMB`).
6. Restore from the backup and re-run to confirm green again.

## Validation

The mutated run must fail **in the check under test**. Read the stack frame: a failure in an
earlier assertion means the mutation was too coarse and the new check is still unproven.

## Pitfalls

- **A `grep -v` pattern that never matches leaves the file untouched**, and the run then passes
  for no reason at all. Prefer `sed '<line>d'`, and always print the result before running.
- **Mutating `release/` instead of `dist/`** tests nothing until you rebuild; the verifier only
  ever reads `dist/`.
- **Gutting a whole file** breaks the earlier launcher-help assertion first and masks the check
  you meant to exercise. Change one decision.
- **The developer machine has Bun installed**, so any check that merely reads `PATH` passes
  regardless. `verifyBunResolution` builds its own `PATH` for exactly this reason - keep that
  property in anything new.
- `.cmd` files are CRLF. Keep `\r` when rewriting lines, or `cmd.exe` misparses labels.
- Rebuild (`bun run build`) after finishing, so `dist/` matches source again.
