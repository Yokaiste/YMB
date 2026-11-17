use super::*;

#[test]
fn tolerated_no_ops_are_warnings_in_successful_and_cached_reports() {
    let w = Workspace::new();
    w.project("noop", json!({}));
    w.patch(
        "noop",
        "main",
        json!({
            "files":[{"op":"remove","target":"GameData/Absent.txt"}],
            "targets":[{"file":"GameData/A.ndf","operations":[
                {"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":1},
                {"op":"remove","selector":{"kind":"object","by":"name","value":"Absent"}}
            ]}]
        }),
    );
    for command in ["build", "build", "sync"] {
        let mut report = json!({"status":"ok", "data":w.run(command)});
        crate::diagnostics::attach(&mut report);
        assert_eq!(report["diagnosticCounts"]["error"], 0, "{report}");
        assert_eq!(report["diagnosticCounts"]["warning"], 3, "{report}");
        for code in ["W8", "W9", "W10"] {
            assert_eq!(report["diagnostics"][code]["severity"], "warning");
        }
    }
    assert!(w.game().contains(SOURCE));
}

#[test]
fn failed_projects_do_not_run_their_dependents_or_later_layers() {
    let w = Workspace::new();
    for (id, extra) in [
        ("a", json!({})),
        ("b", json!({"priority":10,"allowWriteToModifiedFiles":true})),
        ("c", json!({"priority":20,"dependsOn":["b"]})),
        ("independent", json!({})),
    ] {
        w.project(id, extra);
        w.field(id, "main", &format!("Missing_{id}.X"), 4);
    }
    let error = commands::build(w.context.clone(), Selection::default(), "build").unwrap_err();
    let owners: Vec<_> = error
        .related
        .iter()
        .map(|e| e.context["modId"].as_str().unwrap())
        .collect();
    assert_eq!(owners, ["a", "independent"], "{error:?}");
    assert_eq!(w.game(), SOURCE);

    w.patch(
        "a",
        "main",
        json!({"optional":true,"targets":[{
            "file":"GameData/A.ndf","operations":[{
                "op":"modify","selector":{"kind":"field","by":"path","value":"Missing.X"},"value":4
            }]
        }]}),
    );
    w.field("b", "main", "A.X", 6);
    w.field("c", "main", "B.X", 7);
    w.field("independent", "main", "A.Y", 8);
    let report = w.run("build");
    assert_eq!(report["skippedPatches"].as_array().unwrap().len(), 1);
    let output = fs::read_to_string(w.context.output.join("GameData/A.ndf")).unwrap();
    assert!(output.contains("X = 6") && output.contains("X = 7") && output.contains("Y = 8"));
}

#[test]
fn unknown_filters_and_missing_rust_preserve_the_previous_preview() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 7);
    w.run("build");
    let preview = w.context.output.join("GameData/A.ndf");
    let saved = fs::read(&preview).unwrap();
    for (mods, patches) in [
        (vec!["typo".into()], vec![]),
        (vec!["a".into(), "typo".into()], vec![]),
        (vec!["a".into()], vec!["typo".into()]),
    ] {
        let selection = Selection {
            mod_filters: mods,
            patch_filters: patches,
            ..Default::default()
        };
        let error = commands::build(w.context.clone(), selection.clone(), "build").unwrap_err();
        assert_eq!(error.code.as_deref(), Some("E1"));
        assert!(error.context["unmatchedFilters"].is_array());
        assert_eq!(
            commands::cleanup(w.context.clone(), selection, false)
                .unwrap_err()
                .code
                .as_deref(),
            Some("E1")
        );
        assert_eq!(fs::read(&preview).unwrap(), saved);
        assert_eq!(w.game(), SOURCE);
    }
    w.project(
        "a",
        json!({"generators":[{"id":"source","project":"generator/Cargo.toml"}]}),
    );
    w.write(
        "mods/a/config/generator/Cargo.toml",
        "[package]\nname='source'\nversion='0.1.0'\nrust-version='999.0'\n[workspace]\n",
    );
    let error = commands::build(w.context.clone(), Selection::default(), "build").unwrap_err();
    assert_eq!(error.code.as_deref(), Some("E38"));
    assert_eq!(error.context["requiredVersion"], "999.0.0");
    assert_eq!(fs::read(&preview).unwrap(), saved);
    assert_eq!(w.game(), SOURCE);
    assert!(!w.context.lock.exists());
}

