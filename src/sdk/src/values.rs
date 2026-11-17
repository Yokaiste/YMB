use crate::{Result, failure};
use serde_json::{Map, Value};
pub fn record<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        failure(
            crate::messages::format(
                "values.record.label_must_be_an_object",
                &[("LABEL", label.to_string())],
            ),
            crate::messages::text("common.shared.correct_this_configuration_value"),
        )
    })
}
pub fn string<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value.as_str().ok_or_else(|| {
        failure(
            crate::messages::format(
                "values.string.label_must_be_text",
                &[("LABEL", label.to_string())],
            ),
            crate::messages::text("common.shared.correct_this_configuration_value"),
        )
    })
}
pub fn optional_string<'a>(value: Option<&'a Value>, label: &str) -> Result<Option<&'a str>> {
    value.map(|value| string(value, label)).transpose()
}
pub fn boolean(value: &Value, label: &str) -> Result<bool> {
    value.as_bool().ok_or_else(|| {
        failure(
            crate::messages::format(
                "values.boolean.label_must_be_true_or_false",
                &[("LABEL", label.to_string())],
            ),
            crate::messages::text("common.shared.correct_this_configuration_value"),
        )
    })
}
pub fn string_array<'a>(value: &'a Value, label: &str) -> Result<Vec<&'a str>> {
    value
        .as_array()
        .ok_or_else(|| {
            failure(
                crate::messages::format(
                    "values.string_array.label_must_be_a_list",
                    &[("LABEL", label.to_string())],
                ),
                crate::messages::text("values.string_array.supply_a_list_of_strings"),
            )
        })?
        .iter()
        .map(|value| string(value, label))
        .collect()
}
pub fn one_of<'a>(value: &'a Value, label: &str, allowed: &[&str]) -> Result<&'a str> {
    let value = string(value, label)?;
    if !allowed.contains(&value) {
        return Err(failure(
            crate::messages::format(
                "values.one_of.label_must_be_one_of_arg1",
                &[
                    ("LABEL", label.to_string()),
                    ("ARG1", allowed.join(", ").to_string()),
                ],
            ),
            crate::messages::text("values.one_of.choose_a_supported_value"),
        ));
    }
    Ok(value)
}
pub fn positive_integer(value: &Value, label: &str) -> Result<u64> {
    let integer = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        .or_else(|| {
            let n = value
                .as_f64()
                .or_else(|| value.as_str().and_then(|s| s.trim().parse::<f64>().ok()))?;
            // Plain integer text was parsed exactly above; keep float coercion from rounding large text.
            (n.is_finite()
                && n > 0.0
                && n.fract() == 0.0
                && n < u64::MAX as f64
                && (value.as_str().is_none() || n <= 9_007_199_254_740_991.0))
                .then_some(n as u64)
        });
    integer.filter(|n| *n > 0).ok_or_else(|| {
        failure(
            crate::messages::format(
                "values.positive_integer.label_must_be_a_positive_integer_within",
                &[("LABEL", label.to_string())],
            ),
            crate::messages::text("values.positive_integer.supply_a_whole_number_between_1_and"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn positive_integer_accepts_numeric_text_and_rejects_invalid_neighbors() {
        for value in [
            serde_json::json!(3),
            serde_json::json!("3"),
            serde_json::json!("3e0"),
            serde_json::json!(3.0),
        ] {
            assert_eq!(positive_integer(&value, "count").unwrap(), 3);
        }
        for value in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(""),
            serde_json::json!(true),
            serde_json::json!("1.5"),
            serde_json::json!("18446744073709551616"),
            serde_json::json!(u64::MAX as f64),
            serde_json::json!("9007199254740992.5"),
        ] {
            assert!(positive_integer(&value, "count").is_err());
        }
        for expected in [9_007_199_254_740_992u64, u64::MAX] {
            for value in [
                serde_json::json!(expected),
                serde_json::json!(expected.to_string()),
            ] {
                assert_eq!(positive_integer(&value, "count").unwrap(), expected);
            }
        }
    }
}
