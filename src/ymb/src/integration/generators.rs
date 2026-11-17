use super::*;

#[test]
fn generator_warnings_preserve_success_and_their_generator_identity() {
    let w = Workspace::new();
    w.native("warning");
    w.project("native", json!({"variables":{"behavior":"warning"},"generators":[{"id":"generate","executable":"fixture.exe","tests":["before"]}]}));
    for cached in [false, true] {
        let mut report = json!({"status":"ok","data":w.run("build")});
        crate::diagnostics::attach(&mut report);
        assert_eq!(report["diagnosticCounts"]["error"], 0);
        assert_eq!(report["diagnosticCounts"]["warning"], 2);
        assert_eq!(
            report["diagnostics"]["W7"]["messages"][0]["targets"][0]["generatorId"],
            "native::generate"
        );
        assert_eq!(report["diagnostics"]["I5"]["count"], 1);
        assert_eq!(
            report["data"]["metrics"]["cacheHits"].as_u64().unwrap() > 0,
            cached
        );
    }
}

#[test]
fn grouped_generator_errors_keep_their_owning_generator() {
    let w = Workspace::new();
    w.project("owner", json!({}));
    w.field("owner", "feature", "A.X", 4);
    let plan = commands::prepare(w.context.clone(), Selection::default()).unwrap();
    let failures = ymb_core::Diagnostic::group(
        ["First", "Second"]
            .map(|reason| *ymb_core::Diagnostic::new("GeneratorError", reason, "Fix the input."))
            .into(),
    )
    .unwrap()
    .with("generatorId", "generator");
    let owner = &plan.projects[0];
    let error = crate::engine::attach(failures, owner, Some(&owner.patches[0]));
    assert_eq!(error.related.len(), 2);
    for failure in error.related {
        assert_eq!(failure.context["generatorId"], "generator");
        assert_eq!(failure.context["modId"], "owner");
        assert_eq!(failure.context["patchId"], "feature");
    }
}

#[test]
fn cache_capacity_does_not_fail_a_native_generator() {
    let mut w = Workspace::new();
    w.native("cache");
    w.project("native", json!({"variables":{"behavior":"cache"},"generators":[{"id":"generate","executable":"fixture.exe"}]}));
    w.run("build");
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.output.join("GameData/cache.txt")).unwrap(),
        "stored"
    );
    w.context
        .config
        .settings
        .generator_cache_max_bytes_per_namespace = 1;
    let report = w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.output.join("GameData/cache.txt")).unwrap(),
        "cold"
    );
    assert!(
        report["notices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["reason"].as_str().is_some_and(|s| s.contains("cache")))
    );
}

#[test]
fn base_reads_preserve_the_previous_project_without_claiming_a_current_read() {
    let w = Workspace::new();
    w.project("a", json!({}));
    w.field("a", "main", "A.X", 4);
    w.native("base-targets");
    w.project("native", json!({"priority":10,"allowWriteToModifiedFiles":true,"variables":{"behavior":"base-targets"},"generators":[{"id":"generate","executable":"fixture.exe"}]}));
    w.field("native", "main", "A.X", 8);
    w.run("build");
    assert!(
        fs::read_to_string(w.context.output.join("GameData/A.ndf"))
            .unwrap()
            .contains("X = 9")
    );
}

#[test]
fn generator_target_aliases_keep_sequential_reads_and_canonical_recovery_paths() {
    for (input, output) in [
        ("GameData/a.ndf", "GameData/A.ndf"),
        ("GameData/./A.ndf", "GameData/folder/../A.ndf"),
    ] {
        let w = Workspace::new();
        w.native("target-alias");
        w.project("native", json!({"variables":{"behavior":"target-alias","inputPath":input,"outputPath":output},"generators":[{"id":"generate","executable":"fixture.exe"}]}));
        w.field("native", "main", "A.X", 4);
        let report = w.run("sync");
        assert_eq!(report["outputs"][0]["targetRelativePath"], "GameData/A.ndf");
        assert!(w.game().contains("X = 8"));
        assert_eq!(Manifest::load(&w.context).unwrap().entries.len(), 1);
        commands::recover(w.context.clone(), Selection::default()).unwrap();
        assert_eq!(w.game(), SOURCE);
    }
}

