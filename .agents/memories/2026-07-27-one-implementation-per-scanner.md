# The diff and the NDF field scan are each written once, on purpose

Last verified: 2026-07-27
Relevant paths: `src/text-merge.ts`, `src/patch/ndf/scan.ts`, `src/patch/ndf/core.ts`

## Finding

Both hot paths used to exist twice - once blocking, once `async` - and the copies had to stay
byte-for-byte equivalent by hand. They are now single implementations with two drivers:

- `src/text-merge.ts`: the linear-space LCS diff is a generator (`DiffSteps`) that `yield`s at
  fixed work intervals. `drainDiffSteps` spins it for the blocking caller
  (`tools.text.describeChanges`); `drainDiffStepsCooperative` awaits `maybeYield()` at every pause
  for `build`/`sync`. That removed ~450 duplicated lines.
- `src/patch/ndf/scan.ts`: `scanFieldMatches` is the only walk that looks for `Name = value`
  pairs. `findFieldRange`, `readFieldValues`, and `findAllNestedFieldRanges` differ only in their
  `onMatch` callback, the depth mode, and whether a matched value is skipped. That removed three
  copies of the same comment/string/depth state machine.

A third pair got the same treatment: `updateNestedField` and `updateNestedCollectionField` in
`src/patch/ndf/core.ts` were the same recursive walk down a resolved NDF path with different
leaves. They are now `updateAlongNdfPath` plus two `NdfPathLeaf` values
(`createFieldUpdateLeaf`, `createCollectionInsertLeaf`).

Measured against the pre-refactor code on the 27 MB `UniteDescriptor.ndf`, output identical:
field scans equal or ~15% faster, `describeTextChangesCooperative` within noise (+1%), the
blocking `describeTextChanges` ~6% slower from generator resumes.

## Why it matters

Re-splitting either one to "avoid generator overhead" trades a measured 1-6% on one path for a
guaranteed correctness hazard: two diff implementations that must agree, in code whose output is
written into live game files. `tests/text-merge.test.ts` still asserts the two drivers agree, so
a split would pass its own tests while the copies drifted elsewhere.

`skipMatchedValue` is the subtle parameter. A field value is balanced, so jumping over it keeps
the depth count correct - but deep multi-name reads must _not_ skip, because a caller can ask for
both an outer field and one nested inside its value.

## How to verify

`bun run ymb validate --mod <id> --no-cache` exercises both scanners over real game data; the
suite in `tests/ndf.test.ts`, `tests/ndf-reader.test.ts`, and `tests/text-merge.test.ts` pins the
behaviour.
