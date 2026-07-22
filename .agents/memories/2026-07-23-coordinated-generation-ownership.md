# Coordinated script generation and ownership (2026-07-23)

YSM core and horde generation originally read and parsed the same large WARNO targets in separate
script subprocesses. Coordinating both from the core script and sharing one immutable source
analysis materially reduces uncached build time.

The subtle hazard is output metadata: YMB markers include every contributing script. Returning the
same bytes from only the coordinator changes marker hashes even when the generated NDF is otherwise
identical. A coordinator must set `generatedBlockOwnerPaths` to the selected same-mod scripts whose
blocks it produced. YMB validates this delegation; do not accept arbitrary or cross-mod owners.

Persistent deck stores and final localization are stateful across both generators. Process entries
in the established core-then-horde order, carry the updated store and localization into the next
entry, write only the final state, and compare both output and store hashes against a clean baseline.