#[test]
fn dry_runs_discard_preview_and_owned_writes() {
    let w = Workspace::new();
    w.native("normal");
    let selection = Selection {
        dry_run: true,
        ..Default::default()
    };
    commands::build(w.context.clone(), selection, "sync").unwrap();
    assert_eq!(w.game(), SOURCE);
    assert!(!w.context.output.exists());
    assert!(!w.context.mods.join("native/config/identity.txt").exists());
}
#[test]
fn persistent_storage_is_transactional_shared_within_the_mod_and_retained_by_cleanup() {
    let w = Workspace::new();
    w.native("persistent");
    let identity = w.context.mods.join("native/config/.ymb/identity.txt");
    w.run("validate");
    assert!(!identity.exists());
    commands::build(
        w.context.clone(),
        Selection {
            dry_run: true,
            ..Default::default()
        },
        "build",
    )
    .unwrap();
    assert!(!identity.exists());
    w.run("build");
    assert_eq!(
        fs::read_to_string(&identity).unwrap(),
        "persistent identity"
    );
    commands::cleanup(w.context.clone(), Selection::default(), true).unwrap();
    assert_eq!(
        fs::read_to_string(&identity).unwrap(),
        "persistent identity"
    );
    assert!(!w.context.mods.join("native/.ymb").exists());
}
#[test]
fn native_generators_tests_and_owned_writes_have_correct_lifetimes() {
    let w = Workspace::new();
    w.native("normal");
    let result = w.run("validate");
    assert_eq!(result["tests"].as_array().unwrap().len(), 2);
    let root = w.context.mods.join("native/config");
    assert!(!root.join("identity.txt").exists());
    w.run("build");
    assert_eq!(
        fs::read_to_string(root.join("identity.txt")).unwrap(),
        "stable identity"
    );
    assert!(!root.join("test-only.txt").exists());
    assert_eq!(
        fs::read(w.context.output.join("CommonData/asset.bin")).unwrap(),
        [0, 255, 42]
    );
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn invalid_generator_output_and_protocol_failures_preserve_state() {
    for mode in ["bad-ndf", "protocol", "fail"] {
        let w = Workspace::new();
        w.native(mode);
        assert!(
            commands::build(w.context.clone(), Selection::default(), "sync").is_err(),
            "{mode}"
        );
        assert_eq!(w.game(), SOURCE);
        assert!(!w.context.mods.join("native/config/identity.txt").exists());
    }
}
#[test]
fn generator_timeout_kills_the_process_and_releases_lock() {
    let mut w = Workspace::new();
    w.native("timeout");
    w.context.config.settings.generator_timeout_seconds = 1;
    let started = std::time::Instant::now();
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    assert!(started.elapsed().as_secs() < 4);
    assert!(!w.context.lock.exists());
}

#[test]
fn generator_timeout_also_covers_blocked_host_writes() {
    let mut w = Workspace::new();
    let executable = format!("blocked-input{}", std::env::consts::EXE_SUFFIX);
    w.project("blocked", json!({"variables":{"padding":"x".repeat(200_000)},"generators":[{"id":"generate","executable":executable}]}));
    paths::copy_atomic(
        &fixture(),
        &w.context.mods.join("blocked/config").join(&executable),
    )
    .unwrap();
    w.context.config.settings.generator_timeout_seconds = 1;
    let started = std::time::Instant::now();
    let error = commands::build(w.context.clone(), Selection::default(), "build").unwrap_err();
    assert_eq!(error.code.as_deref(), Some("E23"));
    assert!(started.elapsed().as_secs() < 4);
    assert!(!w.context.lock.exists());
}
#[test]
fn generator_cache_honors_bypass_and_checksums() {
    let w = Workspace::new();
    w.native("cache");
    let root = w.context.mods.join("native/config/ymb.mod.yaml");
    let mut config: Value = serde_json::from_slice(&fs::read(&root).unwrap()).unwrap();
    config["generators"][0]["tests"] = json!([]);
    paths::write_atomic(&root, serde_json::to_vec(&config).unwrap()).unwrap();
    let first = w.run("build");
    assert_eq!(first["metrics"]["generatorCacheHits"], 0);
    assert_eq!(
        fs::read_to_string(w.context.output.join("GameData/cache.txt")).unwrap(),
        "cold"
    );
    let second = w.run("build");
    assert_eq!(second["metrics"]["generatorCacheHits"], 1);
    assert_eq!(
        fs::read_to_string(w.context.output.join("GameData/cache.txt")).unwrap(),
        "stored"
    );
    commands::build(
        w.context.clone(),
        Selection {
            use_cache: false,
            ..Default::default()
        },
        "build",
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(w.context.output.join("GameData/cache.txt")).unwrap(),
        "cold"
    );
}

#[test]
fn companion_test_cache_depends_on_resource_settings() {
    let mut w = Workspace::new();
    w.native("normal");
    assert_eq!(w.run("validate")["metrics"]["cacheHits"], 0);
    assert_eq!(w.run("validate")["metrics"]["cacheHits"], 1);
    w.context.config.settings.worker_threads = Some(1);
    assert_eq!(w.run("validate")["metrics"]["cacheHits"], 0);
    assert_eq!(w.run("validate")["metrics"]["cacheHits"], 1);
}
#[test]
fn malformed_payloads_and_escaping_helpers_never_publish() {
    for mode in ["forged", "invalid-utf8", "escape", "stream-fail"] {
        let w = Workspace::new();
        w.native(mode);
        assert!(
            commands::build(w.context.clone(), Selection::default(), "sync").is_err(),
            "{mode}"
        );
        assert_eq!(w.game(), SOURCE);
        assert!(!w.context.output.exists());
    }
}
#[test]
fn sdk_streams_files_and_materializes_new_owned_replacements() {
    for mode in [
        "stream",
        "write-stream",
        "owned-replace",
        "owned-case-replace",
    ] {
        let w = Workspace::new();
        w.native(mode);
        if mode == "owned-case-replace" {
            w.write("mods/native/config/replace/CommonData/new.txt", "old");
        }
        let path = w.context.mods.join("native/config/ymb.mod.yaml");
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config["generators"][0]["tests"] = json!([]);
        paths::write_atomic(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        w.run("build");
        if mode == "write-stream" {
            let bytes = fs::read(w.context.output.join("CommonData/stream.bin")).unwrap();
            assert_eq!(bytes.len(), 6 * 1024 * 1024);
            assert!(bytes.iter().all(|b| *b == 42));
        } else if mode == "stream" {
            let text = fs::read_to_string(w.context.output.join("CommonData/stream.ndf")).unwrap();
            assert!(text.contains("X = 1"));
        } else {
            assert_eq!(
                fs::read_to_string(w.context.output.join("CommonData/new.txt")).unwrap(),
                "new virtual source"
            );
            assert!(
                w.context
                    .mods
                    .join("native/config/replace/CommonData/new.txt")
                    .exists()
            );
        }
    }
}
#[cfg(windows)]
#[test]
fn a_failed_generator_kills_its_descendants() {
    let w = Workspace::new();
    w.native("descendant");
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    std::thread::sleep(std::time::Duration::from_secs(3));
    assert!(!w.context.mods.join("native/config/descendant.txt").exists());
}
#[cfg(windows)]
#[test]
fn generator_process_memory_is_enforced() {
    let mut w = Workspace::new();
    w.native("memory");
    w.context.config.settings.memory_budget_mib = 64;
    let error = commands::build(w.context.clone(), Selection::default(), "build").unwrap_err();
    assert!(error.reason.contains("memory limit"), "{error}");
    assert_eq!(w.game(), SOURCE);
}
#[test]
fn source_generators_reuse_compiler_work_and_rebuild_changed_source() {
    let w = Workspace::new();
    let sdk = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("sdk");
    w.project("src",json!({"variables":{"behavior":"normal"},"generators":[{"id":"generate","project":"generator/Cargo.toml","entry":"generate"}]}));
    let manifest = format!(
        "[package]\nname='source-fixture'\nversion='0.1.0'\nedition='2024'\n[workspace]\n[dependencies]\nserde_json='1'\nymb-sdk={{path='{}'}}\n",
        sdk.to_string_lossy().replace('\\', "/")
    );
    w.write("mods/src/config/generator/Cargo.toml", manifest);
    let source = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixture-generator/src/main.rs"
    ));
    w.write("mods/src/config/generator/src/main.rs", source);
    let result = w.run("build");
    assert_eq!(result["metrics"]["generators"], 1);
    assert!(w.context.mods.join("src/config/identity.txt").exists());
    let compiler = w.context.root.join(".ymb/mods/src/compiler");
    let dependency = paths::walk(&compiler, true)
        .unwrap()
        .into_iter()
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("libymb_sdk-")
                && path
                    .extension()
                    .is_some_and(|extension| extension == "rlib")
        })
        .unwrap();
    let modified = fs::metadata(&dependency).unwrap().modified().unwrap();
    let executable = paths::walk(&w.context.mods.join("src/config/.ymb/g"), true)
        .unwrap()
        .into_iter()
        .find(|path| {
            path.file_name().unwrap()
                == format!("generator{}", std::env::consts::EXE_SUFFIX).as_str()
        })
        .unwrap();
    let executable_modified = fs::metadata(&executable).unwrap().modified().unwrap();
    let second = w.run("sync");
    assert_eq!(result["outputs"], second["outputs"]);
    assert_eq!(
        fs::metadata(&executable).unwrap().modified().unwrap(),
        executable_modified
    );
    commands::build(
        w.context.clone(),
        Selection {
            use_cache: false,
            ..Default::default()
        },
        "validate",
    )
    .unwrap();
    assert_eq!(
        fs::metadata(&executable).unwrap().modified().unwrap(),
        executable_modified
    );
    assert_eq!(
        fs::metadata(&dependency).unwrap().modified().unwrap(),
        modified
    );
    w.write(
        "mods/src/config/generator/src/main.rs",
        source.replace("stable identity", "updated identity"),
    );
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.mods.join("src/config/identity.txt")).unwrap(),
        "updated identity"
    );
    assert_ne!(
        fs::metadata(&executable).unwrap().modified().unwrap(),
        executable_modified
    );
    assert_eq!(
        fs::metadata(&dependency).unwrap().modified().unwrap(),
        modified
    );
    assert!(!w.context.mods.join("src/config/generator/target").exists());
    w.write(
        "mods/src/config/generator/identity.txt",
        "included identity",
    );
    w.write(
        "mods/src/config/generator/src/main.rs",
        source.replace("\"stable identity\"", "include_str!(\"../identity.txt\")"),
    );
    w.run("build");
    w.write("mods/src/config/generator/identity.txt", "changed include");
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.mods.join("src/config/identity.txt")).unwrap(),
        "changed include"
    );
    w.write("mods/src/config/generator/build.rs", r#"fn main() {
        println!("cargo:rerun-if-changed=build-input.txt");
        println!("cargo:rustc-env=FIXTURE_IDENTITY={}", std::fs::read_to_string("build-input.txt").unwrap());
    }"#);
    w.write(
        "mods/src/config/generator/build-input.txt",
        "from build script",
    );
    w.write(
        "mods/src/config/generator/src/main.rs",
        source.replace("\"stable identity\"", "env!(\"FIXTURE_IDENTITY\")"),
    );
    w.run("build");
    w.write(
        "mods/src/config/generator/build-input.txt",
        "changed build input",
    );
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.mods.join("src/config/identity.txt")).unwrap(),
        "changed build input"
    );
    w.write("mods/src/config/generator/src/main.rs", "invalid Rust");
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    assert!(!w.context.output.exists());
    assert_eq!(
        fs::metadata(&dependency).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(fs::read_dir(&w.context.work).unwrap().count(), 0);
    commands::cleanup(w.context.clone(), Selection::default(), false).unwrap();
    assert!(compiler.exists());
    assert!(!w.context.mods.join("src/.ymb").exists());
    assert!(w.context.mods.join("src/config/identity.txt").exists());
}

