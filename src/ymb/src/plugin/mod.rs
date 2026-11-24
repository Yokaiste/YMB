use crate::{
    config::{Generator, GeneratorRoot, check_requirement},
    engine::{self, Materialized, Output},
    store::Snapshot,
};
pub(crate) use compile::prepare_release;
pub(crate) use compile::release_executable;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{BufReader, BufWriter, Read},
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};
use ymb_core::{Diagnostic, Result, hash, metadata, paths};
use ymb_sdk::protocol::*;

enum Destination {
    Output(String),
    Owned(PathBuf),
    Cache(String, String),
}
struct Created {
    root: PathBuf,
    path: PathBuf,
    kind: ContentKind,
    destination: Destination,
}
#[derive(Serialize, Deserialize)]
struct CachedTests {
    tests: Vec<TestResult>,
    notices: Vec<Value>,
    targets: BTreeMap<String, Option<String>>,
    owned: BTreeMap<PathBuf, Option<String>>,
    #[serde(default)]
    base_targets: BTreeMap<String, Option<String>>,
}
pub fn execute(
    built: &mut Materialized<'_>,
    project: usize,
    patch: Option<usize>,
    generator: &Generator,
    variables: &Value,
    phase: &str,
    test_id: Option<&str>,
) -> Result<()> {
    let owner = &built.plan.projects[project];
    let patch_config = patch.map(|i| &owner.patches[i]);
    let owner_root = patch_config.map_or(&owner.config_root, |p| &p.root);
    let code_root = match generator.root {
        GeneratorRoot::Owner => owner_root,
        GeneratorRoot::Mod => &owner.config_root,
    };
    let compiled = resolve_executable(built, code_root, generator)?;
    let executable = &compiled.path;
    let identity = format!(
        "{}:{}:{}",
        owner.config.id,
        patch_config.map_or("", |p| p.config.id.as_str()),
        generator.id
    );
    let session_root = ymb_core::storage::session(&built.plan.context.root, &owner.config.id)?;
    let cache = built
        .generator_caches
        .entry(project)
        .or_insert_with(|| {
            std::sync::Arc::new(crate::store::Cache::at(
                &built.plan.context,
                session_root.join("cache"),
                built.plan.selection.use_cache,
            ))
        })
        .clone();
    cache.prune()?;
    let binary_hash = &compiled.hash;
    let cache_salt = hash(format!("{}:{binary_hash}:{identity}", metadata::BUILD_ID));
    let test_key = hash(
        serde_json::to_vec(&(
            crate::BUILD_ID,
            cache_salt.as_str(),
            generator.entry(),
            test_id,
            variables,
            &built.plan.selection,
            &built.plan.context.root,
            &built.plan.context.game,
            &built.plan.context.config.paths,
            &built.plan.context.config.settings,
            owner_root,
            &owner.config_path,
        ))
        .unwrap(),
    );
    if phase == "before"
        && let Some(snapshot) = cache.read(&built.store, "before-tests", &test_key)?
        && let Ok(cached) = snapshot.read().and_then(|bytes| {
            serde_json::from_slice::<CachedTests>(&bytes).map_err(|e| protocol_error(e.to_string()))
        })
    {
        let mut valid = true;
        for (path, expected) in &cached.base_targets {
            if built.base_target(path)?.map(|snapshot| snapshot.hash) != *expected {
                valid = false;
                break;
            }
        }
        for (path, expected) in &cached.targets {
            if built.visible(path, project)?.map(|s| s.hash) != *expected {
                valid = false;
                break;
            }
        }
        if valid {
            for (path, expected) in &cached.owned {
                let root_ok = paths::overlaps(&owner.config_root, path)?
                    && paths::key(path.to_string_lossy()).starts_with(&format!(
                        "{}/",
                        paths::key(owner.config_root.to_string_lossy())
                    ));
                if !root_ok || built.owned_read(path)?.map(|s| s.hash) != *expected {
                    valid = false;
                    break;
                }
            }
        }
        if valid
            && cached.tests.iter().all(|t| t.status == "passed")
            && cached.notices.len() <= MAX_OUTPUTS.saturating_sub(built.notices.len())
        {
            built.metrics.cache_hits += 1;
            built.metrics.tests += cached.tests.len();
            built.tests.extend(cached.tests);
            built.notices.extend(cached.notices);
            return Ok(());
        }
    }
    let context = ContextInfo {
        builder: BuilderInfo {
            root_path: built.plan.context.root.clone(),
            config_path: built.plan.context.config_path.clone(),
            version: metadata::VERSION.into(),
            game_root: built.plan.context.game.clone(),
            game_data_root: built.plan.context.game.join("GameData"),
            common_data_root: built.plan.context.game.join("CommonData"),
            mods_root: built.plan.context.mods.clone(),
            work_root: built.plan.context.work.clone(),
            output_root: built.plan.context.output.clone(),
            cache_root: built.plan.context.cache.clone(),
            conflicts_root: built.plan.context.conflicts.clone(),
            recovery_root: built.plan.context.state.clone(),
            operation_lock_root: built.plan.context.lock.clone(),
            state_transaction_root: built.plan.context.journal.clone(),
        },
        selection: serde_json::to_value(&built.plan.selection).unwrap(),
        r#mod: OwnerInfo {
            id: owner.config.id.clone(),
            name: owner.config.name.clone(),
            description: owner.config.description.clone(),
            root_path: owner.config_root.clone(),
            config_path: owner.config_path.clone(),
        },
        patch: patch_config.map(|p| OwnerInfo {
            id: p.config.id.clone(),
            name: p.config.name.clone(),
            description: p.config.description.clone(),
            root_path: p.root.clone(),
            config_path: p.config_path.clone(),
        }),
        storage: StorageInfo {
            persistent_root: ymb_core::storage::persistent(&owner.config_root)?,
            session_root: ymb_core::storage::session(&built.plan.context.root, &owner.config.id)?,
        },
        generator_id: identity.clone(),
        variables: variables.clone(),
        cache_enabled: built.plan.selection.use_cache,
        cache_max_bytes: built
            .plan
            .context
            .config
            .settings
            .generator_cache_max_bytes_per_namespace
            .min(built.plan.context.config.settings.cache_max_bytes),
        cache_salt,
    };
    let mut session_context = built.plan.context.clone();
    session_context.work = session_root.join("run");
    let payload_store = crate::store::Store::new(&session_context)?;
    if built.plan.selection.progress() {
        let message = if built.plan.selection.verbose {
            crate::messages::format(
                "plugin.mod.execute.generator_identity_phase_arg2",
                &[
                    ("IDENTITY", identity.to_string()),
                    ("PHASE", phase.to_string()),
                    (
                        "ARG2",
                        test_id
                            .map_or(String::new(), |id| format!(" ({id})"))
                            .to_string(),
                    ),
                ],
            )
        } else {
            crate::messages::format(
                if test_id.is_some() {
                    "plugin.mod.execute.check_feature"
                } else {
                    "plugin.mod.execute.build_feature"
                },
                &[(
                    "NAME",
                    patch_config
                        .map_or(&owner.config.name, |p| &p.config.name)
                        .clone(),
                )],
            )
        };
        crate::ui::phase(message);
    }
    let mut process = crate::platform::Process::spawn(
        executable,
        owner_root,
        built.plan.context.config.settings.parallel_limits(),
    )?;
    let mut writer = BufWriter::new(process.child.stdin.take().unwrap());
    let stdout = process.child.stdout.take().unwrap();
    let stderr = process.child.stderr.take().unwrap();
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let message = read_frame::<PluginMessage>(&mut reader);
            let failed = message.is_err();
            if sender.send(message).is_err() || failed {
                break;
            }
        }
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut reader = stderr;
        let mut tail = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    tail.extend_from_slice(&buffer[..count]);
                    if tail.len() > 65536 {
                        tail.drain(..tail.len() - 65536);
                    }
                }
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(
            built.plan.context.config.settings.generator_timeout_seconds,
        ))
        .ok_or_else(|| {
            protocol_error(crate::messages::text(
                "common.shared.configured_timeout_exceeds_the_supported_clock_range",
            ))
        })?;
    let (outgoing, messages) = mpsc::channel::<HostMessage>();
    let (written, acknowledgements) = mpsc::channel();
    let writer_thread = std::thread::spawn(move || {
        for message in messages {
            let result = write_frame(&mut writer, &message);
            let failed = result.is_err();
            if written.send(result).is_err() || failed {
                break;
            }
        }
    });
    let send = |message| -> Result<()> {
        outgoing.send(message).map_err(|_| {
            protocol_error(crate::messages::text(
                "plugin.mod.execute.generator_input_closed",
            ))
        })?;
        receive(&acknowledgements, deadline)
    };
    let mut created = HashMap::new();
    let first_notice = built.notices.len();
    let mut targets = BTreeMap::new();
    let mut base_targets = BTreeMap::new();
    let mut owned_reads = BTreeMap::new();
    let previous_owned = built.owned.clone();
    let result = (|| -> Result<(Vec<GeneratedFile>, Vec<TestResult>)> {
        send(HostMessage::Hello {
            protocol: metadata::PLUGIN_VERSION,
            ymb: metadata::VERSION.into(),
            execution: uuid::Uuid::new_v4().to_string(),
        })?;
        let PluginMessage::Ready { protocol, requires } = receive(&receiver, deadline)? else {
            return Err(protocol_error(crate::messages::text(
                "plugin.mod.execute.generator_did_not_send_a_handshake",
            )));
        };
        check_protocol(protocol)?;
        check_requirement(&requires, executable, None)?;
        send(HostMessage::Run {
            entry: generator.entry().into(),
            phase: phase.into(),
            test_id: test_id.map(str::to_owned),
            context: Box::new(context),
        })?;
        let mut last_id = 0;
        loop {
            match receive(&receiver, deadline)? {
                PluginMessage::Call { id, call } => {
                    if id <= last_id {
                        return Err(protocol_error(crate::messages::text(
                            "plugin.mod.execute.request_ids_must_increase",
                        )));
                    }
                    last_id = id;
                    let reply = handle_call(
                        built,
                        &CallContext {
                            project,
                            owner_root,
                            mod_root: &owner.config_root,
                            identity: &identity,
                            cache: &cache,
                            staging_root: &payload_store.root,
                        },
                        &mut created,
                        &mut targets,
                        &mut base_targets,
                        &mut owned_reads,
                        call,
                    );
                    send(HostMessage::Reply {
                        id,
                        reply: reply.unwrap_or_else(|error| HostReply::Error { error: *error }),
                    })?;
                }
                PluginMessage::Complete { outputs, tests } => {
                    if outputs.len() > MAX_OUTPUTS || tests.len() > MAX_OUTPUTS {
                        return Err(protocol_error(crate::messages::text(
                            "plugin.mod.execute.generator_returned_too_many_results",
                        )));
                    }
                    return Ok((outputs, tests));
                }
                PluginMessage::Failed { error } => return Err(Box::new(error)),
                PluginMessage::Ready { .. } => {
                    return Err(protocol_error(crate::messages::text(
                        "plugin.mod.execute.generator_sent_a_second_handshake",
                    )));
                }
            }
        }
    })();
    drop(outgoing);
    let result = match result {
        Ok(result) => loop {
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    break if status.success() {
                        Ok(result)
                    } else {
                        Err(protocol_error(crate::messages::format(
                            "plugin.mod.execute.generator_exited_with_status",
                            &[("STATUS", format!("{}", status))],
                        )))
                    };
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Ok(None) => break Err(timeout()),
                Err(error) => break Err(Diagnostic::io(executable, error)),
            }
        },
        Err(error) => Err(error),
    };
    if let Some((cpu_ms, peak)) = process.usage() {
        built.metrics.generator_cpu_ms =
            Some(built.metrics.generator_cpu_ms.unwrap_or(0.) + cpu_ms);
        if let Some(peak) = peak {
            built.metrics.generator_peak_memory_bytes = Some(
                built
                    .metrics
                    .generator_peak_memory_bytes
                    .unwrap_or(0)
                    .max(peak),
            );
        }
    }
    process.terminate();
    let _ = writer_thread.join();
    drop(receiver);
    let _ = reader.join();
    let stderr = stderr_reader.join().unwrap_or_default();
    if phase != "generate" || result.is_err() {
        built.owned = previous_owned;
    }
    let (outputs, tests) = result.map_err(|error| {
        let error = engine::attach(error.with("generatorId", &identity), owner, patch_config);
        if stderr.trim().is_empty() {
            error
        } else {
            error.detail(stderr.trim())
        }
    })?;
    if phase != "generate" && !outputs.is_empty() {
        return Err(protocol_error(crate::messages::text(
            "plugin.mod.execute.companion_tests_cannot_return_game_outputs",
        )));
    }
    let mut allowed_owners = std::collections::HashSet::new();
    for entry in &owner.config.generators {
        allowed_owners.insert(format!("{}::{}", owner.config.id, entry.id));
    }
    for patch in &owner.patches {
        for entry in &patch.config.generators {
            allowed_owners.insert(format!(
                "{}:{}:{}",
                owner.config.id, patch.config.id, entry.id
            ));
        }
    }
    let mut returned = std::collections::HashSet::new();
    let mut validated = Vec::new();
    for mut output in outputs {
        if !output.generated_block_owners.is_empty()
            && (output.payload.kind != ContentKind::Text
                || output
                    .generated_block_owners
                    .iter()
                    .any(|id| !allowed_owners.contains(id)))
        {
            return Err(protocol_error(crate::messages::text(
                "plugin.mod.execute.generated_region_owners_must_name_registered_generators",
            )));
        }
        let target = paths::game_relative(&output.target_relative_path)?;
        if !returned.insert(paths::key(&target)) {
            return Err(protocol_error(crate::messages::text(
                "plugin.mod.execute.a_generator_returned_duplicate_target_paths",
            )));
        }
        let item = created.get(&output.payload.token).ok_or_else(|| {
            protocol_error(crate::messages::text(
                "plugin.mod.execute.output_has_no_host_issued_staging_token",
            ))
        })?;
        if !matches!(&item.destination,Destination::Output(path)if path==&target) {
            return Err(protocol_error(crate::messages::text(
                "plugin.mod.execute.output_token_belongs_to_another_target_or",
            )));
        }
        let snapshot = validate_payload(built, item, &output.payload)?;
        output.target_relative_path = target;
        validated.push((output, snapshot));
    }
    for test in &tests {
        if !matches!(test.status.as_str(), "passed" | "failed" | "skipped") {
            return Err(protocol_error(crate::messages::text(
                "plugin.mod.execute.unknown_test_status",
            )));
        }
        if test.status == "failed" {
            return Err(Diagnostic::new(
                "GeneratorTestError",
                test.reason.as_deref().unwrap_or(crate::messages::text(
                    "plugin.mod.execute.companion_test_failed",
                )),
                test.suggestion.as_deref().unwrap_or(crate::messages::text(
                    "plugin.mod.execute.fix_the_failed_test_before_building",
                )),
            )
            .with("test", &test.name)
            .with("generatorId", &identity)
            .with("details", &test.details));
        }
    }
    let observed: HashMap<_, _> = targets
        .iter()
        .map(|(path, hash)| (paths::key(path), hash.as_deref()))
        .collect();
    for (output, snapshot) in validated {
        if engine::is_ndf(&output.target_relative_path) {
            built
                .store
                .validate_ndf(&snapshot, &output.target_relative_path)?;
        }
        built.combine(
            Output {
                target: output.target_relative_path.clone(),
                content: Some(snapshot),
                contributors: vec![engine::contributor(
                    owner,
                    patch_config,
                    Some(&generator.id),
                )],
                source_type: "generator".into(),
                preserve: output.payload.kind == ContentKind::Binary,
            },
            project,
            observed
                .get(&paths::key(&output.target_relative_path))
                .copied()
                .flatten(),
            &output.generated_block_owners,
        )?;
    }
    if phase == "before" {
        let snapshot = built.store.put(
            serde_json::to_vec(&CachedTests {
                tests: tests.clone(),
                notices: built.notices[first_notice..].to_vec(),
                targets,
                base_targets,
                owned: owned_reads,
            })
            .unwrap(),
            ContentKind::Binary,
        )?;
        cache.write("before-tests", &test_key, &snapshot)?;
    }
    built.metrics.tests += tests.len();
    built.tests.extend(tests);
    Ok(())
}
mod calls;
mod compile;
use calls::*;
use compile::resolve_executable;
pub(crate) use compile::{Prepared, prepare};
