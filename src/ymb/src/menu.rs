use super::*;
use crate::ui::Ui;
use clap::{FromArgMatches, parser::ValueSource};

static COMMANDS: std::sync::LazyLock<Vec<(&str, &str, &str)>> = std::sync::LazyLock::new(|| {
    vec![
        (
            "1",
            "build",
            crate::messages::text("menu.shared.save_a_fresh_preview_for_review"),
        ),
        (
            "2",
            "sync",
            crate::messages::text("menu.shared.build_and_apply_this_selection_to_warno"),
        ),
        (
            "3",
            "validate",
            crate::messages::text("menu.shared.check_this_selection_without_saving_output"),
        ),
        (
            "4",
            "recover",
            crate::messages::text("menu.shared.restore_whole_files_from_saved_originals"),
        ),
        (
            "5",
            "list",
            crate::messages::text("menu.shared.show_selected_projects_and_patches"),
        ),
        (
            "6",
            "explain",
            crate::messages::text("menu.shared.show_why_each_patch_is_included_or"),
        ),
        (
            "7",
            "find",
            crate::messages::text("menu.shared.search_game_objects_by_name_type_or"),
        ),
        (
            "8",
            "doctor",
            crate::messages::text("menu.shared.check_installation_and_recovery_records"),
        ),
        (
            "9",
            "init",
            crate::messages::text("menu.shared.create_a_starter_mod_project"),
        ),
        (
            "A",
            "cleanup",
            crate::messages::text("menu.shared.remove_build_work_and_disposable_caches"),
        ),
        (
            "B",
            "projects",
            crate::messages::text("menu.shared.change_the_project_selection"),
        ),
        (
            "C",
            "scope",
            crate::messages::text("menu.shared.switch_between_normal_and_development_patches"),
        ),
        (
            "D",
            "details",
            crate::messages::text("menu.shared.switch_between_compact_and_detailed_reports"),
        ),
        (
            "E",
            "settings",
            crate::messages::text("menu.shared.show_settings_files_and_storage_paths"),
        ),
        (
            "F",
            "release",
            crate::messages::text("menu.shared.prepare_project_archives_and_deploy_installers"),
        ),
        (
            "H",
            "help",
            crate::messages::text("menu.shared.read_the_workflow_and_command_guide"),
        ),
        ("0", "exit", crate::messages::text("menu.shared.close_ymb")),
        (
            "R",
            "install-rust",
            crate::messages::text("common.shared.rust_is_required_for_some_actions"),
        ),
    ]
});

fn menu_command(input: &str) -> Result<Option<&'static str>> {
    ui::command(input, &COMMANDS)
}

