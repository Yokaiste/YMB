use super::*;

pub fn inspect(context: Context, selection: Selection, command: &str) -> Result<Value> {
    let _progress = crate::ui::Progress::start(vec![if command == "doctor" {
        crate::messages::text("commands.inspect.inspect.check_installation_and_saved_originals")
            .into()
    } else {
        crate::messages::text("commands.inspect.inspect.read_projects_and_resolve_selection").into()
    }]);
    if command == "doctor" {
        let manifest = Manifest::load(&context)?;
        let mut errors = Vec::new();
        if let Err(error) = manifest.validate_backups(&context) {
            errors.push(*error);
        }
        if context.journal.exists() {
            errors.push(
                *Diagnostic::new(
                    "RecoveryError",
                    crate::messages::text(
                        "commands.inspect.inspect.an_interrupted_operation_is_pending",
                    ),
                    crate::messages::text(
                        "commands.inspect.inspect.run_build_to_roll_back_the_interrupted",
                    ),
                )
                .at(&context.journal),
            );
        }
        for root in ["GameData", "CommonData"] {
            let path = context.game.join(root);
            if !path.is_dir() {
                errors.push(
                    *Diagnostic::new(
                        "LayoutError",
                        crate::messages::text(
                            "commands.inspect.inspect.the_mod_data_folder_is_missing",
                        ),
                        crate::messages::text(
                            "commands.inspect.inspect.recover_saved_originals_or_restore_the_base",
                        ),
                    )
                    .at(&path),
                );
            }
        }
        let mut states = BTreeMap::new();
        for entry in &manifest.entries {
            match state::classify(&context, entry) {
                Ok(state) => {
                    if state == TrackedState::Changed {
                        errors.push(*changed_error(&entry.target_relative_path));
                    }
                    states.insert(
                        entry.target_relative_path.clone(),
                        format!("{state:?}").to_lowercase(),
                    );
                }
                Err(error) => errors.push(*error),
            }
        }
        let summary = crate::messages::format(
            "commands.inspect.inspect.doctor_summary",
            &[
                (
                    "FILES",
                    crate::messages::quantity(
                        "common.counts.tracked_files",
                        manifest.entries.len(),
                        &[],
                    ),
                ),
                (
                    "PROBLEMS",
                    crate::messages::quantity("common.counts.problems", errors.len(), &[]),
                ),
            ],
        );
        let contributors: BTreeMap<_, _> = manifest
            .entries
            .iter()
            .map(|entry| (&entry.target_relative_path, &entry.contributors))
            .collect();
        return Ok(
            json!({"summary":summary,"configPath":context.root.join(ymb_core::layout::CONFIG),"localConfigPath":context.root.join(ymb_core::layout::LOCAL_CONFIG),"settings":context.config.settings,"builderRoot":context.root,"gameRoot":context.game,"sourceMods":context.mods,"workRoot":context.work,"cacheRoot":context.cache,"recoveryRoot":context.state,"operationLockRoot":context.lock,"transactionRoot":context.journal,"pendingTransaction":context.journal.exists(),"operationLock":context.lock.exists(),"trackedFiles":states,"trackedContributors":contributors,"errors":errors}),
        );
    }
    let plan = prepare(context, selection)?;
    let mut warnings = plan.override_warnings();
    warnings.extend(plan.unmatched.iter().map(|filter| json!({
        "code":"W1", "reason":crate::messages::format("commands.inspect.inspect.arg0_arg1_matched_no_projects_or_patches", &[("ARG0", filter.option.to_string()), ("ARG1", filter.value.to_string())]),
        "suggestion":crate::messages::text("commands.inspect.inspect.use_list_without_filters_to_see_the"), "filter":filter
    })));
    let projects:Vec<_>=plan.mods.iter().map(|id|{let p=&plan.projects[*id];json!({"id":p.config.id,"name":p.config.name,"projectPath":p.root,"priority":p.config.priority,"dependsOn":p.config.depends_on,"generators":p.config.generators,"patches":plan.patches.iter().filter(|key|key.project==*id).map(|key|{let p=plan.patch(*key);json!({"id":p.config.id,"name":p.config.name,"scope":p.config.scope,"optional":p.config.optional,"dependsOn":p.config.depends_on,"files":p.config.files.len(),"targets":p.config.targets.iter().map(|t|&t.file).collect::<Vec<_>>(),"generators":p.config.generators})}).collect::<Vec<_>>()})}).collect();
    let summary = crate::messages::format(
        "commands.inspect.inspect.selection_summary",
        &[
            (
                "PROJECTS",
                crate::messages::quantity("common.counts.projects", plan.mods.len(), &[]),
            ),
            (
                "PATCHES",
                crate::messages::quantity("common.counts.patches", plan.patches.len(), &[]),
            ),
        ],
    );
    Ok(
        json!({"summary":summary,"projects":projects,"explanations":if command=="explain"{serde_json::to_value(&plan.explanations).unwrap()}else{Value::Null},"unmatchedFilters":plan.unmatched,"warnings":warnings}),
    )
}
pub struct FindOptions {
    pub files: Vec<String>,
    pub name: Option<String>,
    pub type_name: Option<String>,
    pub field: Option<String>,
    pub limit: usize,
}
pub fn find(context: Context, selection: Selection, options: FindOptions) -> Result<Value> {
    let _progress = crate::ui::Progress::start(vec![
        crate::messages::text("commands.inspect.find.select_files_to_search").into(),
        crate::messages::text("commands.inspect.find.search_ndf_objects").into(),
    ]);
    let _lock = OperationLock::acquire(&context, "find")?;
    let plan = if options.files.is_empty() {
        let plan = prepare(context, selection)?;
        plan.require_matches()?;
        plan
    } else {
        Plan::new(context, selection, Vec::new())?
    };
    let mut built = Materialized::inspection(&plan)?;
    let files = if options.files.is_empty() {
        let mut targets = std::collections::BTreeSet::new();
        for key in &plan.patches {
            let variables = built.variables(key.project, Some(key.patch))?;
            for target in &plan.patch(*key).config.targets {
                targets.insert(engine::resolve_path_template(&target.file, &variables)?);
            }
        }
        targets.into_iter().collect()
    } else {
        options.files
    };
    let mut matches = Vec::new();
    let mut count = 0;
    let name = options.name.as_ref().map(|name| name.to_lowercase());
    let type_name = options.type_name.as_ref().map(|name| name.to_lowercase());
    let field = options
        .field
        .as_ref()
        .map(|field| {
            field
                .split_once('=')
                .map(|(k, v)| (k.trim(), v.trim()))
                .filter(|(k, v)| !k.is_empty() && !v.is_empty())
                .map(|(k, v)| (k.to_lowercase(), v.to_lowercase()))
                .ok_or_else(|| {
                    Diagnostic::new(
                        "CommandError",
                        crate::messages::text(
                            "commands.inspect.find.field_needs_a_nonempty_name_value_pair",
                        ),
                        crate::messages::text(
                            "commands.inspect.find.supply_both_the_field_name_and_value",
                        ),
                    )
                })
        })
        .transpose()?;
    crate::ui::step(1);
    let mut seen = HashSet::new();
    for file in files {
        let file = paths::game_relative(&file)?;
        if !seen.insert(paths::key(&file)) {
            continue;
        }
        if built.plan.selection.progress() {
            crate::ui::phase(crate::messages::format(
                "commands.inspect.find.searching_file",
                &[("FILE", file.to_string())],
            ));
        }
        let source = built
            .original(&file)?
            .ok_or_else(|| engine::missing(&file))?
            .text()
            .map_err(|error| error.at(&file))?;
        let mut line = 1;
        let mut line_cursor = 0;
        for (index, block) in ndf::scan(&source)
            .map_err(|error| error.at(&file))?
            .iter()
            .filter(|b| b.kind == ndf::BlockKind::Object)
            .enumerate()
        {
            if name
                .as_ref()
                .is_some_and(|name| !block.name.unwrap_or("").to_lowercase().contains(name))
                || type_name
                    .as_ref()
                    .is_some_and(|name| !block.type_name.to_lowercase().contains(name))
            {
                continue;
            }
            let content = &source[block.span.clone()];
            if let Some((key, value)) = &field
                && !ndf::read::direct_fields(content)?.iter().any(|f| {
                    f.name.to_lowercase() == *key
                        && content[f.value.clone()].to_lowercase().contains(value)
                })
            {
                continue;
            }
            count += 1;
            if matches.len() < options.limit {
                line += source[line_cursor..block.span.start]
                    .bytes()
                    .filter(|b| *b == b'\n')
                    .count();
                line_cursor = block.span.start;
                matches.push(json!({"file":file,"index":index,"name":block.name,"type":block.type_name,"line":line}));
            }
        }
    }
    Ok(
        json!({"summary":crate::messages::quantity("commands.inspect.find.summary", count, &[("SHOWN", matches.len().to_string())]),"totalMatches":count,"matches":matches}),
    )
}
pub fn cleanup(context: Context, selection: Selection, all: bool) -> Result<Value> {
    let _progress = crate::ui::Progress::start(vec![
        crate::messages::text("commands.inspect.cleanup.check_temporary_and_protected_paths")
            .into(),
    ]);
    let _lock = OperationLock::acquire(&context, "cleanup")?;
    state::prepare_pending(&context, selection.dry_run)?;
    let manifest = Manifest::load(&context)?;
    if all && !manifest.entries.is_empty() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text(
                "commands.inspect.cleanup.saved_originals_are_still_needed_by_synced",
            ),
            crate::messages::text("commands.inspect.cleanup.run_recover_before_cleanup_all"),
        ));
    }
    let plan = prepare(context.clone(), selection.clone())?;
    plan.require_matches()?;
    let mut targets = vec![context.work.clone(), context.cache.clone()];
    if all {
        targets.push(context.state.clone());
    }
    let mut protected = Vec::new();
    for project in &plan.mods {
        let owner = &plan.projects[*project];
        let session = ymb_core::storage::session(&context.root, &owner.config.id)?;
        if all {
            targets.push(session);
        } else {
            targets.extend([
                session.join("run"),
                session.join("cache"),
                session.join("release"),
            ]);
        }
        protected.push(ymb_core::storage::persistent(&owner.config_root)?);
        let requests = owner
            .config
            .temp_paths
            .iter()
            .map(|p| (&owner.config_root, p))
            .chain(
                plan.patches
                    .iter()
                    .filter(|k| k.project == *project)
                    .flat_map(|key| {
                        let patch = plan.patch(*key);
                        patch
                            .config
                            .temp_paths
                            .iter()
                            .map(move |p| (&patch.root, p))
                    }),
            );
        for (root, request) in requests {
            let target = paths::resolve(root, request.path())?;
            if request.protected() {
                protected.push(target);
            } else {
                for critical in [&owner.config_path, &context.config_path]
                    .into_iter()
                    .chain(owner.patches.iter().map(|patch| &patch.config_path))
                {
                    if paths::overlaps(&target, critical)? {
                        return Err(Diagnostic::new(
                            "ConfigError",
                            crate::messages::text("commands.inspect.cleanup.a_cleanup_path_contains_project_configuration"),
                            crate::messages::text("commands.inspect.cleanup.choose_a_disposable_temporary_directory"),
                        )
                        .at(&target));
                    }
                }
                targets.push(target);
            }
        }
    }
    targets.retain(|target| {
        !protected
            .iter()
            .any(|keep| paths::overlaps(target, keep).unwrap_or(true))
    });
    targets.sort();
    targets.dedup();
    let mut compact: Vec<PathBuf> = Vec::new();
    for target in targets {
        if !compact.iter().any(|parent| target.starts_with(parent)) {
            compact.push(target);
        }
    }
    let mut existing = Vec::new();
    for target in compact {
        paths::assert_no_links(&target, &target)?;
        if target
            .try_exists()
            .map_err(|cause| Diagnostic::io(&target, cause))?
        {
            existing.push(target);
        }
    }
    let mut compact = existing;
    if !selection.dry_run && !compact.is_empty() {
        crate::ui::extend_steps(vec![
            crate::messages::text("commands.inspect.cleanup.remove_disposable_files").into(),
        ]);
        crate::ui::step(1);
        let mut removed = Vec::new();
        for target in &compact {
            paths::assert_no_links(target, target)?;
            if target.is_dir() {
                paths::remove_tree(target.parent().unwrap(), target)?;
                removed.push(target.clone());
            } else if target.exists() {
                fs::remove_file(target).map_err(|e| Diagnostic::io(target, e))?;
                removed.push(target.clone());
            }
        }
        compact = removed;
    }
    let summary = crate::messages::quantity(
        if selection.dry_run {
            "commands.inspect.cleanup.summary.plan"
        } else {
            "commands.inspect.cleanup.summary.remove"
        },
        compact.len(),
        &[],
    );
    Ok(
        json!({"summary":summary,"paths":compact,"protectedPaths":protected,"dryRun":selection.dry_run}),
    )
}
