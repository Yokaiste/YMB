use super::*;
use std::collections::BTreeSet;

pub fn matches(
    text: &str,
    name: Option<&str>,
    type_name: &str,
    matcher: &BulkMatch,
) -> Result<bool> {
    matches_tracked(text, name, type_name, matcher, None)
}
pub(super) fn matches_tracked(
    text: &str,
    name: Option<&str>,
    type_name: &str,
    matcher: &BulkMatch,
    mut unreached: Option<&mut Vec<BTreeSet<String>>>,
) -> Result<bool> {
    let mut result = matcher.mode == "all";
    for (index, condition) in matcher.conditions.iter().enumerate() {
        let field = if condition.on == "field" {
            read::deep_fields(text, condition.field.as_deref().unwrap())?
                .into_iter()
                .next()
                .map(|field| text[field.value].to_owned())
        } else {
            None
        };
        let subject = match condition.on.as_str() {
            "name" => Some(name.unwrap_or("")),
            "type" => Some(type_name),
            "text" => Some(text),
            _ => field.as_deref(),
        };
        let mut any = false;
        let entries = if matches!(condition.is.as_str(), "hasEntry" | "lacksEntry") {
            subject.map(read::entries).transpose()?
        } else {
            None
        };
        for expected in condition.value.values() {
            let positive = subject.is_some_and(|subject| match condition.is.as_str() {
                "equals" | "notEquals" => {
                    if condition.on == "field" {
                        same_value(subject, expected)
                    } else {
                        subject == expected
                    }
                }
                "startsWith" => subject.starts_with(expected),
                "endsWith" => subject.ends_with(expected),
                "hasEntry" | "lacksEntry" => entries.as_ref().is_some_and(|entries| {
                    entries.iter().any(|entry| same_value(entry.text, expected))
                }),
                _ => subject.contains(expected),
            });
            if positive {
                any = true;
                if let Some(unreached) = unreached.as_deref_mut() {
                    unreached[index].remove(expected);
                }
            }
        }
        let matched = (subject.is_some()
            || matches!(condition.is.as_str(), "notContains" | "lacksEntry"))
            && if matches!(
                condition.is.as_str(),
                "notEquals" | "notContains" | "lacksEntry"
            ) {
                !any
            } else {
                any
            };
        if matcher.mode == "all" {
            result &= matched;
            if !result {
                break;
            }
        } else {
            result |= matched;
        }
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn bulk(
    document: &mut Document<'_>,
    matcher: &BulkMatch,
    edits: &[BulkEdit],
    recursive: bool,
    min_blocks: usize,
    leading: Option<&Comment>,
    identity: &Identity,
    index: usize,
    notices: &mut Vec<Notice>,
) -> Result<()> {
    let mut unreached: Vec<BTreeSet<String>> = matcher
        .conditions
        .iter()
        .map(|condition| {
            if min_blocks > 0
                && !matches!(
                    condition.is.as_str(),
                    "notContains" | "notEquals" | "lacksEntry"
                )
            {
                condition
                    .value
                    .values()
                    .into_iter()
                    .map(str::to_owned)
                    .collect()
            } else {
                BTreeSet::new()
            }
        })
        .collect();
    let mut changes = vec![0usize; edits.len()];
    let mut already = vec![0usize; edits.len()];
    let mut matched_blocks = 0;
    let mut rewrites = Vec::new();
    for id in document.object_ids() {
        let node = document.node(id);
        let candidates = if recursive {
            read::objects(&node.text)?
        } else {
            vec![crate::ndf::Block {
                name: node.name.as_deref(),
                type_name: &node.type_name,
                span: 0..node.text.len(),
                body: None,
                kind: crate::ndf::BlockKind::Object,
            }]
        };
        let mut local = Vec::new();
        let mut previous_end = 0;
        for candidate in candidates {
            let text = &node.text[candidate.span.clone()];
            if !matches_tracked(
                text,
                candidate.name,
                candidate.type_name,
                matcher,
                Some(&mut unreached),
            )? {
                continue;
            }
            if candidate.span.start < previous_end {
                return Err(read::selector(crate::messages::text(
                    "ndf.patch.bulk.bulk.recursive_bulk_conditions_matched_overlapping_parent_and",
                )));
            }
            previous_end = candidate.span.end;
            matched_blocks += 1;
            let mut splices = Vec::new();
            let mut lists: HashMap<&str, Option<(Range<usize>, String)>> = HashMap::new();
            for (edit_index, edit) in edits.iter().enumerate() {
                let (result, count, unchanged) = if let Some(list) = edit.list.as_deref() {
                    if !lists.contains_key(list) {
                        let field = read::deep_fields(text, list)?.into_iter().next();
                        lists.insert(
                            list,
                            field.map(|field| {
                                let value = text[field.value.clone()].to_owned();
                                (field.value, value)
                            }),
                        );
                    }
                    let Some((_, current)) = lists.get_mut(list).unwrap() else {
                        continue;
                    };
                    let (result, count, unchanged) = bulk_list_edits(current, edit)?;
                    if !result.is_empty() {
                        *current = splice(current, result)?;
                    }
                    (Vec::new(), count, unchanged)
                } else {
                    bulk_edits(text, edit)?
                };
                changes[edit_index] += count;
                already[edit_index] += unchanged;
                splices.extend(result);
            }
            for (range, value) in lists.into_values().flatten() {
                if text[range.clone()] != value {
                    splices.push(Edit { range, text: value });
                }
            }
            if !splices.is_empty() {
                let mut changed = splice(text, splices)?;
                if let Some(comment) = leading {
                    let lines = comment
                        .lines()
                        .into_iter()
                        .map(|line| format!("// {line}\n"))
                        .collect::<String>();
                    if let Some(body) = read::first_body(&changed)? {
                        let at = body.start;
                        changed.insert_str(at, &format!("\n{lines}"));
                    }
                }
                local.push(Edit {
                    range: candidate.span,
                    text: changed,
                });
            }
        }
        if !local.is_empty() {
            rewrites.push((id, splice(&node.text, local)?));
        }
    }
    if matched_blocks < min_blocks {
        return Err(read::missing(crate::messages::format(
            "ndf.patch.bulk.bulk.bulk_matched_matched_blocks_blocks_but_requires",
            &[
                ("MATCHED_BLOCKS", format!("{}", matched_blocks)),
                ("MIN_BLOCKS", format!("{}", min_blocks)),
            ],
        )));
    }
    if matched_blocks == 0 {
        return Ok(());
    }
    for values in unreached {
        for value in values {
            notices.push(Notice::new(
                identity,
                index,
                crate::messages::format(
                    "ndf.patch.bulk.bulk.bulk_condition_alternative_value_matched_nothing",
                    &[("VALUE", value.to_string())],
                ),
            ));
        }
    }
    for (edit_index, edit) in edits.iter().enumerate() {
        let count = changes[edit_index] + already[edit_index];
        if count < edit.min_changes {
            return Err(read::missing(crate::messages::format(
                "ndf.patch.bulk.bulk.bulk_edit_arg0_reached_count_values_but",
                &[
                    ("ARG0", format!("{}", edit_index + 1)),
                    ("COUNT", format!("{}", count)),
                    ("ARG2", format!("{}", edit.min_changes)),
                ],
            )));
        }
        if changes[edit_index] == 0 && edit.multiply != Some(1.0) {
            notices.push(Notice::new(
                identity,
                index,
                if count == 0 {
                    crate::messages::format(
                        "ndf.patch.bulk.bulk.bulk_edit_arg0_found_no_values_in",
                        &[("ARG0", format!("{}", edit_index + 1))],
                    )
                } else {
                    crate::messages::format(
                        "ndf.patch.bulk.bulk.bulk_edit_arg0_already_holds_the_requested",
                        &[("ARG0", format!("{}", edit_index + 1))],
                    )
                },
            ));
        }
    }
    for (id, text) in rewrites {
        document.replace(id, text)?;
    }
    Ok(())
}
pub(super) fn bulk_list_edits(
    collection: &str,
    edit: &BulkEdit,
) -> Result<(Vec<Edit>, usize, usize)> {
    let entries = read::entries(collection)?;
    if let Some(insert) = &edit.insert {
        let value = format_value(&insert.value)?;
        let position = Position {
            mode: insert.position.clone(),
            anchor: None,
        };
        let next = insert_collection(collection, &value, Some(&position))?;
        if next == collection {
            return Ok((Vec::new(), 0, 1));
        }
        return Ok((
            vec![Edit {
                range: 0..collection.len(),
                text: next,
            }],
            1,
            0,
        ));
    }
    if let Some(remove) = &edit.remove_entry {
        let mut changes = Vec::new();
        for entry in &entries {
            if equivalent(entry.text, remove) {
                changes.push(Edit {
                    range: entry.span.start..entry.separator_end,
                    text: String::new(),
                });
            }
        }
        let count = changes.len();
        return Ok((changes, count, 0));
    }
    if let Some(set) = &edit.set_entry {
        let index = if set.index < 0 {
            entries.len() as i64 + set.index
        } else {
            set.index
        };
        if index < 0 || index as usize >= entries.len() {
            return Ok((Vec::new(), 0, 0));
        }
        let entry = &entries[index as usize];
        let value = format_value(&set.value)?;
        if same_value(entry.text, &value) {
            return Ok((Vec::new(), 0, 1));
        }
        return Ok((
            vec![Edit {
                range: entry.span.clone(),
                text: value,
            }],
            1,
            0,
        ));
    }
    Ok((Vec::new(), 0, 0))
}
pub(super) fn bulk_edits(source: &str, edit: &BulkEdit) -> Result<(Vec<Edit>, usize, usize)> {
    let ranges = if let Some(field) = &edit.field {
        read::deep_fields(source, field)?
            .into_iter()
            .map(|field| field.value)
            .collect()
    } else {
        map_values(source, edit.map_entry.as_deref().unwrap())?
    };
    let mut result = Vec::new();
    let mut changed = 0;
    let mut already = 0;
    for range in ranges {
        let old = &source[range.clone()];
        let scalar = parse_scalar(old);
        let next = if let Some(multiplier) = edit.multiply {
            if !matches!(scalar.kind.as_str(), "int" | "float") {
                continue;
            }
            if multiplier == 1.0 {
                already += 1;
                continue;
            }
            let value = templates::numeric(&scalar.value)? * multiplier;
            let value = if scalar.kind == "int" {
                templates::round(value)
            } else {
                value
            };
            let number = templates::number(value)?;
            if scalar.kind == "float" && !old.contains(['e', 'E']) && value.abs() < 1e21 {
                let decimals = old
                    .split_once('.')
                    .map_or(1, |(_, fraction)| fraction.len())
                    .clamp(1, 6);
                let half = value.abs() * (1u32 << (decimals + 1)) as f64;
                // Decimal ties round away from zero; the standard formatter uses even ties.
                let rounded = if half.fract() == 0.0 && half % 2.0 == 1.0 {
                    value.abs().next_up().copysign(value)
                } else if value == 0.0 {
                    0.0
                } else {
                    value
                };
                format!("{rounded:.decimals$}")
            } else {
                let mut text = number.to_string();
                if scalar.kind == "float" && !text.contains(['.', 'e', 'E']) {
                    text.push_str(".0");
                }
                text
            }
        } else {
            format_value(edit.set.as_ref().unwrap())?
        };
        if same_value(old, &next) {
            already += 1;
            continue;
        }
        changed += 1;
        let mut text = next;
        if let Some(comment) = &edit.trailing_comment {
            let comment = comment.lines().join(" | ");
            text.push_str(&format!(" // {comment} (was {})", old.trim()));
            let line_tail = &source[range.end..];
            let to_newline = line_tail.find('\n').map_or(line_tail, |n| &line_tail[..n]);
            if !to_newline.trim().is_empty() {
                text.push('\n');
                text.push_str(line_indent(source, range.start));
            }
        }
        result.push(Edit { range, text });
    }
    Ok((result, changed, already))
}
pub(super) fn map_values(source: &str, key: &str) -> Result<Vec<Range<usize>>> {
    let mut lexer = Lexer::new(source, 0);
    let mut result = Vec::new();
    loop {
        let token = lexer.next_token()?;
        if token.kind == Kind::Eof {
            break;
        }
        if token.text != "(" {
            continue;
        }
        let mut parser = crate::ndf::parser::Parser::new(source, token.end)?;
        let start = parser.token.start;
        if parser.value_end().is_err() {
            continue;
        }
        let end = parser.previous_end;
        if source[start..end].trim() != key {
            continue;
        }
        if parser.token.text != "," {
            continue;
        }
        parser.advance()?;
        let value_start = parser.token.start;
        let value_end = parser.value_end()?;
        if parser.token.text == ")" {
            result.push(value_start..value_end);
        }
    }
    Ok(result)
}
