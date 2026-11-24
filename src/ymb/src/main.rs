mod commands;
mod deploy;
use ymb::{arguments, config, diagnostics, messages, platform, ui};
mod engine;
mod init;
mod plan;
mod plugin;
mod release;
mod rust;
mod state;
mod store;
use clap::{CommandFactory, Parser, Subcommand};
use serde_json::{Value, json};
use std::{io::IsTerminal, path::PathBuf, time::Instant};
use ymb_core::{Diagnostic, Result, metadata};
const BUILD_ID: &str = include!(concat!(env!("OUT_DIR"), "/build-id.rs"));

#[cfg(test)]
#[allow(dead_code)]
#[path = "../../core/build.rs"]
mod build_metadata;

#[derive(Clone, Parser)]
#[command(name="ymb",version=metadata::VERSION,about=crate::messages::text("main.shared.build_and_manage_your_warno_mod"),infer_subcommands=true,infer_long_args=true,next_line_help=false,after_help=crate::messages::text("main.shared.open_the_menu_ymb_exe_start_a"))]
struct Cli {
    #[arg(help = crate::messages::text("main.shared.option_json"))]
    #[arg(long, global = true)]
    json: bool,
    #[arg(help = crate::messages::text("main.shared.option_ymb_path"))]
    #[arg(long, global = true, value_name = "PATH")]
    ymb_path: Option<PathBuf>,
    #[arg(help = crate::messages::text("main.shared.option_scope"))]
    #[arg(long,global=true,default_value="prod",value_parser=["prod","dev"],hide_possible_values=true)]
    scope: String,
    #[arg(help = crate::messages::text("main.shared.option_mods"))]
    #[arg(long = "mod", global = true, value_name = "ID_OR_NAME")]
    mods: Vec<String>,
    #[arg(help = crate::messages::text("main.shared.option_patches"))]
    #[arg(long = "patch", global = true, value_name = "ID_OR_NAME")]
    patches: Vec<String>,
    #[arg(help = crate::messages::text("main.shared.option_verbose"))]
    #[arg(long, global = true)]
    verbose: bool,
    #[arg(help = crate::messages::text("main.shared.option_dry_run"))]
    #[arg(long, global = true)]
    dry_run: bool,
    #[arg(help = crate::messages::text("main.shared.option_no_cache"))]
    #[arg(long, global = true)]
    no_cache: bool,
    #[arg(help = crate::messages::text("main.shared.option_require_all"))]
    #[arg(long, global = true)]
    require_all: bool,
    #[arg(help = crate::messages::text("main.shared.option_reset_changed"))]
    #[arg(long, global = true, conflicts_with = "dry_run")]
    reset_changed: bool,
    #[arg(help = crate::messages::text("main.shared.option_yes"))]
    #[arg(long, global = true)]
    yes: bool,
    #[arg(help = crate::messages::text("main.shared.option_install_rust"))]
    #[arg(long, global = true)]
    install_rust: bool,
    #[command(subcommand)]
    command: Option<Action>,
}
#[derive(Clone, Subcommand)]
enum Action {
    #[command(about = crate::messages::text("main.shared.action_installrust"))]
    InstallRust,
    #[command(about = crate::messages::text("main.shared.action_init"))]
    Init {
        #[arg(help = crate::messages::text("main.shared.init_example"))]
        #[arg(long)]
        example: Option<String>,
        #[arg(help = crate::messages::text("main.shared.init_id"))]
        #[arg(long)]
        id: Option<String>,
        #[arg(help = crate::messages::text("main.shared.init_name"))]
        #[arg(long)]
        name: Option<String>,
        #[arg(help = crate::messages::text("main.shared.init_description"))]
        #[arg(long, default_value = "")]
        description: String,
    },
    #[command(about = crate::messages::text("main.shared.action_doctor"))]
    Doctor,
    #[command(about = crate::messages::text("main.shared.action_list"))]
    List,
    #[command(about = crate::messages::text("main.shared.action_explain"))]
    Explain,
    #[command(about = crate::messages::text("main.shared.action_find"))]
    Find {
        #[arg(help = crate::messages::text("main.shared.find_files"))]
        #[arg(long = "file")]
        files: Vec<String>,
        #[arg(help = crate::messages::text("main.shared.find_name"))]
        #[arg(long)]
        name: Option<String>,
        #[arg(help = crate::messages::text("main.shared.find_type_name"))]
        #[arg(long = "type")]
        type_name: Option<String>,
        #[arg(help = crate::messages::text("main.shared.find_field"))]
        #[arg(long)]
        field: Option<String>,
        #[arg(help = crate::messages::text("main.shared.find_limit"))]
        #[arg(long,default_value="50",value_parser=positive)]
        limit: usize,
    },
    #[command(about = crate::messages::text("main.shared.action_validate"))]
    Validate,
    #[command(about = crate::messages::text("main.shared.action_build"))]
    Build,
    #[command(about = crate::messages::text("main.shared.action_release"))]
    Release,
    #[command(about = crate::messages::text("main.shared.action_sync"))]
    Sync,
    #[command(about = crate::messages::text("main.shared.action_recover"))]
    Recover,
    #[command(about = crate::messages::text("main.shared.action_cleanup"))]
    Cleanup {
        #[arg(help = crate::messages::text("main.shared.cleanup_all"))]
        #[arg(long)]
        all: bool,
    },
}
fn positive(value: &str) -> std::result::Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| crate::messages::text("main.positive.expected_a_positive_integer").into())
}
impl Action {
    fn name(&self) -> &'static str {
        match self {
            Self::InstallRust => "install-rust",
            Self::Init { .. } => "init",
            Self::Doctor => "doctor",
            Self::List => "list",
            Self::Explain => "explain",
            Self::Find { .. } => "find",
            Self::Validate => "validate",
            Self::Build => "build",
            Self::Release => "release",
            Self::Sync => "sync",
            Self::Recover => "recover",
            Self::Cleanup { .. } => "cleanup",
        }
    }
}

