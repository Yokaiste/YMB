use crate::config::Context;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use ymb_core::{Diagnostic, Result, hash, metadata, paths};
use ymb_sdk::protocol::{ContentKind, Payload};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub path: PathBuf,
    pub bytes: u64,
    pub hash: String,
    pub kind: ContentKind,
}
impl Snapshot {
    pub fn payload(&self) -> Payload {
        Payload {
            token: String::new(),
            path: self.path.clone(),
            bytes: self.bytes,
            hash: self.hash.clone(),
            kind: self.kind,
        }
    }
    pub fn read(&self) -> Result<Vec<u8>> {
        let bytes = paths::read_limited(&self.path, self.bytes)?;
        if bytes.len() as u64 != self.bytes || hash(&bytes) != self.hash {
            return Err(Diagnostic::new(
                "IoError",
                crate::messages::text("store.read.a_staged_input_changed_during_this_operation"),
                crate::messages::text("store.read.retry_after_stopping_other_programs_that_edit"),
            )
            .at(&self.path));
        }
        Ok(bytes)
    }
    pub fn text(&self) -> Result<String> {
        String::from_utf8(self.read()?).map_err(|_| {
            Diagnostic::new(
                "InputError",
                crate::messages::text("store.text.text_input_is_not_valid_utf_8"),
                crate::messages::text("store.text.use_a_binary_generator_for_binary_assets"),
            )
            .at(&self.path)
        })
    }
}

