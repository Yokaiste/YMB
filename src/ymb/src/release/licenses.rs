use super::*;

fn cache(executable: &Path) -> Result<PathBuf> {
    Ok(executable
        .parent()
        .unwrap()
        .join("licenses")
        .join(paths::hash_file(executable)?))
}

pub fn available(executable: &Path) -> Result<bool> {
    let cache = cache(executable)?;
    Ok(cache.join("THIRD_PARTY_NOTICES.md").is_file()
        && verify_package(&cache, "licenses-manifest.json").is_ok())
}

pub fn prune(executable: &Path) -> Result<()> {
    let binaries = executable.parent().unwrap();
    let licenses = binaries.join("licenses");
    paths::assert_no_links(binaries, &licenses)?;
    let mut keep = std::collections::HashSet::new();
    for entry in fs::read_dir(binaries).map_err(|error| Diagnostic::io(binaries, error))? {
        let path = entry
            .map_err(|error| Diagnostic::io(binaries, error))?
            .path();
        paths::assert_no_links(binaries, &path)?;
        if path.is_file() {
            keep.insert(paths::hash_file(&path)?);
        }
    }
    for entry in fs::read_dir(&licenses).map_err(|error| Diagnostic::io(&licenses, error))? {
        let path = entry
            .map_err(|error| Diagnostic::io(&licenses, error))?
            .path();
        let name = path.file_name().unwrap().to_string_lossy();
        if path.is_dir() && crate::state::valid_hash(&name) && !keep.contains(name.as_ref()) {
            remove(&licenses, &path)?;
        }
    }
    Ok(())
}

pub fn save(executable: &Path, toolchain: &compiler::Toolchain, output: &[u8]) -> Result<()> {
    let cache = cache(executable)?;
    let parent = cache.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| Diagnostic::io(parent, e))?;
    with_work(parent, "stage", |stage| {
        let mut packages = serde_json::Map::new();
        for line in String::from_utf8_lossy(output).lines() {
            let Ok(artifact) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if artifact["reason"] != "compiler-artifact" {
                continue;
            }
            let Some(id) = artifact["package_id"].as_str() else {
                continue;
            };
            if !id.starts_with("registry+") && !id.starts_with("git+") {
                continue;
            }
            let Some(path) = artifact["manifest_path"].as_str() else {
                continue;
            };
            let text = String::from_utf8(paths::read_limited(Path::new(path), 4 << 20)?)
                .map_err(|e| error(e.to_string()))?;
            let data: toml::Value = toml::from_str(&text).map_err(|e| error(e.to_string()))?;
            let package = &data["package"];
            packages.insert(id.into(), json!({"id":id,"source":"compiled dependency","manifest_path":path,"name":package.get("name").and_then(toml::Value::as_str),"version":package.get("version").and_then(toml::Value::as_str),"license":package.get("license").and_then(toml::Value::as_str),"license_file":package.get("license-file").and_then(toml::Value::as_str),"repository":package.get("repository").and_then(toml::Value::as_str)}));
        }
        let ids = packages.keys().cloned().collect();
        notices_with_compiler(
            stage,
            &json!({"packages":packages.into_values().collect::<Vec<_>>()}),
            &ids,
            &toolchain.rustc,
        )?;
        manifest_file(stage)?;
        if cache.exists() {
            remove(parent, &cache)?;
        }
        paths::rename(stage, &cache).map_err(|e| Diagnostic::io(&cache, e))
    })?;
    prune(executable)
}

fn manifest_file(stage: &Path) -> Result<()> {
    manifest(stage, "licenses-manifest.json", metadata::VERSION)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn license_cleanup_keeps_all_current_binaries_and_unknown_material() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first.exe");
        let second = temp.path().join("second.exe");
        paths::write_atomic(&first, "first").unwrap();
        paths::write_atomic(&second, "second").unwrap();
        let licenses = temp.path().join("licenses");
        let stale = licenses.join("0".repeat(64));
        for path in [
            cache(&first).unwrap(),
            cache(&second).unwrap(),
            stale.clone(),
            licenses.join("notes"),
        ] {
            paths::write_atomic(&path.join("NOTICE"), "fixture notice").unwrap();
        }
        let second_cache = cache(&second).unwrap();
        prune(&first).unwrap();
        assert!(cache(&first).unwrap().join("NOTICE").is_file());
        assert!(second_cache.join("NOTICE").is_file());
        assert!(licenses.join("notes/NOTICE").is_file());
        assert!(!stale.exists());
        fs::remove_file(&second).unwrap();
        prune(&first).unwrap();
        assert!(!second_cache.exists());
        assert!(cache(&first).unwrap().join("NOTICE").is_file());
    }
}
