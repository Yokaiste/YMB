# Patch materialization cost profile and scan-cache retention

Last verified: 2026-08-04
Relevant paths: `src/patch/ndf/buffer.ts`, `src/patch/ndf/scan.ts`, `src/scripts/runtime-exchange.ts`

## Finding

Measured on a 31-target source mod over real WARNO game data (58 MB
`GameData/Generated/Gameplay/Decks/DivisionRules.ndf`, 27 MB
`GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf`).

### Never hand a whole file to something that reads all of it

Three separate costs turned out to be the same mistake, and each was the largest
item in its profile when it was found:

- **A cache keyed by file text.** The scan index used to be a `Map` keyed by the
  text it had scanned; a map hashes its key, and hashing a key reads all 58 MB.
  A list compared with `===` answers the same question. **5.7s of a 14s build.**
- **A string rebuilt per operation.** Every operation used to take the whole file
  and return a new whole file, so `Name = 1` in a 27 MB file produced 27 MB of
  new string to say so. One real target runs 231 operations. `NdfTextBuffer`
  splices into the pieces the file is currently made of and joins once:
  **5119ms and 1642 MB became 128ms and 308 MB** for that target.
- **A payload handed to IPC.** Every worker exchanged whole game files with its
  parent, which copied them on both sides. `runtime-exchange.ts` parks anything
  past 256 KB in a directory both processes read.

The pattern to watch for: any whole-file string reaching a hash, a serializer, or
a per-operation rebuild.

### A retained scan-cache generation costs a full copy of the file

The index used to keep the pre-edit text as well. Because every complete-block
edit produces a new whole-file string, one multi-operation patch filled the whole
8-entry cap with generations of the same file: peak retention was **216M
characters** (~433 MB of UTF-16). `NdfTextBuffer.text()` forgets the text it was
built from for the same reason, and `tests/ndf-scan-cache.test.ts` and
`tests/ndf-buffer.test.ts` both pin it.

### The cost centre is the script phase, not patch materialization

Cold build: patch phase **3.6s**, generation scripts **42s**. Warm: patch phase
under a second. Worker parallelism cannot help either - one script dominates, and
the scripts are deliberately coupled: the core script coordinates the second
generator and declares its blocks through `generatedBlockOwnerPaths`, so
selecting the core patch alone fails with "Script output delegates generated
blocks to unknown or foreign scripts". The remaining lever is inside the
generator, not in the builder's scheduler.

## Why it matters

Two obvious "cleanups" are wrong: keying a scan cache by its text, and widening
worker parallelism to cached builds. And the whole-file habit reappears easily -
every one of the three costs above read like ordinary code.

## How to verify

`bun run ymb build --mod <id>` and read the `timing:` line, then re-run with
`--no-cache`. For profiles, `bun --cpu-prof --cpu-prof-md ./index.ts build --mod
<id>`.

**Ignore any frame reported with one or two samples.** Those are subprocess waits
attributed to whatever was on the stack, and they read as the hottest thing in
the profile. `formatHeartbeatDuration` at 20% is a timer, not a cost.

**Measure A and B back to back.** This machine drifts by a factor of two across a
session under repeated builds, so a number taken twenty minutes earlier is not a
baseline - an interleaved run is. A regression that appeared as 18s vs 42s in the
script phase turned out to be the same 42s on both sides.