fn check_cli(cli: Cli) -> std::result::Result<Cli, clap::Error> {
    // Clap checks conflicts before propagating global values across subcommands.
    if cli.dry_run && cli.reset_changed {
        return Err(Cli::command().error(
            clap::error::ErrorKind::ArgumentConflict,
            crate::messages::text("main.check_cli.reset_changed_cannot_be_used_with_dry"),
        ));
    }
    Ok(cli)
}

fn main() {
    match std::env::current_exe()
        .map_err(|error| error.to_string())
        .and_then(|path| deploy::payload::read(&path).map_err(|error| error.to_string()))
    {
        Ok(Some(installer)) => {
            deploy::main(installer);
            return;
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    let started = Instant::now();
    let args: Vec<_> = std::env::args_os().collect();
    let wants_json = arguments::flag_requested(Cli::command(), &args, "json");
    ui::configure(wants_json, false);
    let cli = match Cli::try_parse_from(&args).and_then(check_cli) {
        Ok(cli) => cli,
        Err(error) => {
            let help = matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            );
            let code = if help { 0 } else { 2 };
            let diagnostic = arguments::diagnostic(&error, Cli::command(), &args);
            if wants_json {
                let mut value = envelope(if help { "help" } else { "parse" });
                value["status"] = json!(if help { "ok" } else { "error" });
                value["text"] = json!(error.to_string());
                if !help {
                    value["errors"] = json!([diagnostic]);
                } else {
                    value["data"] = json!({"notices":[{"code":"I8","reason":crate::messages::text("main.main.command_help_requested")}]});
                }
                if matches!(error.kind(), clap::error::ErrorKind::DisplayVersion) {
                    value["command"] = json!("version");
                    value["data"] = json!({"notices":[{"code":"I9","reason":crate::messages::text("main.main.version_requested")}]});
                }
                diagnostics::attach(&mut value);
                println!("{}", serde_json::to_string(&value).unwrap());
            } else {
                if help {
                    if matches!(error.kind(), clap::error::ErrorKind::DisplayVersion) {
                        eprint!("  [I9] {error}");
                    } else {
                        eprint!("{}", ui::help(&error.to_string()));
                    }
                } else {
                    eprint!(
                        "{}",
                        ui::Ui::stderr().error(
                            &diagnostic,
                            arguments::flag_requested(Cli::command(), &args, "verbose")
                        )
                    );
                }
            }
            std::process::exit(code);
        }
    };
    ui::configure(cli.json, cli.verbose);
    if cli.command.is_none()
        && !cli.install_rust
        && !cli.json
        && std::io::stdin().is_terminal()
        && std::io::stderr().is_terminal()
    {
        if let Err(error) = menu(&cli) {
            eprint!("{}", ui::Ui::stderr().error(&error, cli.verbose));
            std::process::exit(1);
        }
        return;
    }
    let install_action = Action::InstallRust;
    let Some(action) = cli
        .command
        .as_ref()
        .or(cli.install_rust.then_some(&install_action))
    else {
        let help = Cli::command().render_help().to_string();
        if cli.json {
            let mut value = envelope("help");
            value["text"] = json!(help);
            value["status"] = json!("ok");
            value["data"] = json!({"notices":[{"code":"I8","reason":crate::messages::text("main.main.command_help_requested")}]});
            diagnostics::attach(&mut value);
            println!("{value}");
        } else {
            print!("{}", ui::help(&help));
        }
        return;
    };
    let command = action.name();
    let interactive =
        !cli.json && std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
    if !cli.json {
        eprint!("{}", ui::Ui::stderr().banner(command));
    }
    let report = execute(&cli, action, interactive, started);
    print_report(&report, &cli);
    if report["status"] == "error" {
        std::process::exit(1);
    }
}

fn selection(cli: &Cli, interactive: bool) -> plan::Selection {
    plan::Selection {
        scope: cli.scope.clone(),
        mod_filters: cli.mods.clone(),
        patch_filters: cli.patches.clone(),
        dry_run: cli.dry_run,
        verbose: cli.verbose,
        use_cache: !cli.no_cache,
        require_all: cli.require_all,
        reset_changed: cli.reset_changed,
        yes: cli.yes,
        interactive,
    }
}

fn execute(cli: &Cli, action: &Action, interactive: bool, started: Instant) -> Value {
    let selection = selection(cli, interactive);
    let result = run(cli, action, selection.clone(), interactive);
    let mut report = envelope(action.name());
    report["durationMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    report["selection"] = serde_json::to_value(selection).unwrap();
    match result {
        Ok(value) => {
            report["status"] = json!("ok");
            report["data"] = value;
        }
        Err(error) => {
            report["status"] = json!("error");
            report["errors"] = if error.related.is_empty() {
                json!([error])
            } else {
                json!(error.related)
            };
        }
    }
    diagnostics::attach(&mut report);
    report
}

fn print_report(report: &Value, cli: &Cli) {
    if cli.json {
        println!("{report}");
        return;
    }
    let ui = ui::Ui::stderr();
    if report["status"] == "ok" {
        print!("{}", ui::Ui::stdout().report(&report["data"], cli.verbose));
    } else {
        let errors = report["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|error| serde_json::from_value::<Diagnostic>(error.clone()).unwrap())
            .collect::<Vec<_>>();
        if errors.len() == 1 {
            eprint!("{}", ui.error(&errors[0], cli.verbose));
        } else {
            eprint!("{}", ui.errors(&errors, cli.verbose));
        }
    }
    let elapsed =
        std::time::Duration::from_secs_f64(report["durationMs"].as_f64().unwrap_or(0.0) / 1000.0);
    eprint!(
        "{}",
        ui.label(
            crate::messages::text("common.shared.elapsed"),
            &ui::elapsed(elapsed)
        )
    );
}
fn envelope(command: &str) -> Value {
    json!({"schemaVersion":metadata::JSON_VERSION,"ymbVersion":metadata::VERSION,"command":command,"formats":{"config":metadata::CONFIG_VERSION,"plugin":metadata::PLUGIN_VERSION,"cache":metadata::CACHE_VERSION,"state":metadata::STATE_VERSION,"journal":metadata::JOURNAL_VERSION},"sourceCompilerRequirement":metadata::RUST_VERSION})
}
fn run(
    cli: &Cli,
    action: &Action,
    mut selection: plan::Selection,
    interactive: bool,
) -> Result<Value> {
    let mut installed = false;
    loop {
        let result = run_once(cli, action, selection.clone(), interactive);
        let Err(error) = result else {
            return result;
        };
        if error.code.as_deref() != Some("E38") {
            return Err(error);
        }
        // A paused interactive sync has already passed its confirmation.
        if interactive && matches!(action, Action::Sync) {
            selection.yes = true;
        }
        let minimum = error
            .context
            .get("requiredVersion")
            .and_then(Value::as_str)
            .unwrap_or(metadata::RUST_VERSION);
        let context = config::Context::resolve_recovery(cli.ymb_path.as_deref())?;
        if cli.install_rust && !installed {
            rust::install(&context, minimum)?;
            installed = true;
        } else if interactive && !cli.install_rust {
            rust::setup(&context, minimum)?;
        } else {
            return Err(error);
        }
    }
}

fn run_once(
    cli: &Cli,
    action: &Action,
    selection: plan::Selection,
    interactive: bool,
) -> Result<Value> {
    if cli.dry_run && matches!(action, Action::Init { .. } | Action::InstallRust) {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::format(
                "main.run_once.arg0_does_not_support_dry_run",
                &[("ARG0", action.name().to_string())],
            ),
            crate::messages::text("main.run_once.run_the_command_without_dry_run_when"),
        ));
    }
    let context = if matches!(action, Action::Release) {
        config::Context::resolve_release(cli.ymb_path.as_deref())?
    } else if matches!(
        action,
        Action::Recover | Action::Doctor | Action::InstallRust
    ) {
        config::Context::resolve_recovery(cli.ymb_path.as_deref())?
    } else {
        config::Context::resolve(cli.ymb_path.as_deref())?
    };
    let needs_yes = matches!(
        action,
        Action::Sync | Action::Recover | Action::Cleanup { .. }
    ) && !selection.dry_run;
    if needs_yes && !selection.yes && !interactive {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("main.run_once.this_command_needs_yes_in_a_noninteractive"),
            crate::messages::text("main.run_once.review_a_dry_run_first_then_repeat"),
        ));
    }
    if needs_yes
        && !selection.yes
        && !ui::confirm(&confirmation_items(&context, action, &selection))?
    {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::format(
                "main.run_once.arg0_cancelled_no_work_started",
                &[("ARG0", action.name().to_string())],
            ),
            crate::messages::text("main.run_once.run_the_command_again_when_ready"),
        )
        .code("I2"));
    }
    let _input = platform::InputBlock::new(
        interactive && !matches!(action, Action::Init { .. } | Action::InstallRust),
    );
    match action {
        Action::InstallRust => {
            if interactive && !cli.install_rust {
                let toolchain = rust::check_or_setup(&context, metadata::RUST_VERSION)?;
                Ok(
                    json!({"summary":crate::messages::text("common.shared.rust_is_ready"),"toolchain":toolchain}),
                )
            } else {
                rust::install(&context, metadata::RUST_VERSION)
            }
        }
        Action::Init {
            example,
            id,
            name,
            description,
        } => {
            let example = init::choose(&context, example.as_deref(), interactive)?;
            let id = match id {
                Some(id) => id.clone(),
                None if interactive => {
                    ui::prompt(crate::messages::text("main.run_once.permanent_project_id"))?
                }
                _ => {
                    return Err(Diagnostic::new(
                        "CommandError",
                        crate::messages::text("main.run_once.init_needs_id"),
                        crate::messages::text("main.run_once.supply_id_and_name"),
                    ));
                }
            };
            let name = match name {
                Some(name) => name.clone(),
                None if interactive => {
                    ui::prompt(crate::messages::text("main.run_once.project_name"))?
                }
                _ => {
                    return Err(Diagnostic::new(
                        "CommandError",
                        crate::messages::text("main.run_once.init_needs_name"),
                        crate::messages::text("main.run_once.supply_id_and_name"),
                    ));
                }
            };
            let _input = platform::InputBlock::new(interactive);
            let _progress = ui::Progress::start(vec![
                crate::messages::text("main.run_once.check_project_destination").into(),
                crate::messages::text("main.run_once.write_the_starter_project").into(),
            ]);
            let _lock = state::OperationLock::acquire(&context, "init")?;
            state::recover_pending(&context)?;
            init::create(&context, &id, &name, description, Some(&example))
        }
        Action::Validate | Action::Build | Action::Sync => {
            commands::build(context, selection, action.name())
        }
        Action::Release => release::run(context, selection),
        Action::Recover => commands::recover(context, selection),
        Action::Doctor | Action::List | Action::Explain => {
            commands::inspect(context, selection, action.name())
        }
        Action::Cleanup { all } => commands::cleanup(context, selection, *all),
        Action::Find {
            files,
            name,
            type_name,
            field,
            limit,
        } => commands::find(
            context,
            selection,
            commands::FindOptions {
                files: files.clone(),
                name: name.clone(),
                type_name: type_name.clone(),
                field: field.clone(),
                limit: *limit,
            },
        ),
    }
}
fn confirmation_items(
    context: &config::Context,
    action: &Action,
    selection: &plan::Selection,
) -> Vec<String> {
    let mut items = match action {
        Action::Sync => vec![
            crate::messages::format(
                "main.confirmation_items.build_this_selection_and_replace_the_preview",
                &[("ARG0", format!("{}", context.output.display()))],
            ),
            crate::messages::format(
                "main.confirmation_items.apply_its_files_and_removals_to_arg0",
                &[("ARG0", format!("{}", context.game.display()))],
            ),
        ],
        Action::Recover => vec![
            crate::messages::format(
                "main.confirmation_items.restore_selected_whole_files_in_arg0_from",
                &[("ARG0", format!("{}", context.game.display()))],
            ),
            crate::messages::text(
                "main.confirmation_items.restore_all_contributions_to_each_selected_file",
            )
            .into(),
        ],
        Action::Cleanup { all } => {
            let mut paths = vec![
                crate::messages::format(
                    "main.confirmation_items.delete_build_work_at_arg0",
                    &[("ARG0", format!("{}", context.work.display()))],
                ),
                crate::messages::format(
                    "main.confirmation_items.delete_result_caches_at_arg0",
                    &[("ARG0", format!("{}", context.cache.display()))],
                ),
                crate::messages::text(
                    "main.confirmation_items.delete_unprotected_temporary_paths_configured_by_the",
                )
                .into(),
            ];
            if *all {
                paths.push(crate::messages::format(
                    "main.confirmation_items.also_delete_unused_recovery_data_at_arg0",
                    &[("ARG0", format!("{}", context.state.display()))],
                ));
            }
            paths
        }
        _ => Vec::new(),
    };
    items.push(crate::messages::format(
        "main.confirmation_items.projects_arg0_patches_arg1_scope_arg2",
        &[
            (
                "ARG0",
                (if selection.mod_filters.is_empty() {
                    "all".into()
                } else {
                    selection.mod_filters.join(", ")
                })
                .to_string(),
            ),
            (
                "ARG1",
                (if selection.patch_filters.is_empty() {
                    "all".into()
                } else {
                    selection.patch_filters.join(", ")
                })
                .to_string(),
            ),
            ("ARG2", selection.scope.to_string()),
        ],
    ));
    if selection.reset_changed && !matches!(action, Action::Cleanup { .. }) {
        items.push(
            crate::messages::text(
                "main.confirmation_items.discard_external_edits_to_tracked_files_when",
            )
            .into(),
        );
    }
    if context.journal.exists() {
        items.push(
            crate::messages::text(
                "main.confirmation_items.finish_rolling_back_the_interrupted_operation_first",
            )
            .into(),
        );
    }
    items
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_commands_do_not_offer_publication_or_upload_options() {
        for action in ["publish", "upload", "push"] {
            assert!(Cli::try_parse_from(["ymb", action]).is_err());
            assert!(Cli::try_parse_from(["ymb", "release", &format!("--{action}")]).is_err());
        }
    }
    #[test]
    fn unsafe_dry_run_combinations_do_not_start_work() {
        assert!(Cli::try_parse_from(["ymb", "recover", "--dry-run", "--reset-changed"]).is_err());
        let cli = Cli::try_parse_from([
            "ymb",
            "init",
            "--id",
            "probe",
            "--name",
            "Probe",
            "--dry-run",
        ])
        .unwrap();
        let error = run(
            &cli,
            cli.command.as_ref().unwrap(),
            plan::Selection::default(),
            false,
        )
        .unwrap_err();
        assert!(error.reason.contains("does not support --dry-run"));
    }
    #[test]
    fn cli_accepts_repeated_filters_and_json_everywhere() {
        for (key, name) in "123456789A".chars().zip([
            "build", "sync", "validate", "recover", "list", "explain", "find", "doctor", "init",
            "cleanup",
        ]) {
            assert_eq!(menu_action(name).unwrap().name(), name);
            assert_eq!(menu_action(&key.to_string()).unwrap().name(), name);
        }
        assert!(menu_action("unknown").is_none());
        let cli = Cli::try_parse_from([
            "ymb", "sync", "--mod", "a", "--mod", "b", "--patch", "p", "--scope", "dev", "--yes",
            "--json",
        ])
        .unwrap();
        assert_eq!(cli.mods, ["a", "b"]);
        assert!(cli.json);
        assert!(Cli::try_parse_from(["ymb", "find", "--limit", "0"]).is_err());
        assert!(matches!(
            Cli::try_parse_from(["ymb", "b"]).unwrap().command,
            Some(Action::Build)
        ));
    }

    #[test]
    fn partial_options_and_parse_suggestions_use_the_active_command() {
        let cli =
            Cli::try_parse_from(["ymb", "bu", "--mo", "a", "--pa", "x", "--sc", "dev", "--j"])
                .unwrap();
        assert_eq!(cli.mods, ["a"]);
        assert_eq!(cli.patches, ["x"]);
        assert_eq!(cli.scope, "dev");
        assert!(cli.json);
        for (tokens, wanted) in [
            (vec!["ymb", "buid"], vec!["build"]),
            (vec!["ymb", "find", "--naem", "a"], vec!["--name"]),
            (
                vec!["ymb", "build", "--re"],
                vec!["--require-all", "--reset-changed"],
            ),
        ] {
            let args: Vec<std::ffi::OsString> = tokens.iter().map(Into::into).collect();
            let error = Cli::try_parse_from(&args).err().unwrap();
            let diagnostic = arguments::diagnostic(&error, Cli::command(), &args);
            let suggestions = diagnostic.context["suggestions"].as_array().unwrap();
            for candidate in wanted {
                assert!(suggestions.contains(&json!(candidate)), "{diagnostic:?}");
            }
        }
        let args: Vec<std::ffi::OsString> = ["ymb", "--mod", "find", "build", "--naem", "a"]
            .iter()
            .map(Into::into)
            .collect();
        let error = Cli::try_parse_from(&args).err().unwrap();
        let diagnostic = arguments::diagnostic(&error, Cli::command(), &args);
        assert!(
            !diagnostic.context["suggestions"]
                .as_array()
                .unwrap()
                .contains(&json!("--name"))
        );
    }
}

#[cfg(test)]
mod integration;

mod menu;
use menu::*;
