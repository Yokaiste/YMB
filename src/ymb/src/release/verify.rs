use super::*;

fn fixture_patch(project: &Path, id: &str) -> Result<()> {
    paths::write_atomic(&project.join("config/patch/main/ymb.patch.yaml"), serde_json::to_vec(&json!({"version":metadata::CONFIG_VERSION,"id":"main","name":"Main","scope":"prod","targets":[{"file":format!("GameData/{id}.ndf"),"operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.Value"},"value":2}]}]})).unwrap())
}

fn fixture_archive(check: &Path, project: &Project, advertise_url: bool) -> Result<PathBuf> {
    let stage = check.join(format!("fixture-{}", project.name));
    let source = stage.join(&project.name);
    paths::write_atomic(&source.join("config/ymb.mod.yaml"), serde_json::to_vec(&json!({"version":metadata::CONFIG_VERSION,"id":project.id,"name":project.name,"requires":format!("={}",metadata::VERSION),"release":{"url":advertise_url.then_some(&project.url),"version":"1.0.0"},"dependencies":project.dependencies})).unwrap())?;
    fixture_patch(&source, &project.id)?;
    paths::write_atomic(
        &source.join("config/.ymb/fixture.store.json"),
        "packaged identities",
    )?;
    manifest(&source, "package-manifest.json", "1.0.0")?;
    let archive = check.join(format!("{}-fixture.zip", project.name));
    zip_directory(&stage, &archive)?;
    Ok(archive)
}

