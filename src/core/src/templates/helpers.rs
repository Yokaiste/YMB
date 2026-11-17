use super::*;

pub(super) fn helper(name: &str, args: &[Value], budget: &mut Budget) -> Result<Value> {
    let get = |i| {
        args.get(i).ok_or_else(|| {
            error(crate::messages::format(
                "templates.helpers.helper.missing_argument_arg0_to_name",
                &[("ARG0", format!("{}", i + 1)), ("NAME", name.to_string())],
            ))
        })
    };
    match name {
        "csv" => {
            let value = budget.stringify(get(0)?)?;
            let escaped = value.len().saturating_add(
                value
                    .bytes()
                    .filter(|b| matches!(b, b'"' | b'\r' | b'\n'))
                    .count(),
            );
            budget.reserve(escaped.saturating_mul(3).saturating_add(2))?;
            Ok(Value::String(crate::text::csv_cell(&value)))
        }
        "round" => number(round(numeric(get(0)?)?)),
        "decimal" => {
            let value = number(numeric(get(0)?)?)?.to_string();
            budget.reserve(value.len())?;
            Ok(Value::String(if value.contains(['.', 'e', 'E']) {
                value
            } else {
                budget.reserve(value.len() + 2)?;
                format!("{value}.0")
            }))
        }
        "len" => number(match get(0)? {
            Value::String(v) => v.encode_utf16().count(),
            Value::Array(v) => v.len(),
            Value::Object(v) => v.len(),
            _ => {
                return Err(error(crate::messages::text(
                    "templates.helpers.helper.len_expects_a_string_array_or_object",
                )));
            }
        } as f64),
        "join" => {
            let separator = args
                .get(1)
                .map_or_else(|| Ok(",".into()), |value| budget.stringify(value))?;
            let values = array(get(0)?)?;
            budget.reserve(values.len().saturating_mul(std::mem::size_of::<String>()))?;
            let strings = values
                .iter()
                .map(|value| budget.stringify(value))
                .collect::<Result<Vec<_>>>()?;
            let bytes = strings.iter().fold(
                separator
                    .len()
                    .saturating_mul(strings.len().saturating_sub(1)),
                |bytes, value| bytes.saturating_add(value.len()),
            );
            budget.reserve(bytes)?;
            Ok(Value::String(strings.join(&separator)))
        }
        "repeat" => {
            let count = integer(get(1)?, 0)? as usize;
            if count == 0 {
                return Ok(Value::Array(Vec::new()));
            }
            budget.reserve(
                array_bytes(count).saturating_add(value_bytes(get(0)?)?.saturating_mul(count)),
            )?;
            Ok(Value::Array(vec![get(0)?.clone(); count]))
        }
        "concat" => {
            let bytes = args.iter().try_fold(0usize, |bytes, value| {
                array(value)?;
                Ok::<_, Box<Diagnostic>>(bytes.saturating_add(value_bytes(value)?))
            })?;
            budget.reserve(bytes)?;
            Ok(Value::Array(
                args.iter()
                    .flat_map(|a| a.as_array().unwrap().iter().cloned())
                    .collect(),
            ))
        }
        "pluck" => {
            let key = get(1)?.as_str().ok_or_else(|| {
                error(crate::messages::text(
                    "templates.helpers.helper.pluck_requires_a_field_name",
                ))
            })?;
            let values = array(get(0)?)?;
            budget.reserve(array_bytes(values.len()))?;
            let mut out = Vec::with_capacity(values.len());
            for value in values {
                let field = value.as_object().and_then(|m| m.get(key)).ok_or_else(|| {
                    error(crate::messages::format(
                        "templates.helpers.helper.pluck_entry_has_no_key_field",
                        &[("KEY", key.to_string())],
                    ))
                })?;
                out.push(budget.copy(field)?);
            }
            Ok(Value::Array(out))
        }
        "numbers" | "integers" | "nonNegativeNumbers" => {
            let mut values = Vec::new();
            for value in array(get(0)?)? {
                let n = numeric(value)?;
                if name == "numbers"
                    || (name == "integers" && n.fract() == 0.0)
                    || (name == "nonNegativeNumbers" && n >= 0.0)
                {
                    budget.reserve(2 * std::mem::size_of::<Value>())?;
                    values.push(number(n)?);
                }
            }
            Ok(Value::Array(values))
        }
        "sum" => number(
            array(get(0)?)?
                .iter()
                .try_fold(0.0, |n, v| Ok::<_, Box<Diagnostic>>(n + numeric(v)?))?,
        ),
        "range" => {
            if !(1..=3).contains(&args.len()) {
                return Err(error(crate::messages::text(
                    "templates.helpers.helper.range_expects_one_two_or_three_arguments",
                )));
            }
            let (start, end, step) = if args.len() == 1 {
                (0, integer(get(0)?, i64::MIN)?, 1)
            } else {
                (
                    integer(get(0)?, i64::MIN)?,
                    integer(get(1)?, i64::MIN)?,
                    if args.len() == 3 {
                        integer(get(2)?, i64::MIN)?
                    } else {
                        1
                    },
                )
            };
            if step == 0 {
                return Err(error(crate::messages::text(
                    "templates.helpers.helper.range_step_cannot_be_zero",
                )));
            }
            let distance = if step > 0 { end - start } else { start - end };
            let count = (distance.max(0) as u64).div_ceil(step.unsigned_abs()) as usize;
            budget.reserve(array_bytes(count))?;
            Ok(Value::Array(
                (0..count).map(|i| json!(start + i as i64 * step)).collect(),
            ))
        }
        "cartesian" => {
            let mut convert = |v: &Value| -> Result<Vec<Value>> {
                if let Value::Array(v) = v {
                    let bytes = v.iter().try_fold(array_bytes(v.len()), |bytes, value| {
                        Ok::<_, Box<Diagnostic>>(bytes.saturating_add(value_bytes(value)?))
                    })?;
                    budget.reserve(bytes)?;
                    Ok(v.clone())
                } else {
                    let count = integer(v, 0)? as usize;
                    budget.reserve(array_bytes(count))?;
                    Ok((0..count).map(|i| json!(i)).collect())
                }
            };
            let left = convert(get(0)?)?;
            let right = convert(get(1)?)?;
            let count = left.len().saturating_mul(right.len());
            let template = args.get(2).map_or_else(
                || Ok("[{left}, {right}]".into()),
                |value| budget.stringify(value),
            )?;
            static PLACEHOLDERS: std::sync::LazyLock<regex::Regex> =
                std::sync::LazyLock::new(|| {
                    regex::Regex::new(r"\{(left|right|leftIndex|rightIndex|index)\}").unwrap()
                });
            let slot = |name: &str| match name {
                "left" => 0,
                "right" => 1,
                "leftIndex" => 2,
                "rightIndex" => 3,
                _ => 4,
            };
            let mut occurrences = [0usize; 5];
            let mut literal_bytes = template.len();
            for captures in PLACEHOLDERS.captures_iter(&template) {
                occurrences[slot(&captures[1])] += 1;
                literal_bytes -= captures.get(0).unwrap().len();
            }
            budget.reserve(array_bytes(count))?;
            let mut out = Vec::with_capacity(count);
            for (li, l) in left.iter().enumerate() {
                for (ri, r) in right.iter().enumerate() {
                    let mut values: [String; 5] = Default::default();
                    for (index, count) in occurrences.iter().enumerate() {
                        if *count == 0 {
                            continue;
                        }
                        values[index] = match index {
                            0 => budget.stringify(l)?,
                            1 => budget.stringify(r)?,
                            2 => li.to_string(),
                            3 => ri.to_string(),
                            _ => out.len().to_string(),
                        };
                        if index >= 2 {
                            budget.reserve(values[index].len())?;
                        }
                    }
                    let bytes = occurrences.iter().zip(&values).fold(
                        literal_bytes,
                        |bytes, (count, value)| {
                            bytes.saturating_add(count.saturating_mul(value.len()))
                        },
                    );
                    budget.reserve(bytes)?;
                    let rendered = PLACEHOLDERS
                        .replace_all(&template, |captures: &regex::Captures<'_>| {
                            values[slot(&captures[1])].as_str()
                        });
                    out.push(Value::String(rendered.into_owned()));
                }
            }
            Ok(Value::Array(out))
        }
        _ => Err(error(crate::messages::format(
            "templates.helpers.helper.unknown_helper_name",
            &[("NAME", name.to_string())],
        ))),
    }
}
