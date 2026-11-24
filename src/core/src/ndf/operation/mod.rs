use crate::{Diagnostic, Result, templates};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

fn present<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

fn one() -> usize {
    1
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub kind: String,
    pub by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#where: Option<Map<String, Value>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub mode: String,
    #[serde(default)]
    pub anchor: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Comment {
    Text(String),
    Lines(Vec<String>),
}
impl Comment {
    pub fn lines(&self) -> Vec<&str> {
        match self {
            Self::Text(text) => text.lines().collect(),
            Self::Lines(lines) => lines.iter().flat_map(|line| line.lines()).collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Copy {
        selector: Selector,
        destination: Destination,
        #[serde(default)]
        reidentify: bool,
        #[serde(default, rename = "leadingComment")]
        leading_comment: Option<Comment>,
        #[serde(default, rename = "allowNoChange")]
        allow_no_change: Option<String>,
    },
    Modify {
        selector: Selector,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        value: Option<Value>,
        #[serde(default)]
        changes: Option<Map<String, Value>>,
        #[serde(default, rename = "leadingComment")]
        leading_comment: Option<Comment>,
        #[serde(default, rename = "allowNoChange")]
        allow_no_change: Option<String>,
    },
    Add {
        #[serde(default)]
        selector: Option<Selector>,
        value: Value,
        #[serde(default)]
        position: Option<Position>,
        #[serde(default, rename = "leadingComment")]
        leading_comment: Option<Comment>,
        #[serde(default, rename = "allowNoChange")]
        allow_no_change: Option<String>,
    },
    Remove {
        selector: Selector,
        #[serde(default, rename = "leadingComment")]
        leading_comment: Option<Comment>,
        #[serde(default, rename = "allowNoChange")]
        allow_no_change: Option<String>,
    },
    Bulk {
        r#match: BulkMatch,
        edits: Vec<BulkEdit>,
        #[serde(default)]
        recursive: bool,
        #[serde(default)]
        expect: BulkExpectation,
        #[serde(default, rename = "leadingComment")]
        leading_comment: Option<Comment>,
        #[serde(default, rename = "allowNoChange")]
        allow_no_change: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BulkExpectation {
    #[serde(default = "one")]
    pub min_blocks: usize,
}
impl Default for BulkExpectation {
    fn default() -> Self {
        Self { min_blocks: 1 }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkMatch {
    #[serde(default = "all")]
    pub mode: String,
    pub conditions: Vec<Condition>,
}
fn all() -> String {
    "all".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub on: String,
    #[serde(default)]
    pub field: Option<String>,
    pub is: String,
    pub value: Alternatives,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Alternatives {
    One(String),
    Many(Vec<String>),
}
impl Alternatives {
    pub fn values(&self) -> Vec<&str> {
        match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values.iter().map(String::as_str).collect(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BulkEdit {
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub map_entry: Option<String>,
    #[serde(default)]
    pub list: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub set: Option<Value>,
    #[serde(default)]
    pub multiply: Option<f64>,
    #[serde(default)]
    pub insert: Option<Insert>,
    #[serde(default)]
    pub remove_entry: Option<String>,
    #[serde(default)]
    pub set_entry: Option<SetEntry>,
    #[serde(default)]
    pub trailing_comment: Option<Comment>,
    #[serde(default)]
    pub min_changes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Insert {
    pub value: Value,
    #[serde(default = "end")]
    pub position: String,
}
fn end() -> String {
    "end".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetEntry {
    pub index: i64,
    pub value: Value,
}

impl Operation {
    pub fn no_change_reason(&self) -> Option<&str> {
        match self {
            Self::Copy {
                allow_no_change, ..
            }
            | Self::Modify {
                allow_no_change, ..
            }
            | Self::Add {
                allow_no_change, ..
            }
            | Self::Remove {
                allow_no_change, ..
            }
            | Self::Bulk {
                allow_no_change, ..
            } => allow_no_change.as_deref(),
        }
    }
    pub fn from_value(value: Value) -> Result<Self> {
        let operation: Self = serde_json::from_value(value).map_err(|e| invalid(e.to_string()))?;
        if operation
            .no_change_reason()
            .is_some_and(|reason| reason.trim().is_empty() || reason.len() > 1024)
        {
            return Err(invalid(crate::messages::text(
                "ndf.operation.mod.from_value.allownochange_needs_a_nonempty_reason_up_to",
            )));
        }
        match &operation {
            Self::Copy {
                selector,
                destination,
                ..
            } => {
                check_selector(selector)?;
                if selector.kind != "object" || destination.name.trim().is_empty() {
                    return Err(invalid(crate::messages::text(
                        "ndf.operation.mod.from_value.copy_requires_an_object_selector_and_destination",
                    )));
                }
            }
            Self::Modify {
                selector,
                value,
                changes,
                leading_comment,
                ..
            } => {
                check_selector(selector)?;
                let valid = match selector.kind.as_str() {
                    "field" => value.is_some() && changes.is_none() && leading_comment.is_none(),
                    "object" => changes.is_some() && value.is_none(),
                    _ => false,
                };
                if !valid {
                    return Err(invalid(crate::messages::text(
                        "ndf.operation.mod.from_value.field_modify_requires_value_object_modify_requires",
                    )));
                }
            }
            Self::Add {
                selector,
                position,
                leading_comment,
                ..
            } => {
                if let Some(selector) = selector {
                    check_selector(selector)?;
                    if !matches!(selector.kind.as_str(), "field" | "collection") {
                        return Err(invalid(crate::messages::text(
                            "ndf.operation.mod.from_value.top_level_add_takes_no_selector",
                        )));
                    }
                    if selector.kind == "field" && (position.is_some() || leading_comment.is_some())
                    {
                        return Err(invalid(crate::messages::text(
                            "ndf.operation.mod.from_value.field_add_does_not_support_position_or",
                        )));
                    }
                }
                if let Some(position) = position {
                    check_position(position)?;
                }
            }
            Self::Remove {
                selector,
                leading_comment,
                ..
            } => {
                check_selector(selector)?;
                if !matches!(selector.kind.as_str(), "object" | "field")
                    || selector.kind == "field" && leading_comment.is_some()
                {
                    return Err(invalid(crate::messages::text(
                        "ndf.operation.mod.from_value.remove_requires_an_object_or_field_selector",
                    )));
                }
            }
            Self::Bulk { r#match, edits, .. } => {
                if !matches!(r#match.mode.as_str(), "all" | "any")
                    || r#match.conditions.is_empty()
                    || edits.is_empty()
                {
                    return Err(invalid(crate::messages::text(
                        "ndf.operation.mod.from_value.bulk_requires_conditions_edits_and_an_all",
                    )));
                }
                for condition in &r#match.conditions {
                    if !matches!(condition.on.as_str(), "name" | "type" | "text" | "field")
                        || !matches!(
                            condition.is.as_str(),
                            "startsWith"
                                | "endsWith"
                                | "contains"
                                | "notContains"
                                | "equals"
                                | "notEquals"
                                | "hasEntry"
                                | "lacksEntry"
                        )
                        || ((condition.on == "field") != condition.field.is_some())
                        || (matches!(condition.is.as_str(), "hasEntry" | "lacksEntry")
                            && condition.on != "field")
                        || condition
                            .field
                            .as_ref()
                            .is_some_and(|field| field.trim().is_empty())
                        || condition.value.values().is_empty()
                        || condition.value.values().iter().any(|s| s.is_empty())
                    {
                        return Err(invalid(crate::messages::text(
                            "ndf.operation.mod.from_value.invalid_bulk_condition_subject_action_field_or",
                        )));
                    }
                }
                for edit in edits {
                    let targets = [
                        edit.field.is_some(),
                        edit.map_entry.is_some(),
                        edit.list.is_some(),
                    ]
                    .into_iter()
                    .filter(|v| *v)
                    .count();
                    let actions = [
                        edit.set.is_some(),
                        edit.multiply.is_some(),
                        edit.insert.is_some(),
                        edit.remove_entry.is_some(),
                        edit.set_entry.is_some(),
                    ]
                    .into_iter()
                    .filter(|v| *v)
                    .count();
                    let list_action = edit.insert.is_some()
                        || edit.remove_entry.is_some()
                        || edit.set_entry.is_some();
                    if [&edit.field, &edit.map_entry, &edit.list, &edit.remove_entry]
                        .iter()
                        .any(|value| value.as_ref().is_some_and(|text| text.trim().is_empty()))
                    {
                        return Err(invalid(crate::messages::text(
                            "ndf.operation.mod.from_value.bulk_target_names_and_removed_entries_must",
                        )));
                    }
                    if targets != 1
                        || actions != 1
                        || (edit.list.is_some() != list_action)
                        || edit.list.is_some() && edit.trailing_comment.is_some()
                        || edit.multiply.is_some_and(|n| !n.is_finite())
                    {
                        return Err(invalid(crate::messages::text(
                            "ndf.operation.mod.from_value.bulk_edits_require_exactly_one_compatible_target",
                        )));
                    }
                    if let Some(insert) = &edit.insert
                        && !matches!(insert.position.as_str(), "start" | "end")
                    {
                        return Err(invalid(crate::messages::text(
                            "ndf.operation.mod.from_value.bulk_list_insertion_position_must_be_start",
                        )));
                    }
                }
            }
        }
        Ok(operation)
    }
}
fn check_selector(selector: &Selector) -> Result<()> {
    let valid = match (selector.kind.as_str(), selector.by.as_str()) {
        ("field" | "collection", "path") | ("object", "name") => {
            selector
                .value
                .as_ref()
                .is_some_and(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                && selector.r#where.is_none()
        }
        ("object", "index") => {
            selector
                .value
                .as_ref()
                .is_some_and(|v| v.as_i64().is_some())
                && selector.r#where.is_none()
        }
        ("object", "match") => {
            selector.r#where.as_ref().is_some_and(|v| {
                !v.is_empty()
                    && v.values()
                        .all(|value| value.is_string() || value.is_number() || value.is_boolean())
            }) && selector.value.is_none()
        }
        _ => false,
    };
    if !valid {
        return Err(invalid(crate::messages::text(
            "ndf.operation.mod.check_selector.unsupported_selector_shape",
        )));
    }
    Ok(())
}
fn check_position(position: &Position) -> Result<()> {
    if !matches!(position.mode.as_str(), "start" | "end" | "before" | "after")
        || matches!(position.mode.as_str(), "before" | "after")
            && position.anchor.as_ref().is_none_or(|s| s.trim().is_empty())
    {
        return Err(invalid(crate::messages::text(
            "ndf.operation.mod.check_position.before_after_positions_require_a_nonempty_anchor",
        )));
    }
    Ok(())
}
fn invalid(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConfigError",
        reason,
        crate::messages::text(
            "ndf.operation.mod.invalid.use_a_supported_operation_shape_from_docs",
        ),
    )
}

mod expand;
pub use expand::{Identity, Notice, expand};
#[cfg(test)]
mod tests;
