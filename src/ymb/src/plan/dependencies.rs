use super::*;

pub(super) fn expand_mods(
    projects: &[ModProject],
    by_id: &HashMap<String, usize>,
    selected: &mut BTreeSet<usize>,
    dependencies: &mut HashMap<usize, HashSet<usize>>,
) -> Result<()> {
    let mut pending: Vec<_> = selected.iter().copied().collect();
    let mut cursor = 0;
    while cursor < pending.len() {
        let id = pending[cursor];
        cursor += 1;
        let mut found = HashSet::new();
        for reference in &projects[id].config.depends_on {
            let dependency = *by_id.get(reference).ok_or_else(|| {
                config_error(
                    &projects[id].config_path,
                    crate::messages::format(
                        "plan.dependencies.expand_mods.required_mod_project_reference_is_missing",
                        &[("REFERENCE", reference.to_string())],
                    ),
                )
            })?;
            if !projects[dependency].config.enabled {
                return Err(config_error(
                    &projects[id].config_path,
                    crate::messages::format(
                        "plan.dependencies.expand_mods.required_mod_project_reference_is_disabled",
                        &[("REFERENCE", reference.to_string())],
                    ),
                ));
            }
            if projects[id].config.priority < projects[dependency].config.priority {
                return Err(config_error(
                    &projects[id].config_path,
                    crate::messages::format(
                        "plan.dependencies.expand_mods.project_arg0_has_lower_priority_than_dependency",
                        &[
                            ("ARG0", projects[id].config.id.to_string()),
                            ("REFERENCE", reference.to_string()),
                        ],
                    ),
                ));
            }
            found.insert(dependency);
            if selected.insert(dependency) {
                pending.push(dependency);
            }
        }
        dependencies.insert(id, found);
    }
    Ok(())
}
pub(super) fn order_mods(
    projects: &[ModProject],
    selected: &BTreeSet<usize>,
    dependencies: &HashMap<usize, HashSet<usize>>,
) -> Result<Vec<usize>> {
    let mut remaining = selected.clone();
    let mut ordered = Vec::new();
    let mut done = HashSet::new();
    while !remaining.is_empty() {
        let next = remaining
            .iter()
            .filter(|id| {
                dependencies
                    .get(id)
                    .is_none_or(|deps| deps.iter().all(|dep| done.contains(dep)))
            })
            .min_by_key(|id| (projects[**id].config.priority, &projects[**id].config.id))
            .copied()
            .ok_or_else(|| {
                config_error(
                    &projects[*remaining.first().unwrap()].config_path,
                    crate::messages::text("plan.dependencies.order_mods.circular_mod_dependencies"),
                )
            })?;
        remaining.remove(&next);
        done.insert(next);
        ordered.push(next);
    }
    Ok(ordered)
}
pub(super) fn resolve_patch(
    projects: &[ModProject],
    owner: usize,
    reference: &str,
) -> Result<PatchRef> {
    let (target_owner, id) = if let Some((project, id)) = reference.split_once(':') {
        (Some(project), id)
    } else {
        (None, reference)
    };
    let mut found = Vec::new();
    for (i, project) in projects.iter().enumerate() {
        if target_owner.is_some_and(|target| target != project.config.id) {
            continue;
        }
        for (j, patch) in project.patches.iter().enumerate() {
            if patch.config.id == id {
                found.push(PatchRef {
                    project: i,
                    patch: j,
                });
            }
        }
    }
    if target_owner.is_none()
        && let Some(local) = found.iter().find(|key| key.project == owner)
    {
        return Ok(*local);
    }
    match found.as_slice() {
        [key] => Ok(*key),
        [] => Err(config_error(
            &projects[owner].config_path,
            crate::messages::format(
                "plan.dependencies.resolve_patch.required_patch_reference_is_missing",
                &[("REFERENCE", reference.to_string())],
            ),
        )),
        _ => Err(config_error(
            &projects[owner].config_path,
            crate::messages::format(
                "plan.dependencies.resolve_patch.patch_dependency_reference_is_ambiguous_use_modid",
                &[("REFERENCE", reference.to_string())],
            ),
        )),
    }
}
pub(super) fn order_patches(
    projects: &[ModProject],
    selected: &BTreeSet<PatchRef>,
    dependencies: &HashMap<PatchRef, Vec<PatchRef>>,
    mod_order: &HashMap<usize, usize>,
) -> Result<Vec<PatchRef>> {
    let mut remaining = selected.clone();
    let mut ordered = Vec::new();
    let mut done = HashSet::new();
    while !remaining.is_empty() {
        let next = remaining
            .iter()
            .filter(|key| {
                dependencies
                    .get(key)
                    .is_none_or(|deps| deps.iter().all(|dep| done.contains(dep)))
            })
            .min_by_key(|key| {
                (
                    mod_order[&key.project],
                    &projects[key.project].patches[key.patch].config.id,
                )
            })
            .copied()
            .ok_or_else(|| {
                config_error(
                    &projects[remaining.first().unwrap().project].config_path,
                    crate::messages::text(
                        "plan.dependencies.order_patches.circular_patch_dependencies",
                    ),
                )
            })?;
        remaining.remove(&next);
        done.insert(next);
        ordered.push(next);
    }
    Ok(ordered)
}
