use super::*;

pub fn failure(reason: impl Into<String>, suggestion: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new("GeneratorError", reason, suggestion)
}
pub fn ensure(
    condition: bool,
    reason: impl Into<String>,
    suggestion: impl Into<String>,
) -> Result<()> {
    if !condition {
        return Err(failure(reason, suggestion));
    }
    Ok(())
}
pub fn assert_text_present(text: &str, reason: &str, suggestion: &str) -> Result<()> {
    ensure(!text.trim().is_empty(), reason, suggestion)
}
pub fn assert_text_includes(
    text: &str,
    fragment: &str,
    reason: &str,
    suggestion: &str,
) -> Result<()> {
    ensure(text.contains(fragment), reason, suggestion)
}
pub fn assert_text_matches(
    text: &str,
    pattern: &str,
    reason: &str,
    suggestion: &str,
) -> Result<()> {
    let regex = regex::Regex::new(pattern).map_err(|e| {
        failure(
            e.to_string(),
            crate::messages::text("checks.assert_text_matches.supply_a_valid_regular_expression"),
        )
    })?;
    ensure(regex.is_match(text), reason, suggestion)
}
pub fn assert_all<'a>(checks: impl IntoIterator<Item = (&'a str, Result<()>)>) -> Result<()> {
    let errors = checks
        .into_iter()
        .filter_map(|(name, result)| result.err().map(|error| *error.with("check", name)))
        .collect();
    match Diagnostic::group(errors) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
