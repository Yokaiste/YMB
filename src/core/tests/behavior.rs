use serde::Deserialize;
use serde_json::Value;
use ymb_core::{
    ndf::{
        self,
        lexer::{Kind, Lexer},
        operation::{Identity, expand},
    },
    templates,
};
#[derive(Deserialize)]
struct Case {
    name: String,
    source: String,
    operations: Vec<Value>,
    expected: Option<String>,
    error: Option<String>,
}
fn tokens(source: &str) -> Vec<String> {
    let mut lexer = Lexer::new(source, 0);
    let mut result = Vec::new();
    loop {
        let token = lexer.next_token().unwrap();
        if token.kind == Kind::Eof {
            break;
        }
        result.push(token.text.to_owned());
    }
    result
}
#[test]
fn recorded_patch_behavior_matches_token_for_token() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../fixtures/behavior.json")).unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let identity = Identity {
            mod_id: "compat".into(),
            mod_name: "Compatibility".into(),
            patch_id: "main".into(),
            path: "GameData/Compat.ndf".into(),
            ..Default::default()
        };
        let result = expand(&case.operations, &serde_json::json!({}))
            .and_then(|ops| ndf::patch::apply(&case.source, &ops, &identity));
        match (case.expected, result) {
            (Some(expected), Ok(actual)) => {
                if tokens(&expected) != tokens(&actual.text) {
                    failures.push(format!(
                        "{}: token mismatch
Expected {:?}
Actual {:?}",
                        case.name,
                        tokens(&expected),
                        tokens(&actual.text)
                    ));
                }
            }
            (Some(_), Err(error)) => failures.push(format!("{}: {error}", case.name)),
            (None, Ok(_)) => failures.push(format!(
                "{}: accepted input rejected by the recorded behavior: {:?}",
                case.name, case.error
            )),
            (None, Err(_)) => (),
        }
    }
    assert!(
        failures.is_empty(),
        "{}",
        failures.join(
            "

"
        )
    );
}
#[test]
fn small_edits_in_large_files_skip_unchanged_text_before_budgeting() {
    let prefix = "unchanged é 🦀
"
    .repeat(300_000);
    let before = format!(
        "{prefix}old
last
"
    );
    let after = format!(
        "{prefix}new
last
"
    );
    let budget = ymb_core::text::DiffBudget {
        max_work: 10,
        max_side_bytes: 100,
        max_combined_bytes: 200,
    };
    let edits = ymb_core::text::changes(&before, &after, budget).unwrap();
    assert_eq!(ymb_core::text::apply(&before, &edits).unwrap(), after);
}
#[test]
fn diffs_reconstruct_unicode_and_empty_endings() {
    for before in [
        "",
        "one",
        "one
",
        "é🦀
last",
        "a
b
",
        "a
b
c
",
    ] {
        for after in [
            "",
            "different",
            "one
",
            "é🦀
new",
            "a
b",
            "a
x
c
",
        ] {
            let edits = ymb_core::text::changes(before, after, Default::default()).unwrap();
            assert_eq!(
                ymb_core::text::apply(before, &edits).unwrap(),
                after,
                "{before:?} -> {after:?}"
            );
        }
    }
}
#[test]
fn numeric_definitions_accept_spacing_and_exclude_expressions() {
    let source = "First\tis\t41
export Second is
 1.0e2
Root is T(Values = [Nested is 11])
Last is -2 // comment
Expression is 10 * 20";
    assert_eq!(
        ndf::read::numeric_definitions(source).unwrap(),
        serde_json::json!({"First":41,"Second":100,"Last":-2})
            .as_object()
            .unwrap()
            .clone()
    );
}
#[test]
fn field_reader_selects_the_body_after_metadata() {
    let source = "A is T meta(Label = 'metadata')(Value = 3)";
    let fields = ndf::read::direct_fields(source).unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].name, "Value");
}
#[test]
fn cartesian_replaces_placeholders_once() {
    let value = templates::resolve(
        &serde_json::json!("${cartesian(['{right}'], ['x'], '{left}:{right}')}"),
        &serde_json::json!({}),
    )
    .unwrap();
    assert_eq!(value, serde_json::json!(["{right}:x"]));
}
#[test]
fn malformed_inputs_and_byte_offsets_do_not_panic() {
    let alphabet = [
        'a', 'é', '🦀', '(', ')', '[', ']', '/', '\'', '"', '\n', '=', ',', ' ',
    ];
    let mut state = 13u64;
    for _ in 0..1000 {
        let mut source = String::new();
        for _ in 0..40 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            source.push(alphabet[(state as usize) % alphabet.len()]);
        }
        let _ = ndf::validate(&source);
        let _ = ndf::scan(&source);
    }
    assert!(Lexer::new("é", 1).next_token().is_err());
    assert!(Lexer::new("x", 2).next_token().is_err());
}

