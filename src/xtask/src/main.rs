use paths::copy_atomic as copy;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};
use ymb::ui::{self, Progress};
use ymb_core::{Diagnostic, Result, layout, metadata, ndf, paths};
use ymb_sdk::distribution::remove;
fn main() {
    ymb::ui::configure(false, false);
    if let Err(error) = run(std::env::args_os().skip(1)) {
        eprint!("{}", ymb::ui::Ui::stderr().error(&error, true));
        std::process::exit(1);
    }
}
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned()
}
fn error(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "DevelopmentError",
        reason,
        crate::messages::text("main.error.fix_the_failed_check_and_retry"),
    )
}
fn run(mut arguments: impl ExactSizeIterator<Item = OsString>) -> Result<()> {
    let command = arguments.next();
    let name = command
        .as_ref()
        .map(|command| {
            command.to_str().ok_or_else(|| {
                error(crate::messages::text(
                    "dev.parse.development_commands_must_be_unicode",
                ))
            })
        })
        .transpose()?;
    if name != Some("dev") && arguments.len() > usize::from(matches!(name, Some("scan" | "bench")))
    {
        return Err(error(crate::messages::text(
            "main.run.unexpected_arguments",
        )));
    }
    match name {
        Some("dev") => std::process::exit(dev::run(arguments)),
        Some("build") => {
            let progress = Progress::start(vec![
                crate::messages::text("dev.plan.build_ymb_exe").into(),
                crate::messages::text("main.run.save_ymb_exe").into(),
            ]);
            let root = root();
            check_distribution_paths(&root)?;
            let (executable, _) = package::artifact()?;
            ui::step(1);
            save_executable(&root, &executable)?;
            drop(progress);
            println!(
                "{}",
                crate::messages::format(
                    "main.run.built_dist_arg0",
                    &[("ARG0", layout::EXECUTABLE.to_string())]
                )
            );
            Ok(())
        }
        Some("release" | "package") => package(),
        Some("verify-release") => {
            let progress = Progress::start(vec![
                crate::messages::text("dev.plan.verify_ymb_release").into(),
            ]);
            let root = root();
            check_distribution_paths(&root)?;
            ymb_sdk::distribution::with_locked_dist(&root, verify_release)?;
            drop(progress);
            println!(
                "{}",
                crate::messages::text(
                    "verify.verify_release.verified_executable_cli_json_checksums_static_imports"
                )
            );
            Ok(())
        }
        Some("clean") => {
            let progress = Progress::start(vec![
                crate::messages::text("dev.plan.remove_generated_files").into(),
            ]);
            clean(&root())?;
            drop(progress);
            println!(
                "{}",
                crate::messages::text(
                    "main.run.removed_work_caches_packages_and_copied_executables"
                )
            );
            Ok(())
        }
        Some("scan") => scan(Path::new(&arguments.next().ok_or_else(|| {
            error(crate::messages::text(
                "main.run.scan_needs_a_warno_mod_folder",
            ))
        })?)),
        Some("bench") => bench(Path::new(&arguments.next().ok_or_else(|| {
            error(crate::messages::text("main.run.bench_needs_an_ndf_file"))
        })?)),
        Some("help") | None => {
            println!(
                "{}",
                crate::messages::text("main.run.cargo_xtask_build_release_verify_release_clean")
            );
            Ok(())
        }
        Some(command) => Err(error(crate::messages::format(
            "main.run.unknown_command_command_run_cargo_xtask_help",
            &[("COMMAND", command.to_string())],
        ))),
    }
}
fn clean(root: &Path) -> Result<()> {
    let context = ymb::config::Context::resolve_recovery(Some(root))?;
    let _lock = ymb::operation_lock::OperationLock::acquire(&context, "clean")?;
    if context.journal.exists() {
        return Err(error(crate::messages::text(
            "main.clean.a_builder_operation_is_active_or_interrupted",
        )));
    }
    let output = root.join(".ymb");
    let mut targets = vec![context.work.clone(), context.cache.clone()];
    targets.push(root.join("dist"));
    for name in ["dist", "bin", "notices", "g", "mods", "releases"] {
        targets.push(output.join(name));
    }
    let protected = [
        context.mods,
        context.state,
        context.journal,
        context.lock,
        context.game.join("GameData"),
        context.game.join("CommonData"),
        output.join("engine"),
        root.join(layout::CONFIG),
        root.join(layout::LOCAL_CONFIG),
    ];
    for target in &targets {
        let target = paths::canonical_missing(target)?;
        for path in &protected {
            if paths::overlaps(&target, path)? {
                return Err(error(crate::messages::format(
                    "main.clean.development_cleanup_would_remove_protected_data_at",
                    &[("ARG0", format!("{}", path.display()))],
                )));
            }
        }
        paths::assert_no_links(target.parent().unwrap(), &target)?;
        if target.exists() {
            paths::entries(&target, &[])?;
        }
    }
    check_distribution_paths(root)?;
    ymb_sdk::distribution::with_locked_dist(root, |_| {
        for target in targets {
            remove(target.parent().unwrap(), &target)?;
        }
        Ok(())
    })
}
fn save_executable(root: &Path, executable: &Path) -> Result<()> {
    ymb_sdk::distribution::with_locked_dist(root, |dist| {
        copy(executable, &dist.join(layout::EXECUTABLE))
    })
}

