use super::*;

pub(super) struct Selection {
    pub(super) value: Range<usize>,
    pub(super) whole: Range<usize>,
    pub(super) entry: bool,
}
pub(super) fn selection(source: &str, parts: &[String]) -> Result<Selection> {
    let Some(last) = parts.last() else {
        return Err(read::selector(crate::messages::text(
            "ndf.patch.editing.selection.a_field_selector_needs_a_field_or",
        )));
    };
    let parent = if parts.len() == 1 {
        0..source.len()
    } else {
        read::path_segments(source, &parts[..parts.len() - 1])?
    };
    let text = &source[parent.clone()];
    if last.starts_with('[') {
        let entry = read::select_entry(text, last)?;
        Ok(Selection {
            value: (parent.start + entry.span.start)..(parent.start + entry.span.end),
            whole: (parent.start + entry.span.start)..(parent.start + entry.separator_end),
            entry: true,
        })
    } else {
        let fields = read::direct_fields(text)?;
        let matches: Vec<_> = fields
            .into_iter()
            .filter(|field| field.name == last)
            .collect();
        match matches.as_slice() {
            [field] => Ok(Selection {
                value: (parent.start + field.value.start)..(parent.start + field.value.end),
                whole: (parent.start + field.span.start)..(parent.start + field.span.end),
                entry: false,
            }),
            [] => Err(read::missing(crate::messages::format(
                "ndf.patch.editing.selection.field_last_was_not_found",
                &[("LAST", last.to_string())],
            ))),
            _ => Err(read::ambiguous(crate::messages::format(
                "ndf.patch.editing.selection.field_last_matches_several_members",
                &[("LAST", last.to_string())],
            ))),
        }
    }
}
pub(super) fn insert_field(source: &str, name: &str, value: &str) -> Result<String> {
    let body = read::first_body(source)?.ok_or_else(|| {
        read::selector(crate::messages::text(
            "ndf.patch.editing.insert_field.the_selected_value_has_no_object_body",
        ))
    })?;
    let close = body.end - 1;
    let line_start = source[..close].rfind('\n').map_or(close, |n| n + 1);
    let insertion = if source[line_start..close].trim().is_empty() {
        line_start
    } else {
        close
    };
    let indent = format!("{}    ", line_indent(source, body.start));
    let prefix = if insertion > 0 && !source[..insertion].ends_with('\n') {
        "\n"
    } else {
        ""
    };
    splice(
        source,
        vec![Edit {
            range: insertion..insertion,
            text: format!("{prefix}{indent}{name} = {value}\n"),
        }],
    )
}
pub(super) fn replace_field_with_marker(
    source: &str,
    selected: &Selection,
    replacement: &str,
    identity: &Identity,
    index: usize,
    operation: &str,
) -> Result<String> {
    if selected.entry {
        return splice(
            source,
            vec![Edit {
                range: selected.value.clone(),
                text: replacement.into(),
            }],
        );
    }
    let start = source[..selected.whole.start]
        .rfind('\n')
        .map_or(0, |n| n + 1);
    let indent = &source[start..selected.whole.start];
    if !indent.trim().is_empty() {
        return Err(read::selector(crate::messages::text(
            "ndf.patch.editing.replace_field_with_marker.field_ownership_comments_need_their_own_line",
        )));
    }
    let mut end = selected.whole.end;
    let line_end = source[end..].find('\n').map_or(source.len(), |n| end + n);
    if source[end..line_end].trim_start().starts_with("//") {
        end = line_end;
    }
    let original = &source[selected.whole.start..end];
    let content = if operation == "remove" {
        String::new()
    } else {
        format!(
            "{}{}{}",
            &source[selected.whole.start..selected.value.start],
            replacement,
            &source[selected.value.end..end]
        )
    };
    let marked = mark(
        operation,
        &content,
        Some(original),
        indent,
        identity,
        index,
        None,
    );
    splice(
        source,
        vec![Edit {
            range: start..end,
            text: marked,
        }],
    )
}
pub(super) fn mark(
    operation: &str,
    text: &str,
    original: Option<&str>,
    indent: &str,
    identity: &Identity,
    index: usize,
    comment: Option<&Comment>,
) -> String {
    let seed = format!(
        "{operation}|{}|{}|{}|{index}",
        identity.mod_id, identity.patch_id, identity.path
    );
    let payload = json!({"id":&crate::hash(seed)[..12],"patchId":identity.patch_id}).to_string();
    let label = operation.to_uppercase();
    let mut output = format!("{indent}// YMB-{label}-START {payload}\n");
    if let Some(comment) = comment {
        for line in comment.lines() {
            output.push_str(&format!("{indent}// {line}\n"));
        }
    }
    if let Some(original) = original {
        output.push_str(&format!("{indent}// YMB-ORIGINAL\n"));
        for line in original.trim_end_matches(['\r', '\n']).lines() {
            output.push_str(&format!("{indent}// {}\n", line.trim_end_matches('\r')));
        }
    }
    if !text.is_empty() {
        output.push_str(indent);
        output.push_str(text);
        if !text.ends_with('\n') {
            output.push('\n');
        }
    }
    output.push_str(&format!("{indent}// YMB-{label}-END {payload}\n"));
    output
}
pub(super) fn line_indent(source: &str, at: usize) -> &str {
    let start = source[..at].rfind('\n').map_or(0, |n| n + 1);
    let line = &source[start..at];
    let length = line
        .bytes()
        .take_while(|b| matches!(b, b' ' | b'\t'))
        .count();
    &line[..length]
}
pub(super) fn normalize_indent(text: &str, indent: &str) -> String {
    let text = text.trim_matches(['\r', '\n']);
    let lines: Vec<_> = text.lines().collect();
    let common = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            line.bytes()
                .take_while(|b| matches!(b, b' ' | b'\t'))
                .count()
        })
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| format!("{indent}{}", &line[common.min(line.len())..]))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn insert_collection(source: &str, value: &str, position: Option<&Position>) -> Result<String> {
    let range = read::first_collection(source)?.ok_or_else(|| {
        read::selector(crate::messages::text(
            "ndf.patch.editing.insert_collection.the_target_is_not_a_collection",
        ))
    })?;
    if Lexer::new(source, range.end).next_token()?.kind != Kind::Eof {
        return Err(read::selector(crate::messages::text(
            "ndf.patch.editing.insert_collection.the_target_must_be_a_collection_rather",
        )));
    }
    let entries = read::entries(source)?;
    let wrapped = format!("[\n{value}\n]");
    let supplied = read::entries(&wrapped)?;
    let existing: HashSet<_> = entries
        .iter()
        .map(|entry| value_tokens(entry.text))
        .collect::<Result<_>>()?;
    let supplied = supplied
        .iter()
        .map(|entry| value_tokens(entry.text))
        .collect::<Result<Vec<_>>>()?;
    if supplied.is_empty() {
        return Err(read::selector(crate::messages::text(
            "ndf.patch.editing.insert_collection.addition_needs_an_entry",
        )));
    }
    let already = supplied
        .iter()
        .filter(|entry| existing.contains(*entry))
        .count();
    if already == supplied.len() {
        return Ok(source.to_owned());
    }
    if already > 0 {
        return Err(conflict(crate::messages::text(
            "ndf.patch.editing.insert_collection.some_entries_already_exist",
        )));
    }
    let base_indent = line_indent(source, range.start);
    let indent = entries
        .first()
        .map(|e| line_indent(source, e.span.start))
        .filter(|s| !s.is_empty())
        .map_or_else(|| format!("{base_indent}    "), str::to_owned);
    let mode = position.map(|p| p.mode.as_str()).unwrap_or("end");
    let mut location = range.end - 1;
    let mut before = false;
    if mode == "start" {
        location = range.start + 1;
        before = true;
    } else if matches!(mode, "before" | "after") {
        let name = position.and_then(|p| p.anchor.as_deref()).unwrap_or("");
        let mut anchors = entries.iter().filter(|entry| {
            !name.is_empty()
                && strip_comments(&source[entry.span.start..entry.separator_end]).contains(name)
        });
        let anchor = anchors.next().ok_or_else(|| {
            read::missing(crate::messages::format(
                "ndf.patch.editing.insert_collection.anchor_was_not_found",
                &[("ANCHOR", name.to_owned())],
            ))
        })?;
        if anchors.next().is_some() {
            return Err(read::ambiguous(crate::messages::format(
                "ndf.patch.editing.insert_collection.anchor_matches_several_entries",
                &[("ANCHOR", name.to_owned())],
            )));
        }
        location = if mode == "before" {
            anchor.span.start
        } else {
            anchor.separator_end
        };
        before = mode == "before";
    }
    let mut edits = Vec::new();
    if !before
        && let Some(previous) = entries
            .iter()
            .rev()
            .find(|entry| entry.span.end <= location)
        && previous.separator_end == previous.span.end
    {
        edits.push(Edit {
            range: previous.span.end..previous.span.end,
            text: ",".into(),
        });
    }
    let mut rendered = normalize_indent(value, &indent);
    let mut lexer = Lexer::new(&rendered, 0);
    let mut last = None;
    loop {
        let token = lexer.next_token()?;
        if token.kind == Kind::Eof {
            break;
        }
        last = Some((token.text == ",", token.end));
    }
    if let Some((false, end)) = last {
        rendered.insert(end, ',');
    }
    let prefix = if location > 0 && source.as_bytes()[location - 1] != b'\n' {
        "\n"
    } else {
        ""
    };
    let addition = format!("{prefix}{rendered}\n{base_indent}");
    if let Some(existing) = edits
        .last_mut()
        .filter(|edit| edit.range == (location..location))
    {
        existing.text.push_str(&addition);
    } else {
        edits.push(Edit {
            range: location..location,
            text: addition,
        });
    }
    splice(source, edits)
}

