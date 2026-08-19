# Collection separator validation is grammar-sensitive; re-sweep real NDF when touching it

Last verified: 2026-07-28
Relevant paths: `src/patch/ndf/validate.ts`, `src/patch/ndf/scan.ts`, `src/patch/ndf/core.ts`,
`src/patch/ndf/bulk.ts`

## Finding

`findCollectionEntries` reports two different ends for an entry, and using the wrong one silently
fuses entries:

- `entry.end` stops **before** the entry's own comma;
- `entry.separatorEnd` clears it, and collapses onto the collection's inner end for a last entry
  that has no comma at all.

Anything appending after an entry must use `separatorEnd`, and must supply the comma itself when
`separatorEnd === separatorStart`.

`validateNdf` now catches a violation, but only because it models enough of the grammar to know
where a bare scalar entry ends. A bare entry (`~/Module_B`, `Ammo_X`, a number) closes no
delimiter, so its end is observable only at the following whitespace — and that rule is wrong for
most of vanilla NDF unless three exceptions are encoded:

1. **Chaining keywords.** `private parInitialSize is Template_Param_Float( … )` is _one_ entry of
   four whitespace-separated tokens. `NDF_ENTRY_CHAINING_WORDS` lists them.
2. **Operator tokens.** After `-` or `div`, the operand belongs to the same entry, so an operator
   token must not arm the check.
3. **Operator suffixes.** A template parameter writes `HasMaxVision: bool = True` with the colon
   glued to the name, so a token still _ending_ in an operator character is mid-expression.

Measured on the 4517 `.ndf` files under `GameData/` and `CommonData/`: the naive
whitespace-ends-an-entry rule produced **1509** false positives, adding (1) cut it to **22**, and
adding (3) reached **0**.

## Why it matters

A false positive here fails every build over vanilla game data, and the rule looks correct on
small fixtures — all three exceptions only appear in real files. Never tune this against unit
tests alone.

## How to verify

`tests/ndf-errors.test.ts` pins both directions (fused bare entries and strings must throw;
multi-token declarations, typed template parameters, and a type-then-block entry must not). Before
trusting a change, also run `validateNdf` across every `.ndf` under the parent `GameData/` and
`CommonData/` and require zero failures.

See also [two block lookup paths must agree](2026-07-28-two-block-lookup-paths-must-agree.md).
