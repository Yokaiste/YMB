# TODO

## Known limitations

### Full-file merge of markerless generated targets by multiple scripts

`materializeScriptOutputs` now replaces (instead of full-file merging) when a generation script
rewrites a target that a lower layer supplies as a plain, **markerless** file — but only for the
**first** script to own that target (sole contributor is still the `existing:<path>` base). This
avoids the O(D²) Myers trace / protected-merge-budget blow-up on large generated files
(e.g. `Divisions.ndf`, `DeckSerializer.ndf`).

It does **not** help when **two or more scripts** write the same target without generated-block
markers: the second contributor still falls through to `tryMergeTextContributionsCooperative`
(whole-file line diff), which is O(D²) in memory and is rejected by the merge budget on large files.

That case is intentionally left on the merge path — replacing would drop the earlier contributor.
The proper fixes for multi-owner markerless targets are either:

- have the generating scripts emit **generated-block markers** so the marker-based block merge
  (`tryMergeGeneratedBlocks`, O(n)) reconciles them, or
- give the full-file line diff a **linear-space** implementation (Myers middle-snake /
  Hirschberg) so even a genuine whole-file merge stays within bounded memory.
