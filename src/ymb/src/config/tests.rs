use super::*;

#[test]
fn writing_unreadable_settings_preserves_the_existing_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.yaml");
    let original = b"version: 2\n";
    fs::write(&path, original).unwrap();
    assert!(
        write(
            &path,
            &json!({"version":2,"variables":{"large":"x".repeat(16 << 20)}})
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    let mut nested = json!(1);
    for _ in 0..129 {
        nested = json!([nested]);
    }
    assert!(write(&path, &json!({"version":2,"variables":{"nested":nested}})).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn written_settings_remain_editable_yaml_and_preserve_values() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.yaml");
    let value = json!({"version":metadata::CONFIG_VERSION,"variables":{"booleanText":"true","numberText":"001","items":[null, false, 1.25, "雪", "two\nlines"]},"mods":{"sample":{"variables":{"scale":1.5}}}});
    write(&path, &value).unwrap();
    let (_, document): (BuilderConfig, _) = load(&path).unwrap();
    assert_eq!(document.value, value);
    let source = fs::read_to_string(&path).unwrap();
    assert!(source.contains("\nmods:\n  sample:\n") && !source.trim_start().starts_with('{'));
}

#[test]
fn documented_defaults_match_the_builder() {
    let example = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ymb.config.yaml"
    ));
    let path = Path::new("ymb.config.yaml");
    let expected = serde_json::to_value(BuilderConfig::default()).unwrap();
    let active: BuilderConfig = decode(&yaml(example, path).unwrap(), path).unwrap();
    assert_eq!(serde_json::to_value(active).unwrap(), expected);
    let defaults = example
        .lines()
        .take_while(|line| *line != "# mods: {}")
        .filter_map(|line| {
            if line.starts_with("#   ")
                || ["# paths:", "# settings:", "# variables: {}"].contains(&line)
            {
                line.strip_prefix("# ")
            } else if !line.starts_with('#') {
                Some(line)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let documented: BuilderConfig = decode(&yaml(&defaults, path).unwrap(), path).unwrap();
    assert_eq!(serde_json::to_value(documented).unwrap(), expected);
}
#[test]
fn marked_yaml_rejects_duplicates_cycles_and_unknown_values() {
    let p = Path::new("sample.yaml");
    for text in [
        "version: 2\nversion: 2",
        "version: 2\nx: &x [*x]",
        "version: 2\nx: .inf",
    ] {
        assert!(yaml(text, p).is_err(), "{text}");
    }
    let document = yaml(
        "version: 2\nvariables:\n  a: &base {health: 10}\n  b: *base\n  __proto__: ordinary data",
        p,
    )
    .unwrap();
    let config: BuilderConfig = decode(&document, p).unwrap();
    assert_eq!(config.variables["a"], config.variables["b"]);
    assert_eq!(config.variables["__proto__"], "ordinary data");
    assert!(decode::<BuilderConfig>(&yaml("version: 2\nunknown: true", p).unwrap(), p).is_err());
    assert!(serde_json::from_value::<GeneratorTest>(json!({"id":"check","whne":"after"})).is_err());
}
#[test]
fn config_versions_and_requirements_use_shared_metadata() {
    let p = Path::new("config.yaml");
    assert!(decode::<BuilderConfig>(&yaml("version: 1", p).unwrap(), p).is_err());
    let current = semver::Version::parse(ymb_core::metadata::VERSION).unwrap();
    let (major, minor, patch) = (current.major, current.minor, current.patch);
    for requirement in [
        major.to_string(),
        format!("{major}.{minor}"),
        format!("{major}.{minor}.{patch}"),
        format!("^{major}"),
        format!("~{major}.{minor}"),
        format!(">={major}, <{}", major + 1),
        format!(">={major}.{minor}, <{}.0", major + 1),
        format!(">={major}.{minor}.{patch}, <{}.0.0", major + 1),
    ] {
        assert!(
            check_requirement(&requirement, p, None).is_ok(),
            "{requirement}"
        );
    }
    for requirement in [
        format!(">={}", major + 1),
        format!("{major}.{}", minor + 1),
        format!("{major}.{minor}.{}", patch + 1),
        "2.0.0.0".into(),
        "2..1".into(),
    ] {
        assert!(
            check_requirement(&requirement, p, None).is_err(),
            "{requirement}"
        );
    }
}

#[test]
fn unsupported_project_versions_need_an_exception_for_this_exact_builder_version() {
    let path = Path::new("config.yaml");
    let current = metadata::VERSION;
    assert!(check_requirement("=999.0.0", path, None).is_err());
    assert!(check_requirement("=999.0.0", path, Some(current)).is_ok());
    assert!(check_requirement("=999.0.0", path, Some("999.0.0")).is_err());
    assert!(check_requirement("invalid", path, Some(current)).is_err());
    assert!(check_requirement("*", path, Some("invalid")).is_err());
}
#[test]
fn operation_locations_keep_yaml_line_numbers() {
    let doc=yaml("version: 2\ntargets:\n  - file: GameData/A.ndf\n    operations:\n      - op: remove\n        selector: {kind: object, by: name, value: Missing}\n",Path::new("patch.yaml")).unwrap();
    assert_eq!(
        doc.lines.get(&vec![
            "targets".into(),
            "0".into(),
            "operations".into(),
            "0".into()
        ]),
        Some(&5)
    );
}
