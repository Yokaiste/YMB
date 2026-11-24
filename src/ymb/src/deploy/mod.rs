use crate::config::{self, Dependency, ModConfig};
use crate::{
    platform,
    ui::{self, Progress, prompt},
};
use clap::{CommandFactory, Parser};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{IsTerminal, Read, Write},
    path::{Path, PathBuf},
    process::Command,
};
use ymb_core::{Diagnostic, Result, layout, paths};
use ymb_sdk::distribution::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub id: String,
    pub url: String,
    pub dependencies: Vec<Dependency>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Installer {
    pub project: Project,
    pub version: String,
}

#[derive(Parser)]
#[command(name = "deploy", infer_long_args = true, disable_help_flag = true)]
struct Options {
    #[arg(long)]
    game: Option<PathBuf>,
    #[arg(long)]
    builder: Option<PathBuf>,
    #[arg(long)]
    project: Vec<PathBuf>,
    #[arg(long)]
    with: Vec<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long)]
    try_latest_ymb: bool,
    #[arg(long)]
    preserve_user_data: bool,
    #[arg(long, short = 'V')]
    version: bool,
    #[arg(long, short = 'h')]
    help: bool,
}

impl Installer {
    pub fn from_config(name: &str, config: &ModConfig) -> Result<Self> {
        paths::identifier(name)?;
        paths::identifier(&config.id)?;
        config::validate_release(config, Path::new("config/ymb.mod.yaml"))?;
        Ok(Self {
            project: Project {
                name: name.into(),
                id: config.id.clone(),
                url: config.release.url.clone().unwrap_or_default(),
                dependencies: config.dependencies.clone(),
            },
            version: config.release.version.clone(),
        })
    }
}

fn unpack_project(archive: &Path, unpacked: &Path) -> Result<(Installer, PathBuf)> {
    extract(archive, unpacked)?;
    let mut roots = fs::read_dir(unpacked).map_err(|e| Diagnostic::io(unpacked, e))?;
    let root = roots
        .next()
        .transpose()
        .map_err(|e| Diagnostic::io(unpacked, e))?
        .ok_or_else(|| {
            error(crate::messages::text(
                "deploy.mod.read_archive.the_mod_archive_is_empty",
            ))
        })?
        .path();
    if roots.next().is_some() || !root.is_dir() {
        return Err(error(crate::messages::text(
            "deploy.mod.read_archive.a_mod_archive_must_contain_one_project",
        )));
    }
    verify_package(&root, "package-manifest.json")?;
    let (config, _): (ModConfig, _) = config::load(&root.join("config/ymb.mod.yaml"))?;
    let installer = Installer::from_config(&root.file_name().unwrap().to_string_lossy(), &config)?;
    Ok((installer, root))
}

fn confirm(items: &[String], yes: bool) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        return Err(error(crate::messages::text(
            "deploy.mod.confirm.confirmation_requires_a_terminal_use_yes_to",
        )));
    }
    crate::ui::confirm(items)
}

fn builder_executable(builder: &Path) -> PathBuf {
    let path = builder.join(layout::EXECUTABLE);
    if path.is_file() {
        path
    } else {
        builder.join("dist/YMB.exe")
    }
}

fn project_command<'a>(
    builder: &Path,
    action: &str,
    options: &[&str],
    projects: impl IntoIterator<Item = &'a Project>,
) -> Command {
    let mut command = Command::new(builder_executable(builder));
    command
        .arg(action)
        .arg("--ymb-path")
        .arg(builder)
        .args(options);
    for project in projects {
        command.arg("--mod").arg(&project.id);
    }
    command
}
fn builder_lock_root(builder: &Path) -> PathBuf {
    let modern = builder.join("dist/YMB.exe").is_file()
        || paths::read_limited(&builder.join("release-manifest.json"), 64 << 20)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|manifest| {
                manifest["files"].as_object().is_some_and(|files| {
                    files.contains_key(layout::EXECUTABLE)
                        && files.contains_key(&format!("{}/Cargo.toml", layout::SDK))
                })
            });
    builder.join(if modern {
        ".ymb/lock"
    } else {
        ".ymb-operation-lock"
    })
}

