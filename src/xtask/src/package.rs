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
    let toolchain = toolchain()?;
    let (executable, packages) = builder::build(&root, &toolchain)?;
    with_distribution(&root, |dist| {
        ymb_sdk::distribution::with_work(dist, "stage", |archive_root| {
            builder::stage(
                &root,
                &archive_root.join("YMB"),
                &executable,
                &packages,
                &toolchain,
            )?;
            let archive = dist.join(format!("YMB-{}-windows-x64.zip", metadata::VERSION));
            ymb_sdk::distribution::zip_directory(archive_root, &archive)?;
            println!(
                "{}",
                crate::messages::format(
                    "package.package.packaged_arg0_arg1_bytes",
                    &[
                        (
                            "ARG0",
                            format!(
                                "{}",
                                root.join("dist")
                                    .join(archive.file_name().unwrap())
                                    .display()
                            )
                        ),
                        (
                            "ARG1",
                            format!(
                                "{}",
                                fs::metadata(&archive)
                                    .map_err(|cause| Diagnostic::io(&archive, cause))?
                                    .len()
                            )
                        )
                    ]
                )
            );
            Ok(())
        })
    })
}
