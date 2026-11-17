use crate::config::Context;
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};
use ymb_core::{Diagnostic, Result, paths};

pub struct OperationLock {
    root: PathBuf,
    file: Option<fs::File>,
    token: String,
}
impl OperationLock {
    pub fn acquire(context: &Context, command: &str) -> Result<Self> {
        check_lock_path(&context.lock, &context.lock)?;
        if let Some(parent) = context.lock.parent() {
            fs::create_dir_all(parent).map_err(|e| Diagnostic::io(parent, e))?;
        }
        if context.lock.exists() {
            let observed = paths::read_limited(&context.lock.join("owner.json"), 16384).ok();
            if !stale_lock(&context.lock)? {
                return Err(lock_error(&context.lock));
            }
            let reclaim = context.lock.with_extension("reclaim");
            fs::create_dir(&reclaim).map_err(|_| lock_error(&reclaim))?;
            let result = (|| -> Result<()> {
                if paths::read_limited(&context.lock.join("owner.json"), 16384).ok() != observed
                    || !stale_lock(&context.lock)?
                {
                    return Err(lock_error(&context.lock));
                }
                let displaced = paths::temporary_sibling(&context.lock);
                paths::rename(&context.lock, &displaced).map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::AlreadyExists => {
                        lock_error(&context.lock)
                    }
                    _ => Diagnostic::io(&context.lock, e),
                })?;
                fs::remove_dir_all(&displaced).map_err(|e| Diagnostic::io(&displaced, e))
            })();
            let _ = fs::remove_dir(&reclaim);
            result?;
        }
        fs::create_dir(&context.lock).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                lock_error(&context.lock)
            } else {
                Diagnostic::io(&context.lock, e)
            }
        })?;
        let result = (|| -> Result<Self> {
            let token = uuid::Uuid::new_v4().to_string();
            let file_path = context.lock.join("native.lock");
            let file = fs::OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&file_path)
                .map_err(|e| Diagnostic::io(&file_path, e))?;
            file.try_lock().map_err(|_| lock_error(&file_path))?;
            let owner = serde_json::json!({"token":token,"command":command,"pid":std::process::id(),"hostname":hostname(),"startedAt":timestamp()});
            paths::write_atomic(
                &context.lock.join("owner.json"),
                serde_json::to_vec(&owner).unwrap(),
            )?;
            Ok(Self {
                root: context.lock.clone(),
                file: Some(file),
                token,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&context.lock);
        }
        result
    }
}
impl Drop for OperationLock {
    fn drop(&mut self) {
        let owner = paths::read_limited(&self.root.join("owner.json"), 16384)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        if let Some(file) = self.file.take() {
            let _ = file.unlock();
            drop(file);
        }
        if owner
            .as_ref()
            .and_then(|v| v.get("token"))
            .and_then(serde_json::Value::as_str)
            == Some(&self.token)
        {
            let _ = fs::remove_file(self.root.join("owner.json"));
            let _ = fs::remove_file(self.root.join("native.lock"));
            let _ = fs::remove_dir(&self.root);
        }
    }
}
fn stale_lock(root: &Path) -> Result<bool> {
    let path = root.join("owner.json");
    check_lock_path(root, &path)?;
    let owner = paths::read_limited(&path, 16384)
        .ok()
        .filter(|b| b.len() < 16384)
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .unwrap_or_default();
    if let Some(pid) = owner["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= u32::MAX as u64)
    {
        return Ok(owner["hostname"].as_str() == Some(hostname().as_str())
            && !crate::platform::process_alive(pid as u32));
    }
    let age = fs::metadata(root)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map_or(0, |d| d.as_secs());
    Ok(age >= 30)
}
fn check_lock_path(root: &Path, path: &Path) -> Result<()> {
    paths::assert_no_links(root, path).map_err(|error| {
        if error.category == "IoError" {
            lock_error(root).detail(error.to_string())
        } else {
            error
        }
    })
}
fn lock_error(path: &Path) -> Box<Diagnostic> {
    Diagnostic::new(
        "CommandError",
        crate::messages::text("state.lock.lock_error.ymb_s_operation_lock_is_busy_or"),
        crate::messages::text("state.lock.lock_error.wait_for_other_commands_to_finish_then"),
    )
    .at(path)
}
fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "localhost".into())
}
fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = seconds / 86400;
    let z = days as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}
