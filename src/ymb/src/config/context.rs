use super::*;

#[derive(Clone, Debug)]
pub struct Context {
    pub root: PathBuf,
    pub config_path: PathBuf,
    pub config: BuilderConfig,
    pub game: PathBuf,
    pub mods: PathBuf,
    pub work: PathBuf,
    pub output: PathBuf,
    pub cache: PathBuf,
    pub conflicts: PathBuf,
    pub state: PathBuf,
    pub lock: PathBuf,
    pub journal: PathBuf,
}
impl Context {
    pub fn resolve(input: Option<&Path>) -> Result<Self> {
        Self::resolve_mode(input, false, true)
    }
    pub fn resolve_recovery(input: Option<&Path>) -> Result<Self> {
        Self::resolve_mode(input, true, false)
    }
    pub fn resolve_release(input: Option<&Path>) -> Result<Self> {
        Self::resolve_mode(input, false, false)
    }
    fn resolve_mode(input: Option<&Path>, legacy_paths: bool, require_game: bool) -> Result<Self> {
        use ymb_core::layout;
        let candidate =
            paths::absolute(input.unwrap_or(
                &std::env::current_dir().map_err(|e| Diagnostic::io(Path::new("."), e))?,
            ))?;
        let root = if input.is_some() {
            candidate
        } else {
            let is_root = |parent: &&Path| {
                parent.join(layout::CONFIG).is_file()
                    || parent.join(layout::LOCAL_CONFIG).is_file()
                    || parent.join("release-manifest.json").is_file()
                    || parent.join("src/ymb/Cargo.toml").is_file()
            };
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.ancestors().find(is_root).map(Path::to_owned))
                .or_else(|| candidate.ancestors().find(is_root).map(Path::to_owned))
                .unwrap_or(candidate)
        };
        let root = paths::canonical_missing(&root)?;
        let mut config_path = root.join(layout::CONFIG);
        let mut config = BuilderConfig::default();
        for name in [layout::CONFIG, layout::LOCAL_CONFIG] {
            let path = root.join(name);
            paths::assert_no_links(&root, &path)?;
            if !path.try_exists().map_err(|e| Diagnostic::io(&path, e))? {
                continue;
            }
            let source = String::from_utf8(paths::read_limited(&path, 16 << 20)?)
                .map_err(|e| config_error(&path, e.to_string()))?;
            let mut document = yaml(&source, &path)?;
            if legacy_paths && document.value["version"] == 1 {
                document.value = json!({"version":metadata::CONFIG_VERSION,"paths":document.value.get("paths").cloned().unwrap_or_else(||json!({}))});
            }
            let _: BuilderConfig = decode(&document, &path)?;
            let mut merged = serde_json::to_value(&config).unwrap();
            templates::merge(&mut merged, &document.value);
            document.value = merged;
            config = decode(&document, &path)?;
            config_path = path;
        }
        let resolve = |path: &str| -> Result<PathBuf> {
            if path.trim().is_empty() {
                return Err(config_error(
                    &config_path,
                    crate::messages::text(
                        "config.context.resolve_mode.configured_roots_must_not_be_empty",
                    ),
                ));
            }
            paths::canonical_missing(&root.join(path))
        };
        let game = resolve(&config.paths.game_root)?;
        let mods = resolve(&config.paths.source_mods)?;
        let work = resolve(&config.paths.work_root)?;
        let cache = resolve(&config.paths.cache_root)?;
        let state = resolve(&config.paths.recovery_root)?;
        let lock = resolve(&config.paths.operation_lock_root)?;
        let journal = resolve(&config.paths.state_transaction_root)?;
        if !legacy_paths {
            for (legacy, current, key, default) in [
                (".ymb-state", &state, "recoveryRoot", ".ymb/state"),
                (
                    ".ymb-operation-lock",
                    &lock,
                    "operationLockRoot",
                    ".ymb/lock",
                ),
                (
                    ".ymb-state-transaction",
                    &journal,
                    "stateTransactionRoot",
                    ".ymb/transaction",
                ),
            ] {
                if current == &resolve(default)? && root.join(legacy).exists() {
                    return Err(Diagnostic::new(
                        "LayoutError",
                        crate::messages::format("config.context.resolve_mode.legacy_storage_still_exists_at_legacy", &[("LEGACY", legacy.to_string())]),
                        crate::messages::format("config.context.resolve_mode.finish_pending_operations_with_the_previous_builder", &[("LEGACY", legacy.to_string()), ("DEFAULT", default.to_string()), ("KEY", key.to_string())]),
                    ).at(root.join(legacy)));
                }
            }
        }
        let data = [game.join("GameData"), game.join("CommonData")];
        let roots = [
            ("paths.sourceMods", &mods),
            ("paths.workRoot", &work),
            ("paths.cacheRoot", &cache),
            ("paths.recoveryRoot", &state),
            ("paths.operationLockRoot", &lock),
            ("paths.stateTransactionRoot", &journal),
        ];
        for (i, (name, path)) in roots.iter().enumerate() {
            if [layout::CONFIG, layout::LOCAL_CONFIG]
                .iter()
                .any(|file| paths::overlaps(path, &root.join(file)).unwrap_or(true))
            {
                return Err(config_error(
                    &config_path,
                    crate::messages::format(
                        "config.context.resolve_mode.name_contains_the_installation_settings_file",
                        &[("NAME", name.to_string())],
                    ),
                ));
            }
            if !legacy_paths {
                for reserved in [
                    "dist",
                    ".ymb/dist-stage",
                    ".ymb/dist.previous",
                    ".ymb/dist.lock",
                ] {
                    if paths::overlaps(path, &root.join(reserved))? {
                        return Err(config_error(
                            &config_path,
                            crate::messages::format(
                                "config.context.resolve_mode.name_overlaps_reserved_distribution_storage",
                                &[("NAME", name.to_string())],
                            ),
                        ));
                    }
                }
            }
            if paths::overlaps(path, &root.join(".ymb/target"))?
                || paths::overlaps(path, &root.join(".ymb/g"))?
                || paths::overlaps(path, &root.join(".ymb/mods"))?
                || paths::overlaps(path, &root.join(".ymb/releases"))?
                || paths::overlaps(path, &root.join(".ymb/engine"))?
            {
                return Err(config_error(
                    &config_path,
                    crate::messages::format(
                        "config.context.resolve_mode.name_overlaps_reserved_compiler_or_rust_engine",
                        &[("NAME", name.to_string())],
                    ),
                ));
            }
            for (other_name, other) in &roots[i + 1..] {
                if paths::overlaps(path, other)? {
                    return Err(config_error(
                        &config_path,
                        crate::messages::format(
                            "config.context.resolve_mode.name_overlaps_other_name",
                            &[
                                ("NAME", name.to_string()),
                                ("OTHER_NAME", other_name.to_string()),
                            ],
                        ),
                    ));
                }
            }
            if paths::overlaps(path, &root)?
                && !paths::key(path.to_string_lossy())
                    .starts_with(&format!("{}/", paths::key(root.to_string_lossy())))
            {
                return Err(config_error(
                    &config_path,
                    crate::messages::format(
                        "config.context.resolve_mode.name_cannot_contain_the_builder_root",
                        &[("NAME", name.to_string())],
                    ),
                ));
            }
            for data in &data {
                if paths::overlaps(path, data)? {
                    return Err(config_error(
                        &config_path,
                        crate::messages::format(
                            "config.context.resolve_mode.name_overlaps_live_game_data",
                            &[("NAME", name.to_string())],
                        ),
                    ));
                }
            }
            if paths::overlaps(path, &game)?
                && !paths::key(path.to_string_lossy())
                    .starts_with(&format!("{}/", paths::key(game.to_string_lossy())))
            {
                return Err(config_error(
                    &config_path,
                    crate::messages::format(
                        "config.context.resolve_mode.name_must_not_contain_the_warno_mod",
                        &[("NAME", name.to_string())],
                    ),
                ));
            }
        }
        if !legacy_paths && paths::strip_prefix(&root.join(".ymb"), &cache).is_none() {
            return Err(config_error(
                &config_path,
                crate::messages::text(
                    "config.context.resolve_mode.paths_cacheroot_must_stay_inside_this_builder",
                ),
            ));
        }
        for path in &data {
            if !path.is_dir() && (require_game || path.exists()) {
                return Err(Diagnostic::new(
                    "LayoutError",
                    crate::messages::text(
                        "config.context.resolve_mode.the_warno_mod_folder_needs_gamedata_and",
                    ),
                    crate::messages::text(
                        "config.context.resolve_mode.create_a_mod_with_warno_s_tools",
                    ),
                )
                .at(path));
            }
        }
        let settings = serde_json::to_value(&config.settings).unwrap();
        for (key, value) in settings.as_object().unwrap() {
            if value.as_u64().is_none_or(|n| n == 0) {
                return Err(config_error(
                    &config_path,
                    crate::messages::format(
                        "config.context.resolve_mode.settings_key_must_be_a_positive_integer",
                        &[("KEY", key.to_string())],
                    ),
                ));
            }
        }
        if !config.variables.is_object() {
            return Err(config_error(
                &config_path,
                crate::messages::text("config.context.resolve_mode.variables_must_be_a_mapping"),
            ));
        }
        for (id, custom) in &config.mods {
            for (field, variables) in
                std::iter::once((format!("mods.{id}.variables"), &custom.variables)).chain(
                    custom.patches.iter().map(|(patch, custom)| {
                        (
                            format!("mods.{id}.patches.{patch}.variables"),
                            &custom.variables,
                        )
                    }),
                )
            {
                if !variables.is_object() {
                    return Err(config_error(
                        &config_path,
                        crate::messages::format(
                            "config.context.resolve_mode.field_must_be_a_mapping",
                            &[("FIELD", field.to_string())],
                        ),
                    ));
                }
            }
        }
        Ok(Self {
            root,
            config_path,
            output: work.join("output"),
            cache,
            conflicts: work.join("conflicts"),
            config,
            game,
            mods,
            work,
            state,
            lock,
            journal,
        })
    }
    pub fn target(&self, path: &str) -> Result<PathBuf> {
        paths::resolve(&self.game, &paths::game_relative(path)?)
    }
}