enum MenuInput {
    Control(&'static str),
    Execute { cli: Box<Cli>, prompt_find: bool },
    Help(String),
}

fn menu_input(defaults: &Cli, input: &str) -> Result<Option<MenuInput>> {
    let mut tokens = arguments::split(input)?;
    let Some(first) = tokens.first_mut() else {
        return Ok(None);
    };
    if !first.starts_with('-') {
        *first = menu_command(first)?
            .ok_or_else(|| {
                Diagnostic::new(
                    "CommandError",
                    crate::messages::text("menu.menu_input.the_command_name_is_empty"),
                    crate::messages::text("menu.menu_input.type_a_command_followed_by_its_options"),
                )
            })?
            .into();
    }
    let mut parser = arguments::menu_parser(Cli::command(), &COMMANDS);
    let input_args: Vec<std::ffi::OsString> = std::iter::once("ymb")
        .chain(tokens.iter().map(String::as_str))
        .map(Into::into)
        .collect();
    let matches = match parser.try_get_matches_from_mut(&input_args) {
        Ok(matches) => matches,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            return Ok(Some(MenuInput::Help(error.to_string())));
        }
        Err(error) => return Err(arguments::diagnostic(&error, parser, &input_args)),
    };
    if let Some((name, _)) = matches.subcommand()
        && Cli::command().find_subcommand(name).is_none()
    {
        if tokens.len() != 1 {
            return Err(Diagnostic::new(
                "CommandError",
                crate::messages::format(
                    "menu.menu_input.name_does_not_accept_command_options",
                    &[("NAME", name.to_string())],
                ),
                crate::messages::text("menu.menu_input.use_options_with_an_action_for_example"),
            ));
        }
        return Ok(Some(MenuInput::Control(
            COMMANDS
                .iter()
                .find(|(_, command, _)| *command == name)
                .unwrap()
                .1,
        )));
    }
    // Parse the combined arguments so menu defaults obey the same CLI validation.
    let supplied = |id| matches.value_source(id) == Some(ValueSource::CommandLine);
    let mut args = vec![std::ffi::OsString::from("ymb")];
    for (id, flag, value) in [
        ("json", "--json", defaults.json),
        ("verbose", "--verbose", defaults.verbose),
        ("dry_run", "--dry-run", defaults.dry_run),
        ("no_cache", "--no-cache", defaults.no_cache),
        ("require_all", "--require-all", defaults.require_all),
        ("reset_changed", "--reset-changed", defaults.reset_changed),
        ("yes", "--yes", defaults.yes),
        ("install_rust", "--install-rust", defaults.install_rust),
    ] {
        if value && !supplied(id) {
            args.push(flag.into());
        }
    }
    if !supplied("ymb_path")
        && let Some(path) = &defaults.ymb_path
    {
        args.extend(["--ymb-path".into(), path.as_os_str().to_owned()]);
    }
    if !supplied("scope") {
        args.extend(["--scope".into(), defaults.scope.clone().into()]);
    }
    for (id, flag, values) in [
        ("mods", "--mod", &defaults.mods),
        ("patches", "--patch", &defaults.patches),
    ] {
        if !supplied(id) {
            for value in values {
                args.extend([flag.into(), value.into()]);
            }
        }
    }
    args.extend(input_args.into_iter().skip(1));
    let matches = parser
        .try_get_matches_from_mut(&args)
        .map_err(|error| arguments::diagnostic(&error, parser.clone(), &args))?;
    let mut cli = Cli::from_arg_matches(&matches)
        .and_then(check_cli)
        .map_err(|error| arguments::diagnostic(&error, parser, &args))?;
    if cli.command.is_none() && cli.install_rust {
        cli.command = Some(Action::InstallRust);
    }
    if cli.command.is_none() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("menu.menu_input.no_command_was_supplied"),
            crate::messages::text("menu.menu_input.type_a_command_followed_by_its_options"),
        ));
    }
    Ok(Some(MenuInput::Execute {
        cli: Box::new(cli),
        prompt_find: tokens.len() == 1,
    }))
}

fn project_shortcut(index: usize) -> String {
    if index < 9 {
        return (index + 1).to_string();
    }
    let letters = b"ABCDEFGIJKLMNOPQRSTUVWXYZ";
    let mut index = index - 9;
    let mut key = String::new();
    loop {
        key.insert(0, char::from(letters[index % letters.len()]));
        if index < letters.len() {
            return key;
        }
        index = index / letters.len() - 1;
    }
}

#[cfg(test)]
pub(super) fn menu_action(choice: &str) -> Option<Action> {
    let defaults = Cli::try_parse_from(["ymb"]).unwrap();
    match menu_input(&defaults, choice).ok()?? {
        MenuInput::Execute { cli, .. } => cli.command,
        _ => None,
    }
}

