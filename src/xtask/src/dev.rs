use super::*;
use clap::{Arg, ArgAction, Command as Parser};
use std::{ffi::OsString, io::IsTerminal};
use ymb::{
    arguments, platform,
    ui::{self, Progress, Tone, Ui},
};

static COMMANDS: std::sync::LazyLock<Vec<(&str, &str, &str)>> = std::sync::LazyLock::new(|| {
    vec![
        (
            "1",
            "run",
            crate::messages::text("dev.shared.open_the_ymb_menu_from_source"),
        ),
        (
            "2",
            "build",
            crate::messages::text("dev.shared.build_only_the_optimized_dist_ymb_exe"),
        ),
        (
            "3",
            "check",
            crate::messages::text("dev.shared.check_rust_types_in_the_builder"),
        ),
        (
            "4",
            "test",
            crate::messages::text("dev.shared.run_builder_tests"),
        ),
        (
            "5",
            "lint",
            crate::messages::text("dev.shared.run_clippy_with_warnings_treated_as_errors"),
        ),
        (
            "6",
            "format",
            crate::messages::text("dev.shared.format_rust_source"),
        ),
        (
            "7",
            "fix",
            crate::messages::text("dev.shared.format_cargo_clippy_fix"),
        ),
        (
            "8",
            "release",
            crate::messages::text("dev.shared.prepare_and_verify_the_full_ymb_archive"),
        ),
        (
            "9",
            "verify",
            crate::messages::text("dev.shared.verify_the_portable_builder_archive"),
        ),
        (
            "A",
            "update",
            crate::messages::text("dev.shared.engine_deps_check"),
        ),
        (
            "B",
            "engine",
            crate::messages::text("dev.shared.update_the_stable_rust_compiler_and_tools"),
        ),
        (
            "C",
            "deps",
            crate::messages::text("dev.shared.update_cargo_dependencies_within_their_constraints"),
        ),
        (
            "D",
            "pull",
            crate::messages::text("dev.shared.pull_this_checkout_with_git_pull_ff"),
        ),
        (
            "E",
            "clean",
            crate::messages::text("dev.shared.cargo_xtask_clean_cargo_clean"),
        ),
        (
            "F",
            "help",
            crate::messages::text("dev.shared.read_the_development_command_guide"),
        ),
        (
            "0",
            "exit",
            crate::messages::text("dev.shared.close_this_menu"),
        ),
    ]
});

#[derive(Clone, Debug)]
struct Step {
    tool: &'static str,
    arguments: Vec<&'static str>,
    label: &'static str,
}

