# YMB Docs

> The navigation hub for YMB documentation.

If you are browsing the `docs` folder directly on GitHub, start here instead of jumping between files at random.

## 🧭 Choose a Path

### I am new to YMB

- [Getting Started](getting-started.md) for the fastest safe first run
- [Step 1: Setup](step-1-setup.md) for Bun, folder layout, and `doctor`
- [Step 2: First Source Mod](step-2-first-mod.md) for `init`, scaffold structure, and first edits
- [Step 3: Test, Sync, and Recover](step-3-review-and-publish.md) for the safe sync and recover loop

### I already know the basics

- [Workflow Guide](workflow.md) for the day-to-day command rhythm
- [Configuration Reference](configuration.md) for `ymb.mod.yaml`, `ymb.patch.yaml`, scripts, replace files, and selection rules
- [Template Expressions Reference](template-expressions.md) for `${...}` syntax, helpers, and expression rules
- [NDF Operations Reference](ndf-operations.md) for selectors, operations, and patch structure
- [Advanced Guide](advanced.md) for layering, recovery details, ownership, and debugging

## 🚀 Recommended Reading Order

**For a quick start:**

1. [Getting Started](getting-started.md)

**For a guided walkthrough:**

1. [Step 1: Setup](step-1-setup.md)
2. [Step 2: First Source Mod](step-2-first-mod.md)
3. [Step 3: Test, Sync, and Recover](step-3-review-and-publish.md)

**After the basics:** 4. [Workflow Guide](workflow.md) 5. [Configuration Reference](configuration.md) 6. [Template Expressions Reference](template-expressions.md) 7. [NDF Operations Reference](ndf-operations.md) 8. [Advanced Guide](advanced.md)

## 📌 Fast Mental Model

> YMB works best when you think in four places:
>
> - `YMB/mods` for source mods that survive game updates
> - `YMB/.ymb-build/output` for reviewing the generated result
> - live `GameData` and `CommonData` for the actual game files
> - `YMB/.ymb-state` for recovery and rollback

And in one normal loop:

```text
doctor -> validate -> build -> check output -> sync --yes -> recover --yes when needed
```