pub fn placement(root: &Path, projects: &[Project]) -> Result<()> {
    for ancestor in root.ancestors() {
        paths::assert_no_links(ancestor, ancestor)?;
    }
    if root
        .parent()
        .and_then(Path::file_name)
        .is_none_or(|name| !name.eq_ignore_ascii_case("Mods"))
        || !root.join("GameData").is_dir()
        || !root.join("CommonData").is_dir()
        || !root.join("GenerateMod.bat").is_file()
    {
        return Err(error(crate::messages::text(
            "deploy.mod.placement.save_the_installer_in_a_warno_mod",
        )));
    }
    let mods = root.join("YMB/mods");
    let mut roots = vec![root.to_path_buf(), root.join("YMB")];
    roots.extend(projects.iter().map(|project| mods.join(&project.name)));
    if mods.is_dir() {
        for entry in fs::read_dir(&mods).map_err(|cause| Diagnostic::io(&mods, cause))? {
            roots.push(entry.map_err(|cause| Diagnostic::io(&mods, cause))?.path());
        }
    }
    for path in roots {
        if path.join(".git").exists() {
            return Err(error(crate::messages::format(
                "deploy.mod.placement.arg0_is_a_git_checkout_update_it",
                &[("ARG0", format!("{}", path.display()))],
            )));
        }
    }
    if root.join("YMB/Cargo.toml").is_file()
        && ["YMB/src/ymb/src/main.rs", "YMB/crates/ymb/src/main.rs"]
            .iter()
            .any(|path| root.join(path).is_file())
    {
        return Err(error(crate::messages::text(
            "deploy.mod.placement.ymb_contains_builder_source_keep_this_checkout",
        )));
    }
    if [
        "YMB/.ymb/transaction",
        "YMB/.ymb-state-transaction",
        ".ysm-install/before",
        ".ysm-install-next",
    ]
    .iter()
    .any(|path| root.join(path).exists())
    {
        return Err(error(crate::messages::text(
            "deploy.mod.placement.a_previous_operation_is_pending_finish_recovery",
        )));
    }
    Ok(())
}

pub fn main(installer: Installer) {
    crate::ui::configure(false, false);
    let args: Vec<_> = std::env::args_os().collect();
    let informational = crate::arguments::flag_requested(Options::command(), &args, "help")
        || crate::arguments::flag_requested(Options::command(), &args, "version");
    let started = std::time::Instant::now();
    if !informational {
        eprint!(
            "{}",
            crate::ui::Ui::stderr().title(&crate::messages::format(
                "deploy.mod.main.deploy_arg0_arg1",
                &[
                    ("ARG0", installer.project.name.to_string()),
                    ("ARG1", installer.version.to_string())
                ]
            ))
        );
    }
    let result = run(installer);
    if let Err(error) = &result {
        eprint!("{}", crate::ui::Ui::stderr().error(error, true));
    }
    if !informational {
        eprint!(
            "{}",
            crate::ui::Ui::stderr().label(
                crate::messages::text("common.shared.elapsed"),
                &crate::ui::elapsed(started.elapsed())
            )
        );
    }
    if std::io::stdin().is_terminal()
        && !informational
        && !crate::arguments::flag_requested(Options::command(), &args, "yes")
    {
        let _ = crate::ui::wait(crate::messages::text(
            "deploy.mod.main.press_enter_to_close",
        ));
    }
    if let Err(error) = result {
        std::process::exit(if error.category == "CommandError" {
            2
        } else {
            1
        });
    }
}

fn dependency_choice(dependency: &Dependency, yes: bool, selected: &[String]) -> Result<bool> {
    let source = config::download_source(&dependency.url)?;
    if dependency.required
        || selected
            .iter()
            .any(|value| value.eq_ignore_ascii_case(source.name()) || value == &dependency.url)
    {
        return Ok(true);
    }
    if yes {
        return Ok(false);
    }
    if !std::io::stdin().is_terminal() {
        return Err(error(crate::messages::text(
            "deploy.mod.dependency_choice.optional_dependency_choices_need_a_terminal_use",
        )));
    }
    let reason = dependency
        .reason
        .as_ref()
        .map(|text| format!(" {text}"))
        .unwrap_or_default();
    Ok(crate::ui::accepted(&prompt(&crate::messages::format(
        "deploy.mod.dependency_choice.also_install_arg0_reason_y_n",
        &[
            ("ARG0", source.name().to_string()),
            ("REASON", reason.to_string()),
        ],
    ))?))
}

