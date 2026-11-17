use super::*;

pub(super) fn template_snapshot(
    store: &Store,
    input: &Snapshot,
    target: &str,
    variables: &Value,
    template: bool,
) -> Result<Snapshot> {
    let output = if template {
        let text = input.text()?;
        let resolved = templates::resolve(&json!(text), variables)?;
        let text = resolved
            .as_str()
            .map_or_else(|| resolved.to_string(), str::to_owned);
        store.put(text, ContentKind::Text)?
    } else {
        input.clone()
    };
    if is_ndf(target) {
        store.validate_ndf(&output, target)?;
    }
    Ok(output)
}
pub(super) fn patch_after(plan: &Plan, later: PatchRef, earlier: PatchRef) -> bool {
    let mut pending = vec![later];
    let mut seen = HashSet::new();
    while let Some(key) = pending.pop() {
        if !seen.insert(key) {
            continue;
        }
        if let Some(deps) = plan.patch_dependencies.get(&key) {
            if deps.contains(&earlier) {
                return true;
            }
            pending.extend(deps);
        }
    }
    false
}
pub(super) fn file_operations(
    built: &mut Materialized<'_>,
    key: PatchRef,
    variables: &Value,
    file_owners: &mut HashMap<String, PatchRef>,
) -> Result<()> {
    let plan = built.plan;
    let project = &plan.projects[key.project];
    let patch = plan.patch(key);
    for operation in &patch.config.files {
        if operation.op == "remove" {
            let target = paths::game_relative(&resolve_path_template(
                operation.target.as_ref().unwrap(),
                variables,
            )?)?;
            let mut candidates = game_files(built, &target)?;
            for output in built.outputs.values() {
                if output.target.eq_ignore_ascii_case(&target)
                    || paths::key(&output.target).starts_with(&format!("{}/", paths::key(&target)))
                {
                    candidates.insert(output.target.clone());
                }
            }
            let mut count = 0;
            for target in candidates {
                let target_key = paths::key(&target);
                let exists = built.visible(&target, key.project)?.is_some();
                if !exists {
                    continue;
                }
                check_file_owner(plan, file_owners, key, &target)?;
                let output = Output {
                    target: target.clone(),
                    content: None,
                    contributors: vec![contributor(project, Some(patch), None)],
                    source_type: "file".into(),
                    preserve: true,
                };
                let observed = built
                    .outputs
                    .get(&target_key)
                    .and_then(|o| o.content.as_ref())
                    .map(|s| s.hash.clone());
                built.combine(output, key.project, observed.as_deref(), &[])?;
                file_owners.insert(target_key, key);
                count += 1;
            }
            if let Some(expect) = &operation.expect
                && count != expect.files
            {
                return Err(conflict(
                    &target,
                    crate::messages::format(
                        "engine.files.file_operations.file_operation_expected_arg0_files_found_arg1",
                        &[
                            ("ARG0", format!("{}", expect.files)),
                            ("ARG1", format!("{}", count)),
                        ],
                    ),
                ));
            }
            if count == 0 {
                built.notices.push(json!({"code":"W10","modId":project.config.id,"patchId":patch.config.id,"path":target,"reason":crate::messages::text("engine.files.file_operations.file_removal_has_no_files_left_to")}));
            }
            continue;
        }
        let source = operation.source.as_ref().unwrap();
        let source_path = paths::relative(&resolve_path_template(&source.path, variables)?)?;
        let destination = paths::game_relative(&resolve_path_template(
            operation.destination.as_ref().unwrap(),
            variables,
        )?)?;
        let source_root = match source.root.as_str() {
            "patch" => patch.root.clone(),
            "mod" => project.config_root.clone(),
            "game" => plan.context.game.clone(),
            "exampleAssets" => plan
                .context
                .game
                .parent()
                .unwrap_or(&plan.context.game)
                .join("ExampleAssets"),
            _ => unreachable!(),
        };
        let absolute = paths::resolve(&source_root, &source_path)?;
        let mut sources: BTreeMap<String, String> = BTreeMap::new();
        let game = source.root == "game";
        if game {
            paths::game_relative(&source_path)?;
            for file in game_files(built, &source_path)? {
                let suffix = if file.eq_ignore_ascii_case(&source_path) {
                    String::new()
                } else {
                    file[source_path.len() + 1..].into()
                };
                sources.insert(suffix, file);
            }
        } else if absolute.is_file() {
            sources.insert(String::new(), source_path.clone());
        } else if absolute.is_dir() {
            for file in paths::walk(&absolute, true)? {
                let suffix = file
                    .strip_prefix(&absolute)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let relative = file
                    .strip_prefix(&source_root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                sources.insert(suffix, relative);
            }
        }
        if sources.is_empty() {
            return Err(missing(&source_path));
        }
        if let Some(expect) = &operation.expect
            && expect.files != sources.len()
        {
            return Err(conflict(
                &source_path,
                crate::messages::format(
                    "engine.files.file_operations.file_operation_expected_arg0_files_found_arg1",
                    &[
                        ("ARG0", format!("{}", expect.files)),
                        ("ARG1", format!("{}", sources.len())),
                    ],
                ),
            ));
        }
        for (suffix, source_path) in sources {
            let target = if suffix.is_empty() {
                destination.clone()
            } else {
                paths::game_relative(&format!("{destination}/{suffix}"))?
            };
            let target_key = paths::key(&target);
            check_file_owner(plan, file_owners, key, &target)?;
            let existing = built.visible(&target, key.project)?;

            if operation.op == "add" && existing.is_some() {
                return Err(conflict(
                    &target,
                    crate::messages::text(
                        "engine.files.file_operations.add_requires_an_absent_destination",
                    ),
                ));
            }
            if operation.op == "replace" && existing.is_none() {
                return Err(missing(&target));
            }
            let input = if game {
                built
                    .original(&source_path)?
                    .ok_or_else(|| missing(&source_path))?
            } else {
                let path = paths::resolve(&source_root, &source_path)?;
                built
                    .owned
                    .get(&path)
                    .cloned()
                    .map_or_else(|| built.store.capture(&path, kind(&source_path)), Ok)?
            };
            let snapshot = template_snapshot(
                &built.store,
                &input,
                &target,
                variables,
                !matches!(source.root.as_str(), "game" | "exampleAssets")
                    && (template_file(&source_path) || is_ndf(&target)),
            )?;
            built.combine(
                Output {
                    target: target.clone(),
                    content: Some(snapshot),
                    contributors: vec![contributor(project, Some(patch), None)],
                    source_type: "file".into(),
                    preserve: matches!(source.root.as_str(), "game" | "exampleAssets")
                        || !(template_file(&source_path) || is_ndf(&target)),
                },
                key.project,
                existing.as_ref().map(|s| s.hash.as_str()),
                &[],
            )?;
            file_owners.insert(target_key, key);
        }
    }
    Ok(())
}
pub(super) fn check_file_owner(
    plan: &Plan,
    owners: &HashMap<String, PatchRef>,
    key: PatchRef,
    target: &str,
) -> Result<()> {
    if let Some(previous) = owners.get(&paths::key(target))
        && *previous != key
        && !patch_after(plan, key, *previous)
    {
        return Err(conflict(
            target,
            crate::messages::text(
                "engine.files.check_file_owner.patches_changing_the_same_file_need_an",
            ),
        ));
    }
    Ok(())
}
pub(super) fn game_files(
    built: &mut Materialized<'_>,
    target: &str,
) -> Result<std::collections::BTreeSet<String>> {
    let path = built.plan.context.target(target)?;
    let mut files = std::collections::BTreeSet::new();
    if path.is_file() {
        files.insert(target.to_owned());
    } else if path.is_dir() {
        for file in paths::walk(&path, true)? {
            files.insert(
                file.strip_prefix(&built.plan.context.game)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    for entry in &built.manifest.entries {
        let relative = &entry.target_relative_path;
        if entry.original_exists
            && (relative.eq_ignore_ascii_case(target)
                || paths::key(relative).starts_with(&format!("{}/", paths::key(target))))
        {
            files.insert(relative.clone());
        }
    }
    Ok(files)
}

pub(super) fn check_references(
    built: &mut Materialized<'_>,
    removed: &HashMap<PatchRef, String>,
) -> Result<()> {
    let mut wanted = BTreeMap::new();
    let mut declaring_targets = HashSet::new();
    for key in &built.plan.patches {
        if removed.contains_key(key) {
            continue;
        }
        let variables = built.variables(key.project, Some(key.patch))?;
        for target in &built.plan.patch(*key).config.targets {
            if let Some(expect) = &target.expect {
                if !expect.referenced.is_empty() {
                    declaring_targets
                        .insert(paths::key(resolve_path_template(&target.file, &variables)?));
                }
                for name in &expect.referenced {
                    wanted.insert(resolve_path_template(name, &variables)?, *key);
                }
            }
        }
    }
    if wanted.is_empty() {
        return Ok(());
    }
    let mut found = HashSet::new();
    for scan_game in [false, true] {
        if found.len() == wanted.len() {
            break;
        }
        let mut candidates = BTreeMap::new();
        if scan_game {
            for root in ["GameData", "CommonData"] {
                for file in paths::walk(&built.plan.context.game.join(root), true)? {
                    let relative = file
                        .strip_prefix(&built.plan.context.game)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    let key = paths::key(&relative);
                    if is_ndf(&relative) && !built.outputs.contains_key(&key) {
                        candidates.insert((false, key), (relative, None));
                    }
                }
            }
        } else {
            for output in built.outputs.values() {
                candidates.insert(
                    (
                        !declaring_targets.contains(&paths::key(&output.target)),
                        paths::key(&output.target),
                    ),
                    (output.target.clone(), output.content.clone()),
                );
            }
        }
        for ((_, key), (target, snapshot)) in candidates {
            if found.len() == wanted.len() {
                break;
            }
            if !is_ndf(&target) {
                continue;
            }
            if built
                .outputs
                .get(&key)
                .is_some_and(|output| output.content.is_none())
            {
                continue;
            }
            let snapshot = match snapshot {
                Some(snapshot) => Some(snapshot),
                None => built.original(&target)?,
            };
            let Some(snapshot) = snapshot else {
                continue;
            };
            let source = snapshot.text()?;
            if !wanted
                .keys()
                .any(|name| !found.contains(name) && source.contains(name))
            {
                continue;
            }
            let mut lexer = ndf::lexer::Lexer::new(&source, 0);
            let mut token = lexer.next_token()?;
            while token.kind != ndf::lexer::Kind::Eof && found.len() != wanted.len() {
                let next = lexer.next_token()?;
                if token.kind == ndf::lexer::Kind::Word && next.text != "is" {
                    for name in wanted.keys() {
                        if token.text == name || token.text.split('/').any(|part| part == name) {
                            found.insert(name.clone());
                        }
                    }
                }
                token = next;
            }
        }
    }
    let errors = wanted
        .into_iter()
        .filter(|(name, _)| !found.contains(name))
        .map(|(name, key)| {
            *attach(
                Diagnostic::new(
                    "SelectorError",
                    crate::messages::format(
                        "engine.files.check_references.no_finished_ndf_file_references_name",
                        &[("NAME", name.to_string())],
                    ),
                    crate::messages::text(
                        "engine.files.check_references.update_the_block_that_should_reference_it",
                    ),
                )
                .at(&built.plan.patch(key).config_path),
                &built.plan.projects[key.project],
                Some(built.plan.patch(key)),
            )
        })
        .collect();
    match Diagnostic::group(errors) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
