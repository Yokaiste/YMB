use crate::{
    config::{self, Context},
    engine::{self, Materialized},
    plan::{Plan, Selection},
    state::{self, Manifest, ManifestEntry, OperationLock, Root, TrackedState, Transaction},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use ymb_core::{Diagnostic, Result, hash, metadata, ndf, parallel, paths};

pub fn prepare(context: Context, selection: Selection) -> Result<Plan> {
    let projects = config::discover(&context)?;
    Plan::new(context, selection, projects)
}
pub fn build(context: Context, selection: Selection, command: &str) -> Result<Value> {
    let _progress = crate::ui::Progress::start(vec![
        crate::messages::text("commands.inspect.inspect.read_projects_and_resolve_selection")
            .into(),
    ]);
    let save_preview = command != "validate" && !selection.dry_run;
    let _lock = OperationLock::acquire(&context, command)?;
    let recovered = state::prepare_pending(&context, !save_preview)?;
    let mut plan = prepare(context, selection)?;
    plan.require_matches()?;
    let mut sync_selection = plan.selection.clone();
    if !sync_selection.mod_filters.is_empty() {
        sync_selection.mod_filters.extend(
            plan.mods
                .iter()
                .map(|id| plan.projects[*id].config.id.clone()),
        );
    }
    let mut steps =
        vec![crate::messages::text("commands.mod.build.prepare_build_workspace").to_owned()];
    let first_project_step = 1 + steps.len();
    steps.extend(plan.mods.iter().map(|id| {
        crate::messages::format(
            "commands.mod.build.build_project_arg0",
            &[("ARG0", plan.projects[*id].config.name.to_string())],
        )
    }));
    steps
        .push(crate::messages::text("commands.mod.build.check_references_and_final_output").into());
    let preview_step = 1 + steps.len();
    if save_preview {
        steps.push(
            crate::messages::text("commands.mod.build.stage_preview_and_generator_owned_files")
                .into(),
        );
        if command == "sync" {
            steps.push(
                crate::messages::text("commands.mod.build.apply_files_and_save_originals").into(),
            );
        }
        steps.push(
            crate::messages::text(
                "commands.mod.build.save_preview_and_finish_the_file_transaction",
            )
            .into(),
        );
    }
    crate::ui::extend_steps(steps);
    crate::ui::step(1);
    if let Err(error) = crate::plugin::prepare(&mut plan) {
        crate::ui::failed_step(1);
        return Err(error);
    }
    let started = Instant::now();
    if save_preview {
        reset_work(&plan.context)?;
    }
    let reset_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut built = engine::materialize(&plan, first_project_step)?;
    built
        .metrics
        .timings_ms
        .insert("resetWork".into(), reset_ms);
    let mut warnings = plan.override_warnings();
    warnings.extend(built.skipped.iter().map(|item|json!({"code":"W2","reason":crate::messages::text("commands.mod.build.an_optional_patch_could_not_run"),"modId":item.mod_id,"patchId":item.patch_id,"cause":item.reason,"patch":item})));
    let mut changed = 0;
    if command == "sync" {
        check_tracked(&built, &sync_selection, &mut warnings)?;
    }
    if save_preview {
        crate::ui::step(preview_step);
        let started = Instant::now();
        let staged = stage_preview(&built)?;
        built.metrics.record("preview", started);
        let mut transaction = Transaction::begin(&plan.context, command)?;
        let started = Instant::now();
        let result = (|| -> Result<()> {
            commit_owned(&built, &mut transaction)?;
            if command == "sync" {
                crate::ui::step(preview_step + 1);
                changed = sync(
                    &mut built,
                    &sync_selection,
                    &staged,
                    &mut transaction,
                    &mut warnings,
                )?;
            }
            crate::ui::step(preview_step + if command == "sync" { 2 } else { 1 });
            transaction.publish_preview(&staged)?;
            Ok(())
        })();
        match result {
            Ok(()) => transaction.commit()?,
            Err(error) => {
                if let Err(rollback) = transaction.rollback() {
                    return Err(error.detail(crate::messages::format(
                        "commands.mod.build.rollback_also_failed_rollback",
                        &[("ROLLBACK", format!("{}", rollback))],
                    )));
                }
                return Err(error);
            }
        }
        built.metrics.record(
            if command == "sync" {
                "applyAndPublish"
            } else {
                "publish"
            },
            started,
        );
    }
    let outputs:Vec<_>=built.outputs.values().map(|output|json!({"targetRelativePath":output.target,"state":if output.content.is_some(){"present"}else{"absent"},"contentHash":output.content.as_ref().map(|s|&s.hash),"bytes":output.content.as_ref().map_or(0,|s|s.bytes),"sourceType":output.source_type,"contributors":output.contributors})).collect();
    let summary = crate::messages::quantity(
        match (command, plan.selection.dry_run) {
            ("validate", true) => "commands.mod.build.summary.validate_dry",
            ("validate", false) => "commands.mod.build.summary.validate",
            (_, true) => "commands.mod.build.summary.plan",
            ("sync", false) => "commands.mod.build.summary.sync",
            _ => "commands.mod.build.summary.build",
        },
        outputs.len(),
        &[],
    );
    Ok(
        json!({"summary":summary,"outputs":outputs,"changedFiles":changed,"warnings":warnings,"notices":built.notices,"tests":built.tests,"skippedPatches":built.skipped,"metrics":built.metrics,"recoveredInterruptedOperation":recovered,"previewPath":plan.context.output,"previewPublished":save_preview,"applied":command=="sync"&&!plan.selection.dry_run,"dryRun":plan.selection.dry_run}),
    )
}
fn reset_work(context: &Context) -> Result<()> {
    paths::assert_no_links(&context.work, &context.work)?;
    if context.work.exists() {
        for entry in fs::read_dir(&context.work).map_err(|e| Diagnostic::io(&context.work, e))? {
            let path = entry.map_err(|e| Diagnostic::io(&context.work, e))?.path();
            paths::assert_no_links(&context.work, &path)?;
            // Legacy Cargo work is reclaimed by cleanup, not by routine builds.
            if path != context.work.join("g") {
                if path.is_dir() {
                    paths::remove_tree(&context.work, &path)?;
                } else {
                    fs::remove_file(&path).map_err(|e| Diagnostic::io(&path, e))?;
                }
            }
        }
    }
    Ok(())
}
fn check_tracked(
    built: &Materialized<'_>,
    selection: &Selection,
    warnings: &mut Vec<Value>,
) -> Result<()> {
    warnings.retain(|warning| warning["code"] != "W4");
    let mut errors = Vec::new();
    for entry in &built.manifest.entries {
        if !state::selected(entry, selection)
            && !built
                .outputs
                .contains_key(&paths::key(&entry.target_relative_path))
        {
            continue;
        }
        let output = built.outputs.get(&paths::key(&entry.target_relative_path));
        let excluded: Vec<_> = entry
            .contributors
            .iter()
            .filter(|owner| {
                !state::contributor_selected(owner, selection)
                    && !output.is_some_and(|output| {
                        output.contributors.iter().any(|next| {
                            next.mod_id == owner.mod_id
                                && next.patch_id == owner.patch_id
                                && next.generator_id == owner.generator_id
                        })
                    })
            })
            .collect();
        if !excluded.is_empty() {
            errors.push(*Diagnostic::new(
                "ConflictError",
                crate::messages::text("commands.mod.check_tracked.this_sync_would_remove_excluded_contributors_from"),
                crate::messages::text("commands.mod.check_tracked.include_all_contributors_in_the_sync_selection"),
            ).at(&entry.target_relative_path).with("contributors", excluded));
            continue;
        }
        if state::classify(&built.plan.context, entry)? == TrackedState::Changed {
            if selection.reset_changed {
                warnings.push(json!({"code":"W4","reason":crate::messages::text("commands.mod.check_tracked.external_edits_to_a_tracked_file_will"),"path":entry.target_relative_path}));
            } else {
                errors.push(*changed_error(&entry.target_relative_path));
            }
        }
    }
    if let Some(error) = Diagnostic::group(errors) {
        return Err(error);
    }
    Ok(())
}
fn stage_preview(built: &Materialized<'_>) -> Result<PathBuf> {
    let staged = built.store.root.join("preview");
    fs::create_dir(&staged).map_err(|e| Diagnostic::io(&staged, e))?;
    let mut deletions = Vec::new();
    let mut outputs = Vec::new();
    // Create and validate shared parents before writers start on Windows.
    for output in built.outputs.values() {
        if let Some(content) = &output.content {
            let target = paths::resolve(&staged, &output.target)?;
            let parent = target.parent().unwrap();
            fs::create_dir_all(parent).map_err(|e| Diagnostic::io(parent, e))?;
            outputs.push((output, content, target));
        } else {
            deletions.push(
                json!({"targetRelativePath":output.target,"contributors":output.contributors}),
            );
        }
    }
    let mut limits = built.plan.context.config.settings.parallel_limits();
    // Copy throughput plateaus at eight writers on the measured Windows workload.
    limits.threads = limits.threads.min(8);
    for result in parallel::map(
        &outputs,
        limits,
        |(_, content, _)| (content.bytes as usize).saturating_mul(4),
        |(output, content, target)| -> Result<()> {
            if output.preserve || state::comment_style(&output.target).is_none() {
                paths::copy_atomic(&content.path, target)?;
            } else {
                paths::write_atomic(
                    target,
                    state::marked_bytes(
                        &content.read()?,
                        &output.target,
                        &output.contributors,
                        &built.plan.context.root,
                        false,
                    )?,
                )?;
            }
            Ok(())
        },
    ) {
        result?;
    }
    paths::write_atomic(
        &staged.join("deletions.json"),
        serde_json::to_vec_pretty(&json!({"version":metadata::CACHE_VERSION,"files":deletions}))
            .unwrap(),
    )?;
    Ok(staged)
}
fn commit_owned(built: &Materialized<'_>, transaction: &mut Transaction) -> Result<()> {
    for (path, expected) in &built.owned_originals {
        if built.overlay(path).is_some() && state::file_hash(path)? != *expected {
            return Err(Diagnostic::new(
                "GeneratorError",
                crate::messages::text(
                    "commands.mod.commit_owned.an_authored_file_changed_during_generation",
                ),
                crate::messages::text("common.shared.retry_after_the_other_writer_has_finished"),
            )
            .at(path));
        }
    }
    for (path, snapshot) in &built.owned {
        let relative = path
            .strip_prefix(&built.plan.context.mods)
            .map_err(|_| {
                Diagnostic::new(
                    "GeneratorError",
                    crate::messages::text(
                        "commands.mod.commit_owned.an_owned_write_escaped_the_source_project",
                    ),
                    crate::messages::text(
                        "commands.mod.commit_owned.use_context_owned_file_helpers",
                    ),
                )
            })?
            .to_string_lossy()
            .replace('\\', "/");
        if state::file_hash(path)?.as_ref() != Some(&snapshot.hash) {
            transaction.copy(Root::Mods, &relative, &snapshot.path)?;
        }
    }
    Ok(())
}
fn sync(
    built: &mut Materialized<'_>,
    selection: &Selection,
    staged: &Path,
    transaction: &mut Transaction,
    warnings: &mut Vec<Value>,
) -> Result<usize> {
    check_tracked(built, selection, warnings)?;
    let targets: Vec<_> = built.outputs.values().map(|o| o.target.clone()).collect();
    for target in targets {
        built.original(&target)?;
    }
    let context = &built.plan.context;
    let mut entries = built.manifest.map();
    let mut changed = 0;
    let obsolete: Vec<_> = entries
        .iter()
        .filter(|(key, entry)| {
            !built.outputs.contains_key(*key) && state::selected(entry, selection)
        })
        .map(|(key, entry)| (key.clone(), entry.clone()))
        .collect();
    for (key, entry) in obsolete {
        restore(transaction, context, &entry)?;
        entries.remove(&key);
        changed += 1;
    }
    for output in built.outputs.values() {
        if built.manifest.entries.iter().any(|entry| {
            entry
                .target_relative_path
                .eq_ignore_ascii_case(&output.target)
        }) {
            continue;
        }
        let expected = built
            .originals
            .get(&paths::key(&output.target))
            .and_then(|s| s.as_ref())
            .map(|s| s.hash.clone());
        if state::file_hash(&context.target(&output.target)?)? != expected {
            return Err(Diagnostic::new(
                "RecoveryError",
                crate::messages::text(
                    "commands.mod.sync.an_untracked_target_changed_during_the_build",
                ),
                crate::messages::text("common.shared.retry_after_the_other_writer_has_finished"),
            )
            .at(&output.target));
        }
    }
    let targets: Vec<_> = built.outputs.keys().cloned().collect();
    for key in targets {
        let output = built.outputs[&key].clone();
        let target = context.target(&output.target)?;
        let original = built.original(&output.target)?;
        let original_hash = original.as_ref().map(|s| s.hash.clone());
        let original_exists = original.is_some();
        let name = entries.get(&key).map_or_else(
            || {
                state::backup_name(
                    &output.target,
                    original_hash.as_deref().unwrap_or(&hash([])),
                    engine::is_ndf(&output.target),
                )
            },
            |entry| entry.backup_file_name.clone(),
        );
        if let Some(snapshot) = original {
            let backup = context.state.join("originals").join(&name);
            if !backup.exists() {
                transaction.copy(Root::State, &format!("originals/{name}"), &snapshot.path)?;
            } else if paths::hash_file(&backup)? != snapshot.hash {
                return Err(state::recovery(
                    &backup,
                    crate::messages::text(
                        "commands.mod.sync.existing_original_backup_has_unexpected_contents",
                    ),
                ));
            }
        }
        let synced_hash = if output.content.is_some() {
            let desired = paths::resolve(staged, &output.target)?;
            let desired_hash = paths::hash_file(&desired)?;
            if state::file_hash(&target)?.as_ref() != Some(&desired_hash) {
                transaction.copy(Root::Game, &output.target, &desired)?;
                changed += 1;
            }
            Some(desired_hash)
        } else {
            if target.exists() {
                transaction.remove(Root::Game, &output.target)?;
                changed += 1;
            }
            None
        };
        entries.insert(
            key,
            ManifestEntry {
                target_relative_path: output.target,
                backup_file_name: name,
                original_exists,
                expected_state: if output.content.is_some() {
                    "present".into()
                } else {
                    "absent".into()
                },
                original_content_hash: original_hash,
                synced_content_hash: synced_hash,
                contributors: output.contributors,
            },
        );
    }
    let manifest = Manifest {
        version: Some(metadata::STATE_VERSION),
        entries: entries.into_values().collect(),
    };
    transaction.write(
        Root::State,
        "manifest.json",
        &state::checked_metadata(
            serde_json::to_vec_pretty(&manifest).unwrap(),
            &context.state.join("manifest.json"),
        )?,
    )?;
    prune_originals(context, &manifest, transaction)?;
    Ok(changed)
}
fn restore(transaction: &mut Transaction, context: &Context, entry: &ManifestEntry) -> Result<()> {
    if entry.original_exists {
        transaction.copy(
            Root::Game,
            &entry.target_relative_path,
            &state::original_backup(context, entry)?,
        )?;
    } else {
        transaction.remove(Root::Game, &entry.target_relative_path)?;
    }
    Ok(())
}
fn prune_originals(
    context: &Context,
    manifest: &Manifest,
    transaction: &mut Transaction,
) -> Result<()> {
    let keep: HashSet<_> = manifest
        .entries
        .iter()
        .filter(|e| e.original_exists)
        .map(|e| e.backup_file_name.as_str())
        .collect();
    for path in paths::walk(&context.state.join("originals"), true)? {
        let name = path.file_name().unwrap().to_string_lossy();
        if !keep.contains(name.as_ref()) {
            transaction.remove(Root::State, &format!("originals/{name}"))?;
        }
    }
    Ok(())
}
pub fn recover(context: Context, selection: Selection) -> Result<Value> {
    let _progress = crate::ui::Progress::start(vec![
        crate::messages::text("commands.mod.recover.check_saved_originals_and_selected_files")
            .into(),
    ]);
    let _lock = OperationLock::acquire(&context, "recover")?;
    let interrupted = state::prepare_pending(&context, selection.dry_run)?;
    let manifest = Manifest::load(&context)?;
    manifest.validate_backups(&context)?;
    let selected: Vec<_> = manifest
        .entries
        .iter()
        .filter(|entry| state::selected(entry, &selection))
        .collect();
    if !manifest.entries.is_empty() {
        for (option, filters) in [
            ("--mod", &selection.mod_filters),
            ("--patch", &selection.patch_filters),
        ] {
            for filter in filters {
                let single = Selection {
                    mod_filters: if option == "--mod" {
                        vec![filter.clone()]
                    } else {
                        vec![]
                    },
                    patch_filters: if option == "--patch" {
                        vec![filter.clone()]
                    } else {
                        vec![]
                    },
                    ..Default::default()
                };
                if !manifest
                    .entries
                    .iter()
                    .any(|entry| state::selected(entry, &single))
                {
                    return Err(Diagnostic::new(
                        "CommandError",
                        crate::messages::format(
                            "commands.mod.recover.unknown_filter",
                            &[("OPTION", option.into()), ("VALUE", filter.clone())],
                        ),
                        crate::messages::text("commands.mod.recover.check_tracked_selection"),
                    )
                    .with("filter", json!({"option":option,"value":filter})));
                }
            }
        }
        if selected.is_empty() {
            return Err(Diagnostic::new(
                "CommandError",
                crate::messages::text("commands.mod.recover.empty_combination"),
                crate::messages::text("commands.mod.recover.check_tracked_selection"),
            ));
        }
    }
    let mut warnings = Vec::new();
    for entry in &selected {
        if state::classify(&context, entry)? == TrackedState::Changed && !selection.reset_changed {
            return Err(changed_error(&entry.target_relative_path));
        }
        if entry.contributors.len() > 1
            && (!selection.mod_filters.is_empty() || !selection.patch_filters.is_empty())
        {
            warnings.push(json!({"code":"W5","reason":crate::messages::text("commands.mod.recover.recovery_restores_whole_files_including_all_their"),"path":entry.target_relative_path,"contributors":entry.contributors}));
        }
    }
    let paths: Vec<_> = selected
        .iter()
        .map(|entry| entry.target_relative_path.clone())
        .collect();
    if !selection.dry_run && !selected.is_empty() {
        crate::ui::extend_steps(vec![
            crate::messages::text("commands.mod.recover.restore_whole_files").into(),
            crate::messages::text("commands.mod.recover.update_recovery_records").into(),
        ]);
        crate::ui::step(1);
        let mut transaction = Transaction::begin(&context, "recover")?;
        let result = (|| -> Result<()> {
            for entry in &selected {
                restore(&mut transaction, &context, entry)?;
            }
            let keys: HashSet<_> = paths.iter().map(paths::key).collect();
            let remaining = Manifest {
                version: manifest.version,
                entries: manifest
                    .entries
                    .iter()
                    .filter(|entry| !keys.contains(&paths::key(&entry.target_relative_path)))
                    .cloned()
                    .collect(),
            };
            crate::ui::step(2);
            transaction.write(
                Root::State,
                "manifest.json",
                &state::checked_metadata(
                    serde_json::to_vec_pretty(&remaining).unwrap(),
                    &context.state.join("manifest.json"),
                )?,
            )?;
            prune_originals(&context, &remaining, &mut transaction)
        })();
        match result {
            Ok(()) => transaction.commit()?,
            Err(error) => {
                transaction.rollback()?;
                return Err(error);
            }
        }
    }
    let summary = crate::messages::quantity(
        if selection.dry_run {
            "commands.mod.recover.summary.plan"
        } else {
            "commands.mod.recover.summary.restore"
        },
        paths.len(),
        &[],
    );
    Ok(
        json!({"summary":summary,"files":paths,"warnings":warnings,"recoveredInterruptedOperation":interrupted,"dryRun":selection.dry_run}),
    )
}
fn changed_error(target: &str) -> Box<Diagnostic> {
    Diagnostic::new(
        "RecoveryError",
        crate::messages::format(
            "commands.mod.changed_error.tracked_file_target_has_external_changes",
            &[("TARGET", target.to_string())],
        ),
        crate::messages::text("commands.mod.changed_error.keep_a_copy_of_those_changes_then"),
    )
    .at(target)
    .code("E12")
}

mod inspect;
pub use inspect::{FindOptions, cleanup, find, inspect};
