use super::{
    document::Document,
    lexer::{Kind, Lexer},
    operation::*,
    read, validate,
    values::{format_value, parse_scalar, strip_comments},
};
use crate::{Diagnostic, Result, templates};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    sync::LazyLock,
};

#[derive(Clone, Debug)]
pub struct Edit {
    pub range: Range<usize>,
    pub text: String,
}
#[derive(Clone, Debug)]
pub struct PatchResult {
    pub text: String,
    pub notices: Vec<Notice>,
}

pub fn apply(
    source: &str,
    operations: &[(Operation, usize)],
    identity: &Identity,
) -> Result<PatchResult> {
    let mut document = Document::new(source).map_err(|e| e.at(&identity.path))?;
    let mut notices = Vec::new();
    for (operation, index) in operations {
        apply_operation(&mut document, operation, identity, *index, &mut notices)
            .map_err(|e| identity.attach(e, *index))?;
    }
    let text = document.render();
    validate(&text).map_err(|e| e.at(&identity.path))?;
    if text==source&&notices.is_empty()&&!operations.iter().all(|(operation,_)|matches!(operation,Operation::Bulk{expect,..}if expect.min_blocks==0)||matches!(operation,Operation::Bulk{edits,..}if edits.iter().all(|edit|edit.multiply==Some(1.0)))){notices.push(Notice::new(identity,0,crate::messages::text("ndf.patch.mod.apply.the_target_applied_successfully_and_changed_no")));}
    Ok(PatchResult { text, notices })
}

