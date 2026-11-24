use super::*;
const SOURCE: &str = "Root is T(Values = [A(X = 1), A(X = 2), ~/Value] Nested = B(Other = 3))";
#[test]
fn paths_resolve_typed_occurrences_fields_and_scalar_identity() {
    for (path, expected) in [
        ("Root.Values.[A#1].X", "2"),
        ("Root.Values.[X=1].X", "1"),
        ("Root.Values.[value=~/Value]", "~/Value"),
        ("Root.Nested.Other", "3"),
    ] {
        let range = path_range(SOURCE, path).unwrap();
        assert_eq!(&SOURCE[range], expected);
    }
    assert_eq!(
        path_range(SOURCE, "Root.Values.[A]")
            .unwrap_err()
            .code
            .as_deref(),
        Some("E17")
    );
    assert_eq!(
        path_range(SOURCE, "Root.Missing")
            .unwrap_err()
            .code
            .as_deref(),
        Some("E16")
    );
}
#[test]
fn entries_exclude_their_comma_and_preserve_separator() {
    let source = "[A(X = 1), 2]";
    let values = entries(source).unwrap();
    assert_eq!(values[0].text, "A(X = 1)");
    assert_eq!(&source[values[0].span.end..values[0].separator_end], ",");
    assert_eq!(values[1].span.end, values[1].separator_end);
}
#[test]
fn fields_ignore_strings_comments_and_nested_members() {
    let fields = direct_fields(SOURCE).unwrap();
    assert_eq!(
        fields.iter().map(|f| f.name).collect::<Vec<_>>(),
        ["Values", "Nested"]
    );
    assert_eq!(deep_fields(SOURCE, "X").unwrap().len(), 2);
    assert_eq!(split_path("Root.Values.[Label='a.b']").unwrap().len(), 3);
}

#[test]
fn nested_entry_conditions_keep_inner_occurrences_and_equals() {
    let source = r#"Root is T(Items = [
        Turret(Label = "one" Weapons = [Weapon(Ammo = $/Test/First)] Value = 1),
        Turret(Label = "a#0=b" Weapons = [Weapon(Ammo = $/Test/Second)] Value = 2),
    ])"#;
    for path in [
        "Root.Items.[Weapons.[Weapon#0].Ammo=$/Test/Second].Value",
        "Root.Items.[Weapons.[Ammo=$/Test/Second].Ammo=$/Test/Second].Value",
        r#"Root.Items.[Label="a#0=b"].Value"#,
    ] {
        let range = path_range(source, path).unwrap();
        assert_eq!(&source[range], "2", "{path}");
    }
}

#[test]
fn field_index_uses_the_grammar_and_keeps_source_order() {
    let source = r#"Root is T(
        Label = "Fake = 99"
        Child = Inner(Actual = 2)
        // Commented = 100
        Actual = 3
        Named is Nested(Value = 4)
    )"#;
    let found = fields(source).unwrap();
    assert_eq!(
        found.iter().map(|field| field.name).collect::<Vec<_>>(),
        ["Label", "Child", "Actual", "Actual", "Value"]
    );
    let values: Vec<_> = found
        .iter()
        .filter(|field| field.name == "Actual")
        .map(|field| &source[field.value.clone()])
        .collect();
    assert_eq!(values, ["2", "3"]);
    assert!(
        found
            .iter()
            .all(|field| source[field.span.clone()].starts_with(field.name))
    );
    assert!(fields("Root is T(Bad = )").is_err());
}
