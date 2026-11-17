use super::*;

pub fn materialize(plan: &Plan) -> Result<Materialized<'_>> {
    let started = Instant::now();
    let mut built = Materialized::new(plan)?;
    built.metrics.record("inputsAndBackups", started);
    let started = Instant::now();
    built.cache.prune()?;
    built.metrics.record("cacheMaintenance", started);
    let mut removed = HashMap::new();
    loop {
        built.outputs.clear();
        built.owned.clear();
        built.owned_originals.clear();
        built.notices.clear();
        built.tests.clear();
        let timings = std::mem::take(&mut built.metrics.timings_ms);
        built.metrics = Metrics {
            timings_ms: timings,
            ..Default::default()
        };
        let mut failures = Vec::new();
        let mut failed_projects = HashSet::new();
        for (index, project) in plan.mods.iter().enumerate() {
            if failed_projects.iter().any(|failed| {
                plan.can_layer(*project, *failed)
                    || plan
                        .mod_dependencies
                        .get(project)
                        .is_some_and(|dependencies| dependencies.contains(failed))
            }) {
                failed_projects.insert(*project);
                crate::ui::failed_step(index + 1);
                continue;
            }
            crate::ui::step(index + 1);
            let keys: Vec<_> = plan
                .patches
                .iter()
                .copied()
                .filter(|key| key.project == *project && !removed.contains_key(key))
                .collect();
            if plan.selection.progress() {
                crate::ui::phase(crate::messages::format(
                    "engine.pipeline.materialize.project_arg0_arg1_selected_patches",
                    &[
                        ("ARG0", plan.projects[*project].config.id.to_string()),
                        ("ARG1", format!("{}", keys.len())),
                    ],
                ));
            }
            if let Err(error) = materialize_project(&mut built, *project, &keys) {
                failed_projects.insert(*project);
                crate::ui::failed_step(index + 1);
                if error.related.is_empty() {
                    failures.push(*error);
                } else {
                    failures.extend(error.related);
                }
            }
        }
        if failures.is_empty() {
            break;
        }
        if plan.drop_optional(&mut removed, &failures) {
            continue;
        }
        return Err(Diagnostic::group(failures).unwrap());
    }
    crate::ui::step(plan.mods.len() + 1);
    let started = Instant::now();
    check_references(&mut built, &removed)?;
    built.metrics.record("references", started);
    built.skipped = removed
        .into_iter()
        .map(|(key, reason)| SkippedPatch {
            mod_id: plan.projects[key.project].config.id.clone(),
            mod_name: plan.projects[key.project].config.name.clone(),
            patch_id: plan.patch(key).config.id.clone(),
            reason,
        })
        .collect();
    built
        .skipped
        .sort_by(|a, b| (&a.mod_id, &a.patch_id).cmp(&(&b.mod_id, &b.patch_id)));
    let started = Instant::now();
    let pending: Vec<_> = built
        .outputs
        .values()
        .filter_map(|output| {
            let snapshot = output.content.as_ref()?;
            (is_ndf(&output.target) && !built.store.is_validated(snapshot))
                .then_some((output.target.as_str(), snapshot))
        })
        .collect();
    let errors = parallel::map(
        &pending,
        plan.context.config.settings.parallel_limits(),
        |(_, snapshot)| (snapshot.bytes as usize).saturating_mul(2),
        |(target, snapshot)| {
            built
                .store
                .validate_ndf(snapshot, target)
                .map_err(|e| e.at(target))
        },
    )
    .into_iter()
    .filter_map(|result| result.err().map(|error| *error))
    .collect();
    built.metrics.record("finalValidation", started);
    if let Some(error) = Diagnostic::group(errors) {
        return Err(error);
    }
    let absent: Vec<_> = built
        .outputs
        .iter()
        .filter(|(_, output)| output.content.is_none())
        .map(|(key, output)| (key.clone(), output.target.clone()))
        .collect();
    for (key, target) in absent {
        if built.original(&target)?.is_none() {
            built.outputs.remove(&key);
        }
    }

    built.metrics.staged_bytes = built
        .outputs
        .values()
        .filter_map(|o| o.content.as_ref())
        .map(|s| s.bytes)
        .sum();
    let started = Instant::now();
    built.cache.prune()?;
    built.metrics.record("cacheMaintenance", started);
    built.notices.extend(built.cache.take_notices());
    for cache in built.generator_caches.values() {
        cache.prune()?;
        built.notices.extend(cache.take_notices());
    }
    Ok(built)
}
#[derive(Clone)]
pub(super) struct PatchWork {
    pub(super) key: PatchRef,
    pub(super) target: config::Target,
    pub(super) variables: Value,
}
pub(super) struct Job {
    pub(super) target: String,
    pub(super) base: Snapshot,
    pub(super) operations: Vec<PatchWork>,
}
#[derive(Serialize, Deserialize)]
pub(super) struct CachedPatch {
    pub(super) notices: Vec<ndf::operation::Notice>,
    pub(super) hash: String,
}
pub(super) fn materialize_project(
    built: &mut Materialized<'_>,
    project: usize,
    keys: &[PatchRef],
) -> Result<()> {
    built.project_base = built.outputs.clone();
    let plan = built.plan;
    let owner = &plan.projects[project];
    let started = Instant::now();
    let mut errors = Vec::new();
    let mut grouped: BTreeMap<String, (String, Vec<PatchWork>)> = BTreeMap::new();
    let mut file_owners: HashMap<String, PatchRef> = HashMap::new();
    for key in keys {
        let patch = plan.patch(*key);
        let result = (|| -> Result<()> {
            let variables = built.variables(project, Some(key.patch))?;
            file_operations(built, *key, &variables, &mut file_owners)?;
            for target in &patch.config.targets {
                let target_path = resolve_path_template(&target.file, &variables)?;
                let target_path = paths::game_relative(&target_path)?;
                let target_key = paths::key(&target_path);
                if file_owners.contains_key(&target_key) {
                    return Err(conflict(
                        &target_path,
                        crate::messages::text(
                            "engine.pipeline.materialize_project.file_operations_and_ndf_targets_cannot_own",
                        ),
                    ));
                }
                grouped
                    .entry(target_key)
                    .or_insert_with(|| (target_path, Vec::new()))
                    .1
                    .push(PatchWork {
                        key: *key,
                        target: target.clone(),
                        variables: variables.clone(),
                    });
            }
            Ok(())
        })();
        if let Err(error) = result {
            errors.push(*attach(error, owner, Some(patch)));
        }
    }
    let mut jobs = Vec::new();
    for (_, (target, operations)) in grouped {
        if file_owners.contains_key(&paths::key(&target)) {
            errors.push(*attach(
                conflict(
                    &target,
                    crate::messages::text("engine.pipeline.materialize_project.file_operations_and_ndf_targets_cannot_own"),
                ),
                owner,
                Some(plan.patch(operations[0].key)),
            ));
            continue;
        }
        match built.visible(&target, project) {
            Ok(Some(base)) => jobs.push(Job {
                target,
                base,
                operations,
            }),
            Ok(None) => errors.push(*attach(
                missing(&target),
                owner,
                Some(plan.patch(operations[0].key)),
            )),
            Err(error) => errors.push(*attach(error, owner, Some(plan.patch(operations[0].key)))),
        }
    }
    built.metrics.record("prepareTargets", started);
    let started = Instant::now();
    let limits = plan.context.config.settings.parallel_limits();
    if plan.selection.progress() && !jobs.is_empty() {
        crate::ui::phase(crate::messages::format(
            "engine.pipeline.materialize_project.processing_arg0_ndf_targets_with_up_to",
            &[
                ("ARG0", format!("{}", jobs.len())),
                ("ARG1", format!("{}", limits.threads)),
            ],
        ));
    }
    let results = parallel::map(
        &jobs,
        limits,
        |job| (job.base.bytes as usize).saturating_mul(8),
        |job| run_patch_job(plan, job, &built.store, &built.cache),
    );
    for (job, result) in jobs.iter().zip(results) {
        match result {
            Ok((snapshot, notices, cached)) => {
                let contributors = job
                    .operations
                    .iter()
                    .map(|work| contributor(owner, Some(plan.patch(work.key)), None))
                    .collect();
                let output = Output {
                    target: job.target.clone(),
                    content: Some(snapshot),
                    contributors,
                    source_type: "patch".into(),
                    preserve: false,
                };
                if let Err(error) = built.combine(output, project, Some(&job.base.hash), &[]) {
                    errors.push(*error);
                }
                built.notices.extend(
                    notices
                        .into_iter()
                        .map(|notice| serde_json::to_value(notice).unwrap()),
                );
                built.metrics.patched_files += 1;
                built.metrics.cache_hits += usize::from(cached);
            }
            Err(error) => errors.push(*error),
        }
    }
    if let Some(error) = Diagnostic::group(errors) {
        return Err(error);
    }
    built.metrics.record("patchTargets", started);
    let variables = built.variables(project, None)?;
    for generator in owner.config.generators.iter().filter(|g| g.enabled) {
        run_generator(built, project, None, generator, &variables)?;
    }
    for key in keys {
        let variables = built.variables(project, Some(key.patch))?;
        for generator in plan
            .patch(*key)
            .config
            .generators
            .iter()
            .filter(|g| g.enabled)
        {
            run_generator(built, project, Some(key.patch), generator, &variables)?;
        }
    }
    let replace = owner.config_root.join("replace");
    let started = Instant::now();
    let replace_sources = built.replacement_sources(project)?;
    for source in replace_sources {
        let relative = paths::strip_prefix(&replace, &source)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let target = paths::game_relative(&resolve_path_template(&relative, &variables)?)?;
        if file_owners.contains_key(&paths::key(&target))
            || jobs.iter().any(|j| j.target.eq_ignore_ascii_case(&target))
        {
            return Err(attach(
                conflict(
                    &target,
                    crate::messages::text(
                        "engine.pipeline.materialize_project.a_mod_wide_replacement_collides_with_a",
                    ),
                ),
                owner,
                None,
            ));
        }
        if built
            .outputs
            .get(&paths::key(&target))
            .is_some_and(|o| o.contributors.iter().any(|c| c.mod_id == owner.config.id))
        {
            return Err(attach(
                conflict(
                    &target,
                    crate::messages::text(
                        "engine.pipeline.materialize_project.a_generator_output_collides_with_its_mod",
                    ),
                ),
                owner,
                None,
            ));
        }
        let source = if let Some(overlay) = built.overlay(&source) {
            overlay.clone()
        } else {
            built.store.capture(&source, kind(&target))?
        };
        let template = template_file(&relative) || is_ndf(&target);
        let snapshot = template_snapshot(&built.store, &source, &target, &variables, template)?;
        built.combine(
            Output {
                target,
                content: Some(snapshot),
                contributors: vec![contributor(owner, None, None)],
                source_type: "replace".into(),
                preserve: !template,
            },
            project,
            None,
            &[],
        )?;
    }
    built.metrics.record("replacements", started);
    Ok(())
}
pub(super) fn run_patch_job(
    plan: &Plan,
    job: &Job,
    store: &Store,
    cache: &Cache,
) -> Result<(Snapshot, Vec<ndf::operation::Notice>, bool)> {
    if plan.selection.progress() {
        crate::ui::phase(crate::messages::format(
            "engine.pipeline.run_patch_job.processing_target",
            &[("TARGET", job.target.clone())],
        ));
    }
    let key=hash(serde_json::to_vec(&json!({"noticeContext":3,"input":job.base.hash,"path":job.target,"patches":job.operations.iter().map(|work|json!({"mod":plan.projects[work.key.project].config.id,"patch":plan.patch(work.key).config.id,"operations":work.target.operations,"operationLines":work.target.operation_lines,"patchConfigPath":plan.patch(work.key).config_path,"variables":work.variables,"expect":work.target.expect})).collect::<Vec<_>>()})).unwrap());
    if let Some(snapshot) = cache.read(store, "patch-text", &key)?
        && let Some(metadata) = cache.read(store, "patch-metadata", &key)?
        && let Ok(cached) = metadata.read().and_then(|bytes| {
            serde_json::from_slice::<CachedPatch>(&bytes).map_err(|e| {
                Diagnostic::new(
                    "CacheError",
                    e.to_string(),
                    crate::messages::text("engine.pipeline.run_patch_job.rebuild_the_cache"),
                )
            })
        })
        && cached.hash == snapshot.hash
        && store.validate_ndf(&snapshot, &job.target).is_ok()
    {
        return Ok((snapshot, cached.notices, true));
    }
    let source = job.base.text().map_err(|error| error.at(&job.target))?;
    let mut document =
        ndf::document::Document::new(&source).map_err(|error| error.at(&job.target))?;
    let mut notices = Vec::new();
    for work in &job.operations {
        let owner = &plan.projects[work.key.project];
        let patch = plan.patch(work.key);
        let identity = ndf::operation::Identity {
            mod_id: owner.config.id.clone(),
            mod_name: owner.config.name.clone(),
            patch_id: patch.config.id.clone(),
            patch_config_path: Some(patch.config_path.to_string_lossy().into_owned()),
            path: job.target.clone(),
            operation_lines: work.target.operation_lines.clone(),
        };
        let expanded = ndf::operation::expand(&work.target.operations, &work.variables)
            .map_err(|e| attach(e.at(&patch.config_path), owner, Some(patch)))?;
        for (operation, index) in expanded {
            ndf::patch::apply_operation(&mut document, &operation, &identity, index, &mut notices)
                .map_err(|e| identity.attach(e, index))?;
        }
    }
    let text = document.render();
    let snapshot = store.put(text, ContentKind::Text)?;
    store.validate_ndf(&snapshot, &job.target)?;
    let cached = store.put(
        serde_json::to_vec(&CachedPatch {
            hash: snapshot.hash.clone(),
            notices: notices.clone(),
        })
        .unwrap(),
        ContentKind::Binary,
    )?;
    cache.write("patch-text", &key, &snapshot)?;
    cache.write("patch-metadata", &key, &cached)?;
    Ok((snapshot, notices, false))
}
pub(super) fn run_generator(
    built: &mut Materialized<'_>,
    project: usize,
    patch: Option<usize>,
    generator: &Generator,
    variables: &Value,
) -> Result<()> {
    let started = Instant::now();
    let result = (|| -> Result<()> {
        for test in generator.tests.iter().filter(|t| t.when() == "before") {
            crate::plugin::execute(
                built,
                project,
                patch,
                generator,
                variables,
                "before",
                Some(test.id()),
            )?;
        }
        crate::plugin::execute(
            built, project, patch, generator, variables, "generate", None,
        )?;
        built.metrics.generators += 1;
        for test in generator.tests.iter().filter(|t| t.when() == "after") {
            crate::plugin::execute(
                built,
                project,
                patch,
                generator,
                variables,
                "after",
                Some(test.id()),
            )?;
        }
        Ok(())
    })();
    built.metrics.record(
        &format!(
            "generator:{}:{}",
            built.plan.projects[project].config.id, generator.id
        ),
        started,
    );
    result.map_err(|error| {
        attach(
            error.with("generatorId", &generator.id),
            &built.plan.projects[project],
            patch.map(|id| &built.plan.projects[project].patches[id]),
        )
    })
}
