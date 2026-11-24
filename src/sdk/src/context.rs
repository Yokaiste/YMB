use super::*;

fn write_cache_json(path: &Path, value: &impl Serialize, limit: u64) -> Result<()> {
    struct Bounded<W> {
        writer: W,
        remaining: u64,
    }
    impl<W: std::io::Write> std::io::Write for Bounded<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() as u64 > self.remaining {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::FileTooLarge,
                    crate::messages::text("context.write.cache_entry_exceeds_its_byte_budget"),
                ));
            }
            let count = self.writer.write(bytes)?;
            self.remaining -= count as u64;
            Ok(count)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.writer.flush()
        }
    }
    use std::io::Write;
    let file = fs::File::create(path).map_err(|e| Diagnostic::io(path, e))?;
    let mut writer = Bounded {
        writer: BufWriter::new(file),
        remaining: limit,
    };
    serde_json::to_writer(&mut writer, value).map_err(|e| {
        failure(
            e.to_string(),
            crate::messages::text(
                "context.write_cache_json.rebuild_without_this_disposable_cache_entry",
            ),
        )
    })?;
    writer.flush().map_err(|e| Diagnostic::io(path, e))
}

impl Context {
    pub fn notice(&mut self, reason: impl Into<String>) -> Result<()> {
        self.report(HostCall::Notice {
            reason: reason.into(),
        })
    }
    pub fn warning(&mut self, reason: impl Into<String>) -> Result<()> {
        self.report(HostCall::Warning {
            reason: reason.into(),
        })
    }
    fn report(&mut self, call: HostCall) -> Result<()> {
        match self.client.call(call)? {
            HostReply::Changed { .. } => Ok(()),
            _ => Err(protocol_error(crate::messages::text(
                "context.notice.expected_a_notice_acknowledgement",
            ))),
        }
    }
    pub fn generator_id(&self) -> &str {
        &self.info.generator_id
    }
    pub fn value<T: DeserializeOwned>(&self, name: &str) -> Result<T> {
        let value = self.variables.get(name).ok_or_else(|| {
            failure(
                crate::messages::format(
                    "context.value.missing_variable_name",
                    &[("NAME", name.to_string())],
                ),
                crate::messages::text("context.value.define_it_in_the_owning_mod_project"),
            )
        })?;
        serde_json::from_value(value.clone()).map_err(|e| {
            failure(
                crate::messages::format(
                    "context.value.variable_name_e",
                    &[("NAME", name.to_string()), ("E", format!("{}", e))],
                ),
                crate::messages::text("context.value.correct_the_value_s_type_in_configuration"),
            )
        })
    }
    pub fn set_target_fixture(&mut self, path: &str, bytes: impl AsRef<[u8]>) -> Result<()> {
        let path = core::paths::game_relative(path)?;
        self.fixtures.insert(path, bytes.as_ref().to_vec());
        Ok(())
    }
    pub fn read_target(&mut self, path: &str) -> Result<String> {
        let mut files = self.read_targets(&[path])?;
        files.remove(path).ok_or_else(|| {
            protocol_error(crate::messages::text(
                "context.read_target.host_omitted_a_requested_target",
            ))
        })
    }
    /// Read input from before this project, including earlier projects' contributions.
    pub fn read_base_targets(&mut self, paths: &[&str]) -> Result<HashMap<String, String>> {
        match self.client.call(HostCall::ReadBaseTargets {
            paths: paths.iter().map(|path| (*path).to_owned()).collect(),
            kind: ContentKind::Text,
        })? {
            HostReply::Payloads { files } => files
                .into_iter()
                .map(|(path, payload)| Ok((path, read_text(&payload)?)))
                .collect(),
            _ => Err(protocol_error(crate::messages::text(
                "context.read_base_targets.expected_base_target_payloads",
            ))),
        }
    }
    pub fn read_targets(&mut self, paths: &[&str]) -> Result<HashMap<String, String>> {
        Ok(self
            .read_targets_with_hashes(paths)?
            .into_iter()
            .map(|(path, (text, _))| (path, text))
            .collect())
    }
    /// Return verified text and its checksum without hashing large inputs again.
    pub fn read_targets_with_hashes(
        &mut self,
        paths: &[&str],
    ) -> Result<HashMap<String, (String, String)>> {
        let mut result = HashMap::new();
        let mut missing = Vec::new();
        for path in paths {
            let normalized = core::paths::game_relative(path)?;
            if let Some(bytes) = self.fixtures.get(&normalized) {
                result.insert(
                    (*path).to_owned(),
                    (
                        String::from_utf8(bytes.clone()).map_err(|_| {
                            failure(
                                crate::messages::text(
                                    "context.read_targets_with_hashes.fixture_is_not_utf_8",
                                ),
                                crate::messages::text(
                                    "context.read_targets_with_hashes.use_a_text_fixture",
                                ),
                            )
                        })?,
                        core::hash(bytes),
                    ),
                );
            } else {
                missing.push((*path).to_owned());
            }
        }
        if !missing.is_empty() {
            match self.client.call(HostCall::ReadTargets {
                paths: missing,
                kind: ContentKind::Text,
            })? {
                HostReply::Payloads { files } => {
                    for verified in parallel::map(
                        &files,
                        parallel::Limits::from_env(),
                        |(_, payload)| payload.bytes as usize,
                        |(path, payload)| -> Result<_> {
                            Ok((path.clone(), (read_text(payload)?, payload.hash.clone())))
                        },
                    ) {
                        let (path, text) = verified?;
                        result.insert(path, text);
                    }
                }
                _ => {
                    return Err(protocol_error(crate::messages::text(
                        "context.read_targets_with_hashes.expected_target_payloads",
                    )));
                }
            }
        }
        Ok(result)
    }
    pub fn read_binary_target(&mut self, path: &str) -> Result<Vec<u8>> {
        let normalized = core::paths::game_relative(path)?;
        if let Some(bytes) = self.fixtures.get(&normalized) {
            return Ok(bytes.clone());
        }
        match self.client.call(HostCall::ReadTargets {
            paths: vec![path.into()],
            kind: ContentKind::Binary,
        })? {
            HostReply::Payloads { mut files } if files.len() == 1 => {
                read_payload(&files.remove(0).1)
            }
            _ => Err(protocol_error(crate::messages::text(
                "context.read_binary_target.expected_one_binary_payload",
            ))),
        }
    }
    pub fn read_owned_text(&mut self, path: &str) -> Result<String> {
        self.read_owned(path, OwnedScope::Owner)
    }
    pub fn read_mod_text(&mut self, path: &str) -> Result<String> {
        self.read_owned(path, OwnedScope::Mod)
    }
    pub fn read_persistent_text(&mut self, path: &str) -> Result<String> {
        self.read_owned(path, OwnedScope::Persistent)
    }
    pub fn persistent_root(&self) -> &Path {
        &self.info.storage.persistent_root
    }
    pub fn session_root(&self) -> &Path {
        &self.info.storage.session_root
    }
    pub fn session_path(&self, path: &str) -> Result<PathBuf> {
        core::paths::resolve(self.session_root(), path)
    }
    fn read_owned(&mut self, path: &str, scope: OwnedScope) -> Result<String> {
        core::paths::relative(path)?;
        match self.client.call(HostCall::ReadOwned {
            path: path.into(),
            scope,
        })? {
            HostReply::OptionalPayload { payload } => {
                payload.as_ref().map_or(Ok(String::new()), read_text)
            }
            _ => Err(protocol_error(crate::messages::text(
                "context.read_owned.expected_an_owned_file_payload",
            ))),
        }
    }
    pub fn resolve_path(&mut self, path: &str) -> Result<PathBuf> {
        self.resolve_owned(path, OwnedScope::Owner)
    }
    pub fn resolve_mod_path(&mut self, path: &str) -> Result<PathBuf> {
        self.resolve_owned(path, OwnedScope::Mod)
    }
    pub fn persistent_path(&mut self, path: &str) -> Result<PathBuf> {
        self.resolve_owned(path, OwnedScope::Persistent)
    }
    fn resolve_owned(&mut self, path: &str, scope: OwnedScope) -> Result<PathBuf> {
        core::paths::relative(path)?;
        match self.client.call(HostCall::ResolveOwned {
            path: path.into(),
            scope,
        })? {
            HostReply::Path { path, .. } => Ok(path),
            _ => Err(protocol_error(crate::messages::text(
                "context.resolve_owned.expected_an_owned_file_path",
            ))),
        }
    }
    pub fn write_owned_text(&mut self, path: &str, content: &str) -> Result<bool> {
        self.write_owned(path, content, OwnedScope::Owner)
    }
    pub fn write_mod_text(&mut self, path: &str, content: &str) -> Result<bool> {
        self.write_owned(path, content, OwnedScope::Mod)
    }
    pub fn write_persistent_text(&mut self, path: &str, content: &str) -> Result<bool> {
        self.write_owned(path, content, OwnedScope::Persistent)
    }
    fn write_owned(&mut self, path: &str, content: &str, scope: OwnedScope) -> Result<bool> {
        core::paths::relative(path)?;
        let created = self.client.call(HostCall::CreateOwned {
            path: path.into(),
            scope,
        })?;
        let payload = write_created(created, content.as_bytes(), ContentKind::Text)?;
        match self.client.call(HostCall::CommitOwned { payload })? {
            HostReply::Changed { changed } => Ok(changed),
            _ => Err(protocol_error(crate::messages::text(
                "context.write_owned.expected_owned_file_write_result",
            ))),
        }
    }
    pub fn output_text(&mut self, path: &str, content: impl AsRef<str>) -> Result<GeneratedFile> {
        self.output(path, content.as_ref().as_bytes(), ContentKind::Text)
    }
    pub fn output_generated(
        &mut self,
        path: &str,
        content: impl AsRef<str>,
    ) -> Result<GeneratedFile> {
        let mut output = self.output_text(path, content)?;
        output.generated_block_owners = vec![self.generator_id().to_owned()];
        Ok(output)
    }
    pub fn output_binary(&mut self, path: &str, bytes: impl AsRef<[u8]>) -> Result<GeneratedFile> {
        self.output(path, bytes.as_ref(), ContentKind::Binary)
    }
    fn output(&mut self, path: &str, bytes: &[u8], kind: ContentKind) -> Result<GeneratedFile> {
        let target = core::paths::game_relative(path)?;
        let created = self.client.call(HostCall::CreateOutput {
            target: target.clone(),
            kind,
        })?;
        let payload = write_created(created, bytes, kind)?;
        Ok(GeneratedFile {
            target_relative_path: target,
            payload,
            generated_block_owners: Vec::new(),
        })
    }
    pub fn output_stream(
        &mut self,
        target: &str,
        kind: ContentKind,
        write: impl FnOnce(&mut dyn std::io::Write) -> std::io::Result<()>,
    ) -> Result<GeneratedFile> {
        use std::io::Write;
        let target = core::paths::game_relative(target)?;
        let HostReply::Path { token, path } = self.client.call(HostCall::CreateOutput {
            target: target.clone(),
            kind,
        })?
        else {
            return Err(protocol_error(crate::messages::text(
                "common.shared.expected_output_staging_path",
            )));
        };
        let file = fs::File::create(&path).map_err(|e| Diagnostic::io(&path, e))?;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        write(&mut writer).map_err(|e| Diagnostic::io(&path, e))?;
        writer.flush().map_err(|e| Diagnostic::io(&path, e))?;
        let bytes = writer
            .get_ref()
            .metadata()
            .map_err(|e| Diagnostic::io(&path, e))?
            .len();
        drop(writer);
        let hash = core::paths::hash_file(&path)?;
        Ok(GeneratedFile {
            target_relative_path: target,
            payload: Payload {
                token,
                path,
                bytes,
                hash,
                kind,
            },
            generated_block_owners: Vec::new(),
        })
    }
    pub fn target_file(&mut self, path: &str, kind: ContentKind) -> Result<Payload> {
        let normalized = core::paths::game_relative(path)?;
        let payload = if let Some(bytes) = self.fixtures.get(&normalized).cloned() {
            let created = self.client.call(HostCall::CreateOutput {
                target: normalized,
                kind,
            })?;
            write_created(created, &bytes, kind)?
        } else {
            match self.client.call(HostCall::ReadTargets {
                paths: vec![path.into()],
                kind,
            })? {
                HostReply::Payloads { mut files } if files.len() == 1 => files.remove(0).1,
                _ => {
                    return Err(protocol_error(crate::messages::text(
                        "context.target_file.expected_one_file_payload",
                    )));
                }
            }
        };
        if fs::metadata(&payload.path)
            .map_err(|e| Diagnostic::io(&payload.path, e))?
            .len()
            != payload.bytes
            || core::paths::hash_file(&payload.path)? != payload.hash
        {
            return Err(protocol_error(crate::messages::text(
                "context.target_file.input_payload_changed",
            )));
        }
        Ok(payload)
    }
    pub fn output_file(
        &mut self,
        target: &str,
        source: &Path,
        kind: ContentKind,
    ) -> Result<GeneratedFile> {
        let target = core::paths::game_relative(target)?;
        let HostReply::Path { token, path } = self.client.call(HostCall::CreateOutput {
            target: target.clone(),
            kind,
        })?
        else {
            return Err(protocol_error(crate::messages::text(
                "common.shared.expected_output_staging_path",
            )));
        };
        core::paths::copy_atomic(source, &path)?;
        let bytes = fs::metadata(&path)
            .map_err(|e| Diagnostic::io(&path, e))?
            .len();
        let hash = core::paths::hash_file(&path)?;
        Ok(GeneratedFile {
            target_relative_path: target,
            payload: Payload {
                token,
                path,
                bytes,
                hash,
                kind,
            },
            generated_block_owners: Vec::new(),
        })
    }
    pub fn cache_enabled(&self) -> bool {
        self.info.cache_enabled
    }
    pub fn cache_key(&self, input: &impl Serialize) -> Result<String> {
        let bytes = serde_json::to_vec(&(self.info.cache_salt.as_str(), input)).map_err(|e| {
            failure(
                e.to_string(),
                crate::messages::text("context.cache_key.use_serializable_cache_key_inputs"),
            )
        })?;
        Ok(core::hash(bytes))
    }
    pub fn cache_read<T: DeserializeOwned>(
        &mut self,
        namespace: &str,
        key: &str,
    ) -> Result<Option<T>> {
        check_cache_name(namespace)?;
        check_cache_name(key)?;
        if !self.cache_enabled() {
            return Ok(None);
        }
        match self.client.call(HostCall::CacheRead {
            namespace: namespace.into(),
            key: key.into(),
        })? {
            HostReply::OptionalPayload { payload } => match payload {
                Some(payload) => Ok(read_payload(&payload)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())),
                None => Ok(None),
            },
            _ => Err(protocol_error(crate::messages::text(
                "context.cache_read.expected_a_cached_payload",
            ))),
        }
    }
    pub fn cache_write(
        &mut self,
        namespace: &str,
        key: &str,
        value: &impl Serialize,
    ) -> Result<()> {
        check_cache_name(namespace)?;
        check_cache_name(key)?;
        if !self.cache_enabled() {
            return Ok(());
        }
        let created = self.client.call(HostCall::CacheCreate {
            namespace: namespace.into(),
            key: key.into(),
        });
        let HostReply::Path { token, path } = (match created {
            Ok(created) => created,
            Err(error) if error.category == "IoError" => {
                return self.notice(crate::messages::format(
                    "context.cache_write.skipped_cache_write_arg0",
                    &[("ARG0", error.reason.to_string())],
                ));
            }
            Err(error) => return Err(error),
        }) else {
            return Err(protocol_error(crate::messages::text(
                "context.cache_write.expected_cache_staging_path",
            )));
        };
        if let Err(error) = write_cache_json(&path, value, self.info.cache_max_bytes) {
            return self.notice(crate::messages::format(
                "context.cache_write.skipped_cache_write_arg0",
                &[("ARG0", error.reason.to_string())],
            ));
        }
        let payload = (|| -> Result<Payload> {
            Ok(Payload {
                token,
                bytes: fs::metadata(&path)
                    .map_err(|e| Diagnostic::io(&path, e))?
                    .len(),
                hash: core::paths::hash_file(&path)?,
                path,
                kind: ContentKind::Binary,
            })
        })();
        let payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                return self.notice(crate::messages::format(
                    "context.cache_write.skipped_cache_write_arg0",
                    &[("ARG0", error.reason.to_string())],
                ));
            }
        };
        match self.client.call(HostCall::CacheCommit { payload })? {
            HostReply::Changed { .. } => Ok(()),
            _ => Err(protocol_error(crate::messages::text(
                "context.cache_write.expected_a_cache_write_result",
            ))),
        }
    }
    /// Use the current mod and patch when applying NDF operations outside `patch`.
    pub fn patch_identity(&self, path: &str) -> ndf::operation::Identity {
        ndf::operation::Identity {
            mod_id: self.info.r#mod.id.clone(),
            mod_name: self.info.r#mod.name.clone(),
            patch_id: self
                .info
                .patch
                .as_ref()
                .map_or_else(String::new, |p| p.id.clone()),
            path: path.into(),
            ..Default::default()
        }
    }
    pub fn patch(
        &self,
        source: &str,
        path: &str,
        operations: &[Value],
    ) -> Result<ndf::patch::PatchResult> {
        ndf::patch::apply(
            source,
            &ndf::operation::expand(operations, &self.variables)?,
            &self.patch_identity(path),
        )
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    #[test]
    fn cache_serialization_streams_with_a_finite_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let value = vec!["payload"; 100];
        assert!(write_cache_json(&path, &value, 20).is_err());
        assert!(fs::metadata(&path).unwrap().len() <= 20);
        write_cache_json(&path, &value, 4096).unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&fs::read(path).unwrap()).unwrap(),
            value
        );
    }
}
