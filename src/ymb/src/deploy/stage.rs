use super::*;

pub(super) fn carry_engine(previous: &Path, next: &Path) -> Result<()> {
    let engine = previous.join(".ymb/engine");
    paths::assert_no_links(previous, &engine)?;
    if !engine.is_dir() {
        return Ok(());
    }
    if engine.join("lock").exists() {
        return Err(error(crate::messages::text(
            "deploy.stage.carry_engine.a_rust_installation_is_active_wait_for",
        )));
    }
    for entry in fs::read_dir(&engine).map_err(|cause| Diagnostic::io(&engine, cause))? {
        let entry = entry.map_err(|cause| Diagnostic::io(&engine, cause))?;
        let name = entry.file_name();
        if name
            .to_str()
            .and_then(|name| name.strip_suffix("-windows-x64"))
            .is_some_and(|version| semver::Version::parse(version).is_ok())
        {
            paths::copy_tree(&entry.path(), &next.join(".ymb/engine").join(name))?;
        }
    }
    Ok(())
}

pub(super) fn carry_user_data(previous: &Path, next: &Path, projects: &[Project]) -> Result<()> {
    carry_user_files(previous, next, projects)?;
    check_preserved_layout(next)
}

pub(super) fn carry_user_files(previous: &Path, next: &Path, projects: &[Project]) -> Result<()> {
    let mut settings = json!({});
    for name in [layout::CONFIG, layout::LOCAL_CONFIG] {
        let path = previous.join(name);
        paths::assert_no_links(previous, &path)?;
        if path.try_exists().map_err(|e| Diagnostic::io(&path, e))? {
            let source = String::from_utf8(paths::read_limited(&path, 16 << 20)?)
                .map_err(|e| error(e.to_string()))?;
            let source = migrate_config(&source, u64::from(ymb_core::metadata::CONFIG_VERSION));
            let document = config::yaml(&source, &path)?;
            let _: config::BuilderConfig = serde_json::from_value(document.value.clone())
                .map_err(|cause| config::config_error(&path, cause.to_string()))?;
            ymb_core::templates::merge(&mut settings, &document.value);
        }
    }
    if let Some(mods) = settings.get_mut("mods").and_then(Value::as_object_mut) {
        mods.retain(|id, _| projects.iter().any(|project| project.id == *id));
    }
    if !settings.as_object().unwrap().is_empty() {
        config::write(&next.join(layout::LOCAL_CONFIG), &settings)?;
    }
    let mods = previous.join("mods");
    let mut roots = HashMap::new();
    paths::assert_no_links(previous, &mods)?;
    if mods.is_dir() {
        for entry in fs::read_dir(&mods).map_err(|cause| Diagnostic::io(&mods, cause))? {
            let entry = entry.map_err(|cause| Diagnostic::io(&mods, cause))?;
            if !entry
                .file_type()
                .map_err(|cause| Diagnostic::io(&entry.path(), cause))?
                .is_dir()
            {
                continue;
            }
            let root = entry.path().join("config");
            let path = root.join("ymb.mod.yaml");
            paths::assert_no_links(&mods, &path)?;
            if !path.is_file() {
                continue;
            }
            let source = String::from_utf8(paths::read_limited(&path, 16 << 20)?)
                .map_err(|cause| config::config_error(&path, cause.to_string()))?;
            let document = config::yaml(&source, &path)?;
            if let Some(project) = projects
                .iter()
                .find(|project| document.value["id"] == project.id)
                && let Some(previous) = roots.insert(project.id.clone(), root)
            {
                return Err(config::config_error(
                    &path,
                    crate::messages::format(
                        "config.project.discover.project_id_arg0_is_also_used_by",
                        &[
                            ("ARG0", project.id.clone()),
                            ("ARG1", previous.join("ymb.mod.yaml").display().to_string()),
                        ],
                    ),
                ));
            }
        }
    }
    for project in projects {
        let root = roots
            .get(&project.id)
            .cloned()
            .unwrap_or_else(|| previous.join("mods").join(&project.name).join("config"));
        let source = ymb_core::storage::persistent(&root)?;
        let target = paths::resolve(next, &format!("mods/{}/config/.ymb", project.name))?;
        if source
            .try_exists()
            .map_err(|e| Diagnostic::io(&source, e))?
        {
            if source.is_dir() {
                // Keep newly shipped binaries so preserving identities never forces an outdated cache rebuild.
                copy_tree(
                    &source,
                    &target,
                    if target.join("g").is_dir() {
                        &["g"]
                    } else {
                        &[]
                    },
                )?;
            } else {
                paths::copy_atomic(&source, &target)?;
            }
        }
    }
    Ok(())
}

