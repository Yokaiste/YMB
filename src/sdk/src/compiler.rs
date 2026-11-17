use crate::{Result, core::paths};
use std::{path::Path, process::Command};

mod artifact;
mod toolchain;
pub use artifact::{current_executable, source_fingerprint, stamp_executable};
pub use toolchain::{
    PORTABLE_HOST, Toolchain, discover, discover_for, project_requirement, required,
};

pub fn command(builder: &Path, mod_id: &str, manifest: &Path) -> Result<Command> {
    let toolchain = discover(builder, |command| {
        command
            .output()
            .map_err(|error| crate::Diagnostic::io(Path::new(command.get_program()), error))
    })?;
    build_command(builder, mod_id, manifest, &toolchain)
}

pub fn target_directory(builder: &Path, mod_id: &str) -> Result<std::path::PathBuf> {
    paths::resolve(&crate::core::storage::session(builder, mod_id)?, "compiler")
}

pub fn sdk_workspace(root: &Path) -> Result<String> {
    let mut manifest = toolchain::load_manifest(&root.join("Cargo.toml"))?;
    manifest["workspace"]["members"] = toml::Value::Array(vec![
        toml::Value::String("src/core".into()),
        toml::Value::String("src/sdk".into()),
    ]);
    let mut needed = std::collections::HashSet::new();
    for name in ["core", "sdk"] {
        let member = toolchain::load_manifest(&root.join("src").join(name).join("Cargo.toml"))?;
        needed.extend(
            toolchain::dependencies(&member)
                .filter(|(_, value)| {
                    value.get("workspace").and_then(toml::Value::as_bool) == Some(true)
                })
                .map(|(name, _)| name.clone()),
        );
    }
    if let Some(dependencies) = manifest
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("dependencies"))
        .and_then(toml::Value::as_table_mut)
    {
        dependencies.retain(|name, _| needed.contains(name));
    }
    toml::to_string_pretty(&manifest).map_err(|e| {
        crate::Diagnostic::new(
            "ConfigError",
            e.to_string(),
            crate::messages::text("compiler.sdk_workspace.correct_the_sdk_workspace_manifest"),
        )
    })
}

pub fn build_command(
    builder: &Path,
    mod_id: &str,
    manifest: &Path,
    toolchain: &Toolchain,
) -> Result<Command> {
    let target = target_directory(builder, mod_id)?;
    let mut command = toolchain.command(&toolchain.cargo);
    command
        .args([
            "build",
            "--release",
            "--message-format=json-render-diagnostics",
            "--manifest-path",
        ])
        .arg(manifest)
        .arg("--target-dir")
        .arg(target)
        .args(["--target", &toolchain.host])
        .env_remove("CARGO_BUILD_BUILD_DIR");
    #[cfg(windows)]
    command.args([
        "--config",
        r#"target.x86_64-pc-windows-msvc.rustflags=["-C","target-feature=+crt-static"]"#,
    ]);
    Ok(command)
}