#[test]
fn compiled_generators_with_the_same_binary_name_keep_their_own_artifacts() {
    let mut w = Workspace::new();
    if cfg!(windows) {
        let root = w
            .context
            .root
            .join("n".repeat(180usize.saturating_sub(w.context.root.to_string_lossy().len())));
        paths::write_atomic(
            &root.join("ymb.config.yaml"),
            serde_json::to_vec(&json!({
                "version":metadata::CONFIG_VERSION,"paths":{"gameRoot":w.context.game}
            }))
            .unwrap(),
        )
        .unwrap();
        w.context = Context::resolve(Some(&root)).unwrap();
        assert!(w.context.root.to_string_lossy().len() >= 180);
    }
    let sdk = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("sdk");
    let manifest = format!(
        "[package]\nname='shared-name'\nversion='0.1.0'\nedition='2024'\n[workspace]\n[dependencies]\nymb-sdk={{path='{}'}}\n",
        sdk.to_string_lossy().replace('\\', "/")
    );
    let source = r#"fn generate(ctx:&mut ymb_sdk::Context)->ymb_sdk::Result<Vec<ymb_sdk::GeneratedFile>>{
        let name=ctx.generator_id().rsplit(':').next().unwrap().to_owned();
        ctx.write_owned_text(&format!("{name}.txt"),"__VALUE__")?;Ok(Vec::new())
    }
    fn main(){ymb_sdk::run(&[ymb_sdk::GeneratorEntry{name:"generate",generate}],&[]);}"#;
    w.project("src",json!({"generators":[{"id":"first","project":"a/Cargo.toml","entry":"generate"},{"id":"middle","project":"b/Cargo.toml","entry":"generate"},{"id":"last","project":"a/Cargo.toml","entry":"generate"}]}));
    for (name, value) in [("a", "from A"), ("b", "from B")] {
        w.write(&format!("mods/src/config/{name}/Cargo.toml"), &manifest);
        w.write(
            &format!("mods/src/config/{name}/src/main.rs"),
            source.replace("__VALUE__", value),
        );
    }
    w.run("build");
    let root = w.context.mods.join("src/config");
    assert_eq!(
        fs::read_to_string(root.join("first.txt")).unwrap(),
        "from A"
    );
    assert_eq!(
        fs::read_to_string(root.join("middle.txt")).unwrap(),
        "from B"
    );
    assert_eq!(fs::read_to_string(root.join("last.txt")).unwrap(), "from A");
    let compiler = w.context.mods.join("src/config/.ymb/g");
    let executables: Vec<_> = paths::walk(&compiler, true)
        .unwrap()
        .into_iter()
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("generator")
                && path.extension().is_some_and(|extension| extension == "exe")
        })
        .map(|path| {
            let modified = fs::metadata(&path).unwrap().modified().unwrap();
            (path, modified)
        })
        .collect();
    assert_eq!(executables.len(), 2);
    w.run("build");
    for (path, modified) in executables {
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), modified);
    }
    assert_eq!(
        fs::read_to_string(root.join("first.txt")).unwrap(),
        "from A"
    );
    assert_eq!(
        fs::read_to_string(root.join("middle.txt")).unwrap(),
        "from B"
    );
    assert_eq!(fs::read_to_string(root.join("last.txt")).unwrap(), "from A");
}