fn plan(name: &str) -> Vec<Step> {
    let step = |tool, arguments: &[&'static str], label| {
        vec![Step {
            tool,
            arguments: arguments.to_vec(),
            label,
        }]
    };
    match name {
        "run" => step(
            "cargo",
            &["run", "--quiet", "--locked", "--package", "ymb", "--"],
            crate::messages::text("dev.plan.open_ymb"),
        ),
        "build" => step(
            "cargo",
            &["xtask", "build"],
            crate::messages::text("dev.plan.build_ymb_exe"),
        ),
        "check" => step(
            "cargo",
            &[
                "check",
                "--workspace",
                "--all-features",
                "--all-targets",
                "--locked",
            ],
            crate::messages::text("dev.plan.check_types"),
        ),
        "test" => step(
            "cargo",
            &["test", "--workspace", "--all-features", "--locked"],
            crate::messages::text("dev.plan.run_tests"),
        )
        .into_iter()
        .chain(step(
            "powershell.exe",
            &[
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                ".github/scripts/test-dev.ps1",
            ],
            crate::messages::text("dev.plan.check_development_frontend"),
        ))
        .collect(),
        "lint" => step(
            "cargo",
            &[
                "clippy",
                "--workspace",
                "--all-features",
                "--all-targets",
                "--locked",
                "--",
                "-D",
                "warnings",
            ],
            crate::messages::text("dev.plan.run_clippy"),
        ),
        "format" => step(
            "cargo",
            &["fmt", "--all"],
            crate::messages::text("dev.plan.format_source"),
        ),
        "fix" => plan("format")
            .into_iter()
            .chain(step(
                "cargo",
                &[
                    "clippy",
                    "--fix",
                    "--workspace",
                    "--all-features",
                    "--all-targets",
                    "--locked",
                    "--allow-dirty",
                    "--allow-staged",
                    "--allow-no-vcs",
                    "--",
                    "-D",
                    "warnings",
                ],
                crate::messages::text("dev.plan.apply_clippy_fixes"),
            ))
            .collect(),
        "release" => step(
            "cargo",
            &["xtask", "release"],
            crate::messages::text("dev.plan.prepare_ymb_release_archive"),
        ),
        "verify" => step(
            "cargo",
            &["xtask", "verify-release"],
            crate::messages::text("dev.plan.verify_ymb_release"),
        ),
        "update" => [plan("engine"), plan("deps"), plan("check")].concat(),
        "engine" => step(
            "rustup",
            &["update", "stable", "--no-self-update"],
            crate::messages::text("dev.plan.update_rust"),
        ),
        "deps" => step(
            "cargo",
            &["update"],
            crate::messages::text("dev.plan.update_dependencies"),
        ),
        "pull" => step(
            "git",
            &["pull", "--ff-only"],
            crate::messages::text("dev.plan.pull_checkout"),
        ),
        "clean" => step(
            "cargo",
            &["xtask", "clean"],
            crate::messages::text("dev.plan.remove_generated_files"),
        )
        .into_iter()
        .chain(step(
            "cargo",
            &["clean"],
            crate::messages::text("dev.plan.remove_compiler_caches"),
        ))
        .collect(),
        _ => vec![],
    }
}

fn menu(ui: &Ui) -> String {
    let mut out = ui.title(crate::messages::text("dev.menu.ymb_development"));
    out.push_str(&ui.label(
        crate::messages::text("dev.menu.folder"),
        &root().display().to_string(),
    ));
    out.push_str(&ui.label(crate::messages::text("common.shared.output"), "dist/"));
    for (title, compact, detailed) in [
        (crate::messages::text("dev.menu.build"), 0..2, 2..2),
        (crate::messages::text("dev.menu.check"), 2..6, 6..7),
        (crate::messages::text("dev.menu.release"), 7..7, 7..9),
        (crate::messages::text("dev.menu.maintain"), 10..13, 13..14),
    ] {
        out.push('\n');
        out.push_str(&ui.rule(title));
        if title == crate::messages::text("dev.menu.maintain") {
            out.push_str(&ui.rows(&COMMANDS[9..10], Tone::Muted));
        }
        out.push_str(
            &ui.actions(
                &COMMANDS[compact]
                    .iter()
                    .map(|(key, name, _)| (*key, *name))
                    .collect::<Vec<_>>(),
            ),
        );
        out.push_str(&ui.rows(&COMMANDS[detailed], Tone::Muted));
    }
    out.push('\n');
    out.push_str(&ui.actions(&[("F", "help"), ("0", "exit")]));
    out
}

fn help(ui: &Ui) {
    eprint!(
        "{}",
        ui.rule(crate::messages::text("dev.help.development_commands"))
    );
    eprint!("{}", ui.rows(&COMMANDS[..14], Tone::Muted));
    for line in [
        crate::messages::text("dev.help.development_commands_operate_on_ymb_itself_manage"),
        crate::messages::text("dev.help.build_saves_only_dist_ymb_exe_release"),
        crate::messages::text("dev.help.update_runs_engine_deps_check_use_pull"),
        crate::messages::text("dev.help.clean_requires_confirmation_use_yes_in_scripts"),
        crate::messages::text("dev.help.shortcuts_take_priority_ignoring_case_use_bu"),
        crate::messages::text("dev.help.message_codes_docs_references_message_codes_md"),
    ] {
        eprint!("{}", ui.block("  ", line, Tone::Muted));
    }
}

