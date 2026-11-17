use crate::{
    config::{self, Context, GeneratorRoot},
    deploy::{self, Installer, Project},
    plan::{Plan, Selection},
    plugin,
    state::OperationLock,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use ymb_core::{Diagnostic, Result, layout, metadata, paths};
use ymb_sdk::{compiler, distribution::*};

pub fn run(context: Context, mut selection: Selection) -> Result<Value> {
    if !selection.patch_filters.is_empty() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("release.mod.run.release_packages_whole_projects"),
            crate::messages::text("release.mod.run.use_mod_to_select_projects_and_omit"),
        ));
    }
    let _lock = OperationLock::acquire(&context, "release")?;
    if context.journal.exists() {
        return Err(error(crate::messages::text(
            "release.mod.run.finish_the_pending_ymb_operation_before_preparing",
        )));
    }
    let mut projects = config::discover(&context)?;
    for project in &mut projects {
        project.config.enabled = true;
        for generator in
            project
                .config
                .generators
                .iter_mut()
                .chain(project.patches.iter_mut().flat_map(|patch| {
                    patch.config.enabled = true;
                    &mut patch.config.generators
                }))
        {
            generator.enabled = true;
        }
    }
    selection.scope = "dev".into();
    let mut plan = Plan::new(context, selection, projects)?;
    plan.require_matches()?;
    if plan.mods.is_empty() {
        return Err(error(crate::messages::text(
            "release.mod.run.no_mod_projects_are_available_to_release",
        )));
    }
    let rust = crate::rust::discover(&plan.context.root).ok();
    let projects = plan
        .mods
        .iter()
        .map(|index| {
            (
                plan.projects[*index].config.name.clone(),
                plan.projects[*index].config.release.url.is_some() && rust.is_some(),
            )
        })
        .collect::<Vec<_>>();
    let generators = plan
        .mods
        .iter()
        .any(|index| !plan.projects[*index].config.generators.is_empty())
        || plan
            .patches
            .iter()
            .any(|patch| !plan.patch(*patch).config.generators.is_empty());
    let runtime = projects.iter().any(|(_, deploy)| *deploy);
    let _progress = crate::ui::Progress::start(
        plan.selection.interactive,
        progress_steps(&projects, plan.selection.dry_run, generators),
    );
    if !plan.selection.dry_run && generators {
        plugin::prepare_release(&mut plan)?;
    }
    let release_projects = |portable: Option<&Path>| -> Result<Value> {
        let mut results = Vec::new();
        let mut next_step = usize::from(generators) + usize::from(runtime);
        for index in &plan.mods {
            let project = &plan.projects[*index];
            let name = project.root.file_name().unwrap().to_string_lossy();
            let installer = Installer::from_config(&name, &project.config)?;
            let deploy = project.config.release.url.is_some() && rust.is_some();
            if !plan.selection.dry_run {
                let prepare_step = next_step;
                let archive_step = prepare_step + 1;
                let verify_step = archive_step + 1 + usize::from(deploy);
                let save_step = verify_step + 1;
                next_step = save_step + 1;
                crate::ui::step(prepare_step);
                crate::ui::phase(crate::messages::format(
                    "release.mod.run.preparing_release_for_name",
                    &[("NAME", format!("{}", name))],
                ));
                let work_root = ymb_core::storage::session(&plan.context.root, &project.config.id)?
                    .join("release");
                with_dist(&project.config_root, |dist| {
                    with_work(&work_root, "package", |work| {
                        let stage = work.join("stage");
                        let staged = stage.join(name.as_ref());
                        let config_relative =
                            project.config_root.strip_prefix(&project.root).unwrap();
                        let mut compiled = BTreeMap::new();
                        let mut excluded = vec![
                            ".git".to_owned(),
                            "dist".into(),
                            "target".into(),
                            ".ymb/dist-stage".into(),
                            ".ymb/dist.previous".into(),
                            ".ymb/dist.lock".into(),
                        ];
                        for (owner, generator) in project
                            .config
                            .generators
                            .iter()
                            .map(|generator| (&project.config_root, generator))
                            .chain(project.patches.iter().flat_map(|patch| {
                                patch
                                    .config
                                    .generators
                                    .iter()
                                    .map(move |generator| (&patch.root, generator))
                            }))
                        {
                            let Some(source) = &generator.project else {
                                continue;
                            };
                            let root = match generator.root {
                                GeneratorRoot::Owner => owner,
                                GeneratorRoot::Mod => &project.config_root,
                            };
                            let manifest = paths::resolve(root, source)?;
                            let manifest = if manifest.is_dir() {
                                manifest.join("Cargo.toml")
                            } else {
                                manifest
                            };
                            let relative =
                                manifest.strip_prefix(&project.config_root).map_err(|_| {
                                    error(crate::messages::text(
                                        "release.mod.run.generator_source_must_stay_inside_its_mod",
                                    ))
                                })?;
                            excluded.push(
                                relative
                                    .parent()
                                    .unwrap()
                                    .join("target")
                                    .to_string_lossy()
                                    .replace('\\', "/"),
                            );
                            if let std::collections::btree_map::Entry::Vacant(entry) =
                                compiled.entry((manifest, generator.binary.clone()))
                            {
                                entry.insert(plugin::release_executable(&plan, root, generator)?);
                            }
                        }
                        copy_tree(
                            &project.config_root,
                            &staged.join(config_relative),
                            &excluded.iter().map(String::as_str).collect::<Vec<_>>(),
                        )?;
                        for relative in &project.config.release.include {
                            let source = paths::resolve(&project.root, relative)?;
                            if paths::overlaps(&source, &project.config_root)?
                                || paths::overlaps(&source, &project.root.join(".ymb"))?
                                || paths::overlaps(&source, &project.root.join("dist"))?
                            {
                                return Err(config::config_error(
                                    &project.config_path,
                                    crate::messages::text(
                                        "release.mod.run.release_include_must_name_extra_files_outside",
                                    ),
                                ));
                            }
                            let target = paths::resolve(&staged, relative)?;
                            if source.is_dir() {
                                copy_tree(&source, &target, &[".git", "dist", "target", ".ymb"])?;
                            } else {
                                paths::copy_atomic(&source, &target)?;
                            }
                        }
                        for ((manifest, binary), executable) in &compiled {
                            let relative = manifest.strip_prefix(&project.root).unwrap();
                            let target_manifest = staged.join(relative);
                            let text = fs::read_to_string(&target_manifest)
                                .map_err(|e| Diagnostic::io(&target_manifest, e))?;
                            let mut cargo: toml::Value =
                                toml::from_str(&text).map_err(|e| error(e.to_string()))?;
                            rewrite_sdk(
                                &mut cargo,
                                &format!(
                                    "{}sdk/src/sdk",
                                    "../".repeat(
                                        2 + relative.parent().unwrap().components().count()
                                    )
                                ),
                            );
                            paths::write_atomic(
                                &target_manifest,
                                toml::to_string_pretty(&cargo).map_err(|e| error(e.to_string()))?,
                            )?;
                            let target = ymb_core::storage::generator(
                                &staged.join(config_relative),
                                &target_manifest,
                                binary.as_deref(),
                            )?;
                            if executable
                                != &ymb_core::storage::generator(
                                    &project.config_root,
                                    manifest,
                                    binary.as_deref(),
                                )?
                            {
                                paths::copy_atomic(executable, &target)?;
                                copy_tree(
                                    &executable.parent().unwrap().join("licenses"),
                                    &target.parent().unwrap().join("licenses"),
                                    &[],
                                )?;
                            }
                            compiler::stamp_executable(
                                &plan.context.root,
                                &target_manifest,
                                binary.as_deref(),
                                &target,
                            )?;
                        }
                        crate::ui::step(archive_step);
                        manifest(&staged, "package-manifest.json", &installer.version)?;
                        let archive = dist.join(format!("{name}-config.zip"));
                        zip_directory(&stage, &archive)?;
                        if deploy {
                            crate::ui::step(archive_step + 1);
                            let portable = portable.unwrap();
                            let executable = dist.join(format!("Deploy-{name}.exe"));
                            deploy::payload::write(
                                &portable.join(layout::EXECUTABLE),
                                &executable,
                                &installer,
                            )?;
                            paths::write_atomic(
                                &executable.with_extension("exe.sha256"),
                                format!("{}  Deploy-{name}.exe\n", paths::hash_file(&executable)?),
                            )?;
                            let notices_path = portable.join("THIRD_PARTY_NOTICES.md");
                            let notices = fs::read_to_string(&notices_path)
                                .map_err(|e| Diagnostic::io(&notices_path, e))?;
                            paths::write_atomic(
                                &dist.join("THIRD_PARTY_NOTICES.md"),
                                notices.replace(
                                    "licenses/rust-standard-library.html",
                                    "rust-standard-library.html",
                                ),
                            )?;
                            paths::copy_atomic(
                                &portable.join("licenses/rust-standard-library.html"),
                                &dist.join("rust-standard-library.html"),
                            )?;
                        }
                        crate::ui::step(verify_step);
                        if deploy {
                            verify::verify_installer(dist, portable.unwrap(), &installer)?;
                        }
                        with_work(work, "verify", |unpacked| {
                            extract(&archive, unpacked)?;
                            verify_package(&unpacked.join(name.as_ref()), "package-manifest.json")?;
                            Ok(())
                        })?;
                        Ok(())
                    })?;
                    crate::ui::step(save_step);
                    Ok(())
                })?;
            }
            results.push(json!({"modId":project.config.id,"version":installer.version,"dist":project.config_root.join("dist"),"archive":project.config_root.join("dist").join(format!("{name}-config.zip")),"deploy":if deploy {Some(project.config_root.join("dist").join(format!("Deploy-{name}.exe")))}else{None},"deploySkippedReason":if project.config.release.url.is_some() && !deploy {Some(crate::messages::text("release.mod.run.rust_is_not_available"))}else{None}}));
        }
        let summary = crate::messages::quantity(
            if plan.selection.dry_run {
                "release.mod.run.summary.plan"
            } else {
                "release.mod.run.summary.prepare"
            },
            results.len(),
            &[],
        );
        Ok(json!({"summary":summary, "releases":results,"dryRun":plan.selection.dry_run}))
    };
    if !plan.selection.dry_run
        && let Some(toolchain) = rust.as_ref()
        && plan
            .mods
            .iter()
            .any(|index| plan.projects[*index].config.release.url.is_some())
    {
        with_work(
            &plan.context.root.join(".ymb/releases"),
            "builder",
            |work| {
                crate::ui::step(usize::from(generators));
                let portable = portable_builder(&plan.context.root, work, toolchain)?;
                release_projects(Some(&portable))
            },
        )
    } else {
        release_projects(None)
    }
}

