use crate::{
    config::Context,
    platform,
    state::OperationLock,
    ui::{self, Ui},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};
use ymb_core::{Diagnostic, Result, metadata, paths};
use ymb_sdk::compiler::{self, Toolchain};

fn probe(command: &mut Command) -> Result<Output> {
    platform::capture(command, Duration::from_secs(5))
}

pub fn discover(builder: &Path) -> Result<Toolchain> {
    compiler::discover(builder, probe)
}

pub fn discover_for(builder: &Path, minimum: &str) -> Result<Toolchain> {
    compiler::discover_for(builder, minimum, probe)
}

pub fn verify(builder: &Path, toolchain: &Toolchain) -> Result<()> {
    let work = paths::resolve(
        builder,
        &format!(".ymb/engine/probe-{}", uuid::Uuid::new_v4()),
    )?;
    let result = (|| -> Result<()> {
        let source = work.join("probe.rs");
        let executable = work.join(format!("probe{}", std::env::consts::EXE_SUFFIX));
        paths::write_atomic(
            &source,
            r#"#[cfg(windows)]
#[link(name = "kernel32", kind = "raw-dylib")]
unsafe extern "system" { fn GetCurrentProcessId() -> u32; }
fn main() {
    #[cfg(windows)]
    assert_ne!(unsafe { GetCurrentProcessId() }, 0);
    println!("YMB Rust check");
}
"#,
        )?;
        let mut command = toolchain.command(&toolchain.rustc);
        command
            .arg(&source)
            .args(["--edition", "2024", "--target", &toolchain.host, "-o"])
            .arg(&executable);
        if toolchain.host.ends_with("windows-msvc") {
            command.args(["-C", "target-feature=+crt-static"]);
        }
        let output = platform::capture(&mut command, Duration::from_secs(30))?;
        if !output.status.success() || !executable.is_file() {
            return Err(compiler::required()
                .detail(String::from_utf8_lossy(&output.stderr))
                .with("toolchain", toolchain));
        }
        let mut command = Command::new(&executable);
        if let Some(system) = std::env::var_os("SystemRoot") {
            command.env("PATH", PathBuf::from(system).join("System32"));
        }
        let output = platform::capture(&mut command, Duration::from_secs(5))?;
        if !output.status.success() {
            return Err(compiler::required()
                .detail(crate::messages::text(
                    "rust.verify.the_compiled_program_cannot_run_without_external",
                ))
                .with("exitCode", output.status.code()));
        }
        Ok(())
    })();
    if work.exists() {
        paths::remove_tree(&builder.join(".ymb/engine"), &work)?;
    }
    result.map_err(|error| {
        if error.code.as_deref() == Some("E38") {
            error
        } else {
            compiler::required().detail(error.to_string())
        }
    })
}

fn install_error(error: impl std::fmt::Display) -> Box<Diagnostic> {
    Diagnostic::new(
        "RustInstallError",
        crate::messages::text("rust.install_error.automatic_rust_installation_failed"),
        crate::messages::text("rust.install_error.manual_installation_is_recommended_run_ymb_exe"),
    )
    .detail(error.to_string())
}