fn child_error(label: &str, code: i32) -> Box<Diagnostic> {
    error(crate::messages::format(
        "dev.child_error.label_failed_with_exit_code_code",
        &[("LABEL", label.to_string()), ("CODE", format!("{}", code))],
    ))
    .with("exitCode", code)
}

fn execute(step: &Step, interactive: bool) -> Result<()> {
    let mut command = Command::new(step.tool);
    command.current_dir(root()).args(&step.arguments);
    let output = platform::capture_with_progress(&mut command, interactive).map_err(|cause| {
        error(crate::messages::format(
            "dev.execute.arg0_could_not_run_arg1",
            &[
                ("ARG0", step.label.to_string()),
                ("ARG1", cause.reason.to_string()),
            ],
        ))
        .detail(cause.to_string())
        .with("cause", &cause)
    })?;
    if !output.status.success() {
        let tail = |bytes: &[u8]| {
            String::from_utf8_lossy(bytes)
                .lines()
                .rev()
                .take(100)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        };
        return Err(child_error(step.label, output.status.code().unwrap_or(1))
            .detail(tail(&output.stdout))
            .detail(tail(&output.stderr)));
    }
    Ok(())
}

fn run_steps(steps: &[Step], execute: &mut impl FnMut(&Step) -> Result<()>) -> Result<()> {
    for (index, step) in steps.iter().enumerate() {
        if index > 0 {
            ui::step(index);
        }
        if let Err(error) = execute(step) {
            ui::failed_step(index);
            return Err(error);
        }
    }
    Ok(())
}

fn invoke(name: &str, yes: bool) -> Result<Value> {
    let interactive = std::io::stdin().is_terminal();
    if name == "clean" && !yes {
        if !interactive {
            return Err(Diagnostic::new(
                "CommandError",
                crate::messages::text("dev.invoke.clean_needs_yes_in_a_noninteractive_session"),
                crate::messages::text("dev.invoke.review_the_cleanup_command_then_repeat_with"),
            ));
        }
        if !ui::confirm(&[
            crate::messages::text(
                "dev.invoke.remove_generated_work_previews_executables_and_release",
            )
            .into(),
            crate::messages::text("dev.invoke.remove_builder_compiler_caches").into(),
            crate::messages::text("dev.invoke.keep_settings_authored_projects_and_saved_originals")
                .into(),
        ])? {
            return Err(Diagnostic::new(
                "CommandError",
                crate::messages::text("dev.invoke.clean_cancelled_no_work_started"),
                crate::messages::text("dev.invoke.run_clean_again_when_ready"),
            )
            .code("I2"));
        }
    }
    let steps = plan(name);
    if matches!(name, "build" | "release" | "verify") {
        eprint!(
            "{}",
            Ui::stderr().label(
                crate::messages::text("common.shared.output"),
                &root().join("dist").display().to_string()
            )
        );
    }
    if name == "run" {
        ui::phase(steps[0].label.into());
        let status = Command::new(steps[0].tool)
            .current_dir(root())
            .args(&steps[0].arguments)
            .status()
            .map_err(|cause| error(cause.to_string()))?;
        if !status.success() {
            return Err(child_error(steps[0].label, status.code().unwrap_or(1)));
        }
    } else {
        let _input = platform::InputBlock::new(interactive);
        let _progress = Progress::start(steps.iter().map(|step| step.label.into()).collect());
        run_steps(&steps, &mut |step| execute(step, interactive))?;
    }
    Ok(
        json!({"summary":crate::messages::format("dev.invoke.name_completed", &[("NAME", name.to_string())])}),
    )
}

