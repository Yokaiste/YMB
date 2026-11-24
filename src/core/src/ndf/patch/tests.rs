use super::*;
const SOURCE: &str = "export A is T\n(\n    HP = 10\n    Items = [~/One, ~/Two]\n    Child = C(Value = 2.0)\n)\nexport B is T\n(\n    HP = 5\n)\n";
fn run(source: &str, operations: Value) -> Result<PatchResult> {
    let identity = Identity {
        mod_id: "fixture".into(),
        patch_id: "edit".into(),
        path: "GameData/Units.ndf".into(),
        ..Default::default()
    };
    let operations = operations
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(Operation::from_value)
        .enumerate()
        .map(|(i, op)| op.map(|op| (op, i)))
        .collect::<Result<Vec<_>>>()?;
    apply(source, &operations, &identity)
}
#[test]
fn sequential_field_edits_and_copy_keep_neighbors() {
    let result=run(SOURCE,json!([{"op":"modify","selector":{"kind":"field","by":"path","value":"A.HP"},"value":20},{"op":"copy","selector":{"kind":"object","by":"name","value":"A"},"destination":{"name":"New"}},{"op":"modify","selector":{"kind":"field","by":"path","value":"New.HP"},"value":30}])).unwrap();
    let value = |path: &str| {
        let range = read::path_range(&result.text, path).unwrap();
        result.text[range].to_owned()
    };
    assert_eq!(value("A.HP"), "20");
    assert_eq!(value("New.HP"), "30");
    assert_eq!(value("B.HP"), "5");
    assert!(result.text.contains("YMB-ORIGINAL"));
}
#[test]
fn collection_insertion_supplies_missing_comma_and_removal_keeps_validity() {
    let source = "Root is T\n(\n    Items = [~/One]\n)";
    let result=run(source,json!([{"op":"add","selector":{"kind":"collection","by":"path","value":"Root.Items"},"value":{"$raw":"~/Two"}},{"op":"remove","selector":{"kind":"field","by":"path","value":"Root.Items.[value=~/One]"}}])).unwrap();
    let range = read::path_range(&result.text, "Root.Items").unwrap();
    let values = read::entries(&result.text[range]).unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].text, "~/Two");
}
#[test]
fn bulk_counts_neighbors_and_overlapping_edits() {
    let result=run(SOURCE,json!([{"op":"bulk","match":{"conditions":[{"on":"type","is":"equals","value":"T"}]},"edits":[{"field":"HP","multiply":1.5,"minChanges":2}],"expect":{"minBlocks":2}}])).unwrap();
    assert!(result.text.contains("HP = 15"));
    assert!(result.text.contains("HP = 8"));
    assert!(run(SOURCE,json!([{"op":"bulk","match":{"conditions":[{"on":"name","is":"equals","value":"A"}]},"edits":[{"field":"HP","set":1},{"field":"HP","set":2}]}])).is_err());
}
#[test]
fn insertions_keep_markers_idempotence_and_neighbor_declarations() {
    let source = "First is T(Value = 1)\nSecond is T(Value = 2)\n";
    for position in [
        json!({"mode":"start"}),
        json!({"mode":"after","anchor":"First"}),
    ] {
        let added = run(
            source,
            json!([{"op":"add","value":{"$raw":"New is T(Value = 3)"},"position":position}]),
        )
        .unwrap();
        let blocks = super::super::scan(&added.text).unwrap();
        assert_eq!(blocks.len(), 3, "{}", added.text);
        for name in ["First", "Second", "New"] {
            assert!(blocks.iter().any(|b| b.name == Some(name)));
        }
    }
    let adjacent = "First is T(Value = 1) Second is T(Value = 2)";
    for operation in [
        json!({"op":"modify","selector":{"kind":"object","by":"name","value":"First"},"changes":{"Value":3}}),
        json!({"op":"remove","selector":{"kind":"object","by":"name","value":"First"}}),
    ] {
        let result = run(adjacent, json!([operation])).unwrap();
        let blocks = super::super::scan(&result.text).unwrap();
        assert!(
            blocks.iter().any(|b| b.name == Some("Second")),
            "{}",
            result.text
        );
    }
    let source = "Root is T(Items = [1, 2])";
    assert_eq!(
        insert_at_path(
            source,
            "Root.Items",
            &json!({"$raw":"2, // existing"}),
            None
        )
        .unwrap(),
        source
    );
    assert!(insert_at_path(source, "Root", &json!(3), None).is_err());
    let owner = crate::generated::render("fixture.owner", &["3,".into()], None, None).unwrap();
    let updated = insert_at_path(source, "Root.Items", &json!(owner), None).unwrap();
    assert_eq!(crate::generated::regions(&updated).unwrap().len(), 1);
    let second_owner =
        crate::generated::render("fixture.second", &["4,".into()], None, None).unwrap();
    let start = Position {
        mode: "start".into(),
        anchor: None,
    };
    let both = insert_at_path(&updated, "Root.Items", &json!(second_owner), Some(&start)).unwrap();
    assert_eq!(crate::generated::regions(&both).unwrap().len(), 2);
    assert_eq!(
        insert_at_path(
            "Root is T(Items = [1, 2])",
            "Root.Items",
            &json!({"$raw":"1, 2,"}),
            None
        )
        .unwrap(),
        "Root is T(Items = [1, 2])"
    );
    assert_eq!(
        insert_at_path(&updated, "Root.Items", &json!(owner), None).unwrap(),
        updated
    );
    let before = Position {
        mode: "before".into(),
        anchor: Some("2,".into()),
    };
    let updated = insert_at_path(
        "Root is T(Items = [1, 2, 4])",
        "Root.Items",
        &json!(3),
        Some(&before),
    )
    .unwrap();
    let range = read::path_range(&updated, "Root.Items").unwrap();
    assert_eq!(
        read::entries(&updated[range])
            .unwrap()
            .iter()
            .map(|e| e.text)
            .collect::<Vec<_>>(),
        ["1", "3", "2", "4"]
    );
}
#[test]
fn collection_additions_reject_empty_input_and_partial_duplicates() {
    for value in ["", "// no entry", "2, 3"] {
        assert!(insert_collection("[1, 2]", value, None).is_err(), "{value}");
    }
    assert_eq!(
        insert_collection("[1, 2]", "2, 1,", None).unwrap(),
        "[1, 2]"
    );
    let output = insert_collection("[1, 2]", "3, 4", None).unwrap();
    let entries: Vec<_> = read::entries(&output)
        .unwrap()
        .iter()
        .map(|entry| entry.text)
        .collect();
    assert_eq!(entries, ["1", "2", "3", "4"]);
}

