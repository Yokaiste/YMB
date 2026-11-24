use super::*;
use std::{io::Write, mem::size_of};

const MAX_BYTES: usize = 256 * 1024 * 1024;

pub(crate) struct Budget {
    remaining: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            remaining: MAX_BYTES,
        }
    }
}
impl Budget {
    pub(crate) fn reserve(&mut self, bytes: usize) -> Result<()> {
        if bytes > self.remaining {
            return Err(limit());
        }
        self.remaining -= bytes;
        Ok(())
    }
    pub(crate) fn copy(&mut self, value: &Value) -> Result<Value> {
        self.reserve(value_bytes(value)?)?;
        Ok(value.clone())
    }
    pub(super) fn stringify(&mut self, value: &Value) -> Result<String> {
        match value {
            Value::String(text) => self.reserve(text.len())?,
            Value::Array(_) | Value::Object(_) => {
                serde_json::to_writer(&mut Counter(self), value).map_err(|_| limit())?;
            }
            _ => {
                let text = stringify(value);
                self.reserve(text.len())?;
                return Ok(text);
            }
        }
        Ok(stringify(value))
    }
}
struct Counter<'a>(&'a mut Budget);
impl Write for Counter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .reserve(bytes.len())
            .map_err(|_| std::io::ErrorKind::OutOfMemory)?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn array_bytes(count: usize) -> usize {
    count.saturating_mul(size_of::<Value>())
}
pub(crate) fn map_bytes(count: usize) -> usize {
    // Include map buckets and spare capacity in the storage estimate.
    count.saturating_mul(2 * (size_of::<(String, Value)>() + 2 * size_of::<usize>()))
}
pub(super) fn path_bytes(path: &[String]) -> usize {
    path.iter().fold(
        path.len().saturating_mul(size_of::<String>()) + 2 * size_of::<(Vec<String>, Value)>(),
        |bytes, key| bytes.saturating_add(key.len()),
    )
}
pub(super) fn value_bytes(value: &Value) -> Result<usize> {
    if let Value::String(text) = value {
        return Ok(text.len());
    }
    if !value.is_array() && !value.is_object() {
        return Ok(0);
    }
    let mut bytes = 0usize;
    let mut pending = vec![(value, 0)];
    while let Some((value, depth)) = pending.pop() {
        if depth > 128 {
            return Err(error(crate::messages::text(
                "templates.budget.value_bytes.template_value_nesting_exceeds_the_limit",
            )));
        }
        match value {
            Value::String(text) => bytes = bytes.saturating_add(text.len()),
            Value::Array(values) => {
                bytes = bytes.saturating_add(array_bytes(values.len()));
                if bytes > MAX_BYTES {
                    return Ok(bytes);
                }
                pending.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                bytes = bytes.saturating_add(map_bytes(values.len()));
                for key in values.keys() {
                    bytes = bytes.saturating_add(key.len());
                }
                if bytes > MAX_BYTES {
                    return Ok(bytes);
                }
                pending.extend(values.values().map(|value| (value, depth + 1)));
            }
            _ => (),
        }
    }
    Ok(bytes)
}
fn limit() -> Box<Diagnostic> {
    Diagnostic::new(
        "ConfigError",
        crate::messages::text(
            "templates.budget.limit.template_values_exceed_the_256_mib_resolution",
        ),
        crate::messages::text("templates.budget.limit.use_smaller_variable_values_or_a_generator"),
    )
    .code("E28")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serialized_values_count_utf8_and_escaped_bytes_at_the_limit() {
        let value = json!(["\"\n🦀", 1.0]);
        let expected = "[\"\\\"\\n🦀\",1.0]";
        let mut exact = Budget {
            remaining: expected.len(),
        };
        assert_eq!(exact.stringify(&value).unwrap(), expected);
        assert!(exact.stringify(&json!("x")).is_err());
        let mut short = Budget {
            remaining: expected.len() - 1,
        };
        assert_eq!(
            short.stringify(&value).unwrap_err().code.as_deref(),
            Some("E28")
        );
    }
}
