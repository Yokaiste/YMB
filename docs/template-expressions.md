# Variables

Write a value once, use it everywhere. Change it in one place, and every patch that
uses it follows.

```yaml
# in ymb.mod.yaml
variables:
  frontArmor: 7

# in any patch of that mod
value: ${frontArmor}
```

---

## Where variables work

| Works in                       | Example                                     |
| ------------------------------ | ------------------------------------------- |
| Operation values               | `value: ${frontArmor}`                      |
| Nested `changes`               | `FrontArmor: ${frontArmor}`                 |
| Target file paths              | `file: ${gfx}/Ammunition.ndf`               |
| File-operation paths           | `destination: GameData/Assets/${modId}`     |
| Replace file **paths**         | `replace/GameData/.../${modRootName}/x.csv` |
| Replace file **text** contents | `"TOKEN";"${modName}"`                      |
| Script and test paths          | `path: ${scriptDir}/generate.ts`            |
| Temp paths                     | `tempPaths: ['${modId}.cache']`             |

Variables live in `ymb.mod.yaml` (whole mod) or `ymb.patch.yaml` (that patch only).
**Patch variables win** when both define the same name.

File-operation objects are resolved recursively, including `source.path`, `destination`,
and `target`. Text content from `patch` and `mod` sources uses the same substitution
rules as replace files.

---

## Two ways to use one

This distinction matters:

```yaml
value: ${frontArmor} # exact  → stays a number: 7
value: 'Armor is ${frontArmor}' # in text → becomes a string: "Armor is 7"
```

An **exact** template keeps the real type — number, boolean, array, or object.
A template **inside text** is converted to text and joined.

| Value type       | Inside text becomes |
| ---------------- | ------------------- |
| String           | unchanged           |
| Number, boolean  | its normal spelling |
| Array, object    | JSON text           |
| `null`, no value | empty text          |

This is about a variable that **has** an empty value. A name no variable answers
is a mistake, not an empty value, and stops the build — see
[When something is wrong](#when-something-is-wrong).

---

## Built-in variables

Always available, no setup:

| Variable           | Value                                    |
| ------------------ | ---------------------------------------- |
| `modRootName`      | The WARNO mod folder name                |
| `modId`            | This mod's id                            |
| `modName`          | This mod's display name                  |
| `modDescription`   | This mod's description                   |
| `patchId`          | This patch's id, empty outside a patch   |
| `patchName`        | This patch's name, empty outside a patch |
| `patchDescription` | This patch's description, empty outside  |

A common use — put localization under a folder named after the mod:

```text
config/replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv
```

---

## Variables read out of the game

`readValues` in a mod or patch config turns a value that lives in the game files into a
variable, read fresh on every build. From here on it behaves like any other variable —
everything on this page applies to it unchanged.

Full reference: **[Reading values out of the game](configuration.md#reading-values-out-of-the-game)**.

---

## Doing maths and logic

Variables can be built from other variables:

```yaml
variables:
  stats:
    frontArmor: 7
    bonuses: [2, 4]
  finalArmor: ${stats.frontArmor + stats.bonuses[1]} # 11
  label: "${finalArmor >= 10 ? 'Heavy' : 'Standard'}" # "Heavy"
```

| Kind        | Operators                          |
| ----------- | ---------------------------------- |
| Arithmetic  | `+` `-` `*` `/` `%`                |
| Comparison  | `<` `<=` `>` `>=` `==` `!=`        |
| Logical     | `!` `&&` `\|\|`                    |
| Conditional | `condition ? whenTrue : whenFalse` |
| Grouping    | `( ... )`                          |

Notes:

- `+` joins text when either side is a string.
- `&&`, `||`, and `? :` short-circuit — the unused branch is never evaluated.
- Dividing or taking `%` by zero is an error, not `Infinity`.
- Reading a missing property or an out-of-range index is an error.

---

## Helpers

| Helper                                                   | Result                                       |
| -------------------------------------------------------- | -------------------------------------------- |
| `join(array, separator = ',')`                           | Join entries into text                       |
| `repeat(value, count)`                                   | An array with `value` repeated `count` times |
| `len(value)`                                             | Length of a string or array, or key count    |
| `concat(...arrays)`                                      | Combine arrays into one                      |
| `numbers(array)`                                         | Require every entry to be a finite number    |
| `integers(array)`                                        | Keep only whole numbers                      |
| `nonNegativeNumbers(array)`                              | Keep only numbers `>= 0`                     |
| `range(end)`                                             | `0` up to `end - 1`                          |
| `range(start, end, step = 1)`                            | A stepped range                              |
| `sum(array)`                                             | Add the numbers up                           |
| `cartesian(left, right, template = '[{left}, {right}]')` | Every combination of two lists               |

```yaml
variables:
  slotCount: 5
  slotIndexes: ${range(slotCount)} # [0, 1, 2, 3, 4]
  slotValues: ${join(repeat(1, slotCount), ', ')} # "1, 1, 1, 1, 1"
  totalBonus: ${sum([2, 4, 6])} # 12
```

`cartesian` fills `{left}`, `{right}`, `{leftIndex}`, `{rightIndex}`, and `{index}`:

```yaml
variables:
  pairs: ${cartesian(['A', 'B'], [1, 2], '{left}{right}')} # ['A1','A2','B1','B2']
```

> **Generating helpers are capped** at 100,000 items. Going over is an error, not a
> silent truncation — it stops a typo from eating your memory.

---

## When something is wrong

YMB refuses to guess. It reports and stops on:

- an unknown variable name, written on its own as `${typo}` or inside a larger expression
- a missing object property or out-of-range index
- invalid operands, for example maths on text
- division or `%` by zero
- a variable that refers to itself, directly or in a loop
- a generating helper asked for too much

Fix the expression. A bad value is never silently substituted.

---

## See also

- [Configuration](configuration.md#variables) — where to declare variables
- [Changing NDF files](ndf-operations.md) — where the resolved values end up
