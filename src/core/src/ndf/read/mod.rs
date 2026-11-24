use super::{
    Block, BlockKind,
    lexer::{Kind, Lexer},
    parser::Parser,
    scan,
};
use crate::{Diagnostic, Result};
use std::ops::Range;

pub use super::parser::{Field, fields, objects};

#[derive(Clone, Debug)]
pub struct Entry<'a> {
    pub span: Range<usize>,
    pub separator_end: usize,
    pub text: &'a str,
    pub type_name: Option<&'a str>,
}

pub fn direct_fields(source: &str) -> Result<Vec<Field<'_>>> {
    let Some(body) = first_body(source)? else {
        return Ok(Vec::new());
    };
    let mut parser = Parser::new(source, body.start + 1)?;
    let mut fields = Vec::new();
    while parser.token.start < body.end - 1 && parser.token.kind != Kind::Eof {
        let (name, value) = parser.member()?;
        if let Some(value) = value {
            fields.push(Field {
                name: name.text,
                span: name.start..value.end,
                value,
            });
        }
    }
    Ok(fields)
}

pub fn trailing_comment<'a>(source: &'a str, field: &Field<'_>) -> Option<&'a str> {
    let tail = source
        .get(field.value.end..)?
        .split('\n')
        .next()?
        .trim_start();
    tail.strip_prefix("//").map(str::trim)
}
pub fn deep_fields<'a>(source: &'a str, wanted: &str) -> Result<Vec<Field<'a>>> {
    let mut lexer = Lexer::new(source, 0);
    let mut fields = Vec::new();
    let mut depth = 0usize;
    loop {
        let token = lexer.next_token()?;
        if token.kind == Kind::Eof {
            break;
        }
        if token.text == "(" || token.text == "[" {
            depth += 1;
        }
        if token.text == ")" || token.text == "]" {
            depth = depth.saturating_sub(1);
        }
        if depth > 0 && token.kind == Kind::Word && token.text == wanted {
            let mut parser = Parser::new(source, token.start)?;
            if let Ok((name, Some(value))) = parser.member() {
                fields.push(Field {
                    name: name.text,
                    span: name.start..value.end,
                    value,
                });
            }
        }
    }
    Ok(fields)
}

pub fn first_body(source: &str) -> Result<Option<Range<usize>>> {
    let mut lexer = Lexer::new(source, 0);
    let first = lexer.next_token()?;
    if first.text == "(" {
        return Ok(Some(first.start..matching_end(source, first.start)?));
    }
    Ok(scan(source)?.first().and_then(|block| block.body.clone()))
}
pub fn first_collection(source: &str) -> Result<Option<Range<usize>>> {
    let mut lexer = Lexer::new(source, 0);
    loop {
        let token = lexer.next_token()?;
        if token.kind == Kind::Eof {
            return Ok(None);
        }
        if token.text == "[" {
            return Ok(Some(token.start..matching_end(source, token.start)?));
        }
    }
}

pub fn matching_end(source: &str, start: usize) -> Result<usize> {
    let mut lexer = Lexer::new(source, start);
    let first = lexer.next_token()?;
    let close = match first.text {
        "(" => ")",
        "[" => "]",
        "{" => "}",
        _ => {
            return Err(selector(crate::messages::text(
                "ndf.read.mod.matching_end.expected_an_opening_delimiter",
            )));
        }
    };
    let mut stack = vec![close];
    loop {
        let token = lexer.next_token()?;
        match token.text {
            "" => {
                return Err(selector(crate::messages::text(
                    "ndf.read.mod.matching_end.unclosed_ndf_delimiter",
                )));
            }
            "(" => stack.push(")"),
            "[" => stack.push("]"),
            "{" => stack.push("}"),
            ")" | "]" | "}" => {
                if stack.pop() != Some(token.text) {
                    return Err(selector(crate::messages::text(
                        "ndf.read.mod.matching_end.mismatched_ndf_delimiter",
                    )));
                }
                if stack.is_empty() {
                    return Ok(token.end);
                }
            }
            _ => (),
        }
    }
}

