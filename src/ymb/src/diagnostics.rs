use serde_json::{Map, Value, json};
use ymb_core::Diagnostic;

pub fn severity(code: &str) -> &'static str {
    match code.as_bytes().first() {
        Some(b'E') => "error",
        Some(b'W') => "warning",
        Some(b'I') => "info",
        _ => "error",
    }
}

pub fn errors(errors: &[Diagnostic]) -> Value {
    group(
        errors
            .iter()
            .map(|error| serde_json::to_value(error).unwrap())
            .collect(),
    )
}

pub fn data(data: &Value) -> Value {
    let mut messages = Vec::new();
    if let Some(summary) = data["summary"].as_str() {
        messages.push(json!({"code":"I1","reason":summary}));
    }
    for (key, default) in [("errors", "E37"), ("warnings", "W7"), ("notices", "I7")] {
        if let Some(items) = data[key].as_array() {
            messages.extend(items.iter().map(|item| {
                let mut item = item.clone();
                if item["code"].is_null() {
                    item["code"] = json!(default);
                }
                item
            }));
        }
    }
    if data["recoveredInterruptedOperation"] == true {
        messages.push(json!({"code":"I6","reason":crate::messages::text("diagnostics.data.rolled_back_an_interrupted_operation_before_starting")}));
    }
    if let Some(outputs) = data["outputs"].as_array() {
        for output in outputs {
            let mut item = output.clone();
            item["path"] = item["targetRelativePath"].take();
            let (code, message) = if item["state"] == "absent" {
                (
                    "I11",
                    crate::messages::text("diagnostics.data.files_prepared_for_removal"),
                )
            } else {
                (
                    "I10",
                    crate::messages::text("diagnostics.data.files_prepared_for_writing"),
                )
            };
            item["code"] = json!(code);
            item["reason"] = json!(message);
            messages.push(item);
        }
    }
    group(messages)
}

pub fn group(items: Vec<Value>) -> Value {
    fn append(
        mut item: Value,
        groups: &mut Map<String, Value>,
        indices: &mut std::collections::HashMap<(String, String), usize>,
        seen: &mut std::collections::HashSet<(String, String, String)>,
    ) {
        if let Some(related) = item["related"].as_array().filter(|items| !items.is_empty()) {
            for child in related {
                append(child.clone(), groups, indices, seen);
            }
            return;
        }
        let code = item["code"]
            .as_str()
            .unwrap_or_else(|| {
                item["category"]
                    .as_str()
                    .map_or("I7", ymb_core::diagnostic::error_code)
            })
            .to_owned();
        let Some(reason) = item["reason"].as_str().map(str::to_owned) else {
            return;
        };
        let suggestion = item["suggestion"].as_str().map(str::to_owned);
        let entry = groups.entry(code.clone()).or_insert_with(|| {
            json!({
                "severity":severity(&code), "count":0, "messages":[]
            })
        });
        entry["count"] = json!(entry["count"].as_u64().unwrap() + 1);
        let messages = entry["messages"].as_array_mut().unwrap();
        let index = *indices
            .entry((code.clone(), reason.clone()))
            .or_insert_with(|| {
                messages.push(json!({"message":reason,"count":0,"targets":[],"suggestions":[]}));
                messages.len() - 1
            });
        let message = &mut messages[index];
        message["count"] = json!(message["count"].as_u64().unwrap() + 1);
        if let Some(suggestion) = suggestion {
            let suggestions = message["suggestions"].as_array_mut().unwrap();
            if !suggestions.contains(&json!(suggestion)) {
                suggestions.push(json!(suggestion));
            }
        }
        let target = item.as_object_mut().unwrap();
        for key in ["code", "reason", "suggestion", "related"] {
            target.remove(key);
        }
        target.retain(|_, value| !value.is_null());
        if !target.is_empty() {
            let targets = message["targets"].as_array_mut().unwrap();
            if seen.insert((code, reason, serde_json::to_string(&item).unwrap())) {
                targets.push(item);
            }
        }
    }
    let mut groups = Map::new();
    let mut indices = std::collections::HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for item in items {
        append(item, &mut groups, &mut indices, &mut seen);
    }
    Value::Object(groups)
}

