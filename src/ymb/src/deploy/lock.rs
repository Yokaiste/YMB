use super::*;

pub(super) struct BuilderLock {
    pub(super) root: PathBuf,
    pub(super) file: Option<fs::File>,
}
impl BuilderLock {
    pub(super) fn acquire(builder: &Path) -> Result<Self> {
        let root = builder_lock_root(builder);
        paths::assert_no_links(builder, &root)?;
        fs::create_dir_all(root.parent().unwrap()).map_err(|e| Diagnostic::io(&root, e))?;
        fs::create_dir(&root).map_err(|_| {
            error(crate::messages::text(
                "deploy.lock.acquire.another_command_is_using_ymb_close_it",
            ))
        })?;
        let result = (|| {
            let file = fs::OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(root.join("native.lock"))
                .map_err(|e| Diagnostic::io(&root, e))?;
            file.try_lock().map_err(|_| {
                error(crate::messages::text(
                    "deploy.lock.acquire.ymb_operation_lock_is_busy",
                ))
            })?;
            let host = std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "localhost".into());
            paths::write_atomic(&root.join("owner.json"),serde_json::to_vec(&json!({"pid":std::process::id(),"hostname":host,"command":"YMB mod installer","token":uuid::Uuid::new_v4().to_string()})).unwrap())?;
            Ok(Self {
                root: root.clone(),
                file: Some(file),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&root);
        }
        result
    }
    pub(super) fn release(&mut self) -> Result<()> {
        drop(self.file.take());
        if self.root.exists() {
            for name in ["native.lock", "owner.json"] {
                let p = self.root.join(name);
                fs::remove_file(&p).map_err(|e| Diagnostic::io(&p, e))?;
            }
            fs::remove_dir(&self.root).map_err(|e| Diagnostic::io(&self.root, e))?;
        }
        Ok(())
    }
}
impl Drop for BuilderLock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
pub(super) fn clear_interrupted_lock(builder: &Path) -> Result<()> {
    let root = builder_lock_root(builder);
    paths::assert_no_links(builder, &root)?;
    if !root.exists() {
        return Ok(());
    }
    let owner = paths::read_limited(&root.join("owner.json"), 16384)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if owner
        .as_ref()
        .is_none_or(|v| v["command"] != "YMB mod installer")
    {
        return Ok(());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("native.lock"))
        .map_err(|e| Diagnostic::io(&root, e))?;
    file.try_lock().map_err(|_| {
        error(crate::messages::text(
            "deploy.lock.clear_interrupted_lock.the_previous_installer_still_owns_its_ymb",
        ))
    })?;
    drop(file);
    for name in ["owner.json", "native.lock"] {
        let p = root.join(name);
        fs::remove_file(&p).map_err(|e| Diagnostic::io(&p, e))?
    }
    fs::remove_dir(&root).map_err(|e| Diagnostic::io(&root, e))?;
    Ok(())
}
