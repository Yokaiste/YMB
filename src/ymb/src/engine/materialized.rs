use super::*;

impl<'a> Materialized<'a> {
    pub fn base_target(&mut self, path: &str) -> Result<Option<Snapshot>> {
        match self.project_base.get(&paths::key(path)) {
            Some(output) => Ok(output.content.clone()),
            None => self.original(path),
        }
    }
    pub fn new(plan: &'a Plan) -> Result<Self> {
        let built = Self::inspection(plan)?;
        built.manifest.validate_backups(&plan.context)?;
        Ok(built)
    }
    pub fn inspection(plan: &'a Plan) -> Result<Self> {
        let manifest = Manifest::load(&plan.context)?;

        Ok(Self {
            plan,
            store: Store::new(&plan.context)?,
            cache: Cache::new(&plan.context, plan.selection.use_cache),
            generator_caches: HashMap::new(),
            manifest,
            originals: BTreeMap::new(),
            outputs: BTreeMap::new(),
            project_base: BTreeMap::new(),
            owned: BTreeMap::new(),
            owned_originals: BTreeMap::new(),
            replace_catalog: HashMap::new(),
            read_values_cache: HashMap::new(),
            notices: Vec::new(),
            tests: Vec::new(),
            skipped: Vec::new(),
            metrics: Metrics::default(),
            compiled: HashMap::new(),
        })
    }
    pub fn original(&mut self, target: &str) -> Result<Option<Snapshot>> {
        let target = paths::game_relative(target)?;
        let key = paths::key(&target);
        if let Some(snapshot) = self.originals.get(&key) {
            return Ok(snapshot.clone());
        }
        let snapshot = if let Some(entry) = self
            .manifest
            .entries
            .iter()
            .find(|entry| paths::key(&entry.target_relative_path) == key)
        {
            if entry.original_exists {
                Some(self.store.capture(
                    &state::original_backup(&self.plan.context, entry)?,
                    kind(&target),
                )?)
            } else {
                None
            }
        } else {
            let path = self.plan.context.target(&target)?;
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_file() || paths::is_link(&metadata) {
                        return Err(state::recovery(
                            &path,
                            crate::messages::text("common.shared.input_is_not_a_regular_file"),
                        ));
                    }
                    let snapshot = self.store.capture(&path, kind(&target))?;
                    if let Some((open, _)) = state::comment_style(&target) {
                        use std::io::Read;
                        let mut prefix = [0; 128];
                        let count = std::fs::File::open(&snapshot.path)
                            .and_then(|mut file| file.read(&mut prefix))
                            .map_err(|e| Diagnostic::io(&path, e))?;
                        if prefix[..count].starts_with(format!("{open}YMB-START ").as_bytes()) {
                            return Err(state::recovery(
                                &path,
                                crate::messages::text(
                                    "engine.materialized.original.a_ymb_marked_file_has_no_saved",
                                ),
                            ));
                        }
                    }
                    Some(snapshot)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(Diagnostic::io(&path, error)),
            }
        };
        self.originals.insert(key, snapshot.clone());
        Ok(snapshot)
    }
    pub fn visible(&mut self, target: &str, project: usize) -> Result<Option<Snapshot>> {
        let key = paths::key(target);
        if let Some(output) = self.outputs.get(&key) {
            let visible = output.contributors.iter().all(|owner| {
                self.project_id(&owner.mod_id).is_some_and(|earlier| {
                    earlier == project || self.plan.can_layer(project, earlier)
                })
            });
            if visible {
                return Ok(output.content.clone());
            }
        }
        let replace = self.plan.projects[project].config_root.join("replace");
        let sources = self.replacement_sources(project)?;
        if !sources.is_empty() {
            let variables = self.variables(project, None)?;
            for source in sources {
                let relative = paths::strip_prefix(&replace, &source)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if paths::key(resolve_path_template(&relative, &variables)?) == key {
                    let input = if let Some(snapshot) = self.overlay(&source) {
                        snapshot.clone()
                    } else {
                        self.store.capture(&source, kind(target))?
                    };
                    return template_snapshot(
                        &self.store,
                        &input,
                        target,
                        &variables,
                        template_file(&source.to_string_lossy()) || is_ndf(target),
                    )
                    .map(Some);
                }
            }
        }
        self.original(target)
    }
    fn project_id(&self, id: &str) -> Option<usize> {
        self.plan.projects.iter().position(|p| p.config.id == id)
    }
    pub(super) fn replacement_sources(&mut self, project: usize) -> Result<Vec<PathBuf>> {
        let replace = self.plan.projects[project].config_root.join("replace");
        if let std::collections::hash_map::Entry::Vacant(entry) =
            self.replace_catalog.entry(project)
        {
            entry.insert(paths::walk(&replace, true)?.into_iter().collect());
        }
        let mut sources: BTreeMap<_, _> = self.replace_catalog[&project]
            .iter()
            .map(|path| (paths::key(path.to_string_lossy()), path.clone()))
            .collect();
        sources.extend(
            self.owned
                .keys()
                .filter(|path| paths::strip_prefix(&replace, path).is_some())
                .map(|path| (paths::key(path.to_string_lossy()), path.clone())),
        );
        Ok(sources.into_values().collect())
    }
    pub fn overlay(&self, path: &Path) -> Option<&Snapshot> {
        let key = paths::key(path.to_string_lossy());
        self.owned
            .iter()
            .find(|(p, _)| paths::key(p.to_string_lossy()) == key)
            .map(|(_, value)| value)
    }
    pub fn stage_owned(&mut self, path: &Path, snapshot: Snapshot) {
        let key = paths::key(path.to_string_lossy());
        let path = self
            .owned
            .keys()
            .find(|p| paths::key(p.to_string_lossy()) == key)
            .cloned()
            .unwrap_or_else(|| path.to_owned());
        self.owned.insert(path, snapshot);
    }
    pub fn owned_read(&mut self, path: &Path) -> Result<Option<Snapshot>> {
        if let Some(snapshot) = self.overlay(path) {
            return Ok(Some(snapshot.clone()));
        }
        let original_hash = state::file_hash(path)?;
        let key = paths::key(path.to_string_lossy());
        if !self
            .owned_originals
            .keys()
            .any(|path| paths::key(path.to_string_lossy()) == key)
        {
            self.owned_originals
                .insert(path.to_owned(), original_hash.clone());
        }
        match original_hash {
            Some(_) => self.store.capture(path, ContentKind::Text).map(Some),
            None => Ok(None),
        }
    }
    pub fn variables(&mut self, project: usize, patch: Option<usize>) -> Result<Value> {
        let owner = &self.plan.projects[project];
        let mut reads = self.read_values(&owner.config.read_values)?;
        let patch = patch.map(|id| &owner.patches[id]);
        if let Some(patch) = patch {
            templates::merge(&mut reads, &self.read_values(&patch.config.read_values)?);
        }
        let raw = config::variables(&self.plan.context, owner, patch, &reads)?;
        templates::resolve(&raw, &raw)
    }
    fn read_values(&mut self, requests: &BTreeMap<String, ReadValue>) -> Result<Value> {
        let mut values = json!({});
        for (name, request) in requests {
            let key = (paths::key(&request.file), request.path.clone());
            if let Some(value) = self.read_values_cache.get(&key) {
                values[name] = value.clone();
                continue;
            }
            let input = self
                .original(&request.file)?
                .ok_or_else(|| missing(&request.file))?;
            let source = input.text().map_err(|error| error.at(&request.file))?;
            let parts =
                ndf::read::split_path(&request.path).map_err(|error| error.at(&request.file))?;
            let value = if parts.len() == 1 && !parts[0].starts_with('@') {
                ndf::read::numeric_definitions(&source)
                    .map_err(|error| error.at(&request.file))?
                    .get(&parts[0])
                    .cloned()
                    .ok_or_else(|| {
                        config::config_error(
                            Path::new(&request.file),
                            crate::messages::format("engine.materialized.read_values.numeric_definition_arg0_was_not_found", &[("ARG0", request.path.to_string())]),
                        )
                    })?
            } else {
                let range = ndf::read::path_range(&source, &request.path)
                    .map_err(|error| error.at(&request.file))?;
                let raw = source[range].trim();
                raw.parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .map_or_else(|| Ok(json!(raw)), templates::number)?
            };
            self.read_values_cache.insert(key, value.clone());
            values[name] = value;
        }
        Ok(values)
    }
    pub fn combine(
        &mut self,
        next: Output,
        project: usize,
        observed: Option<&str>,
        owners: &[String],
    ) -> Result<()> {
        let key = paths::key(&next.target);
        for (existing_key, existing) in &self.outputs {
            if existing_key != &key
                && (existing_key.starts_with(&format!("{key}/"))
                    || key.starts_with(&format!("{existing_key}/")))
            {
                return Err(conflict(
                    &next.target,
                    crate::messages::text(
                        "engine.materialized.combine.a_file_target_overlaps_another_output_s",
                    ),
                )
                .with("otherTarget", &existing.target));
            }
        }
        let Some(previous) = self.outputs.get(&key).cloned() else {
            self.outputs.insert(key, next);
            return Ok(());
        };
        let mut contributors = previous.contributors.clone();
        for owner in &next.contributors {
            if !contributors.contains(owner) {
                contributors.push(owner.clone());
            }
        }
        let permitted = previous.contributors.iter().all(|owner| {
            self.project_id(&owner.mod_id)
                .is_some_and(|earlier| earlier == project || self.plan.can_layer(project, earlier))
        });
        let merged = (|| -> Result<Option<Snapshot>> {
            Ok(match (&previous.content, &next.content) {
                (None, None) => None,
                (Some(a), Some(b)) if a.hash == b.hash => Some(a.clone()),
                (Some(a), Some(b)) => {
                    if !owners.is_empty() {
                        let current = a.text()?;
                        let proposed = b.text()?;
                        let original = if permitted && observed == Some(a.hash.as_str()) {
                            current.clone()
                        } else {
                            self.original(&next.target)?
                                .map(|s| s.text())
                                .transpose()?
                                .unwrap_or_default()
                        };
                        let merged = generated::merge(
                            &original,
                            &current,
                            &proposed,
                            owners,
                            self.plan.context.config.settings.diff_budget(),
                        )?
                        .ok_or_else(|| {
                            conflict(
                                &next.target,
                                crate::messages::text("engine.materialized.combine.generated_output_changes_text_outside_its_declared"),
                            )
                        })?;
                        Some(self.store.put(merged, ContentKind::Text)?)
                    } else if permitted
                        && (observed == Some(a.hash.as_str()) || next.source_type == "replace")
                    {
                        Some(b.clone())
                    } else {
                        if previous.preserve || next.preserve {
                            return Err(conflict(
                                &next.target,
                                crate::messages::text(
                                    "engine.materialized.combine.independent_byte_exact_outputs_contain_different_data",
                                ),
                            ));
                        }
                        let base=self.original(&next.target)?.ok_or_else(||conflict(&next.target,crate::messages::text("engine.materialized.combine.independent_outputs_create_different_versions_of_the")))?.text()?;
                        let merged = text::merge(
                            &base,
                            &[&a.text()?, &b.text()?],
                            self.plan.context.config.settings.diff_budget(),
                        )
                        .map_err(|e| e.at(&next.target).with("contributors", &contributors))?;
                        Some(self.store.put(merged, ContentKind::Text)?)
                    }
                }
                _ if permitted
                    && previous.content.as_ref().map(|s| s.hash.as_str()) == observed =>
                {
                    next.content.clone()
                }
                _ => {
                    return Err(conflict(
                        &next.target,
                        crate::messages::text(
                            "engine.materialized.combine.a_deletion_conflicts_with_another_contribution",
                        ),
                    ));
                }
            })
        })();
        let content = match merged {
            Ok(content) => content,
            Err(error) => {
                return self.report_conflict(&previous, &next, error);
            }
        };
        self.outputs.insert(
            key,
            Output {
                content,
                contributors,
                preserve: previous.preserve && next.preserve,
                ..next
            },
        );
        Ok(())
    }
    fn report_conflict(
        &mut self,
        previous: &Output,
        next: &Output,
        error: Box<Diagnostic>,
    ) -> Result<()> {
        let directory = self.plan.context.conflicts.join(hash(&next.target));
        paths::assert_no_links(&self.plan.context.work, &directory)?;
        if let Some(base) = self.original(&next.target)? {
            paths::copy_atomic(&base.path, &directory.join("original.bin"))?;
        }
        for (name, output) in [("current", previous), ("incoming", next)] {
            if let Some(snapshot) = &output.content {
                paths::copy_atomic(&snapshot.path, &directory.join(format!("{name}.bin")))?;
            }
            paths::write_atomic(&directory.join(format!("{name}.json")),serde_json::to_vec_pretty(&json!({"target":output.target,"deleted":output.content.is_none(),"contributors":output.contributors})).unwrap())?;
        }
        Err(error.with("conflictPreviewPath", &directory).detail(
            crate::messages::text("engine.materialized.report_conflict.compare_original_current_and_incoming_files_in"),
        ))
    }
}
