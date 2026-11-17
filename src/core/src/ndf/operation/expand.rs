use super::*;
use templates::budget::{Budget, map_bytes};

pub fn expand(authored: &[Value], variables: &Value) -> Result<Vec<(Operation, usize)>> {
    let mut result = Vec::new();
    let mut budget = Budget::default();
    for (index, value) in authored.iter().enumerate() {
        expand_one(value, variables, index, 0, &mut result, &mut budget)?;
    }
    Ok(result)
}
fn expand_one(
    value: &Value,
    variables: &Value,
    origin: usize,
    depth: usize,
    out: &mut Vec<(Operation, usize)>,
    budget: &mut Budget,
) -> Result<()> {
    if depth > 64 {
        return Err(invalid(crate::messages::text(
            "ndf.operation.expand.expand_one.foreach_nesting_exceeds_the_limit",
        )));
    }
    if let Some(items) = value.get("forEach") {
        let object = value.as_object().unwrap();
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "forEach" | "as" | "do"))
        {
            return Err(invalid(crate::messages::text(
                "ndf.operation.expand.expand_one.unknown_foreach_property",
            )));
        }
        let binding = value
            .get("as")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                invalid(crate::messages::text(
                    "ndf.operation.expand.expand_one.foreach_requires_as",
                ))
            })?;
        if !binding
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || i > 0 && b.is_ascii_digit())
        {
            return Err(invalid(crate::messages::text(
                "ndf.operation.expand.expand_one.foreach_binding_is_not_an_expression_identifier",
            )));
        }
        let operations = value
            .get("do")
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                invalid(crate::messages::text(
                    "ndf.operation.expand.expand_one.foreach_requires_a_nonempty_do_list",
                ))
            })?;
        let items = templates::resolve_in_budget(items, variables, budget)?;
        let items = items.as_array().ok_or_else(|| {
            invalid(crate::messages::text(
                "ndf.operation.expand.expand_one.foreach_must_resolve_to_a_list",
            ))
        })?;
        for (index, item) in items.iter().enumerate() {
            budget.reserve(map_bytes(2).saturating_add(binding.len().saturating_mul(2) + 5))?;
            let mut bound = budget.copy(variables)?;
            let map = bound.as_object_mut().ok_or_else(|| {
                invalid(crate::messages::text(
                    "ndf.operation.expand.expand_one.variables_must_be_an_object",
                ))
            })?;
            map.insert(binding.into(), budget.copy(item)?);
            map.insert(format!("{binding}Index"), serde_json::json!(index));
            for operation in operations {
                expand_one(operation, &bound, origin, depth + 1, out, budget)?;
            }
        }
    } else {
        budget.reserve(std::mem::size_of::<(Operation, usize)>())?;
        out.push((
            Operation::from_value(templates::resolve_in_budget(value, variables, budget)?)?,
            origin,
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub mod_id: String,
    pub mod_name: String,
    pub patch_id: String,
    pub path: String,
    #[serde(default)]
    pub patch_config_path: Option<String>,
    #[serde(default)]
    pub operation_lines: Vec<usize>,
}
impl Identity {
    pub fn attach(&self, mut error: Box<Diagnostic>, index: usize) -> Box<Diagnostic> {
        error = error
            .at(&self.path)
            .with("modId", &self.mod_id)
            .with("modName", &self.mod_name)
            .with("patchId", &self.patch_id)
            .with("operationIndex", index);
        if let Some(path) = &self.patch_config_path {
            error = error.with("patchConfigPath", path);
        }
        if let Some(line) = self.operation_lines.get(index) {
            error = error.with("operationLine", line);
        }
        error
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    #[serde(default = "notice_code")]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<Selector>,
    pub path: String,
    pub mod_id: String,
    pub mod_name: String,
    pub patch_id: String,
    pub operation_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_config_path: Option<String>,
    pub reason: String,
    pub suggestion: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
}
fn notice_code() -> String {
    "W8".into()
}
impl Notice {
    pub fn new(identity: &Identity, index: usize, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            code: if reason
                == crate::messages::text("common.shared.removal_target_is_already_absent")
            {
                "W9"
            } else {
                "W8"
            }
            .into(),
            selector: None,
            path: identity.path.clone(),
            mod_id: identity.mod_id.clone(),
            mod_name: identity.mod_name.clone(),
            patch_id: identity.patch_id.clone(),
            operation_index: index,
            operation_line: identity.operation_lines.get(index).copied(),
            patch_config_path: identity.patch_config_path.clone(),
            reason,
            expected: None,
            suggestion: crate::messages::text(
                "ndf.operation.expand.new.check_whether_this_operation_is_still_needed",
            )
            .into(),
        }
    }
}
