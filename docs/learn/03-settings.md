# 3. Make features adjustable

[All documentation](../README.md#beginner-course)

| Previous | You are here | Next |
| --- | --- | --- |
| [2. Change unit health](02-unit-health.md) | Learn · 3. Make features adjustable | [4. Calculate from current game values](04-calculations.md) |

Continue with `MyFirstMod` and its `first_mod` project. You'll set the M1A1 Abrams to 30 health through a local override, then turn that feature off and back on.

Keep the welcome patch from `init` unchanged. This lesson edits only the health patch and local settings.

## Start from the single-tank patch

If you tried the loop or bulk versions in the NDF lesson, replace the contents of this file with the single-tank version below:

```text
MyFirstMod/YMB/mods/first_mod/config/patch/gameplay/health/ymb.patch.yaml
```

```yaml
version: 2
id: gameplay.health
name: M1A1 health
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

Run `build --mod first_mod`. In the preview's `GameData/Generated/Gameplay/TacticalUnits.ndf`, find `Descriptor_Unit_M1A1_Abrams_US`. Its `TBaseDamageModuleDescriptor` should contain `MaxPhysicalDamages = 20`.

## Change it without editing the patch

Create `MyFirstMod/YMB/.ymb/config.yaml` for this installation's overrides. Keep the commented root `ymb.config.yaml` as the shared defaults. Use:

```yaml
version: 2
mods:
  first_mod:
    patches:
      gameplay.health:
        variables:
          health: 30
```

If that file already contains settings you need, keep them and add this project under its existing `mods` entry. Do not create a second `version` or `mods` key.

Build again:

```text
.\YMB.exe build --mod first_mod
```

The M1A1's preview value should now be `30`, while the patch file still says `health: 20`. Your local override wins.

To try it in WARNO, run `sync --mod first_mod --yes`, run `MyFirstMod/GenerateMod.bat`, and enable `MyFirstMod`. The same M1A1 Abrams now has a maximum of 30 health. Its armor and weapons are unchanged; extra health is not extra armor.

## Turn the feature off

Keep the local value and add `enabled: false` to the patch override:

```yaml
version: 2
mods:
  first_mod:
    patches:
      gameplay.health:
        enabled: false
        variables:
          health: 30
```

Run `build --mod first_mod`. The report should exclude `gameplay.health`. With only the starter and this health patch installed, `TacticalUnits.ndf` is now absent from the preview because nothing selected changes it. The welcome-screen title remains.

`sync --mod first_mod --yes` restores the previously applied health file when it is no longer part of this project's output. Compile again to return the tank to its original health in game.

Change `enabled` to `true` and build again. The health patch returns with the local value `30`.

## Keep experiments out of normal builds

In the health patch file, change `scope: prod` to `scope: dev`. Then compare:

```text
.\YMB.exe build --mod first_mod
.\YMB.exe build --mod first_mod --scope dev
```

The first command leaves out the health patch. The second includes both production and development patches.

Put `scope: prod` back before continuing. Leave the local override at `health: 30` and `enabled: true`. [Lesson 4](04-calculations.md) starts by removing that fixed override, then calculates health from the game's original value.

### Checkpoint

| Setting | Leave it at |
| --- | --- |
| Health patch scope | `prod` |
| Local `enabled` | `true` |
| Patch default health | `20` |
| Local health override | `30` |

### Try it yourself

Predict the result before deleting only the local `health: 30` entry. Build: the patch default of 20 returns. Put 30 back for the next lesson. You can switch settings without maintaining two copies of the unit file.

### Look up the format

For lists and quoted values, the official [YAML language overview](https://yaml.org/spec/1.2.2/#chapter-2-language-overview) has small examples. YMB's [configuration reference](../references/configuration.md) defines which settings work here.

| Previous | You are here | Next |
| --- | --- | --- |
| [2. Change unit health](02-unit-health.md) | Learn · 3. Make features adjustable | [4. Calculate from current game values](04-calculations.md) |
