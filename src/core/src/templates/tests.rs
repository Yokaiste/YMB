use super::*;

#[test]
fn csv_keeps_multiline_text_in_one_warno_localisation_row() {
    let value = resolve(
        &json!("${csv(text)}"),
        &json!({"text":"雪 \"quote\"\r\nsecond\rthird\nfourth"}),
    )
    .unwrap();
    assert_eq!(
        value,
        json!("\"雪 \"\"quote\"\"\\nsecond\\nthird\\nfourth\"")
    );
    assert_eq!(value.as_str().unwrap().lines().count(), 1);
}

#[test]
fn configuration_is_literal_data_and_other_variables_still_resolve() {
    let variables = json!({
        "config": {
            "mod": {"release": {"version": "7.11.3"}, "variables": {"self": "${config.mod}"}},
            "patch": {"targets": [{"value": "${item.name}"}]},
        },
        "version": "${config.mod.release.version}",
        "nested": {"config": "${version}"},
    });
    let resolved = resolve(&variables, &variables).unwrap();
    assert_eq!(resolved["config"], variables["config"]);
    assert_eq!(resolved["version"], "7.11.3");
    assert_eq!(resolved["nested"]["config"], "7.11.3");
    for (expression, expected) in [
        ("${config.mod}", variables["config"]["mod"].clone()),
        ("${config.patch.targets[0].value}", json!("${item.name}")),
        ("${config.mod.variables.self}", json!("${config.mod}")),
        ("${config.mod.release.version}", json!("7.11.3")),
    ] {
        assert_eq!(resolve(&json!(expression), &resolved).unwrap(), expected);
    }
}

#[test]
fn typed_values_precedence_lazy_branches_and_helpers() {
    let variables = json!({"base":10,"percent":1.5,"nested":{"base":3,"copy":"${nested.base}"},"alias":"${nested}","items":[2,4],"true":"named"});
    let mut r = Resolver::new(&variables);
    for (source, wanted) in [
        ("${round(base * percent)}", json!(15)),
        ("${false && missing}", json!(false)),
        ("${true ? nested.copy : missing}", json!(3)),
        ("${alias.copy}", json!(3)),
        ("${items[1] + 2}", json!(6)),
        ("${join(range(3), '-')}", json!("0-1-2")),
        ("${sum(numbers(items))}", json!(6)),
        ("${true}", json!("named")),
        ("v${items}", json!("v[2,4]")),
        ("${1 == 1.0}", json!(true)),
        ("${round(-1.5)}", json!(-1)),
    ] {
        assert_eq!(r.resolve(&json!(source)).unwrap(), wanted, "{source}");
    }
}
#[test]
fn standalone_literals_work_without_a_variable_with_the_same_name() {
    for value in [json!(true), json!(false), Value::Null] {
        let source = format!("${{{value}}}");
        assert_eq!(resolve(&json!(source), &json!({})).unwrap(), value);
        assert_eq!(
            resolve(&json!(source), &json!({value.to_string(): "named"})).unwrap(),
            "named"
        );
    }
}

#[test]
fn rejects_real_cycles_and_invalid_neighbors() {
    for vars in [
        json!({"a":"${b}","b":"${a}"}),
        json!({"a":{"parent":"${a}"}}),
    ] {
        assert!(resolve(&json!("${a}"), &vars).is_err());
    }
    for source in [
        "${1 / 0}",
        "${missing}",
        "${range(0,3,0)}",
        "${1e308 * 1e308}",
        "${[1][3]}",
        "${1.}",
        "${1.e2}",
        "${1e}",
        "${1..2}",
        "${(}",
        "${unclosed",
    ] {
        assert!(resolve(&json!(source), &json!({})).is_err(), "{source}");
    }
    assert_eq!(
        resolve(&json!("${range(3,0,-1)}"), &json!({})).unwrap(),
        json!([3, 2, 1])
    );
}
#[test]
fn merge_replaces_arrays_and_preserves_siblings() {
    let mut value = json!({"a":{"x":1,"y":2},"list":[1,2]});
    merge(&mut value, &json!({"a":{"x":3},"list":[]}));
    assert_eq!(value, json!({"a":{"x":3,"y":2},"list":[]}));
}

#[test]
fn list_sizes_follow_the_memory_budget_instead_of_an_item_cap() {
    for source in [
        "len(repeat(1,100001))",
        "len(range(100001))",
        "len(concat(repeat(1,100000),[2]))",
        "len(cartesian(1,100001))",
    ] {
        assert_eq!(
            Resolver::new(&json!({})).expression(source).unwrap(),
            json!(100001),
            "{source}"
        );
    }
}

