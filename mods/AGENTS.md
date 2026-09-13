# Source-Mod Agent Guide

The root `AGENTS.md` applies. Each child mod is its own repository.

Use the [development principles](../docs/development.md) to decide ownership and
configuration scope. Apply the pattern across the mod, not only to the example named
in a request. Each checkout's own `AGENTS.md` records its feature boundaries.

- Keep each mod's documentation in one concise README: a visual showcase, player
  features, and a short source workflow. Link to YMB's guides for detailed builder usage.
- Preserve feature brands, including **YSM × ANY MOD**. Keep showcase language simple
  and appealing; use one brief compatibility note where needed, without turning a
  brand into a technical guarantee or qualifying every feature description.
- Read the mod README and `config/ymb.mod.yaml`. Author feature changes under `config/`.
- Use declarative patches and the public `ymb/api` tools before writing a generator.
  Never import builder `src/` modules or duplicate its NDF parser inside a mod.
- Keep feature tuning, descriptions, validators, and tests with their feature. The mod
  config owns identity and values that genuinely coordinate independent features;
  it is not an inventory of every variable. Keep necessary derived expressions with
  their consumer and local choices in the builder's `ymb.config.yaml`.
- Use the existing scope and merge rules; a parent folder does not make variables
  available to child patches. Do not replace root-variable clutter with sibling YAML
  parsing or a new feature-config loader. Preserve nested settings when overriding.
- `shared/` needs independent production consumers with the same contract. Multiple
  files or tests inside one feature do not make that feature shared infrastructure.
- Player descriptions should capture the feature's identity and experience. Do not
  append roster inventories, slot counts, generation rules, or availability formulas
  simply because the generator has them. Explain gameplay differences needed to choose
  between division types in their descriptions; put unit details in unit UI or guides.
- Validation belongs to the rule's owner. A zombie rule belongs under zombies; a
  common checker accepts explicit inputs and knows no mod-specific name prefixes.
  Fix malformed authoring and retain a focused regression check. Preserve general
  builder validation and recovery guarantees.
- Preserve stable mod/patch ids, generated-block owners, GUIDs, serializer ids and
  localisation tokens. Names and balance values may change without renumbering identity.
- Test scripts with invented data. Validate real output in the generator when an
  invariant must hold for every build; do not make a test pin the current mod content.
- Each mod owns its legal files. Do not copy or synchronize licenses.

The installer body below `:deploy_repositories` is shared across current mods. The
workflow body is shared apart from `env` and concurrency configuration. Apply shared
fixes to all current copies and compare them. Installers must preserve local builder
configuration during updates.

Run the root guide's mod checks, update the README for changed capabilities or source
workflow, and inspect its Git diff separately.
