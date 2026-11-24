use super::*;
use semver::VersionReq;

#[test]
fn installer_options_accept_prefixes_and_offer_the_actual_available_flags() {
    let options = Options::try_parse_from([
        "deploy",
        "--ga",
        "folder with spaces",
        "--pro",
        "one.zip",
        "--project=two.zip",
        "--wi",
        "optional",
        "--ye",
    ])
    .unwrap();
    assert_eq!(options.game, Some(PathBuf::from("folder with spaces")));
    assert_eq!(
        options.project,
        [PathBuf::from("one.zip"), PathBuf::from("two.zip")]
    );
    assert!(options.yes);
    for flag in ["--he", "-h", "--vers", "-V"] {
        let args = vec!["deploy".into(), flag.into()];
        assert!(crate::arguments::flag_requested(
            Options::command(),
            &args,
            if flag.contains('h') {
                "help"
            } else {
                "version"
            }
        ));
    }
    let args: Vec<std::ffi::OsString> = ["deploy", "--builer", "file.zip"]
        .iter()
        .map(Into::into)
        .collect();
    let error = Options::try_parse_from(&args).err().unwrap();
    let diagnostic = crate::arguments::diagnostic(&error, Options::command(), &args);
    assert_eq!(diagnostic.context["suggestions"][0], "--builder");
}

#[test]
fn updates_keep_installed_engines_and_reject_an_active_rust_installation() {
    let temp = tempfile::tempdir().unwrap();
    let previous = temp.path().join("previous");
    let next = temp.path().join("next");
    let engine = previous.join(".ymb/engine");
    paths::write_atomic(
        &engine.join("1.100.0-windows-x64/rustup/toolchains/compiler"),
        "compiler",
    )
    .unwrap();
    paths::write_atomic(&engine.join("install-unfinished/partial"), "partial").unwrap();
    stage::carry_engine(&previous, &next).unwrap();
    assert_eq!(
        fs::read_to_string(next.join(".ymb/engine/1.100.0-windows-x64/rustup/toolchains/compiler"))
            .unwrap(),
        "compiler"
    );
    assert!(!next.join(".ymb/engine/install-unfinished").exists());
    fs::create_dir(engine.join("lock")).unwrap();
    assert!(stage::carry_engine(&previous, &temp.path().join("blocked")).is_err());
    assert!(!temp.path().join("blocked").exists());
}

#[test]
fn preserved_updates_keep_declared_data_and_replace_code() {
    let temp = tempfile::tempdir().unwrap();
    let previous = temp.path().join("previous");
    let next = temp.path().join("next");
    paths::write_atomic(
        &previous.join("ymb.config.yaml"),
        "version: 1\nmods:\n  test:\n    variables:\n      value: 7\n",
    )
    .unwrap();
    paths::write_atomic(
        &previous.join("mods/Test/config/.ymb/identity.store.json"),
        "saved identity",
    )
    .unwrap();
    paths::write_atomic(&previous.join("mods/Test/config/source.rs"), "old code").unwrap();
    paths::write_atomic(
        &next.join("mods/Test/config/.ymb/identity.store.json"),
        "seed identity",
    )
    .unwrap();
    paths::write_atomic(&next.join("mods/Test/config/source.rs"), "new code").unwrap();
    paths::write_atomic(
        &previous.join("mods/Test/config/.ymb/g/program.exe"),
        "old generator",
    )
    .unwrap();
    paths::write_atomic(
        &next.join("mods/Test/config/.ymb/g/program.exe"),
        "new generator",
    )
    .unwrap();
    let project = Project {
        name: "Test".into(),
        id: "test".into(),
        url: "https://downloads.example.com/project-config.zip".into(),
        dependencies: vec![],
    };
    stage::carry_user_files(&previous, &next, &[project]).unwrap();
    assert_eq!(
        fs::read_to_string(next.join("mods/Test/config/.ymb/g/program.exe")).unwrap(),
        "new generator"
    );
    assert_eq!(
        fs::read_to_string(next.join("mods/Test/config/.ymb/identity.store.json")).unwrap(),
        "saved identity"
    );
    assert_eq!(
        fs::read_to_string(next.join("mods/Test/config/source.rs")).unwrap(),
        "new code"
    );
    let (config, _): (config::BuilderConfig, _) =
        config::load(&next.join(layout::LOCAL_CONFIG)).unwrap();
    assert_eq!(config.version, ymb_core::metadata::CONFIG_VERSION);
    assert_eq!(config.mods["test"].variables["value"], 7);
    assert_eq!(
        fs::read_to_string(previous.join("mods/Test/config/.ymb/identity.store.json")).unwrap(),
        "saved identity"
    );
}

