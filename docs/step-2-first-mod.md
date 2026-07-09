# Step 2: Create Your First Source Mod

This step turns an empty `YMB/mods` folder into a real source mod you can validate, test, and sync.

> [!NOTE]
> This page assumes YMB is already installed and `bun run ymb doctor` is pointing at the correct WARNO mod root. If not, go back to [Step 1: Setup](step-1-setup.md).

## Goal

By the end of this page, you should have:

- one source mod created by `init`
- a basic understanding of the scaffold
- a clear idea of which files you are supposed to edit first

## 1. Create the Scaffold

Run:

```bash
bun run ymb init --id my_pack --name "My Pack" --description "My first YMB source mod"
```

If you omit values in an interactive terminal, YMB prompts for the missing ones.

The new source mod appears here:

```text
YMB/mods/my_pack/
```

## 2. Understand What `init` Created

The scaffold is intentionally small, but it shows the three main ways YMB produces output.

| File or folder                       | Why it exists                        |
| ------------------------------------ | ------------------------------------ |
| `config/ymb.mod.yaml`                | Defines the source mod itself        |
| `config/patch/.../ymb.patch.yaml`    | Shows a focused NDF patch            |
| `config/replace/...`                 | Shows whole-file replacement         |
| `config/generate-build-info.ts`      | Shows generated output               |
| `config/generate-build-info.test.ts` | Shows how script tests work          |
| `README.md`                          | Gives local notes for the source mod |

## 3. Learn the Core Editing Areas

Most real work happens under:

```text
YMB/mods/my_pack/config/
```

Start with these ideas:

- edit `ymb.mod.yaml` when you want to change metadata, variables, or shared scripts
- add files under `patch/` when you want small targeted NDF changes
- add files under `replace/` when you intentionally own the full output file
- use `.ts` generation scripts when the output is assembled or derived
- keep `.test.ts` files near scripts that need protection from regressions

## 4. Run the Safe First Commands

After `init`, run:

```bash
bun run ymb validate --mod my_pack
bun run ymb build --mod my_pack
```

`validate` makes sure the scaffold is sound and targets exist.

`build` tests your logic and writes generated output without touching the live WARNO mod files.

## 5. Inspect the Output

Open:

```text
YMB/.ymb-build/output/
```

That output folder is one of the best teaching tools in YMB. It shows what your patch, replace file, and generated script actually produce together before applying them over the game files.

## 6. Decide What To Keep

The starter scaffold is a learning aid, not a permanent design.

Common next actions:

- rename the source mod to fit your project
- keep the sample patch and adapt it
- remove starter files you do not need
- add your own patches in small, focused pieces

## Next Step

Continue with [Step 3: Test, Sync, and Recover](step-3-review-and-publish.md).
