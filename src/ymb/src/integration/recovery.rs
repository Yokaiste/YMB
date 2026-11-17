use super::*;

#[test]
fn doctor_reports_external_edits_and_pending_recovery_without_writing() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.run("sync");
    paths::write_atomic(&w.context.game.join("GameData/A.ndf"), "external").unwrap();
    let transaction = Transaction::begin(&w.context, "interrupted").unwrap();
    let result = commands::inspect(w.context.clone(), Selection::default(), "doctor").unwrap();
    let errors = result["errors"].as_array().unwrap();
    assert!(errors.iter().any(|error| error["code"] == "E12"));
    assert!(errors.iter().any(|error| error["code"] == "E11"));
    assert_eq!(result["trackedFiles"]["GameData/A.ndf"], "changed");
    assert_eq!(w.game(), "external");
    assert!(w.context.journal.exists());
    transaction.rollback().unwrap();
}

#[test]
fn sync_is_idempotent_and_recovery_is_byte_exact() {
    let w = Workspace::new();
    w.project("one", json!({}));
    w.field("one", "main", "A.X", 4);
    assert_eq!(w.run("sync")["changedFiles"], 1);
    let synced = w.game();
    assert!(synced.contains("X = 4"));
    assert_eq!(
        fs::read_to_string(w.context.output.join("GameData/A.ndf")).unwrap(),
        synced
    );
    assert_eq!(w.run("sync")["changedFiles"], 0);
    assert_eq!(w.game(), synced);
    commands::recover(w.context.clone(), Selection::default()).unwrap();
    assert_eq!(w.game(), SOURCE);
    assert!(Manifest::load(&w.context).unwrap().entries.is_empty());
}
#[test]
fn corrupted_originals_abort_before_any_write() {
    let w = Workspace::new();
    w.project("one", json!({}));
    w.field("one", "main", "A.X", 4);
    w.run("sync");
    let manifest = Manifest::load(&w.context).unwrap();
    let backup = w
        .context
        .state
        .join("originals")
        .join(&manifest.entries[0].backup_file_name);
    paths::write_atomic(&backup, "damaged").unwrap();
    let before = w.game();
    assert!(commands::recover(w.context.clone(), Selection::default()).is_err());
    assert_eq!(w.game(), before);
}
#[test]
fn obsolete_outputs_restore_originals_on_next_sync() {
    let w = Workspace::new();
    w.project("one", json!({}));
    w.field("one", "main", "A.X", 4);
    w.run("sync");
    w.patch("one", "main", json!({"enabled":false}));
    w.run("sync");
    assert_eq!(w.game(), SOURCE);
    assert!(Manifest::load(&w.context).unwrap().entries.is_empty());
}

