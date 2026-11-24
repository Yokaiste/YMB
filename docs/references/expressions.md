# Variables, expressions, and helpers

[All documentation](../README.md#reference)

| Previous | You are here | Next |
| --- | --- | --- |
| [Project files, settings, and assets](configuration.md) | Reference · 3/7 · Variables, expressions, and helpers | [Generator SDK and execution](generators.md) |

Expressions resolve after variable merging. For a complete health patch, follow [lesson 4](../learn/04-calculations.md).

| You need to… | Go to |
| --- | --- |
| Use a setting | [Supported locations](#where-variables-work), [types](#keep-a-values-type), [nested values](#nested-settings-and-references) |
| Read project or game data | [Built-ins](#built-in-variables), [game reads](#reading-game-data) |
| Calculate a result | [Operators](#maths-and-conditions), [helpers](#helpers) |
| Fix a calculation | [Limits](#expression-limits), [errors](#when-something-is-wrong) |

## Where variables work

| Location                             | Use in this project                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Operation values and `changes`       | `value: ${health}`                                                                       |
| Selectors                            | `${unit.descriptor}.ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages` |
| Target paths                         | The localisation destination includes `${modRootName}`                                  |
| File-operation and replacement paths | `GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv`                             |
| Supported text assets                | The starter CSV substitutes `${csv(titleToken)};${csv(modName)}`                        |

A mod variable is available throughout that project. A patch variable applies only inside its patch and overrides a mod default with the same name. Installation settings in `.ymb/config.yaml` have higher precedence; see [override order](configuration.md#where-a-value-comes-from).

File-operation source, destination, and removal paths resolve expressions. Content substitution applies to supported text from `patch` and `mod` sources; `game` and `exampleAssets` copies keep their original bytes.

Generator `project` and `executable` paths and declared `tempPaths` are literal relative paths. They do not resolve expressions.

## Keep a value's type

An expression occupying the whole YAML string preserves its result type. In the first health patch:

```yaml
value: ${health}
```

This writes a number. Quoting the YAML as `value: '${health}'` also preserves that result type because the whole string is one expression.

Embedding a value in other text produces a string. The starter uses that behavior in its CSV:

```csv
${csv(titleToken)};${csv(modName)}
```

For example, if the starter assigns the title key `A1B2C3D4_T`, the built row is:

```csv
"A1B2C3D4_T";"My Very Serious Mod"
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
| `modPersistentRoot` | Absolute path to this mod's `config/.ymb/` storage |
| `modSessionRoot` | Absolute path to this installation's `YMB/.ymb/mods/ID/` storage |
| `patchId`          | `gameplay.health` inside the health patch; empty outside a patch |
| `patchName`        | The current patch's `name`; empty outside a patch                |
| `patchDescription` | The current patch's `description`, or empty                      |
| `config` | Parsed builder, mod, and current patch configuration; see below |

Built-ins are reserved. They cannot be replaced by custom defaults or local overrides.

The localisation path uses `modRootName` because WARNO needs its folder name. Renaming the display title does not move the CSV. Several projects can share one `modRootName` because they build into the same WARNO mod folder.

### Configuration snapshots

`config.builder`, `config.mod`, and `config.patch` expose all supported YAML keys and defaults. Builder config combines shared and local files; mod/patch selection reflects local overrides. `config.patch` is `null` outside a patch.

| Expression | Reads |
| --- | --- |
| `${config.mod.release.version}` | Mod release version |
| `${config.mod.dependencies[0].reason}` | First download dependency's reason |
| `${config.builder.settings.workerThreads}` | Configured thread limit |

These can be read in patches, text assets, and generator code.

Snapshots leave `${...}` as text: reading one neither runs operations nor needs loop bindings. Their `variables` hold declared defaults and expressions; ordinary variables give resolved values after overrides. Changing a snapshot in generator memory changes neither files nor the command plan.

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

The health lesson uses `round(baseHealth * healthMultiplier)`. To try a cap of 18, use the [complete single-tank patch](../learn/04-calculations.md#read-the-original-and-double-it), then replace only its `health` variable with:

```yaml
health: '${baseHealth * healthMultiplier > 18 ? 18 : round(baseHealth * healthMultiplier)}'
```

With the local multiplier of `1.5`, it still produces `15`. A multiplier of `3` produces `18`.

`+` joins text if either side is a string. `&&`, `||`, and the conditional evaluate only the branch they need. Dividing by zero, invalid arithmetic, missing members, and out-of-range indexes fail.

Expressions use YMB's expression language. Use a [generator](generators.md) when you need a program.

## Helpers

| Call                                                     | Result                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `round(number)`                                          | Nearest integer                                        |
| `decimal(number)`                                        | Numeric text with a decimal point or exponent          |
| `csv(value)` | Quoted localisation cell; doubles quotes and writes line breaks as literal `\n` |
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

`cartesian` substitutes `{left}`, `{right}`, `{leftIndex}`, `{rightIndex}`, and `{index}` into its text template.

## Expression limits

| Limit | Maximum |
| --- | --- |
| Expression source | 1 MiB |
| Parsing, expression trees, evaluation, variable references | 128 levels each; aliases share the evaluation depth limit |
| Generated lists and expanded operations | Bounded by the memory budget, with no separate item count cap |
| Resolver memory | 256 MiB estimated storage, copies, and cached paths |

Operation expansion shares one memory budget per target across expressions, loop bindings, and intermediate values. Replication and text construction check before allocating; excess returns `E28`. Simplify the calculation or use a streaming generator for larger output.

## Reading game data

`readValues` works in both mod and patch configs. Each entry has a game-relative `file` and an NDF `path`. Numeric values become numbers; other values arrive as written, including quotes or list syntax. An explicit variable with the same name wins.

Reads happen before patching and use original game data. They cannot read a file first created by the same build. Use [generator target readers](generators.md) when a calculation needs earlier generated output.

## When something is wrong

The error names the failed input and location. Check spelling, properties, indexes, circular references, operands, division or remainder by zero, and generated item counts.

If a valid calculation seems to do nothing, check `.ymb/config.yaml` for an old override. The calculation lesson begins by removing that fixed override.

| Previous | You are here | Next |
| --- | --- | --- |
| [Project files, settings, and assets](configuration.md) | Reference · 3/7 · Variables, expressions, and helpers | [Generator SDK and execution](generators.md) |