#[test]
fn parallel_patches_preserve_serial_outputs_and_error_order() {
    let mut w = Workspace::new();
    w.project("parallel", json!({}));
    for i in 0..12 {
        let target = format!("GameData/Shared/Nested/F{i:02}.ndf");
        let source = format!(
            "// {}\n{SOURCE}",
            "padding".repeat(if i == 0 { 32768 } else { 4096 })
        );
        paths::write_atomic(&w.context.game.join(&target), source).unwrap();
        w.patch("parallel", &format!("p{i:02}"), json!({"targets":[{"file":target,"operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":4}]}]}));
    }
    let selection = Selection {
        use_cache: false,
        ..Default::default()
    };
    w.context.config.settings.worker_threads = Some(1);
    let serial = commands::build(w.context.clone(), selection.clone(), "build").unwrap();
    w.context.config.settings.worker_threads = Some(4);
    let parallel = commands::build(w.context.clone(), selection.clone(), "build").unwrap();
    assert_eq!(serial["outputs"], parallel["outputs"]);
    assert_eq!(serial["notices"], parallel["notices"]);
    for i in [1, 8] {
        paths::write_atomic(
            &w.context
                .game
                .join(format!("GameData/Shared/Nested/F{i:02}.ndf")),
            "A is T(X = )",
        )
        .unwrap();
    }
    w.context.config.settings.worker_threads = Some(1);
    let serial = commands::build(w.context.clone(), selection.clone(), "validate").unwrap_err();
    w.context.config.settings.worker_threads = Some(4);
    let parallel = commands::build(w.context.clone(), selection, "validate").unwrap_err();
    assert_eq!(
        serde_json::to_value(serial).unwrap(),
        serde_json::to_value(parallel).unwrap()
    );
}

#[test]
fn concurrent_cache_access_keeps_checksums_and_capacity_limits() {
    let mut w = Workspace::new();
    w.context.config.settings.cache_max_entries = 4;
    w.context.config.settings.cache_max_bytes = 8 << 20;
    let cache = crate::store::Cache::new(&w.context, true);
    let store = crate::store::Store::new(&w.context).unwrap();
    let snapshots: Vec<_> = (0..8)
        .map(|i| {
            store
                .put(vec![i as u8; 2 << 20], ymb_sdk::ContentKind::Binary)
                .unwrap()
        })
        .collect();
    let indexes: Vec<_> = (0..8).collect();
    let limits = ymb_core::parallel::Limits {
        threads: 4,
        memory_bytes: 16 << 20,
    };
    for result in ymb_core::parallel::map(
        &indexes,
        limits,
        |_| 2usize << 20,
        |i| cache.write("generator:fixture:parallel", &i.to_string(), &snapshots[*i]),
    ) {
        result.unwrap();
    }
    let retained = ymb_core::parallel::map(
        &indexes,
        limits,
        |_| 2usize << 20,
        |i| {
            let found = cache
                .read(&store, "generator:fixture:parallel", &i.to_string())
                .unwrap();
            if let Some(snapshot) = &found {
                assert_eq!(snapshot.hash, snapshots[*i].hash);
                assert_eq!(snapshot.read().unwrap(), vec![*i as u8; 2 << 20]);
            }
            found.is_some()
        },
    );
    assert_eq!(retained.iter().filter(|value| **value).count(), 4);
    assert!(cache.take_notices().is_empty());
    assert_eq!(paths::walk(&w.context.cache, true).unwrap().len(), 8);
}

#[test]
fn cache_reads_refresh_eviction_order_across_commands() {
    let mut w = Workspace::new();
    w.context.config.settings.cache_max_entries = 2;
    let store = crate::store::Store::new(&w.context).unwrap();
    let cache = crate::store::Cache::new(&w.context, true);
    for key in ["a", "b"] {
        cache
            .write(
                "fixture",
                key,
                &store.put(key, ymb_sdk::ContentKind::Binary).unwrap(),
            )
            .unwrap();
    }
    assert!(cache.read(&store, "fixture", "a").unwrap().is_some());
    let cache = crate::store::Cache::new(&w.context, true);
    cache
        .write(
            "fixture",
            "c",
            &store.put("c", ymb_sdk::ContentKind::Binary).unwrap(),
        )
        .unwrap();
    assert!(cache.read(&store, "fixture", "a").unwrap().is_some());
    assert!(cache.read(&store, "fixture", "b").unwrap().is_none());
    assert!(cache.read(&store, "fixture", "c").unwrap().is_some());
}