fn progress_steps(projects: &[(String, bool)], dry_run: bool, generators: bool) -> Vec<String> {
    if dry_run {
        return vec![
            crate::messages::text("release.mod.progress_steps.plan_project_releases").into(),
        ];
    }
    let mut steps = Vec::new();
    if generators {
        steps.push(
            crate::messages::text("release.mod.progress_steps.check_generator_registrations")
                .into(),
        );
    }
    if projects.iter().any(|(_, deploy)| *deploy) {
        steps.push(
            crate::messages::text("release.mod.progress_steps.prepare_installer_files").into(),
        );
    }
    for (name, deploy) in projects {
        steps.push(crate::messages::format(
            "release.mod.progress_steps.stage_name_files",
            &[("NAME", name.to_string())],
        ));
        steps.push(crate::messages::format(
            "release.mod.progress_steps.create_name_archive",
            &[("NAME", name.to_string())],
        ));
        if *deploy {
            steps.push(crate::messages::format(
                "release.mod.progress_steps.create_name_deploy_installer",
                &[("NAME", name.to_string())],
            ));
        }
        steps.push(crate::messages::format(
            "release.mod.progress_steps.verify_name_release",
            &[("NAME", name.to_string())],
        ));
        steps.push(crate::messages::format(
            "release.mod.progress_steps.save_name_files_in_dist",
            &[("NAME", name.to_string())],
        ));
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_progress_lists_only_work_that_will_run() {
        let projects = [("Linked".into(), true), ("Archive".into(), false)];
        let steps = progress_steps(&projects, false, true);
        assert_eq!(steps.len(), 11);
        assert_eq!(steps[1], "Prepare installer files");
        assert_eq!(steps[6], "Save Linked files in dist/");
        assert_eq!(steps[10], "Save Archive files in dist/");
        let archive_only = progress_steps(&[("Archive".into(), false)], false, false);
        assert_eq!(archive_only.len(), 4);
        assert!(
            !archive_only
                .iter()
                .any(|step| step.contains("generator") || step.contains("toolchain"))
        );
        assert!(!archive_only.iter().any(|step| step.contains("deploy")));
        assert_eq!(progress_steps(&projects, true, true).len(), 1);
    }

    #[test]
    fn portable_runtime_staging_copies_verified_payload_without_authored_mods_or_caches() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("YMB");
        paths::write_atomic(&root.join("YMB.exe"), "compiled builder").unwrap();
        paths::write_atomic(&root.join("sdk/Cargo.toml"), "portable SDK").unwrap();
        manifest(&root, "release-manifest.json", metadata::VERSION).unwrap();
        paths::write_atomic(
            &root.join("mods/Authored/config/ymb.mod.yaml"),
            "authored project",
        )
        .unwrap();
        paths::write_atomic(&root.join(".ymb/config.yaml"), "private settings").unwrap();
        let toolchain =
            compiler::Toolchain::portable(&root.join("unused-engine"), metadata::RUST_VERSION);
        let stage =
            portable_builder(&root, &root.join(".ymb/releases/fixture"), &toolchain).unwrap();
        verify_package(&stage, "release-manifest.json").unwrap();
        assert!(!stage.join("mods").exists());
        assert!(!stage.join(".ymb").exists());
        assert_eq!(
            fs::read_to_string(root.join(".ymb/config.yaml")).unwrap(),
            "private settings"
        );
    }
}

