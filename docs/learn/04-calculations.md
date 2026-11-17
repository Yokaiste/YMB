# 4. Calculate from current game values

[All documentation](../README.md#beginner-course)

| Previous | You are here | Next |
| --- | --- | --- |
| [3. Make features adjustable](03-settings.md) | Learn · 4. Calculate from current game values | [5. Finish the menu and own its assets](05-menu-and-assets.md) |

The M1A1 health patch currently replaces the game's value with a fixed number. Make it a multiplier instead: read the original health, multiply it, then write the result. When WARNO changes the original, your calculation follows it.

## Remove the fixed local override

Open `MyFirstMod/YMB/.ymb/config.yaml`. The previous lesson left `health: 30` under `mods.first_mod.patches.gameplay.health.variables`. Remove that variable.

For the tutorial installation, the file can now be:

```yaml
version: 2
mods:
  first_mod:
    patches:
      gameplay.health:
        enabled: true
```

Keep any unrelated settings you added. A local `health` value would override the calculated `health` below. There is no amount of maths that can win an argument with an explicit override.

## Read the original and double it

Replace the complete contents of `MyFirstMod/YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml` with:

```yaml
version: 2
id: gameplay.health
name: M1A1 health multiplier
scope: prod
readValues:
  baseHealth:
    file: GameData/Generated/Gameplay/TacticalUnits.ndf
    path: Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
variables:
  healthMultiplier: 2
  health: ${round(baseHealth * healthMultiplier)}
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

Run:

```text
.\YMB.exe build --mod first_mod
```

In `YMB/.ymb/build/output/GameData/Generated/Gameplay/TacticalUnits.ndf`, find `Descriptor_Unit_M1A1_Abrams_US`. The `TBaseDamageModuleDescriptor` field `MaxPhysicalDamages` should be `20`: the original is `10` in the game data used for this guide.

The three parts have separate jobs:

1. `readValues.baseHealth` reads the original field and exposes it as a variable.
2. `healthMultiplier` is the setting you choose.
3. `health` calculates the number written by the operation.

`round(...)` keeps the result a whole number. A build reads original data, including YMB's saved original when this file was previously synced. Rebuilding does not keep doubling yesterday's result.

If a later WARNO update changes the original health, the expected result becomes twice that new value. If the unit or field disappears, YMB reports the missing input.

## Choose a multiplier locally

Add `healthMultiplier: 1.5` to the local patch override. For this tutorial:

```yaml
version: 2
mods:
  first_mod:
    patches:
      gameplay.health:
        enabled: true
        variables:
          healthMultiplier: 1.5
```

Build again. With the original value `10`, the M1A1's preview health becomes `15`. The patch still contains its default multiplier of `2`.

To try the result, run `sync --mod first_mod --yes`, run `MyFirstMod/GenerateMod.bat`, and enable `MyFirstMod` in WARNO. The M1A1 Abrams should now have 15 maximum health. The title from the first lesson remains in place.

Now apply the calculation to a second tank, reading its own original health.

## Apply the calculation to two tanks

The M1IP Abrams is `Descriptor_Unit_M1IP_Abrams_US`. Read each tank's original separately so the calculation still works if they stop sharing the same base health.

To try this version, replace the whole health patch with:

```yaml
version: 2
id: gameplay.health
name: Abrams health multiplier
scope: prod
readValues:
  m1a1BaseHealth:
    file: GameData/Generated/Gameplay/TacticalUnits.ndf
    path: Descriptor_Unit_M1A1_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
  m1ipBaseHealth:
    file: GameData/Generated/Gameplay/TacticalUnits.ndf
    path: Descriptor_Unit_M1IP_Abrams_US.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
variables:
  healthMultiplier: 2
  units:
    - descriptor: Descriptor_Unit_M1A1_Abrams_US
      baseHealth: ${m1a1BaseHealth}
    - descriptor: Descriptor_Unit_M1IP_Abrams_US
      baseHealth: ${m1ipBaseHealth}
targets:
  - file: GameData/Generated/Gameplay/TacticalUnits.ndf
    operations:
      - forEach: ${units}
        as: unit
        do:
          - op: modify
            selector:
              kind: field
              by: path
              value: ${unit.descriptor}.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages
            value: ${round(unit.baseHealth * healthMultiplier)}
```

Build `first_mod`. Both originals are `10` in the data used here, so both preview fields become `15` with your local multiplier of `1.5`. Remove that local override and both become `20` from the patch's default of `2`.

`forEach` runs the operation once for each entry in `units`. During each run, `unit.descriptor` provides the unit name and `unit.baseHealth` provides its own starting health. See [loops](02-unit-health.md#foreach-the-same-operations-for-every-entry-in-a-list) for selection and nesting rules.

Keep the two-tank version and the local multiplier of `1.5`. The next lesson keeps this rule and improves the menu. These expressions work like spreadsheet formulas: choose the inputs and let YMB calculate the result.

### Checkpoint and experiment

Both selected tanks should have 15 HP when their originals are 10. Set the local multiplier to `1.2`, predict 12, then build and inspect both blocks. Restore `1.5`.

Run another unchanged build. The result stays 15, because reads use saved originals rather than yesterday's boosted tank. The [expression reference](../references/expressions.md) covers conditionals, list helpers, and limits.

| Previous | You are here | Next |
| --- | --- | --- |
| [3. Make features adjustable](03-settings.md) | Learn · 4. Calculate from current game values | [5. Finish the menu and own its assets](05-menu-and-assets.md) |