#[test]
fn dependency_and_disabled_project_scopes_restore_only_their_own_obsolete_files() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.project("b", json!({"dependsOn":["a"]}));
    w.field("a", "main", "A.X", 4);
    let selection = Selection {
        mod_filters: vec!["b".into()],
        ..Default::default()
    };
    commands::build(w.context.clone(), selection.clone(), "sync").unwrap();
    w.patch("a", "main", json!({"enabled":false}));
    commands::build(w.context.clone(), selection, "sync").unwrap();
    assert_eq!(w.game(), SOURCE);
    assert!(Manifest::load(&w.context).unwrap().entries.is_empty());

    w.project("b", json!({}));
    w.field("a", "main", "A.X", 4);
    paths::write_atomic(&w.context.game.join("CommonData/B.ndf"), SOURCE).unwrap();
    w.patch("b", "main", json!({"targets":[{"file":"CommonData/B.ndf","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.Y"},"value":8}]}]}));
    w.run("sync");
    let retained = fs::read(w.context.game.join("CommonData/B.ndf")).unwrap();
    w.project("a", json!({"enabled":false}));
    commands::build(
        w.context.clone(),
        Selection {
            mod_filters: vec!["a".into()],
            ..Default::default()
        },
        "sync",
    )
    .unwrap();
    assert_eq!(w.game(), SOURCE);
    assert_eq!(
        fs::read(w.context.game.join("CommonData/B.ndf")).unwrap(),
        retained
    );
    assert_eq!(Manifest::load(&w.context).unwrap().entries.len(), 1);
}
#[test]
fn file_operations_keep_binary_bytes_and_recover_deletions() {
    let w = Workspace::new();
    w.project("files", json!({}));
    w.write("mods/files/config/payload.bin", [0, 255, 9]);
    w.patch("files","main",json!({"files":[{"op":"add","source":{"root":"mod","path":"payload.bin"},"destination":"CommonData/copied.bin"},{"op":"remove","target":"GameData/A.ndf","expect":{"files":1}}]}));
    w.run("sync");
    assert!(!w.context.game.join("GameData/A.ndf").exists());
    assert_eq!(
        fs::read(w.context.game.join("CommonData/copied.bin")).unwrap(),
        [0, 255, 9]
    );
    w.run("sync");
    commands::recover(w.context.clone(), Selection::default()).unwrap();
    assert_eq!(w.game(), SOURCE);
    assert!(!w.context.game.join("CommonData/copied.bin").exists());
}
#[test]
fn file_sources_always_use_saved_game_originals() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.run("sync");
    w.project("b", json!({}));
    w.patch("b","copy",json!({"files":[{"op":"copy","source":{"root":"game","path":"GameData/A.ndf"},"destination":"CommonData/copy.ndf"}]}));
    let selection = Selection {
        mod_filters: vec!["b".into()],
        ..Default::default()
    };
    commands::build(w.context.clone(), selection, "build").unwrap();
    assert_eq!(
        fs::read_to_string(w.context.output.join("CommonData/copy.ndf")).unwrap(),
        SOURCE
    );
}
#[test]
fn read_values_and_overrides_resolve_against_original_bytes() {
    let w = Workspace::new();
    w.project("a",json!({"readValues":{"x":{"file":"GameData/A.ndf","path":"A.X"}},"variables":{"wanted":"${x + 2}"}}));
    w.patch("a","main",json!({"targets":[{"file":"GameData/A.ndf","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":"${wanted}"}]}]}));
    w.run("sync");
    assert!(w.game().contains("X = 3"));
    w.run("sync");
    assert!(w.game().contains("X = 3"));
}
#[test]
fn transaction_rollback_restores_touched_roots_and_removes_new_files() {
    let w = Workspace::new();
    let mut tx = Transaction::begin(&w.context, "test").unwrap();
    tx.write(Root::Game, "GameData/A.ndf", b"changed").unwrap();
    tx.write(Root::Mods, "one/config/store.txt", b"authored")
        .unwrap();
    tx.write(Root::State, "manifest.json", b"changed").unwrap();
    drop(tx);
    assert!(state::recover_pending(&w.context).unwrap());
    assert_eq!(w.game(), SOURCE);
    assert!(!w.context.mods.join("one/config/store.txt").exists());
    assert!(!w.context.state.join("manifest.json").exists());
}
#[test]
fn damaged_journal_aborts_before_restoring_any_target() {
    let w = Workspace::new();
    let mut tx = Transaction::begin(&w.context, "test").unwrap();
    tx.write(Root::Game, "GameData/A.ndf", b"changed").unwrap();
    drop(tx);
    let snapshots = paths::walk(&w.context.journal.join("snapshots"), true).unwrap();
    paths::write_atomic(&snapshots[0], "bad").unwrap();
    assert!(state::recover_pending(&w.context).is_err());
    assert_eq!(w.game(), "changed");
}
#[test]
fn preview_swap_is_recovered_after_interruption() {
    let w = Workspace::new();
    paths::write_atomic(&w.context.output.join("old.txt"), "old").unwrap();
    let staged = w.context.work.join("staged");
    paths::write_atomic(&staged.join("new.txt"), "new").unwrap();
    let mut tx = Transaction::begin(&w.context, "test").unwrap();
    tx.publish_preview(&staged).unwrap();
    drop(tx);
    state::recover_pending(&w.context).unwrap();
    assert!(w.context.output.join("old.txt").exists());
    assert!(!w.context.output.join("new.txt").exists());
}
#[test]
fn locks_are_exclusive_and_release_without_leftovers() {
    let w = Workspace::new();
    let lock = OperationLock::acquire(&w.context, "test").unwrap();
    assert!(OperationLock::acquire(&w.context, "other").is_err());
    let owner: Value =
        serde_json::from_slice(&fs::read(w.context.lock.join("owner.json")).unwrap()).unwrap();
    assert!(owner["startedAt"].as_str().unwrap().ends_with('Z'));
    drop(lock);
    assert!(!w.context.lock.exists());
    OperationLock::acquire(&w.context, "again").unwrap();
}

