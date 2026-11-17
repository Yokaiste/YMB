use crate::{Diagnostic, Result};
use std::{
    collections::{BTreeMap, HashSet},
    ops::Range,
};

#[derive(Clone, Debug)]
pub struct Region<'a> {
    pub id: &'a str,
    pub source_path: Option<&'a str>,
    pub full: Range<usize>,
    pub inner: Range<usize>,
}

pub fn regions(source: &str) -> Result<Vec<Region<'_>>> {
    let mut result = Vec::new();
    let mut active: Option<(&str, usize, usize, Option<&str>)> = None;
    let mut offset = 0;
    let mut ids = HashSet::new();
    for line in source.split_inclusive('\n') {
        let text = line.trim();
        if text.starts_with("// ") {
            if let Some((_, id)) = text.split_once("GENERATED BLOCK START | ") {
                if active.is_some() || !ids.insert(id) {
                    return Err(error(crate::messages::text(
                        "generated.regions.generated_block_ids_must_be_unique_and",
                    )));
                }
                active = Some((id, offset, offset + line.len(), None));
            } else if let Some((_, id)) = text.split_once("GENERATED BLOCK END | ") {
                let Some((owner, start, inner_start, source_path)) = active.take() else {
                    return Err(error(crate::messages::text(
                        "generated.regions.generated_block_end_has_no_matching_start",
                    )));
                };
                if id != owner {
                    return Err(error(crate::messages::text(
                        "generated.regions.generated_block_markers_name_different_owners",
                    )));
                }
                result.push(Region {
                    id: owner,
                    source_path,
                    full: start..offset + line.len(),
                    inner: inner_start..offset,
                });
            } else if let Some(path) = text.strip_prefix("// Source: ")
                && let Some(active) = active.as_mut()
            {
                active.3 = Some(path);
            }
        }
        offset += line.len();
    }
    if active.is_some() {
        return Err(error(crate::messages::text(
            "generated.regions.generated_block_start_has_no_matching_end",
        )));
    }
    Ok(result)
}