pub fn apply_operation(
    document: &mut Document<'_>,
    operation: &Operation,
    identity: &Identity,
    index: usize,
    notices: &mut Vec<Notice>,
) -> Result<()> {
    let first_notice = notices.len();
    apply_operation_inner(document, operation, identity, index, notices)?;
    for notice in &mut notices[first_notice..] {
        notice.selector = match operation {
            Operation::Copy { selector, .. }
            | Operation::Modify { selector, .. }
            | Operation::Remove { selector, .. } => Some(selector.clone()),
            Operation::Add { selector, .. } => selector.clone(),
            Operation::Bulk { .. } => None,
        };
        if let Some(reason) = operation.no_change_reason() {
            notice.code = "I4".into();
            notice.expected = Some(reason.to_owned());
            notice.suggestion = crate::messages::text("ndf.patch.mod.apply_operation.intentional_compatibility_operation_retain_its_condition").into();
        }
    }
    Ok(())
}
fn apply_operation_inner(
    document: &mut Document<'_>,
    operation: &Operation,
    identity: &Identity,
    index: usize,
    notices: &mut Vec<Notice>,
) -> Result<()> {
    match operation {
        Operation::Copy {
            selector,
            destination,
            reidentify,
            leading_comment,
            ..
        } => {
            let id = document.select(selector)?;
            let source = document.node(id);
            let name = source.name.as_ref().ok_or_else(|| {
                read::selector(crate::messages::text(
                    "ndf.patch.mod.apply_operation_inner.copy_needs_a_named_object",
                ))
            })?;
            let pattern = Regex::new(&format!(r"\b{}\b", regex::escape(name)))
                .map_err(|e| read::selector(e.to_string()))?;
            let mut text = pattern
                .replace_all(&source.text, |_: &regex::Captures<'_>| {
                    destination.name.clone()
                })
                .into_owned();
            if *reidentify {
                let namespace = json!([
                    identity.mod_id,
                    identity.patch_id,
                    identity.path.replace('\\', "/"),
                    destination.name
                ])
                .to_string();
                text = reidentify_ids(&text, &namespace)?;
            }
            match document.named(&destination.name) {
                Ok(existing) => {
                    if equivalent(&document.node(existing).text, &text) {
                        notices.push(Notice::new(
                            identity,
                            index,
                            crate::messages::format("ndf.patch.mod.apply_operation_inner.copy_destination_arg0_already_exists_unchanged", &[("ARG0", destination.name.to_string())]),
                        ));
                        return Ok(());
                    }
                    return Err(conflict(crate::messages::format(
                        "ndf.patch.mod.apply_operation_inner.copy_destination_arg0_already_contains_different_data",
                        &[("ARG0", destination.name.to_string())],
                    )));
                }
                Err(e) if e.code.as_deref() == Some("E16") => (),
                Err(e) => return Err(e),
            }
            document.insert(
                mark(
                    "copy",
                    &text,
                    None,
                    "",
                    identity,
                    index,
                    leading_comment.as_ref(),
                ),
                document.order_len(),
            )?;
        }
        Operation::Modify {
            selector,
            value,
            changes,
            leading_comment,
            ..
        } => {
            if selector.kind == "field" {
                let path = selector.value.as_ref().and_then(Value::as_str).unwrap();
                let parts = read::split_path(path)?;
                let id = document.reference(&parts[0])?;
                let source = &document.node(id).text;
                let formatted = format_value(value.as_ref().unwrap())?;
                let selected = match selection(source, &parts[1..]) {
                    Ok(selected) => selected,
                    Err(error) if error.code.as_deref() == Some("E16") => {
                        let parents = &parts[1..parts.len() - 1];
                        let range = if parents.is_empty() {
                            0..source.len()
                        } else {
                            read::path_segments(source, parents)?
                        };
                        let parent = &source[range.clone()];
                        let name = parts.last().unwrap();
                        if name.starts_with('[') {
                            return Err(error);
                        }
                        let body = read::first_body(parent)?.ok_or_else(|| {
                            read::selector(crate::messages::text("ndf.patch.mod.apply_operation_inner.the_missing_field_needs_an_object_parent"))
                        })?;
                        let close = body.end - 1;
                        let line_start = parent[..close].rfind('\n').map_or(0, |at| at + 1);
                        let at = if parent[line_start..close].trim().is_empty() {
                            line_start
                        } else {
                            close
                        };
                        let indent = format!("{}    ", line_indent(parent, close));
                        let marked = mark(
                            "modify",
                            &format!("{name} = {formatted}"),
                            None,
                            &indent,
                            identity,
                            index,
                            None,
                        );
                        let insertion = format!(
                            "{}{marked}
",
                            if at > 0 && parent.as_bytes()[at - 1] != b'\n' {
                                "
"
                            } else {
                                ""
                            }
                        );
                        let replacement = splice(
                            parent,
                            vec![Edit {
                                range: at..at,
                                text: insertion,
                            }],
                        )?;
                        document.replace(
                            id,
                            splice(
                                source,
                                vec![Edit {
                                    range,
                                    text: replacement,
                                }],
                            )?,
                        )?;
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                };
                if selected.entry {
                    return Err(read::selector(crate::messages::text(
                        "ndf.patch.mod.apply_operation_inner.modify_a_field_inside_the_collection_entry",
                    )));
                }
                if same_value(&source[selected.value.clone()], &formatted) {
                    notices.push(Notice::new(
                        identity,
                        index,
                        crate::messages::format("ndf.patch.mod.apply_operation_inner.path_already_holds_the_requested_value", &[("PATH", path.to_string())]),
                    ));
                    return Ok(());
                }
                let text = replace_field_with_marker(
                    source, &selected, &formatted, identity, index, "modify",
                )?;
                document.replace(id, text)?;
            } else {
                let id = document.select(selector)?;
                let original = document.node(id).text.to_string();
                let mut text = original.clone();
                for (name, value) in changes.as_ref().unwrap() {
                    let formatted = format_value(value)?;
                    let fields = read::direct_fields(&text)?;
                    if let Some(field) = fields.iter().find(|field| field.name == name) {
                        if same_value(&text[field.value.clone()], &formatted) {
                            notices.push(Notice::new(
                                identity,
                                index,
                                crate::messages::format("ndf.patch.mod.apply_operation_inner.field_name_already_holds_the_requested_value", &[("NAME", name.to_string())]),
                            ));
                        } else {
                            text = splice(
                                &text,
                                vec![Edit {
                                    range: field.value.clone(),
                                    text: formatted,
                                }],
                            )?;
                        }
                    } else {
                        text = insert_field(&text, name, &formatted)?;
                    }
                }
                if text != original {
                    document.replace(
                        id,
                        mark(
                            "modify",
                            &text,
                            Some(&original),
                            "",
                            identity,
                            index,
                            leading_comment.as_ref(),
                        ),
                    )?;
                }
            }
        }
        Operation::Add {
            selector,
            value,
            position,
            leading_comment,
            ..
        } => {
            let formatted = format_value(value)?;
            if let Some(selector) = selector {
                let path = selector.value.as_ref().and_then(Value::as_str).unwrap();
                let parts = read::split_path(path)?;
                let id = document.reference(&parts[0])?;
                let source = &document.node(id).text;
                if selector.kind == "collection" {
                    let range = if parts.len() == 1 {
                        0..source.len()
                    } else {
                        read::path_segments(source, &parts[1..])?
                    };
                    let collection = &source[range.clone()];
                    let added = mark(
                        "add",
                        &formatted,
                        None,
                        "",
                        identity,
                        index,
                        leading_comment.as_ref(),
                    );
                    let replacement = insert_collection(collection, &added, position.as_ref())?;
                    if replacement == collection {
                        notices.push(Notice::new(
                            identity,
                            index,
                            crate::messages::format("ndf.patch.mod.apply_operation_inner.the_collection_at_path_already_contains_this", &[("PATH", path.to_string())]),
                        ));
                        return Ok(());
                    }
                    let text = splice(
                        source,
                        vec![Edit {
                            range,
                            text: replacement,
                        }],
                    )?;
                    document.replace(id, text)?;
                } else {
                    if parts.len() < 2 {
                        return Err(read::selector(crate::messages::text(
                            "ndf.patch.mod.apply_operation_inner.field_add_needs_a_field_path_after",
                        )));
                    }
                    let parent_parts = &parts[1..parts.len() - 1];
                    let parent_range = if parent_parts.is_empty() {
                        0..source.len()
                    } else {
                        read::path_segments(source, parent_parts)?
                    };
                    let parent = &source[parent_range.clone()];
                    let name = parts.last().unwrap();
                    let fields = read::direct_fields(parent)?;
                    if let Some(field) = fields.iter().find(|field| field.name == name) {
                        if same_value(&parent[field.value.clone()], &formatted) {
                            notices.push(Notice::new(
                                identity,
                                index,
                                crate::messages::format("ndf.patch.mod.apply_operation_inner.field_path_already_exists_unchanged", &[("PATH", path.to_string())]),
                            ));
                            return Ok(());
                        }
                        return Err(conflict(crate::messages::format(
                            "ndf.patch.mod.apply_operation_inner.field_path_already_exists_with_different_content",
                            &[("PATH", path.to_string())],
                        )));
                    }
                    let replacement = insert_field(parent, name, &formatted)?;
                    let text = splice(
                        source,
                        vec![Edit {
                            range: parent_range,
                            text: replacement,
                        }],
                    )?;
                    document.replace(id, text)?;
                }
            } else {
                let blocks = super::scan(&formatted)?;
                if blocks.is_empty() {
                    return Err(read::selector(crate::messages::text(
                        "ndf.patch.mod.apply_operation_inner.top_level_add_requires_a_declaration",
                    )));
                }
                let mut names = HashSet::new();
                let mut existing_count = 0;
                for block in &blocks {
                    if let Some(name) = block.name {
                        if !names.insert(name) {
                            return Err(conflict(crate::messages::format(
                                "ndf.patch.mod.apply_operation_inner.addition_repeats_block_name",
                                &[("NAME", name.to_string())],
                            )));
                        }
                        match document.named(name) {
                            Ok(existing) => {
                                if equivalent(
                                    &document.node(existing).text,
                                    &formatted[block.span.clone()],
                                ) {
                                    existing_count += 1;
                                } else {
                                    return Err(conflict(crate::messages::format(
                                        "ndf.patch.mod.apply_operation_inner.block_name_already_contains_different_content",
                                        &[("NAME", name.to_string())],
                                    )));
                                }
                            }
                            Err(error) if error.code.as_deref() == Some("E16") => (),
                            Err(error) => return Err(error),
                        }
                    }
                }
                if existing_count == blocks.len() {
                    notices.push(Notice::new(
                        identity,
                        index,
                        crate::messages::text("ndf.patch.mod.apply_operation_inner.all_added_blocks_already_exist_unchanged"),
                    ));
                    return Ok(());
                }
                if existing_count > 0 {
                    return Err(conflict(crate::messages::text(
                        "ndf.patch.mod.apply_operation_inner.some_declarations_in_this_addition_already_exist",
                    )));
                }
                let location = match position.as_ref().map(|p| p.mode.as_str()).unwrap_or("end") {
                    "start" => 0,
                    "end" => document.order_len(),
                    mode => {
                        let anchor = position.as_ref().unwrap().anchor.as_deref().unwrap();
                        if blocks[0].name == Some(anchor) {
                            return Err(read::selector(crate::messages::text(
                                "ndf.patch.mod.apply_operation_inner.a_new_block_cannot_be_its_own",
                            )));
                        }
                        let id = document.named(anchor)?;
                        document.position(id) + usize::from(mode == "after")
                    }
                };
                document.insert(
                    mark(
                        "add",
                        &formatted,
                        None,
                        "",
                        identity,
                        index,
                        leading_comment.as_ref(),
                    ),
                    location,
                )?;
            }
        }
        Operation::Remove {
            selector,
            leading_comment,
            ..
        } => {
            let result = (|| -> Result<()> {
                if selector.kind == "object" {
                    let id = document.select(selector)?;
                    let old = &document.node(id).text;
                    let text = mark(
                        "remove",
                        "",
                        Some(old),
                        "",
                        identity,
                        index,
                        leading_comment.as_ref(),
                    );
                    document.replace(id, text)?;
                } else {
                    let path = selector.value.as_ref().and_then(Value::as_str).unwrap();
                    let parts = read::split_path(path)?;
                    let id = document.reference(&parts[0])?;
                    let source = &document.node(id).text;
                    let selected = selection(source, &parts[1..])?;
                    let text = if selected.entry {
                        splice(
                            source,
                            vec![Edit {
                                range: selected.whole,
                                text: String::new(),
                            }],
                        )?
                    } else {
                        replace_field_with_marker(source, &selected, "", identity, index, "remove")?
                    };
                    document.replace(id, text)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                if error.code.as_deref() == Some("E16") {
                    notices.push(Notice::new(
                        identity,
                        index,
                        crate::messages::text("common.shared.removal_target_is_already_absent"),
                    ));
                } else {
                    return Err(error);
                }
            }
        }
        Operation::Bulk {
            r#match,
            edits,
            recursive,
            expect,
            leading_comment,
            ..
        } => bulk(
            document,
            r#match,
            edits,
            *recursive,
            expect.min_blocks,
            leading_comment.as_ref(),
            identity,
            index,
            notices,
        )?,
    }
    Ok(())
}

pub fn insert_at_path(
    source: &str,
    path: &str,
    value: &Value,
    position: Option<&Position>,
) -> Result<String> {
    let range = read::path_range(source, path)?;
    let next = insert_collection(&source[range.clone()], &format_value(value)?, position)?;
    let output = splice(source, vec![Edit { range, text: next }])?;
    validate(&output)?;
    Ok(output)
}
mod bulk;
mod editing;
pub use bulk::matches;
use bulk::*;
use editing::*;
pub use editing::{insert_collection, reidentify_ids, splice};
#[cfg(test)]
mod tests;