pub(super) fn menu(cli: &Cli) -> Result<()> {
    let ui = Ui::stderr();
    let mut mods = cli.mods.clone();
    let mut scope = cli.scope.clone();
    let mut verbose = cli.verbose;
    let mut last = String::new();
    loop {
        let rendering = platform::InputBlock::new(true);
        if ui.rich {
            eprint!("\x1b[2J\x1b[H");
        }
        eprint!("{}", ui.banner(""));
        let mut defaults = cli.clone();
        defaults.scope = scope.clone();
        defaults.mods = mods.clone();
        defaults.verbose = verbose;
        let selection = selection(&defaults, true);
        let installation = {
            let _progress = ui::Progress::start(vec![
                crate::messages::text("menu.menu.read_installation").into(),
            ]);
            config::Context::resolve_recovery(cli.ymb_path.as_deref()).map(|context| {
                let plan = commands::prepare(context.clone(), selection);
                let manifest = state::Manifest::load(&context);
                (context, plan, manifest)
            })
        };
        match installation {
            Ok((context, plan, manifest)) => {
                eprint!(
                    "{}",
                    ui.label(
                        crate::messages::text("common.shared.warno_mod"),
                        &context.game.display().to_string()
                    )
                );
                match plan {
                    Ok(plan) => eprint!(
                        "{}",
                        ui.label(
                            crate::messages::text("common.shared.selection"),
                            &crate::messages::format(
                                if cli.dry_run {
                                    "menu.menu.selection_dry"
                                } else {
                                    "menu.menu.selection_counts"
                                },
                                &[
                                    (
                                        "PROJECTS",
                                        crate::messages::quantity(
                                            "common.counts.projects",
                                            plan.mods.len(),
                                            &[]
                                        )
                                    ),
                                    (
                                        "PATCHES",
                                        crate::messages::quantity(
                                            "common.counts.patches",
                                            plan.patches.len(),
                                            &[]
                                        )
                                    )
                                ]
                            )
                        )
                    ),
                    Err(error) => eprint!("{}", ui.error(&error, verbose)),
                }
                match manifest {
                    Ok(manifest) => eprint!(
                        "{}",
                        ui.label(
                            crate::messages::text("menu.menu.applied"),
                            &crate::messages::format(
                                "menu.menu.arg0_tracked_files_arg1",
                                &[
                                    ("ARG0", format!("{}", manifest.entries.len())),
                                    (
                                        "ARG1",
                                        (if context.output.is_dir() {
                                            "saved preview available"
                                        } else {
                                            "no saved preview"
                                        })
                                        .to_string()
                                    )
                                ]
                            )
                        )
                    ),
                    Err(error) => eprint!("{}", ui.error(&error, verbose)),
                }
                let next = if context.journal.exists() {
                    crate::messages::text(
                        "menu.menu.an_interrupted_command_needs_rollback_use_doctor",
                    )
                } else if context.lock.exists() {
                    crate::messages::text("menu.menu.an_operation_lock_exists_use_doctor_before")
                } else if context.output.is_dir() {
                    crate::messages::text(
                        "menu.menu.rebuild_after_changing_settings_or_selection_review",
                    )
                } else {
                    crate::messages::text("menu.menu.build_a_preview_to_review_this_selection")
                };
                eprint!(
                    "{}",
                    ui.label(crate::messages::text("common.shared.next"), next)
                );
            }
            Err(error) => eprint!("{}", ui.error(&error, verbose)),
        }
        if !last.is_empty() {
            eprint!(
                "{}",
                ui.label(crate::messages::text("menu.menu.last_command"), &last)
            );
        }
        eprintln!();
        eprint!(
            "{}",
            ui.rule(crate::messages::text("common.shared.build_and_play"))
        );
        eprint!("{}", ui.rows(&COMMANDS[..4], ui::Tone::Muted));
        eprintln!();
        eprint!("{}", ui.rule(crate::messages::text("menu.menu.tools")));
        eprint!(
            "{}",
            ui.actions(
                &COMMANDS[4..10]
                    .iter()
                    .chain(std::iter::once(&COMMANDS[14]))
                    .map(|(key, name, _)| (*key, *name))
                    .collect::<Vec<_>>()
            )
        );
        eprint!("{}", ui.rows(&COMMANDS[17..], ui::Tone::Muted));
        eprintln!();
        eprint!(
            "{}",
            ui.rule(crate::messages::text("menu.menu.preferences"))
        );
        let projects = if mods.is_empty() {
            crate::messages::text("menu.menu.all_projects").into()
        } else {
            mods.join(", ")
        };
        eprint!(
            "{}",
            ui.rows(
                &[
                    ("B", "projects", &projects),
                    (
                        "C",
                        "scope",
                        if scope == "dev" {
                            crate::messages::text("menu.menu.development_normal")
                        } else {
                            "normal"
                        }
                    ),
                    ("D", "details", if verbose { "on" } else { "off" }),
                ],
                ui::Tone::Accent
            )
        );
        eprintln!();
        eprint!(
            "{}",
            ui.actions(&[("E", "settings"), ("H", "help"), ("0", "exit")])
        );
        drop(rendering);
        let input = match ui::prompt(crate::messages::text("menu.menu.command")) {
            Ok(input) => input,
            Err(error) if error.code.as_deref() == Some("I3") => return Ok(()),
            Err(error) => return Err(error),
        };
        let request = match menu_input(&defaults, &input) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(error) => {
                eprint!("{}", ui.error(&error, verbose));
                pause()?;
                continue;
            }
        };
        let command = match &request {
            MenuInput::Control(command) => *command,
            MenuInput::Execute { cli, .. } => cli.command.as_ref().unwrap().name(),
            MenuInput::Help(text) => {
                eprint!("{}", ui::help(text));
                pause()?;
                continue;
            }
        };
        match command {
            "exit" => return Ok(()),
            "projects" => {
                if let Err(error) = choose_projects(cli, &mut mods, &ui) {
                    eprint!("{}", ui.error(&error, verbose));
                    pause()?;
                }
                continue;
            }
            "scope" => {
                scope = if scope == "prod" { "dev" } else { "prod" }.into();
                continue;
            }
            "details" => {
                verbose = !verbose;
                continue;
            }
            "settings" => {
                show_settings(cli, &ui, verbose);
                pause()?;
                continue;
            }
            "help" => {
                show_help(&ui);
                pause()?;
                continue;
            }
            _ => (),
        }
        let MenuInput::Execute {
            mut cli,
            prompt_find,
        } = request
        else {
            unreachable!()
        };
        let mut action = cli.command.take().unwrap();
        if prompt_find
            && let Action::Find {
                ref mut name,
                ref mut type_name,
                ref mut field,
                ref mut files,
                ..
            } = action
        {
            eprint!(
                "{}",
                ui.rule(crate::messages::text("menu.menu.find_game_objects"))
            );
            eprintln!(
                "{}",
                crate::messages::text("menu.menu.leave_a_filter_empty_to_match_any")
            );
            *name = nonempty(ui::prompt(crate::messages::text(
                "menu.menu.name_contains",
            ))?);
            *type_name = nonempty(ui::prompt(crate::messages::text(
                "menu.menu.type_contains",
            ))?);
            *field = nonempty(ui::prompt(crate::messages::text(
                "menu.menu.field_name_value",
            ))?);
            eprintln!(
                "{}",
                crate::messages::text("menu.menu.leave_the_file_empty_to_search_the")
            );
            if let Some(file) = nonempty(ui::prompt(crate::messages::text(
                "menu.menu.gamedata_or_commondata_file",
            ))?) {
                files.push(file);
            }
        }
        if !cli.json {
            eprint!("{}", ui.rule(action.name()));
        }
        let started = Instant::now();
        ui::configure(cli.json, cli.verbose);
        let report = execute(&cli, &action, !cli.json, started);
        print_report(&report, &cli);
        ui::configure(false, false);
        match report["status"].as_str() {
            Some("ok") => {
                last = format!(
                    "{} / {}",
                    report["data"]["summary"]
                        .as_str()
                        .unwrap_or(crate::messages::text("menu.menu.completed")),
                    ui::elapsed(started.elapsed())
                );
            }
            _ => {
                last = format!(
                    "{} / {}",
                    report["errors"][0]["reason"]
                        .as_str()
                        .unwrap_or(crate::messages::text("menu.menu.command_failed")),
                    ui::elapsed(started.elapsed())
                );
            }
        }
        pause()?;
    }
}

