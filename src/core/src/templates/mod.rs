use crate::{Diagnostic, Result};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

fn raw_member<'a>(mut value: &'a Value, path: &[String]) -> Option<&'a Value> {
    for segment in path {
        value = match value {
            Value::Object(map) => map.get(segment)?,
            Value::Array(array) => array.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(value)
}
fn member_key(value: &Value) -> Result<String> {
    match value {
        Value::String(v) => Ok(v.clone()),
        Value::Number(n) if n.as_f64().is_some_and(|v| v.fract() == 0.0) => Ok(stringify(value)),
        _ => Err(error(crate::messages::text(
            "templates.mod.member_key.a_member_key_must_be_a_string",
        ))),
    }
}
fn read_member(value: &Value, key: &Value, budget: &mut Budget) -> Result<Value> {
    match value {
        Value::Object(map) => {
            budget.reserve(value_bytes(key)?)?;
            budget.copy(map.get(&member_key(key)?).ok_or_else(|| {
                error(crate::messages::text(
                    "templates.mod.read_member.object_has_no_requested_member",
                ))
            })?)
        }
        Value::Array(values) => values
            .get(integer(key, 0)? as usize)
            .ok_or_else(|| {
                error(crate::messages::text(
                    "templates.mod.read_member.array_index_is_out_of_range",
                ))
            })
            .and_then(|value| budget.copy(value)),
        Value::String(value) => {
            let unit = value
                .encode_utf16()
                .nth(integer(key, 0)? as usize)
                .ok_or_else(|| {
                    error(crate::messages::text(
                        "templates.mod.read_member.string_index_is_out_of_range",
                    ))
                })?;
            let ch = char::from_u32(unit as u32).ok_or_else(|| {
                error(crate::messages::text(
                    "templates.mod.read_member.string_index_splits_a_unicode_surrogate_pair",
                ))
            })?;
            budget.reserve(ch.len_utf8())?;
            Ok(Value::String(ch.to_string()))
        }
        _ => Err(error(crate::messages::text(
            "templates.mod.read_member.member_access_requires_an_object_array_or",
        ))),
    }
}
pub fn resolve(value: &Value, variables: &Value) -> Result<Value> {
    Resolver::new(variables).resolve(value)
}
pub fn merge(base: &mut Value, next: &Value) {
    if let (Value::Object(base), Value::Object(next)) = (&mut *base, next) {
        for (key, value) in next {
            match base.get_mut(key) {
                Some(previous) => merge(previous, value),
                None => {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
    } else {
        *base = next.clone();
    }
}
pub fn stringify(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Number(number) if number.is_f64() => {
            let value = number.as_f64().unwrap();
            if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
                (value as i64).to_string()
            } else {
                number.to_string()
            }
        }
        _ => value.to_string(),
    }
}
pub fn numeric(value: &Value) -> Result<f64> {
    value.as_f64().filter(|v| v.is_finite()).ok_or_else(|| {
        error(crate::messages::text(
            "templates.mod.numeric.expected_a_finite_number",
        ))
    })
}
pub(crate) fn round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}
pub fn number(value: f64) -> Result<Value> {
    if !value.is_finite() {
        return Err(error(crate::messages::text(
            "templates.mod.number.arithmetic_produced_a_non_finite_number",
        )));
    }
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Ok(json!(value as i64))
    } else {
        Ok(json!(value))
    }
}
fn integer(value: &Value, minimum: i64) -> Result<i64> {
    let value = numeric(value)?;
    if value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0 || value < minimum as f64 {
        return Err(error(crate::messages::text(
            "templates.mod.integer.expected_an_integer_within_the_supported_range",
        )));
    }
    Ok(value as i64)
}
fn array(value: &Value) -> Result<&[Value]> {
    value.as_array().map(Vec::as_slice).ok_or_else(|| {
        error(crate::messages::text(
            "templates.mod.array.expected_an_array",
        ))
    })
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|w| equal(v, w)))
        }
        _ => a == b,
    }
}
fn compare(a: &Value, b: &Value) -> Result<Option<std::cmp::Ordering>> {
    match (a, b) {
        (Value::String(a), Value::String(b)) => Ok(Some(a.encode_utf16().cmp(b.encode_utf16()))),
        _ if (a.is_number() || a.is_string()) && (b.is_number() || b.is_string()) => {
            let n = |v: &Value| {
                v.as_f64().or_else(|| {
                    v.as_str().and_then(|s| {
                        if s.trim().is_empty() {
                            Some(0.0)
                        } else {
                            s.parse().ok()
                        }
                    })
                })
            };
            Ok(n(a).zip(n(b)).and_then(|(a, b)| a.partial_cmp(&b)))
        }
        _ => Err(error(crate::messages::text(
            "templates.mod.compare.comparison_requires_strings_or_numbers",
        ))),
    }
}
fn is_name(value: &str) -> bool {
    let mut b = value.bytes();
    b.next()
        .is_some_and(|v| v.is_ascii_alphabetic() || b"_$".contains(&v))
        && b.all(|v| v.is_ascii_alphanumeric() || b"_$".contains(&v))
}
fn helper_name(name: &str) -> bool {
    matches!(
        name,
        "csv"
            | "round"
            | "decimal"
            | "join"
            | "repeat"
            | "len"
            | "concat"
            | "pluck"
            | "numbers"
            | "integers"
            | "nonNegativeNumbers"
            | "range"
            | "sum"
            | "cartesian"
    )
}
fn error(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConfigError",
        reason,
        crate::messages::text("templates.mod.error.check_the_variable_names_value_types_and"),
    )
}

pub(crate) mod budget;
mod expression;
mod helpers;
mod resolver;
use budget::{Budget, array_bytes, map_bytes, path_bytes, value_bytes};
use expression::{Expr, Parser};
use helpers::helper;
pub use resolver::Resolver;
pub(crate) use resolver::resolve_in_budget;
#[cfg(test)]
mod tests;