#[test]
fn concurrent_lock_requests_remain_exclusive_and_report_contention() {
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    let w = Workspace::new();
    let barrier = Barrier::new(12);
    let owners = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..12 {
            scope.spawn(|| {
                barrier.wait();
                for _ in 0..12 {
                    match OperationLock::acquire(&w.context, "concurrent") {
                        Ok(lock) => {
                            assert_eq!(owners.fetch_add(1, Ordering::SeqCst), 0);
                            std::thread::yield_now();
                            assert_eq!(owners.fetch_sub(1, Ordering::SeqCst), 1);
                            drop(lock);
                        }
                        Err(error) => assert_eq!(error.category, "CommandError", "{error}"),
                    }
                }
            });
        }
    });
    assert_eq!(owners.load(Ordering::SeqCst), 0);
    assert!(!w.context.lock.exists());
}
#[test]
fn cleanup_refuses_to_destroy_live_recovery() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.run("sync");
    assert!(commands::cleanup(w.context.clone(), Selection::default(), true).is_err());
    commands::cleanup(w.context.clone(), Selection::default(), false).unwrap();
    assert!(!w.context.work.exists());
    assert_eq!(Manifest::load(&w.context).unwrap().entries.len(), 1);
}
#[test]
fn marker_roundtrip_and_corruption_checks_handle_newlines() {
    for source in [
        "A is 1", "A is 1
", "A is 1
",
    ] {
        let bytes = state::marked_bytes(
            source.as_bytes(),
            "GameData/A.ndf",
            &[],
            Path::new("C:/YMB"),
            false,
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            state::unwrap_marked(&text, "GameData/A.ndf")
                .unwrap()
                .is_some()
        );
        assert!(state::unwrap_marked(&text.replace("A is 1", "A is 2"), "GameData/A.ndf").is_err());
        assert_ne!(hash(source), hash(text));
    }
}