fn download(url: &str, target: &Path) -> Result<()> {
    let system = std::env::var_os("SystemRoot").ok_or_else(|| {
        install_error(crate::messages::text("common.shared.systemroot_is_missing"))
    })?;
    let curl = PathBuf::from(system).join("System32/curl.exe");
    let output = platform::capture(
        Command::new(&curl)
            .args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--retry",
                "2",
                "--connect-timeout",
                "20",
                "--max-time",
                "600",
                "--max-filesize",
                "134217728",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--output",
            ])
            .arg(target)
            .arg(url),
        Duration::from_secs(620),
    )?;
    if !output.status.success() {
        return Err(install_error(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

fn checksum(text: &str) -> Result<&str> {
    text.split_whitespace()
        .next()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            install_error(crate::messages::text(
                "rust.checksum.the_official_installer_checksum_is_invalid",
            ))
        })
}

fn activate(engine: &Path, staged: &Path) -> Result<()> {
    let backup = engine.with_file_name(format!(
        "{}.previous",
        engine.file_name().unwrap().to_string_lossy()
    ));
    let root = engine.parent().unwrap();
    paths::assert_no_links(root, engine)?;
    paths::assert_no_links(root, &backup)?;
    if backup.exists() {
        if !engine.exists() {
            paths::rename(&backup, engine).map_err(|error| Diagnostic::io(engine, error))?;
        } else {
            paths::remove_tree(root, &backup)?;
        }
    }
    if engine.exists() {
        paths::rename(engine, &backup).map_err(|error| Diagnostic::io(engine, error))?;
    }
    if let Err(error) = paths::rename(staged, engine) {
        if backup.exists() {
            paths::rename(&backup, engine).map_err(|restore| {
                install_error(crate::messages::format(
                    "rust.activate.error_restoring_the_previous_engine_failed_restore",
                    &[
                        ("ERROR", format!("{}", error)),
                        ("RESTORE", format!("{}", restore)),
                    ],
                ))
            })?;
        }
        return Err(Diagnostic::io(engine, error));
    }
    if backup.exists() {
        paths::remove_tree(root, &backup)?;
    }
    Ok(())
}

fn clear_staging(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root).map_err(|error| Diagnostic::io(root, error))? {
        let entry = entry.map_err(|error| Diagnostic::io(root, error))?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix("install-"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            paths::remove_tree(root, &entry.path())?;
        }
    }
    Ok(())
}

pub fn install(context: &Context, version: &str) -> Result<Value> {
    install_portable(context, version).map_err(|error| {
        if error.code.as_deref() == Some("E39") {
            error
        } else {
            install_error(&error).with("cause", &error)
        }
    })
}

fn install_portable(context: &Context, version: &str) -> Result<Value> {
    use std::io::IsTerminal;
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err(install_error(crate::messages::text(
            "rust.install_portable.automatic_installation_supports_windows_x64_install_rust",
        )));
    }
    let version = semver::Version::parse(version).map_err(install_error)?;
    let version = version
        .max(semver::Version::parse(metadata::RUST_VERSION).unwrap())
        .to_string();
    let interactive = std::io::stdin().is_terminal();
    let _input = platform::InputBlock::new(interactive && Ui::stderr().rich);
    let _progress = ui::Progress::start(vec![
        crate::messages::text("rust.install_portable.check_portable_rust").into(),
    ]);
    let engine = paths::resolve(&context.root, &format!(".ymb/engine/{version}-windows-x64"))?;
    let mut engine_context = context.clone();
    engine_context.lock = context.root.join(".ymb/engine/lock");
    let _lock = OperationLock::acquire(&engine_context, "install-rust")?;
    clear_staging(&context.root.join(".ymb/engine"))?;
    let mut installed = Toolchain::portable(&engine, &version);
    if installed.check(&mut probe).is_ok() && verify(&context.root, &installed).is_ok() {
        return Ok(
            json!({"summary":crate::messages::text("common.shared.rust_is_ready"),"toolchain":installed,"installed":false}),
        );
    }
    ui::extend_steps(vec![
        crate::messages::text("rust.install_portable.download_official_installer").into(),
        crate::messages::text("rust.install_portable.install_portable_rust").into(),
        crate::messages::text("rust.install_portable.verify_compiler_and_linker").into(),
        crate::messages::text("rust.install_portable.activate_portable_rust_locally").into(),
    ]);
    let staged = paths::resolve(
        &context.root,
        &format!(".ymb/engine/install-{}", uuid::Uuid::new_v4()),
    )?;
    fs::create_dir_all(&staged).map_err(|error| Diagnostic::io(&staged, error))?;
    let result = (|| -> Result<Value> {
        ui::step(1);
        ui::phase(
            crate::messages::text("rust.install_portable.downloading_the_official_rust_installer")
                .into(),
        );
        let url = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe";
        let rustup = staged.join("rustup.exe");
        let digest = staged.join("rustup.sha256");
        download(url, &rustup)?;
        download(&format!("{url}.sha256"), &digest)?;
        let text = String::from_utf8(paths::read_limited(&digest, 4096)?).map_err(install_error)?;
        if !paths::hash_file(&rustup)?.eq_ignore_ascii_case(checksum(&text)?) {
            return Err(install_error(crate::messages::text(
                "rust.install_portable.the_official_installer_checksum_does_not_match",
            )));
        }
        let mut command = Command::new(&rustup);
        ui::step(2);
        command
            .args([
                "toolchain",
                "install",
                &format!("{version}-{}", compiler::PORTABLE_HOST),
                "--profile",
                "minimal",
                "--component",
                "rust-mingw",
                "--no-self-update",
            ])
            .env("RUSTUP_HOME", staged.join("rustup"))
            .env("CARGO_HOME", staged.join("cargo"))
            .env("RUSTUP_DIST_SERVER", "https://static.rust-lang.org")
            .env("RUSTUP_UPDATE_ROOT", "https://static.rust-lang.org/rustup")
            .env("RUSTUP_AUTO_INSTALL", "0")
            .env_remove("RUSTUP_TOOLCHAIN")
            .env_remove("RUSTC")
            .env_remove("RUSTDOC");
        let output = platform::capture(&mut command, Duration::from_secs(1800))?;
        if !output.status.success() {
            return Err(install_error(String::from_utf8_lossy(&output.stderr)));
        }
        ui::step(3);
        let mut toolchain = Toolchain::portable(&staged, &version);
        toolchain.check(&mut probe)?;
        verify(&context.root, &toolchain)?;
        ui::step(4);
        activate(&engine, &staged)?;
        let mut toolchain = Toolchain::portable(&engine, &version);
        toolchain.check(&mut probe)?;
        Ok(
            json!({"summary":crate::messages::text("rust.install_portable.rust_is_installed_and_ready"),"toolchain":toolchain,"installed":true}),
        )
    })();
    if staged.exists() {
        paths::remove_tree(&context.root.join(".ymb/engine"), &staged)?;
    }
    result
}