fn check_preserved_layout(next: &Path) -> Result<()> {
    let bytes = execute(
        Command::new(builder_executable(next))
            .arg("doctor")
            .arg("--ymb-path")
            .arg(next)
            .arg("--json"),
    )?;
    let report: Value = serde_json::from_slice(&bytes).map_err(|e| error(e.to_string()))?;
    check_update_paths(next, &report["data"])?;
    for (key, expected) in [
        ("sourceMods", next.join("mods")),
        ("workRoot", next.join(".ymb/build")),
        ("cacheRoot", next.join(".ymb/cache")),
    ] {
        if report["data"][key]
            .as_str()
            .map(|p| paths::canonical_missing(Path::new(p)))
            .transpose()?
            != Some(paths::canonical_missing(&expected)?)
        {
            return Err(error(crate::messages::text(
                "deploy.stage.check_preserved_layout.preserving_user_data_requires_the_default_sourcemods",
            )));
        }
    }
    Ok(())
}

pub(super) fn check_update_paths(builder: &Path, report: &Value) -> Result<()> {
    let configured = report["operationLockRoot"]
        .as_str()
        .ok_or_else(|| error(crate::messages::text("deploy.stage.check_update_paths.the_builder_needs_to_report_operationlockroot_download")))?;
    if paths::canonical_missing(Path::new(configured))?
        != paths::canonical_missing(&builder_lock_root(builder))?
        || report["pendingTransaction"] != false
    {
        return Err(error(crate::messages::text(
            "deploy.stage.check_update_paths.finish_pending_operations_and_use_the_default",
        )));
    }
    let recovery = report["recoveryRoot"].as_str().ok_or_else(|| {
        error(crate::messages::text(
            "deploy.stage.check_update_paths.the_builder_did_not_report_recoveryroot",
        ))
    })?;
    let recovery = paths::canonical_missing(Path::new(recovery))?;
    if recovery != paths::canonical_missing(&builder.join(".ymb/state"))?
        && recovery != paths::canonical_missing(&builder.join(".ymb-state"))?
    {
        return Err(error(crate::messages::text(
            "deploy.stage.check_update_paths.this_installation_has_a_custom_recoveryroot_recover",
        )));
    }
    Ok(())
}

pub(super) fn allow_builder_version(builder: &Path, projects: &[(Project, PathBuf)]) -> Result<()> {
    let manifest: Value = serde_json::from_slice(&paths::read_limited(
        &builder.join("release-manifest.json"),
        64 << 20,
    )?)
    .map_err(|cause| error(cause.to_string()))?;
    let version = manifest["version"].as_str().ok_or_else(|| {
        error(crate::messages::text(
            "deploy.stage.allow_builder_version.the_builder_manifest_has_no_version",
        ))
    })?;
    let parsed = semver::Version::parse(version).map_err(|cause| error(cause.to_string()))?;
    let local = builder.join(layout::LOCAL_CONFIG);
    paths::assert_no_links(builder, &local)?;
    let mut settings = if local.exists() {
        let (_, document): (config::BuilderConfig, _) = config::load(&local)?;
        document.value
    } else {
        json!({"version":ymb_core::metadata::CONFIG_VERSION})
    };
    let mut changed = false;
    for (project, _) in projects {
        let path = builder
            .join("mods")
            .join(&project.name)
            .join("config/ymb.mod.yaml");
        let (config, _): (ModConfig, _) = config::load(&path)?;
        if let Some(required) = config.requires
            && !semver::VersionReq::parse(&required)
                .map_err(|cause| error(cause.to_string()))?
                .matches(&parsed)
        {
            settings["mods"][&project.id]["allowUnsupportedYmb"] = json!(version);
            changed = true;
        }
    }
    if changed {
        config::write(&local, &settings)?;
    }
    Ok(())
}