#[test]
fn collection_positions_require_one_existing_anchor() {
    for mode in ["before", "after"] {
        for (anchor, code) in [("missing", "E16"), ("~/One", "E17")] {
            let position = Position {
                mode: mode.into(),
                anchor: Some(anchor.into()),
            };
            let source = "[~/One, ~/OneOther, ~/Two]";
            let error = insert_collection(source, "~/New", Some(&position)).unwrap_err();
            assert_eq!(error.code.as_deref(), Some(code), "{error}");
        }
        let position = Position {
            mode: mode.into(),
            anchor: Some("~/Two".into()),
        };
        let output = insert_collection("[~/One, ~/Two]", "~/New", Some(&position)).unwrap();
        let values: Vec<_> = read::entries(&output)
            .unwrap()
            .iter()
            .map(|e| e.text)
            .collect();
        assert_eq!(
            values,
            if mode == "before" {
                vec!["~/One", "~/New", "~/Two"]
            } else {
                vec!["~/One", "~/Two", "~/New"]
            }
        );
    }
}

#[test]
fn unmatched_bulk_alternatives_have_stable_diagnostic_order() {
    let operation = json!([{"op":"bulk","match":{"conditions":[{"on":"name","is":"equals","value":["MissingZ","A","MissingB"]}]},"edits":[{"field":"HP","set":20}]}]);
    let result = run(SOURCE, operation).unwrap();
    assert_eq!(result.notices.len(), 2);
    assert!(result.notices[0].reason.contains("MissingB"));
    assert!(result.notices[1].reason.contains("MissingZ"));
}

