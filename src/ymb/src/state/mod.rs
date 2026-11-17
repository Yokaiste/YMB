use crate::{
    config::Context,
    plan::{Selection, matches},
};
use paths::copy_tree;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use ymb_core::{Diagnostic, Result, hash, metadata, paths};

fn yes() -> bool {
    true
}
fn present() -> String {
    "present".into()
}
pub const MAX_METADATA_BYTES: usize = 64 * 1024 * 1024;
pub fn checked_metadata(bytes: Vec<u8>, path: &Path) -> Result<Vec<u8>> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(Diagnostic::new(
            "InputError",
            crate::messages::text(
                "state.mod.checked_metadata.recovery_metadata_exceeds_the_64_mib_limit",
            ),
            crate::messages::text(
                "state.mod.checked_metadata.reduce_the_selected_output_or_split_projects",
            ),
        )
        .at(path)
        .code("E26"));
    }
    Ok(bytes)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub mod_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub target_relative_path: String,
    pub backup_file_name: String,
    #[serde(default = "yes")]
    pub original_exists: bool,
    #[serde(default = "present")]
    pub expected_state: String,
    #[serde(default)]
    pub original_content_hash: Option<String>,
    #[serde(default)]
    pub synced_content_hash: Option<String>,
    pub contributors: Vec<Contributor>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default)]
    pub entries: Vec<ManifestEntry>,
}
impl Manifest {
    pub fn load(context: &Context) -> Result<Self> {
        let path = context.state.join("manifest.json");
        paths::assert_no_links(&context.state, &path)?;
        if !path.try_exists().map_err(|e| Diagnostic::io(&path, e))? {
            let originals = context.state.join("originals");
            let any_original = if originals.exists() {
                fs::read_dir(&originals)
                    .map_err(|e| Diagnostic::io(&originals, e))?
                    .next()
                    .is_some()
            } else {
                false
            };
            if any_original || context.state.join("manifest.json.bak").exists() {
                return Err(recovery(
                    &path,
                    crate::messages::text(
                        "state.mod.load.recovery_files_exist_but_manifest_json_is",
                    ),
                ));
            }
            return Ok(Self::default());
        }
        let bytes = paths::read_limited(&path, MAX_METADATA_BYTES as u64)?;
        let manifest: Self = serde_json::from_slice(&bytes).map_err(|e| {
            recovery(
                &path,
                crate::messages::format(
                    "state.mod.load.cannot_read_recovery_manifest_e",
                    &[("E", format!("{}", e))],
                ),
            )
        })?;
        if manifest.version.unwrap_or(1) != metadata::STATE_VERSION {
            return Err(recovery(
                &path,
                crate::messages::text("state.mod.load.unsupported_recovery_state_format"),
            ));
        }
        let mut seen = HashSet::new();
        for entry in &manifest.entries {
            if paths::game_relative(&entry.target_relative_path)? != entry.target_relative_path
                || !valid_backup_name(&entry.backup_file_name)
                || !seen.insert(paths::key(&entry.target_relative_path))
                || !matches!(entry.expected_state.as_str(), "present" | "absent")
                || entry
                    .original_content_hash
                    .as_ref()
                    .is_some_and(|s| !valid_hash(s))
                || entry
                    .synced_content_hash
                    .as_ref()
                    .is_some_and(|s| !valid_hash(s))
            {
                return Err(recovery(
                    &path,
                    crate::messages::text(
                        "state.mod.load.recovery_manifest_contains_invalid_or_duplicate_target",
                    ),
                ));
            }
        }
        Ok(manifest)
    }
    pub fn map(&self) -> BTreeMap<String, ManifestEntry> {
        self.entries
            .iter()
            .map(|entry| (paths::key(&entry.target_relative_path), entry.clone()))
            .collect()
    }
    pub fn validate_backups(&self, context: &Context) -> Result<()> {
        let entries: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| entry.original_exists)
            .collect();
        for result in ymb_core::parallel::map(
            &entries,
            context.config.settings.parallel_limits(),
            |entry| ymb_core::parallel::Cost {
                memory_bytes: 64 << 10,
                work_bytes: std::fs::metadata(
                    context
                        .state
                        .join("originals")
                        .join(&entry.backup_file_name),
                )
                .map_or(0, |m| m.len() as usize),
            },
            |entry| original_backup(context, entry),
        ) {
            result?;
        }
        Ok(())
    }
}
pub fn selected(entry: &ManifestEntry, selection: &Selection) -> bool {
    entry
        .contributors
        .iter()
        .any(|owner| contributor_selected(owner, selection))
}
pub fn contributor_selected(owner: &Contributor, selection: &Selection) -> bool {
    let patch = owner.patch_id.as_deref().unwrap_or("");
    matches(
        &selection.mod_filters,
        &owner.mod_id,
        owner.mod_name.as_deref().unwrap_or(&owner.mod_id),
    ) && (matches(
        &selection.patch_filters,
        patch,
        owner.patch_name.as_deref().unwrap_or(patch),
    ) || selection
        .patch_filters
        .iter()
        .any(|filter| filter.eq_ignore_ascii_case(&format!("{}:{patch}", owner.mod_id))))
}
pub fn original_backup(context: &Context, entry: &ManifestEntry) -> Result<PathBuf> {
    let root = context.state.join("originals");
    let path = paths::resolve(&root, &entry.backup_file_name)?;
    if !path.is_file() {
        return Err(recovery(
            &path,
            crate::messages::format(
                "state.mod.original_backup.original_backup_is_missing_for_arg0",
                &[("ARG0", entry.target_relative_path.to_string())],
            ),
        ));
    }
    if let Some(expected) = &entry.original_content_hash
        && paths::hash_file(&path)? != *expected
    {
        return Err(recovery(
            &path,
            crate::messages::text(
                "state.mod.original_backup.original_backup_checksum_does_not_match",
            ),
        ));
    }
    Ok(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackedState {
    Synced,
    Original,
    Changed,
}
pub fn classify(context: &Context, entry: &ManifestEntry) -> Result<TrackedState> {
    let path = context.target(&entry.target_relative_path)?;
    let actual = file_hash(&path)?;
    if entry.expected_state == "absent" && actual.is_none()
        || actual
            .as_ref()
            .is_some_and(|hash| Some(hash) == entry.synced_content_hash.as_ref())
    {
        return Ok(TrackedState::Synced);
    }
    if entry.expected_state == "present" && entry.synced_content_hash.is_none() && actual.is_some()
    {
        let limit = (context.config.settings.memory_budget_mib as u64).saturating_mul(1024 * 1024);
        if let Ok(bytes) = paths::read_limited(&path, limit)
            && let Ok(source) = std::str::from_utf8(&bytes)
            && unwrap_marked(source, &entry.target_relative_path)
                .ok()
                .flatten()
                .is_some()
        {
            return Ok(TrackedState::Synced);
        }
    }
    let legacy_original_hash = if entry.original_exists && entry.original_content_hash.is_none() {
        Some(paths::hash_file(&original_backup(context, entry)?)?)
    } else {
        None
    };
    let original_hash = entry
        .original_content_hash
        .as_ref()
        .or(legacy_original_hash.as_ref());
    if !entry.original_exists && actual.is_none()
        || actual
            .as_ref()
            .is_some_and(|hash| Some(hash) == original_hash)
    {
        return Ok(TrackedState::Original);
    }
    Ok(TrackedState::Changed)
}
pub fn file_hash(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || paths::is_link(&metadata) {
                return Err(recovery(
                    path,
                    crate::messages::text(
                        "state.mod.file_hash.a_protected_target_is_not_a_regular",
                    ),
                ));
            }
            paths::hash_file(path).map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Diagnostic::io(path, error)),
    }
}
pub fn backup_name(path: &str, bytes_hash: &str, text: bool) -> String {
    format!(
        "{}.{}",
        hash(format!("{path}:{bytes_hash}")),
        if text { "ndf" } else { "bin" }
    )
}
pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn valid_backup_name(value: &str) -> bool {
    value
        .strip_suffix(".ndf")
        .or_else(|| value.strip_suffix(".bin"))
        .is_some_and(valid_hash)
}
pub fn recovery(path: &Path, reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "RecoveryError",
        reason,
        crate::messages::text("state.mod.recovery.restore_the_named_data_from_a_trusted"),
    )
    .at(path)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Root {
    Game,
    State,
    Mods,
    Work,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProtectedFile {
    root: Root,
    path: String,
    existed: bool,
    snapshot: Option<String>,
    hash: Option<String>,
    #[serde(default)]
    postimages: Vec<Option<String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DirectorySwap {
    path: String,
    previous: String,
    existed: bool,
    previous_hash: Option<String>,
    published_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Journal {
    version: u32,
    command: String,
    roots: Vec<String>,
    committed: bool,
    files: Vec<ProtectedFile>,
    directories: Vec<DirectorySwap>,
}
pub struct Transaction {
    context: Context,
    journal: Journal,
}
mod markers;
mod recovery;
mod transaction;
pub use markers::{comment_style, marked_bytes, unwrap_marked};
use recovery::*;
pub use recovery::{prepare_pending, recover_pending};
use transaction::*;
pub use ymb::operation_lock::OperationLock;
#[cfg(test)]
mod tests;