#[test]
fn integer_ranges_keep_values_at_numeric_boundaries() {
    for (source, expected) in [
        (
            "range(-9007199254740991, 9007199254740990, 9007199254740990)",
            json!([-9007199254740991i64, -1, 9007199254740989i64]),
        ),
        (
            "range(9007199254740991, -9007199254740990, -9007199254740990)",
            json!([9007199254740991i64, 1, -9007199254740989i64]),
        ),
        ("range(3, 0, 1)", json!([])),
        ("range(0, 3, -1)", json!([])),
        ("range(0, 0)", json!([])),
        ("range(-3, 4, 2)", json!([-3, -1, 1, 3])),
    ] {
        assert_eq!(
            Resolver::new(&json!({})).expression(source).unwrap(),
            expected,
            "{source}"
        );
    }
}

#[test]
fn flat_expression_chains_obey_the_nesting_limit() {
    for source in [
        "1+".repeat(256) + "1",
        "value".to_owned() + &".member".repeat(256),
        format!("({}1){}", "1+".repeat(100), "+1".repeat(100)),
    ] {
        assert!(Parser::new(&source).unwrap().parse().is_err());
    }
    assert!(
        Parser::new(&("1+".repeat(127) + "1"))
            .unwrap()
            .parse()
            .is_ok()
    );
    assert!(
        Parser::new(&("1+".repeat(128) + "1"))
            .unwrap()
            .parse()
            .is_err()
    );
    let source = format!("[{}]", vec!["1"; 1000].join(","));
    assert!(Parser::new(&source).unwrap().parse().is_ok());
}

#[test]
fn aliases_cannot_bypass_expression_evaluation_limits() {
    let mut variables = json!({"v32": 1, "known": 42});
    for i in 0..32 {
        variables[format!("v{i}")] = json!(format!("${{v{}{} }}", i + 1, "+1".repeat(16)));
    }
    let mut resolver = Resolver::new(&variables);
    assert!(resolver.expression("v0").is_err());
    assert_eq!(resolver.expression("known").unwrap(), json!(42));
}

#[test]
fn generated_values_have_a_budget_before_large_replication() {
    let variables = json!({"piece": "x".repeat(4096), "pattern": "{left}".repeat(100_000)});
    for source in [
        "repeat(repeat(1,100000),100000)",
        "repeat(piece,100000)",
        "cartesian([piece],[0],pattern)",
    ] {
        let error = Resolver::new(&variables).expression(source).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("E28"), "{source}: {error}");
    }
    assert_eq!(
        Resolver::new(&variables)
            .expression("len(repeat(piece,2))")
            .unwrap(),
        json!(2)
    );
    assert_eq!(
        Resolver::new(&json!({})).expression("cartesian(['{right}'], ['雪'], '{left}:{right}:{index}:[{leftIndex},{rightIndex}]')").unwrap(),
        json!(["{right}:雪:0:[0,0]"])
    );
}

#[test]
fn expansion_failures_leave_the_resolver_reusable() {
    let variables = json!({"large": "${repeat(repeat(1,100000),100000)}", "small": 7});
    let mut resolver = Resolver::new(&variables);
    for _ in 0..2 {
        assert_eq!(
            resolver.expression("large").unwrap_err().code.as_deref(),
            Some("E28")
        );
    }
    assert_eq!(resolver.expression("small").unwrap(), json!(7));
}

#[test]
fn cached_aliases_and_string_concatenation_share_the_budget() {
    let mut variables = json!({"v0": "x".repeat(32 * 1024)});
    for index in 1..20 {
        variables[format!("v{index}")] = json!(format!("${{v{0}+v{0}}}", index - 1));
    }
    let mut resolver = Resolver::new(&variables);
    let mut limited = false;
    for index in 0..20 {
        if let Err(error) = resolver.expression(&format!("v{index}")) {
            assert_eq!(error.code.as_deref(), Some("E28"));
            limited = true;
            break;
        }
    }
    assert!(limited);
}

#[test]
fn joining_large_values_reserves_the_result_before_construction() {
    let variables = json!({"piece": "x".repeat(1024)});
    let error = Resolver::new(&variables)
        .expression("join(repeat(piece,100000),piece)")
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("E28"));
}