#[test]
fn generated_regions_merge_independent_owners_and_preserve_other_text() {
    use ymb_core::{generated as g, text::DiffBudget};
    let a = g::render("a", &["A is 1".into()], None, None).unwrap();
    let b = g::render("b", &["B is 2".into()], None, None).unwrap();
    let base = "Header is 0\n";
    let current = g::upsert(base, &a, "a").unwrap();
    let next = g::upsert(base, &b, "b").unwrap();
    let merged = g::merge(base, &current, &next, &["b".into()], DiffBudget::default())
        .unwrap()
        .unwrap();
    assert!(merged.contains(&a) && merged.contains(&b));
    assert_eq!(g::strip(&merged).unwrap(), base);
    let changed = current.replace("Header is 0", "Header is 9");
    let merged = g::merge(base, &changed, &next, &["b".into()], Default::default())
        .unwrap()
        .unwrap();
    assert!(merged.contains("Header is 9"));
    assert!(merged.contains(&a) && merged.contains(&b));
    assert!(g::merge(base, &current, &next, &["a".into()], Default::default()).is_err());
}
#[test]
fn generated_regions_handle_middle_insertion_removal_and_no_final_newline() {
    use ymb_core::generated as g;
    let a = g::render("a", &["A is 1".into()], None, None).unwrap();
    let b = g::render("b", &["B is 2".into()], None, None).unwrap();
    let base = "First is 0\nLast is 1\n";
    let current = g::upsert(base, &a, "a").unwrap();
    let incoming = format!("First is 0\n{b}Last is 1\n");
    let merged = g::merge(base, &current, &incoming, &["b".into()], Default::default())
        .unwrap()
        .unwrap();
    assert!(merged.find(&b).unwrap() < merged.find("Last is").unwrap());
    assert!(merged.contains(&a));
    let base = g::upsert("Header is 0", &a, "a").unwrap();
    let current = g::upsert(&base, &b, "b").unwrap();
    let removed = g::merge(
        &base,
        &current,
        "Header is 0\n",
        &["a".into()],
        Default::default(),
    )
    .unwrap()
    .unwrap();
    assert!(!removed.contains(&a));
    assert!(removed.contains(&b));
    let a = g::upsert("Header is 0", &a, "a").unwrap();
    let b = g::upsert("Header is 0", &b, "b").unwrap();
    let merged = g::merge("Header is 0", &a, &b, &["b".into()], Default::default())
        .unwrap()
        .unwrap();
    assert_eq!(g::strip(&merged).unwrap(), "Header is 0\n");
}
#[test]
fn generated_regions_reject_conflicting_owners_and_external_writes() {
    use ymb_core::generated as g;
    let a = g::render("a", &["A is 1".into()], None, None).unwrap();
    let changed = a.replace("A is 1", "A is 2");
    let other = a.replace("A is 1", "A is 3");
    assert!(g::merge(&a, &changed, &other, &["a".into()], Default::default()).is_err());
    assert!(
        g::merge(
            "Base is 0\n",
            "Base is 0\n",
            "Base is 1\n",
            &["a".into()],
            Default::default()
        )
        .unwrap()
        .is_none()
    );
}
#[test]
fn native_tools_support_list_parsing_comment_reads_and_unmarked_insertion() {
    let source = "A is T(\n    Items = [1, 'text'] // retained\n)\n";
    let range = ndf::read::path_range(source, "A.Items").unwrap();
    let values = ndf::values::parse_list(&source[range]).unwrap();
    assert_eq!(values[0].value, serde_json::json!(1));
    assert_eq!(values[1].value, serde_json::json!("text"));
    let fields = ndf::read::direct_fields(source).unwrap();
    assert_eq!(
        ndf::read::trailing_comment(source, &fields[0]),
        Some("retained")
    );
    let next = ndf::patch::insert_at_path(source, "A.Items", &serde_json::json!(3), None).unwrap();
    let range = ndf::read::path_range(&next, "A.Items").unwrap();
    assert_eq!(ndf::read::entries(&next[range]).unwrap().len(), 3);
    assert!(!next.contains("YMB-ADD"));
    assert_eq!(ymb_core::text::escape_regex("a+b"), "a\\+b");
}
#[test]
fn csv_cells_escape_quotes_and_keep_unicode() {
    let value = templates::resolve(
        &serde_json::json!("${csv(name)}"),
        &serde_json::json!({"name":"A \"quoted\" 🦀"}),
    )
    .unwrap();
    assert_eq!(value, serde_json::json!("\"A \"\"quoted\"\" 🦀\""));
}

#[test]
fn nested_object_reads_use_the_grammar_and_exclude_metadata_and_template_roots() {
    let source = "private A is T meta(Family = 'fake C()')(Child = C(Value = 1) Named is E(Flag = True))\ntemplate P[x] is R meta(Family = 'sample',)(Child = D(Value = <x>))\n";
    let objects = ndf::read::objects(source).unwrap();
    assert_eq!(
        objects
            .iter()
            .map(|block| block.type_name)
            .collect::<Vec<_>>(),
        ["T", "C", "E", "D"]
    );
    assert_eq!(
        objects.iter().map(|block| block.name).collect::<Vec<_>>(),
        [Some("A"), None, Some("Named"), None]
    );
    assert!(source[objects[0].span.clone()].starts_with("private A is T meta"));
    let fields = ndf::read::direct_fields(&source[objects[0].span.clone()]).unwrap();
    assert!(!fields.iter().any(|field| field.name == "Family"));
    assert_eq!(
        source[objects[2].span.clone()].trim(),
        "Named is E(Flag = True)"
    );
}