#[test]
fn failed_builds_still_prune_old_cache_entries_and_orphaned_work() {
    let mut w = Workspace::new();
    w.context.config.settings.cache_max_entries = 1;
    w.project("a", json!({"priority":-10}));
    w.field("a", "main", "A.X", 4);
    w.run("build");
    paths::write_atomic(
        &w.context.cache.join("abandoned.tmp"),
        "orphaned cache work",
    )
    .unwrap();
    w.field("a", "main", "A.X", 8);
    w.native("fail");
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    let cache = paths::walk(&w.context.cache, true).unwrap();
    assert!(
        cache
            .iter()
            .filter(|path| path
                .extension()
                .is_some_and(|extension| extension == "json"))
            .count()
            <= 1
    );
    assert!(!w.context.cache.join("abandoned.tmp").exists());
    assert_eq!(w.game(), SOURCE);
}

#[test]
fn fresh_build_discards_old_work_and_failed_output_without_losing_recovery() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.run("sync");
    let manifest = paths::hash_file(&w.context.state.join("manifest.json")).unwrap();
    paths::write_atomic(
        &w.context.work.join("generators/old/compiler-data"),
        "old build",
    )
    .unwrap();
    w.run("build");
    assert!(!w.context.work.join("generators").exists());
    assert_eq!(fs::read_dir(&w.context.work).unwrap().count(), 1);
    assert_eq!(
        paths::hash_file(&w.context.state.join("manifest.json")).unwrap(),
        manifest
    );
    w.field("a", "main", "Missing.X", 8);
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    assert!(!w.context.output.exists());
    assert_eq!(
        paths::hash_file(&w.context.state.join("manifest.json")).unwrap(),
        manifest
    );
    commands::recover(w.context.clone(), Selection::default()).unwrap();
    assert_eq!(w.game(), SOURCE);
}