#[test]
fn preserved_settings_merge_both_layers_and_drop_removed_projects() {
    let temp = tempfile::tempdir().unwrap();
    let previous = temp.path().join("previous");
    let next = temp.path().join("next");
    let shared = "version: 1\nsettings:\n  scriptTimeoutSeconds: 45\nvariables: {shared: 2, overridden: 3}\nmods:\n  kept:\n    variables: {shared: 4, overridden: 5}\n  removed:\n    variables: {keep: false}\n";
    let local = "version: 2\nvariables: {overridden: 7}\nmods:\n  kept:\n    variables: {overridden: 8}\n  removed:\n    enabled: false\n";
    paths::write_atomic(&previous.join(layout::CONFIG), shared).unwrap();
    paths::write_atomic(&previous.join(layout::LOCAL_CONFIG), local).unwrap();
    let project = Project {
        name: "Kept".into(),
        id: "kept".into(),
        url: "https://downloads.example.com/Kept-config.zip".into(),
        dependencies: vec![],
    };
    stage::carry_user_files(&previous, &next, &[project]).unwrap();
    let (settings, _): (config::BuilderConfig, _) =
        config::load(&next.join(layout::LOCAL_CONFIG)).unwrap();
    assert_eq!(settings.settings.generator_timeout_seconds, 45);
    assert_eq!(settings.variables, json!({"shared":2,"overridden":7}));
    assert_eq!(
        settings.mods["kept"].variables,
        json!({"shared":4,"overridden":8})
    );
    assert_eq!(settings.mods.len(), 1);
    assert_eq!(
        fs::read_to_string(previous.join(layout::CONFIG)).unwrap(),
        shared
    );
    assert_eq!(
        fs::read_to_string(previous.join(layout::LOCAL_CONFIG)).unwrap(),
        local
    );
    for invalid in ["null", "[]", "5", "version: 2\nunknown: true\n"] {
        paths::write_atomic(&previous.join(layout::LOCAL_CONFIG), invalid).unwrap();
        assert!(stage::carry_user_files(&previous, &next, &[]).is_err());
        let (settings, _): (config::BuilderConfig, _) =
            config::load(&next.join(layout::LOCAL_CONFIG)).unwrap();
        assert_eq!(settings.mods.len(), 1);
    }
    stage::carry_user_files(&temp.path().join("absent"), &temp.path().join("empty"), &[]).unwrap();
    assert!(!temp.path().join("empty").exists());
}

#[test]
fn preserved_identities_follow_project_ids_after_folder_renames() {
    let temp = tempfile::tempdir().unwrap();
    let previous = temp.path().join("previous");
    let next = temp.path().join("next");
    let config = "version: 2\nid: stable\nname: Project\n";
    paths::write_atomic(&previous.join("mods/Renamed/config/ymb.mod.yaml"), config).unwrap();
    paths::write_atomic(
        &previous.join("mods/Renamed/config/.ymb/decks/identity.json"),
        "saved identity",
    )
    .unwrap();
    paths::write_atomic(
        &next.join("mods/Current/config/.ymb/decks/identity.json"),
        "seed identity",
    )
    .unwrap();
    let project = Project {
        name: "Current".into(),
        id: "stable".into(),
        url: "https://downloads.example.com/Current-config.zip".into(),
        dependencies: vec![],
    };
    stage::carry_user_files(&previous, &next, std::slice::from_ref(&project)).unwrap();
    assert_eq!(
        fs::read_to_string(next.join("mods/Current/config/.ymb/decks/identity.json")).unwrap(),
        "saved identity"
    );
    paths::write_atomic(&previous.join("mods/Duplicate/config/ymb.mod.yaml"), config).unwrap();
    assert!(
        stage::carry_user_files(&previous, &temp.path().join("ambiguous"), &[project]).is_err()
    );
    assert!(!temp.path().join("ambiguous").exists());
}
#[test]
fn update_paths_reject_custom_locks_and_pending_transactions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let mut report = json!({"operationLockRoot":builder_lock_root(root), "recoveryRoot":root.join(".ymb/state"), "pendingTransaction":false});
    stage::check_update_paths(root, &report).unwrap();
    report["operationLockRoot"] = json!(root.join("custom-lock"));
    assert!(stage::check_update_paths(root, &report).is_err());
    report["operationLockRoot"] = json!(builder_lock_root(root));
    report["pendingTransaction"] = json!(true);
    assert!(stage::check_update_paths(root, &report).is_err());
    report["pendingTransaction"] = json!(false);
    report["recoveryRoot"] = json!(root.join(".ymb-state"));
    stage::check_update_paths(root, &report).unwrap();
    report["recoveryRoot"] = json!(root.join("custom-state"));
    assert!(stage::check_update_paths(root, &report).is_err());
    assert!(stage::check_update_paths(root, &json!({})).is_err());
}

