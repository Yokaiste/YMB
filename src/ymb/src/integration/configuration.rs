use super::*;

#[test]
fn malformed_override_variables_fail_before_project_discovery() {
    let w = Workspace::new();
    for custom in [
        json!({"variables":null}),
        json!({"variables":[]}),
        json!({"patches":{"main":{"variables":5}}}),
    ] {
        w.write(
            "ymb.config.yaml",
            serde_json::to_vec(&json!({"version":metadata::CONFIG_VERSION,"mods":{"a":custom}}))
                .unwrap(),
        );
        let error = Context::resolve(Some(&w.context.root)).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("E4"));
        assert!(error.reason.contains("variables"));
    }
}

#[test]
fn cleanup_rejects_misspelled_protection_flags_before_removing_anything() {
    let w = Workspace::new();
    w.project(
        "a",
        json!({"tempPaths":[{"path":"precious","unsafeToRemvoe":true}]}),
    );
    w.write("mods/a/config/precious/keep.txt", "keep");
    w.write(".ymb/build/keep.txt", "preview");
    assert!(commands::cleanup(w.context.clone(), Selection::default(), false).is_err());
    assert_eq!(
        fs::read(w.context.mods.join("a/config/precious/keep.txt")).unwrap(),
        b"keep"
    );
    assert_eq!(
        fs::read(w.context.work.join("keep.txt")).unwrap(),
        b"preview"
    );
}

#[test]
fn find_rejects_unmatched_filters_and_accepts_spaces_in_field_filters() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    let options = |field| commands::FindOptions {
        files: vec![],
        name: None,
        type_name: None,
        field,
        limit: 10,
    };
    let error = commands::find(
        w.context.clone(),
        Selection {
            mod_filters: vec!["typo".into()],
            ..Default::default()
        },
        options(None),
    )
    .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("E1"));
    for invalid in ["", "=1", "X=", " = "] {
        assert!(
            commands::find(
                w.context.clone(),
                Selection::default(),
                options(Some(invalid.into()))
            )
            .is_err()
        );
    }
    let result = commands::find(
        w.context.clone(),
        Selection::default(),
        options(Some(" X = 1 ".into())),
    )
    .unwrap();
    assert_eq!(result["totalMatches"], 1);
}

#[test]
fn inspection_reports_each_unmatched_filter_and_init_preserves_existing_ids() {
    let w = Workspace::new();
    w.project("original_folder", json!({"id":"stable_id"}));
    w.field("original_folder", "main", "A.X", 4);
    for command in ["list", "explain"] {
        let result = commands::inspect(
            w.context.clone(),
            Selection {
                mod_filters: vec!["stable_id".into(), "typo".into()],
                ..Default::default()
            },
            command,
        )
        .unwrap();
        assert_eq!(result["projects"].as_array().unwrap().len(), 1);
        assert_eq!(result["warnings"][0]["code"], "W1");
        assert_eq!(result["warnings"][0]["filter"]["value"], "typo");
    }
    assert!(init::create(&w.context, "STABLE_ID", "Duplicate", "", None).is_err());
    assert!(!w.context.mods.join("STABLE_ID").exists());
    assert_eq!(config::discover(&w.context).unwrap().len(), 1);
}

