# 2. Change unit health

[All documentation](../README.md#beginner-course)

| Previous | You are here | Next |
| --- | --- | --- |
| [1. Put your title in WARNO](01-first-build.md) | Learn · 2. Change unit health | [3. Make features adjustable](03-settings.md) |

Keep `first_mod` and its welcome title. Edit one health patch against real game data: first one M1A1 Abrams, then two tanks, then every eligible unit.

## Find the real unit first

From PowerShell inside YMB, run:

```powershell
.\YMB.exe find --file GameData/Generated/Gameplay/TacticalUnits.ndf --name M1A1_Abrams_US
```

Copy the exact regular-unit name, including its country suffix. Open the original file in `MyFirstMod/GameData/Generated/Gameplay/` and find that block. Inspect its damage module without editing it. `find --field` searches direct fields only, so it does not read health nested inside a module.

## Try a complete example

Finish [the first-build guide](01-first-build.md) first. You should have `YMB/mods/first_mod/config/ymb.mod.yaml` and the generated welcome-screen patch.

The relevant game file is:

```text
GameData/Generated/Gameplay/TacticalUnits.ndf
```

In the game data used for this guide, `Descriptor_Unit_M1A1_Abrams_US` has `MaxPhysicalDamages = 10`. We will set it to `20`. Despite its name, this field is the unit's damage capacity: its health. It does not change armor or outgoing damage. More HP does not make a shell stop penetrating.

Create `YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml`. Put this **whole file** in it:

```yaml
version: 2
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
        value: ${health}
```

Run this in the [PowerShell terminal in YMB/](01-first-build.md#where-to-type-commands):

```text
.\YMB.exe build --mod first_mod
```

Open `YMB/.ymb/build/output/GameData/Generated/Gameplay/TacticalUnits.ndf`. Search for `export Descriptor_Unit_M1A1_Abrams_US is`, then its `MaxPhysicalDamages` line. The **active line**, outside YMB's original-value comments, should say `20`.

Check `Descriptor_Unit_M1IP_Abrams_US` too. Its health should still be `10` on the data used here. Your welcome-screen title and localisation files should still appear in the same preview.

### Apply a lesson and try it in WARNO

Each health variant below uses the same commands:

```text
.\YMB.exe build --mod first_mod
.\YMB.exe sync --mod first_mod --yes
```

Inspect the preview before syncing. Then run `GenerateMod.bat` in the WARNO mod folder, enable the mod, and check the affected unit in the armory and a fresh skirmish. Use a deck containing the regular M1A1 Abrams; command, recon, and heavy-armor variants have different descriptor names.

YMB's preview is not the compiled mod. Skipping WARNO's compilation step is an excellent way to test yesterday's changes again.

Game updates can change names and values. If a selector stops matching, [find the current object](../references/ndf-patches.md#finding-the-name-to-select) before changing the patch. Do not edit the generated preview to repair it.

## Modify: change a value

Read the health selector from left to right:

| Part                             | What it selects                         |
| -------------------------------- | --------------------------------------- |
| `Descriptor_Unit_M1A1_Abrams_US` | The regular US M1A1 Abrams descriptor   |
| `ModulesDescriptors`             | Its list of gameplay modules            |
| `[TBaseDamageModuleDescriptor]`  | The damage-capacity module in that list |
| `MaxPhysicalDamages`             | The health value inside the module      |

The field form of `modify` takes `value`. Here `${health}` reads the patch's setting, so changing `health: 20` to `health: 30` changes the result without rewriting the selector. Keep health values as positive integers.

The object form takes `changes`, a map of direct field names to new values. It is useful when several fields belong directly to one named object. The health field is nested inside a module, so the field selector is the precise choice here.

Object modifications can also add `leadingComment` above the object. Use that form for objects whose fields share a line with their header: field-level ownership comments need their own line, and YMB rejects placement that would comment out surrounding NDF.

## forEach: the same operations for every entry in a list

Now give the regular M1A1 and M1IP Abrams `20` HP each.

**Replace the entire contents of the same health patch** with this version. Keep the welcome-screen patch. Do not add a second health patch alongside the first.

```yaml
version: 2
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - forEach:
          - Descriptor_Unit_M1A1_Abrams_US
          - Descriptor_Unit_M1IP_Abrams_US
        as: unit
        do:
          - op: modify
            selector:
              kind: field
              by: path
              value: '${unit}.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages'
            value: ${health}
```

Build again. Both named tanks should show `20`; other unit descriptors should be unchanged. These two units started at `10` in the data used for this guide.

`${unit}` is the current list item. `${unitIndex}` is its zero-based position: `0` for M1A1, `1` for M1IP. The loop expands into two normal `modify` operations, so a missing named unit fails the build.

`forEach` accepts a literal list or a variable resolving to one. Loops can nest, and inner loops can use outer bindings. An empty list runs nothing; a non-list value fails. Expansion is limited to 10,000 operations per target.

## Bulk: change many blocks at once

`forEach` repeats instructions for a list you supply. `bulk` searches for matching objects and applies edits within them. Start with the same two tanks so you can compare the result.

### Match the two named tanks

Replace the whole health patch with:

```yaml
version: 2
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: bulk
        match:
          conditions:
            - on: type
              is: equals
              value: TEntityDescriptor
            - on: name
              is: equals
              value:
                - Descriptor_Unit_M1A1_Abrams_US
                - Descriptor_Unit_M1IP_Abrams_US
        expect:
          minBlocks: 2
        edits:
          - field: MaxPhysicalDamages
            set: ${health}
            minChanges: 2
```

Build and inspect the same two descriptors. The result should match the loop version: `20` HP on each tank, with other units untouched.

The two conditions must both match: the object has the right type **and** one of the exact names. `field: MaxPhysicalDamages` edits that field wherever it appears inside each selected object. Unlike a field selector, a bulk field edit uses the field name, not the full dotted path.

`minBlocks: 2` requires at least two matching objects. `minChanges: 2` requires at least two matching health values to be changed or already equal to the requested value. These are minimums, not a cap on how much a broad rule can change.

### Give every eligible unit 20 HP

For the wider experiment, replace the whole health patch again:

```yaml
version: 2
id: gameplay.health
name: Unit health
enabled: true
scope: prod
variables:
  health: 20
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - op: bulk
        match:
          conditions:
            - on: type
              is: equals
              value: TEntityDescriptor
            - on: name
              is: startsWith
              value: Descriptor_Unit_
        expect:
          minBlocks: 1
        edits:
          - field: MaxPhysicalDamages
            set: ${health}
            minChanges: 1
```

This changes `MaxPhysicalDamages` inside every matching unit descriptor in this file. That includes infantry, transports, aircraft, command units, and other variants, not just tanks. A matched object without that field is left unchanged.

The number of matching units depends on your WARNO data. Inspect several unrelated units in the preview, including one whose original health was below `10`. They should now all have `20`; unrelated fields should stay the same.

> [!WARNING]
> This is a broad balance experiment. Equal HP does not mean equal survivability, and changing infantry health can interact with squad behavior. Check the result in game before keeping or sharing it. The name prefix is doing the selecting; the minimum count is not an emergency brake.

### Return to one tank before the next lesson

Restore the [first complete patch](#try-a-complete-example), with `health: 20` and the single M1A1 selector. Build again. M1A1 should have `20`; M1IP and other units should return to their original preview values.

If you applied a broader version, sync this restored version and compile again to replace it in WARNO. Continue with [local settings](../references/configuration.md) using this same `first_mod` project. That lesson also includes the complete single-unit patch if you need to reset your starting point.

### Checkpoint

| Descriptor | Final preview HP on the tutorial data |
| --- | ---: |
| `Descriptor_Unit_M1A1_Abrams_US` | 20 |
| `Descriptor_Unit_M1IP_Abrams_US` | 10 |

### Try it yourself

Temporarily misspell the M1A1 name and build. Read the selector error and its source location, then restore the name and rebuild. A rule that cannot find its tank should complain before you launch the game.

The [operation reference](../references/ndf-patches.md) covers all selectors and actions. Lesson 5 uses add, remove, and copy to finish the welcome screen.

| Previous | You are here | Next |
| --- | --- | --- |
| [1. Put your title in WARNO](01-first-build.md) | Learn · 2. Change unit health | [3. Make features adjustable](03-settings.md) |