pub fn markers(owner: &str) -> Result<(String, String)> {
    if owner.trim().is_empty() || owner.contains(['\r', '\n']) {
        return Err(error(crate::messages::text(
            "generated.markers.a_generated_block_needs_a_nonempty_single",
        )));
    }
    Ok((
        format!("// YMB GENERATED BLOCK START | {owner}"),
        format!("// YMB GENERATED BLOCK END | {owner}"),
    ))
}
pub fn render(
    owner: &str,
    blocks: &[String],
    title: Option<&str>,
    source_path: Option<&str>,
) -> Result<String> {
    let (start, end) = markers(owner)?;
    let mut text = format!("{start}\n");
    if let Some(title) = title {
        for line in title.lines() {
            text.push_str(&format!("// {line}\n"));
        }
    }
    if let Some(path) = source_path {
        if path.contains(['\r', '\n']) {
            return Err(error(crate::messages::text(
                "generated.render.a_generated_block_source_path_must_be",
            )));
        }
        text.push_str(&format!("// Source: {path}\n"));
    }
    text.push('\n');
    for block in blocks {
        text.push_str(block);
        if !block.ends_with('\n') {
            text.push('\n');
        }
    }
    text.push_str(&end);
    text.push('\n');
    Ok(text)
}
pub fn strip(source: &str) -> Result<String> {
    let mut text = String::with_capacity(source.len());
    let mut cursor = 0;
    for region in regions(source)? {
        text.push_str(&source[cursor..region.full.start]);
        cursor = region.full.end;
    }
    text.push_str(&source[cursor..]);
    Ok(text)
}
pub fn upsert(source: &str, generated: &str, owner: &str) -> Result<String> {
    let supplied = regions(generated)?;
    if supplied.len() != 1 || supplied[0].id != owner {
        return Err(error(crate::messages::text(
            "generated.upsert.the_supplied_block_must_declare_exactly_its",
        )));
    }
    let regions = regions(source)?;
    if let Some(region) = regions.iter().find(|region| region.id == owner) {
        let mut text = String::with_capacity(source.len() + generated.len());
        text.push_str(&source[..region.full.start]);
        text.push_str(generated);
        text.push_str(&source[region.full.end..]);
        Ok(text)
    } else {
        Ok(format!(
            "{}{}{}",
            source,
            if source.is_empty() || source.ends_with('\n') {
                ""
            } else {
                "\n"
            },
            generated
        ))
    }
}
pub fn merge_owned(current: &str, next: &str, owners: &[String]) -> Result<Option<String>> {
    merge(current, current, next, owners, Default::default())
}
pub fn merge(
    base: &str,
    current: &str,
    next: &str,
    owners: &[String],
    budget: crate::text::DiffBudget,
) -> Result<Option<String>> {
    let original = regions(base)?;
    let existing = regions(current)?;
    let incoming = regions(next)?;
    let base_plain = strip(base)?;
    let next_plain = strip(next)?;
    let compatible = next_plain == base_plain
        || (!base_plain.ends_with('\n') && next_plain == format!("{base_plain}\n"));
    if !compatible {
        return Ok(None);
    }
    let original: BTreeMap<_, _> = original.iter().map(|r| (r.id, r)).collect();
    let existing_by_id: BTreeMap<_, _> = existing.iter().map(|r| (r.id, r)).collect();
    let incoming_by_id: BTreeMap<_, _> = incoming.iter().map(|r| (r.id, r)).collect();
    let ids: std::collections::BTreeSet<_> = original
        .keys()
        .chain(incoming_by_id.keys())
        .copied()
        .collect();
    let current_plain = strip(current)?;
    let mut edits: BTreeMap<(usize, usize), String> = BTreeMap::new();
    let mut additions = Vec::new();
    for id in ids {
        let before = original.get(id);
        let after = incoming_by_id.get(id);
        let present = existing_by_id.get(id);
        let old_text = before.map(|r| &base[r.full.clone()]);
        let next_text = after.map(|r| &next[r.full.clone()]);
        let current_text = present.map(|r| &current[r.full.clone()]);
        if old_text == next_text {
            continue;
        }
        let owned = owners.iter().any(|owner| {
            id == owner
                || id.starts_with(&format!("{owner} |"))
                || before.is_some_and(|r| r.source_path == Some(owner.as_str()))
                || after.is_some_and(|r| r.source_path == Some(owner.as_str()))
        });
        if !owned {
            return Err(error(crate::messages::format(
                "generated.merge.output_changes_generated_block_id_owned_by",
                &[("ID", id.to_string())],
            )));
        }
        if current_text != old_text && current_text != next_text {
            return Err(error(crate::messages::format(
                "generated.merge.contributors_change_the_same_generated_block_id",
                &[("ID", id.to_string())],
            )));
        }
        if current_text == next_text {
            continue;
        }
        if let Some(present) = present {
            edits.insert(
                (present.full.start, present.full.end),
                next_text.unwrap_or("").to_owned(),
            );
        } else if let Some(after) = after {
            additions.push((after.full.start, *after));
        }
    }
    additions.sort_by_key(|(start, _)| *start);
    let mut plain_changes = None;
    for (_, region) in additions {
        let prefix = strip(&next[..region.full.start])?;
        let offset = prefix.len().min(base_plain.len());
        let at = if offset == base_plain.len() {
            current.len()
        } else {
            let target = if current_plain == base_plain {
                offset
            } else {
                if plain_changes.is_none() {
                    plain_changes =
                        Some(crate::text::changes(&base_plain, &current_plain, budget)?);
                }
                let line = base_plain[..offset].bytes().filter(|b| *b == b'\n').count();
                let mut shifted = line as isize;
                for edit in plain_changes.as_ref().unwrap() {
                    if edit.start < line && line < edit.end {
                        return Err(error(crate::messages::text(
                            "generated.merge.a_generated_region_insertion_overlaps_another_contributor",
                        )));
                    }
                    if edit.end <= line {
                        shifted += edit.replacement.split_inclusive('\n').count() as isize
                            - (edit.end - edit.start) as isize;
                    }
                }
                current_plain
                    .split_inclusive('\n')
                    .take(shifted.max(0) as usize)
                    .map(str::len)
                    .sum()
            };
            let mut left = target;
            let mut cursor = 0;
            let mut location = None;
            for existing in &existing {
                let gap = existing.full.start - cursor;
                if left < gap {
                    location = Some(cursor + left);
                    break;
                }
                left -= gap;
                cursor = existing.full.end;
            }
            location.unwrap_or(cursor + left)
        };
        let text = edits.entry((at, at)).or_default();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&next[region.full.clone()]);
    }
    let mut output = String::with_capacity(current.len() + next.len());
    let mut cursor = 0;
    for ((start, end), mut replacement) in edits {
        if start < cursor || end > current.len() {
            return Err(error(crate::messages::text(
                "generated.merge.generated_region_edits_overlap",
            )));
        }
        output.push_str(&current[cursor..start]);
        if start == end
            && !replacement.is_empty()
            && start > 0
            && current.as_bytes()[start - 1] != b'\n'
        {
            replacement.insert(0, '\n');
        }
        output.push_str(&replacement);
        cursor = end;
    }
    output.push_str(&current[cursor..]);
    Ok(Some(output))
}
fn error(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConflictError",
        reason,
        crate::messages::text("generated.error.keep_stable_generated_block_owners_and_preserve"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upserts_literal_dollar_text_and_keeps_neighbors() {
        let a = render("a", &["A is '$&'".into()], None, Some("owner-a")).unwrap();
        let b = render("b", &["B is 1".into()], None, Some("owner-b")).unwrap();
        let source = format!("Header is 0\n{a}{b}");
        let replacement = render("a", &["A is '$after'".into()], None, Some("owner-a")).unwrap();
        let next = upsert(&source, &replacement, "a").unwrap();
        assert!(next.contains("$after"));
        assert!(next.contains(&b));
        assert!(
            merge_owned(&source, &next, &["owner-a".into()])
                .unwrap()
                .is_some()
        );
        assert!(merge_owned(&source, &next, &["owner-b".into()]).is_err());
    }
    #[test]
    fn malformed_and_duplicate_regions_fail_and_crlf_has_no_bare_carriage() {
        let text = render("a", &["A is 1".into()], None, None)
            .unwrap()
            .replace('\n', "\r\n");
        assert_eq!(
            strip(&format!("before\r\n{text}after\r\n")).unwrap(),
            "before\r\nafter\r\n"
        );
        assert!(regions(&format!("{text}{text}")).is_err());
        assert!(regions("// YMB GENERATED BLOCK START | a\n").is_err());
    }
}