pub fn splice(source: &str, mut edits: Vec<Edit>) -> Result<String> {
    edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
    let mut cursor = 0;
    let mut previous_point = None;
    let mut output = String::with_capacity(source.len());
    for edit in edits {
        if edit.range.start < cursor
            || edit.range.start > edit.range.end
            || edit.range.end > source.len()
            || !source.is_char_boundary(edit.range.start)
            || !source.is_char_boundary(edit.range.end)
            || previous_point == Some(edit.range.start)
        {
            return Err(conflict(crate::messages::text(
                "ndf.patch.editing.splice.edits_overlap_or_split_an_invalid_source",
            )));
        }
        output.push_str(&source[cursor..edit.range.start]);
        output.push_str(&edit.text);
        cursor = edit.range.end;
        previous_point = if edit.range.is_empty() {
            Some(edit.range.start)
        } else {
            None
        };
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}
pub(super) fn value_tokens(source: &str) -> Result<Vec<&str>> {
    let mut lexer = Lexer::new(source, 0);
    let mut result = Vec::new();
    loop {
        let token = lexer.next_token()?;
        if token.kind == Kind::Eof {
            break;
        }
        result.push(token.text);
    }
    if result.last() == Some(&",") {
        result.pop();
    }
    Ok(result)
}
pub(super) fn equivalent(a: &str, b: &str) -> bool {
    value_tokens(a)
        .ok()
        .zip(value_tokens(b).ok())
        .is_some_and(|(a, b)| a == b)
}
pub(super) fn same_value(a: &str, b: &str) -> bool {
    templates::equal(&parse_scalar(a).value, &parse_scalar(b).value)
}
pub(super) fn conflict(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConflictError",
        reason,
        crate::messages::text(
            "ndf.patch.editing.conflict.keep_one_owner_or_explicitly_order_compatible",
        ),
    )
}

pub fn reidentify_ids(source: &str, namespace: &str) -> Result<String> {
    use sha2::{Digest, Sha256};
    static GUID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^GUID:\{([0-9a-z]{8}-(?:[0-9a-z]{4}-){3}[0-9a-z]{12})\}$").unwrap()
    });
    let mut occurrences = std::collections::HashMap::<String, usize>::new();
    let mut edits = Vec::new();
    for field in read::deep_fields(source, "DescriptorId")? {
        let literal = strip_comments(&source[field.value.clone()]);
        let Some(captures) = GUID.captures(literal.trim()) else {
            continue;
        };
        let original = captures[1].to_ascii_lowercase();
        let occurrence = occurrences.entry(original.clone()).or_default();
        let input = json!([namespace, original, *occurrence]).to_string();
        *occurrence += 1;
        let mut digest = Sha256::digest(input.as_bytes());
        digest[6] = (digest[6] & 0x0f) | 0x80;
        digest[8] = (digest[8] & 0x3f) | 0x80;
        let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
        let guid = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        edits.push(Edit {
            range: field.value,
            text: format!("GUID:{{{guid}}}"),
        });
    }
    splice(source, edits)
}
