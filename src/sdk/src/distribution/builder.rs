use super::*;
use crate::{compiler, core::metadata};

pub fn build(
    root: &Path,
    toolchain: &compiler::Toolchain,
) -> Result<(PathBuf, std::collections::HashSet<String>)> {
    let stdout = execute(toolchain.command(&toolchain.cargo).current_dir(root).args([
        "build",
        "--release",
        "--locked",
        "--package",
        "ymb",
        "--message-format=json",
        "--target",
        &toolchain.host,
    ]))?;
    let messages: Vec<_> = String::from_utf8_lossy(&stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| v["reason"] == "compiler-artifact")
        .collect();
    let packages = messages
        .iter()
        .filter_map(|v| v["package_id"].as_str().map(str::to_owned))
        .collect();
    let executable = messages
        .iter()
        .find_map(|v| v["executable"].as_str().map(PathBuf::from))
        .ok_or_else(|| {
            error(crate::messages::text(
                "distribution.builder.build.cargo_did_not_return_the_builder_executable",
            ))
        })?;
    Ok((executable, packages))
}
pub fn stage(
    root: &Path,
    stage: &Path,
    executable: &Path,
    packages: &HashSet<String>,
    toolchain: &compiler::Toolchain,
) -> Result<()> {
    let sdk = stage.join(layout::SDK);
    paths::copy_tree(&root.join("resources/release/structure"), stage)?;
    paths::copy_atomic(executable, &stage.join(layout::EXECUTABLE))?;
    for file in ["README.md", "LICENSE", "NOTICE", layout::CONFIG] {
        paths::copy_atomic(&root.join(file), &stage.join(file))?;
    }
    paths::copy_tree(&root.join("docs"), &stage.join("docs"))?;
    paths::copy_tree_filtered(
        &root.join("resources"),
        &stage.join("resources"),
        &["release/structure"],
    )?;
    let cargo_config_path = root.join(".cargo/config.toml");
    let mut cargo_config: toml::Value = toml::from_str(
        &fs::read_to_string(&cargo_config_path)
            .map_err(|e| Diagnostic::io(&cargo_config_path, e))?,
    )
    .map_err(|e| error(e.to_string()))?;
    cargo_config.as_table_mut().unwrap().remove("alias");
    cargo_config["build"]["target-dir"] = toml::Value::String("../.ymb/target".into());
    let portable_config =
        toml::to_string_pretty(&cargo_config).map_err(|e| error(e.to_string()))?;
    paths::write_atomic(&sdk.join(".cargo/config.toml"), &portable_config)?;
    paths::copy_tree(&root.join("src/fixtures"), &sdk.join("src/fixtures"))?;
    for name in ["core", "sdk"] {
        paths::copy_tree(&root.join("src").join(name), &sdk.join("src").join(name))?;
        let catalog = format!("resources/messages/en/{name}.json");
        paths::copy_atomic(&root.join(&catalog), &sdk.join(&catalog))?;
    }
    for file in ["LICENSE", "NOTICE"] {
        paths::copy_atomic(&root.join(file), &sdk.join(file))?;
    }
    paths::write_atomic(&sdk.join("Cargo.toml"), compiler::sdk_workspace(root)?)?;
    execute(
        toolchain
            .command(&toolchain.cargo)
            .current_dir(sdk)
            .args(["generate-lockfile", "--offline"]),
    )?;
    licenses(root, stage, packages, toolchain)?;
    let imports = imports(&stage.join(layout::EXECUTABLE))?;
    for library in &imports {
        let lower = library.to_lowercase();
        if ["vcruntime", "msvcp", "ucrtbase", "bun", "node"]
            .iter()
            .any(|bad| lower.contains(bad))
        {
            return Err(error(crate::messages::format(
                "distribution.builder.stage.unexpected_runtime_import_library",
                &[("LIBRARY", library.to_string())],
            )));
        }
    }
    let mut manifest = manifest(stage, "release-manifest.json", metadata::VERSION)?;
    for (key, value) in [
        ("configVersion", metadata::CONFIG_VERSION),
        ("jsonVersion", metadata::JSON_VERSION),
        ("pluginVersion", metadata::PLUGIN_VERSION),
        ("stateVersion", metadata::STATE_VERSION),
        ("journalVersion", metadata::JOURNAL_VERSION),
        ("cacheVersion", metadata::CACHE_VERSION),
    ] {
        manifest[key] = json!(value);
    }
    manifest["imports"] = json!(imports);
    paths::write_atomic(
        &stage.join("release-manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
}
fn licenses(
    root: &Path,
    stage: &Path,
    packages: &std::collections::HashSet<String>,
    toolchain: &compiler::Toolchain,
) -> Result<()> {
    let stdout = execute(toolchain.command(&toolchain.cargo).current_dir(root).args([
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        &toolchain.host,
    ]))?;
    let metadata: Value = serde_json::from_slice(&stdout).map_err(|e| error(e.to_string()))?;
    notices_with_compiler(stage, &metadata, packages, &toolchain.rustc)
}
fn imports(path: &Path) -> Result<Vec<String>> {
    let bytes = fs::read(path).map_err(|e| Diagnostic::io(path, e))?;
    let u16_at = |at: usize| -> Result<usize> {
        Ok(u16::from_le_bytes(
            bytes
                .get(at..at + 2)
                .ok_or_else(|| {
                    error(crate::messages::text(
                        "distribution.builder.imports.truncated_pe_header",
                    ))
                })?
                .try_into()
                .unwrap(),
        ) as usize)
    };
    let u32_at = |at: usize| -> Result<usize> {
        Ok(u32::from_le_bytes(
            bytes
                .get(at..at + 4)
                .ok_or_else(|| {
                    error(crate::messages::text(
                        "distribution.builder.imports.truncated_pe_header",
                    ))
                })?
                .try_into()
                .unwrap(),
        ) as usize)
    };
    if bytes.get(..2) != Some(b"MZ") {
        return Err(error(crate::messages::text(
            "distribution.builder.imports.executable_has_no_dos_header",
        )));
    }
    let pe = u32_at(60)?;
    if bytes.get(pe..pe + 4) != Some(b"PE\0\0") {
        return Err(error(crate::messages::text(
            "distribution.builder.imports.executable_has_no_pe_header",
        )));
    }
    let count = u16_at(pe + 6)?;
    let optional = pe + 24;
    if u16_at(optional)? != 0x20b {
        return Err(error(crate::messages::text(
            "distribution.builder.imports.release_is_not_a_64_bit_pe",
        )));
    }
    let sections = optional + u16_at(pe + 20)?;
    let offset = |rva: usize| -> Result<usize> {
        for section in 0..count {
            let at = sections + section * 40;
            let start = u32_at(at + 12)?;
            let size = u32_at(at + 8)?.max(u32_at(at + 16)?);
            if rva >= start && rva < start.saturating_add(size) {
                return Ok(u32_at(at + 20)? + rva - start);
            }
        }
        Err(error(crate::messages::text(
            "distribution.builder.imports.invalid_pe_import_address",
        )))
    };
    let mut descriptor = offset(u32_at(optional + 112 + 8)?)?;
    let mut imports = Vec::new();
    for _ in 0..256 {
        let name = u32_at(descriptor + 12)?;
        if name == 0 {
            return Ok(imports);
        }
        let at = offset(name)?;
        let tail = bytes.get(at..).ok_or_else(|| {
            error(crate::messages::text(
                "distribution.builder.imports.truncated_pe_import",
            ))
        })?;
        let end = tail.iter().take(256).position(|b| *b == 0).ok_or_else(|| {
            error(crate::messages::text(
                "distribution.builder.imports.invalid_pe_library_name",
            ))
        })?;
        imports.push(String::from_utf8(tail[..end].to_vec()).map_err(|e| error(e.to_string()))?);
        descriptor += 20;
    }
    Err(error(crate::messages::text(
        "distribution.builder.imports.too_many_pe_imports",
    )))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn source_releases_leave_the_running_host_executable_untouched() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        paths::write_atomic(
            &root.path().join("Cargo.toml"),
            "[package]\nname='ymb'\nversion='0.1.0'\nedition='2024'\n[workspace]\n",
        )
        .unwrap();
        paths::write_atomic(
            &root.path().join("Cargo.lock"),
            "version = 4\n[[package]]\nname = 'ymb'\nversion = '0.1.0'\n",
        )
        .unwrap();
        paths::write_atomic(
            &root.path().join(".cargo/config.toml"),
            "[build]\ntarget-dir='output'\n",
        )
        .unwrap();
        paths::write_atomic(
            &root.path().join("src/main.rs"),
            "fn main() { println!(\"fixture builder\"); }\n",
        )
        .unwrap();
        let running = root.path().join("output/release/ymb.exe");
        paths::write_atomic(&running, "running host executable").unwrap();
        let _held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&running)
            .unwrap();
        let toolchain = compiler::discover(root.path(), |command| {
            command.output().map_err(|cause| error(cause.to_string()))
        })
        .unwrap();
        let (executable, _) = build(root.path(), &toolchain).unwrap();
        assert_ne!(executable, running);
        assert_eq!(
            fs::read_to_string(&running).unwrap(),
            "running host executable"
        );
        assert_eq!(
            String::from_utf8(execute(&mut Command::new(executable)).unwrap())
                .unwrap()
                .trim(),
            "fixture builder"
        );
    }
    #[test]
    fn malformed_pe_does_not_panic() {
        assert!(
            imports(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("Cargo.toml")
                    .as_path()
            )
            .is_err()
        );
    }
}