fn portable_builder(root: &Path, work: &Path, toolchain: &compiler::Toolchain) -> Result<PathBuf> {
    if root.join("release-manifest.json").is_file() {
        let manifest = verify_manifest(root, "release-manifest.json")?;
        let stage = work.join("YMB");
        for relative in std::iter::once("release-manifest.json").chain(
            manifest["files"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str),
        ) {
            paths::copy_atomic(&root.join(relative), &stage.join(relative))?;
        }
        verify_manifest(&stage, "release-manifest.json")?;
        return Ok(stage);
    }
    if !root.join("src/ymb/Cargo.toml").is_file() {
        return Err(Diagnostic::new(
            "DeploymentError",
            crate::messages::text(
                "release.mod.portable_builder.cannot_create_the_deploy_installer_ymb_s",
            ),
            crate::messages::text(
                "release.mod.portable_builder.extract_the_complete_ymb_archive_and_run",
            ),
        )
        .at(root));
    }
    crate::ui::phase(
        crate::messages::text("release.mod.portable_builder.preparing_installer_files").into(),
    );
    let (executable, packages) = builder::build(root, toolchain)?;
    let stage = work.join("YMB");
    builder::stage(root, &stage, &executable, &packages, toolchain)?;
    Ok(stage)
}

fn rewrite_sdk(value: &mut toml::Value, path: &str) {
    if let Some(table) = value.as_table_mut() {
        for (name, value) in table {
            if (name == "ymb-sdk"
                || value.get("package").and_then(toml::Value::as_str) == Some("ymb-sdk"))
                && value.get("path").is_some()
            {
                value["path"] = toml::Value::String(path.into());
            } else {
                rewrite_sdk(value, path);
            }
        }
    }
}

pub(crate) mod licenses;
mod verify;