#[test]
fn complete_configuration_reaches_expressions_assets_and_native_generators() {
    let mut w = Workspace::new();
    w.native("config");
    w.context.config.settings.cache_max_entries = 9;
    w.project(
        "native",
        json!({
            "release":{"version":"7.11.3"}, "requires":"*",
            "variables":{"behavior":"config","amount":5,"label":"${config.mod.release.version}"},
            "generators":[{"id":"generate","executable":"fixture.exe"}],
        }),
    );
    w.patch("native", "main", json!({
        "variables":{"copy":"${config.mod.name}"},
        "generators":[{"id":"patch","root":"mod","executable":"fixture.exe","entry":"generate"}],
        "targets":[{"file":"GameData/A.ndf","operations":[{
            "forEach":["X","Y"], "as":"field", "do":[{
                "op":"modify", "selector":{"kind":"field","by":"path","value":"A.${field}"},
                "value":"${config.mod.variables.amount + config.builder.settings.cacheMaxEntries + fieldIndex}",
            }],
        }]}],
    }));
    w.write(
        "mods/native/config/replace/CommonData/metadata.txt",
        "${config.mod.release.version};${config.builder.settings.cacheMaxEntries}",
    );
    w.context.config.mods.insert(
        "native".into(),
        serde_json::from_value(json!({"priority":12})).unwrap(),
    );
    w.run("build");
    let output = fs::read_to_string(w.context.output.join("GameData/A.ndf")).unwrap();
    assert!(output.contains("X = 14") && output.contains("Y = 15"));
    assert_eq!(
        fs::read_to_string(w.context.output.join("CommonData/metadata.txt")).unwrap(),
        "7.11.3;9"
    );
    let projects = config::discover(&w.context).unwrap();
    for scope in ["mod", "patch"] {
        let path = w
            .context
            .output
            .join(format!("CommonData/config-{scope}.json"));
        let snapshot: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            snapshot["builder"],
            serde_json::to_value(&w.context.config).unwrap()
        );
        assert_eq!(
            snapshot["mod"],
            serde_json::to_value(&projects[0].config).unwrap()
        );
        assert_eq!(
            snapshot["patch"],
            if scope == "mod" {
                Value::Null
            } else {
                serde_json::to_value(&projects[0].patches[0].config).unwrap()
            }
        );
    }
    w.project("reserved", json!({"variables":{"config":{}}}));
    let error = commands::build(w.context.clone(), Selection::default(), "build").unwrap_err();
    assert!(error.reason.contains("reserved built-in variable"));
    assert_eq!(w.game(), SOURCE);
}

#[test]
fn installation_overrides_merge_and_reset_without_changing_shared_defaults() {
    let w = Workspace::new();
    w.write(
        "ymb.config.yaml",
        "version: 2\nvariables: {shared: 7, selected: base}\nsettings: {cacheMaxEntries: 9}\n",
    );
    w.write(
        ".ymb/config.yaml",
        "version: 2\nvariables: {selected: local}\nsettings: {cacheMaxBytes: 4096}\n",
    );
    let context = Context::resolve(Some(&w.context.root)).unwrap();
    assert_eq!(
        context.config.variables,
        json!({"shared":7,"selected":"local"})
    );
    assert_eq!(context.config.settings.cache_max_entries, 9);
    assert_eq!(context.config.settings.cache_max_bytes, 4096);
    paths::remove_tree(&w.context.root, &w.context.root.join(".ymb")).unwrap();
    let context = Context::resolve(Some(&w.context.root)).unwrap();
    assert_eq!(
        context.config.variables,
        json!({"shared":7,"selected":"base"})
    );
    assert_eq!(context.config.settings.cache_max_entries, 9);
    assert!(w.context.root.join("ymb.config.yaml").is_file());
}

#[test]
fn work_roots_cannot_contain_installation_overrides() {
    let w = Workspace::new();
    w.write("ymb.config.yaml", "version: 2\npaths:\n  workRoot: .ymb\n  cacheRoot: cache\n  recoveryRoot: state\n  operationLockRoot: lock\n  stateTransactionRoot: transaction\n");
    assert!(
        Context::resolve(Some(&w.context.root))
            .unwrap_err()
            .reason
            .contains("settings")
    );
}

#[test]
fn global_caches_stay_inside_the_builder_and_outside_other_roots() {
    let w = Workspace::new();
    for paths in [
        json!({"cacheRoot":"cache"}),
        json!({"workRoot":".ymb/g"}),
        json!({"cacheRoot":".ymb/releases"}),
    ] {
        w.write(
            "ymb.config.yaml",
            json!({"version":2,"paths":paths}).to_string(),
        );
        assert!(Context::resolve(Some(&w.context.root)).is_err());
    }
    w.write(
        "ymb.config.yaml",
        "version: 2\npaths: {cacheRoot: .ymb/results}\n",
    );
    assert_eq!(
        Context::resolve(Some(&w.context.root)).unwrap().cache,
        w.context.root.join(".ymb/results")
    );
}