fn cancelled() -> Box<Diagnostic> {
    Diagnostic::new(
        "CommandError",
        crate::messages::text("rust.cancelled.action_cancelled"),
        crate::messages::text("rust.cancelled.choose_another_action_when_ready"),
    )
    .code("I2")
}

fn check(context: &Context, minimum: &str) -> Result<Toolchain> {
    let _input = platform::InputBlock::new(true);
    let _progress =
        ui::Progress::start(vec![crate::messages::text("rust.check.check_rust").into()]);
    let toolchain = discover_for(&context.root, minimum)?;
    verify(&context.root, &toolchain)?;
    Ok(toolchain)
}

pub fn check_or_setup(context: &Context, minimum: &str) -> Result<Toolchain> {
    match check(context, minimum) {
        Ok(toolchain) => Ok(toolchain),
        Err(_) => {
            setup(context, minimum)?;
            discover_for(&context.root, minimum)
        }
    }
}

pub fn setup(context: &Context, minimum: &str) -> Result<()> {
    let ui = Ui::stderr();
    let mut last_error: Option<Box<Diagnostic>> = None;
    loop {
        eprint!(
            "{}",
            ui.block("  [E38] ", &compiler::required().reason, ui::Tone::Warn)
        );
        if let Some(error) = last_error.take()
            && error.code.as_deref() != Some("E38")
        {
            eprint!(
                "{}",
                ui.block(
                    &format!("  [{}] ", error.code.as_deref().unwrap_or("E39")),
                    &error.reason,
                    ui::Tone::Bad
                )
            );
            if error.code.as_deref() == Some("E39") {
                eprint!(
                    "{}",
                    ui.block(
                        "  ",
                        crate::messages::text("rust.setup.manual_installation_is_recommended"),
                        ui::Tone::Warn
                    )
                );
            }
        }
        eprint!(
            "{}",
            ui.rows(
                &[
                    (
                        "1",
                        crate::messages::text("rust.setup.automatic"),
                        crate::messages::text("rust.setup.install_portable_rust_for_ymb")
                    ),
                    (
                        "2",
                        crate::messages::text("rust.setup.manual"),
                        crate::messages::text("rust.setup.install_rust_outside_ymb")
                    ),
                    (
                        "0",
                        crate::messages::text("rust.setup.cancel"),
                        crate::messages::text("rust.setup.stop_this_action")
                    ),
                ],
                ui::Tone::Accent
            )
        );
        let choice = match ui::prompt(crate::messages::text("rust.setup.choice")) {
            Ok(choice) => choice,
            Err(error) if error.code.as_deref() == Some("I3") => return Err(cancelled()),
            Err(error) => return Err(error),
        };
        match choice.as_str() {
            "1" => match install(context, minimum) {
                Ok(_) => return Ok(()),
                Err(error) => last_error = Some(error),
            },
            "2" => {
                let instructions = crate::messages::format(
                    "rust.setup.manual_instructions",
                    &[("MINIMUM", minimum.to_string())],
                );
                for line in instructions.lines() {
                    eprint!("{}", ui.block("  ", line, ui::Tone::Strong));
                }
                match ui::prompt(crate::messages::text(
                    "rust.setup.press_enter_to_recheck_or_0_to",
                )) {
                    Ok(answer) if answer == "0" => continue,
                    Ok(_) => match check(context, minimum) {
                        Ok(_) => return Ok(()),
                        Err(error) => last_error = Some(error),
                    },
                    Err(error) if error.code.as_deref() == Some("I3") => return Err(cancelled()),
                    Err(error) => return Err(error),
                }
            }
            "0" => return Err(cancelled()),
            _ => {
                last_error = Some(Diagnostic::new(
                    "CommandError",
                    crate::messages::text("rust.setup.choose_1_2_or_0"),
                    crate::messages::text("rust.setup.use_a_listed_choice"),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_checksums_are_strict_and_activation_preserves_other_engine_data() {
        assert_eq!(
            checksum(&format!("{}  rustup-init.exe\n", "a".repeat(64))).unwrap(),
            "a".repeat(64)
        );
        for text in ["", "1234", &"g".repeat(64)] {
            assert!(checksum(text).is_err());
        }
        let temp = tempfile::tempdir().unwrap();
        let engine = temp.path().join("engine");
        let staged = temp.path().join("install");
        paths::write_atomic(&engine.join("old"), "old compiler").unwrap();
        paths::write_atomic(&staged.join("new"), "new compiler").unwrap();
        paths::write_atomic(&temp.path().join("other-version/keep"), "keep").unwrap();
        activate(&engine, &staged).unwrap();
        assert!(engine.join("new").is_file());
        assert!(!engine.join("old").exists());
        assert!(!staged.exists());
        assert!(temp.path().join("other-version/keep").is_file());
        assert!(activate(&engine, &staged).is_err());
        assert!(engine.join("new").is_file());
    }

    #[test]
    fn setup_reclaims_only_owned_download_staging() {
        let temp = tempfile::tempdir().unwrap();
        let staged = temp
            .path()
            .join(format!("install-{}", uuid::Uuid::new_v4()));
        paths::write_atomic(&staged.join("partial"), "partial download").unwrap();
        paths::write_atomic(&temp.path().join("install-custom/keep"), "keep").unwrap();
        paths::write_atomic(&temp.path().join("1.100.0-windows-x64/keep"), "keep").unwrap();
        clear_staging(temp.path()).unwrap();
        assert!(!staged.exists());
        assert!(temp.path().join("install-custom/keep").exists());
        assert!(temp.path().join("1.100.0-windows-x64/keep").exists());
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn busy_installations_return_the_installation_error_without_removing_the_lock() {
        let temp = tempfile::tempdir().unwrap();
        let context = Context::resolve_recovery(Some(temp.path())).unwrap();
        let mut owner = context.clone();
        owner.lock = context.root.join(".ymb/engine/lock");
        let _lock = OperationLock::acquire(&owner, "install-rust").unwrap();
        let error = install(&context, metadata::RUST_VERSION).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("E39"));
        assert_eq!(error.context["cause"]["code"], "E1");
        assert!(owner.lock.exists());
    }
}
