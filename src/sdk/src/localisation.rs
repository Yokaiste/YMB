pub use crate::core::text::csv_cell as cell;
use regex::Regex;
use std::sync::LazyLock;

static ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^"((?:[^"]|"")*)";"((?:[^"]|"")*)"$"#).unwrap());

pub fn row(line: &str) -> Option<(String, String)> {
    let captures = ROW.captures(line)?;
    Some((
        captures[1].replace("\"\"", "\""),
        captures[2].replace("\"\"", "\""),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_cells_round_trip_quotes_and_escape_line_breaks() {
        let encoded = format!("{};{}", cell("A\"B"), cell("line 1\r\n\"line 2\""));
        assert_eq!(
            row(&encoded),
            Some(("A\"B".into(), "line 1\\n\"line 2\"".into()))
        );
        assert!(row("\"A\";\"B\";\"extra\"").is_none());
    }
}
