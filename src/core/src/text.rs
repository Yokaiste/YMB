use crate::{Diagnostic, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug)]
pub struct DiffBudget {
    pub max_work: u64,
    pub max_side_bytes: usize,
    pub max_combined_bytes: usize,
}
impl Default for DiffBudget {
    fn default() -> Self {
        Self {
            max_work: 50_000_000,
            max_side_bytes: 4_000_000,
            max_combined_bytes: 6_000_000,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEdit {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

pub fn changes(before: &str, after: &str, budget: DiffBudget) -> Result<Vec<TextEdit>> {
    if before == after {
        return Ok(Vec::new());
    }
    let common = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let prefix_byte = before.as_bytes()[..common]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |at| at + 1);
    let prefix = before.as_bytes()[..prefix_byte]
        .iter()
        .filter(|b| **b == b'\n')
        .count();
    let common_suffix = before.as_bytes()[prefix_byte..]
        .iter()
        .rev()
        .zip(after.as_bytes()[prefix_byte..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let suffix_start = before.len() - common_suffix;
    let suffix = if suffix_start == 0 || before.as_bytes().get(suffix_start - 1) == Some(&b'\n') {
        common_suffix
    } else {
        before.as_bytes()[suffix_start..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(0, |at| common_suffix - at - 1)
    };
    let left = &before[prefix_byte..before.len() - suffix];
    let right = &after[prefix_byte..after.len() - suffix];
    if left.len().max(right.len()) > budget.max_side_bytes
        || left.len().saturating_add(right.len()) > budget.max_combined_bytes
    {
        return Err(budget_error());
    }
    let a: Vec<_> = left.split_inclusive('\n').collect();
    let b: Vec<_> = right.split_inclusive('\n').collect();
    if (a.len() as u64).saturating_mul(b.len() as u64) > budget.max_work {
        return Err(budget_error());
    }
    let mut matches = Vec::new();
    lcs(&a, &b, prefix, prefix, &mut matches);
    matches.push((prefix + a.len(), prefix + b.len()));
    let mut edits = Vec::new();
    let mut ai = prefix;
    let mut bi = prefix;
    for (a, b_at) in matches {
        if ai != a || bi != b_at {
            edits.push(TextEdit {
                start: ai,
                end: a,
                replacement: b[bi - prefix..b_at - prefix].concat(),
            });
        }
        ai = a + 1;
        bi = b_at + 1;
    }
    Ok(edits)
}
fn row(left: &[&str], right: &[&str], reverse: bool) -> Vec<usize> {
    let mut previous = vec![0; right.len() + 1];
    let mut current = vec![0; right.len() + 1];
    for i in 0..left.len() {
        let a = left[if reverse { left.len() - 1 - i } else { i }];
        for j in 0..right.len() {
            let b = right[if reverse { right.len() - 1 - j } else { j }];
            current[j + 1] = if a == b {
                previous[j] + 1
            } else {
                previous[j + 1].max(current[j])
            };
        }
        std::mem::swap(&mut current, &mut previous);
        current.fill(0);
    }
    previous
}
fn lcs(left: &[&str], right: &[&str], a: usize, b: usize, out: &mut Vec<(usize, usize)>) {
    if left.is_empty() || right.is_empty() {
        return;
    }
    if left.len() == 1 {
        if let Some(index) = right.iter().position(|line| *line == left[0]) {
            out.push((a, b + index));
        }
        return;
    }
    let middle = left.len() / 2;
    let forward = row(&left[..middle], right, false);
    let backward = row(&left[middle..], right, true);
    let split = (0..=right.len())
        .max_by_key(|index| forward[*index] + backward[right.len() - *index])
        .unwrap();
    drop(forward);
    drop(backward);
    lcs(&left[..middle], &right[..split], a, b, out);
    lcs(&left[middle..], &right[split..], a + middle, b + split, out);
}
pub fn apply(before: &str, edits: &[TextEdit]) -> Result<String> {
    let lines: Vec<_> = before.split_inclusive('\n').collect();
    let mut output = String::with_capacity(before.len());
    let mut cursor = 0;
    for edit in edits {
        if edit.start < cursor || edit.start > edit.end || edit.end > lines.len() {
            return Err(conflict(crate::messages::text(
                "text.apply.text_changes_overlap_or_use_an_invalid",
            )));
        }
        for line in &lines[cursor..edit.start] {
            output.push_str(line);
        }
        output.push_str(&edit.replacement);
        cursor = edit.end;
    }
    for line in &lines[cursor..] {
        output.push_str(line);
    }
    Ok(output)
}
pub fn merge(before: &str, contributions: &[&str], budget: DiffBudget) -> Result<String> {
    let mut combined: Vec<TextEdit> = Vec::new();
    for contribution in contributions {
        for edit in changes(before, contribution, budget)? {
            let mut inherited = false;
            for existing in &mut combined {
                if *existing == edit {
                    inherited = true;
                    break;
                }
                if overlaps(existing, &edit) {
                    if existing.start == existing.end
                        && edit.start == edit.end
                        && existing.start == edit.start
                    {
                        let a: Vec<_> = existing.replacement.split_inclusive('\n').collect();
                        let b: Vec<_> = edit.replacement.split_inclusive('\n').collect();
                        if a.starts_with(&b) || b.starts_with(&a) {
                            if b.len() > a.len() {
                                *existing = edit.clone();
                            }
                            inherited = true;
                            break;
                        }
                    }
                    return Err(conflict(crate::messages::format(
                        "text.merge.contributors_change_overlapping_lines_near_arg0",
                        &[("ARG0", format!("{}", edit.start + 1))],
                    )));
                }
            }
            if !inherited {
                combined.push(edit);
            }
        }
    }
    combined.sort_by_key(|edit| (edit.start, edit.end));
    apply(before, &combined)
}
fn overlaps(a: &TextEdit, b: &TextEdit) -> bool {
    match (a.start == a.end, b.start == b.end) {
        (true, true) => a.start == b.start,
        (true, false) => a.start > b.start && a.start < b.end,
        (false, true) => b.start > a.start && b.start < a.end,
        _ => a.start.max(b.start) < a.end.min(b.end),
    }
}
fn budget_error() -> Box<Diagnostic> {
    Diagnostic::new(
        "ConflictError",
        crate::messages::text("text.budget_error.text_comparison_exceeds_its_configured_work_or"),
        crate::messages::text("text.budget_error.use_explicit_layering_or_adjust_the_named"),
    )
    .code("E27")
}
fn conflict(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConflictError",
        reason,
        crate::messages::text("text.conflict.keep_independent_edits_disjoint_or_explicitly_order"),
    )
}

pub fn escape_regex(value: &str) -> String {
    regex::escape(value)
}

pub fn csv_cell(value: &str) -> String {
    // WARNO localisation stores line breaks as literal \n inside a single CSV row.
    format!(
        "\"{}\"",
        value
            .replace("\r\n", "\\n")
            .replace(['\r', '\n'], "\\n")
            .replace('"', "\"\"")
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn line_diff_reconstructs_varied_repeated_inputs() {
        for seed in 0..50 {
            let base = (0..30)
                .map(|i| format!("{}\r\n", (i * 7 + seed) % 9))
                .collect::<String>();
            let next = base.replacen("2\r\n", "other\r\nextra\r\n", 1);
            let edits = changes(&base, &next, DiffBudget::default()).unwrap();
            assert_eq!(apply(&base, &edits).unwrap(), next);
        }
        let base = "one\rcarriage\nnext";
        let next = "one\rcarriage\nchanged";
        assert_eq!(
            apply(base, &changes(base, next, DiffBudget::default()).unwrap()).unwrap(),
            next
        );
    }
    #[test]
    fn merges_disjoint_and_inherited_edits_but_rejects_conflicts() {
        let base = "A\nB\nC\n";
        assert_eq!(
            merge(base, &["X\nB\nC\n", "A\nB\nY\n"], DiffBudget::default()).unwrap(),
            "X\nB\nY\n"
        );
        assert!(merge(base, &["X\nB\nC\n", "Y\nB\nC\n"], DiffBudget::default()).is_err());
        assert_eq!(
            merge(
                base,
                &["A\nX\nB\nC\n", "A\nX\nY\nB\nC\n"],
                DiffBudget::default()
            )
            .unwrap(),
            "A\nX\nY\nB\nC\n"
        );
    }
    #[test]
    fn budgets_are_finite_and_one_sided_insertions_skip_quadratic_work() {
        let budget = DiffBudget {
            max_work: 1,
            max_side_bytes: 10000,
            max_combined_bytes: 20000,
        };
        assert!(changes("a\nb\n", "x\ny\n", budget).is_err());
        assert!(changes("a\n", &format!("{}a\n", "x\n".repeat(1000)), budget).is_ok());
    }
}