#[test]
fn native_entries_reuse_one_immutable_executable_per_command() {
    let w = Workspace::new();
    w.native("normal");
    let mut plan = commands::prepare(w.context.clone(), Selection::default()).unwrap();
    crate::plugin::prepare(&mut plan).unwrap();
    let mut built = crate::engine::materialize(&plan).unwrap();
    assert_eq!(built.compiled.len(), 1);
    let compiled = built.compiled.values().next().unwrap().clone();
    let original = w.context.mods.join("native/config/fixture.exe");
    assert_eq!(compiled.hash, paths::hash_file(&original).unwrap());
    paths::write_atomic(&original, "replaced while running").unwrap();
    let generator = &plan.projects[0].config.generators[0];
    crate::plugin::execute(
        &mut built,
        0,
        None,
        generator,
        &json!({"behavior":"normal"}),
        "before",
        Some("before"),
    )
    .unwrap();
    assert_eq!(built.compiled.len(), 1);
    assert_eq!(paths::hash_file(&compiled.path).unwrap(), compiled.hash);
}

#[test]
fn packaged_generators_rebuild_changed_sources_and_reuse_verified_fallbacks() {
    let w = Workspace::new();
    w.native("normal");
    let sdk = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("sdk");
    w.write("mods/native/config/generator/Cargo.toml", format!("[package]\nname='fallback-fixture'\nversion='0.1.0'\nedition='2024'\n[workspace]\n[dependencies]\nymb-sdk={{path='{}'}}\nserde_json='1'\n", sdk.to_string_lossy().replace('\\', "/")));
    let source = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixture-generator/src/main.rs"
    ));
    w.write("mods/native/config/generator/src/main.rs", source);
    let manifest = w.context.mods.join("native/config/generator/Cargo.toml");
    let executable = w.context.mods.join("native/config/fixture.exe");
    ymb_sdk::compiler::stamp_executable(
        &w.context.root,
        &manifest,
        Some("fallback-fixture"),
        &executable,
    )
    .unwrap();
    w.project("native", json!({"variables":{"behavior":"normal"},"generators":[{"id":"generate","executable":"fixture.exe","project":"generator/Cargo.toml","binary":"fallback-fixture"}]}));
    let mut plan = commands::prepare(w.context.clone(), Selection::default()).unwrap();
    crate::plugin::prepare(&mut plan).unwrap();
    assert!(plan.compiler.is_none());
    w.run("build");
    w.write(
        "mods/native/config/generator/src/main.rs",
        source.replace("stable identity", "rebuilt identity"),
    );
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.mods.join("native/config/identity.txt")).unwrap(),
        "rebuilt identity"
    );
    fs::remove_file(&executable).unwrap();
    let mut plan = commands::prepare(w.context.clone(), Selection::default()).unwrap();
    crate::plugin::prepare(&mut plan).unwrap();
    assert!(plan.compiler.is_none());
    w.run("build");
}