pub fn attach(report: &mut Value) {
    normalize_paths(report, false);
    report["diagnostics"] = if let Some(errors) = report["errors"].as_array() {
        group(errors.clone())
    } else {
        data(&report["data"])
    };
    let mut counts = json!({"error":0,"warning":0,"info":0});
    for entry in report["diagnostics"].as_object().unwrap().values() {
        let severity = entry["severity"].as_str().unwrap();
        counts[severity] =
            json!(counts[severity].as_u64().unwrap() + entry["count"].as_u64().unwrap());
    }
    report["diagnosticCounts"] = counts;
}

fn normalize_paths(value: &mut Value, path_field: bool) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let path_field = key.ends_with("Path")
                    || key.ends_with("Root")
                    || matches!(
                        key.as_str(),
                        "path"
                            | "paths"
                            | "files"
                            | "protectedPaths"
                            | "sourceMods"
                            | "dist"
                            | "archive"
                            | "deploy"
                            | "cargo"
                            | "rustc"
                            | "sysroot"
                            | "engine"
                            | "executable"
                    );
                normalize_paths(value, path_field);
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| normalize_paths(item, path_field)),
        Value::String(text)
            if path_field && (text.starts_with(r"\\?\") || text.starts_with("//?/")) =>
        {
            *text = ymb_core::paths::display(&*text);
        }
        _ => (),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_and_grouped_diagnostics_use_readable_paths() {
        let mut report = json!({"data":{"previewPath":r"\\?\C:\Mods\YMB\.ymb\build\output", "projects":[{"name":r"\\?\C:\literal name"}], "paths":[r"\\?\UNC\server\share\file.ndf"], "notices":[{"code":"I4","reason":"Expected","path":"//?/C:/Mods/GameData/A.ndf"}]}});
        attach(&mut report);
        assert_eq!(
            report["data"]["projects"][0]["name"],
            r"\\?\C:\literal name"
        );
        assert_eq!(report["data"]["paths"][0], "//server/share/file.ndf");
        assert_eq!(
            report["data"]["previewPath"],
            "C:/Mods/YMB/.ymb/build/output"
        );
        assert_eq!(
            report["diagnostics"]["I4"]["messages"][0]["targets"][0]["path"],
            "C:/Mods/GameData/A.ndf"
        );
    }
    #[test]
    fn codes_group_messages_and_keep_each_target_and_source() {
        let mut failed = json!({"errors":[*Diagnostic::new("GeneratorError", "Failed.", "Fix it.").code("producer.failure")]});
        attach(&mut failed);
        assert_eq!(failed["diagnosticCounts"]["error"], 1);
        assert_eq!(failed["diagnosticCounts"]["info"], 0);
        let grouped = group(vec![
            json!({"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf","selector":{"value":"A"},"operationIndex":0,"patchConfigPath":"patch.yaml","operationLine":12}),
            json!({"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf","selector":{"value":"B"},"operationIndex":1,"patchConfigPath":"patch.yaml","operationLine":15}),
            json!({"code":"E19","reason":"Another message.","path":"GameData/B.ndf"}),
        ]);
        assert_eq!(grouped["E19"]["severity"], "error");
        assert_eq!(grouped["E19"]["count"], 3);
        let messages = grouped["E19"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["targets"].as_array().unwrap().len(), 2);
        assert_eq!(messages[0]["targets"][1]["operationLine"], 15);
        let errors = Diagnostic::group(vec![
            *Diagnostic::new("ConfigError", "Invalid option.", "Fix it.").at("a.yaml"),
            *Diagnostic::new("ConfigError", "Invalid option.", "Fix it.").at("b.yaml"),
        ])
        .unwrap();
        let grouped = super::errors(&[*errors]);
        assert_eq!(
            grouped["E4"]["messages"][0]["targets"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