pub struct Store {
    valid_ndf: Mutex<std::collections::HashSet<String>>,
    pub root: PathBuf,
}
impl Store {
    pub fn new(context: &Context) -> Result<Self> {
        let root = context
            .work
            .join(format!(".ymb-run-{}", uuid::Uuid::new_v4()));
        paths::assert_no_links(&context.work, &root)?;
        fs::create_dir_all(&root).map_err(|e| Diagnostic::io(&root, e))?;
        Ok(Self {
            root,
            valid_ndf: Mutex::new(std::collections::HashSet::new()),
        })
    }
    pub fn put(&self, bytes: impl AsRef<[u8]>, kind: ContentKind) -> Result<Snapshot> {
        let bytes = bytes.as_ref();
        let hash = hash(bytes);
        let path = self.root.join("blobs").join(&hash);
        if !path.exists() {
            paths::write_atomic_volatile(&path, bytes)?;
        }
        Ok(Snapshot {
            path,
            bytes: bytes.len() as u64,
            hash,
            kind,
        })
    }
    pub fn capture(&self, path: &Path, kind: ContentKind) -> Result<Snapshot> {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Write};
        let before = fs::metadata(path).map_err(|e| Diagnostic::io(path, e))?;
        if !before.is_file() {
            return Err(Diagnostic::new(
                "InputError",
                crate::messages::text("common.shared.input_is_not_a_regular_file"),
                crate::messages::text("store.capture.choose_a_file"),
            )
            .at(path));
        }
        let directory = self.root.join("blobs");
        fs::create_dir_all(&directory).map_err(|e| Diagnostic::io(&directory, e))?;
        let temporary = directory.join(format!(".capture-{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<Snapshot> {
            let mut input = fs::File::open(path).map_err(|e| Diagnostic::io(path, e))?;
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|e| Diagnostic::io(&temporary, e))?;
            let mut digest = Sha256::new();
            let mut bytes = 0;
            let mut buffer = [0; 65536];
            loop {
                let count = input
                    .read(&mut buffer)
                    .map_err(|e| Diagnostic::io(path, e))?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| Diagnostic::io(&temporary, e))?;
                digest.update(&buffer[..count]);
                bytes += count as u64;
            }
            drop(output);
            let after = input.metadata().map_err(|e| Diagnostic::io(path, e))?;
            if bytes != before.len()
                || after.len() != before.len()
                || after.modified().ok() != before.modified().ok()
            {
                return Err(Diagnostic::new(
                    "InputError",
                    crate::messages::text("store.capture.input_changed_while_being_read"),
                    crate::messages::text("store.capture.retry_after_its_writer_finishes"),
                )
                .at(path));
            }
            let hash: String = digest
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let destination = directory.join(&hash);
            paths::rename(&temporary, &destination).map_err(|e| Diagnostic::io(&destination, e))?;
            Ok(Snapshot {
                path: destination,
                bytes,
                hash,
                kind,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
    pub fn validate_ndf(&self, snapshot: &Snapshot, target: &str) -> Result<()> {
        if self.is_validated(snapshot) {
            return Ok(());
        }
        ymb_core::ndf::validate(&snapshot.text()?).map_err(|e| e.at(target))?;
        self.valid_ndf
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(snapshot.hash.clone());
        Ok(())
    }
    pub fn is_validated(&self, snapshot: &Snapshot) -> bool {
        self.valid_ndf
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&snapshot.hash)
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = paths::remove_tree(self.root.parent().unwrap(), &self.root);
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CacheEntry {
    version: u32,
    identity: String,
    namespace: String,
    hash: String,
    bytes: u64,
    used: u64,
}
pub struct Cache {
    root: PathBuf,
    enabled: AtomicBool,
    max_entries: usize,
    max_bytes: u64,
    namespace_entries: usize,
    namespace_bytes: u64,
    gate: RwLock<()>,
    entries: Mutex<Option<BTreeMap<String, CacheEntry>>>,
    notices: Mutex<Vec<serde_json::Value>>,
}
impl Cache {
    pub fn new(context: &Context, enabled: bool) -> Self {
        Self::at(context, context.cache.clone(), enabled)
    }
    pub fn at(context: &Context, root: PathBuf, enabled: bool) -> Self {
        Self {
            root,
            namespace_entries: context
                .config
                .settings
                .generator_cache_max_entries_per_namespace,
            namespace_bytes: context
                .config
                .settings
                .generator_cache_max_bytes_per_namespace,
            enabled: AtomicBool::new(enabled),
            max_entries: context.config.settings.cache_max_entries,
            max_bytes: context.config.settings.cache_max_bytes,
            gate: RwLock::new(()),
            entries: Mutex::new(None),
            notices: Mutex::new(Vec::new()),
        }
    }
    pub fn notice(&self, reason: &str) {
        let notice = serde_json::json!({"code":"W6","reason":reason,"cacheRoot":self.root});
        let mut notices = self.notices.lock().unwrap_or_else(|e| e.into_inner());
        if !notices.contains(&notice) {
            notices.push(notice);
        }
    }
    pub fn take_notices(&self) -> Vec<serde_json::Value> {
        std::mem::take(&mut *self.notices.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn optional<T>(&self, action: impl FnOnce() -> Result<T>, fallback: T) -> Result<T> {
        match action() {
            Err(error) if error.category == "IoError" => {
                self.enabled.store(false, Ordering::Relaxed);
                self.notice(crate::messages::text(
                    "store.optional.cache_storage_is_unavailable_continuing_without_the",
                ));
                Ok(fallback)
            }
            result => result,
        }
    }
    pub fn read(&self, store: &Store, namespace: &str, key: &str) -> Result<Option<Snapshot>> {
        let _guard = self.gate.read().unwrap_or_else(|e| e.into_inner());
        self.optional(|| self.read_inner(store, namespace, key), None)
    }
    pub fn write(&self, namespace: &str, key: &str, snapshot: &Snapshot) -> Result<()> {
        let _guard = self.gate.write().unwrap_or_else(|e| e.into_inner());
        self.optional(|| self.write_inner(namespace, key, snapshot), ())
    }
    pub fn prune(&self) -> Result<()> {
        let _guard = self.gate.write().unwrap_or_else(|e| e.into_inner());
        self.optional(|| self.prune_inner(), ())
    }
    pub fn identity(namespace: &str, key: &str) -> String {
        let build = if namespace.starts_with("generator:") {
            metadata::BUILD_ID
        } else {
            crate::BUILD_ID
        };
        hash(format!(
            "{}:{}:{namespace}:{key}",
            metadata::CACHE_VERSION,
            build
        ))
    }
    fn fits(&self, namespace: &str, bytes: u64) -> bool {
        bytes <= self.max_bytes
            && (!namespace.starts_with("generator:") || bytes <= self.namespace_bytes)
    }
    fn read_inner(&self, store: &Store, namespace: &str, key: &str) -> Result<Option<Snapshot>> {
        if !self.enabled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let identity = Self::identity(namespace, key);
        let path = self.root.join(format!("{identity}.json"));
        paths::assert_no_links(&self.root, &path)?;
        let entry = paths::read_limited(&path, 4096)
            .ok()
            .filter(|bytes| bytes.len() < 4096)
            .and_then(|bytes| serde_json::from_slice::<CacheEntry>(&bytes).ok());
        let Some(mut entry) = entry.filter(|e| {
            e.identity == identity
                && e.namespace == namespace
                && e.version == metadata::CACHE_VERSION
                && self.fits(namespace, e.bytes)
                && crate::state::valid_hash(&e.hash)
        }) else {
            return Ok(None);
        };
        let payload = self.root.join(format!("{identity}.bin"));
        paths::assert_no_links(&self.root, &payload)?;
        if fs::metadata(&payload)
            .ok()
            .is_none_or(|m| !m.is_file() || m.len() != entry.bytes)
        {
            return Ok(None);
        }
        let captured = store.capture(&payload, ContentKind::Binary)?;
        if captured.bytes != entry.bytes || captured.hash != entry.hash {
            return Ok(None);
        }
        let used = now();
        let previous_used = entry.used;
        let mut index = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entries) = index.as_mut()
            && let Some(indexed) = entries.get_mut(&identity)
        {
            indexed.used = indexed.used.max(used);
            entry.used = entry.used.max(indexed.used);
        }
        if previous_used != entry.used.max(used) {
            entry.used = entry.used.max(used);
            paths::write_atomic_volatile(&path, serde_json::to_vec(&entry).unwrap())?;
        }
        Ok(Some(captured))
    }
    fn write_inner(&self, namespace: &str, key: &str, snapshot: &Snapshot) -> Result<()> {
        if !self.enabled.load(Ordering::Relaxed) || !self.fits(namespace, snapshot.bytes) {
            return Ok(());
        }
        let identity = Self::identity(namespace, key);
        let payload = self.root.join(format!("{identity}.bin"));
        paths::assert_no_links(&self.root, &payload)?;
        if !fs::metadata(&payload).is_ok_and(|metadata| metadata.len() == snapshot.bytes)
            || paths::hash_file(&payload).ok().as_deref() != Some(snapshot.hash.as_str())
        {
            paths::copy_atomic_volatile(&snapshot.path, &payload)?;
        }
        let entry = CacheEntry {
            version: metadata::CACHE_VERSION,
            identity: identity.clone(),
            namespace: namespace.into(),
            hash: snapshot.hash.clone(),
            bytes: snapshot.bytes,
            used: now(),
        };
        paths::write_atomic_volatile(
            &self.root.join(format!("{identity}.json")),
            serde_json::to_vec(&entry).unwrap(),
        )?;
        if let Some(entries) = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            entries.insert(identity, entry);
        }
        self.prune_inner()
    }
    fn prune_inner(&self) -> Result<()> {
        if !self.enabled.load(Ordering::Relaxed) || !self.root.exists() {
            return Ok(());
        }
        paths::assert_no_links(&self.root, &self.root)?;
        let mut index = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if index.is_none() {
            let mut entries = BTreeMap::new();
            let files = paths::walk(&self.root, true)?;
            for path in &files {
                if path.extension().is_some_and(|e| e == "json") {
                    let entry = paths::read_limited(path, 4096)
                        .ok()
                        .filter(|b| b.len() < 4096)
                        .and_then(|b| serde_json::from_slice::<CacheEntry>(&b).ok());
                    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    if let Some(entry) = entry.filter(|e| {
                        e.identity == stem
                            && crate::state::valid_hash(stem)
                            && e.version == metadata::CACHE_VERSION
                            && crate::state::valid_hash(&e.hash)
                            && fs::metadata(path.with_extension("bin"))
                                .is_ok_and(|m| m.is_file() && m.len() == e.bytes)
                    }) {
                        entries.insert(entry.identity.clone(), entry);
                    } else {
                        fs::remove_file(path).map_err(|e| Diagnostic::io(path, e))?;
                    }
                } else if !path.extension().is_some_and(|e| e == "bin") {
                    fs::remove_file(path).map_err(|e| Diagnostic::io(path, e))?;
                }
            }
            for path in &files {
                if path.extension().is_some_and(|e| e == "bin")
                    && !entries
                        .contains_key(path.file_stem().and_then(|s| s.to_str()).unwrap_or(""))
                {
                    fs::remove_file(path).map_err(|e| Diagnostic::io(path, e))?;
                }
            }
            *index = Some(entries);
        }
        let entries = index.as_mut().unwrap();
        let mut bytes = entries
            .values()
            .fold(0u64, |sum, e| sum.saturating_add(e.bytes));
        let mut count = entries.len();
        let mut namespaces = std::collections::HashMap::<String, (usize, u64)>::new();
        for entry in entries.values() {
            let total = namespaces.entry(entry.namespace.clone()).or_default();
            total.0 += 1;
            total.1 = total.1.saturating_add(entry.bytes);
        }
        if count <= self.max_entries
            && bytes <= self.max_bytes
            && namespaces.iter().all(|(namespace, (count, bytes))| {
                !namespace.starts_with("generator:")
                    || (*count <= self.namespace_entries && *bytes <= self.namespace_bytes)
            })
        {
            return Ok(());
        }
        let mut order: Vec<_> = entries
            .values()
            .map(|entry| (entry.used, entry.identity.clone()))
            .collect();
        order.sort();
        for (_, identity) in order {
            let entry = &entries[&identity];
            let namespace = &entry.namespace;
            let size = entry.bytes;
            let total = namespaces.get_mut(namespace).unwrap();
            let namespace_over = namespace.starts_with("generator:")
                && (total.0 > self.namespace_entries || total.1 > self.namespace_bytes);
            if namespace_over || count > self.max_entries || bytes > self.max_bytes {
                let path = self.root.join(format!("{identity}.json"));
                fs::remove_file(&path).map_err(|e| Diagnostic::io(&path, e))?;
                let payload = self.root.join(format!("{identity}.bin"));
                if payload.exists() {
                    fs::remove_file(&payload).map_err(|e| Diagnostic::io(&payload, e))?;
                }
                total.0 -= 1;
                total.1 = total.1.saturating_sub(size);
                count -= 1;
                bytes = bytes.saturating_sub(size);
                entries.remove(&identity);
            }
        }
        Ok(())
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .try_into()
        .unwrap_or(u64::MAX)
}