fn check_distribution_paths(root: &Path) -> Result<()> {
    let context = ymb::config::Context::resolve_recovery(Some(root))?;
    let protected = [
        context.mods,
        context.work,
        context.cache,
        context.state,
        context.lock,
        context.journal,
        context.game.join("GameData"),
        context.game.join("CommonData"),
        root.join(layout::CONFIG),
        root.join(layout::LOCAL_CONFIG),
    ];
    for relative in [
        "dist",
        ".ymb/dist-stage",
        ".ymb/dist.previous",
        ".ymb/dist.lock",
    ] {
        for path in &protected {
            if paths::overlaps(&root.join(relative), path)? {
                return Err(error(crate::messages::format(
                    "main.with_distribution.distribution_output_would_overwrite_configured_data_at",
                    &[("ARG0", format!("{}", path.display()))],
                )));
            }
        }
    }
    Ok(())
}
mod dev;
mod inspect;
mod package;
mod verify;
use inspect::{bench, scan};
use package::package;
use verify::verify_release;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unexpected_arguments_are_rejected_before_starting_work() {
        for args in [
            vec!["clean", "--dry-run"],
            vec!["build", "--unknown"],
            vec!["scan", "folder", "extra"],
        ] {
            assert!(run(args.into_iter().map(Into::into)).is_err());
        }
    }

    #[test]
    fn release_tree_keeps_nested_assets_hidden_files_and_empty_directories() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("resources/release/structure");
        let target = temp.path().join("stage");
        paths::write_atomic(&source.join(".ymb/assets/data.bin"), [0, 255, 42]).unwrap();
        fs::create_dir_all(source.join("mods/empty")).unwrap();
        paths::copy_tree(&source, &target).unwrap();
        assert_eq!(
            fs::read(target.join(".ymb/assets/data.bin")).unwrap(),
            [0, 255, 42]
        );
        assert!(target.join("mods/empty").is_dir());
        assert_eq!(paths::walk(&source, true).unwrap().len(), 1);
        assert!(paths::copy_tree(&source, &source.join("nested")).is_err());
    }

    #[test]
    fn clean_removes_builder_work_but_keeps_mods_settings_and_saved_originals() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["build", "cache", "dist", "bin", "state", "transaction"] {
            paths::write_atomic(&temp.path().join(".ymb").join(name).join("keep"), name).unwrap();
        }
        let project = temp.path().join("mods/Example");
        paths::write_atomic(&temp.path().join("dist/old.zip"), "old release").unwrap();
        paths::write_atomic(&project.join("config/generator/Cargo.toml"), "authored").unwrap();
        paths::write_atomic(&project.join("config/patch/keep.yaml"), "authored").unwrap();
        paths::write_atomic(&project.join("config/dist/package.zip"), "generated").unwrap();
        paths::write_atomic(&project.join("config/generator/target/output"), "generated").unwrap();
        paths::write_atomic(&project.join("config/.ymb/g/compiled"), "generated").unwrap();
        paths::write_atomic(
            &temp.path().join(".ymb/mods/example/compiler/cached"),
            "generated",
        )
        .unwrap();
        assert!(clean(temp.path()).is_err());
        assert!(temp.path().join(".ymb/build/keep").is_file());
        fs::remove_dir_all(temp.path().join(".ymb/transaction")).unwrap();
        paths::write_atomic(&temp.path().join(layout::LOCAL_CONFIG), "version: 2\n").unwrap();
        clean(temp.path()).unwrap();
        assert!(temp.path().join(".ymb/state/keep").is_file());
        assert!(temp.path().join(layout::LOCAL_CONFIG).is_file());
        assert!(!temp.path().join(".ymb/build").exists());
        assert!(!temp.path().join(".ymb/cache").exists());
        assert!(!temp.path().join(".ymb/dist").exists());
        assert!(!temp.path().join("dist").exists());
        assert!(project.join("config/dist/package.zip").is_file());
        assert!(project.join("config/generator/target/output").is_file());
        assert!(project.join("config/.ymb/g/compiled").is_file());
        assert!(!temp.path().join(".ymb/mods").exists());
        assert!(project.join("config/patch/keep.yaml").is_file());
        assert!(project.join("config/generator/Cargo.toml").is_file());
    }

    #[test]
    fn clean_cannot_remove_work_while_a_builder_command_owns_it() {
        let temp = tempfile::tempdir().unwrap();
        let context = ymb::config::Context::resolve_recovery(Some(temp.path())).unwrap();
        let work = context.work.join("active");
        paths::write_atomic(&work, "in use").unwrap();
        let lock = ymb::operation_lock::OperationLock::acquire(&context, "build").unwrap();
        assert!(clean(temp.path()).is_err());
        assert_eq!(fs::read_to_string(&work).unwrap(), "in use");
        drop(lock);
        clean(temp.path()).unwrap();
        assert!(!work.exists());
    }

    #[test]
    fn clean_cannot_remove_game_data_from_a_custom_game_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        paths::write_atomic(
            &root.join(layout::CONFIG),
            "version: 2\npaths:\n  gameRoot: dist\n",
        )
        .unwrap();
        let game = root.join("dist/GameData/A.ndf");
        paths::write_atomic(&game, "original game data").unwrap();
        assert!(clean(root).is_err());
        assert_eq!(fs::read_to_string(game).unwrap(), "original game data");
    }

    #[test]
    fn distribution_preparation_cannot_replace_configured_recovery_data() {
        let temp = tempfile::tempdir().unwrap();
        for recovery in [
            "dist/originals",
            ".ymb/dist-stage/originals",
            ".ymb/dist.previous/originals",
        ] {
            paths::write_atomic(
                &temp.path().join(layout::CONFIG),
                format!("version: 2\npaths:\n  recoveryRoot: {recovery}\n"),
            )
            .unwrap();
            let original = temp.path().join(recovery).join("keep");
            paths::write_atomic(&original, "saved original").unwrap();
            assert!(check_distribution_paths(temp.path()).is_err());
            assert_eq!(fs::read_to_string(&original).unwrap(), "saved original");
        }
    }

    #[test]
    fn saving_an_executable_keeps_existing_archives() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("built.exe");
        let archive = root.join("dist/existing.zip");
        paths::write_atomic(&source, "new executable").unwrap();
        paths::write_atomic(&archive, "existing release").unwrap();
        save_executable(root, &source).unwrap();
        assert_eq!(fs::read_to_string(archive).unwrap(), "existing release");
        assert_eq!(
            fs::read_to_string(root.join("dist/YMB.exe")).unwrap(),
            "new executable"
        );
    }
}
mod messages;