fn finish(name: &str, yes: bool) -> i32 {
    let started = Instant::now();
    let ui = Ui::stderr();
    let code = match invoke(name, yes) {
        Ok(data) => {
            print!("{}", Ui::stdout().report(&data, false));
            0
        }
        Err(error) => {
            eprint!("{}", ui.error(&error, true));
            exit_code(&error)
        }
    };
    eprint!(
        "{}",
        ui.label(
            crate::messages::text("dev.finish.elapsed"),
            &ui::elapsed(started.elapsed())
        )
    );
    code
}

fn exit_code(error: &Diagnostic) -> i32 {
    if error.code.as_deref() == Some("I2") {
        return 0;
    }
    error
        .context
        .get("exitCode")
        .and_then(Value::as_i64)
        .and_then(|code| i32::try_from(code).ok())
        .unwrap_or(if error.category == "CommandError" {
            2
        } else {
            1
        })
}

fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<(Option<String>, bool)> {
    let mut args: Vec<_> = std::iter::once(OsString::from("Dev.bat"))
        .chain(arguments)
        .collect();
    for arg in args.iter_mut().skip(1) {
        if arg.to_str().is_some_and(|arg| {
            arg.eq_ignore_ascii_case("-yes") || arg.eq_ignore_ascii_case("--yes")
        }) {
            *arg = "--yes".into();
        } else if arg
            .to_str()
            .is_some_and(|arg| arg.eq_ignore_ascii_case("--help"))
        {
            *arg = "--help".into();
        }
    }
    if let Some(first) = args
        .iter_mut()
        .skip(1)
        .find(|arg| !arg.to_string_lossy().starts_with('-'))
    {
        let name = first.to_str().ok_or_else(|| {
            Diagnostic::new(
                "CommandError",
                crate::messages::text("dev.parse.development_commands_must_be_unicode"),
                crate::messages::text("dev.parse.use_a_listed_development_command"),
            )
        })?;
        if let Some(name) = ui::command(name, &COMMANDS)? {
            *first = name.into();
        }
    }
    let mut parser = arguments::menu_parser(
        Parser::new("Dev.bat")
            .infer_subcommands(true)
            .infer_long_args(true)
            .disable_help_flag(true)
            .arg(
                Arg::new("yes")
                    .long("yes")
                    .global(true)
                    .action(ArgAction::SetTrue),
            )
            .arg(
                Arg::new("help")
                    .long("help")
                    .short('h')
                    .global(true)
                    .action(ArgAction::SetTrue),
            ),
        &COMMANDS,
    );
    let matches = parser
        .try_get_matches_from_mut(&args)
        .map_err(|error| arguments::diagnostic(&error, parser, &args))?;
    Ok((
        if matches.get_flag("help") {
            Some("help".into())
        } else {
            matches.subcommand_name().map(str::to_owned)
        },
        matches.get_flag("yes"),
    ))
}