fn show_help(ui: &Ui) {
    eprint!(
        "{}",
        ui.rule(crate::messages::text("common.shared.build_and_play"))
    );
    for line in [
        crate::messages::text("menu.show_help.choose_projects_with_b_use_c_to"),
        crate::messages::text("menu.show_help.use_build_to_save_a_preview_review"),
        crate::messages::text("menu.show_help.after_sync_run_generatemod_bat_in_the"),
        crate::messages::text("menu.show_help.use_recover_to_restore_whole_files_including"),
        crate::messages::text("menu.show_help.commands_sync_recover_and_cleanup_ask_once"),
        crate::messages::text("menu.show_help.type_a_shortcut_command_name_or_unique"),
        crate::messages::text("menu.show_help.commands_accept_cli_options_for_example_build"),
        crate::messages::text("menu.show_help.unique_option_prefixes_work_too_quote_values"),
        crate::messages::text("menu.show_help.shortcuts_take_priority_ignoring_case_for_example"),
        crate::messages::text("menu.show_help.use_d_for_full_diagnostics_message_codes"),
    ] {
        eprintln!("  {line}");
    }
    eprint!(
        "{}",
        ui.rule(crate::messages::text("menu.show_help.commands"))
    );
    eprint!("{}", ui.rows(&COMMANDS[..10], ui::Tone::Muted));
    eprint!("{}", ui.rows(&COMMANDS[14..15], ui::Tone::Muted));
    eprint!("{}", ui.rows(&COMMANDS[17..], ui::Tone::Muted));
    eprintln!(
        "{}",
        crate::messages::text("menu.show_help.documentation_docs_readme_md")
    );
    eprintln!(
        "{}",
        crate::messages::text("menu.show_help.community_https_discord_gg_33sqn6dtjf")
    );
}