#[test]
fn local_layering_and_stale_overrides_do_not_rewrite_projects() {
    let mut w = Workspace::new();
    w.project("a", json!({}));
    w.project("b", json!({}));
    w.field("a", "main", "A.X", 4);
    w.field("b", "main", "A.X", 8);
    let source = fs::read(w.context.mods.join("b/config/ymb.mod.yaml")).unwrap();
    w.context.config.mods.insert("b".into(), serde_json::from_value(json!({"priority":10,"allowWriteToModifiedFiles":true,"patches":{"removed":{"variables":{"keep":7}}}})).unwrap());
    assert!(commands::prepare(w.context.clone(), Selection::default()).is_err());
    w.context
        .config
        .mods
        .get_mut("b")
        .unwrap()
        .ignore_unknown_patches = true;
    let report = w.run("build");
    assert!(
        report["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["patchId"] == "removed")
    );
    assert!(
        fs::read_to_string(w.context.output.join("GameData/A.ndf"))
            .unwrap()
            .contains("X = 8")
    );
    assert_eq!(
        source,
        fs::read(w.context.mods.join("b/config/ymb.mod.yaml")).unwrap()
    );
    w.context
        .config
        .mods
        .get_mut("b")
        .unwrap()
        .allow_write_to_modified_files = Some(false);
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
}

#[test]
fn defaults_keep_cache_separate_and_require_explicit_legacy_storage() {
    let w = Workspace::new();
    assert_eq!(w.context.cache, w.context.root.join(".ymb/cache"));
    assert!(!w.context.cache.starts_with(&w.context.work));
    w.write(".ymb-state/manifest.json", r#"{"entries":[]}"#);
    assert!(Context::resolve(Some(&w.context.root)).is_err());
    w.write(
        "ymb.config.yaml",
        "version: 2\npaths:\n  recoveryRoot: .ymb-state\n",
    );
    let context = Context::resolve(Some(&w.context.root)).unwrap();
    assert_eq!(context.state, context.root.join(".ymb-state"));
}

#[test]
fn dependencies_include_filtered_projects_and_report_cycles() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.project("b", json!({"dependsOn":["a"]}));
    w.patch("a", "needed", json!({}));
    w.patch("b", "main", json!({"dependsOn":["a:needed"]}));
    let selection = Selection {
        mod_filters: vec!["b".into()],
        patch_filters: vec!["main".into()],
        ..Default::default()
    };
    let plan = commands::prepare(w.context.clone(), selection).unwrap();
    assert_eq!(plan.mods.len(), 2);
    assert_eq!(plan.patches.len(), 2);
    w.project("a", json!({"dependsOn":["b"]}));
    assert!(commands::prepare(w.context.clone(), Selection::default()).is_err());
}

#[test]
fn patch_dependencies_expand_their_owners_project_dependencies() {
    let w = Workspace::new();
    w.project("a", json!({"priority":2}));
    w.project(
        "b",
        json!({"dependsOn":["c"],"priority":1,"allowWriteToModifiedFiles":true}),
    );
    w.project("c", json!({}));
    w.patch(
        "a",
        "main",
        json!({"dependsOn":["b:main"],"files":[{"op":"remove","target":"GameData/unused.txt"}]}),
    );
    w.patch("b", "main", json!({"targets":[{"file":"GameData/new.ndf","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":9}]}]}));
    w.write("mods/c/config/patch/main/new.ndf", SOURCE);
    w.patch("c", "main", json!({"files":[{"op":"add","source":{"root":"patch","path":"new.ndf"},"destination":"GameData/new.ndf"}]}));
    let selection = Selection {
        mod_filters: vec!["a".into()],
        ..Default::default()
    };
    let plan = commands::prepare(w.context.clone(), selection.clone()).unwrap();
    assert_eq!(plan.patches.len(), 3);
    assert!(plan.explanations.iter().all(|item| item.included));
    commands::build(w.context.clone(), selection, "build").unwrap();
    assert!(
        fs::read_to_string(w.context.output.join("GameData/new.ndf"))
            .unwrap()
            .contains("X = 9")
    );
}

