use serde_json::Value;
use std::process::Command;

#[test]
fn init_requires_an_example_only_when_several_exist_and_copies_its_workflow() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("YMB");
    for folder in ["GameData", "CommonData"] {
        std::fs::create_dir(temp.path().join(folder)).unwrap();
    }
    let examples = root.join("resources/examples");
    std::fs::create_dir_all(&examples).unwrap();
    let run = |example: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ymb"));
        command
            .args([
                "init",
                "--id",
                "example",
                "--name",
                "Example",
                "--json",
                "--ymb-path",
            ])
            .arg(&root);
        if let Some(example) = example {
            command.args(["--example", example]);
        }
        let output = command.output().unwrap();
        assert!(output.stderr.is_empty());
        (
            output.status.success(),
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        )
    };
    assert!(!run(None).0);
    assert!(!root.join("mods/example").exists());
    for name in ["one", "two"] {
        let project = examples.join(name);
        std::fs::create_dir_all(project.join("config")).unwrap();
        std::fs::create_dir_all(project.join(".github/workflows")).unwrap();
        std::fs::write(
            project.join("config/ymb.mod.yaml"),
            "version: @FORMAT@\nid: @ID@\nname: @NAME@\n",
        )
        .unwrap();
        std::fs::write(
            project.join(".github/workflows/release.yml"),
            format!("example: {name}\nproject: @PROJECT_ID@\n"),
        )
        .unwrap();
    }
    let (success, report) = run(None);
    assert!(!success);
    assert_eq!(
        report["errors"][0]["examples"],
        serde_json::json!(["one", "two"])
    );
    assert!(!run(Some("missing")).0);
    let (success, report) = run(Some("two"));
    assert!(success, "{report}");
    assert_eq!(report["data"]["example"], "two");
    assert_eq!(
        std::fs::read_to_string(root.join("mods/example/.github/workflows/release.yml")).unwrap(),
        "example: two\nproject: example\n"
    );
}

#[test]
fn malformed_ndf_reports_an_error_count_and_the_input_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("YMB");
    let config = root.join("mods/example/config");
    std::fs::create_dir_all(config.join("patch/main")).unwrap();
    std::fs::create_dir(temp.path().join("GameData")).unwrap();
    std::fs::create_dir(temp.path().join("CommonData")).unwrap();
    std::fs::write(temp.path().join("GameData/A.ndf"), "A is T(X = )").unwrap();
    std::fs::write(
        config.join("ymb.mod.yaml"),
        "version: 2\nid: example\nname: Example\n",
    )
    .unwrap();
    std::fs::write(config.join("patch/main/ymb.patch.yaml"), serde_json::to_vec(&serde_json::json!({
        "version":2,"id":"main","name":"Main","scope":"prod",
        "targets":[{"file":"GameData/A.ndf","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":4}]}]
    })).unwrap()).unwrap();
    for args in [vec!["build"], vec!["find", "--file", "GameData/A.ndf"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_ymb"))
            .args(args)
            .args(["--json", "--ymb-path"])
            .arg(&root)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stderr.is_empty());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["errors"][0]["code"], "E14");
        assert_eq!(report["errors"][0]["path"], "GameData/A.ndf");
        assert_eq!(report["errors"][0]["line"], 1);
        assert_eq!(report["diagnosticCounts"]["error"], 1);
        assert_eq!(report["diagnosticCounts"]["info"], 0);
    }
}

#[test]
fn native_commands_accept_partial_options_and_quoted_values_without_chatter() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("YMB");
    for folder in [
        &root,
        &temp.path().join("GameData"),
        &temp.path().join("CommonData"),
    ] {
        std::fs::create_dir(folder).unwrap();
    }
    for args in [
        vec![
            "init",
            "--id",
            "example",
            "--na",
            "Example with spaces",
            "--j",
        ],
        vec!["li", "--mo", "example", "--js"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_ymb"))
            .args(args)
            .arg("--ymb-path")
            .arg(&root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["status"], "ok");
        if report["command"] == "list" {
            assert_eq!(report["data"]["projects"][0]["name"], "Example with spaces");
        }
    }
}

#[test]
fn invalid_input_returns_ranked_suggestions_and_partial_json_stays_silent() {
    for (args, first) in [
        (vec!["buid", "--j"], "build"),
        (vec!["build", "--re", "--json"], "--require-all"),
        (vec!["find", "--naem", "a", "--js"], "--name"),
        (vec!["build", "--scope", "prdo", "--j"], "prod"),
        (
            vec!["--mod", "find", "build", "--modd", "a", "--json"],
            "--mod",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_ymb"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["status"], "error");
        assert_eq!(report["errors"][0]["suggestions"][0], first, "{report}");
        assert!(
            report["errors"][0]["suggestion"]
                .as_str()
                .unwrap()
                .starts_with("Did you mean")
        );
    }
    for args in [
        ["--dry-run", "sync", "--reset-changed", "--j"],
        ["--reset-changed", "sync", "--dry-run", "--j"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_ymb"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stderr.is_empty());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["errors"][0]["code"], "E1");
    }
}