#[test]
fn deployment_requires_the_selected_game_folder() {
    let temp = tempfile::tempdir().unwrap();
    let game = temp.path().join("Selected");
    assert!(stage::check_game_root(&game, &json!({"gameRoot": game})).is_ok());
    assert!(
        stage::check_game_root(&game, &json!({"gameRoot": temp.path().join("Other")})).is_err()
    );
}
#[test]
fn supported_builder_selection_uses_real_versions_and_all_project_requirements() {
    let release = |tag: &str, version: &str, pre: bool| json!({"tag_name":tag,"draft":false,"prerelease":pre,"assets":[{"name":format!("YMB-{version}-windows-x64.zip")}]});
    let releases = vec![
        release("3.0.X", "3.0.0", false),
        release("2.10.X", "2.10.8", false),
        release("2.9.X", "2.9.99", false),
        release("2.11.X-pre", "2.11.1", true),
        release("2.12.X", "2.12.0", false),
    ];
    let tags = ["3.0.X", "2.10.X", "2.9.X", "2.11.X-pre"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let required = requirement("version: 2\nrequires: '>=2, <3' # supported builder\n").unwrap();
    assert_eq!(
        compatible_release(&releases, &tags, std::slice::from_ref(&required), true).unwrap()["tag_name"],
        "2.10.X"
    );
    let narrow = semver::VersionReq::parse("<2.10").unwrap();
    assert_eq!(
        compatible_release(&releases, &tags, &[required, narrow], true).unwrap()["tag_name"],
        "2.9.X"
    );
    assert!(
        compatible_release(
            &releases,
            &tags,
            &[semver::VersionReq::parse("<2").unwrap()],
            true
        )
        .is_none()
    );
    assert_eq!(
        compatible_release(
            &releases,
            &tags,
            &[semver::VersionReq::parse(">=2.11.1-pre, <3").unwrap()],
            true
        )
        .unwrap()["tag_name"],
        "2.11.X-pre"
    );
    let mut invalid = releases[1].clone();
    invalid["draft"] = json!(true);
    assert!(compatible_release(&[invalid], &tags, &[semver::VersionReq::STAR], true).is_none());
    let preview_only = vec![releases[3].clone()];
    assert_eq!(
        compatible_release(
            &preview_only,
            &tags,
            &[VersionReq::parse("2").unwrap()],
            true
        )
        .unwrap()["tag_name"],
        "2.11.X-pre"
    );
    assert!(compatible_release(&preview_only, &tags, &[], false).is_none());
    let mut ambiguous = releases[1].clone();
    ambiguous["assets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"YMB-invalid-windows-x64.zip"}));
    assert!(compatible_release(&[ambiguous], &tags, &[], true).is_none());
    assert!(requirement("requires: [2, 3]").is_err());
    assert!(requirement("requires: 'invalid'").is_err());
    assert!(requirement("requires: '*'\n---\nrequires: '*'").is_err());
    assert!(requirement("requires: '*'\nvariables: {1: invalid}").is_err());
    assert_eq!(
        requirement("id: fixture").unwrap(),
        semver::VersionReq::STAR
    );
}

#[test]
fn unsupported_builder_fallback_requires_a_choice_and_missing_releases_offer_help() {
    let releases = vec![
        json!({"tag_name":"stable","draft":false,"prerelease":false,"assets":[{"name":"YMB-v3.0.1-windows-x64.zip"}]}),
        json!({"tag_name":"2.0.X","draft":false,"prerelease":false,"assets":[{"name":"YMB-2.0.9-windows-x64.zip"}]}),
        json!({"tag_name":"4.0.X-pre","draft":false,"prerelease":true,"assets":[{"name":"YMB-4.0.0-windows-x64.zip"}]}),
    ];
    let tags = ["stable".into(), "2.0.X".into(), "4.0.X-pre".into()]
        .into_iter()
        .collect();
    let supported = [semver::VersionReq::parse("2").unwrap()];
    let chosen = choose_builder(&releases, &tags, &supported, &mut |_| {
        panic!("Supported releases must not prompt.")
    })
    .unwrap()
    .unwrap();
    assert_eq!(chosen.0["tag_name"], "2.0.X");
    assert!(!chosen.1);
    let unsupported = [semver::VersionReq::parse("1").unwrap()];
    assert!(
        choose_builder(&releases, &tags, &unsupported, &mut |_| Ok(false))
            .unwrap()
            .is_none()
    );
    let chosen = choose_builder(&releases, &tags, &unsupported, &mut |release| {
        assert_eq!(release["tag_name"], "stable");
        Ok(true)
    })
    .unwrap()
    .unwrap();
    assert_eq!(chosen.0["tag_name"], "stable");
    assert!(chosen.1);
    let preview = choose_builder(
        &releases,
        &tags,
        &[VersionReq::parse("4").unwrap()],
        &mut |_| panic!("A matching preview must not require unsupported-version consent."),
    )
    .unwrap()
    .unwrap();
    assert_eq!(preview.0["tag_name"], "4.0.X-pre");
    assert!(!preview.1);
    let missing = choose_builder(&[], &tags, &supported, &mut |_| {
        panic!("No releases cannot prompt.")
    })
    .unwrap_err();
    assert!(missing.reason.contains("https://github.com/Yokaiste/YMB"));
    assert!(choose_builder(&releases, &HashSet::new(), &supported, &mut |_| Ok(true)).is_err());
}

#[test]
fn accepted_builder_versions_are_saved_locally_without_changing_mod_requirements() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let path = root.join("mods/Fixture/config/ymb.mod.yaml");
    let authored = "version: 2\nid: fixture\nname: Fixture\nrequires: '=999.0.0'\n";
    paths::write_atomic(&path, authored).unwrap();
    paths::write_atomic(
        &root.join("release-manifest.json"),
        serde_json::to_vec(&json!({"version":ymb_core::metadata::VERSION})).unwrap(),
    )
    .unwrap();
    paths::write_atomic(
        &root.join(layout::LOCAL_CONFIG),
        "version: 2\nvariables:\n  health: 30\n",
    )
    .unwrap();
    let project = Project {
        name: "Fixture".into(),
        id: "fixture".into(),
        url: "https://downloads.example.com/Fixture-config.zip".into(),
        dependencies: vec![],
    };
    let context = config::Context::resolve_release(Some(root)).unwrap();
    assert!(config::discover(&context).is_err());
    stage::allow_builder_version(root, &[(project, PathBuf::new())]).unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), authored);
    let context = config::Context::resolve_release(Some(root)).unwrap();
    assert!(config::discover(&context).is_ok());
    assert_eq!(context.config.variables["health"], 30);
    assert_eq!(
        context.config.mods["fixture"]
            .allow_unsupported_ymb
            .as_deref(),
        Some(ymb_core::metadata::VERSION)
    );
}
#[test]
fn project_archives_supply_their_builder_requirements() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("src");
    paths::write_atomic(
        &source.join("Fixture/config/ymb.mod.yaml"),
        "version: 2\nid: fixture\nname: Fixture\nrequires: '>=2.9, <3'\n",
    )
    .unwrap();
    manifest(&source.join("Fixture"), "package-manifest.json", "1.0.0").unwrap();
    let archive = temp.path().join("project.zip");
    zip_directory(&source, &archive).unwrap();
    let (installer, unpacked) = unpack_project(&archive, &temp.path().join("unpacked")).unwrap();
    let required = requirements(&[(installer.project, unpacked)]).unwrap();
    assert!(required[0].matches(&semver::Version::parse("2.10.3").unwrap()));
    assert!(!required[0].matches(&semver::Version::parse("3.0.0").unwrap()));
}
#[cfg(windows)]
#[test]
fn directory_swap_waits_for_a_transient_windows_file_handle() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("src");
    let destination = temp.path().join("destination");
    paths::write_atomic(&source.join("held"), "fixture").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(source.join("held"))
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        drop(held);
    });
    transaction::rename(&source, &destination).unwrap();
    release.join().unwrap();
    assert!(destination.join("held").is_file());
}
fn layout(root: &Path) {
    for name in ["GameData", "CommonData"] {
        fs::create_dir_all(root.join(name)).unwrap()
    }
    paths::write_atomic(&root.join("GenerateMod.bat"), "fixture").unwrap();
}
#[test]
fn placement_and_locking() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Mods/Test");
    layout(&root);
    placement(&root, &[]).unwrap();
    let checkout = temp.path().join("Mods/Other");
    layout(&checkout);
    fs::create_dir_all(checkout.join("YMB/mods/Renamed/.git")).unwrap();
    assert!(placement(&checkout, &[]).is_err());
    fs::create_dir(root.join("YMB")).unwrap();
    let guard = BuilderLock::acquire(&root.join("YMB")).unwrap();
    assert!(BuilderLock::acquire(&root.join("YMB")).is_err());
    drop(guard);
    paths::write_atomic(&root.join("YMB/Cargo.toml"), "source").unwrap();
    paths::write_atomic(&root.join("YMB/crates/ymb/src/main.rs"), "source").unwrap();
    assert!(placement(&root, &[]).is_err());
    fs::remove_file(root.join("YMB/Cargo.toml")).unwrap();
    fs::create_dir(root.join("YMB/.git")).unwrap();
    assert!(placement(&root, &[]).is_err());
    assert!(placement(temp.path(), &[]).is_err());
}
#[test]
fn current_builder_layout_uses_the_shared_operation_lock() {
    let temp = tempfile::tempdir().unwrap();
    paths::write_atomic(&temp.path().join("dist/YMB.exe"), "fixture").unwrap();
    let guard = BuilderLock::acquire(temp.path()).unwrap();
    assert!(temp.path().join(".ymb/lock/native.lock").is_file());
    assert!(BuilderLock::acquire(temp.path()).is_err());
    assert!(clear_interrupted_lock(temp.path()).is_err());
    drop(guard);
    assert!(!temp.path().join(".ymb/lock").exists());
    fs::remove_file(temp.path().join("dist/YMB.exe")).unwrap();
    paths::write_atomic(&temp.path().join(layout::EXECUTABLE), "fixture").unwrap();
    assert_eq!(
        builder_lock_root(temp.path()),
        temp.path().join(".ymb-operation-lock")
    );
    paths::write_atomic(
        &temp.path().join("release-manifest.json"),
        serde_json::to_vec(&json!({"version":"0.0.1","files":{(layout::EXECUTABLE):"fixture",(format!("{}/Cargo.toml",layout::SDK)):"fixture"}})).unwrap(),
    )
    .unwrap();
    let guard = BuilderLock::acquire(temp.path()).unwrap();
    assert!(temp.path().join(".ymb/lock/native.lock").is_file());
    assert_eq!(
        builder_executable(temp.path()),
        temp.path().join(layout::EXECUTABLE)
    );
    drop(guard);
}
#[test]
fn swap_and_interrupted_recovery() {
    for phase in ["prepared", "installed"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Mods/Test");
        layout(&root);
        let work = root.join(".ymb-install");
        fs::create_dir(&work).unwrap();
        fs::create_dir(root.join("YMB")).unwrap();
        paths::write_atomic(&root.join("YMB/old"), "identity").unwrap();
        let next = root.join(".ymb-install-next");
        fs::create_dir(&next).unwrap();
        paths::write_atomic(&next.join("new"), "new version").unwrap();
        let mut old = Some(BuilderLock::acquire(&root.join("YMB")).unwrap());
        install(&root, &work, &next, &mut old).unwrap();
        assert!(root.join("YMB/new").is_file());
        assert!(!work.join("before").exists());
        fs::create_dir(work.join("before")).unwrap();
        paths::write_atomic(&work.join("before/old"), "identity").unwrap();
        let before_lock = BuilderLock::acquire(&work.join("before")).unwrap();

        let live = root.join("YMB");
        paths::write_atomic(&live.join(".ymb-stage"), "fixture").unwrap();
        let live_lock = BuilderLock::acquire(&live).unwrap();
        drop(live_lock);
        paths::write_atomic(
            &work.join("phase.json"),
            serde_json::to_vec(&json!({"phase":phase})).unwrap(),
        )
        .unwrap();
        // A live lock must be rejected even when its owner has the installer's name.
        assert!(recover(&root, &work).is_err());
        drop(before_lock);
        recover(&root, &work).unwrap();
    }
}
#[test]
fn interrupted_swap_restores_old_or_keeps_committed() {
    for (phase, live_exists) in [("prepared", false), ("prepared", true), ("installed", true)] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Mods/Test");
        layout(&root);
        let work = root.join(".ymb-install");
        fs::create_dir(&work).unwrap();
        fs::create_dir(work.join("before")).unwrap();
        paths::write_atomic(&work.join("before/old"), "original").unwrap();
        if live_exists {
            fs::create_dir(root.join("YMB")).unwrap();
            paths::write_atomic(&root.join("YMB/new"), "new").unwrap();
            paths::write_atomic(&root.join("YMB/.ymb-stage"), "fixture").unwrap();
        }
        paths::write_atomic(
            &work.join("phase.json"),
            serde_json::to_vec(&json!({"phase":phase})).unwrap(),
        )
        .unwrap();
        recover(&root, &work).unwrap();
        assert!(
            root.join(if live_exists { "YMB/new" } else { "YMB/old" })
                .is_file()
        );
        assert!(!work.join("before").exists());
    }
}
