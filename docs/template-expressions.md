# Template Expressions

Templates work in target paths, operation values, nested changes, replace paths and supported text, and script paths.

An exact template preserves its resolved type:

```yaml
value: ${frontArmor}
```

A template embedded in text produces a string:

```yaml
value: 'Armor-${frontArmor}'
```

## Built-in values

| Variable           | Value                                       |
| ------------------ | ------------------------------------------- |
| `modRootName`      | WARNO mod folder name                       |
| `modId`            | Source-mod ID                               |
| `modName`          | Source-mod name                             |
| `modDescription`   | Source-mod description                      |
| `patchId`          | Patch ID, or empty outside a patch          |
| `patchName`        | Patch name, or empty outside a patch        |
| `patchDescription` | Patch description, or empty outside a patch |

Patch variables override source-mod variables.

## Values and operators

Expressions support numbers, quoted strings, booleans, `null`, arrays, and object or array member access.

```yaml
variables:
  stats:
    frontArmor: 7
    bonuses: [2, 4]
  finalArmor: ${stats.frontArmor + stats.bonuses[1]}
  label: "${finalArmor >= 10 ? 'Heavy' : 'Standard'}"
```

Supported operators:

- arithmetic: `+`, `-`, `*`, `/`, `%`
- comparison: `<`, `<=`, `>`, `>=`, `==`, `!=`
- logical: `!`, `&&`, `||`
- conditional: `condition ? whenTrue : whenFalse`
- grouping: `( ... )`

`+` concatenates when either side is a string. Logical and conditional operations short-circuit. Invalid member access and division or modulo by zero are errors.

## Helpers

| Helper                                                   | Result                                             |
| -------------------------------------------------------- | -------------------------------------------------- |
| `join(array, separator = ',')`                           | Join entries into text                             |
| `repeat(value, count)`                                   | Repeat a value into an array                       |
| `len(value)`                                             | String or array length, or object key count        |
| `concat(...arrays)`                                      | Combine arrays                                     |
| `numbers(array)`                                         | Require finite numeric entries                     |
| `integers(array)`                                        | Keep integer entries                               |
| `nonNegativeNumbers(array)`                              | Keep numeric entries greater than or equal to zero |
| `range(end)`                                             | Generate values from zero to `end - 1`             |
| `range(start, end, step = 1)`                            | Generate a stepped range                           |
| `sum(array)`                                             | Add numeric entries                                |
| `cartesian(left, right, template = '[{left}, {right}]')` | Render every left/right combination                |

Generating helpers reject requests larger than their protected limit.

```yaml
variables:
  slotCount: 5
  slotIndexes: ${range(slotCount)}
  slotValues: ${join(repeat(1, slotCount), ', ')}
  totalBonus: ${sum([2, 4, 6])}
```

## String conversion

Embedded templates convert values as follows:

- strings remain unchanged
- numbers and booleans use their normal text form
- arrays and objects become JSON text
- `null` and undefined values become empty text

For exact templates, the original array, object, number, boolean, or null value is retained.

## Errors

YMB reports unknown variables, invalid operators or helper arguments, missing properties, out-of-range indexes, circular variable references, and excessive generated collections. Fix the source expression; templates do not silently substitute invalid results.