fn show_settings(cli: &Cli, ui: &Ui, verbose: bool) {
    match config::Context::resolve_recovery(cli.ymb_path.as_deref()) {
        Ok(context) => {
            eprint!(
                "{}",
                ui.rule(crate::messages::text("common.shared.settings"))
            );
            for (label, path) in [
                (
                    crate::messages::text("common.shared.builder"),
                    context.root.clone(),
                ),
                (
                    crate::messages::text("menu.show_settings.defaults"),
                    context.root.join(ymb_core::layout::CONFIG),
                ),
                (
                    crate::messages::text("common.shared.overrides"),
                    context.root.join(ymb_core::layout::LOCAL_CONFIG),
                ),
                (
                    crate::messages::text("common.shared.preview"),
                    context.output.clone(),
                ),
                (
                    crate::messages::text("common.shared.cache"),
                    context.cache.clone(),
                ),
                (
                    crate::messages::text("menu.show_settings.originals"),
                    context.state.clone(),
                ),
            ] {
                eprint!("{}", ui.label(label, &path.display().to_string()));
            }
            eprintln!(
                "{}",
                crate::messages::text(
                    "menu.show_settings.edit_overrides_for_this_installation_remove_an"
                )
            );
            eprintln!(
                "{}",
                crate::messages::text(
                    "menu.show_settings.objects_merge_lists_replace_keep_saved_originals"
                )
            );
            eprint!(
                "{}",
                ui.label(
                    crate::messages::text("menu.show_settings.cache_limit"),
                    &crate::messages::format(
                        "menu.show_settings.arg0_arg1_entries",
                        &[
                            (
                                "ARG0",
                                ui::size(context.config.settings.cache_max_bytes).to_string()
                            ),
                            (
                                "ARG1",
                                format!("{}", context.config.settings.cache_max_entries)
                            )
                        ]
                    )
                )
            );
        }
        Err(error) => eprint!("{}", ui.error(&error, verbose)),
    }
}

fn pause() -> Result<()> {
    ui::wait(crate::messages::text("menu.pause.press_enter_to_return"))
}

