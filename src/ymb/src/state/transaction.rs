use super::*;

impl Transaction {
    pub fn begin(context: &Context, command: &str) -> Result<Self> {
        if context.journal.exists() {
            return Err(recovery(
                &context.journal,
                crate::messages::text(
                    "state.transaction.begin.an_interrupted_operation_is_still_pending",
                ),
            ));
        }
        let journal = Journal {
            version: metadata::JOURNAL_VERSION,
            command: command.into(),
            roots: root_identity(context),
            committed: false,
            files: Vec::new(),
            directories: Vec::new(),
        };
        let bytes = checked_metadata(
            serde_json::to_vec(&journal).unwrap(),
            &context.journal.join("transaction.json"),
        )?;
        let staged = paths::temporary_sibling(&context.journal);
        fs::create_dir_all(staged.join("snapshots")).map_err(|e| Diagnostic::io(&staged, e))?;
        paths::write_atomic(&staged.join("transaction.json"), bytes)?;
        paths::rename(&staged, &context.journal)
            .map_err(|e| Diagnostic::io(&context.journal, e))?;
        Ok(Self {
            context: context.clone(),
            journal,
        })
    }
    pub(super) fn save(&self) -> Result<()> {
        paths::write_atomic(
            &self.context.journal.join("transaction.json"),
            checked_metadata(
                serde_json::to_vec(&self.journal).unwrap(),
                &self.context.journal.join("transaction.json"),
            )?,
        )
    }
    fn protect(&mut self, root: Root, path: &str, next: Option<String>) -> Result<PathBuf> {
        let path = paths::relative(path)?;
        let absolute = journal_path(&self.context, &root, &path)?;
        if let Some(file) = self
            .journal
            .files
            .iter_mut()
            .find(|file| file.root == root && paths::key(&file.path) == paths::key(&path))
        {
            let actual = file_hash(&absolute)?;
            if actual != file.hash && !file.postimages.contains(&actual) {
                return Err(recovery(
                    &absolute,
                    crate::messages::text(
                        "state.transaction.protect.a_protected_file_changed_outside_this_operation",
                    ),
                ));
            }
            if !file.postimages.contains(&next) {
                file.postimages.push(next);
                self.save()?;
            }
            return Ok(absolute);
        }
        let hash_before = file_hash(&absolute)?;
        let snapshot = hash_before
            .as_ref()
            .map(|_| format!("{}.bin", hash(format!("{root:?}:{path}"))));
        if let Some(snapshot) = &snapshot {
            let destination = self.context.journal.join("snapshots").join(snapshot);
            paths::copy_atomic(&absolute, &destination)?;
            if paths::hash_file(&destination)? != *hash_before.as_ref().unwrap() {
                return Err(recovery(
                    &absolute,
                    crate::messages::text(
                        "state.transaction.protect.a_protected_file_changed_while_its_preimage",
                    ),
                ));
            }
        }
        self.journal.files.push(ProtectedFile {
            root,
            path,
            existed: hash_before.is_some(),
            snapshot,
            hash: hash_before,
            postimages: vec![next],
        });
        self.save()?;
        Ok(absolute)
    }
    pub fn write(&mut self, root: Root, path: &str, content: &[u8]) -> Result<()> {
        let absolute = self.protect(root, path, Some(hash(content)))?;
        paths::write_atomic(&absolute, content)
    }
    pub fn copy(&mut self, root: Root, path: &str, source: &Path) -> Result<()> {
        let absolute = self.protect(root, path, Some(paths::hash_file(source)?))?;
        paths::copy_atomic(source, &absolute)
    }
    pub fn remove(&mut self, root: Root, path: &str) -> Result<()> {
        let absolute = self.protect(root, path, None)?;
        match fs::remove_file(&absolute) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Diagnostic::io(&absolute, e)),
        }
    }
    pub fn publish_preview(&mut self, staged: &Path) -> Result<()> {
        paths::assert_no_links(&self.context.work, staged)?;
        let destination = &self.context.output;
        let previous = paths::temporary_sibling(destination);
        let previous_name = previous.file_name().unwrap().to_string_lossy().to_string();
        let existed = destination
            .try_exists()
            .map_err(|e| Diagnostic::io(destination, e))?;
        let previous_hash = if existed {
            Some(tree_hash(destination, &self.context)?)
        } else {
            None
        };
        let published_hash = tree_hash(staged, &self.context)?;
        self.journal.directories.push(DirectorySwap {
            path: "output".into(),
            previous: previous_name,
            existed,
            previous_hash,
            published_hash,
        });
        self.save()?;
        if existed {
            paths::rename(destination, &previous).map_err(|e| Diagnostic::io(destination, e))?;
        }
        paths::rename(staged, destination).map_err(|e| Diagnostic::io(destination, e))
    }
    pub fn commit(mut self) -> Result<()> {
        self.journal.committed = true;
        self.save()?;
        self.finish().map_err(|error| {
            error.detail(crate::messages::text("state.transaction.commit.the_operation_committed_successfully_only_journal_cleanup"))
        })
    }
    pub(super) fn finish(&self) -> Result<()> {
        check_swaps(&self.context, &self.journal, true)?;
        for swap in &self.journal.directories {
            let path = paths::resolve(&self.context.work, &swap.previous)?;
            if path.exists() {
                fs::remove_dir_all(&path).map_err(|e| Diagnostic::io(&path, e))?;
            }
        }
        fs::remove_dir_all(&self.context.journal)
            .map_err(|e| Diagnostic::io(&self.context.journal, e))
    }
    pub fn rollback(self) -> Result<()> {
        rollback(&self.context, &self.journal)
    }
}
pub(super) fn root_identity(context: &Context) -> Vec<String> {
    [&context.game, &context.state, &context.mods, &context.work]
        .iter()
        .map(|path| paths::key(path.to_string_lossy()))
        .collect()
}
pub(super) fn journal_path(context: &Context, root: &Root, path: &str) -> Result<PathBuf> {
    if *root == Root::Game {
        paths::game_relative(path)?;
    }
    if *root == Root::Mods {
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() < 3 || parts[1] != "config" {
            return Err(recovery(
                &context.journal,
                crate::messages::text(
                    "state.transaction.journal_path.an_authored_state_journal_target_lies_outside",
                ),
            ));
        }
    }
    let root = match root {
        Root::Game => &context.game,
        Root::State => &context.state,
        Root::Mods => &context.mods,
        Root::Work => &context.work,
    };
    paths::resolve(root, path)
}
