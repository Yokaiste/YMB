use super::*;

pub fn with_dist<T>(root: &Path, prepare: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    locked_dist(root, |dist, backup| {
        let data = backup.parent().unwrap();
        with_work(data, "dist-stage", |work| {
            let staged = work.join("dist");
            fs::create_dir(&staged).map_err(|e| Diagnostic::io(&staged, e))?;
            let value = prepare(&staged)?;
            if dist.exists() {
                paths::rename(dist, backup).map_err(|e| Diagnostic::io(dist, e))?;
            }
            if let Err(cause) = paths::rename(&staged, dist) {
                if backup.exists() {
                    paths::rename(backup, dist).map_err(|e| Diagnostic::io(dist, e))?;
                }
                return Err(Diagnostic::io(dist, cause));
            }
            if backup.exists() {
                remove(data, backup)?;
            }
            Ok(value)
        })
    })
}

pub fn with_locked_dist<T>(root: &Path, access: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    locked_dist(root, |dist, _| access(dist))
}

fn locked_dist<T>(root: &Path, access: impl FnOnce(&Path, &Path) -> Result<T>) -> Result<T> {
    let data = root.join(".ymb");
    let dist = root.join("dist");
    let backup = data.join("dist.previous");
    for path in [&data, &dist, &backup] {
        paths::assert_no_links(root, path)?;
    }
    fs::create_dir_all(&data).map_err(|e| Diagnostic::io(&data, e))?;
    let lock_path = data.join("dist.lock");
    paths::assert_no_links(root, &lock_path)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| Diagnostic::io(&lock_path, e))?;
    lock.try_lock().map_err(|_| {
        error(crate::messages::text(
            "distribution.output.with_dist.another_build_or_release_is_preparing_this",
        ))
    })?;
    if backup.exists() {
        if dist.exists() {
            remove(&data, &backup)?;
        } else {
            paths::rename(&backup, &dist).map_err(|e| Diagnostic::io(&dist, e))?;
        }
    }
    access(&dist, &backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distribution_replacement_preserves_the_previous_release_on_failure_and_removes_stale_files()
    {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        paths::write_atomic(&root.join("dist/old.zip"), "old").unwrap();
        let result: Result<()> = with_dist(root, |stage| {
            paths::write_atomic(&stage.join("new.zip"), "partial")?;
            Err(error("failed"))
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("dist/old.zip")).unwrap(),
            "old"
        );
        with_dist(root, |stage| {
            paths::write_atomic(&stage.join("new.zip"), "new")
        })
        .unwrap();
        assert!(!root.join("dist/old.zip").exists());
        assert_eq!(
            fs::read_to_string(root.join("dist/new.zip")).unwrap(),
            "new"
        );
        assert!(!root.join(".ymb/dist-stage").exists());
    }
}