#[test]
fn find_resolves_selected_targets_with_project_and_patch_variables() {
    let w = Workspace::new();
    w.project("a", json!({"variables":{"directory":"GameData"}}));
    w.patch("a", "main", json!({"variables":{"target":"${directory}/A.ndf"},"targets":[{"file":"${target}","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":4}]}]}));
    w.run("build");
    let result = commands::find(
        w.context.clone(),
        Selection::default(),
        commands::FindOptions {
            files: Vec::new(),
            name: Some("A".into()),
            type_name: None,
            field: None,
            limit: 10,
        },
    )
    .unwrap();
    assert_eq!(result["totalMatches"], 1);
    assert_eq!(result["matches"][0]["file"], "GameData/A.ndf");
}
#[test]
fn path_traversal_hierarchy_and_reserved_names_fail() {
    for target in ["../outside", "GameData/A.ndf/child", "GameData/CON.ndf"] {
        let w = Workspace::new();
        w.project("a", json!({}));
        w.write("mods/a/config/data.txt", "text");
        w.patch("a","copy",json!({"files":[{"op":"copy","source":{"root":"mod","path":"data.txt"},"destination":target}]}));
        assert!(
            commands::build(w.context.clone(), Selection::default(), "sync").is_err(),
            "{target}"
        );
        assert_eq!(w.game(), SOURCE);
    }
}
#[test]
fn find_cannot_race_a_build_that_replaces_its_work_files() {
    let w = Workspace::new();
    let _lock = OperationLock::acquire(&w.context, "build").unwrap();
    let error = commands::find(
        w.context.clone(),
        Selection::default(),
        commands::FindOptions {
            files: vec!["GameData/A.ndf".into()],
            name: None,
            type_name: None,
            field: None,
            limit: 1,
        },
    )
    .unwrap_err();
    assert_eq!(error.category, "CommandError");
    assert!(error.reason.contains("operation lock"));
    assert!(!w.context.work.exists());
}

#[test]
fn find_explicit_files_ignores_unrelated_broken_project_configs() {
    let w = Workspace::new();
    w.write("mods/broken/config/ymb.mod.yaml", "bad yaml: [");
    let result = commands::find(
        w.context.clone(),
        Selection::default(),
        commands::FindOptions {
            files: vec!["GameData/A.ndf".into()],
            name: None,
            type_name: Some("t".into()),
            field: None,
            limit: 1,
        },
    )
    .unwrap();
    assert_eq!(result["totalMatches"], 2);
    assert_eq!(result["matches"].as_array().unwrap().len(), 1);
    assert!(commands::inspect(w.context.clone(), Selection::default(), "doctor").is_ok());
}