#[test]
fn preview_is_repeatable_and_never_writes_game_files() {
    let w = Workspace::new();
    w.project("one", json!({}));
    w.field("one", "main", "A.X", 4);
    let first = w.run("build");
    let preview = w.context.output.join("GameData/A.ndf");
    let hash = paths::hash_file(&preview).unwrap();
    let second = w.run("build");
    assert_eq!(w.game(), SOURCE);
    assert_eq!(paths::hash_file(&preview).unwrap(), hash);
    assert_eq!(first["outputs"], second["outputs"]);
    assert_eq!(second["metrics"]["cacheHits"], 1);
}
#[test]
fn changed_targets_fail_without_reset_and_reset_restores_baseline() {
    let w = Workspace::new();
    w.project("one", json!({}));
    w.field("one", "main", "A.X", 4);
    w.run("sync");
    paths::write_atomic(&w.context.game.join("GameData/A.ndf"), "external").unwrap();
    assert!(commands::build(w.context.clone(), Selection::default(), "sync").is_err());
    let selection = Selection {
        reset_changed: true,
        ..Default::default()
    };
    let result = commands::build(w.context.clone(), selection, "sync").unwrap();
    assert_eq!(result["warnings"].as_array().unwrap().len(), 1);
    assert!(w.game().contains("X = 4"));
    commands::recover(w.context.clone(), Selection::default()).unwrap();
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn independent_fields_merge_and_conflicts_fail_before_publication() {
    let w = Workspace::new();
    for id in ["a", "b"] {
        w.project(id, json!({}));
    }
    w.field("a", "main", "A.X", 4);
    w.field("b", "main", "A.Y", 8);
    w.run("build");
    let preview = w.context.output.join("GameData/A.ndf");
    let source = fs::read_to_string(&preview).unwrap();
    assert!(source.contains("X = 4") && source.contains("Y = 8"));
    w.field("b", "main", "A.X", 8);
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    assert!(!preview.exists());
    assert_eq!(w.game(), SOURCE);
}

#[test]
fn partial_sync_cannot_drop_unselected_contributions_to_shared_files() {
    for separate_projects in [true, false] {
        let w = Workspace::new();
        w.project("a", json!({}));
        if separate_projects {
            w.project("b", json!({}));
        }
        w.field("a", "first", "A.X", 4);
        w.field(
            if separate_projects { "b" } else { "a" },
            "second",
            "A.Y",
            8,
        );
        w.run("sync");
        let before = w.game();
        let manifest = fs::read(w.context.state.join("manifest.json")).unwrap();
        let selection = Selection {
            mod_filters: vec!["a".into()],
            patch_filters: if separate_projects {
                vec![]
            } else {
                vec!["first".into()]
            },
            ..Default::default()
        };
        for dry_run in [true, false] {
            let error = commands::build(
                w.context.clone(),
                Selection {
                    dry_run,
                    ..selection.clone()
                },
                "sync",
            )
            .unwrap_err();
            assert_eq!(error.code.as_deref(), Some("E21"));
            assert_eq!(w.game(), before);
            assert_eq!(
                fs::read(w.context.state.join("manifest.json")).unwrap(),
                manifest
            );
        }
        w.run("sync");
        assert_eq!(w.game(), before);
        commands::recover(w.context.clone(), Selection::default()).unwrap();
        commands::build(w.context.clone(), selection, "sync").unwrap();
        assert!(w.game().contains("X = 4") && w.game().contains("Y = 2"));
    }
}
#[test]
fn explicit_ordering_requires_write_permission() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.project(
        "b",
        json!({"dependsOn":["a"],"allowWriteToModifiedFiles":true}),
    );
    w.field("a", "main", "A.X", 4);
    w.field("b", "main", "A.X", 8);
    w.run("build");
    assert!(
        fs::read_to_string(w.context.output.join("GameData/A.ndf"))
            .unwrap()
            .contains("X = 8")
    );
    w.project("b", json!({"dependsOn":["a"]}));
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
}
#[test]
fn optional_missing_patch_and_dependents_are_skipped_but_syntax_is_not() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.patch(
        "a",
        "missing",
        json!({"optional":true,"targets":[{"file":"GameData/Missing.ndf","operations":[{"op":"remove","selector":{"kind":"object","by":"name","value":"Missing"}}]}]}),
    );
    w.patch("a", "dependent", json!({"dependsOn":["missing"]}));
    assert_eq!(
        w.run("validate")["skippedPatches"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let selection = Selection {
        require_all: true,
        ..Default::default()
    };
    assert!(commands::build(w.context.clone(), selection, "validate").is_err());
    w.patch("a","missing",json!({"optional":true,"targets":[{"file":"GameData/A.ndf","operations":[{"op":"unknown"}]}]}));
    assert!(commands::build(w.context.clone(), Selection::default(), "validate").is_err());
}
#[test]
fn ordered_file_operations_cancel_add_then_remove() {
    let w = Workspace::new();
    w.project("files", json!({}));
    w.write("mods/files/config/data.txt", "hello");
    w.patch("files","main",json!({"files":[{"op":"add","source":{"root":"mod","path":"data.txt"},"destination":"CommonData/new.txt"},{"op":"remove","target":"CommonData/new.txt"}]}));
    w.run("sync");
    assert!(!w.context.game.join("CommonData/new.txt").exists());
    assert!(Manifest::load(&w.context).unwrap().entries.is_empty());
}
#[test]
fn required_references_ignore_definitions_comments_and_strings() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.patch("a","main",json!({"targets":[{"file":"GameData/A.ndf","expect":{"referenced":["A"]},"operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":4}]}]}));
    paths::write_atomic(
        &w.context.game.join("CommonData/refs.ndf"),
        "Note is '// A' // A\n",
    )
    .unwrap();
    assert!(commands::build(w.context.clone(), Selection::default(), "validate").is_err());
    paths::write_atomic(
        &w.context.game.join("CommonData/refs.ndf"),
        "Alias is ~/A\n",
    )
    .unwrap();
    w.run("validate");
    w.write(
        "mods/a/config/replace/CommonData/refs.ndf",
        "Alias is ~/A\n",
    );
    paths::write_atomic(&w.context.game.join("CommonData/0-unrelated.ndf"), [255]).unwrap();
    w.run("validate");
    fs::remove_file(w.context.game.join("CommonData/0-unrelated.ndf")).unwrap();
    fs::remove_file(w.context.game.join("CommonData/refs.ndf")).unwrap();
    fs::remove_dir(w.context.game.join("CommonData")).unwrap();
    paths::write_atomic(&w.context.game.join("CommonData"), "unrelated file").unwrap();
    w.run("validate");
}
#[test]
fn deletion_cannot_silently_overwrite_an_independent_project() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.project("b", json!({}));
    w.field("a", "main", "A.X", 4);
    w.patch(
        "b",
        "remove",
        json!({"files":[{"op":"remove","target":"GameData/A.ndf"}]}),
    );
    assert!(commands::build(w.context.clone(), Selection::default(), "sync").is_err());
    assert_eq!(w.game(), SOURCE);
    w.project(
        "b",
        json!({"dependsOn":["a"],"allowWriteToModifiedFiles":true}),
    );
    w.run("sync");
    assert!(!w.context.game.join("GameData/A.ndf").exists());
    commands::recover(w.context.clone(), Selection::default()).unwrap();
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn reusable_cache_payloads_survive_age_and_identical_writes() {
    let mut w = Workspace::new();
    w.context
        .config
        .settings
        .generator_cache_max_bytes_per_namespace = 1;
    let cache = crate::store::Cache::new(&w.context, true);
    let store = crate::store::Store::new(&w.context).unwrap();
    let snapshot = store.put("reusable", ymb_sdk::ContentKind::Text).unwrap();
    cache.write("test", "key", &snapshot).unwrap();
    let identity = crate::store::Cache::identity("test", "key");
    let payload = w.context.cache.join(format!("{identity}.bin"));
    let metadata = w.context.cache.join(format!("{identity}.json"));
    let modified = fs::metadata(&payload).unwrap().modified().unwrap();
    let mut entry: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    entry["used"] = json!(1);
    paths::write_atomic(&metadata, serde_json::to_vec(&entry).unwrap()).unwrap();
    cache.prune().unwrap();
    assert_eq!(
        cache
            .read(&store, "test", "key")
            .unwrap()
            .unwrap()
            .text()
            .unwrap(),
        "reusable"
    );
    cache.write("test", "key", &snapshot).unwrap();
    assert_eq!(
        fs::metadata(&payload).unwrap().modified().unwrap(),
        modified
    );
    cache
        .write("generator:too-small", "key", &snapshot)
        .unwrap();
    assert!(
        !w.context
            .cache
            .join(format!(
                "{}.bin",
                crate::store::Cache::identity("generator:too-small", "key")
            ))
            .exists()
    );
}

