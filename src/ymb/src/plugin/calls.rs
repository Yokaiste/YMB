use super::*;

pub(super) fn receive<T>(receiver: &mpsc::Receiver<Result<T>>, deadline: Instant) -> Result<T> {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => timeout(),
            mpsc::RecvTimeoutError::Disconnected => protocol_error(crate::messages::text(
                "plugin.calls.receive.generator_closed_its_protocol_stream",
            )),
        })?
}
pub(super) fn timeout() -> Box<Diagnostic> {
    Diagnostic::new(
        "GeneratorError",
        crate::messages::text("plugin.calls.timeout.generator_exceeded_its_time_limit"),
        crate::messages::text(
            "plugin.calls.timeout.fix_an_unbounded_operation_or_increase_settings",
        ),
    )
    .code("E23")
}
#[derive(Clone, Copy)]
pub(super) struct CallContext<'a> {
    pub(super) project: usize,
    pub(super) owner_root: &'a Path,
    pub(super) mod_root: &'a Path,
    pub(super) identity: &'a str,
    pub(super) cache: &'a crate::store::Cache,
    pub(super) staging_root: &'a Path,
}
pub(super) fn handle_call(
    built: &mut Materialized<'_>,
    context: &CallContext<'_>,
    created: &mut HashMap<String, Created>,
    targets: &mut BTreeMap<String, Option<String>>,
    base_targets: &mut BTreeMap<String, Option<String>>,
    owned_reads: &mut BTreeMap<PathBuf, Option<String>>,
    call: HostCall,
) -> Result<HostReply> {
    let CallContext {
        project,
        owner_root,
        mod_root,
        identity,
        cache,
        staging_root,
    } = *context;
    let base = matches!(call, HostCall::ReadBaseTargets { .. });
    let warning = matches!(call, HostCall::Warning { .. });
    Ok(match call {
        HostCall::Notice { reason } | HostCall::Warning { reason } => {
            if reason.trim().is_empty() || reason.len() > 4096 || built.notices.len() >= MAX_OUTPUTS
            {
                return Err(protocol_error(crate::messages::text(
                    "plugin.calls.handle_call.invalid_or_excessive_generator_notices",
                )));
            }
            built
                .notices
                .push(serde_json::json!({"code":if warning { "W7" } else { "I5" },"generatorId":identity,"reason":reason}));
            HostReply::Changed { changed: false }
        }
        HostCall::ReadTargets {
            paths: requests,
            kind,
        }
        | HostCall::ReadBaseTargets {
            paths: requests,
            kind,
        } => {
            if requests.len() > MAX_OUTPUTS {
                return Err(protocol_error(crate::messages::text(
                    "plugin.calls.handle_call.too_many_requested_targets",
                )));
            }
            let mut files = Vec::new();
            for request in requests {
                let path = paths::game_relative(&request)?;
                let snapshot = if base {
                    built.base_target(&path)?
                } else {
                    built.visible(&path, project)?
                };
                if base {
                    &mut *base_targets
                } else {
                    &mut *targets
                }
                .insert(path.clone(), snapshot.as_ref().map(|s| s.hash.clone()));
                let mut payload = snapshot.ok_or_else(|| engine::missing(&path))?.payload();
                payload.kind = kind;
                files.push((request, payload));
            }
            HostReply::Payloads { files }
        }
        HostCall::ReadOwned { path, scope } => {
            let path = owned_path(owner_root, mod_root, &path, scope)?;
            let snapshot = built.owned_read(&path)?;
            owned_reads
                .entry(path)
                .or_insert_with(|| snapshot.as_ref().map(|s| s.hash.clone()));
            HostReply::OptionalPayload {
                payload: snapshot.map(|s| s.payload()),
            }
        }
        HostCall::ResolveOwned { path, scope } => HostReply::Path {
            token: String::new(),
            path: owned_path(owner_root, mod_root, &path, scope)?,
        },
        HostCall::CreateOutput { target, kind } => create(
            staging_root,
            created,
            kind,
            Destination::Output(paths::game_relative(&target)?),
        )?,
        HostCall::CreateOwned { path, scope } => create(
            staging_root,
            created,
            ContentKind::Text,
            Destination::Owned(owned_path(owner_root, mod_root, &path, scope)?),
        )?,
        HostCall::CommitOwned { payload } => {
            let item = created.get(&payload.token).ok_or_else(|| {
                protocol_error(crate::messages::text(
                    "plugin.calls.handle_call.unknown_owned_file_token",
                ))
            })?;
            let Destination::Owned(path) = &item.destination else {
                return Err(protocol_error(crate::messages::text(
                    "plugin.calls.handle_call.token_does_not_belong_to_an_owned",
                )));
            };
            let snapshot = validate_payload(built, item, &payload)?;
            let before = built.owned_read(path)?;
            owned_reads
                .entry(path.clone())
                .or_insert_with(|| before.as_ref().map(|s| s.hash.clone()));
            let changed = before.is_none_or(|before| before.hash != snapshot.hash);
            built.stage_owned(path, snapshot);
            HostReply::Changed { changed }
        }
        HostCall::CacheRead { namespace, key } => {
            paths::identifier(&namespace)?;
            paths::identifier(&key)?;
            let payload = cache
                .read(
                    &built.store,
                    &format!("generator:{identity}:{namespace}"),
                    &key,
                )?
                .map(|s| s.payload());
            built.metrics.generator_cache_hits += usize::from(payload.is_some());
            HostReply::OptionalPayload { payload }
        }
        HostCall::CacheCreate { namespace, key } => {
            paths::identifier(&namespace)?;
            paths::identifier(&key)?;
            create(
                staging_root,
                created,
                ContentKind::Binary,
                Destination::Cache(format!("generator:{identity}:{namespace}"), key),
            )?
        }
        HostCall::CacheCommit { payload } => {
            let item = created.get(&payload.token).ok_or_else(|| {
                protocol_error(crate::messages::text(
                    "plugin.calls.handle_call.unknown_cache_token",
                ))
            })?;
            let Destination::Cache(namespace, key) = &item.destination else {
                return Err(protocol_error(crate::messages::text(
                    "plugin.calls.handle_call.token_does_not_belong_to_a_cache",
                )));
            };
            let snapshot = validate_payload(built, item, &payload)?;
            if snapshot.bytes
                > built
                    .plan
                    .context
                    .config
                    .settings
                    .generator_cache_max_bytes_per_namespace
            {
                cache
                    .notice(crate::messages::text("plugin.calls.handle_call.skipped_generator_cache_entry_exceeding_its_namespace"));
                return Ok(HostReply::Changed { changed: false });
            }
            cache.write(namespace, key, &snapshot)?;
            HostReply::Changed { changed: true }
        }
    })
}
pub(super) fn create(
    root: &Path,
    created: &mut HashMap<String, Created>,
    kind: ContentKind,
    destination: Destination,
) -> Result<HostReply> {
    if created.len() > MAX_OUTPUTS * 4 {
        return Err(protocol_error(crate::messages::text(
            "plugin.calls.create.generator_created_too_many_staging_files",
        )));
    }
    let token = uuid::Uuid::new_v4().to_string();
    let path = root.join("plugin").join(&token);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| Diagnostic::io(&path, e))?;
    created.insert(
        token.clone(),
        Created {
            root: root.to_owned(),
            path: path.clone(),
            kind,
            destination,
        },
    );
    Ok(HostReply::Path { token, path })
}
pub(super) fn validate_payload(
    built: &Materialized<'_>,
    item: &Created,
    payload: &Payload,
) -> Result<Snapshot> {
    if payload.path != item.path
        || payload.kind != item.kind
        || !crate::state::valid_hash(&payload.hash)
    {
        return Err(protocol_error(crate::messages::text(
            "plugin.calls.validate_payload.returned_payload_does_not_match_its_staging",
        )));
    }
    paths::assert_no_links(&item.root, &payload.path)?;
    let metadata = fs::metadata(&payload.path).map_err(|e| Diagnostic::io(&payload.path, e))?;
    if !metadata.is_file()
        || metadata.len() != payload.bytes
        || payload.bytes > 2 * 1024 * 1024 * 1024
    {
        return Err(protocol_error(crate::messages::text(
            "plugin.calls.validate_payload.returned_payload_size_checksum_or_file_type",
        )));
    }
    let snapshot = built.store.capture(&payload.path, payload.kind)?;
    if snapshot.bytes != payload.bytes || snapshot.hash != payload.hash {
        return Err(protocol_error(crate::messages::text(
            "plugin.calls.validate_payload.returned_payload_size_checksum_or_file_type",
        )));
    }
    if payload.kind == ContentKind::Text {
        snapshot.text()?;
    }
    Ok(snapshot)
}
pub(super) fn owned_path(
    owner: &Path,
    mod_root: &Path,
    path: &str,
    scope: OwnedScope,
) -> Result<PathBuf> {
    let path = paths::relative(path)?;
    if Path::new(&path).file_name().is_some_and(|name| {
        name.eq_ignore_ascii_case("ymb.mod.yaml") || name.eq_ignore_ascii_case("ymb.patch.yaml")
    }) {
        return Err(protocol_error(crate::messages::text(
            "plugin.calls.owned_path.owned_file_helpers_cannot_overwrite_project_configuration",
        )));
    }
    let persistent = ymb_core::storage::persistent(mod_root)?;
    paths::resolve(
        match scope {
            OwnedScope::Owner => owner,
            OwnedScope::Mod => mod_root,
            OwnedScope::Persistent => &persistent,
        },
        &path,
    )
}
