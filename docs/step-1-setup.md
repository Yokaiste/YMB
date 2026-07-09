# Step 1: Setup and Trust the Builder

This page focuses on one thing: making sure YMB is installed correctly before you trust it with live WARNO files.

## 🎯 Goal

By the end of this step, you should know:

- where `YMB` belongs
- where to get Bun
- how to install YMB dependencies
- how to confirm the builder context before you create source mods

## 1. Install Bun First

> [!IMPORTANT]
> YMB requires **Bun**. Get it from [bun.com](https://bun.com/).

After Bun is installed and available in your terminal, continue with the rest of the setup.

## 2. Put `YMB` in the Correct Folder

YMB is not meant to live anywhere on disk. It expects this layout:

```text
<ModRoot>/
  CommonData/
  GameData/
  YMB/
    mods/
```

If `YMB` is outside that structure, it will not be targeting the correct live WARNO files.

## 3. Install Builder Dependencies

From the `YMB` directory:

```bash
bun install
```

`bun install` installs YMB's project dependencies. It does not install Bun itself.

## 4. Run the Builder Health Check

Run:

```bash
bun run ymb doctor
```

Confirm the reported paths make sense:

| Path          | Should point to                  |
| ------------- | -------------------------------- |
| Builder root  | Your `YMB` folder                |
| Live mod root | The WARNO mod folder above `YMB` |
| Output root   | `YMB/.ymb-build/output`          |
| Recovery root | `YMB/.ymb-state`                 |

> [!TIP]
> If those paths are wrong, fix the folder layout before you continue. Everything after this depends on `doctor` being correct.

## Next Step

Continue with [Step 2: Create Your First Source Mod](step-2-first-mod.md).
