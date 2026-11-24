use crate::{Diagnostic, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scalar {
    pub kind: String,
    pub value: Value,
    pub raw: String,
}

pub fn strip_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut result = String::with_capacity(source.len());
    let mut at = 0;
    let mut quote = None;
    while at < bytes.len() {
        let ch = source[at..].chars().next().unwrap();
        if let Some(delimiter) = quote {
            result.push(ch);
            at += ch.len_utf8();
            if ch == '\\' {
                if let Some(next) = source[at..].chars().next() {
                    result.push(next);
                    at += next.len_utf8();
                }
            } else if ch == delimiter {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            result.push(ch);
            at += 1;
        } else if bytes[at..].starts_with(b"//") {
            at = source[at..].find('\n').map_or(source.len(), |n| at + n);
        } else if bytes[at..].starts_with(b"/*") {
            let end = source[at + 2..]
                .find("*/")
                .map_or(source.len(), |n| at + n + 4);
            for ch in source[at..end].chars() {
                if ch == '\n' {
                    result.push('\n');
                }
            }
            result.push(' ');
            at = end;
        } else {
            result.push(ch);
            at += ch.len_utf8();
        }
    }
    result
}
pub fn parse_scalar(source: &str) -> Scalar {
    let raw = source.trim().to_owned();
    let code = strip_comments(&raw);
    let code = code.trim();
    let (kind, value) = if code.eq_ignore_ascii_case("true") || code.eq_ignore_ascii_case("false") {
        ("bool", json!(code.eq_ignore_ascii_case("true")))
    } else if let Some(value) = unquote(code) {
        ("string", Value::String(value))
    } else if let Ok(value) = code.parse::<i64>() {
        if value.unsigned_abs() <= 9_007_199_254_740_991 {
            ("int", json!(value))
        } else {
            ("raw", Value::String(raw.clone()))
        }
    } else if let Ok(value) = code.parse::<f64>() {
        if value.is_finite() && code.contains(['.', 'e', 'E']) {
            ("float", json!(value))
        } else {
            ("raw", Value::String(raw.clone()))
        }
    } else if code.starts_with("~/")
        || code.starts_with("$/")
        || code.starts_with("GUID:{")
        || token_like(code)
    {
        ("reference", Value::String(code.into()))
    } else {
        ("raw", Value::String(raw.clone()))
    };
    Scalar {
        kind: kind.into(),
        value,
        raw,
    }
}
pub fn unquote(value: &str) -> Option<String> {
    let quote = value.chars().next()?;
    if !matches!(quote, '\'' | '"') || !value.ends_with(quote) || value.len() < 2 {
        return None;
    }
    let mut out = String::new();
    let mut chars = value[1..value.len() - 1].chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == quote {
            return None;
        }
        if ch == '\\'
            && chars
                .peek()
                .is_some_and(|next| matches!(next, '\'' | '"' | '\\'))
        {
            out.push(chars.next().unwrap());
        } else {
            out.push(ch);
        }
    }
    Some(out)
}
pub fn format_value(value: &Value) -> Result<String> {
    match value {
        Value::Object(map) if map.contains_key("$raw") => {
            let raw = &map["$raw"];
            if raw.is_null() || raw.is_array() || raw.is_object() {
                return Err(Diagnostic::new(
                    "ConfigError",
                    crate::messages::text(
                        "ndf.values.format_value.raw_requires_text_a_number_or_a",
                    ),
                    crate::messages::text(
                        "ndf.values.format_value.join_structured_parts_into_an_ndf_string",
                    ),
                ));
            }
            Ok(strip_comments(&crate::templates::stringify(raw)))
        }
        Value::Object(map) if map.contains_key("$string") => {
            map["$string"].as_str().map(quote).ok_or_else(|| {
                Diagnostic::new(
                    "ConfigError",
                    crate::messages::text("ndf.values.format_value.string_requires_text"),
                    crate::messages::text("ndf.values.format_value.supply_a_string_value"),
                )
            })
        }
        Value::Null => Ok("Nil".into()),
        Value::Bool(value) => Ok(if *value { "True" } else { "False" }.into()),
        Value::Number(_) => Ok(crate::templates::stringify(value)),
        Value::String(value) => Ok(
            if value.starts_with('/')
                || value.starts_with("~/")
                || value.starts_with("$/")
                || value.starts_with("GUID:{")
                || token_like(value)
            {
                value.clone()
            } else {
                quote(value)
            },
        ),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(format_value)
                .collect::<Result<Vec<_>>>()?
                .join(", ")
        )),
        Value::Object(values) => Ok(format!(
            "(\n{}\n)",
            values
                .iter()
                .map(|(key, value)| format_value(value).map(|value| format!("    {key} = {value}")))
                .collect::<Result<Vec<_>>>()?
                .join("\n")
        )),
    }
}
pub fn quote(value: &str) -> String {
    let delimiter = if value.contains('\'') && !value.contains('"') {
        '"'
    } else {
        '\''
    };
    let escaped = value
        .replace('\\', "\\\\")
        .replace(delimiter, &format!("\\{delimiter}"));
    format!("{delimiter}{escaped}{delimiter}")
}
fn token_like(value: &str) -> bool {
    let mut chars = value.bytes();
    chars
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && chars.all(|b| b.is_ascii_alphanumeric() || b"_./".contains(&b))
}

pub fn parse_list(source: &str) -> Result<Vec<Scalar>> {
    Ok(super::read::entries(source)?
        .iter()
        .map(|entry| parse_scalar(entry.text))
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scalar_kinds_comments_and_escaping() {
        for (source, kind, value) in [
            ("10 // original", "int", json!(10)),
            ("10.0", "float", json!(10.0)),
            ("True", "bool", json!(true)),
            ("'a\\\\b'", "string", json!("a\\b")),
            ("~/Root/Value", "reference", json!("~/Root/Value")),
        ] {
            let parsed = parse_scalar(source);
            assert_eq!(parsed.kind, kind);
            assert_eq!(parsed.value, value);
        }
        let value = "quote' and slash\\";
        assert_eq!(unquote(&quote(value)).unwrap(), value);
        assert!(format_value(&json!({"$raw":[1]})).is_err());
        assert_eq!(
            strip_comments("'// not comment' /* comment */ X"),
            "'// not comment'   X"
        );
    }

    #[test]
    fn whole_numeric_values_keep_reference_spelling_and_explicit_decimals() {
        for (value, expected) in [
            (json!(0.0), "0"),
            (json!(-0.0), "0"),
            (json!(2.0), "2"),
            (json!(1.25), "1.25"),
        ] {
            assert_eq!(format_value(&value).unwrap(), expected);
            assert_eq!(crate::templates::stringify(&value), expected);
            assert_eq!(format_value(&json!({"$raw":value})).unwrap(), expected);
        }
        assert_eq!(format_value(&json!({"$raw":"2.0"})).unwrap(), "2.0");
        let decimal = crate::templates::resolve(&json!("${decimal(2)}"), &json!({})).unwrap();
        assert_eq!(format_value(&json!({"$raw":decimal})).unwrap(), "2.0");
    }
}
