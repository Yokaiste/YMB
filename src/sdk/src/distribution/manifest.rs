use super::*;

pub fn manifest(root: &Path, name: &str, version: &str) -> Result<Value> {
    let mut checks = serde_json::Map::new();
    for file in files(root, &[name])? {
        checks.insert(
            file.strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
            json!(paths::hash_file(&file)?),
        );
    }
    let value = json!({"version":version,"rustRequirement":crate::core::metadata::RUST_VERSION,"files":checks});
    let bytes = serde_json::to_vec_pretty(&value).unwrap();
    if bytes.len() > 16 << 20 {
        return Err(error(crate::messages::text(
            "distribution.manifest.manifest.package_metadata_exceeds_the_16_mib_read",
        )));
    }
    paths::write_atomic(&root.join(name), bytes)?;
    Ok(value)
}
pub fn verify_manifest(root: &Path, name: &str) -> Result<Value> {
    let data = paths::read_limited(&root.join(name), 16 << 20)?;
    let manifest: Value = serde_json::from_slice(&data).map_err(|e| error(e.to_string()))?;
    let entries = manifest["files"]
        .as_object()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            error(crate::messages::text(
                "distribution.manifest.verify_manifest.package_manifest_has_no_files",
            ))
        })?;
    let mut names = HashSet::new();
    for (name, expected) in entries {
        if paths::relative(name)? != *name || !names.insert(paths::key(name)) {
            return Err(error(crate::messages::format(
                "distribution.manifest.verify_manifest.invalid_or_aliased_manifest_path_name",
                &[("NAME", name.to_string())],
            )));
        }
        let path = paths::resolve(root, name)?;
        if Some(paths::hash_file(&path)?.as_str()) != expected.as_str() {
            return Err(error(crate::messages::format(
                "distribution.manifest.verify_manifest.package_checksum_failed_name",
                &[("NAME", name.to_string())],
            )));
        }
    }
    Ok(manifest)
}
pub fn verify_package(root: &Path, name: &str) -> Result<Value> {
    let manifest = verify_manifest(root, name)?;
    let expected: HashSet<_> = manifest["files"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let actual = files(root, &[name])?;
    if actual.len() != expected.len()
        || actual.iter().any(|path| {
            !expected.contains(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
                    .as_str(),
            )
        })
    {
        return Err(error(crate::messages::text(
            "distribution.manifest.verify_package.the_package_contains_files_outside_its_checksum",
        )));
    }
    Ok(manifest)
}
pub fn verify_archive(archive: &Path, digest: &str) -> Result<()> {
    let expected = digest.strip_prefix("sha256:").unwrap_or(digest);
    if expected.len() != 64
        || !expected.bytes().all(|c| c.is_ascii_hexdigit())
        || !paths::hash_file(archive)?.eq_ignore_ascii_case(expected)
    {
        return Err(error(crate::messages::format(
            "distribution.manifest.verify_archive.download_checksum_failed_arg0",
            &[("ARG0", format!("{}", archive.display()))],
        )));
    }
    Ok(())
}