fn nonempty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}
fn choose_projects(cli: &Cli, selected: &mut Vec<String>, ui: &Ui) -> Result<()> {
    let context = config::Context::resolve_recovery(cli.ymb_path.as_deref())?;
    let projects = config::discover(&context)?;
    eprint!(
        "{}",
        ui.rule(crate::messages::text(
            "menu.choose_projects.choose_projects"
        ))
    );
    if projects.is_empty() {
        eprintln!(
            "{}",
            crate::messages::text("menu.choose_projects.i7_no_projects_found_use_init_to")
        );
        return Ok(());
    }
    let mut rows = Vec::new();
    for (index, project) in projects.iter().enumerate() {
        let active = project.config.enabled
            && plan::matches(selected, &project.config.id, &project.config.name);
        rows.push((
            project_shortcut(index),
            project.config.id.as_str(),
            format!(
                "{} {}{}",
                if active { "[+]" } else { "[ ]" },
                project.config.name,
                if project.config.enabled {
                    ""
                } else {
                    crate::messages::text("menu.choose_projects.disabled_in_configuration")
                }
            ),
        ));
    }
    eprint!(
        "{}",
        ui.rows(
            &rows
                .iter()
                .map(|(key, name, value)| (key.as_str(), *name, value.as_str()))
                .collect::<Vec<_>>(),
            ui::Tone::Muted
        )
    );
    eprintln!(
        "{}",
        crate::messages::text("menu.choose_projects.enter_shortcuts_or_ids_separated_by_commas")
    );
    eprintln!(
        "{}",
        crate::messages::text("menu.choose_projects.leave_empty_to_keep_the_current_selection")
    );
    let choice = ui::prompt(crate::messages::text("common.shared.projects"))?;
    if choice.is_empty() {
        return Ok(());
    }
    if choice.eq_ignore_ascii_case("all") {
        selected.clear();
        return Ok(());
    }
    let mut next = Vec::new();
    for item in choice
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let project = rows
            .iter()
            .position(|(key, _, _)| key.eq_ignore_ascii_case(item))
            .and_then(|index| projects.get(index))
            .or_else(|| {
                projects.iter().find(|project| {
                    project.config.id.eq_ignore_ascii_case(item)
                        || project.config.name.eq_ignore_ascii_case(item)
                })
            })
            .ok_or_else(|| {
                Diagnostic::new(
                    "CommandError",
                    crate::messages::format(
                        "menu.choose_projects.unknown_project_item",
                        &[("ITEM", item.to_string())],
                    ),
                    crate::messages::text(
                        "menu.choose_projects.choose_one_of_the_listed_shortcuts_or",
                    ),
                )
            })?;
        if !next.contains(&project.config.id) {
            next.push(project.config.id.clone());
        }
    }
    if next.is_empty() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("menu.choose_projects.no_project_was_selected"),
            crate::messages::text("menu.choose_projects.choose_at_least_one_listed_shortcut_or"),
        ));
    }
    *selected = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_options_preserve_defaults_shortcuts_and_unique_prefixes() {
        let defaults = Cli::try_parse_from([
            "ymb",
            "--mod",
            "old",
            "--scope",
            "dev",
            "--verbose",
            "--dry-run",
            "--no-cache",
            "--require-all",
        ])
        .unwrap();
        for input in [
            "1 --mo a --mod b --pa feature --j",
            "bu --mod a --mod b --patch feature --json",
            "--mo a --mod b --patch feature --json 1",
        ] {
            let MenuInput::Execute { cli, prompt_find } =
                menu_input(&defaults, input).unwrap().unwrap()
            else {
                panic!("Expected an action")
            };
            assert_eq!(cli.command.as_ref().unwrap().name(), "build");
            assert_eq!(cli.mods, ["a", "b"]);
            assert_eq!(cli.patches, ["feature"]);
            assert_eq!(cli.scope, "dev");
            assert!(cli.verbose && cli.dry_run && cli.no_cache && cli.require_all && cli.json);
            assert!(!prompt_find);
        }
        let MenuInput::Execute { cli, .. } =
            menu_input(&defaults, "build --sc prod").unwrap().unwrap()
        else {
            panic!()
        };
        assert_eq!(cli.scope, "prod");
        assert_eq!(cli.mods, ["old"]);
        assert!(menu_input(&defaults, "sync --reset-changed").is_err());
        assert!(matches!(
            menu_input(&defaults, "b").unwrap(),
            Some(MenuInput::Control("projects"))
        ));
        assert!(menu_input(&defaults, "--mod a b").is_err());
        assert!(matches!(
            menu_input(&defaults, "find --na 'A tank' --lim 2").unwrap(),
            Some(MenuInput::Execute {
                prompt_find: false,
                ..
            })
        ));
        assert!(matches!(
            menu_input(&defaults, "7").unwrap(),
            Some(MenuInput::Execute {
                prompt_find: true,
                ..
            })
        ));
        assert!(matches!(
            menu_input(&defaults, "build --he").unwrap(),
            Some(MenuInput::Help(_))
        ));
        for input in [
            "build --re",
            "build --modd x",
            "find --name 'unfinished",
            "''",
            "'' --mod a",
        ] {
            assert!(menu_input(&defaults, input).is_err(), "{input}");
        }
    }
    #[test]
    fn shortcuts_and_unique_prefixes_resolve_without_guessing() {
        for (key, name, _) in COMMANDS.iter() {
            assert_eq!(menu_command(key).unwrap(), Some(*name));
            assert_eq!(
                menu_command(&key.to_ascii_lowercase()).unwrap(),
                Some(*name)
            );
            assert_eq!(menu_command(name).unwrap(), Some(*name));
        }
        assert_eq!(menu_command("b").unwrap(), Some("projects"));
        assert_eq!(menu_command("bu").unwrap(), Some("build"));
        assert_eq!(menu_command("[B]").unwrap(), Some("projects"));
        assert_eq!(menu_command("[b]").unwrap(), Some("projects"));
        assert_eq!(menu_command("A").unwrap(), Some("cleanup"));
        assert_eq!(menu_command("C").unwrap(), Some("scope"));
        assert_eq!(menu_command("c").unwrap(), Some("scope"));
        assert_eq!(menu_command("E").unwrap(), Some("settings"));
        assert_eq!(menu_command("DO").unwrap(), Some("doctor"));
        assert!(menu_command("s").is_err());
        assert!(menu_command("unknown").is_err());
        assert_eq!(menu_command("").unwrap(), None);
        assert_eq!(
            COMMANDS.iter().map(|(key, _, _)| *key).collect::<String>(),
            "123456789ABCDEFH0R"
        );
        assert!(menu_command("10").is_err());
    }
    #[test]
    fn project_shortcuts_use_letters_after_nine_and_skip_help() {
        for (index, key) in [
            (0, "1"),
            (8, "9"),
            (9, "A"),
            (15, "G"),
            (16, "I"),
            (33, "Z"),
            (34, "AA"),
            (35, "AB"),
        ] {
            assert_eq!(project_shortcut(index), key);
        }
    }
}
