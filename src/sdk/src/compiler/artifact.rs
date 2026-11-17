use crate::{
    Diagnostic, Result,
    core::{hash, metadata, paths},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Artifact {
    fingerprint: String,
    executable: String,
    hash: String,
    binary: Option<String>,
}

pub fn source_fingerprint(
    builder: &Path,
    manifest: &Path,
    binary: Option<&str>,
) -> Result<Option<String>> {
    // shortcut: receipts cover project and SDK inputs, add explicit tracking before supporting external includes.
    let project = manifest.parent().unwrap();
    let cargo = super::toolchain::load_manifest(manifest)?;
    // Build scripts may read external inputs; let Cargo validate those projects on every action.
    if project.join("build.rs").is_file()
        || cargo
            .get("package")
            .and_then(|package| package.get("build"))
            .is_some_and(|build| build.as_bool() != Some(false))
    {
        return Ok(None);
    }
    let sdk = if builder.join("sdk/Cargo.toml").is_file() {
        builder.join("sdk")
    } else if !builder.join("src/sdk").is_dir() {
        let Some(path) = cargo
            .get("dependencies")
            .and_then(|dependencies| dependencies.get("ymb-sdk"))
            .and_then(|dependency| dependency.get("path"))
            .and_then(toml::Value::as_str)
        else {
            return Ok(None);
        };
        let sdk_crate = paths::canonical_missing(&project.join(path))?;
        let Some(sdk) = sdk_crate.parent().and_then(Path::parent) else {
            return Ok(None);
        };
        sdk.to_owned()
    } else {
        builder.to_owned()
    };
    for (name, dependency) in super::toolchain::dependencies(&cargo) {
        if name != "ymb-sdk"
            && let Some(path) = dependency.get("path").and_then(toml::Value::as_str)
            && paths::strip_prefix(project, &paths::canonical_missing(&project.join(path))?)
                .is_none()
        {
            return Ok(None);
        }
    }
    let mut inputs = BTreeMap::new();
    let mut total = 0u64;
    for (label, root, skip) in [
        (
            "project",
            project.to_owned(),
            vec!["bin", "target", ".ymb", ".git", "dist"],
        ),
        ("core", sdk.join("src/core"), vec!["target"]),
        ("sdk", sdk.join("src/sdk"), vec!["target"]),
    ] {
        if !root.is_dir() {
            return Ok(None);
        }
        for path in paths::entries(&root, &skip)? {
            if !path.is_file() {
                continue;
            }
            total = total.saturating_add(
                fs::metadata(&path)
                    .map_err(|error| Diagnostic::io(&path, error))?
                    .len(),
            );
            if inputs.len() >= 50_000 || total > 512 << 20 {
                return Ok(None);
            }
            inputs.insert(
                format!(
                    "{label}/{}",
                    path.strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                ),
                paths::hash_file(&path)?,
            );
        }
    }
    for package in ["core", "sdk"] {
        let catalog = sdk
            .join("resources/messages/en")
            .join(format!("{package}.json"));
        if catalog.is_file() {
            inputs.insert(format!("messages/{package}"), paths::hash_file(&catalog)?);
        }
    }
    inputs.insert("workspace".into(), hash(super::sdk_workspace(&sdk)?));
    Ok(Some(hash(
        serde_json::to_vec(&(metadata::PLUGIN_VERSION, metadata::VERSION, binary, inputs)).unwrap(),
    )))
}

fn read(path: &Path, fingerprint: &Option<String>, binary: Option<&str>) -> Option<Artifact> {
    let fingerprint = fingerprint.as_ref()?;
    let receipt: Artifact =
        serde_json::from_slice(&paths::read_limited(path, 16 << 10).ok()?).ok()?;
    (receipt.fingerprint == *fingerprint && receipt.binary.as_deref() == binary).then_some(receipt)
}

pub fn current_executable(
    executable: &Path,
    fingerprint: &Option<String>,
    binary: Option<&str>,
) -> Result<bool> {
    let receipt_path = executable.with_extension("exe.ymb.json");
    paths::assert_no_links(executable.parent().unwrap(), &receipt_path)?;
    Ok(
        read(&receipt_path, fingerprint, binary).is_some_and(|receipt| {
            receipt.executable == executable.file_name().unwrap().to_string_lossy()
                && paths::hash_file(executable).ok().as_deref() == Some(receipt.hash.as_str())
        }),
    )
}

pub fn stamp_executable(
    builder: &Path,
    manifest: &Path,
    binary: Option<&str>,
    executable: &Path,
) -> Result<()> {
    let Some(fingerprint) = source_fingerprint(builder, manifest, binary)? else {
        return Ok(());
    };
    let receipt = Artifact {
        fingerprint,
        executable: executable
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        hash: paths::hash_file(executable)?,
        binary: binary.map(str::to_owned),
    };
    paths::write_atomic(
        &executable.with_extension("exe.ymb.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_reject_changed_source_sdk_and_executable_and_keep_settings_separate() {
        let temp = tempfile::tempdir().unwrap();
        let builder = temp.path();
        let manifest = builder.join("mods/a/config/generator/Cargo.toml");
        paths::write_atomic(&manifest, "[package]\nname='fixture'\nversion='0.1.0'\n").unwrap();
        paths::write_atomic(
            &manifest.parent().unwrap().join("src/main.rs"),
            "fn main() {}\n",
        )
        .unwrap();
        for name in ["src/core/src/lib.rs", "src/sdk/src/lib.rs"] {
            paths::write_atomic(&builder.join(name), "fixture").unwrap();
        }
        paths::write_atomic(
            &builder.join("Cargo.toml"),
            "[workspace]\nmembers = ['src/core', 'src/sdk', 'src/ymb']\n",
        )
        .unwrap();
        for name in ["core", "sdk"] {
            paths::write_atomic(
                &builder.join(format!("src/{name}/Cargo.toml")),
                "[package]\nname='fixture'\nversion='0.1.0'\n",
            )
            .unwrap();
        }
        let executable = manifest.parent().unwrap().join("bin/fixture.exe");
        paths::write_atomic(&executable, "compiled fixture").unwrap();
        stamp_executable(builder, &manifest, Some("fixture"), &executable).unwrap();
        let fingerprint = source_fingerprint(builder, &manifest, Some("fixture")).unwrap();
        paths::write_atomic(
            &builder.join("Cargo.toml"),
            super::super::sdk_workspace(builder).unwrap(),
        )
        .unwrap();
        assert_eq!(
            fingerprint,
            source_fingerprint(builder, &manifest, Some("fixture")).unwrap()
        );
        assert!(current_executable(&executable, &fingerprint, Some("fixture")).unwrap());
        paths::write_atomic(&builder.join("resources/messages/en/ymb.json"), "{}").unwrap();
        assert_eq!(
            fingerprint,
            source_fingerprint(builder, &manifest, Some("fixture")).unwrap()
        );
        paths::write_atomic(&builder.join("resources/messages/en/core.json"), "{}").unwrap();
        assert_ne!(
            fingerprint,
            source_fingerprint(builder, &manifest, Some("fixture")).unwrap()
        );
        std::fs::remove_file(builder.join("resources/messages/en/core.json")).unwrap();
        paths::write_atomic(
            &manifest
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("ymb.mod.yaml"),
            "changed settings",
        )
        .unwrap();
        assert_eq!(
            fingerprint,
            source_fingerprint(builder, &manifest, Some("fixture")).unwrap()
        );
        paths::write_atomic(&builder.join("src/sdk/src/lib.rs"), "updated SDK").unwrap();
        assert!(
            !current_executable(
                &executable,
                &source_fingerprint(builder, &manifest, Some("fixture")).unwrap(),
                Some("fixture")
            )
            .unwrap()
        );
        paths::write_atomic(&executable, "damaged binary").unwrap();
        assert!(!current_executable(&executable, &fingerprint, Some("fixture")).unwrap());
        paths::write_atomic(
            &manifest.parent().unwrap().join("build.rs"),
            "fn main() {}\n",
        )
        .unwrap();
        assert!(
            source_fingerprint(builder, &manifest, Some("fixture"))
                .unwrap()
                .is_none()
        );
    }
}