fn run(installer: Installer) -> Result<()> {
    let primary = installer.project.clone();
    config::download_source(&primary.url)?;
    let args: Vec<_> = std::env::args_os().collect();
    let options = Options::try_parse_from(&args)
        .map_err(|error| crate::arguments::diagnostic(&error, Options::command(), &args))?;
    if options.version {
        println!("{} {}", primary.name, installer.version);
        return Ok(());
    }
    if options.help {
        println!(
            "{}",
            crate::messages::format(
                "deploy.mod.run.save_deploy_arg0_exe_beside_gamedata_commondata",
                &[("ARG0", primary.name.to_string())]
            )
        );
        for dependency in &primary.dependencies {
            println!(
                "{}: {}{}",
                config::download_source(&dependency.url)?.name(),
                if dependency.required {
                    crate::messages::text("deploy.mod.run.required")
                } else {
                    crate::messages::text("deploy.mod.run.optional")
                },
                dependency
                    .reason
                    .as_ref()
                    .map(|text| format!("; {text}"))
                    .unwrap_or_default()
            );
        }
        return Ok(());
    }
    let Options {
        game,
        builder,
        project: projects,
        with: selected_options,
        yes,
        preserve_user_data,
        try_latest_ymb: try_latest,
        ..
    } = options;
    if builder.is_some() != !projects.is_empty() {
        return Err(error(crate::messages::text(
            "deploy.mod.run.offline_installation_needs_builder_and_project_zips",
        )));
    }
    let root = paths::absolute(
        &game.unwrap_or(
            std::env::current_exe()
                .map_err(|error| Diagnostic::io(Path::new("installer"), error))?
                .parent()
                .unwrap()
                .to_path_buf(),
        ),
    )?;
    placement(&root, std::slice::from_ref(&primary))?;
    let mut choices = HashMap::new();
    let mut planned = Vec::new();
    for dependency in &primary.dependencies {
        let include = dependency_choice(dependency, yes, &selected_options)?;
        choices.insert(dependency.url.clone(), include);
        if include {
            planned.push(config::download_source(&dependency.url)?.name().to_owned());
        }
    }
    planned.push(primary.name.clone());
    let mut confirmations = vec![crate::messages::format(
        "deploy.mod.run.install_and_sync_arg0_in_arg1",
        &[
            ("ARG0", planned.join(", ").to_string()),
            ("ARG1", format!("{}", root.display())),
        ],
    )];
    let work = root.join(".ymb-install");
    let confirmed_update = root.join("YMB").exists() || work.join("before").exists();
    if confirmed_update {
        confirmations.push(
            crate::messages::text(
                "deploy.mod.run.restore_all_tracked_live_files_including_external",
            )
            .into(),
        );
        confirmations.push(if preserve_user_data {
            crate::messages::text(
                "deploy.mod.run.replace_ymb_preserve_compatible_settings_and_declared",
            )
            .into()
        } else {
            crate::messages::text("deploy.mod.run.replace_the_entire_ymb_folder_including_settings")
                .into()
        });
    }
    if !confirm(&confirmations, yes)? {
        print!(
            "{}",
            crate::ui::Ui::stdout().block(
                "  [I2] ",
                crate::messages::text("deploy.mod.run.deployment_cancelled_no_work_started"),
                crate::ui::Tone::Muted
            )
        );
        return Ok(());
    }
    ui::phase(crate::messages::text("deploy.mod.run.check_interrupted_installation").into());
    paths::assert_no_links(&root, &work)?;
    if work.exists()
        && paths::read_limited(&work.join("owner"), 64).ok().as_deref()
            != Some(b"YMB mod installer\n")
    {
        return Err(error(crate::messages::text(
            "deploy.mod.run.ymb_install_exists_without_its_installer_marker",
        )));
    }
    fs::create_dir_all(&work).map_err(|error| Diagnostic::io(&work, error))?;
    paths::write_atomic(&work.join("owner"), "YMB mod installer\n")?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(work.join("lock"))
        .map_err(|error| Diagnostic::io(&work, error))?;
    lock.try_lock().map_err(|_| {
        error(crate::messages::text(
            "deploy.mod.run.another_mod_installer_is_running_in_this",
        ))
    })?;
    recover(&root, &work)?;
    let updating = root.join("YMB").exists();
    if updating && !confirmed_update {
        return Err(error(crate::messages::text(
            "deploy.mod.run.installation_appeared",
        )));
    }
    let project_work = work.join("projects");
    remove(&work, &project_work)?;
    let interactive = std::io::stdin().is_terminal();
    let mut offline = Vec::new();
    if !projects.is_empty() {
        let _input = platform::InputBlock::new(interactive);
        let _progress = Progress::start(vec![
            crate::messages::text("deploy.mod.run.check_local_archives").into(),
        ]);
        for (index, archive) in projects.iter().enumerate() {
            let archive = local_archive(archive)?;
            offline.push(unpack_project(
                &archive,
                &project_work.join(format!("offline-{index}")),
            )?);
        }
    }
    let mut recognized = HashSet::new();
    let mut choose = |dependency: &Dependency| -> Result<bool> {
        let source = config::download_source(&dependency.url)?;
        for option in &selected_options {
            if option.eq_ignore_ascii_case(source.name()) || option == &dependency.url {
                recognized.insert(option.clone());
            }
        }
        if let Some(include) = choices.get(&dependency.url) {
            return Ok(*include);
        }
        let include = dependency_choice(dependency, yes, &selected_options)?;
        choices.insert(dependency.url.clone(), include);
        Ok(include)
    };
    let mut fetch = |url: &str| -> Result<(Installer, PathBuf)> {
        let source = config::download_source(url)?;
        if builder.is_some() {
            let exact: Vec<_> = offline
                .iter()
                .filter(|(metadata, _)| metadata.project.url == url)
                .collect();
            let found: Vec<_> = if exact.is_empty() {
                offline
                    .iter()
                    .filter(|(metadata, _)| {
                        metadata.project.name.eq_ignore_ascii_case(source.name())
                    })
                    .collect()
            } else {
                exact
            };
            if found.len() != 1 {
                return Err(error(crate::messages::format(
                    "deploy.mod.run.provide_one_project_zip_for_arg0",
                    &[("ARG0", source.name().to_string())],
                )));
            }
            return Ok(found[0].clone());
        }
        let key = ymb_core::hash(url);
        let archive = work.join(format!("project-{key}.zip"));
        let _input = platform::InputBlock::new(interactive);
        let _progress = Progress::start(vec![crate::messages::format(
            "deploy.mod.run.download_project",
            &[("NAME", source.name().into())],
        )]);
        project_asset(url, &archive)?;
        unpack_project(&archive, &project_work.join(key))
    };
    let packages = dependencies::resolve(&primary.url, &mut fetch, &mut choose)?;
    if selected_options
        .iter()
        .any(|option| !recognized.contains(option))
    {
        return Err(error(crate::messages::text(
            "deploy.mod.run.unknown_optional_dependency_in_with_use_help",
        )));
    }
    if builder.is_some() && packages.len() != offline.len() {
        return Err(error(crate::messages::text(
            "deploy.mod.run.provide_project_zips_only_for_selected_projects",
        )));
    }
    if packages
        .last()
        .is_none_or(|(project, _)| project.id != primary.id || project.name != primary.name)
    {
        return Err(error(crate::messages::text(
            "deploy.mod.run.the_download_link_returned_a_different_primary",
        )));
    }
    let selected: Vec<_> = packages
        .iter()
        .map(|(project, _)| project.clone())
        .collect();
    placement(&root, &selected)?;
    let (builder, unsupported) = if let Some(builder) = builder {
        let _progress = Progress::start(vec![
            crate::messages::text("deploy.mod.run.check_local_builder").into(),
        ]);
        (local_archive(&builder)?, try_latest)
    } else {
        let archive = work.join("builder.zip");
        let Some(unsupported) =
            builder_asset(&requirements(&packages)?, &work, &archive, try_latest)?
        else {
            drop(lock);
            remove(&root, &work)?;
            print!(
                "{}",
                crate::ui::Ui::stdout().block(
                    "  [I2] ",
                    crate::messages::text(
                        "deploy.mod.run.deployment_cancelled_the_installation_is_unchanged"
                    ),
                    crate::ui::Tone::Muted
                )
            );
            return Ok(());
        };
        (archive, unsupported)
    };
    let _input = platform::InputBlock::new(interactive);
    let mut steps = vec![crate::messages::text("deploy.mod.run.prepare_installation").into()];
    if updating {
        steps.push(crate::messages::text("deploy.mod.run.restore_saved_files").into());
    }
    steps.extend([
        crate::messages::text("deploy.mod.run.check_project_build").into(),
        crate::messages::text("deploy.mod.run.save_installation").into(),
        crate::messages::text("deploy.mod.run.apply_projects").into(),
    ]);
    let check_step = 1 + usize::from(updating);
    let progress = Progress::start(steps);
    let next = stage(&root, &work, &builder, &packages, unsupported)?;
    stage::carry_engine(&root.join("YMB"), &next)?;
    if preserve_user_data && updating {
        let _lock = BuilderLock::acquire(&root.join("YMB"))?;
        stage::carry_user_data(&root.join("YMB"), &next, &selected)?;
        if unsupported {
            stage::allow_builder_version(&next, &packages)?;
        }
        execute(&mut project_command(&next, "list", &[], &selected)).map_err(|mut error| {
            error.reason = crate::messages::text(
                "deploy.mod.run.preserved_configuration_was_rejected_before_recovery_the",
            )
            .into();
            error
        })?;
    }
    let mut old_lock = if updating {
        ui::step(1);
        Some(stage::restore_live(&root)?)
    } else {
        None
    };
    ui::step(check_step);
    execute(&mut project_command(&next, "validate", &[], &selected)).map_err(|mut error| {
        ui::failed_step(check_step);
        error.reason = crate::messages::text(if updating {
            "deploy.mod.run.update_build_failed"
        } else {
            "deploy.mod.run.fresh_build_failed"
        })
        .into();
        error
    })?;
    ui::step(check_step + 1);
    install(&root, &work, &next, &mut old_lock)?;
    ui::step(check_step + 2);
    let applied = execute(&mut project_command(
        &root.join("YMB"),
        "sync",
        &["--yes"],
        &selected,
    ))
    .map_err(|mut error| {
        ui::failed_step(check_step + 2);
        error.reason =
            crate::messages::text("deploy.mod.run.the_projects_are_installed_but_applying_stopped")
                .into();
        error
    })?;
    drop(lock);
    remove(&root, &work)?;
    drop(progress);
    let ui = crate::ui::Ui::stdout();
    print!("{}", String::from_utf8_lossy(&applied));
    for (label, text) in [
        (
            crate::messages::text("deploy.mod.run.edit"),
            crate::messages::text("deploy.mod.run.change_ymb_ymb_config_yaml_or_your"),
        ),
        (
            crate::messages::text("deploy.mod.run.docs"),
            "YMB/docs/README.md",
        ),
        (
            crate::messages::text("deploy.mod.run.help"),
            "https://discord.gg/33Sqn6dTjf",
        ),
    ] {
        print!("{}", ui.label(label, text));
    }
    let guide = format!("YMB/mods/{}/GUIDE.md", primary.name);
    if root.join(&guide).is_file() {
        print!(
            "{}",
            ui.label(crate::messages::text("deploy.mod.run.guide"), &guide)
        );
    }
    Ok(())
}

mod dependencies;
mod download;
mod lock;
pub mod payload;
mod stage;
mod transaction;
use download::*;
use lock::*;
use stage::stage;
use transaction::install;
pub use transaction::recover;
#[cfg(test)]
mod tests;