#[test]
fn qualified_recovery_filters_match_the_manifest_without_project_discovery() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.run("sync");
    w.write("mods/a/config/ymb.mod.yaml", "broken: [");
    commands::recover(
        w.context.clone(),
        Selection {
            patch_filters: vec!["a:main".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn recovery_checks_every_filter_and_accepts_recorded_patch_names() {
    let w = Workspace::new();
    w.project("a", json!({"name":"Project A"}));
    w.project("b", json!({}));
    w.patch("a", "first", json!({"name":"First patch", "targets":[{"file":"GameData/A.ndf", "operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.X"},"value":4}]}]}));
    w.field("b", "second", "B.X", 6);
    w.run("sync");
    let live = w.game();
    let manifest = fs::read(w.context.state.join("manifest.json")).unwrap();
    let doctor = commands::inspect(w.context.clone(), Selection::default(), "doctor").unwrap();
    assert_eq!(
        doctor["trackedContributors"]["GameData/A.ndf"][0]["patchName"],
        "First patch"
    );
    for (mods, patches) in [
        (vec!["a", "unknown"], vec![]),
        (vec![], vec!["first", "unknown"]),
        (vec!["a"], vec!["second"]),
    ] {
        let selection = Selection {
            mod_filters: mods.into_iter().map(str::to_owned).collect(),
            patch_filters: patches.into_iter().map(str::to_owned).collect(),
            ..Default::default()
        };
        let error = commands::recover(w.context.clone(), selection).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("E1"));
        assert_eq!(w.game(), live);
        assert_eq!(
            fs::read(w.context.state.join("manifest.json")).unwrap(),
            manifest
        );
    }
    w.write("mods/a/config/ymb.mod.yaml", "broken: [");
    commands::recover(
        w.context.clone(),
        Selection {
            mod_filters: vec!["project a".into()],
            patch_filters: vec!["first PATCH".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(w.game(), SOURCE);
    commands::recover(
        w.context.clone(),
        Selection {
            mod_filters: vec!["a".into()],
            ..Default::default()
        },
    )
    .unwrap();
}
#[test]
fn rollback_refuses_a_missing_preview_before_restoring_other_files() {
    let w = Workspace::new();
    paths::write_atomic(&w.context.output.join("old.txt"), "old").unwrap();
    let staged = w.context.work.join("staged");
    paths::write_atomic(&staged.join("new.txt"), "new").unwrap();
    let mut tx = Transaction::begin(&w.context, "test").unwrap();
    tx.write(Root::Game, "GameData/A.ndf", b"changed").unwrap();
    tx.publish_preview(&staged).unwrap();
    drop(tx);
    let raw: Value =
        serde_json::from_slice(&fs::read(w.context.journal.join("transaction.json")).unwrap())
            .unwrap();
    let previous = w
        .context
        .work
        .join(raw["directories"][0]["previous"].as_str().unwrap());
    assert!(previous.starts_with(&w.context.work));
    fs::remove_dir_all(previous).unwrap();
    assert!(state::recover_pending(&w.context).is_err());
    assert_eq!(w.game(), "changed");
}
#[test]
fn tampered_committed_journals_cannot_delete_an_arbitrary_work_directory() {
    let w = Workspace::new();
    let tx = Transaction::begin(&w.context, "test").unwrap();
    drop(tx);
    let path = w.context.journal.join("transaction.json");
    let mut raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    raw["committed"] = json!(true);
    raw["directories"] = json!([{"path":"output","previous":"valuable","existed":true,"previousHash":hash("x"),"publishedHash":hash("x")}]);
    paths::write_atomic(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
    paths::write_atomic(&w.context.work.join("valuable/keep.txt"), "keep").unwrap();
    assert!(state::recover_pending(&w.context).is_err());
    assert!(w.context.work.join("valuable/keep.txt").exists());
}
#[test]
fn legacy_transaction_snapshots_remain_readable() {
    let w = Workspace::new();
    let journal = &w.context.journal;
    let manifest = b"{\"entries\":[]}";
    paths::write_atomic(&journal.join("state-before/manifest.json"), manifest).unwrap();
    let digest = hash(format!("F:manifest.json\0{}\0", hash(manifest)));
    let name = format!("{}.bin", hash("GameData/A.ndf"));
    paths::write_atomic(&journal.join("targets-before").join(&name), SOURCE).unwrap();
    let raw = json!({"version":1,"stateExisted":true,"stateSnapshotHash":digest,"targets":[{"targetRelativePath":"GameData/A.ndf","existed":true,"snapshotFileName":name,"contentHash":hash(SOURCE)}]});
    paths::write_atomic(
        &journal.join("transaction.json"),
        serde_json::to_vec(&raw).unwrap(),
    )
    .unwrap();
    paths::write_atomic(&w.context.game.join("GameData/A.ndf"), "interrupted").unwrap();
    assert!(state::recover_pending(&w.context).is_err());
    assert_eq!(w.game(), "interrupted");
    paths::write_atomic(&w.context.game.join("GameData/A.ndf"), SOURCE).unwrap();
    state::recover_pending(&w.context).unwrap();
    assert_eq!(w.game(), SOURCE);
    assert!(Manifest::load(&w.context).unwrap().entries.is_empty());
}

#[test]
fn pending_rollback_preserves_later_edits_and_dry_runs() {
    for target in ["GameData/A.ndf", "GameData/new.txt"] {
        let w = Workspace::new();
        let mut tx = Transaction::begin(&w.context, "sync").unwrap();
        tx.write(Root::Game, "GameData/A.ndf", b"partial").unwrap();
        tx.write(Root::Game, "GameData/new.txt", b"new partial")
            .unwrap();
        drop(tx);
        let journal = fs::read(w.context.journal.join("transaction.json")).unwrap();
        let selection = Selection {
            dry_run: true,
            ..Default::default()
        };
        assert!(commands::recover(w.context.clone(), selection.clone()).is_err());
        assert!(commands::build(w.context.clone(), selection.clone(), "build").is_err());
        assert!(commands::build(w.context.clone(), Selection::default(), "validate").is_err());
        assert!(commands::cleanup(w.context.clone(), selection, false).is_err());
        assert_eq!(w.game(), "partial");
        assert_eq!(
            fs::read(w.context.journal.join("transaction.json")).unwrap(),
            journal
        );
        paths::write_atomic(&w.context.game.join(target), "later manual edit").unwrap();
        assert!(state::recover_pending(&w.context).is_err());
        assert_eq!(
            fs::read_to_string(w.context.game.join(target)).unwrap(),
            "later manual edit"
        );
        assert!(w.context.game.join("GameData/new.txt").exists());
    }
}

#[test]
fn old_file_journals_refuse_unknown_postimages() {
    let w = Workspace::new();
    let mut tx = Transaction::begin(&w.context, "sync").unwrap();
    tx.write(Root::Game, "GameData/A.ndf", b"partial").unwrap();
    drop(tx);
    let path = w.context.journal.join("transaction.json");
    let mut raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    raw["version"] = json!(2);
    raw["files"][0]
        .as_object_mut()
        .unwrap()
        .remove("postimages");
    paths::write_atomic(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(state::recover_pending(&w.context).is_err());
    assert_eq!(w.game(), "partial");
    paths::write_atomic(&w.context.game.join("GameData/A.ndf"), SOURCE).unwrap();
    assert!(state::recover_pending(&w.context).unwrap());
}
#[test]
fn cleanup_protects_nested_configuration_and_authored_stores() {
    let w = Workspace::new();
    w.project("a", json!({"tempPaths":["patch"]}));
    w.field("a", "main", "A.X", 4);
    assert!(commands::cleanup(w.context.clone(), Selection::default(), false).is_err());
    w.project(
        "a",
        json!({"tempPaths":["data",{"path":"data/identity","unsafeToRemove":true}]}),
    );
    w.write("mods/a/config/data/identity/store.txt", "stable");
    commands::cleanup(w.context.clone(), Selection::default(), false).unwrap();
    assert!(
        w.context
            .mods
            .join("a/config/data/identity/store.txt")
            .exists()
    );
}

#[test]
fn cleanup_removes_only_selected_mod_storage_and_respects_dry_runs() {
    let w = Workspace::new();
    for id in ["a", "b"] {
        w.project(id, json!({}));
        w.write(
            &format!("mods/{id}/config/.ymb/g/compiled"),
            "reusable work",
        );
        w.write(&format!(".ymb/mods/{id}/cache/data"), "long-lived work");
        w.write(
            &format!("mods/{id}/config/identity.txt"),
            "authored identity",
        );
    }
    let mut selection = Selection {
        mod_filters: vec!["a".into()],
        dry_run: true,
        ..Default::default()
    };
    let report = commands::cleanup(w.context.clone(), selection.clone(), false).unwrap();
    assert!(
        report["paths"]
            .as_array()
            .unwrap()
            .contains(&json!(w.context.root.join(".ymb/mods/a/cache")))
    );
    assert!(w.context.mods.join("a/config/.ymb/g/compiled").exists());
    selection.dry_run = false;
    commands::cleanup(w.context.clone(), selection, false).unwrap();
    assert!(!w.context.root.join(".ymb/mods/a/cache").exists());
    assert!(w.context.root.join(".ymb/mods/b/cache/data").exists());
    for id in ["a", "b"] {
        assert_eq!(
            fs::read_to_string(w.context.mods.join(id).join("config/identity.txt")).unwrap(),
            "authored identity"
        );
    }
}

#[test]
fn cleanup_counts_only_paths_that_exist_and_were_removed() {
    let w = Workspace::new();
    let dry = Selection {
        dry_run: true,
        ..Default::default()
    };
    let report = commands::cleanup(w.context.clone(), dry.clone(), false).unwrap();
    assert_eq!(report["paths"], json!([]));
    w.write(".ymb/cache/entry", "disposable cache");
    let report = commands::cleanup(w.context.clone(), dry, false).unwrap();
    assert_eq!(report["paths"].as_array().unwrap().len(), 1);
    assert!(w.context.cache.join("entry").exists());
    let report = commands::cleanup(w.context.clone(), Selection::default(), false).unwrap();
    assert_eq!(report["paths"].as_array().unwrap().len(), 1);
    assert!(!w.context.cache.exists());
    let report = commands::cleanup(w.context.clone(), Selection::default(), false).unwrap();
    assert_eq!(report["paths"], json!([]));
}
#[cfg(windows)]
#[test]
fn a_failed_sync_rolls_back_earlier_writes() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    let blocked = w.context.game.join("GameData/Z.ndf");
    paths::write_atomic(&blocked, "Z is 1\n").unwrap();
    w.write("mods/a/config/replace/GameData/Z.ndf", "Z is 2\n");
    let original_permissions = fs::metadata(&blocked).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&blocked, permissions).unwrap();
    let result = commands::build(w.context.clone(), Selection::default(), "sync");
    fs::set_permissions(&blocked, original_permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(w.game(), SOURCE);
    assert_eq!(fs::read_to_string(&blocked).unwrap(), "Z is 1\n");
    assert!(!w.context.journal.exists());
}
#[test]
fn recovery_and_doctor_read_legacy_builder_paths_without_loading_old_projects() {
    let w = Workspace::new();
    w.write(
        "ymb.config.yaml",
        "version: 1\nsettings: {scriptTimeoutSeconds: 99}\n",
    );
    w.write(
        "mods/old/config/ymb.mod.yaml",
        "version: 1\nscripts: [old-script.ts]\n",
    );
    assert!(Context::resolve(Some(&w.context.root)).is_err());
    let context = Context::resolve_recovery(Some(&w.context.root)).unwrap();
    assert!(commands::inspect(context.clone(), Selection::default(), "doctor").is_ok());
    commands::recover(context, Selection::default()).unwrap();
}
#[test]
fn legacy_hashless_markers_and_remaining_script_metadata_are_preserved() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.project("b", json!({}));
    w.field("a", "main", "A.X", 4);
    paths::write_atomic(&w.context.game.join("GameData/Z.ndf"), "Z is 1\n").unwrap();
    w.write("mods/b/config/replace/GameData/Z.ndf", "Z is 2\n");
    w.run("sync");
    let manifest = w.context.state.join("manifest.json");
    let mut raw: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    raw.as_object_mut().unwrap().remove("version");
    for entry in raw["entries"].as_array_mut().unwrap() {
        entry["originalContentHash"] = Value::Null;
        entry["syncedContentHash"] = Value::Null;
        entry["contributors"][0]["scriptPath"] = json!("legacy/generate.ts");
    }
    paths::write_atomic(&manifest, serde_json::to_vec(&raw).unwrap()).unwrap();
    for entry in &Manifest::load(&w.context).unwrap().entries {
        assert_eq!(
            state::classify(&w.context, entry).unwrap(),
            state::TrackedState::Synced
        );
    }
    commands::recover(
        w.context.clone(),
        Selection {
            mod_filters: vec!["a".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(w.game(), SOURCE);
    let remaining = Manifest::load(&w.context).unwrap();
    assert_eq!(remaining.entries.len(), 1);
    assert_eq!(
        remaining.entries[0].contributors[0].script_path.as_deref(),
        Some("legacy/generate.ts")
    );
}
#[test]
fn unsupported_state_versions_fail_before_writing() {
    let w = Workspace::new();
    paths::write_atomic(
        &w.context.state.join("manifest.json"),
        b"{\"version\":999,\"entries\":[]}",
    )
    .unwrap();
    assert!(commands::recover(w.context.clone(), Selection::default()).is_err());
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn recovery_recreates_missing_data_directories() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.run("sync");
    let data = paths::canonical_missing(&w.context.game.join("GameData")).unwrap();
    let allowed = paths::canonical_missing(w._temp.path()).unwrap();
    assert!(data.starts_with(&allowed));
    fs::remove_dir_all(data).unwrap();
    let context = Context::resolve_recovery(Some(&w.context.root)).unwrap();
    commands::recover(
        context,
        Selection {
            reset_changed: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn an_untracked_marker_never_becomes_a_new_original() {
    let w = Workspace::new();
    let marked = state::marked_bytes(
        SOURCE.as_bytes(),
        "GameData/A.ndf",
        &[],
        &w.context.root,
        false,
    )
    .unwrap();
    paths::write_atomic(&w.context.game.join("GameData/A.ndf"), marked).unwrap();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    assert!(commands::build(w.context.clone(), Selection::default(), "sync").is_err());
    assert!(!w.context.state.exists());
}
#[test]
fn explicit_find_checks_only_the_saved_originals_it_reads() {
    let w = Workspace::new();
    w.project("one", json!({}));
    w.field("one", "main", "A.X", 4);
    w.run("sync");
    let manifest = Manifest::load(&w.context).unwrap();
    let backup = state::original_backup(&w.context, &manifest.entries[0]).unwrap();
    paths::write_atomic(&backup, "corrupt").unwrap();
    paths::write_atomic(&w.context.game.join("GameData/Other.ndf"), SOURCE).unwrap();
    let inspect = |file: &str| {
        commands::find(
            w.context.clone(),
            Selection::default(),
            commands::FindOptions {
                files: vec![file.into()],
                name: None,
                type_name: None,
                field: None,
                limit: 10,
            },
        )
    };
    assert!(inspect("GameData/Other.ndf").is_ok());
    assert!(inspect("GameData/A.ndf").is_err());
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
}
