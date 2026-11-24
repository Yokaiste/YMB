use crate::{Diagnostic, Result, paths};
use regex::Regex;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
};

static FIELDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@@|@([A-Z][A-Z0-9_]*)@").unwrap());

pub fn render(source: &str, values: &[(&str, String)]) -> std::result::Result<String, String> {
    let mut missing = None;
    let rendered = FIELDS
        .replace_all(source, |matched: &regex::Captures<'_>| {
            let Some(key) = matched.get(1) else {
                return "@".to_owned();
            };
            match values.iter().find(|(name, _)| *name == key.as_str()) {
                Some((_, value)) => value.clone(),
                None => {
                    missing = Some(key.as_str().to_owned());
                    matched[0].to_owned()
                }
            }
        })
        .into_owned();
    missing.map_or(Ok(rendered), Err)
}

pub struct Catalog(Value);

impl Catalog {
    pub fn new(source: &str) -> Self {
        Self(serde_json::from_str(source).expect("valid message catalog"))
    }

    pub fn text(&self, key: &str) -> &str {
        key.split('.')
            .try_fold(&self.0, |value, part| value.get(part))
            .and_then(Value::as_str)
            .expect("registered message key")
    }

    pub fn format(&self, key: &str, values: &[(&str, String)]) -> String {
        render(self.text(key), values).expect("message arguments match its placeholders")
    }

    pub fn quantity(&self, key: &str, count: usize, values: &[(&str, String)]) -> String {
        let form = if count == 1 { "one" } else { "other" };
        let mut values = values.to_vec();
        values.push(("COUNT", count.to_string()));
        self.format(&format!("{key}.{form}"), &values)
    }
}

pub fn directory(preferred: &Path) -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|error| Diagnostic::io(preferred, error))?;
    for root in std::iter::once(preferred).chain(executable.ancestors()) {
        let resource = root.join("resources");
        paths::assert_no_links(root, &resource)?;
        if resource.is_dir() {
            return Ok(resource);
        }
    }
    Err(Diagnostic::new(
        "LayoutError",
        crate::messages::text("resources.directory.ymb_s_resources_folder_is_missing"),
        crate::messages::text("resources.directory.restore_the_resources_folder_from_the_ymb"),
    )
    .at(preferred.join("resources")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutions_preserve_inserted_tokens_and_support_reordered_messages() {
        let values = [("NAME", "@OTHER@".into()), ("COUNT", "3".into())];
        assert_eq!(
            render("@COUNT@: @NAME@; @@NAME@@", &values).unwrap(),
            "3: @OTHER@; @NAME@"
        );
        assert_eq!(render("@UNKNOWN@", &values).unwrap_err(), "UNKNOWN");
        let english = Catalog::new(r#"{"sample":{"line":"@NAME@: @COUNT@"}}"#);
        let translated = Catalog::new(r#"{"sample":{"line":"@COUNT@ / @NAME@"}}"#);
        assert_eq!(english.format("sample.line", &values), "@OTHER@: 3");
        assert_eq!(translated.format("sample.line", &values), "3 / @OTHER@");
        let counts = Catalog::new(
            r#"{"files":{"one":"@COUNT@ file for @NAME@","other":"@COUNT@ files for @NAME@"}}"#,
        );
        for count in [0, 1, 2] {
            assert_eq!(
                counts.quantity("files", count, &[("NAME", "a mod".into())]),
                format!(
                    "{count} {} for a mod",
                    if count == 1 { "file" } else { "files" }
                ),
            );
        }
    }
}
