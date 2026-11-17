use super::*;

pub(super) fn rollback(context: &Context, journal: &Journal) -> Result<()> {
    if journal.roots != root_identity(context) {
        return Err(recovery(
            &context.journal,
            crate::messages::text(
                "state.recovery.rollback.configured_roots_differ_from_those_protected_by",
            ),
        ));
    }
    let mut seen = HashSet::new();
    for file in &journal.files {
        journal_path(context, &file.root, &file.path)?;
        if !seen.insert(format!("{:?}:{}", file.root, paths::key(&file.path))) {
            return Err(recovery(
                &context.journal,
                crate::messages::text(
                    "state.recovery.rollback.interrupted_journal_repeats_a_target",
                ),
            ));
        }
        if file.existed != file.hash.is_some()
            || file
                .postimages
                .iter()
                .flatten()
                .any(|hash| !valid_hash(hash))
        {
            return Err(recovery(
                &context.journal,
                crate::messages::text("state.recovery.rollback.invalid_protected_file_hashes"),
            ));
        }
        if file.existed {
            let name = file
                .snapshot
                .as_ref()
                .filter(|s| s.strip_suffix(".bin").is_some_and(valid_hash))
                .ok_or_else(|| {
                    recovery(
                        &context.journal,
                        crate::messages::text("state.recovery.rollback.interrupted_journal_has_an_invalid_snapshot_name"),
                    )
                })?;
            let snapshot = paths::resolve(&context.journal.join("snapshots"), name)?;
            if file.hash.as_ref().is_none_or(|hash| !valid_hash(hash))
                || paths::hash_file(&snapshot).ok().as_ref() != file.hash.as_ref()
            {
                return Err(recovery(
                    &snapshot,
                    crate::messages::text(
                        "state.recovery.rollback.rollback_snapshot_is_missing_or_damaged_no",
                    ),
                ));
            }
        }
        let absolute = journal_path(context, &file.root, &file.path)?;
        let actual = file_hash(&absolute)?;
        if actual != file.hash && !file.postimages.contains(&actual) {
            return Err(recovery(
                &absolute,
                crate::messages::text(
                    "state.recovery.rollback.the_file_changed_while_rollback_was_pending",
                ),
            ));
        }
    }
    check_swaps(context, journal, false)?;
    for file in journal.files.iter().rev() {
        let absolute = journal_path(context, &file.root, &file.path)?;
        if file.existed {
            if file_hash(&absolute).ok().flatten().as_ref() == file.hash.as_ref() {
                continue;
            }
            paths::copy_atomic(
                &context
                    .journal
                    .join("snapshots")
                    .join(file.snapshot.as_ref().unwrap()),
                &absolute,
            )?;
        } else if absolute.exists() {
            fs::remove_file(&absolute).map_err(|e| Diagnostic::io(&absolute, e))?;
        }
    }
    for swap in journal.directories.iter().rev() {
        let destination = paths::resolve(&context.work, &swap.path)?;
        let previous = paths::resolve(&context.work, &swap.previous)?;
        if previous.exists() {
            if destination.exists() {
                fs::remove_dir_all(&destination).map_err(|e| Diagnostic::io(&destination, e))?;
            }
            paths::rename(&previous, &destination).map_err(|e| Diagnostic::io(&destination, e))?;
        } else if !swap.existed && destination.exists() {
            fs::remove_dir_all(&destination).map_err(|e| Diagnostic::io(&destination, e))?;
        }
    }
    fs::remove_dir_all(&context.journal).map_err(|e| Diagnostic::io(&context.journal, e))
}
pub fn prepare_pending(context: &Context, read_only: bool) -> Result<bool> {
    if read_only && context.journal.exists() {
        return Err(recovery(
            &context.journal,
            crate::messages::text(
                "state.recovery.prepare_pending.an_interrupted_operation_needs_recovery_this_preview",
            ),
        ));
    }
    recover_pending(context)
}
pub fn recover_pending(context: &Context) -> Result<bool> {
    if !context.journal.exists() {
        return Ok(false);
    }
    paths::assert_no_links(&context.journal, &context.journal.join("transaction.json"))?;
    let path = context.journal.join("transaction.json");
    let bytes = paths::read_limited(&path, MAX_METADATA_BYTES as u64)?;
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| recovery(&path, e.to_string()))?;
    let version = raw
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            recovery(
                &path,
                crate::messages::text(
                    "state.recovery.recover_pending.transaction_has_no_format_version",
                ),
            )
        })?;
    if version == 1 {
        return recover_legacy(context, &raw).map(|()| true);
    }
    if version != 2 && version != u64::from(metadata::JOURNAL_VERSION) {
        return Err(recovery(
            &path,
            crate::messages::format(
                "state.recovery.recover_pending.unsupported_transaction_version_version",
                &[("VERSION", format!("{}", version))],
            ),
        ));
    }
    let journal: Journal =
        serde_json::from_value(raw).map_err(|e| recovery(&path, e.to_string()))?;
    if journal.roots != root_identity(context) {
        return Err(recovery(
            &context.journal,
            crate::messages::text(
                "common.shared.configured_roots_differ_from_the_interrupted_operation",
            ),
        ));
    }
    for swap in &journal.directories {
        let valid_name = swap
            .previous
            .strip_prefix(".ymb-")
            .and_then(|s| s.strip_suffix(".tmp"))
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok());
        if swap.path != "output" || !valid_name {
            return Err(recovery(
                &context.journal,
                crate::messages::text(
                    "state.recovery.recover_pending.invalid_interrupted_preview_path",
                ),
            ));
        }
        paths::resolve(&context.work, &swap.previous)?;
    }
    if journal.committed {
        let transaction = Transaction {
            context: context.clone(),
            journal,
        };
        transaction.finish()?;
        Ok(false)
    } else {
        rollback(context, &journal)?;
        Ok(true)
    }
}