pub(super) fn verify_installer(dist: &Path, builder: &Path, installer: &Installer) -> Result<()> {
    let primary = &installer.project;
    let actual = dist.join(format!("Deploy-{}.exe", primary.name));
    let version = execute(Command::new(&actual).arg("--version"))?;
    if String::from_utf8_lossy(&version).trim() != format!("{} {}", primary.name, installer.version)
    {
        return Err(error(crate::messages::text(
            "release.verify.verify_installer.the_deploy_executable_reports_a_different_project",
        )));
    }
    with_work(dist, "installer test 雪", |check| {
        let nested_required = Project {
            name: "NestedRequiredFixture".into(),
            id: "ymb_nested_required_fixture".into(),
            url: "https://downloads.example.com/NestedRequiredFixture-config.zip".into(),
            dependencies: vec![],
        };
        let nested_optional = Project {
            name: "NestedOptionalFixture".into(),
            id: "ymb_nested_optional_fixture".into(),
            url: "https://downloads.example.com/NestedOptionalFixture-config.zip".into(),
            dependencies: vec![],
        };
        let required = Project {
            name: "RequiredFixture".into(),
            id: "ymb_required_fixture".into(),
            url: "https://downloads.example.com/RequiredFixture-config.zip".into(),
            dependencies: vec![
                config::Dependency {
                    url: nested_required.url.clone(),
                    required: true,
                    reason: None,
                },
                config::Dependency {
                    url: nested_optional.url.clone(),
                    required: false,
                    reason: None,
                },
            ],
        };
        let optional = Project {
            name: "OptionalFixture".into(),
            id: "ymb_optional_fixture".into(),
            url: "https://downloads.example.com/OptionalFixture-config.zip".into(),
            dependencies: vec![],
        };
        let mut fixture = installer.clone();
        fixture.project.dependencies = vec![
            config::Dependency {
                url: required.url.clone(),
                required: true,
                reason: None,
            },
            config::Dependency {
                url: optional.url.clone(),
                required: false,
                reason: Some("Optional verification content.".into()),
            },
        ];
        let primary = &fixture.project;
        let executable = check.join("Deploy-fixture.exe");
        deploy::payload::write(&builder.join(layout::EXECUTABLE), &executable, &fixture)?;
        let archive = fixture_archive(check, primary, true)?;
        let required_archive = fixture_archive(check, &required, false)?;
        let optional_archive = fixture_archive(check, &optional, false)?;
        let nested_required_archive = fixture_archive(check, &nested_required, false)?;
        let nested_optional_archive = fixture_archive(check, &nested_optional, false)?;
        let builder_stage = check.join("builder-stage");
        copy_tree(builder, &builder_stage.join("YMB"), &[])?;
        let builder_zip = check.join("builder.zip");
        zip_directory(&builder_stage, &builder_zip)?;
        let game = check.join("Mods/Development");
        for name in ["GameData", "CommonData"] {
            fs::create_dir_all(game.join(name)).map_err(|e| Diagnostic::io(&game, e))?;
        }
        paths::write_atomic(
            &game.join("GenerateMod.bat"),
            "@echo Unexpected compile>compiled.txt\r\n",
        )?;
        let original = "A is T(\n    Value = 1\n)\n";
        for id in [
            &primary.id,
            &required.id,
            &optional.id,
            &nested_required.id,
            &nested_optional.id,
            "other",
        ] {
            paths::write_atomic(&game.join(format!("GameData/{id}.ndf")), original)?;
        }
        let system =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(|| {
                error(crate::messages::text("common.shared.systemroot_is_missing"))
            })?)
            .join("System32");
        let run = |builder: &Path,
                   with_optional: bool,
                   success: bool,
                   preserve: bool|
         -> Result<()> {
            let mut command = Command::new(&executable);
            command
                .arg("--game")
                .arg(&game)
                .arg("--builder")
                .arg(builder)
                .arg("--yes")
                .arg("--project")
                .arg(&required_archive)
                .arg("--project")
                .arg(&nested_required_archive)
                .arg("--project")
                .arg(&archive)
                .env("PATH", &system)
                .env_remove("CARGO")
                .env_remove("RUSTC");
            if with_optional {
                command
                    .arg("--with")
                    .arg(&optional.name)
                    .arg("--project")
                    .arg(&optional_archive);
                command
                    .arg("--with")
                    .arg(&nested_optional.name)
                    .arg("--project")
                    .arg(&nested_optional_archive);
            }
            if preserve {
                command.arg("--preserve-user-data");
            }
            let output = command.output().map_err(|e| error(e.to_string()))?;
            if output.status.success() != success {
                return Err(error(crate::messages::format(
                    "release.verify.verify_installer.installer_verification_returned_arg0",
                    &[("ARG0", format!("{}", output.status))],
                ))
                .detail(String::from_utf8_lossy(&output.stdout))
                .detail(String::from_utf8_lossy(&output.stderr)));
            }
            if success
                && (!String::from_utf8_lossy(&output.stdout).contains("GenerateMod.bat")
                    || game.join("compiled.txt").exists()
                    || game.join(".ymb-install").exists()
                    || game.join(".ymb-install-next").exists())
            {
                return Err(error(crate::messages::text(
                    "release.verify.verify_installer.deployment_must_stop_after_sync_explain_the",
                )));
            }
            Ok(())
        };
        let installed = game.join("YMB");
        let live = game.join(format!("GameData/{}.ndf", primary.id));
        run(&builder_zip, false, true, false)?;
        if !fs::read_to_string(&live)
            .map_err(|e| Diagnostic::io(&live, e))?
            .contains("Value = 2")
            || !installed.join("mods").join(&required.name).is_dir()
            || installed.join("mods").join(&optional.name).exists()
            || !installed.join("mods").join(&nested_required.name).is_dir()
            || installed.join("mods").join(&nested_optional.name).exists()
        {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.fresh_deployment_must_sync_the_project_and",
            )));
        }
        run(&builder_zip, true, true, false)?;
        if !installed.join("mods").join(&optional.name).is_dir()
            || !installed.join("mods").join(&nested_optional.name).is_dir()
            || !fs::read_to_string(game.join(format!("GameData/{}.ndf", nested_required.id)))
                .map_err(|e| error(e.to_string()))?
                .contains("Value = 2")
            || !fs::read_to_string(game.join(format!("GameData/{}.ndf", nested_optional.id)))
                .map_err(|e| error(e.to_string()))?
                .contains("Value = 2")
        {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.nested_required_and_selected_optional_dependencies_must",
            )));
        }
        let other = installed.join("mods/Other");
        paths::write_atomic(
            &other.join("config/ymb.mod.yaml"),
            serde_json::to_vec(
                &json!({"version":metadata::CONFIG_VERSION,"id":"other","name":"Other"}),
            )
            .unwrap(),
        )?;
        fixture_patch(&other, "other")?;
        execute(
            Command::new(installed.join(layout::EXECUTABLE))
                .args(["sync", "--mod", "other", "--yes"])
                .arg("--ymb-path")
                .arg(&installed)
                .env("PATH", &system),
        )?;
        let store = installed
            .join("mods")
            .join(&primary.name)
            .join("config/.ymb/fixture.store.json");
        paths::write_atomic(&store, "local identities")?;
        paths::write_atomic(
            &installed.join(layout::LOCAL_CONFIG),
            format!(
                "version: {}\nmods:\n  {}:\n    variables:\n      localSetting: 60\n",
                metadata::CONFIG_VERSION,
                primary.id
            ),
        )?;
        paths::write_atomic(&installed.join("obsolete.txt"), "obsolete")?;
        paths::write_atomic(&live, "A is T(\n    Value = 3\n)\n")?;
        let unchanged = || -> Result<()> {
            if fs::read_to_string(&store).map_err(|e| error(e.to_string()))? != "local identities"
                || !installed.join(layout::LOCAL_CONFIG).is_file()
                || !fs::read_to_string(&live)
                    .map_err(|e| error(e.to_string()))?
                    .contains("Value = 3")
            {
                return Err(error(crate::messages::text(
                    "release.verify.verify_installer.a_rejected_update_changed_installed_or_live",
                )));
            }
            Ok(())
        };
        let bad = check.join("bad.zip");
        paths::copy_atomic(&builder_zip, &bad)?;
        paths::write_atomic(&bad.with_extension("zip.sha256"), "0".repeat(64))?;
        run(&bad, false, false, false)?;
        unchanged()?;
        let backup = files(&installed.join(".ymb/state/originals"), &[])?
            .into_iter()
            .next()
            .ok_or_else(|| {
                error(crate::messages::text(
                    "release.verify.verify_installer.sync_did_not_save_originals",
                ))
            })?;
        let saved = fs::read(&backup).map_err(|e| Diagnostic::io(&backup, e))?;
        paths::write_atomic(&backup, "corrupt original")?;
        run(&builder_zip, false, false, false)?;
        unchanged()?;
        paths::write_atomic(&backup, saved)?;
        let local_path = installed.join(layout::LOCAL_CONFIG);
        let local_before =
            fs::read(&local_path).map_err(|error| Diagnostic::io(&local_path, error))?;
        paths::write_atomic(
            &local_path,
            format!(
                "version: {}\nmods:\n  {}:\n    patches:\n      unknown_patch:\n        enabled: true\n",
                metadata::CONFIG_VERSION,
                primary.id
            ),
        )?;
        run(&builder_zip, false, false, true)?;
        unchanged()?;
        paths::write_atomic(&local_path, local_before)?;
        run(&builder_zip, false, true, false)?;
        if installed.join(layout::LOCAL_CONFIG).exists()
            || installed.join("obsolete.txt").exists()
            || other.exists()
            || installed.join("mods").join(&optional.name).exists()
            || fs::read_to_string(&store).map_err(|e| error(e.to_string()))?
                != "packaged identities"
            || fs::read_to_string(game.join("GameData/other.ndf"))
                .map_err(|e| error(e.to_string()))?
                != original
            || fs::read_to_string(game.join(format!("GameData/{}.ndf", optional.id)))
                .map_err(|e| error(e.to_string()))?
                != original
        {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.an_update_must_recover_every_tracked_file",
            )));
        }
        run(&builder_zip, true, true, false)?;
        paths::write_atomic(
            &installed.join(layout::CONFIG),
            format!(
                "version: {}\nvariables: {{sharedSetting: 6}}\n",
                metadata::CONFIG_VERSION
            ),
        )?;
        paths::write_atomic(
            &installed.join(layout::LOCAL_CONFIG),
            format!(
                "version: {}\nmods:\n  {}:\n    variables:\n      retainedSetting: 7\n  {}:\n    enabled: true\n",
                metadata::CONFIG_VERSION,
                primary.id,
                optional.id
            ),
        )?;
        let preserved = installed
            .join("mods")
            .join(&primary.name)
            .join("config/.ymb/fixture.store.json");
        paths::write_atomic(&preserved, "retained identity")?;
        let renamed = installed
            .join("mods")
            .join(format!("Renamed-{}", primary.name));
        paths::rename(&installed.join("mods").join(&primary.name), &renamed)
            .map_err(|cause| Diagnostic::io(&renamed, cause))?;
        run(&builder_zip, false, true, true)?;
        let (settings, _): (config::BuilderConfig, _) =
            config::load(&installed.join(layout::LOCAL_CONFIG))?;
        if settings.variables["sharedSetting"] != 6
            || settings
                .mods
                .get(&primary.id)
                .is_none_or(|custom| custom.variables["retainedSetting"] != 7)
            || settings.mods.contains_key(&optional.id)
            || installed.join("mods").join(&optional.name).exists()
        {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.a_preserved_update_discarded_local_settings",
            )));
        }
        if fs::read_to_string(&preserved).map_err(|e| error(e.to_string()))? != "retained identity"
        {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.a_preserved_update_discarded_a_declared_identity",
            )));
        }
        let work = game.join(".ymb-install");
        fs::create_dir_all(&work).map_err(|e| Diagnostic::io(&work, e))?;
        paths::write_atomic(&work.join("owner"), "YMB mod installer\n")?;
        fs::rename(&installed, work.join("before")).map_err(|e| Diagnostic::io(&installed, e))?;
        run(&builder_zip, false, true, false)?;
        fs::create_dir(installed.join(".git")).map_err(|e| Diagnostic::io(&installed, e))?;
        run(&builder_zip, false, false, false)?;
        fs::remove_dir(installed.join(".git")).map_err(|e| Diagnostic::io(&installed, e))?;
        let misplaced = Command::new(&executable)
            .arg("--game")
            .arg(check)
            .arg("--yes")
            .output()
            .map_err(|e| error(e.to_string()))?;
        if misplaced.status.success() {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.the_installer_accepted_a_folder_outside_a",
            )));
        }
        let project_stage = check.join(format!("fixture-{}", primary.name));
        let source = project_stage.join(&primary.name);
        let config_path = source.join("config/ymb.mod.yaml");
        let mut config: Value =
            serde_json::from_slice(&paths::read_limited(&config_path, 16 << 20)?)
                .map_err(|cause| error(cause.to_string()))?;
        config["requires"] = json!("=999.0.0");
        paths::write_atomic(&config_path, serde_json::to_vec(&config).unwrap())?;
        manifest(&source, "package-manifest.json", "1.0.0")?;
        zip_directory(&project_stage, &archive)?;
        let live_hash = paths::hash_file(&live)?;
        run(&builder_zip, false, false, false)?;
        if paths::hash_file(&live)? != live_hash {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.rejecting_an_unsupported_builder_changed_live_files",
            )));
        }
        let output = Command::new(&executable)
            .arg("--game")
            .arg(&game)
            .arg("--builder")
            .arg(&builder_zip)
            .args(["--yes", "--try-latest-ymb"])
            .arg("--project")
            .arg(&required_archive)
            .arg("--project")
            .arg(&nested_required_archive)
            .arg("--project")
            .arg(&archive)
            .env("PATH", &system)
            .env_remove("CARGO")
            .env_remove("RUSTC")
            .output()
            .map_err(|cause| error(cause.to_string()))?;
        if !output.status.success() {
            return Err(
                error(crate::messages::text("release.verify.verify_installer.the_explicit_unsupported_version_attempt_failed_verification"))
                    .detail(String::from_utf8_lossy(&output.stdout))
                    .detail(String::from_utf8_lossy(&output.stderr)),
            );
        }
        let (local, _): (config::BuilderConfig, _) =
            config::load(&installed.join(layout::LOCAL_CONFIG))?;
        let (authored, _): (config::ModConfig, _) = config::load(
            &installed
                .join("mods")
                .join(&primary.name)
                .join("config/ymb.mod.yaml"),
        )?;
        if local
            .mods
            .get(&primary.id)
            .and_then(|custom| custom.allow_unsupported_ymb.as_deref())
            != Some(metadata::VERSION)
            || authored.requires.as_deref() != Some("=999.0.0")
        {
            return Err(error(crate::messages::text(
                "release.verify.verify_installer.an_unsupported_builder_must_retain_authored_requirements",
            )));
        }
        paths::write_atomic(&dist.join("installer-verification.json"), serde_json::to_vec_pretty(&json!({"compilerFreePath":system,"freshInstallAndSync":true,"requiredDependenciesAutomatic":true,"optionalProjectVerified":true,"nestedRequiredAndOptionalVerified":true,"fullRecoveryBeforeReplacement":true,"unselectedProjectsRecoveredAndRemoved":true,"localContentsReplaced":true,"preservedUpdateVerified":true,"corruptDownloadRejected":true,"corruptOriginalPreventsReplacement":true,"interruptedSwapRecovered":true,"checkoutAndPlacementRejected":true,"installerWorkFilesRemoved":true,"unsupportedVersionOptInVerified":true,"warnoCompilationLeftToUser":true})).unwrap())
    })
}
