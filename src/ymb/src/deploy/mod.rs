use crate::config::{self, Dependency, ModConfig};
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
    #[arg(long, hide = true)]
    apply: bool,
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

pub fn read_archive(archive: &Path, work: &Path) -> Result<Installer> {
    with_work(work, "metadata", |unpacked| {
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
        Installer::from_config(&root.file_name().unwrap().to_string_lossy(), &config)
    })
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
use crate::ui::prompt;

fn builder_executable(builder: &Path) -> PathBuf {
    let path = builder.join(layout::EXECUTABLE);
    if path.is_file() {
        path
    } else {
        builder.join("dist/YMB.exe")
    }
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
    crate::ui::configure(false);
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
    if root.join("YMB").exists() {
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
    let work = root.join(".ymb-install");
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
    let offline = projects
        .iter()
        .map(|archive| {
            let archive = local_archive(archive)?;
            Ok((read_archive(&archive, &work)?, archive))
        })
        .collect::<Result<Vec<_>>>()?;
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
        let archive = work.join(format!("project-{}.zip", &ymb_core::hash(url)[..16]));
        project_asset(url, &archive)?;
        Ok((read_archive(&archive, &work)?, archive))
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
    crate::ui::phase(
        crate::messages::text("deploy.mod.run.checking_and_staging_the_update").into(),
    );
    let next = stage(&root, &work, &builder, &packages, unsupported)?;
    stage::carry_engine(&root.join("YMB"), &next)?;
    if preserve_user_data && root.join("YMB").exists() {
        let _lock = BuilderLock::acquire(&root.join("YMB"))?;
        stage::carry_user_data(&root.join("YMB"), &next, &selected)?;
        if unsupported {
            stage::allow_builder_version(&next, &packages)?;
        }
        let mut command = Command::new(builder_executable(&next));
        command
            .arg("list")
            .arg("--ymb-path")
            .arg(&next)
            .args(["--require-all", "--json"]);
        for project in &selected {
            command.arg("--mod").arg(&project.id);
        }
        execute(&mut command).map_err(|error| {
            error.detail(crate::messages::text(
                "deploy.mod.run.preserved_configuration_was_rejected_before_recovery_the",
            ))
        })?;
    }
    let mut old_lock = if root.join("YMB").exists() {
        crate::ui::phase(
            crate::messages::text("deploy.mod.run.restoring_all_live_files_from_ymb_s").into(),
        );
        Some(stage::restore_live(&root)?)
    } else {
        None
    };
    if preserve_user_data && old_lock.is_some() {
        let mut command = Command::new(builder_executable(&next));
        command
            .arg("validate")
            .arg("--ymb-path")
            .arg(&next)
            .args(["--require-all", "--json"]);
        for project in &selected {
            command.arg("--mod").arg(&project.id);
        }
        execute(&mut command).map_err(|error| {
            error.detail(crate::messages::text(
                "deploy.mod.run.preserved_settings_or_identities_are_incompatible_the",
            ))
        })?;
    }
    install(&root, &work, &next, &mut old_lock)?;
    {
        let mut command = Command::new(builder_executable(&root.join("YMB")));
        command
            .arg("sync")
            .arg("--ymb-path")
            .arg(root.join("YMB"))
            .arg("--yes");
        for project in &selected {
            command.arg("--mod").arg(&project.id);
        }
        let status = command
            .status()
            .map_err(|error| Diagnostic::io(Path::new("YMB"), error))?;
        if !status.success() {
            return Err(error(crate::messages::text(
                "deploy.mod.run.the_projects_are_installed_but_applying_stopped",
            )));
        }
    }
    drop(lock);
    remove(&root, &work)?;
    let ui = crate::ui::Ui::stdout();
    print!(
        "{}",
        ui.report(
            &json!({"summary":crate::messages::format("deploy.mod.run.installed_and_synced_arg0", &[("ARG0", primary.name.to_string())])}),
            false
        )
    );
    for (label, text) in [
        (
            crate::messages::text("common.shared.next"),
            crate::messages::text("deploy.mod.run.run_generatemod_bat_in_this_warno_mod"),
        ),
        (
            crate::messages::text("deploy.mod.run.edit"),
            crate::messages::text("deploy.mod.run.change_ymb_ymb_config_yaml_or_your"),
        ),
        (
            crate::messages::text("deploy.mod.run.docs"),
            "YMB/docs/README.md",
        ),
        (
            crate::messages::text("deploy.mod.run.online_docs"),
            "https://github.com/Yokaiste/YMB/blob/master/docs/README.md",
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
pub use stage::stage;
use transaction::install;
pub use transaction::recover;
#[cfg(test)]
mod tests;