#[test]
fn owned_overlay_reuses_windows_case_aliases() {
    let w = Workspace::new();
    let plan = crate::plan::Plan::new(w.context.clone(), Selection::default(), Vec::new()).unwrap();
    let mut built = crate::engine::Materialized::new(&plan).unwrap();
    let original = w.context.mods.join("identity.txt");
    paths::write_atomic(&original, "original").unwrap();
    built.owned_read(&original).unwrap();
    built
        .owned_read(&w.context.mods.join("IDENTITY.TXT"))
        .unwrap();
    assert_eq!(built.owned_originals.len(), 1);
    let first = built
        .store
        .put("first", ymb_sdk::ContentKind::Text)
        .unwrap();
    built.stage_owned(&original, first);
    let alias = w.context.mods.join("IDENTITY.TXT");
    assert_eq!(
        built.owned_read(&alias).unwrap().unwrap().text().unwrap(),
        "first"
    );
    let next = built.store.put("next", ymb_sdk::ContentKind::Text).unwrap();
    built.stage_owned(&alias, next);
    assert_eq!(built.owned.len(), 1);
    assert_eq!(built.owned_originals.len(), 1);
    assert_eq!(built.owned[&original].text().unwrap(), "next");
    assert_eq!(fs::read_to_string(&original).unwrap(), "original");
}

