use super::*;

pub struct YamlDocument {
    pub value: Value,
    pub lines: BTreeMap<Vec<String>, usize>,
}
pub fn write(path: &Path, value: &Value) -> Result<()> {
    let documents = saphyr::Yaml::load_from_str(&serde_json::to_string(value).unwrap())
        .map_err(|cause| config_error(path, cause.to_string()))?;
    let mut source = String::new();
    saphyr::YamlEmitter::new(&mut source)
        .dump(&documents[0])
        .map_err(|cause| config_error(path, cause.to_string()))?;
    source.push('\n');
    yaml(&source, path)?;
    paths::write_atomic(path, source)
}
pub fn yaml(source: &str, path: &Path) -> Result<YamlDocument> {
    if source.len() > 16 * 1024 * 1024 {
        return Err(config_error(
            path,
            crate::messages::text("config.yaml.yaml.yaml_configuration_exceeds_the_16_mib_limit"),
        ));
    }
    let documents = MarkedYaml::load_from_str(source).map_err(|error| {
        let character = error.marker().index();
        let byte = source
            .char_indices()
            .nth(character)
            .map_or(source.len(), |(at, _)| at);
        config_error(path, error.info())
            .code("E5")
            .located(source, byte)
    })?;
    if documents.len() != 1 {
        return Err(config_error(
            path,
            crate::messages::text(
                "config.yaml.yaml.configuration_must_contain_exactly_one_yaml_document",
            ),
        ));
    }
    let mut lines = BTreeMap::new();
    let mut budget = 1_000_000;
    let value = yaml_value(
        &documents[0],
        &mut Vec::new(),
        &mut lines,
        path,
        0,
        &mut budget,
    )?;
    if !value.is_object() {
        return Err(config_error(
            path,
            crate::messages::text("config.yaml.yaml.configuration_must_be_a_mapping"),
        ));
    }
    Ok(YamlDocument { value, lines })
}
pub(super) fn yaml_value(
    node: &MarkedYaml<'_>,
    location: &mut Vec<String>,
    lines: &mut BTreeMap<Vec<String>, usize>,
    path: &Path,
    depth: usize,
    budget: &mut usize,
) -> Result<Value> {
    if depth > 128 || *budget == 0 {
        return Err(config_error(
            path,
            crate::messages::text(
                "config.yaml.yaml_value.yaml_nesting_or_expansion_exceeds_the_limit",
            ),
        ));
    }
    *budget -= 1;
    lines.insert(location.clone(), node.span.start.line());
    match &node.data {
        YamlData::Value(value) => Ok(match value {
            Scalar::Null => Value::Null,
            Scalar::Boolean(v) => json!(v),
            Scalar::Integer(v) => json!(v),
            Scalar::FloatingPoint(v) => ymb_core::templates::number(v.0)?,
            Scalar::String(v) => Value::String(v.to_string()),
        }),
        YamlData::Sequence(values) => {
            let mut out = Vec::new();
            for (index, value) in values.iter().enumerate() {
                location.push(index.to_string());
                out.push(yaml_value(value, location, lines, path, depth + 1, budget)?);
                location.pop();
            }
            Ok(Value::Array(out))
        }
        YamlData::Mapping(values) => {
            let mut out = Map::new();
            for (key, value) in values {
                let name = match &key.data {
                    YamlData::Value(Scalar::String(name)) => name.to_string(),
                    _ => {
                        return Err(config_error(
                            path,
                            crate::messages::text(
                                "config.yaml.yaml_value.yaml_mapping_keys_must_be_strings",
                            ),
                        ));
                    }
                };
                location.push(name.clone());
                out.insert(
                    name,
                    yaml_value(value, location, lines, path, depth + 1, budget)?,
                );
                location.pop();
            }
            Ok(Value::Object(out))
        }
        YamlData::Alias(_) => Err(config_error(
            path,
            crate::messages::text("config.yaml.yaml_value.unresolved_or_cyclic_yaml_alias"),
        )),
        _ => Err(config_error(
            path,
            crate::messages::text("config.yaml.yaml_value.unsupported_yaml_tag_or_scalar_value"),
        )),
    }
}
pub(super) fn decode<T: DeserializeOwned>(document: &YamlDocument, path: &Path) -> Result<T> {
    if document.value.get("scripts").is_some() {
        return Err(config_error(
            path,
            crate::messages::text("config.yaml.decode.this_project_registers_typescript_scripts"),
        )
        .detail(crate::messages::text(
            "config.yaml.decode.register_native_generators_in_config_format_2",
        )));
    }
    let version = document
        .value
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            config_error(
                path,
                crate::messages::text("config.yaml.decode.version_must_be_an_integer"),
            )
        })?;
    if version != u64::from(metadata::CONFIG_VERSION) {
        return Err(config_error(
            path,
            crate::messages::format(
                "config.yaml.decode.config_version_version_is_unsupported_this_ymb",
                &[
                    ("VERSION", format!("{}", version)),
                    ("ARG1", format!("{}", metadata::CONFIG_VERSION)),
                ],
            ),
        )
        .code("E6"));
    }
    serde_path_to_error::deserialize(document.value.clone()).map_err(|error| {
        let location: Vec<String> = error
            .path()
            .iter()
            .filter_map(|segment| match segment {
                serde_path_to_error::Segment::Seq { index } => Some(index.to_string()),
                serde_path_to_error::Segment::Map { key }
                | serde_path_to_error::Segment::Enum { variant: key } => Some(key.clone()),
                serde_path_to_error::Segment::Unknown => None,
            })
            .collect();
        let mut diagnostic = config_error(path, error.inner().to_string())
            .with("configField", error.path().to_string());
        diagnostic.line = (0..=location.len())
            .rev()
            .find_map(|end| document.lines.get(&location[..end]).copied());
        diagnostic
    })
}
pub fn load<T: DeserializeOwned>(path: &Path) -> Result<(T, YamlDocument)> {
    let source = String::from_utf8(paths::read_limited(path, 16 * 1024 * 1024)?)
        .map_err(|e| config_error(path, e.to_string()))?;
    let document = yaml(&source, path)?;
    let value = decode(&document, path)?;
    Ok((value, document))
}
