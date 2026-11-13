# 4. Calculate health from the game

[Docs](README.md) / Variables · [Previous: local settings](configuration.md) · [Next: write a generator](script-tools.md)

The M1A1 health patch currently replaces the game's value with a fixed number. Make it a multiplier instead: read the original health, multiply it, then write the result. When WARNO changes the original, your calculation follows it.

## Remove the fixed local override

Open `MyFirstMod/YMB/ymb.config.yaml`. The previous lesson left `health: 30` under `mods.first_mod.patches.gameplay.health.variables`. Remove that variable.

For the tutorial installation, the file can now be:

```yaml
version: 1
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
version: 1
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
build --mod first_mod
```

In `YMB/.ymb-build/output/GameData/Generated/Gameplay/TacticalUnits.ndf`, find `Descriptor_Unit_M1A1_Abrams_US`. The `TBaseDamageModuleDescriptor` field `MaxPhysicalDamages` should be `20`: the original is `10` in the game data used for this guide.

The three parts have separate jobs:

1. `readValues.baseHealth` reads the original field and exposes it as a variable.
2. `healthMultiplier` is the setting you choose.
3. `health` calculates the number written by the operation.

`round(...)` keeps the result a whole number. A build reads original data, including YMB's saved original when this file was previously synced. Rebuilding does not keep doubling yesterday's result.

If a later WARNO update changes the original health, the expected result becomes twice that new value. If the unit or field disappears, YMB reports the missing input.

## Choose a multiplier locally

Add `healthMultiplier: 1.5` to the local patch override. For this tutorial:

```yaml
version: 1
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

You can continue to [the generator lesson](script-tools.md) now. The rest of this page shows how to scale the same calculation and serves as a reference.

## Apply the calculation to two tanks

The M1IP Abrams is `Descriptor_Unit_M1IP_Abrams_US`. Read each tank's original separately so the calculation still works if they stop sharing the same base health.

To try this version, replace the whole health patch with:

```yaml
version: 1
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

