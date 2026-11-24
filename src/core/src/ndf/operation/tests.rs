use super::*;
use serde_json::json;
#[test]
fn operations_reject_invalid_shapes_with_valid_neighbors() {
    for value in [
        json!({"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"}}),
        json!({"op":"add","selector":{"kind":"object","by":"name","value":"A"},"value":1}),
        json!({"op":"bulk","match":{"conditions":[]},"edits":[]}),
    ] {
        assert!(Operation::from_value(value).is_err());
    }
    assert!(Operation::from_value(json!({"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":null})).is_ok());
}
#[test]
fn nested_loops_bind_before_resolution() {
    let ops = vec![
        json!({"forEach":["A","B"],"as":"unit","do":[{"op":"modify","selector":{"kind":"field","by":"path","value":"${unit}.X"},"value":"${unitIndex + amount}"}]}),
    ];
    let result = expand(&ops, &json!({"amount":3})).unwrap();
    assert_eq!(result.len(), 2);
    match &result[1].0 {
        Operation::Modify {
            selector, value, ..
        } => {
            assert_eq!(selector.value, Some(json!("B.X")));
            assert_eq!(value, &Some(json!(4)));
        }
        _ => panic!(),
    }
}

#[test]
fn expanded_operations_follow_the_memory_budget_instead_of_a_count_cap() {
    let authored = json!([{
        "forEach":"${range(10001)}", "as":"i", "do":[{
            "op":"modify", "selector":{"kind":"field","by":"path","value":"A.X"},
            "value":"${i}"
        }]
    }]);
    let expanded = expand(authored.as_array().unwrap(), &json!({})).unwrap();
    assert_eq!(expanded.len(), 10001);
    assert_eq!(expanded.last().unwrap().1, 0);
    match &expanded.last().unwrap().0 {
        Operation::Modify { value, .. } => assert_eq!(value, &Some(json!(10000))),
        _ => panic!(),
    }
}

#[test]
fn empty_nested_loops_share_the_expansion_allocation_budget() {
    let mut authored = serde_json::json!([{
        "forEach":"${range(1000)}","as":"i","do":[{
            "forEach":"${range(1000)}","as":"j","do":[{
                "forEach":[],"as":"unused","do":[{
                    "op":"remove","selector":{"kind":"object","by":"name","value":"Unused"}
                }]
            }]
        }]
    }]);
    let variables = serde_json::json!({"padding":"x".repeat(16384)});
    let error = expand(authored.as_array().unwrap(), &variables).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("E28"));
    authored[0]["forEach"] = serde_json::json!("${range(2)}");
    authored[0]["do"][0]["forEach"] = serde_json::json!("${range(3)}");
    assert!(
        expand(authored.as_array().unwrap(), &variables)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn operations_share_the_budget_for_intermediate_values() {
    let authored = json!([{
        "forEach":"${range(100)}","as":"i","do":[{
            "op":"modify",
            "selector":{"kind":"field","by":"path","value":"A.X"},
            "value":"${len(range(100000))}"
        }]
    }]);
    let error = expand(authored.as_array().unwrap(), &json!({})).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("E28"));
}
