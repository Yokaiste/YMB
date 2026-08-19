# Getting Started

**No programming needed.** By the end of this page you will have changed something in
WARNO, seen the result, installed it, and undone it again.

> Everything here is reversible. Nothing reaches your game until you type `--yes`.

---

## 1. Install YMB

First you need a WARNO mod folder. In WARNO's install folder, open `Mods` and run:

```text
CreateNewMod.bat YourModName
```

That creates a folder containing `GameData` and `CommonData`. Now:

1. Download the [latest YMB release](https://github.com/Yokaiste/YMB/releases/latest).
2. Extract the `YMB` folder **inside** your new mod folder.
3. Double-click `YMB/YMB.bat`.

You should end up with:

```text
<WARNO>/Mods/YourModName/
├── CommonData/
├── GameData/
└── YMB/
    ├── YMB.bat
    └── mods/
```

Now type:

```text
doctor
```

Read the folders it prints. **They must point at the mod you intend to change.**
If they do not, you extracted YMB in the wrong place.

---

## 2. Create a starter mod

```text
init --id my_pack --name "My Pack"
```

Use a short id with no spaces. YMB writes a small **working** example:

```text
YMB/mods/my_pack/
└── config/
    ├── ymb.mod.yaml                 ← your mod's settings
    ├── generate-build-info.ts       ← an example script
    ├── generate-build-info.test.ts  ← its test
    ├── patch/
    │   └── ui/branding/welcome-view/
    │       └── ymb.patch.yaml       ← an example change
    └── replace/                     ← whole files you provide
        └── GameData/Localisation/${modRootName}/
            └── INTERFACE_OUTGAME.csv  ← an example replaced file
```

You can build this right now, before editing anything.

---

## 3. Build it

```text
validate --mod my_pack
build --mod my_pack
```

- **`validate`** checks for mistakes and writes nothing.
- **`build`** writes the finished files to `YMB/.ymb-build/output`.

Open that folder and look at what it produced. This is exactly what would be installed.

---

## 4. Make your first change

Open this file in any text editor:

```text
YMB/mods/my_pack/config/patch/ui/branding/welcome-view/ymb.patch.yaml
```

You will see something like:

```yaml
version: 1
id: ui.branding.welcome_view
name: Welcome View Demo
enabled: true
scope: prod
targets:
  - file: GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf
    operations:
      - op: add
        # ...
```

### Reading YAML

YAML is just indented text. Three rules cover almost everything:

| Rule                       | Example                            |
| -------------------------- | ---------------------------------- |
| `name: value` sets a value | `enabled: true`                    |
| Indentation means "inside" | `targets:` then indented `- file:` |
| `-` starts a list item     | `- op: add`                        |

**Use spaces, never tabs.** A tab is the single most common YAML mistake.

### Try it

Change `name:` to something else, save, then:

```text
build --mod my_pack
```

Look at the preview again. Your change is there.

> **Only edit files under `YMB/mods/`.** Everything in `.ymb-build` is regenerated on
> every build, so edits there are thrown away.

---

## 5. Install it

Once the preview looks right:

```text
sync --mod my_pack --yes
```

Your mod is now live. Start WARNO and try it.

---

## 6. Undo it

```text
recover --mod my_pack --yes
```

Every original file goes back exactly as it was.

> **Do not delete `YMB/.ymb-state`.** That folder is what makes undo possible.

---

## When something breaks

YMB errors always have the same shape, and the **`Fix`** line tells you what to do:

```text
[x] Problem in a config file

  Patch id `armor` is used more than once inside source mod `my_pack`.

  Fix    Give each patch a unique permanent `id` in `ymb.patch.yaml`.
  File   YMB/mods/my_pack/config/patch/armor/ymb.patch.yaml
  Mod    my_pack (My Pack)
```

Read it as: **what went wrong** → **how to fix it** → **where it is**.

When a run hits several independent problems — three targets naming files that moved, two
patch configs with the same typo — it reports all of them in one go, numbered, each with
its own block:

```text
[x] 2 problems found

  1 of 2  File is missing or unreadable

    Target file `GameData/Generated/Gameplay/Decks.ndf` does not exist.

    Fix    Fix the target path or add the missing input file before building.
    File   ...\GameData\Generated\Gameplay\Decks.ndf
    Mod    my_pack (My Pack)
    Patch  gameplay.decks

  2 of 2  Nothing matched this selector
    ...
```

Fix them all, then run again.

### Common problems

| It says                           | It usually means                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Wrong path**                    | A path escaped the mod folder, or is missing `GameData/`.                                       |
| **Nothing matched this selector** | The name or path you targeted is not in that file. Run `find --name <part>` to see what is.     |
| **Broken NDF**                    | A bracket or comma is missing in a `$raw` block you wrote.                                      |
| **Two mods want the same thing**  | Two mods change one file. See [Advanced → Layering](advanced.md#layering-one-mod-over-another). |
| **Could not read or parse YAML**  | Indentation is off, or you used a tab.                                                          |
| **Expected N file(s), matched M** | A `files:` source folder gained or lost files. Check it, then update `expect.files`.            |
| **Block already exists**          | An `add` uses a name the file already defines. Use `modify`, or rename the new block.           |

### When a game file changed behind YMB

`sync` checks every file it tracks before it builds anything. Two things can have
happened to one since the last sync:

- **It is back at its untouched game file.** WARNO's own `GenerateMod.bat` rewrites some
  declaration files every time it runs, and a game update replaces others. YMB says
  nothing and simply applies over it again, exactly as the first sync did.
- **It holds something else** — a hand edit, or a half-finished write. YMB stops and
  names the files, because applying a patch on top of that would build your change into
  content nobody meant to keep.

For the second case, once you have preserved anything you want to keep:

```text
sync --yes --reset-changed
```

That puts the saved original back over each listed file, then applies your changes on
top of it. `recover --yes --reset-changed` does the same when you want the originals
back and nothing applied. `doctor` lists both kinds separately, so you can see which
files are in which state before you decide.

`--reset-changed` needs to really write the originals back, so it does not combine with
`--dry-run`.

### If you are stuck

```text
doctor                          # are the folders right?
list                            # did YMB find what you expected?
explain --mod my_pack           # why was my patch skipped?
find --name <part-of-a-name>    # what is this block actually called?
validate --no-cache --verbose   # every error, nothing cached
```

Fix the file under `YMB/mods/`, then build again.

---

## What next

| You want to…                     | Read                                                                |
| -------------------------------- | ------------------------------------------------------------------- |
| Understand the four commands     | [How a build works](workflow.md)                                    |
| Know every available setting     | [Configuration](configuration.md)                                   |
| Change values inside game files  | [Changing NDF files](ndf-operations.md)                             |
| Add, copy, or remove whole files | [Configuration → File operations](configuration.md#file-operations) |
| Reuse a value in many places     | [Variables](template-expressions.md)                                |
| Generate output with code        | [Generation scripts](script-tools.md)                               |