pub(super) fn run(arguments: impl Iterator<Item = OsString>) -> i32 {
    let ui = Ui::stderr();
    let (name, yes) = match parse(arguments) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprint!("{}", ui.error(&error, false));
            return 2;
        }
    };
    if let Some(name) = name {
        return match name.as_str() {
            "exit" => 0,
            "help" => {
                help(&ui);
                0
            }
            name => {
                eprint!(
                    "{}",
                    ui.banner(&crate::messages::format(
                        "dev.run.development_name",
                        &[("NAME", name.to_string())]
                    ))
                );
                finish(name, yes)
            }
        };
    }
    loop {
        if ui.rich {
            eprint!("\x1b[2J\x1b[H");
        }
        eprint!("{}", menu(&ui));
        let input = match ui::prompt(crate::messages::text("dev.run.command")) {
            Ok(input) => input,
            Err(error) if error.code.as_deref() == Some("I3") => return 0,
            Err(error) => {
                eprint!("{}", ui.error(&error, false));
                return 1;
            }
        };
        match arguments::split(&input).and_then(|args| parse(args.into_iter().map(OsString::from)))
        {
            Ok((Some(name), _)) if name == "exit" => return 0,
            Ok((None, _)) => continue,
            Ok((Some(name), _)) if name == "help" => help(&ui),
            Ok((Some(name), command_yes)) => {
                eprint!("{}", ui.rule(&name));
                finish(&name, yes || command_yes);
            }
            Err(error) => eprint!("{}", ui.error(&error, false)),
        }
        if let Err(error) = ui::wait(crate::messages::text("dev.run.press_enter_to_return")) {
            eprint!("{}", ui.error(&error, false));
            return 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_options_work_with_shortcuts_and_in_menu_input() {
        for input in ["build -Yes", "bu --ye", "2 --yes", "--ye Bu"] {
            assert_eq!(
                parse(
                    arguments::split(input)
                        .unwrap()
                        .into_iter()
                        .map(OsString::from)
                )
                .unwrap(),
                (Some("build".into()), true)
            );
        }
        assert_eq!(
            parse(["bu", "--he"].into_iter().map(OsString::from))
                .unwrap()
                .0
                .as_deref(),
            Some("help")
        );
        let error = parse(["build", "--yess"].into_iter().map(OsString::from)).unwrap_err();
        assert_eq!(error.context["suggestions"][0], "--yes");
    }

    #[test]
    fn commands_use_shared_resolution_and_keep_builder_only_plans() {
        assert_eq!(
            COMMANDS.iter().map(|(key, _, _)| *key).collect::<String>(),
            "123456789ABCDEF0"
        );
        for (key, name, _) in COMMANDS.iter() {
            assert_eq!(
                ui::command(&key.to_lowercase(), &COMMANDS).unwrap(),
                Some(*name)
            );
            for step in plan(name) {
                assert!(
                    !step
                        .arguments
                        .iter()
                        .any(|argument| matches!(*argument, "publish" | "upload" | "push"))
                );
                assert!(
                    !step.arguments.iter().any(
                        |argument| argument.contains("mods/") || *argument == "--manifest-path"
                    )
                );
            }
        }
        assert_eq!(ui::command("bu", &COMMANDS).unwrap(), Some("build"));
        assert_eq!(ui::command("[b]", &COMMANDS).unwrap(), Some("engine"));
        assert!(ui::command("r", &COMMANDS).is_err());
        assert!(ui::command("mods", &COMMANDS).is_err());
        assert_eq!(
            plan("update")
                .iter()
                .map(|step| step.tool)
                .collect::<Vec<_>>(),
            ["rustup", "cargo", "cargo"]
        );
        assert_eq!(plan("release")[0].arguments, ["xtask", "release"]);
        let mut calls = 0;
        assert!(
            run_steps(&plan("update"), &mut |_| {
                calls += 1;
                Err(child_error("fixture", 7))
            })
            .is_err()
        );
        assert_eq!(calls, 1);
        assert_eq!(exit_code(&child_error("fixture", 7)), 7);
    }

    #[test]
    fn shared_menu_layout_keeps_each_command_once_and_wraps_narrow_windows() {
        for width in [44, 79, 99] {
            let text = menu(&Ui::plain(width));
            for (key, name, _) in COMMANDS.iter() {
                assert_eq!(text.matches(&format!("[{key}]")).count(), 1);
                assert!(text.contains(name));
            }
            assert!(text.lines().all(|line| line.chars().count() <= width));
        }
    }

    #[cfg(windows)]
    #[test]
    fn development_child_failures_keep_output_and_exit_codes() {
        let error = execute(
            &Step {
                tool: "cmd.exe",
                arguments: vec![
                    "/d",
                    "/c",
                    "echo stdout message & echo stderr message 1>&2 & exit /b 7",
                ],
                label: "Failing fixture",
            },
            false,
        )
        .unwrap_err();
        assert_eq!(error.code.as_deref(), Some("E32"));
        assert_eq!(exit_code(&error), 7);
        assert!(
            error
                .details
                .iter()
                .any(|line| line.contains("stdout message"))
        );
        assert!(
            error
                .details
                .iter()
                .any(|line| line.contains("stderr message"))
        );
    }
}
