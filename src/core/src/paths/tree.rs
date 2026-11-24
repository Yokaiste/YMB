use super::*;

pub fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    copy_tree_filtered(source, target, &[])
}

fn skipped(relative: &str, skip: &[&str]) -> bool {
    let relative = key(relative);
    skip.iter().any(|path| {
        let path = key(path);
        relative == path || relative.starts_with(&format!("{path}/"))
    })
}

pub fn walk(root: &Path, reject_links: bool) -> Result<Vec<PathBuf>> {
    if !root.try_exists().map_err(|e| Diagnostic::io(root, e))? {
        return Ok(Vec::new());
    }
    collect(root, &[], reject_links, false)
}

pub fn entries(root: &Path, skip: &[&str]) -> Result<Vec<PathBuf>> {
    collect(root, skip, true, true)
}

fn collect(
    root: &Path,
    skip: &[&str],
    reject_links: bool,
    include_directories: bool,
) -> Result<Vec<PathBuf>> {
    if reject_links {
        assert_no_links(root, root)?;
    }
    let mut pending = vec![root.to_owned()];
    let mut result = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|e| Diagnostic::io(&directory, e))? {
            let path = entry.map_err(|e| Diagnostic::io(&directory, e))?.path();
            let relative = path.strip_prefix(root).unwrap().to_string_lossy();
            if skipped(&relative, skip) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|e| Diagnostic::io(&path, e))?;
            if is_link(&metadata) {
                if reject_links {
                    return Err(path_error(
                        &path.to_string_lossy(),
                        crate::messages::text(
                            "paths.tree.collect.this_authored_tree_contains_a_symlink_or",
                        ),
                    ));
                }
                continue;
            }
            if metadata.is_dir() {
                pending.push(path.clone());
                if !include_directories {
                    continue;
                }
            } else if !metadata.is_file() {
                if include_directories {
                    return Err(path_error(
                        &path.to_string_lossy(),
                        crate::messages::text(
                            "paths.tree.collect.copy_sources_must_contain_regular_files_and",
                        ),
                    ));
                }
                continue;
            }
            result.push(path);
        }
    }
    result.sort_by_cached_key(|path| key(path.to_string_lossy()));
    Ok(result)
}

pub fn copy_tree_filtered(source: &Path, target: &Path, skip: &[&str]) -> Result<()> {
    if overlaps(source, target)? {
        let source = canonical_missing(source)?;
        let target = canonical_missing(target)?;
        let excluded = strip_prefix(&source, &target).is_some_and(|relative| {
            !relative.as_os_str().is_empty() && skipped(&relative.to_string_lossy(), skip)
        });
        if !excluded {
            return Err(path_error(
                &target.to_string_lossy(),
                crate::messages::text(
                    "paths.tree.copy_tree_filtered.copy_source_and_destination_must_not_overlap",
                ),
            ));
        }
    }
    assert_no_links(target, target)?;
    let entries = entries(source, skip)?;
    fs::create_dir_all(target).map_err(|e| Diagnostic::io(target, e))?;
    for source_path in entries {
        let relative = source_path
            .strip_prefix(source)
            .unwrap()
            .to_str()
            .ok_or_else(|| {
                path_error(
                    &source.to_string_lossy(),
                    crate::messages::text(
                        "paths.tree.copy_tree_filtered.filenames_must_be_valid_unicode",
                    ),
                )
            })?;
        let destination = resolve(target, relative)?;
        if source_path.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| Diagnostic::io(&destination, e))?;
        } else {
            copy_atomic(&source_path, &destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_share_validation_and_preserve_hidden_files_and_empty_directories() {
        let root = std::env::temp_dir().join(format!("ymb-tree-{}", uuid::Uuid::new_v4()));
        let source = root.join("src");
        write_atomic(&source.join(".hidden/雪.bin"), [0, 255, 42]).unwrap();
        write_atomic(&source.join("ignored/data"), "skip").unwrap();
        write_atomic(&source.join("ignored-neighbor/data"), "keep").unwrap();
        fs::create_dir_all(source.join("empty/nested")).unwrap();
        let plain = root.join("plain");
        let filtered = root.join("filtered");
        copy_tree(&source, &plain).unwrap();
        copy_tree_filtered(&source, &filtered, &["IGNORED/"]).unwrap();
        for target in [&plain, &filtered] {
            assert_eq!(
                fs::read(target.join(".hidden/雪.bin")).unwrap(),
                [0, 255, 42]
            );
            assert!(target.join("empty/nested").is_dir());
            assert_eq!(
                fs::read(target.join("ignored-neighbor/data")).unwrap(),
                b"keep"
            );
        }
        assert!(plain.join("ignored/data").is_file());
        assert!(!filtered.join("ignored").exists());
        for skip in [&[][..], &["ignored"][..]] {
            let nested = source.join("nested");
            assert!(copy_tree_filtered(&source, &nested, skip).is_err());
            assert!(!nested.exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
