# Development principles

[← Docs](README.md)

**Put each decision with its owner. Make other parts know as little about it as possible.**

YMB preserves authored mod changes through game updates. YSM and WTO provide distinct
playing experiences. Improvements should reduce how many places a developer must
understand or change to support those purposes. These principles guide judgment;
they do not require an architecture framework or an architectural lint system.

## Find the responsibility

Organize around decisions that change together. A feature owns its rules, content,
assets, validation and tests. Composition connects features. Common code supplies
an operation with the same meaning for its actual consumers.

| Owner            | Responsibility                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| YMB              | Config syntax, selection, NDF operations, composition, script execution, output ownership and recovery |
| Mod              | Identity, feature relationships and settings independent features must agree on                        |
| Feature          | Its behavior, balance, presentation and correctness                                                    |
| Shared mechanism | A demonstrated common operation with explicit inputs                                                   |

Mods use `ymb/api`; the builder does not know mod policy. The deck generator renders
Horde content supplied by zombies. A common entity checker receives the owning
feature's selection instead of recognizing a growing list of production prefixes.
Several files inside one feature do not make that feature shared infrastructure.

This follows Parnas's criterion of hiding design decisions likely to change, rather
than dividing software solely into processing steps. Moving folders helps navigation;
it does not by itself fix hidden dependencies. [Original paper](https://ckrybus.com/static/papers/decomposing_systems_into_modules_1972.pdf)

## Make configuration intentional

A setting promises a supported choice. Identify who changes it, what outcome changes,
and why a fixed default is insufficient before exposing it.

| Value                                  | Treatment                                                             |
| -------------------------------------- | --------------------------------------------------------------------- |
| Supported choice                       | Document it at the smallest scope serving its consumers               |
| Feature content or balance             | Author it with the feature; do not promote every field as a user knob |
| Agreement between features             | Keep one canonical value with their common owner                      |
| Derived value                          | Calculate it at the consuming boundary                                |
| File path, NDF literal or format limit | Keep it with the adapter or operation                                 |
| Persistent identity                    | Preserve it deliberately                                              |
| No consumer or purpose                 | Remove it after tracing supported callers                             |

For example, deck capacity coordinates the generator and deck UI. A quoted `modTag`
is only a representation of the same identity. Neither an arbitrary literal nor a
large YAML file proves that a setting is wrong; misplaced or duplicated decisions do.

Feature defaults live in patch configs. Local choices use builder overrides. Respect
the existing [scope and merge rules](configuration.md#customizing-installed-mods):
folders do not inherit variables, objects merge and lists replace. Do not introduce
sibling-YAML readers or another config loader to simulate missing scope.

Avoid speculative flexibility and global coupling. [YAGNI](https://martinfowler.com/bliki/Yagni.html),
[Abseil on flags](https://abseil.io/tips/45)

## Share meaning, not resemblance

The same number can represent independent decisions; different expressions can encode
one shared rule. Reuse a semantic contract, not private expression spelling or file
layout. A useful abstraction reduces what callers need to know.

Prefer deletion, existing helpers, the standard library and native capabilities.
Keep code local until its shared meaning is clear. Do not add registries, factories,
forwarding layers or new schemas just to make a cleanup look architectural. Do not
flatten a complex algorithm into an unreadable function to reduce file count.
[AHA programming](https://kentcdodds.com/blog/aha-programming)

## Validate where correctness is established

YMB checks general syntax, operation contracts, conflicts and recovery. Features check
their own meaningful inputs and results. Zombie tuning belongs to zombies, and an
unrelated selection should not require a disabled feature's runtime assumptions.

Fix defective authoring at its source. Retain a focused regression check and a valid
neighboring case. A shared invariant accepts explicit inputs; an incident is not a
reason to install a permanent whole-project scanner. Do not assume every repeated
WARNO module is invalid everywhere because one clone was wrong.

Tests assert observable behavior with invented data: correct output, useful rejection,
preserved identities and unrelated content, and supported disabled or layered selections.
Avoid production-name inventories, implementation-text checks and snapshots of incidental prose.

## Write for the current audience

Division descriptions convey identity, theme, playing experience and the gameplay
differences needed to choose between division types. Generic does not mean interchangeable.
Unit cards explain
useful mechanics. Customization docs explain choices. Diagnostics locate failures.
Contributor docs explain ownership and contracts. A technically accurate fact can
still be irrelevant on a particular surface.

Generators render authored content; they do not append rosters, slots or availability
formulas merely because those values are available. Preserve each mod's character and
brands. Put useful detail where it supports a real decision.
[Microsoft writing guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style),
[Diátaxis](https://diataxis.fr/)

## Give data the right lifetime

Authored intent, persistent identity, preview output, caches and recovery data have
different lifetimes. Return generated text through the script output API. Keep any
deliberate identity-store write separate. Do not classify saved IDs as temporary data
or renumber them when a feature is disabled.

Preserve generated-block owners, GUIDs, serializer IDs and localisation tokens during
refactors. Respect observed-read composition and replacement ownership. Use existing
dependency hashes for cache invalidation instead of duplicating that decision with
manual version bumps. Keep necessary performance bounds and recovery safeguards.

## Finish the migration

Trace the behavior, its owner, callers, supported settings and output before editing.
Treat user examples as evidence of a pattern and inspect sibling cases. Complete each
change across defaults, consumers, tests and current documentation. Explain migrations
for removed settings; do not leave two representations indefinitely or silently
discard a supported choice. Do not change balance just to shorten configuration.

Check affected features, meaningful disabled selections and intended mod combinations.
Remove completed audits, obsolete instructions and unused scaffolding. Keep durable
rationale and necessary contracts. Success means less unrelated knowledge is needed
to change a feature, with its intended behavior and identity preserved.