pub fn stage(
    root: &Path,
    work: &Path,
    builder: &Path,
    projects: &[(Project, PathBuf)],
    unsupported: bool,
) -> Result<PathBuf> {
    let unpacked_builder = work.join("builder");
    remove(work, &unpacked_builder)?;
    let unpacked_builder = extract_builder(builder, &unpacked_builder)?;
    if !builder_executable(&unpacked_builder).is_file()
        || !unpacked_builder.join(layout::EXECUTABLE).is_file()
        || !unpacked_builder.join(layout::CONFIG).is_file()
        || unpacked_builder.join(layout::LOCAL_CONFIG).exists()
    {
        return Err(error(crate::messages::text(
            "deploy.stage.stage.the_builder_package_needs_its_executable_and",
        )));
    }
    let next = root.join(".ymb-install-next");
    fs::create_dir(&next).map_err(|error| Diagnostic::io(&next, error))?;
    paths::write_atomic(&next.join(".ymb-stage"), "YMB staged update\n")?;
    copy_tree(&unpacked_builder, &next, &[])?;
    for (project, archive) in projects {
        let unpacked = work.join(&project.name);
        remove(work, &unpacked)?;
        extract(archive, &unpacked)?;
        let source = unpacked.join(&project.name);
        verify_package(&source, "package-manifest.json")?;
        if !source.join("config/ymb.mod.yaml").is_file() {
            return Err(error(crate::messages::format(
                "deploy.stage.stage.the_arg0_package_is_missing_config_ymb",
                &[("ARG0", project.name.to_string())],
            )));
        }
        copy_tree(&source, &next.join("mods").join(&project.name), &[])?;
    }
    if unsupported {
        allow_builder_version(&next, projects)?;
    }
    let report = execute(
        Command::new(builder_executable(&next))
            .arg("doctor")
            .arg("--ymb-path")
            .arg(&next)
            .arg("--json"),
    )?;
    let report: Value = serde_json::from_slice(&report).map_err(|e| error(e.to_string()))?;
    check_update_paths(&next, &report["data"])?;
    let mut command = Command::new(builder_executable(&next));
    command
        .arg("list")
        .arg("--ymb-path")
        .arg(&next)
        .args(["--require-all", "--json"]);
    for (project, _) in projects {
        command.arg("--mod").arg(&project.id);
    }
    let report = execute(&mut command)?;
    let report: Value = serde_json::from_slice(&report).map_err(|e| error(e.to_string()))?;
    if report["status"] != "ok" {
        return Err(error(crate::messages::text(
            "deploy.stage.stage.the_staged_builder_rejected_the_projects_the",
        )));
    }
    Ok(next)
}

pub(super) fn restore_live(root: &Path) -> Result<BuilderLock> {
    let builder = root.join("YMB");
    files(&builder, &[])?;
    let report = execute(
        Command::new(builder_executable(&builder))
            .arg("doctor")
            .arg("--ymb-path")
            .arg(&builder)
            .arg("--json"),
    )?;
    let report: Value = serde_json::from_slice(&report).map_err(|e| error(e.to_string()))?;
    check_update_paths(&builder, &report["data"])?;
    if report["data"]["gameRoot"]
        .as_str()
        .map(|path| paths::canonical_missing(Path::new(path)))
        .transpose()?
        != Some(paths::canonical_missing(root)?)
    {
        return Err(error(crate::messages::text(
            "deploy.stage.restore_live.ymb_points_at_another_warno_mod_folder",
        )));
    }
    // No project filter: replacing YMB also discards every project's saved originals.
    execute(
        Command::new(builder_executable(&builder))
            .arg("recover")
            .arg("--ymb-path")
            .arg(&builder)
            .args(["--yes", "--reset-changed"]),
    )?;
    let lock = BuilderLock::acquire(&builder)?;
    let report = execute(
        Command::new(builder_executable(&builder))
            .arg("doctor")
            .arg("--ymb-path")
            .arg(&builder)
            .arg("--json"),
    )?;
    let report: Value = serde_json::from_slice(&report).map_err(|e| error(e.to_string()))?;
    if report["data"]["trackedFiles"]
        .as_object()
        .is_none_or(|files| !files.is_empty())
    {
        return Err(error(crate::messages::text(
            "deploy.stage.restore_live.another_command_synced_files_during_recovery_close",
        )));
    }
    Ok(lock)
}