`forEach` runs the operation once for each entry in `units`. During each run, `unit.descriptor` provides the unit name and `unit.baseHealth` provides its own starting health. See [loops](ndf-operations.md#foreach-the-same-operations-for-every-entry-in-a-list) for selection and nesting rules.

Either this version or the single-tank version can remain active. The next lesson replaces this same patch with a script.

## Where variables work

| Location                             | Use in this project                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Operation values and `changes`       | `value: ${health}`                                                                       |
| Selectors                            | `${unit.descriptor}.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages` |
| Target paths                         | The starter's `generatedInfoTarget` includes `${modId}`                                  |
| File-operation and replacement paths | `GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv`                             |
| Supported text assets                | The starter CSV substitutes `"${welcomeTitleToken}";"${modName}"`                        |
| Script and test paths                | Registered paths may contain variables                                                   |
| Temporary paths                      | Declared paths may contain variables                                                     |

A mod variable is available throughout that project. A patch variable applies only inside its patch and overrides a mod default with the same name. Local settings in `ymb.config.yaml` have higher precedence; see [override order](configuration.md#where-a-value-comes-from).

File-operation objects resolve recursively. Content substitution applies to supported text from `patch` and `mod` sources; `game` and `exampleAssets` copies keep their original bytes.

## Keep a value's type

An expression occupying the whole YAML string preserves its result type. In the first health patch:

```yaml
value: ${health}
```

This writes a number. Quoting the YAML as `value: '${health}'` also preserves that result type because the whole string is one expression.

Embedding a value in other text produces a string. The starter uses that behavior in its CSV:

```csv
"${welcomeTitleToken}";"${modName}"
```

With the first lesson's project name, the built row is:

```csv
"FIRST_MO_T";"My Very Serious Mod"
```

| Value embedded in text            | Conversion    |
| --------------------------------- | ------------- |
| String                            | Its contents  |
| Number or boolean                 | Its text form |
| Array or object                   | JSON text     |
| `null` or an existing empty value | Empty text    |

An unknown variable is an error. It does not become an empty string.

## Built-in variables

| Name               | Value in these lessons                                           |
| ------------------ | ---------------------------------------------------------------- |
| `modRootName`      | `MyFirstMod`, the WARNO mod folder name                          |
| `modId`            | `first_mod`                                                      |
| `modName`          | `My Very Serious Mod` after the first lesson's edit              |
| `modDescription`   | The project's `description`, or empty                            |
| `patchId`          | `gameplay.health` inside the health patch; empty outside a patch |
| `patchName`        | The current patch's `name`; empty outside a patch                |
| `patchDescription` | The current patch's `description`, or empty                      |

Built-ins are reserved. They cannot be replaced by custom defaults or local overrides.

The localisation path uses `modRootName` because WARNO needs its folder name. Renaming the display title does not move the CSV. Several projects can share one `modRootName` because they build into the same WARNO mod folder.

## Nested settings and references

The two-tank example uses a list of objects. `units[0].descriptor` reads the first unit's name; `units[1].baseHealth` reads the second unit's original health.

Dot access reads a member; brackets read a member or array index. A reference to a whole object returns its resolved contents. Nested aliases and helpers use the same resolution rules.

Expressions resolve after defaults and local overrides are merged. Changing `healthMultiplier` therefore changes every calculation that uses it. Cycles fail even when the cycle crosses several settings.

## Maths and conditions

| Purpose     | Operators                          |
| ----------- | ---------------------------------- |
| Arithmetic  | `+` `-` `*` `/` `%`                |
| Comparison  | `<` `<=` `>` `>=` `==` `!=`        |
| Logic       | `!` `&&` `\|\|`                    |
| Conditional | `condition ? whenTrue : whenFalse` |
| Grouping    | `(expression)`                     |

The health lesson uses `round(baseHealth * healthMultiplier)`. To try a cap of 18, return to the complete single-tank patch above, then replace only its `health` variable with:

```yaml
health: '${baseHealth * healthMultiplier > 18 ? 18 : round(baseHealth * healthMultiplier)}'
```

With the local multiplier of `1.5`, it still produces `15`. A multiplier of `3` produces `18`.

`+` joins text if either side is a string. `&&`, `||`, and the conditional evaluate only the branch they need. Dividing by zero, invalid arithmetic, missing members, and out-of-range indexes fail.

Expressions are YMB's small expression language. They do not execute arbitrary JavaScript. Use a [script](script-tools.md) when you need a program.

## Helpers

| Call                                                     | Result                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `round(number)`                                          | Nearest integer                                        |
| `decimal(number)`                                        | Numeric text with a decimal point or exponent          |
| `join(array, separator = ',')`                           | Entries joined as text                                 |
| `repeat(value, count)`                                   | A list containing repeated values                      |
| `len(value)`                                             | String or array length, or object key count            |
| `pluck(records, field)`                                  | One named field from every record; missing fields fail |
| `concat(...arrays)`                                      | Combined arrays                                        |
| `numbers(array)`                                         | Requires finite numeric entries                        |
| `integers(array)`                                        | Keeps whole numbers                                    |
| `nonNegativeNumbers(array)`                              | Keeps numbers greater than or equal to zero            |
| `range(end)`                                             | Integers from zero up to, but excluding, `end`         |
| `range(start, end, step = 1)`                            | Values at the requested interval                       |
| `sum(array)`                                             | Sum of numeric entries                                 |
| `cartesian(left, right, template = '[{left}, {right}]')` | Text for every pair from two lists                     |

For the two-tank variables, `len(units)` returns `2`, `pluck(units, 'descriptor')` returns the two descriptor names, and `sum(pluck(units, 'baseHealth'))` returns `20` with the current originals.

`cartesian` substitutes `{left}`, `{right}`, `{leftIndex}`, `{rightIndex}`, and `{index}` into its text template. Helpers that generate lists are capped at 100,000 items. An oversized result fails instead of being truncated.

## Reading game data

`readValues` works in both mod and patch configs. Each entry has a game-relative `file` and an NDF `path`. Numeric values become numbers; other values arrive as written, including quotes or list syntax. An explicit variable with the same name wins.

Reads happen before patching and use original game data. They cannot read a file first created by the same build. Use [script target readers](script-tools.md) when a calculation needs earlier generated output.

## When something is wrong

Check the name and location in the error:

- A misspelled variable, property, or index is rejected.
- A circular reference is rejected.
- Invalid operands and division or remainder by zero are rejected.
- Generating too many items is rejected.

If a valid calculation seems to do nothing, check `ymb.config.yaml` for an old override. The first step of this lesson removes one for exactly that reason.