pub(super) fn recover_legacy(context: &Context, raw: &serde_json::Value) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Legacy {
        state_existed: bool,
        state_snapshot_hash: Option<String>,
        targets: Vec<LegacyTarget>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyTarget {
        target_relative_path: String,
        existed: bool,
        snapshot_file_name: Option<String>,
        content_hash: Option<String>,
    }
    let journal: Legacy = serde_json::from_value(raw.clone())
        .map_err(|e| recovery(&context.journal, e.to_string()))?;
    let state_snapshot = context.journal.join("state-before");
    if journal.state_existed
        && (journal
            .state_snapshot_hash
            .as_ref()
            .is_none_or(|hash| !valid_hash(hash))
            || tree_hash(&state_snapshot, context)?.as_str()
                != journal.state_snapshot_hash.as_deref().unwrap())
    {
        return Err(recovery(
            &state_snapshot,
            crate::messages::text(
                "state.recovery.recover_legacy.legacy_recovery_state_snapshot_checksum_does_not",
            ),
        ));
    }
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for target in journal.targets {
        let relative = paths::game_relative(&target.target_relative_path)?;
        if !seen.insert(paths::key(&relative)) {
            return Err(recovery(
                &context.journal,
                crate::messages::text(
                    "state.recovery.recover_legacy.legacy_transaction_repeats_a_target",
                ),
            ));
        }
        let absolute = context.target(&relative)?;
        let snapshot = if target.existed {
            let name = target
                .snapshot_file_name
                .filter(|name| name.strip_suffix(".bin").is_some_and(valid_hash))
                .ok_or_else(|| {
                    recovery(
                        &context.journal,
                        crate::messages::text(
                            "state.recovery.recover_legacy.legacy_target_snapshot_name_is_invalid",
                        ),
                    )
                })?;
            let path = paths::resolve(&context.journal.join("targets-before"), &name)?;
            if target
                .content_hash
                .as_ref()
                .is_none_or(|hash| !valid_hash(hash))
                || paths::hash_file(&path)?.as_str() != target.content_hash.as_deref().unwrap()
            {
                return Err(recovery(
                    &path,
                    crate::messages::text(
                        "state.recovery.recover_legacy.legacy_rollback_snapshot_checksum_does_not_match",
                    ),
                ));
            }
            Some(path)
        } else {
            None
        };
        let expected = snapshot
            .as_ref()
            .map(|path| paths::hash_file(path))
            .transpose()?;
        if file_hash(&absolute)? != expected {
            return Err(recovery(
                &absolute,
                crate::messages::text(
                    "state.recovery.recover_legacy.legacy_rollback_cannot_identify_later_edits_no",
                ),
            ));
        }
        targets.push((absolute, snapshot));
    }
    if context.state.exists()
        && (!journal.state_existed
            || tree_hash(&context.state, context)?
                != journal.state_snapshot_hash.as_deref().unwrap())
    {
        return Err(recovery(
            &context.state,
            crate::messages::text(
                "state.recovery.recover_legacy.legacy_recovery_records_changed_no_files_have",
            ),
        ));
    }
    for (absolute, snapshot) in targets {
        if let Some(snapshot) = snapshot {
            paths::copy_atomic(&snapshot, &absolute)?;
        } else if absolute.exists() {
            fs::remove_file(&absolute).map_err(|e| Diagnostic::io(&absolute, e))?;
        }
    }
    if journal.state_existed {
        let staged = paths::temporary_sibling(&context.state);
        copy_tree(&state_snapshot, &staged)?;
        if context.state.exists() {
            let previous = paths::temporary_sibling(&context.state);
            paths::rename(&context.state, &previous)
                .map_err(|e| Diagnostic::io(&context.state, e))?;
            if let Err(error) = paths::rename(&staged, &context.state) {
                let _ = paths::rename(&previous, &context.state);
                return Err(Diagnostic::io(&context.state, error));
            }
            fs::remove_dir_all(&previous).map_err(|e| Diagnostic::io(&previous, e))?;
        } else {
            paths::rename(&staged, &context.state)
                .map_err(|e| Diagnostic::io(&context.state, e))?;
        }
    } else if context.state.exists() {
        fs::remove_dir_all(&context.state).map_err(|e| Diagnostic::io(&context.state, e))?;
    }
    fs::remove_dir_all(&context.journal).map_err(|e| Diagnostic::io(&context.journal, e))
}
pub(super) fn tree_hash(root: &Path, context: &Context) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut records = Vec::new();
    let mut pending = vec![PathBuf::new()];
    let mut cursor = 0;
    while cursor < pending.len() {
        let relative = pending[cursor].clone();
        cursor += 1;
        let directory = root.join(&relative);
        paths::assert_no_links(root, &directory)?;
        let mut entries = fs::read_dir(&directory)
            .map_err(|e| Diagnostic::io(&directory, e))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Diagnostic::io(&directory, e))?;
        entries.sort_by_cached_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
        for entry in entries {
            let relative = relative.join(entry.file_name());
            let name = relative.to_string_lossy().replace('\\', "/");
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|e| Diagnostic::io(&entry.path(), e))?;
            if paths::is_link(&metadata) {
                return Err(recovery(
                    &entry.path(),
                    crate::messages::text(
                        "state.recovery.tree_hash.legacy_snapshot_contains_a_link",
                    ),
                ));
            }
            if metadata.is_dir() {
                records.push((format!("D:{name}\0"), None, 0));
                pending.push(relative);
            } else if metadata.is_file() {
                records.push((
                    format!("F:{name}\0"),
                    Some(entry.path()),
                    metadata.len() as usize,
                ));
            } else {
                return Err(recovery(
                    &entry.path(),
                    crate::messages::text(
                        "state.recovery.tree_hash.legacy_snapshot_contains_a_special_file",
                    ),
                ));
            }
        }
    }
    let hashes = ymb_core::parallel::map(
        &records,
        context.config.settings.parallel_limits(),
        |(_, _, bytes)| ymb_core::parallel::Cost {
            memory_bytes: 64 << 10,
            work_bytes: *bytes,
        },
        |(_, path, _)| path.as_ref().map(|path| paths::hash_file(path)).transpose(),
    );
    let mut digest = Sha256::new();
    for ((record, _, _), hash) in records.into_iter().zip(hashes) {
        digest.update(record);
        if let Some(hash) = hash? {
            digest.update(hash);
            digest.update(b"\0");
        }
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
pub(super) fn check_swaps(context: &Context, journal: &Journal, committed: bool) -> Result<()> {
    if journal.roots != root_identity(context) {
        return Err(recovery(
            &context.journal,
            crate::messages::text(
                "common.shared.configured_roots_differ_from_the_interrupted_operation",
            ),
        ));
    }
    let mut seen = HashSet::new();
    for swap in &journal.directories {
        let valid_name = swap
            .previous
            .strip_prefix(".ymb-")
            .and_then(|s| s.strip_suffix(".tmp"))
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok());
        if swap.path != "output"
            || !valid_name
            || !seen.insert(&swap.path)
            || !valid_hash(&swap.published_hash)
            || swap.existed != swap.previous_hash.is_some()
        {
            return Err(recovery(
                &context.journal,
                crate::messages::text(
                    "state.recovery.check_swaps.interrupted_preview_metadata_is_invalid",
                ),
            ));
        }
        let previous = paths::resolve(&context.work, &swap.previous)?;
        let destination = paths::resolve(&context.work, &swap.path)?;
        if previous.exists() {
            if tree_hash(&previous, context).ok().as_ref() != swap.previous_hash.as_ref() {
                return Err(recovery(
                    &previous,
                    crate::messages::text(
                        "state.recovery.check_swaps.previous_preview_checksum_does_not_match_nothing",
                    ),
                ));
            }
            if !committed
                && destination.exists()
                && tree_hash(&destination, context)? != swap.published_hash
            {
                return Err(recovery(
                    &destination,
                    crate::messages::text(
                        "state.recovery.check_swaps.published_preview_changed_while_rollback_was_pending",
                    ),
                ));
            }
        } else if !committed && swap.existed {
            if !destination.exists()
                || tree_hash(&destination, context).ok().as_ref() != swap.previous_hash.as_ref()
            {
                return Err(recovery(
                    &previous,
                    crate::messages::text(
                        "state.recovery.check_swaps.previous_preview_is_missing_or_damaged_nothing",
                    ),
                ));
            }
        } else if !committed
            && destination.exists()
            && tree_hash(&destination, context)? != swap.published_hash
        {
            return Err(recovery(
                &destination,
                crate::messages::text(
                    "state.recovery.check_swaps.an_unrelated_preview_appeared_while_rollback_was",
                ),
            ));
        }
    }
    Ok(())
}