pub fn entries(source: &str) -> Result<Vec<Entry<'_>>> {
    let Some(range) = first_collection(source)? else {
        return Ok(Vec::new());
    };
    let mut parser = Parser::new(source, range.start + 1)?;
    let mut result = Vec::new();
    while parser.token.text != "]" {
        let start = parser.token.start;
        let kind = parser.token.kind;
        let type_name = if kind == Kind::Word {
            Some(parser.token.text)
        } else {
            None
        };
        let end = parser.value_end()?;
        let separator_end = if parser.token.text == "," {
            parser.advance()?.end
        } else {
            end
        };
        result.push(Entry {
            span: start..end,
            separator_end,
            text: &source[start..end],
            type_name: type_name.filter(|_| source[start..end].contains('(')),
        });
        if separator_end == end && parser.token.text != "]" {
            return Err(selector(crate::messages::text(
                "ndf.read.mod.entries.list_entries_need_commas",
            )));
        }
    }
    Ok(result)
}

pub fn split_path(path: &str) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (at, ch) in path.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote.is_some() && ch == '\\' {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }
        if quote.is_some() {
            continue;
        }
        match ch {
            '[' => depth += 1,
            ']' => {
                depth = depth.checked_sub(1).ok_or_else(|| {
                    selector(crate::messages::text(
                        "ndf.read.mod.split_path.unbalanced_selector_brackets",
                    ))
                })?;
            }
            '.' if depth == 0 => {
                let part = path[start..at].trim();
                if part.is_empty() {
                    return Err(selector(crate::messages::text(
                        "ndf.read.mod.split_path.empty_selector_path_segment",
                    )));
                }
                parts.push(part.into());
                start = at + 1;
            }
            _ => (),
        }
    }
    if depth != 0 || quote.is_some() {
        return Err(selector(crate::messages::text(
            "ndf.read.mod.split_path.unclosed_selector_brackets_or_string",
        )));
    }
    let last = path[start..].trim();
    if !last.is_empty() {
        parts.push(last.into());
    }
    if parts.is_empty() {
        return Err(selector(crate::messages::text(
            "ndf.read.mod.split_path.selector_path_is_empty",
        )));
    }
    Ok(parts)
}

pub fn path_range(source: &str, path: &str) -> Result<Range<usize>> {
    let parts = split_path(path)?;
    path_segments(source, &parts)
}
pub fn path_segments(source: &str, parts: &[String]) -> Result<Range<usize>> {
    let mut view = 0..source.len();
    let mut cursor = 0;
    let blocks = scan(source);
    if let Some(first) = parts.first()
        && (first.starts_with('@')
            || blocks.as_ref().is_ok_and(|blocks| {
                blocks
                    .iter()
                    .any(|block| block.name == Some(first.as_str()))
            }))
    {
        let blocks = blocks?;
        let selected = select_block(&blocks, first)?;
        view = selected.span.clone();
        cursor = 1;
    }
    for part in &parts[cursor..] {
        let local = &source[view.clone()];
        let found = if part.starts_with('[') {
            select_entry(local, part)?.span
        } else {
            let fields = direct_fields(local)?;
            let matches: Vec<_> = fields.iter().filter(|field| field.name == part).collect();
            match matches.as_slice() {
                [field] => field.value.clone(),
                [] => {
                    return Err(missing(crate::messages::format(
                        "ndf.read.mod.path_segments.field_part_was_not_found",
                        &[("PART", part.to_string())],
                    )));
                }
                _ => {
                    return Err(ambiguous(crate::messages::format(
                        "ndf.read.mod.path_segments.field_part_matches_several_members",
                        &[("PART", part.to_string())],
                    )));
                }
            }
        };
        view = (view.start + found.start)..(view.start + found.end);
    }
    Ok(view)
}

pub fn select_block<'a, 'b>(blocks: &'b [Block<'a>], reference: &str) -> Result<&'b Block<'a>> {
    if let Some(index) = reference
        .strip_prefix('@')
        .and_then(|s| s.parse::<usize>().ok())
    {
        return blocks
            .iter()
            .filter(|block| block.kind == BlockKind::Object)
            .nth(index)
            .ok_or_else(|| {
                missing(crate::messages::format(
                    "ndf.read.mod.select_block.top_level_block_index_index_was_not",
                    &[("INDEX", format!("{}", index))],
                ))
            });
    }
    let matches: Vec<_> = blocks
        .iter()
        .filter(|block| {
            if let Some(type_name) = reference.strip_prefix("@type:") {
                block.kind == BlockKind::Object && block.type_name == type_name
            } else {
                block.name == Some(reference)
            }
        })
        .collect();
    match matches.as_slice() {
        [block] => Ok(*block),
        [] => Err(missing(crate::messages::format(
            "ndf.read.mod.select_block.top_level_block_reference_was_not_found",
            &[("REFERENCE", reference.to_string())],
        ))),
        _ => Err(ambiguous(crate::messages::format(
            "ndf.read.mod.select_block.top_level_selector_reference_matches_several_blocks",
            &[("REFERENCE", reference.to_string())],
        ))),
    }
}