#[test]
fn bulk_composes_list_edits_in_order_and_keeps_scalar_overlap_guards() {
    let source = "Root is T(Items = [~/One, ~/Two] Other = 7)\nNeighbor is T(Items = [~/One])";
    let operations = json!([{"op":"bulk","match":{"conditions":[{"on":"name","is":"equals","value":"Root"}]},"edits":[
        {"list":"Items","removeEntry":"~/One","minChanges":1},
        {"list":"Items","insert":{"value":{"$raw":"~/Three"},"position":"start"},"minChanges":1},
        {"list":"Items","setEntry":{"index":-1,"value":{"$raw":"~/Four"}},"minChanges":1},
        {"list":"Items","insert":{"value":{"$raw":"~/Three,"},"position":"end"},"minChanges":1}
    ],"expect":{"minBlocks":1}}]);
    let result = run(source, operations).unwrap();
    let range = read::path_range(&result.text, "Root.Items").unwrap();
    assert_eq!(
        read::entries(&result.text[range])
            .unwrap()
            .iter()
            .map(|e| e.text)
            .collect::<Vec<_>>(),
        ["~/Three", "~/Four"]
    );
    assert!(result.text.contains("Other = 7"));
    assert!(result.text.contains("Neighbor is T(Items = [~/One])"));
}
#[test]
fn stable_identity_changes_only_literal_descriptor_ids() {
    let source = "A is T\n(\n DescriptorId = GUID:{12345678-1234-1234-1234-123456789abc}\n OtherId = GUID:{12345678-1234-1234-1234-123456789abc}\n)";
    let a = reidentify_ids(source, "fixture").unwrap();
    assert_eq!(a, reidentify_ids(source, "fixture").unwrap());
    assert_ne!(a, reidentify_ids(source, "other").unwrap());
    assert!(a.contains("OtherId = GUID:{12345678-1234-1234-1234-123456789abc}"));
    let inherited = source.replace(
        "12345678-1234-1234-1234-123456789abc",
        "fg25aaea-9679-4a61-b5ea-c5b0747e6216",
    );
    let cloned = reidentify_ids(&inherited, "fixture").unwrap();
    assert_eq!(cloned, reidentify_ids(&inherited, "fixture").unwrap());
    assert_ne!(cloned, inherited);
    let field = read::deep_fields(&cloned, "DescriptorId")
        .unwrap()
        .remove(0);
    let literal = &cloned[field.value];
    assert!(literal.chars().all(|c| !c.is_ascii_lowercase() || c <= 'f'));
    assert!(cloned.contains("OtherId = GUID:{fg25aaea-9679-4a61-b5ea-c5b0747e6216}"));
}
#[test]
fn absent_removal_warns_but_ambiguous_selection_fails() {
    let result = run(
        SOURCE,
        json!([{"op":"remove","selector":{"kind":"object","by":"name","value":"Missing"}}]),
    )
    .unwrap();
    assert_eq!(result.text, SOURCE);
    let copied = run("A is T(X = 1)\nB is T(X = 1)", json!([{"op":"copy","selector":{"kind":"object","by":"name","value":"A"},"destination":{"name":"B"},"allowNoChange":"compatibility: another project may already supply this object"}])).unwrap();
    assert!(copied.notices[0].expected.is_some());
    assert_eq!(result.notices.len(), 1);
    let duplicate = format!("{SOURCE}{SOURCE}");
    assert!(
        run(
            &duplicate,
            json!([{"op":"remove","selector":{"kind":"object","by":"name","value":"A"}}])
        )
        .is_err()
    );
}

#[test]
fn intentional_no_change_is_reported_without_hiding_bad_selectors() {
    let operation = json!({"op":"remove","selector":{"kind":"object","by":"name","value":"Absent"},"allowNoChange":"compatibility: remove an inherited optional module"});
    let result = run(SOURCE, json!([operation.clone()])).unwrap();
    assert_eq!(result.notices[0].code, "I4");
    assert_eq!(
        result.notices[0].selector.as_ref().unwrap().value,
        Some(json!("Absent"))
    );
    let unexpected = run(
        SOURCE,
        json!([{"op":"remove","selector":{"kind":"object","by":"name","value":"Absent"}}]),
    )
    .unwrap();
    assert_eq!(unexpected.notices[0].code, "W9");
    assert!(
        result.notices[0]
            .expected
            .as_deref()
            .unwrap()
            .starts_with("compatibility:")
    );
    assert_eq!(result.text, SOURCE);
    let mut invalid = operation;
    invalid["selector"]["kind"] = json!("unknown");
    assert!(run(SOURCE, json!([invalid])).is_err());
}

#[test]
fn collection_conditions_use_own_tags_and_ignore_quotes_comments_and_cargo() {
    let source = "Carrier is T(TagSet = ['Vehicle', // \"Crew\"\n] TransportableTagSet = [\"Crew\"] Value = 1)\nCrew is T(TagSet = ['Crew'] Value = 1)";
    let result = run(source, json!([{"op":"bulk","match":{"conditions":[{"on":"field","field":"TagSet","is":"lacksEntry","value":"\"Crew\""}]},"edits":[{"field":"Value","set":2}]}])).unwrap();
    let carrier = read::path_range(&result.text, "Carrier.Value").unwrap();
    let crew = read::path_range(&result.text, "Crew.Value").unwrap();
    assert_eq!(&result.text[carrier], "2");
    assert_eq!(&result.text[crew], "1");
}
