# Large script caches and deck-analysis profiling (2026-07-23)

- Script cache entries can contain tens of MiB of JSON even when generated outputs are much smaller. Cache entries are disposable; persistent deck and serializer stores are not.
- Cache schema changes must invalidate old entries instead of migrating them. Validate the uncompressed content hash, use atomic writes, and enforce both entry-count and byte limits per script namespace.
- For YSM performance work, compare hashes for every generated output and persistent store after each optimization. A successful preview alone does not prove semantic equivalence.
- Uncached profiling showed premade selection and trimming dominate generation time. Cache only immutable entity-level facts, then create fresh mutable category analyses; never share role tokens, metrics, relative metrics, or similarity vectors between categories.
- More worker processes are not automatically faster. Benchmark the worker ceiling on comparable uncached runs and remove changes that regress wall time.