#[test]
fn find_reports_lines_across_filtered_unicode_and_multiple_files() {
    let w = Workspace::new();
    paths::write_atomic(
        &w.context.game.join("GameData/First.ndf"),
        "// 雪\r\nSkip is T(Value = 0)\r\n\r\nFirst is T(Value = 1)\r\n// gap\r\nSecond is T(Value = 1)\r\n",
    ).unwrap();
    paths::write_atomic(
        &w.context.game.join("CommonData/Second.ndf"),
        "\nThird is T(Value = 1)\n",
    )
    .unwrap();
    let result = commands::find(
        w.context.clone(),
        Selection::default(),
        commands::FindOptions {
            files: vec![
                "GameData/First.ndf".into(),
                "CommonData/Second.ndf".into(),
                "GameData/./First.ndf".into(),
                "GameData/first.ndf".into(),
            ],
            name: None,
            type_name: Some("T".into()),
            field: Some("Value=1".into()),
            limit: 10,
        },
    )
    .unwrap();
    assert_eq!(result["totalMatches"], 3);
    let matches = result["matches"].as_array().unwrap();
    assert_eq!(
        matches
            .iter()
            .map(|m| m["line"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [4, 6, 2]
    );
    assert_eq!(matches[0]["index"], 1);
}
#[test]
fn init_creates_valid_native_configuration_without_overwriting() {
    let w = Workspace::new();
    init::create(&w.context, "starter", "Starter", "Example", None).unwrap();
    assert!(init::create(&w.context, "starter", "Starter", "", None).is_err());
    let projects = config::discover(&w.context).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].patches.len(), 1);
    assert!(projects[0].config.generators.is_empty());
    assert!(
        fs::read_to_string(w.context.mods.join("starter/config/README.md"))
            .unwrap()
            .contains(env!("CARGO_PKG_REPOSITORY"))
    );
}
#[test]
fn starter_title_uses_the_mod_folder_and_updates_from_project_settings() {
    let w = Workspace::new();
    let target = w
        .context
        .game
        .join("GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf");
    paths::write_atomic(
        &target,
        "UISpecificOutGameWelcomeDescriptor is T(Components = [])\n",
    )
    .unwrap();
    init::create(
        &w.context,
        "starter",
        "A \"quoted\" title",
        "Hint \"text\"",
        None,
    )
    .unwrap();
    w.run("build");
    let csv = w
        .context
        .output
        .join("GameData/Localisation")
        .join(w.context.game.file_name().unwrap())
        .join("INTERFACE_OUTGAME.csv");
    let content = fs::read_to_string(&csv).unwrap();
    assert!(content.contains("\"A \"\"quoted\"\" title\""));
    assert!(content.contains("\"Hint \"\"text\"\"\""));
    let path = w.context.mods.join("starter/config/ymb.mod.yaml");
    let mut config: Value = config::load(&path).unwrap().0;
    config["name"] = json!("Updated");
    paths::write_atomic(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    w.run("build");
    assert!(fs::read_to_string(&csv).unwrap().contains("\"Updated\""));
}

#[cfg(windows)]
#[test]
fn junction_sources_cannot_escape_the_owning_project() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.patch("a","main",json!({"files":[{"op":"copy","source":{"root":"mod","path":"linked/keep.txt"},"destination":"CommonData/copied.txt"}]}));
    let outside = w._temp.path().join("outside");
    paths::write_atomic(&outside.join("keep.txt"), "keep").unwrap();
    let link = w.context.mods.join("a/config/linked");
    let output=Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","New-Item -ItemType Junction -Path $env:YMB_TEST_LINK -Target $env:YMB_TEST_TARGET | Out-Null"]).env("YMB_TEST_LINK",&link).env("YMB_TEST_TARGET",&outside).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(paths::is_link(&fs::symlink_metadata(&link).unwrap()));
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    assert_eq!(
        fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "keep"
    );
}
#[test]
fn starter_localisation_keys_are_short_stable_and_distinguish_similar_ids() {
    let w = Workspace::new();
    let mut seen = std::collections::HashSet::new();
    for id in [
        "long_project_prefix_a",
        "long_project_prefix_b",
        "a-b",
        "a_b",
    ] {
        init::create(&w.context, id, "Name", "Hint", None).unwrap();
        let config: Value = config::load(&w.context.mods.join(id).join("config/ymb.mod.yaml"))
            .unwrap()
            .0;
        for key in ["titleToken", "detailToken"] {
            let token = config["variables"][key].as_str().unwrap();
            assert!(token.len() <= 10 && token.is_ascii());
            assert!(seen.insert(token.to_owned()));
        }
    }
    let other = Workspace::new();
    init::create(
        &other.context,
        "long_project_prefix_a",
        "Another name",
        "Another hint",
        None,
    )
    .unwrap();
    let read = |w: &Workspace| -> Value {
        config::load(
            &w.context
                .mods
                .join("long_project_prefix_a/config/ymb.mod.yaml"),
        )
        .unwrap()
        .0
    };
    assert_eq!(read(&w)["variables"], read(&other)["variables"]);
}

#[test]
fn example_assets_are_resolved_beside_the_warno_mod() {
    let mut w = Workspace::new();
    let game = w._temp.path().join("Mods/Example");
    paths::write_atomic(&game.join("GameData/A.ndf"), SOURCE).unwrap();
    fs::create_dir_all(game.join("CommonData")).unwrap();
    let asset = w
        ._temp
        .path()
        .join("Mods/ExampleAssets/Meshes/Sample/texture.bin");
    paths::write_atomic(&asset, [0, 255, 9]).unwrap();
    w.write(
        "ymb.config.yaml",
        serde_json::to_vec(&json!({
            "version":metadata::CONFIG_VERSION,"paths":{"gameRoot":"../Mods/Example"}
        }))
        .unwrap(),
    );
    w.context = Context::resolve(Some(&w.context.root)).unwrap();
    w.project("assets", json!({}));
    w.patch(
        "assets",
        "mesh",
        json!({"files":[{
            "op":"copy",
            "source":{"root":"exampleAssets","path":"Meshes/Sample"},
            "destination":"GameData/Assets/Sample",
            "expect":{"files":1}
        }]}),
    );
    w.run("build");
    assert_eq!(
        fs::read(w.context.output.join("GameData/Assets/Sample/texture.bin")).unwrap(),
        [0, 255, 9]
    );
    assert_eq!(w.game(), SOURCE);
}
