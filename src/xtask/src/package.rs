use super::*;
use ymb_sdk::{compiler, distribution::builder};

fn toolchain() -> Result<compiler::Toolchain> {
    compiler::discover(&root(), |command| {
        command.output().map_err(|cause| error(cause.to_string()))
    })
}

pub(super) fn artifact() -> Result<(PathBuf, std::collections::HashSet<String>)> {
    builder::build(&root(), &toolchain()?)
}

pub(super) fn package() -> Result<()> {
    let root = root();
    let progress = Progress::start(vec![
        crate::messages::text("dev.plan.build_ymb_exe").into(),
        crate::messages::text("package.package.create_archive").into(),
        crate::messages::text("dev.plan.verify_ymb_release").into(),
        crate::messages::text("package.package.save_archive").into(),
    ]);
    check_distribution_paths(&root)?;
    let toolchain = toolchain()?;
    let (executable, packages) = builder::build(&root, &toolchain)?;
    ui::step(1);
    let (name, bytes) = ymb_sdk::distribution::with_dist(&root, |dist| {
        ymb_sdk::distribution::with_work(dist, "stage", |archive_root| {
            builder::stage(
                &root,
                &archive_root.join("YMB"),
                &executable,
                &packages,
                &toolchain,
            )?;
            let name = archive_name();
            let archive = dist.join(&name);
            ymb_sdk::distribution::zip_directory(archive_root, &archive)?;
            let bytes = fs::metadata(&archive)
                .map_err(|cause| Diagnostic::io(&archive, cause))?
                .len();
            Ok((name, bytes))
        })
        .and_then(|release| {
            ui::step(2);
            verify_release(dist)?;
            ui::step(3);
            Ok(release)
        })
    })?;
    drop(progress);
    println!(
        "{}",
        crate::messages::format(
            "package.package.packaged_arg0_arg1_bytes",
            &[
                ("ARG0", paths::display(root.join("dist").join(name))),
                ("ARG1", bytes.to_string())
            ],
        )
    );
    Ok(())
}

pub(super) fn archive_name() -> String {
    format!("YMB-{}-windows-x64.zip", metadata::VERSION)
}