#[test]
fn cached_notices_follow_the_current_yaml_location() {
    let w = Workspace::new();
    w.project("one", json!({}));
    let path = "mods/one/config/patch/main/ymb.patch.yaml";
    let patch = "version: 2\nid: main\nname: Main\nscope: prod\ntargets:\n  - file: GameData/A.ndf\n    operations:\n      - op: remove\n        selector: {kind: object, by: name, value: Missing}\n";
    w.write(path, patch);
    let first = w.run("build");
    w.write(path, format!("\n\n{patch}"));
    let next = w.run("build");
    assert_eq!(next["metrics"]["cacheHits"], 0);
    let left = serde_json::to_string(&first["notices"]).unwrap();
    let right = serde_json::to_string(&next["notices"]).unwrap();
    assert_ne!(left, right);
}

#[test]
fn owned_helpers_protect_configuration_case_aliases() {
    let w = Workspace::new();
    w.native("config-case");
    assert!(commands::build(w.context.clone(), Selection::default(), "build").is_err());
    let config: Value = serde_json::from_slice(
        &fs::read(w.context.mods.join("native/config/ymb.mod.yaml")).unwrap(),
    )
    .unwrap();
    assert_eq!(config["id"], "native");
}

#[test]
fn project_generators_seed_inputs_before_ordered_patch_generators() {
    let w = Workspace::new();
    w.project(
        "locale",
        json!({
            "variables": {"behavior": "seed-localisation"},
            "generators": [{"id": "seed", "executable": "fixture.exe", "entry": "generate"}]
        }),
    );
    w.field("locale", "balance", "A.X", 7);
    w.patch(
        "locale",
        "feature",
        json!({
            "variables": {"behavior": "append-localisation"},
            "generators": [{"id": "append", "root": "mod", "executable": "fixture.exe", "entry": "generate"}]
        }),
    );
    paths::copy_atomic(
        &fixture(),
        &w.context.mods.join("locale/config/fixture.exe"),
    )
    .unwrap();
    w.run("build");
    assert_eq!(
        fs::read_to_string(w.context.output.join("CommonData/locale.csv")).unwrap(),
        "TOKEN;REFTEXT\nTEST;Feature text\n"
    );
    assert_eq!(w.game(), SOURCE);
    assert_eq!(
        fs::read_to_string(w.context.mods.join("locale/config/patch/feature/scope.txt")).unwrap(),
        "feature-owned"
    );
    assert!(!w.context.mods.join("locale/config/scope.txt").exists());
}
