use super::*;

#[derive(Clone, Debug)]
pub struct Patch {
    pub config: PatchConfig,
    pub root: PathBuf,
    pub config_path: PathBuf,
}
#[derive(Clone, Debug)]
pub struct ModProject {
    pub config: ModConfig,
    pub root: PathBuf,
    pub config_root: PathBuf,
    pub config_path: PathBuf,
    pub patches: Vec<Patch>,
}
pub fn discover(context: &Context) -> Result<Vec<ModProject>> {
    let mut projects = Vec::new();
    let mut errors = Vec::new();
    let mut ids = BTreeMap::new();
    if !context
        .mods
        .try_exists()
        .map_err(|e| Diagnostic::io(&context.mods, e))?
    {
        return Ok(projects);
    }
    for entry in fs::read_dir(&context.mods).map_err(|e| Diagnostic::io(&context.mods, e))? {
        let entry = entry.map_err(|e| Diagnostic::io(&context.mods, e))?;
        if !entry
            .file_type()
            .map_err(|e| Diagnostic::io(&entry.path(), e))?
            .is_dir()
        {
            continue;
        }
        let root = entry.path();
        let config_root = root.join("config");
        let config_path = config_root.join("ymb.mod.yaml");
        if !config_path.is_file() {
            continue;
        }
        let result = (|| -> Result<ModProject> {
            paths::assert_no_links(&context.mods, &config_path)?;
            let (mut config, _): (ModConfig, _) = load(&config_path)?;
            validate_release(&config, &config_path)?;
            check_common(
                &config.id,
                &config.name,
                &config.variables,
                &config.generators,
                &config_path,
            )?;
            if let Some(requirement) = &config.requires {
                check_requirement(
                    requirement,
                    &config_path,
                    context
                        .config
                        .mods
                        .get(&config.id)
                        .and_then(|custom| custom.allow_unsupported_ymb.as_deref()),
                )?;
            }
            if let Some(custom) = context.config.mods.get(&config.id) {
                if let Some(enabled) = custom.enabled {
                    config.enabled = enabled;
                }
                if let Some(priority) = custom.priority {
                    config.priority = priority;
                }
                if let Some(allowed) = custom.allow_write_to_modified_files {
                    config.allow_write_to_modified_files = allowed;
                }
            }
            let mut patches = Vec::new();
            let mut patch_ids = std::collections::HashSet::new();
            let patch_root = config_root.join("patch");
            paths::assert_no_links(&root, &config_root.join("replace"))?;
            for path in paths::walk(&patch_root, true)?
                .into_iter()
                .filter(|path| path.file_name().is_some_and(|n| n == "ymb.patch.yaml"))
            {
                let (mut patch, document): (PatchConfig, _) = load(&path)?;
                check_common(
                    &patch.id,
                    &patch.name,
                    &patch.variables,
                    &patch.generators,
                    &path,
                )?;
                if !patch_ids.insert(paths::key(&patch.id)) {
                    return Err(config_error(
                        &path,
                        crate::messages::format(
                            "config.project.discover.duplicate_patch_id_arg0",
                            &[("ARG0", patch.id.to_string())],
                        ),
                    ));
                }
                if !matches!(patch.scope.as_str(), "prod" | "dev") {
                    return Err(config_error(
                        &path,
                        crate::messages::text(
                            "config.project.discover.patch_scope_must_be_prod_or_dev",
                        ),
                    ));
                }
                if patch.targets.is_empty() && patch.files.is_empty() && patch.generators.is_empty()
                {
                    return Err(config_error(
                        &path,
                        crate::messages::text(
                            "config.project.discover.a_patch_needs_targets_files_or_generators",
                        ),
                    ));
                }
                if patch.optional && patch.targets.is_empty() {
                    return Err(config_error(
                        &path,
                        crate::messages::text(
                            "config.project.discover.optional_requires_ndf_targets",
                        ),
                    ));
                }
                for (target_index, target) in patch.targets.iter_mut().enumerate() {
                    if target.file.trim().is_empty() || target.operations.is_empty() {
                        return Err(config_error(
                            &path,
                            crate::messages::text(
                                "config.project.discover.a_target_needs_a_file_and_operations",
                            ),
                        ));
                    }
                    target.operation_lines = (0..target.operations.len())
                        .map(|index| {
                            document
                                .lines
                                .get(&vec![
                                    "targets".into(),
                                    target_index.to_string(),
                                    "operations".into(),
                                    index.to_string(),
                                ])
                                .copied()
                                .unwrap_or(1)
                        })
                        .collect();
                }
                for file in &patch.files {
                    check_file(file, &path)?;
                }
                if let Some(enabled) = context
                    .config
                    .mods
                    .get(&config.id)
                    .and_then(|custom| custom.patches.get(&patch.id))
                    .and_then(|custom| custom.enabled)
                {
                    patch.enabled = enabled;
                }
                patches.push(Patch {
                    config: patch,
                    root: path.parent().unwrap().to_owned(),
                    config_path: path,
                });
            }
            patches.sort_by(|a, b| a.config.id.cmp(&b.config.id));
            if let Some(custom) = context.config.mods.get(&config.id) {
                for id in custom.patches.keys() {
                    if !custom.ignore_unknown_patches
                        && !patches.iter().any(|patch| patch.config.id == *id)
                    {
                        return Err(config_error(
                            &context.config_path,
                            crate::messages::format(
                                "config.project.discover.customization_names_unknown_patch_id",
                                &[("ID", id.to_string())],
                            ),
                        ));
                    }
                }
            }
            Ok(ModProject {
                config,
                root,
                config_root,
                config_path,
                patches,
            })
        })();
        match result {
            Ok(project) => {
                let key = paths::key(&project.config.id);
                if let Some(previous) = ids.insert(key, project.config_path.clone()) {
                    errors.push(*config_error(
                        &project.config_path,
                        crate::messages::format(
                            "config.project.discover.project_id_arg0_is_also_used_by",
                            &[
                                ("ARG0", project.config.id.to_string()),
                                ("ARG1", format!("{}", previous.display())),
                            ],
                        ),
                    ));
                } else {
                    projects.push(project);
                }
            }
            Err(error) => errors.push(*error),
        }
    }
    for id in context.config.mods.keys() {
        if !projects.iter().any(|project| project.config.id == *id) {
            errors.push(*config_error(
                &context.config_path,
                crate::messages::format(
                    "config.project.discover.customization_names_unknown_project_id",
                    &[("ID", id.to_string())],
                ),
            ));
        }
    }
    if let Some(error) = Diagnostic::group(errors) {
        return Err(error);
    }
    projects.sort_by(|a, b| a.config.id.cmp(&b.config.id));
    Ok(projects)
}
pub(super) fn check_common(
    id: &str,
    name: &str,
    variables: &Value,
    generators: &[Generator],
    path: &Path,
) -> Result<()> {
    paths::identifier(id).map_err(|e| e.at(path))?;
    if name.trim().is_empty() || !variables.is_object() {
        return Err(config_error(
            path,
            crate::messages::text(
                "config.project.check_common.name_must_be_nonempty_text_and_variables",
            ),
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for generator in generators {
        paths::identifier(&generator.id).map_err(|e| e.at(path))?;
        if let Some(binary) = &generator.binary {
            paths::identifier(binary).map_err(|error| error.at(path))?;
        }
        if !ids.insert(paths::key(&generator.id)) {
            return Err(config_error(
                path,
                crate::messages::text(
                    "config.project.check_common.generator_ids_must_be_unique_within_their",
                ),
            ));
        }
        if generator.executable.is_none() && generator.project.is_none() {
            return Err(config_error(
                path,
                crate::messages::text(
                    "config.project.check_common.a_generator_needs_executable_project_or_both",
                ),
            ));
        }
        for test in &generator.tests {
            if test.id().trim().is_empty() || !matches!(test.when(), "before" | "after") {
                return Err(config_error(
                    path,
                    crate::messages::text(
                        "config.project.check_common.generator_tests_need_an_id_and_before",
                    ),
                ));
            }
        }
    }
    Ok(())
}
pub(super) fn check_file(file: &FileOperation, path: &Path) -> Result<()> {
    let valid = match file.op.as_str() {
        "add" | "copy" | "replace" => {
            file.source.is_some()
                && file
                    .destination
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty())
                && file.target.is_none()
        }
        "remove" => {
            file.target.as_ref().is_some_and(|s| !s.trim().is_empty())
                && file.source.is_none()
                && file.destination.is_none()
        }
        _ => false,
    };
    if !valid || file.expect.as_ref().is_some_and(|expect| expect.files == 0) {
        return Err(config_error(
            path,
            crate::messages::text(
                "config.project.check_file.invalid_file_operation_or_expected_file_count",
            ),
        ));
    }
    if let Some(source) = &file.source
        && (!matches!(
            source.root.as_str(),
            "patch" | "mod" | "game" | "exampleAssets"
        ) || source.path.trim().is_empty())
    {
        return Err(config_error(
            path,
            crate::messages::text(
                "config.project.check_file.invalid_file_operation_source_root_or_path",
            ),
        ));
    }
    Ok(())
}
pub fn check_requirement(requirement: &str, path: &Path, allowed: Option<&str>) -> Result<()> {
    let requirement =
        semver::VersionReq::parse(requirement).map_err(|e| config_error(path, e.to_string()))?;
    let version = semver::Version::parse(metadata::VERSION).unwrap();
    if let Some(allowed) = allowed {
        semver::Version::parse(allowed).map_err(|e| {
            config_error(
                path,
                crate::messages::format(
                    "config.project.check_requirement.invalid_allowunsupportedymb_version_e",
                    &[("E", format!("{}", e))],
                ),
            )
        })?;
    }
    if !requirement.matches(&version) && allowed != Some(metadata::VERSION) {
        return Err(config_error(
            path,
            crate::messages::format(
                "config.project.check_requirement.this_project_requires_ymb_requirement_found_version",
                &[
                    ("REQUIREMENT", format!("{}", requirement)),
                    ("VERSION", format!("{}", version)),
                ],
            ),
        ));
    }
    Ok(())
}
pub fn variables(
    context: &Context,
    project: &ModProject,
    patch: Option<&Patch>,
    read_values: &Value,
) -> Result<Value> {
    let mut values = object();
    templates::merge(&mut values, read_values);
    templates::merge(&mut values, &project.config.variables);
    if let Some(patch) = patch {
        templates::merge(&mut values, &patch.config.variables);
    }
    templates::merge(&mut values, &context.config.variables);
    if let Some(custom) = context.config.mods.get(&project.config.id) {
        templates::merge(&mut values, &custom.variables);
        if let Some(patch) = patch
            && let Some(custom) = custom.patches.get(&patch.config.id)
        {
            templates::merge(&mut values, &custom.variables);
        }
    }
    let builtins = json!({
        "config": {
            "builder": context.config,
            "mod": project.config,
            "patch": patch.map(|patch| &patch.config),
        },
        "modPersistentRoot": ymb_core::storage::persistent(&project.config_root)?,
        "modSessionRoot": ymb_core::storage::session(&context.root, &project.config.id)?,
        "modRootName": context.game.file_name().unwrap_or_default().to_string_lossy(),
        "modId": project.config.id,
        "modName": project.config.name,
        "modDescription": project.config.description,
        "patchId": patch.map_or("", |p| p.config.id.as_str()),
        "patchName": patch.map_or("", |p| p.config.name.as_str()),
        "patchDescription": patch.map_or("", |p| p.config.description.as_str()),
    });
    for key in builtins.as_object().unwrap().keys() {
        if values.get(key).is_some() {
            return Err(config_error(
                &project.config_path,
                crate::messages::format(
                    "config.project.variables.key_is_a_reserved_built_in_variable",
                    &[("KEY", key.to_string())],
                ),
            ));
        }
    }
    templates::merge(&mut values, &builtins);
    Ok(values)
}