pub fn select_entry<'a>(source: &'a str, segment: &str) -> Result<Entry<'a>> {
    let body = segment
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .ok_or_else(|| {
            selector(crate::messages::text(
                "ndf.read.mod.select_entry.list_selector_must_be_enclosed_in_brackets",
            ))
        })?
        .trim();
    let values = entries(source)?;
    if let Ok(index) = body.strip_prefix("index:").unwrap_or(body).parse::<usize>() {
        return values.into_iter().nth(index).ok_or_else(|| {
            missing(crate::messages::format(
                "ndf.read.mod.select_entry.list_entry_index_was_not_found",
                &[("INDEX", format!("{}", index))],
            ))
        });
    }
    let mut lexer = Lexer::new(body, 0);
    let mut depth = 0usize;
    let mut condition = None;
    let mut suffix = None;
    loop {
        let token = lexer.next_token()?;
        match token.text {
            "" => break,
            "[" | "(" | "{" => depth += 1,
            "]" | ")" | "}" => {
                depth = depth.checked_sub(1).ok_or_else(|| {
                    selector(crate::messages::text(
                        "ndf.read.mod.select_entry.unbalanced_entry_selector",
                    ))
                })?;
            }
            "=" if depth == 0 => {
                condition = Some((&body[..token.start], &body[token.end..]));
                break;
            }
            "#" if depth == 0 => suffix = Some(token.start),
            _ => (),
        }
    }
    let mut occurrence = None;
    let type_body = if condition.is_none() {
        if let Some(at) = suffix {
            occurrence = Some(body[at + 1..].parse::<usize>().map_err(|_| {
                selector(crate::messages::text(
                    "ndf.read.mod.select_entry.invalid_type_occurrence_index",
                ))
            })?);
            &body[..at]
        } else {
            body
        }
    } else {
        body
    };
    let type_body = type_body.strip_prefix("type:").unwrap_or(type_body);
    let mut matches = Vec::new();
    for entry in values {
        let matched = if let Some((field, expected)) = condition {
            let actual = if field.trim() == "value" {
                Some(entry.text)
            } else {
                path_range(entry.text, field.trim())
                    .ok()
                    .map(|span| &entry.text[span])
            };
            actual.is_some_and(|actual| actual.trim() == expected.trim())
        } else {
            type_body
                .split('|')
                .any(|name| entry.type_name == Some(name.trim()))
        };
        if matched {
            matches.push(entry);
        }
    }
    if let Some(index) = occurrence {
        return matches.into_iter().nth(index).ok_or_else(|| {
            missing(crate::messages::format(
                "ndf.read.mod.select_entry.list_type_occurrence_index_was_not_found",
                &[("INDEX", format!("{}", index))],
            ))
        });
    }
    match matches.len() {
        0 => Err(missing(crate::messages::format(
            "ndf.read.mod.select_entry.list_selector_segment_matched_nothing",
            &[("SEGMENT", segment.to_string())],
        ))),
        1 => Ok(matches.remove(0)),
        _ => Err(ambiguous(crate::messages::format(
            "ndf.read.mod.select_entry.list_selector_segment_matches_several_entries_use",
            &[("SEGMENT", segment.to_string())],
        ))),
    }
}

pub fn numeric_definitions(source: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
    let mut values = serde_json::Map::new();
    for block in scan(source)? {
        if block.kind != BlockKind::Bare {
            continue;
        }
        let Some(name) = block.name else {
            continue;
        };
        let text = &source[block.span];
        let mut lexer = Lexer::new(text, 0);
        loop {
            let token = lexer.next_token()?;
            if token.kind == Kind::Eof {
                break;
            }
            if token.text == "is" {
                let scalar = super::values::parse_scalar(&text[token.end..]);
                if matches!(scalar.kind.as_str(), "int" | "float") {
                    values.insert(
                        name.into(),
                        crate::templates::number(scalar.value.as_f64().unwrap())?,
                    );
                }
                break;
            }
        }
    }
    Ok(values)
}

pub fn selector(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "SelectorError",
        reason,
        crate::messages::text("ndf.read.mod.selector.use_find_to_check_the_object_field"),
    )
}
pub fn missing(reason: impl Into<String>) -> Box<Diagnostic> {
    selector(reason).code("E16")
}
pub fn ambiguous(reason: impl Into<String>) -> Box<Diagnostic> {
    selector(reason).code("E17")
}

#[cfg(test)]
mod tests;
