# Template Expressions Reference

This page covers the `${...}` expression language used by YMB for paths, values, variables, and generated text.

## ✨ The Two Rules That Matter Most

> [!IMPORTANT]
> If you remember only two things, remember these:
>
> - an exact template like `${value}` keeps the resolved type
> - embedded text like `Prefix-${value}` becomes a string

Those two rules explain most of the surprising cases people hit when they first start using template expressions.

## 📍 Where Templates Work

YMB expands templates in:

- patch target file paths
- patch operation values and nested `changes`
- replace file paths
- supported replace-file content
- script config paths

## 🧠 Built-In Variables

These variables are always available:

| Variable           | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `modRootName`      | Folder name of the WARNO mod root containing `YMB`                  |
| `modId`            | Source-mod id                                                       |
| `modName`          | Source-mod display name                                             |
| `modDescription`   | Source-mod description or empty string                              |
| `patchId`          | Patch id for patch-owned templates, otherwise empty string          |
| `patchName`        | Patch name for patch-owned templates, otherwise empty string        |
| `patchDescription` | Patch description for patch-owned templates, otherwise empty string |

Precedence:

- patch `variables` override source-mod `variables`
- built-in variables are always available

## 🔢 Literals

YMB expressions support these literal values:

- numbers such as `7`, `12`, and `3.5`
- strings with single or double quotes
- booleans: `true` and `false`
- `null`
- arrays such as `[1, 2, 3]`

Example:

```yaml
variables:
  baseArmor: 7
  armorLabel: "${'Armor-' + baseArmor}"
  slotIndexes: ${range(0, 5)}
```

## ➕ Operators

Supported operators:

- arithmetic: `+`, `-`, `*`, `/`, `%`
- comparison: `<`, `<=`, `>`, `>=`, `==`, `!=`
- logical: `!`, `&&`, `||`
- conditional: `condition ? whenTrue : whenFalse`
- grouping: `( ... )`

Notes:

- `+` concatenates when either side is a string
- `&&`, `||`, and `?:` short-circuit
- division by zero and modulo by zero fail with an error

Example:

```yaml
variables:
  planeCap: 99
  planeLimitLabel: "${planeCap > 96 ? 'Large' : 'Standard'}"
```

## 🧩 Member Access

Expressions can read nested data from objects, arrays, and strings:

- `stats.frontArmor`
- `stats['frontArmor']`
- `bonuses[1]`
- `modName[0]`

Rules:

- array and string indexes must be non-negative integers
- out-of-range indexes fail with an error
- missing object properties fail with an error

Example:

```yaml
variables:
  stats:
    frontArmor: 7
    bonuses: [2, 4]
  finalArmor: ${stats.frontArmor + stats.bonuses[1]}
```

## 🧰 Helpers

| Helper                                                   | What it does                                           |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `join(array, separator = ',')`                           | Render array entries into one string                   |
| `repeat(value, count)`                                   | Create an array with the same value repeated           |
| `len(value)`                                             | Length of a string or array, or key count of an object |
| `concat(...arrays)`                                      | Join arrays into one array                             |
| `numbers(array)`                                         | Validate that every entry is numeric and return them   |
| `integers(array)`                                        | Keep only integer numeric entries                      |
| `nonNegativeNumbers(array)`                              | Keep only numeric entries greater than or equal to `0` |
| `range(end)`                                             | Generate `[0, 1, ..., end - 1]`                        |
| `range(start, end, step = 1)`                            | Generate a stepped numeric range                       |
| `sum(array)`                                             | Add numeric entries in an array                        |
| `cartesian(left, right, template = '[{left}, {right}]')` | Render a cartesian product                             |

Generating helpers (`repeat`, `range`, `cartesian`) are capped at 100 000 items per call; larger requests fail with an error instead of exhausting memory.

Example:

```yaml
variables:
  deckSlotCount: 5
  deckSlotIndexes: ${range(deckSlotCount)}
  deckSlotRow: ${join(repeat(1, deckSlotCount), ', ')}
  eliteSlots: ${concat(range(0, 2), repeat(9, 2))}
  rawThresholds: [-2, -0.5, 0, 0.25, 1, 1.5, 2]
  safeUnsignedChoices: ${integers(nonNegativeNumbers(rawThresholds))}
  totalBonus: ${sum([2, 4, 6])}
```

### Numeric sanitizing helpers

These helpers are useful when the source config is intentionally broad, but the target field is stricter:

- `numbers(array)` ensures every entry is a finite number and fails fast if any entry is not numeric
- `integers(array)` keeps only integer values, which is useful for fields that reject floats
- `nonNegativeNumbers(array)` keeps only values valid for `>= 0` float-style fields
- combine `integers(nonNegativeNumbers(array))` when a target needs unsigned-style integer values

Example:

```yaml
variables:
  upkeepPercentValues: [0, 0.25, 0.5, 1, 1.5, 2]
  upkeepPercentValuesRaw: "${'[ ' + join(upkeepPercentValues, ', ') + ' ]'}"
  upkeepPercentUnsignedRaw: "${'[ ' + join(integers(nonNegativeNumbers(upkeepPercentValues)), ', ') + ' ]'}"
```

## 🔄 Stringification Rules

When an exact template resolves to a non-string value, YMB keeps the type.

When a template is embedded in surrounding text, YMB stringifies the result:

- strings stay unchanged
- `null` and `undefined` become an empty string
- objects and arrays become JSON text
- numbers and booleans become their normal string form

## ⚖ Truthiness

Conditional expressions and logical operators use JavaScript-style truthiness:

- falsy: `false`, `0`, `''`, `null`, `undefined`
- truthy: everything else, including arrays and objects

Example:

```yaml
variables:
  customName: ''
  displayName: '${customName || modName}'
```

## ❌ Error Behavior

YMB is permissive for simple substitution but strict for real expressions.

These resolve to an empty string:

- `${missing}`
- `Prefix-${missing}`

These fail with an error:

- `${missingValue + 1}`
- `${stats.unknownField}`
- `${values[99]}`
- circular references such as `${loopA}` depending on `${loopB}` and back again
- malformed expressions
- unterminated templates

> [!TIP]
> If an expression becomes hard to reason about, move part of it into a named variable. A boring config is easier to maintain than a clever one, and easier for AI coding agents to reason about safely.

## 🧪 Worked Example

```yaml
variables:
  planeCap: 99
  stats:
    frontArmor: 7
    bonuses: [2, 4]
    labels: ['Elite', 'Reserve']
  planeLimit: ${planeCap}
  planeTier: '${planeLimit >= 96 ? stats.labels[0] : stats.labels[1]}'
  armorChoices: ${concat(range(0, 2), repeat(stats.frontArmor, 2))}
targets:
  - file: GameData/UserInterface/Use/InGame/UISpecificSkirmishProductionMenuView.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: UISpecificSkirmishProductionMenuViewDescriptor.NbMaxPlanes
        value: ${planeLimit}
```

## ✅ Practical Advice

- keep expressions readable and boring when possible
- put shared logic in `variables` instead of repeating long expressions everywhere
- prefer clear names over clever expression chains
- treat failed expressions as a signal to simplify the config