#[test]
fn cache_corruption_is_a_miss_and_does_not_change_the_result() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    let first = w.run("build");
    for path in paths::walk(&w.context.cache, true).unwrap() {
        if path.extension().is_some_and(|e| e == "bin") {
            let mut bytes = fs::read(&path).unwrap();
            bytes[0] ^= 1;
            paths::write_atomic(&path, bytes).unwrap();
        }
    }
    let second = w.run("build");
    assert_eq!(first["outputs"], second["outputs"]);
    assert_eq!(second["metrics"]["cacheHits"], 0);
}

#[test]
fn unavailable_cache_does_not_fail_valid_output() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    paths::write_atomic(&w.context.cache, "cache root occupied by a file").unwrap();
    let result = w.run("build");
    assert!(
        fs::read_to_string(w.context.output.join("GameData/A.ndf"))
            .unwrap()
            .contains("X = 4")
    );
    assert!(
        result["notices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["cacheRoot"].is_string())
    );
    let cache = crate::store::Cache::new(&w.context, true);
    cache.prune().unwrap();
    fs::remove_file(&w.context.cache).unwrap();
    let store = crate::store::Store::new(&w.context).unwrap();
    let payload = store
        .put("result", ymb_sdk::protocol::ContentKind::Text)
        .unwrap();
    cache.write("test", "key", &payload).unwrap();
    assert!(!w.context.cache.exists());
    assert_eq!(cache.take_notices().len(), 1);
}
#[test]
fn independent_generated_regions_compose_without_declaring_project_layering() {
    let w = Workspace::new();
    for id in ["a", "b"] {
        w.project(id,json!({"variables":{"behavior":"regions"},"generators":[{"id":"generate","executable":"fixture.exe"}]}));
        paths::copy_atomic(
            &fixture(),
            &w.context.mods.join(id).join("config/fixture.exe"),
        )
        .unwrap();
    }
    w.run("build");
    let output = fs::read_to_string(w.context.output.join("GameData/regions.ndf")).unwrap();
    assert!(output.contains("Generated_a_generate"));
    assert!(output.contains("Generated_b_generate"));
}
#[test]
fn generated_region_delegation_stays_inside_the_registered_project() {
    let w = Workspace::new();
    w.native("foreign-claim");
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    assert!(!w.context.output.exists());
}
#[test]
fn file_template_behavior_follows_the_source_extension() {
    let w = Workspace::new();
    w.project("files", json!({}));
    w.write("mods/files/config/text.txt", "${modName}");
    w.write("mods/files/config/binary.bin", [0, 255, 1]);
    w.patch("files","main",json!({"files":[{"op":"copy","source":{"root":"mod","path":"text.txt"},"destination":"CommonData/text.bin"},{"op":"copy","source":{"root":"mod","path":"binary.bin"},"destination":"CommonData/binary.txt"}]}));
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.output.join("CommonData/text.bin")).unwrap(),
        "files"
    );
    assert_eq!(
        fs::read(w.context.output.join("CommonData/binary.txt")).unwrap(),
        [0, 255, 1]
    );
}
#[test]
fn file_and_ndf_ownership_collisions_do_not_depend_on_patch_order() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "first", "A.X", 3);
    w.write("mods/a/config/source.ndf", SOURCE);
    w.patch("a","last",json!({"dependsOn":["first"],"files":[{"op":"copy","source":{"root":"mod","path":"source.ndf"},"destination":"GameData/A.ndf"}]}));
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
}
