use serde_json::{Value, json};
use ymb_sdk::{
    Result,
    core::{
        generated as g,
        ndf::{
            self,
            lexer::{Kind, Lexer},
            operation::{Identity, Position},
            read, values,
        },
        templates,
    },
    values as checks,
};
fn normalize(v: &Value) -> Value {
    match v {
        Value::Object(m) if m.contains_key("$undefined") => Value::Null,
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
        _ => v.clone(),
    }
}
fn missing<T>(result: Result<T>) -> Result<Option<T>> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.code.as_deref() == Some("E16") => Ok(None),
        Err(e) => Err(e),
    }
}
fn blocks(source: &str, nested: bool) -> Result<Value> {
    let found = if nested {
        read::objects(source)?
    } else {
        ndf::scan(source)?
    };
    Ok(Value::Array(
        found
            .iter()
            .map(|b| json!({"name":b.name,"typeName":b.type_name,"text":&source[b.span.clone()]}))
            .collect(),
    ))
}
fn field(source: &str, name: &str, deep: bool, range: bool, comment: bool) -> Result<Value> {
    let fields = if deep {
        read::deep_fields(source, name)?
    } else {
        read::direct_fields(source)?
    };
    let Some(f) = fields.iter().find(|f| f.name == name) else {
        return Ok(Value::Null);
    };
    if !range {
        return Ok(json!(&source[f.value.clone()]));
    }
    let mut value = json!({"text":&source[f.span.clone()],"valueText":&source[f.value.clone()]});
    if comment {
        value["trailingComment"] =
            read::trailing_comment(source, f).map_or(Value::Null, |v| json!(v))
    }
    Ok(value)
}
fn regions(source: &str) -> Result<Value> {
    Ok(Value::Array(g::regions(source)?.iter().map(|r|json!({"id":r.id,"sourcePath":r.source_path,"fullText":&source[r.full.clone()],"innerText":&source[r.inner.clone()]})).collect()))
}
fn run(c: &Value) -> Result<Value> {
    let name = c["name"].as_str().unwrap();
    let a = &c["args"];
    let s = |i: usize| a[i].as_str().unwrap();
    match name {
        "expression.evaluate" => {
            templates::resolve(&json!(format!("{}{{{}}}", '$', s(0))), &normalize(&a[1]))
        }
        "template.resolve" => templates::resolve(&normalize(&a[0]), &normalize(&a[1])),
        "patch.apply" => {
            let operations: Vec<Value> =
                serde_json::from_value(a[1]["operations"].clone()).unwrap();
            let identity: Identity = serde_json::from_value(a[2].clone()).unwrap();
            Ok(json!(
                ndf::patch::apply(
                    s(0),
                    &ndf::operation::expand(&operations, &json!({}))?,
                    &identity
                )?
                .text
            ))
        }
        "ndf.validate" => Ok(json!({"ok":ndf::validate(s(0)).is_ok()})),
        "ndf.assertValid" => {
            ndf::validate(s(0))?;
            Ok(Value::Null)
        }
        "ndf.findTopLevelBlocks" => blocks(s(0), false),
        "ndf.findObjects" => blocks(s(0), true),
        "ndf.findNamedBlock" => {
            let found = ndf::scan(s(0))?;
            Ok(missing(read::select_block(&found, s(1)))?.map_or(
                Value::Null,
                |b| json!({"name":b.name,"typeName":b.type_name,"text":&s(0)[b.span.clone()]}),
            ))
        }
        "ndf.findField"
        | "ndf.findFieldDeep"
        | "ndf.findFieldWithComment"
        | "ndf.readField"
        | "ndf.readFieldDeep" => field(
            s(0),
            s(1),
            name.ends_with("Deep"),
            name.starts_with("ndf.find"),
            name.ends_with("Comment"),
        ),
        "ndf.readFields" | "ndf.readFieldsDeep" => {
            let mut map = serde_json::Map::new();
            for key in a[1].as_array().unwrap() {
                let value = field(
                    s(0),
                    key.as_str().unwrap(),
                    name.ends_with("Deep"),
                    false,
                    false,
                )?;
                if !value.is_null() {
                    map.insert(key.as_str().unwrap().into(), value);
                }
            }
            Ok(Value::Object(map))
        }
        "ndf.readPath" => {
            let range = if a[1].is_string() {
                read::path_range(s(0), s(1))
            } else {
                read::path_segments(
                    s(0),
                    &serde_json::from_value::<Vec<String>>(a[1].clone()).unwrap(),
                )
            };
            Ok(missing(range)?.map_or(Value::Null, |r| json!(&s(0)[r])))
        }
        "ndf.readNumericDefinitions" => Ok(Value::Object(read::numeric_definitions(s(0))?)),
        "ndf.extractBody" | "ndf.extractCollection" => {
            let range = if name.ends_with("Body") {
                read::first_body(s(0))?
            } else {
                read::first_collection(s(0))?
            };
            Ok(range.map_or(Value::Null, |r| json!({"text":&s(0)[r]})))
        }
        "ndf.findCollectionEntries" => Ok(Value::Array(
            read::entries(s(0))?
                .iter()
                .map(|e| json!({"text":e.text,"typeName":e.type_name}))
                .collect(),
        )),
        "ndf.parseValue" => Ok(serde_json::to_value(values::parse_scalar(s(0))).unwrap()),
        "ndf.parseList" => Ok(serde_json::to_value(values::parse_list(s(0))?).unwrap()),
        "ndf.formatValue" => Ok(json!(values::format_value(&a[0])?)),
        "ndf.stripComments" => Ok(json!(values::strip_comments(s(0)))),
        "ndf.matches" => Ok(json!(ndf::patch::matches(
            a[1]["text"].as_str().unwrap(),
            a[1]["name"].as_str(),
            a[1]["typeName"].as_str().unwrap(),
            &serde_json::from_value(a[0].clone()).unwrap()
        )?)),
        "ndf.insertIntoCollection" => {
            let pos = &a[3]["position"];
            let position = if pos.is_string() {
                Some(Position {
                    mode: pos.as_str().unwrap().into(),
                    anchor: None,
                })
            } else if let Some(before) = pos["before"].as_str() {
                Some(Position {
                    mode: "before".into(),
                    anchor: Some(before.into()),
                })
            } else {
                pos["after"].as_str().map(|after| Position {
                    mode: "after".into(),
                    anchor: Some(after.into()),
                })
            };
            Ok(json!(ndf::patch::insert_at_path(
                s(0),
                s(1),
                &a[2],
                position.as_ref()
            )?))
        }
        "ndf.generatedBlockMarkers" => {
            let (start, end) = g::markers(s(0))?;
            Ok(json!({"start":start,"end":end}))
        }
        "generated.renderGeneratedBlock" | "ndf.renderGeneratedBlock" => {
            let blocks = serde_json::from_value::<Vec<String>>(a[0]["blocks"].clone()).unwrap();
            Ok(json!(g::render(
                a[0]["ownerId"].as_str().unwrap(),
                &blocks,
                a[0]["title"].as_str(),
                a[0]["sourcePath"].as_str()
            )?))
        }
        "generated.listGeneratedBlocks" | "ndf.listGeneratedBlocks" => regions(s(0)),
        "generated.stripGeneratedBlocks" | "ndf.stripGeneratedBlocks" => Ok(json!(g::strip(s(0))?)),
        "generated.upsertGeneratedBlock" => Ok(json!(g::upsert(s(0), s(1), s(2))?)),
        "values.record" => Ok(Value::Object(checks::record(&a[0], s(1))?.clone())),
        "values.string" => Ok(json!(checks::string(&a[0], s(1))?)),
        "values.optionalString" => Ok(json!(checks::optional_string(
            if a[0].get("$undefined") == Some(&json!(true)) {
                None
            } else {
                Some(&a[0])
            },
            s(1)
        )?)),
        "values.boolean" => Ok(json!(checks::boolean(&a[0], s(1))?)),
        "values.stringArray" => Ok(json!(checks::string_array(&a[0], s(1))?)),
        "values.oneOf" => Ok(json!(checks::one_of(
            &a[0],
            s(1),
            &a[2]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect::<Vec<_>>()
        )?)),
        "values.positiveInteger" => Ok(json!(checks::positive_integer(&a[0], s(1))?)),
        _ => panic!("Unmapped reference function: {name}"),
    }
}
fn project(value: &Value) -> Value {
    match value {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| {
                    ![
                        "start",
                        "end",
                        "valueStart",
                        "valueEnd",
                        "separatorStart",
                        "separatorEnd",
                        "error",
                    ]
                    .contains(&k.as_str())
                })
                .map(|(k, v)| (k.clone(), project(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(project).collect()),
        _ => normalize(value),
    }
}
fn contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e
            .iter()
            .all(|(k, v)| contains(a.get(k).unwrap_or(&Value::Null), v)),
        (Value::Array(a), Value::Array(e)) => {
            a.len() == e.len() && a.iter().zip(e).all(|(a, e)| contains(a, e))
        }
        (Value::Number(a), Value::Number(e)) => a.as_f64() == e.as_f64(),
        _ => actual == expected,
    }
}
fn tokens(source: &str) -> Vec<String> {
    let mut lexer = Lexer::new(source, 0);
    let mut out = Vec::new();
    loop {
        let t = lexer.next_token().unwrap();
        if t.kind == Kind::Eof {
            return out;
        }
        if t.text == "]" && out.last().is_some_and(|s| s == ",") {
            out.pop();
        }
        out.push(t.text.into())
    }
}
fn test_group(prefixes: &[&str]) {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../fixtures/reference-tools.json")).unwrap();
    let mut errors = Vec::new();
    for (i, c) in cases.iter().enumerate().filter(|(_, c)| {
        prefixes
            .iter()
            .any(|p| c["name"].as_str().unwrap().starts_with(p))
    }) {
        let actual = run(c);
        if c["error"] == true {
            if actual.is_ok() {
                errors.push(format!(
                    "{i} {} accepted rejected case: {:?}",
                    c["name"], c["args"]
                ))
            }
            continue;
        }
        let actual = match actual {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{i} {}: {e}; {:?}", c["name"], c["args"]));
                continue;
            }
        };
        let mut expected = normalize(c.get("result").unwrap_or(&Value::Null));
        if matches!(
            c["name"].as_str(),
            Some("ndf.findField" | "ndf.findFieldDeep" | "ndf.findFieldWithComment")
        ) && let Some(m) = expected.as_object_mut()
        {
            m.remove("text");
        }
        let name = c["name"].as_str().unwrap();
        let same = if name == "patch.apply"
            || name == "ndf.insertIntoCollection"
            || name == "ndf.readField"
            || name == "ndf.readFieldDeep"
        {
            let a = tokens(actual.as_str().unwrap());
            let e = tokens(expected.as_str().unwrap());
            a.len() == e.len()
                && a.iter().zip(&e).all(|(a, e)| {
                    a == e
                        || (a.starts_with("GUID:{")
                            && e.starts_with("GUID:{")
                            && !c["args"].to_string().contains(e))
                })
        } else {
            contains(&project(&actual), &project(&expected))
        };
        if !same {
            errors.push(format!(
                "{i} {name}: expected {expected}; actual {actual}; args {:?}",
                c["args"]
            ))
        }
    }
    assert!(
        errors.is_empty(),
        "{} mismatches:\n{}",
        errors.len(),
        errors.join("\n")
    );
}
#[test]
fn expression_contract() {
    test_group(&["expression."])
}
#[test]
fn template_contract() {
    test_group(&["template."])
}
#[test]
fn patch_contract() {
    test_group(&["patch."])
}
#[test]
fn ndf_tools_contract() {
    test_group(&["ndf."])
}
#[test]
fn generated_regions_contract() {
    test_group(&["generated."])
}
#[test]
fn value_checks_contract() {
    test_group(&["values."])
}
