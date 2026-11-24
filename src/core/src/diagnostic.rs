use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt, path::Path};

pub type Result<T> = std::result::Result<T, Box<Diagnostic>>;

pub fn error_code(category: &str) -> &'static str {
    match category {
        "CommandError" => "E1",
        "ConfigError" => "E4",
        "LayoutError" => "E7",
        "InputError" => "E8",
        "IoError" => "E10",
        "RecoveryError" => "E11",
        "ParserError" => "E14",
        "SelectorError" => "E15",
        "ConflictError" => "E21",
        "GeneratorError" => "E22",
        "CacheError" => "E30",
        "DeploymentError" => "E31",
        "DevelopmentError" => "E32",
        "GeneratorTestError" => "E33",
        "RustRequired" => "E38",
        "RustInstallError" => "E39",
        _ => "E37",
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub category: String,
    pub reason: String,
    pub suggestion: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<Diagnostic>,
    #[serde(flatten)]
    pub context: BTreeMap<String, serde_json::Value>,
}

impl Diagnostic {
    pub fn new(
        category: &str,
        reason: impl Into<String>,
        suggestion: impl Into<String>,
    ) -> Box<Self> {
        Box::new(Self {
            category: category.into(),
            reason: reason.into(),
            suggestion: suggestion.into(),
            path: None,
            code: Some(error_code(category).into()),
            line: None,
            column: None,
            offset: None,
            details: Vec::new(),
            related: Vec::new(),
            context: BTreeMap::new(),
        })
    }
    pub fn at(mut self: Box<Self>, path: impl AsRef<Path>) -> Box<Self> {
        self.path = Some(crate::paths::display(path));
        self
    }
    pub fn with(mut self: Box<Self>, key: &str, value: impl Serialize) -> Box<Self> {
        if let Ok(value) = serde_json::to_value(value) {
            self.context.insert(key.into(), value);
        }
        self
    }
    pub fn code(mut self: Box<Self>, code: &str) -> Box<Self> {
        self.code = Some(code.into());
        self
    }
    pub fn detail(mut self: Box<Self>, value: impl Into<String>) -> Box<Self> {
        self.details.push(value.into());
        self
    }
    pub fn located(mut self: Box<Self>, source: &str, byte: usize) -> Box<Self> {
        let mut byte = byte.min(source.len());
        while !source.is_char_boundary(byte) {
            byte -= 1;
        }
        let prefix = &source[..byte];
        let line_start = prefix.rfind('\n').map_or(0, |n| n + 1);
        self.line = Some(prefix.bytes().filter(|&b| b == b'\n').count() + 1);
        self.column = Some(source[line_start..byte].encode_utf16().count() + 1);
        self.offset = Some(prefix.encode_utf16().count());
        let end = source[byte..].find('\n').map_or(source.len(), |n| byte + n);
        let excerpt = source[line_start..end].trim_end_matches('\r');
        let shown: String = excerpt.chars().take(200).collect();
        self.details.push(shown);
        self.details.push(format!(
            "{}^",
            " ".repeat(self.column.unwrap_or(1).min(200) - 1)
        ));
        self
    }
    pub fn io(path: &Path, error: std::io::Error) -> Box<Self> {
        Self::new(
            "IoError",
            error.to_string(),
            crate::messages::text("diagnostic.io.check_the_path_permissions_and_available_disk"),
        )
        .at(path)
    }
    pub fn group(mut errors: Vec<Diagnostic>) -> Option<Box<Self>> {
        match errors.len() {
            0 => None,
            1 => Some(Box::new(errors.remove(0))),
            _ => {
                let mut error = Self::new(
                    "ConfigError",
                    crate::messages::format(
                        "diagnostic.group.arg0_independent_errors",
                        &[("ARG0", format!("{}", errors.len()))],
                    ),
                    crate::messages::text("diagnostic.group.fix_the_listed_inputs_and_retry"),
                );
                error.related = errors;
                Some(error)
            }
        }
    }
}
impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(path) = &self.path {
            write!(f, "{path}")?;
            if let Some(line) = self.line {
                write!(f, ":{line}")?;
            }
            if let Some(column) = self.column {
                write!(f, ":{column}")?;
            }
            write!(f, ": ")?;
        }
        write!(
            f,
            "[{}] {}: {}",
            self.code
                .as_deref()
                .unwrap_or_else(|| error_code(&self.category)),
            self.category,
            self.reason
        )
    }
}
impl std::error::Error for Diagnostic {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locations_use_utf16_while_input_spans_use_bytes() {
        let source = "Alpha\r\n'\u{1f600}é' = ]";
        let byte = source.find(']').unwrap();
        let error = Diagnostic::new("ParserError", "Invalid value", "Supply a value")
            .at("sample.ndf")
            .located(source, byte);
        assert!(
            error
                .to_string()
                .starts_with("sample.ndf:2:9: [E14] ParserError:")
        );
        assert_eq!(
            (error.line, error.column, error.offset),
            (Some(2), Some(9), Some(15))
        );
        assert!(
            !serde_json::to_value(error)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("related")
        );
    }
}
