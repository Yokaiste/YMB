# Getting Started

This is the fastest safe path from zero to a working YMB workflow.

## 🚨 First Requirement

> [!IMPORTANT]
> YMB requires **Bun**. Install it first from [bun.com](https://bun.com/).

If Bun is missing, stop here and install it before doing anything else.

## 🧭 What You Are Setting Up

YMB is an advanced source-mod builder for WARNO. Its main purpose is to save you from the painful process of running native game scripts to merge updates, which often creates massive conflicts and broken code. The normal flow is:

1. author resilient source files and scripts under `YMB/mods`
2. declare explicit dependencies between your modular feature packs
3. validate them to catch conflicts early
4. build to test and generate the logic
5. sync to merge your changes into the game

This workflow lets you safely experiment, combine multiple mods without collisions, and build complex projects that survive game updates cleanly. Because YMB uses strict validation and explicit YAML targets, it is entirely **AI-ready**—you can delegate feature creation to an AI coding agent and trust the builder to catch any hallucinations before they reach the game.

## ✅ Before You Begin

> [!WARNING]
> Building a source mod runs its generation scripts as regular code on your machine, with your user's full permissions. Only build source mods you trust; review the `scripts` entries of downloaded mods first.

Make sure all three are true:

- Bun is installed and available in your terminal
- your `YMB` folder lives inside a WARNO mod root
- you can open a terminal in the `YMB` directory

Expected layout:

```text
<ModRoot>/
  CommonData/
  GameData/
  YMB/
    mods/
```

## 🚀 First-Time Setup

From the `YMB` folder:

```bash
bun install
bun run ymb doctor
```

What `doctor` should confirm:

- the builder root is your `YMB` folder
- the live mod root is the folder above it
- the output root is `YMB/.ymb-build/output`
- the recovery root is `YMB/.ymb-state`

> [!TIP]
> If any of those paths look wrong, fix the folder layout before you continue. Do not trust later commands until `doctor` looks correct.

## 🛠 Create Your First Source Mod

Run:

```bash
bun run ymb init --id my_pack --name "My Pack" --description "My first YMB source mod"
```

That creates a small working source mod under `YMB/mods/my_pack`.

The starter scaffold includes:

- a `ymb.mod.yaml` source-mod config
- a sample patch
- a sample replace file
- a sample generation script
- a sample script test
- a local README for the new source mod

## 👀 Validate, Build, Check

Use this exact sequence:

```bash
bun run ymb validate --mod my_pack
bun run ymb build --mod my_pack
```

Then inspect the generated output here:

```text
YMB/.ymb-build/output/
```

> [!NOTE]
> The most important beginner habit in YMB is simple: test your generation logic using `build` before you `sync` to the live game.

## 📦 Sync Only After Review

If the output looks correct:

```bash
bun run ymb sync --mod my_pack --yes
```

If you later want to restore tracked originals:

```bash
bun run ymb recover --mod my_pack --yes
```

## 📚 Read Next

- Want a slower setup walkthrough: [Step 1: Setup](step-1-setup.md)
- Want the scaffold explained: [Step 2: First Source Mod](step-2-first-mod.md)
- Want test/sync/recover flow: [Step 3: Test, Sync, and Recover](step-3-review-and-publish.md)
- Want the command model: [Workflow Guide](workflow.md)
- Want the config reference: [Configuration Reference](configuration.md)

## ✅ Beginner Checklist

- Bun is installed from [bun.com](https://bun.com/)
- `bun install` completed successfully
- `bun run ymb doctor` points at the correct WARNO mod root
- your source files live under `YMB/mods/<your-mod>`
- `validate` is clean
- `build` output looks correct
- only then do you run `sync --yes`
