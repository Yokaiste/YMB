use super::*;

pub(super) use ymb_core::paths::rename;

pub fn recover(root: &Path, work: &Path) -> Result<()> {
    let live = root.join("YMB");
    let before = work.join("before");
    let next = root.join(".ymb-install-next");
    let phase = work.join("phase.json");
    clear_interrupted_lock(&live)?;
    clear_interrupted_lock(&before)?;
    if before.exists() {
        let committed = fs::read(&phase)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|v| v["phase"] == "installed");
        if live.exists() {
            if !committed && !live.join(".ymb-stage").is_file() {
                return Err(error(crate::messages::text(
                    "deploy.transaction.recover.an_interrupted_update_found_an_unrecognized_ymb",
                )));
            }
            remove(work, &before)?;
            let marker = live.join(".ymb-stage");
            if marker.exists() {
                fs::remove_file(&marker).map_err(|e| Diagnostic::io(&marker, e))?;
            }
        } else {
            rename(&before, &live).map_err(|e| Diagnostic::io(&live, e))?;
        }
    }
    if next.exists() && !next.join(".ymb-stage").is_file() {
        return Err(error(crate::messages::text(
            "deploy.transaction.recover.an_unrecognized_ymb_install_next_folder_already",
        )));
    }
    remove(root, &next)?;
    if phase.exists() {
        fs::remove_file(&phase).map_err(|e| Diagnostic::io(&phase, e))?
    }
    Ok(())
}
pub(super) fn install(
    root: &Path,
    work: &Path,
    next: &Path,
    old_lock: &mut Option<BuilderLock>,
) -> Result<()> {
    let live = root.join("YMB");
    let before = work.join("before");
    let phase = work.join("phase.json");
    let mut new_lock = BuilderLock::acquire(next)?;
    paths::write_atomic(
        &phase,
        serde_json::to_vec(&json!({"phase":"prepared"})).unwrap(),
    )?;
    // Windows cannot rename these directories with open lock handles; live owner PIDs still exclude YMB commands.
    drop(new_lock.file.take());
    if let Some(lock) = old_lock.as_mut() {
        drop(lock.file.take());
    }
    if live.exists() {
        rename(&live, &before).map_err(|e| Diagnostic::io(&live, e))?;
        if let Some(lock) = old_lock.as_mut() {
            lock.root = builder_lock_root(&before);
        }
    }
    if let Err(e) = rename(next, &live) {
        if before.exists() {
            rename(&before, &live).map_err(|restore| {
                error(crate::messages::format(
                    "deploy.transaction.install.install_failed_e_restore_failed_restore_keep",
                    &[("E", format!("{}", e)), ("RESTORE", format!("{}", restore))],
                ))
            })?
        }
        if let Some(lock) = old_lock.as_mut() {
            lock.root = builder_lock_root(&live);
        }
        return Err(Diagnostic::io(&live, e));
    }
    new_lock.root = builder_lock_root(&live);
    paths::write_atomic(
        &phase,
        serde_json::to_vec(&json!({"phase":"installed"})).unwrap(),
    )?;
    if let Some(lock) = old_lock.as_mut() {
        lock.release()?;
    }
    new_lock.release()?;
    let marker = live.join(".ymb-stage");
    if marker.exists() {
        fs::remove_file(&marker).map_err(|e| Diagnostic::io(&marker, e))?
    }
    remove(work, &before)?;
    fs::remove_file(&phase).map_err(|e| Diagnostic::io(&phase, e))?;
    Ok(())
}
