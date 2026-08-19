# The big descriptor patches look repetitive but do not collapse into `forEach`

Last verified: 2026-07-27
Relevant paths: `src/patch/for-each.ts`, `mods/<mod>/config/patch/**/descriptors/**/ymb.patch.yaml`

## Finding

`forEach` repeats a fixed body once per list entry. The large descriptor patches are shaped
alike but are not identical per entity, so a fixed body cannot express them.

Measured on a real zombie roster:

- **Ammunition**, 10 profiles across 243 operations. Only 10 fields are set on all ten
  profiles. The rest appear on 9, 6, 5, 4, or 3 of them.
- **Units**, 7 entities across 288 operations, 37 to 44 each. The module sets differ by
  entity: one carries `TCapaciteModuleDescriptor`, another `TFormationModuleDescriptor`,
  and each references a different vanilla weapon descriptor.

Collapsing either would mean a loop over the common subset plus a long residue of
per-entity exceptions. That is about the same number of lines, arranged so no single
profile can be read top to bottom, and it splits one entity's definition across two places.

A restructure also cannot be proven equivalent by diffing preview bytes: marker payloads
are seeded with the operation index (`createMarkerPayload` in `src/patch/ndf/shared.ts`),
so renumbering operations changes every marker id even when the NDF is identical.

## Why it matters

The volume invites the assumption that this is mechanical repetition. It is not, and the
cheap check - which fields appear on every entity versus only some - settles it in a
minute. `forEach` remains the right tool where a list genuinely repeats, such as
copy-and-rename fan-outs over role names.

## How to verify

Count field usage across the entities in one patch:

```sh
grep -o '<Prefix>_[A-Za-z_]*\.[A-Za-z]*' <patch>.yaml | sed 's/.*\.//' | sort | uniq -c | sort -rn
```

A collapsible patch shows one count repeated for every field. These show a long tail.
