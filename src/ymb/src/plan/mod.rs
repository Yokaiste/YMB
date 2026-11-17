use crate::config::{Context, ModProject, Patch, config_error};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use ymb_core::{Diagnostic, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub scope: String,
    pub mod_filters: Vec<String>,
    pub patch_filters: Vec<String>,
    pub dry_run: bool,
    pub verbose: bool,
    pub use_cache: bool,
    pub require_all: bool,
    pub reset_changed: bool,
    #[serde(skip)]
    pub yes: bool,
    #[serde(skip)]
    pub interactive: bool,
}
impl Default for Selection {
    fn default() -> Self {
        Self {
            scope: "prod".into(),
            mod_filters: Vec::new(),
            patch_filters: Vec::new(),
            dry_run: false,
            verbose: false,
            use_cache: true,
            require_all: false,
            reset_changed: false,
            yes: false,
            interactive: false,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PatchRef {
    pub project: usize,
    pub patch: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub mod_id: String,
    pub patch_id: String,
    pub included: bool,
    pub reasons: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedFilter {
    pub option: String,
    pub value: String,
    pub available_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPatch {
    pub mod_id: String,
    pub mod_name: String,
    pub patch_id: String,
    pub reason: String,
}
pub struct Plan {
    pub context: Context,
    pub selection: Selection,
    pub projects: Vec<ModProject>,
    pub mods: Vec<usize>,
    pub patches: Vec<PatchRef>,
    pub explanations: Vec<Explanation>,
    pub unmatched: Vec<UnmatchedFilter>,
    pub mod_dependencies: HashMap<usize, HashSet<usize>>,
    pub patch_dependencies: HashMap<PatchRef, Vec<PatchRef>>,
    pub(crate) generators: HashMap<String, crate::plugin::Prepared>,
    pub(crate) compiler: Option<ymb_sdk::compiler::Toolchain>,
}

impl Selection {
    pub fn progress(&self) -> bool {
        self.interactive || self.verbose
    }
}

impl Plan {
    pub fn require_matches(&self) -> Result<()> {
        if self.unmatched.is_empty() {
            return Ok(());
        }
        Err(Diagnostic::new(
            "CommandError",
            crate::messages::format(
                "plan.mod.require_matches.selection_filters_matched_no_projects_or_patches",
                &[(
                    "FILTERS",
                    self.unmatched
                        .iter()
                        .map(|filter| format!("{} '{}'", filter.option, filter.value))
                        .collect::<Vec<_>>()
                        .join(", "),
                )],
            ),
            crate::messages::text("plan.mod.require_matches.correct_the_filters_use_list_to_see"),
        )
        .with("unmatchedFilters", &self.unmatched))
    }

    pub fn override_warnings(&self) -> Vec<serde_json::Value> {
        self.projects.iter().flat_map(|project| {
            self.context.config.mods.get(&project.config.id).into_iter().flat_map(move |custom| {
                custom.patches.keys().filter(|id| !project.patches.iter().any(|patch| patch.config.id == **id)).map(|id| {
                    serde_json::json!({"code":"W3","reason":"An unknown patch override was ignored; its configuration was retained.","modId":project.config.id,"patchId":id})
                })
            })
        }).collect()
    }
}

pub fn matches(filters: &[String], id: &str, name: &str) -> bool {
    filters.is_empty()
        || filters.iter().any(|filter| {
            filter.to_lowercase() == id.to_lowercase()
                || filter.to_lowercase() == name.to_lowercase()
        })
}
impl Plan {
    pub fn new(context: Context, selection: Selection, projects: Vec<ModProject>) -> Result<Self> {
        let by_id: HashMap<_, _> = projects
            .iter()
            .enumerate()
            .map(|(i, p)| (p.config.id.clone(), i))
            .collect();
        let mut mods: BTreeSet<usize> = projects
            .iter()
            .enumerate()
            .filter(|(_, project)| {
                project.config.enabled
                    && matches(
                        &selection.mod_filters,
                        &project.config.id,
                        &project.config.name,
                    )
            })
            .map(|(i, _)| i)
            .collect();
        let mut mod_dependencies = HashMap::new();
        expand_mods(&projects, &by_id, &mut mods, &mut mod_dependencies)?;
        let mut patches: BTreeSet<PatchRef> = BTreeSet::new();
        let mut explanations = Vec::new();
        let mut explicitly_selected = HashSet::new();
        for (i, project) in projects.iter().enumerate() {
            for (j, patch) in project.patches.iter().enumerate() {
                let key = PatchRef {
                    project: i,
                    patch: j,
                };
                let mut reasons = Vec::new();
                if !project.config.enabled {
                    reasons
                        .push(crate::messages::text("plan.mod.new.mod_project_is_disabled").into());
                }
                if !mods.contains(&i) {
                    reasons.push(crate::messages::text("plan.mod.new.excluded_by_mod").into());
                }
                if !patch.config.enabled {
                    reasons.push(crate::messages::text("plan.mod.new.patch_is_disabled").into());
                }
                if selection.scope != "dev" && patch.config.scope != "prod" {
                    reasons.push(crate::messages::text("plan.mod.new.excluded_by_scope").into());
                }
                let qualified = format!("{}:{}", project.config.id, patch.config.id);
                if !matches(
                    &selection.patch_filters,
                    &patch.config.id,
                    &patch.config.name,
                ) && !selection
                    .patch_filters
                    .iter()
                    .any(|filter| filter.eq_ignore_ascii_case(&qualified))
                {
                    reasons.push(crate::messages::text("plan.mod.new.excluded_by_patch").into());
                }
                let included = reasons.is_empty();
                if included {
                    patches.insert(key);
                    explicitly_selected.insert(key);
                    reasons.push(
                        crate::messages::text("plan.mod.new.included_by_scope_and_filters").into(),
                    );
                }
                explanations.push(Explanation {
                    mod_id: project.config.id.clone(),
                    patch_id: patch.config.id.clone(),
                    included,
                    reasons,
                });
            }
        }
        let mut patch_dependencies = HashMap::new();
        let mut pending: Vec<_> = patches.iter().copied().collect();
        let mut cursor = 0;
        loop {
            while cursor < pending.len() {
                let key = pending[cursor];
                cursor += 1;
                let project = &projects[key.project];
                let patch = &project.patches[key.patch];
                let mut dependencies = Vec::new();
                for reference in &patch.config.depends_on {
                    let dependency = resolve_patch(&projects, key.project, reference)?;
                    let owner = &projects[dependency.project];
                    let target = &owner.patches[dependency.patch];
                    if !owner.config.enabled || !target.config.enabled {
                        return Err(config_error(
                            &patch.config_path,
                            crate::messages::format(
                                "plan.mod.new.required_patch_reference_is_disabled",
                                &[("REFERENCE", reference.to_string())],
                            ),
                        ));
                    }
                    if project.config.priority < owner.config.priority {
                        return Err(config_error(
                            &patch.config_path,
                            crate::messages::format(
                                "plan.mod.new.patch_dependency_reference_belongs_to_a_project",
                                &[("REFERENCE", reference.to_string())],
                            ),
                        ));
                    }
                    dependencies.push(dependency);
                    if patches.insert(dependency) {
                        pending.push(dependency);
                    }
                    mods.insert(dependency.project);
                }
                patch_dependencies.insert(key, dependencies);
            }
            let previous = mods.clone();
            expand_mods(&projects, &by_id, &mut mods, &mut mod_dependencies)?;
            for project in mods.difference(&previous).copied() {
                for (patch, value) in projects[project].patches.iter().enumerate() {
                    let qualified = format!("{}:{}", projects[project].config.id, value.config.id);
                    if value.config.enabled
                        && (selection.scope == "dev" || value.config.scope == "prod")
                        && (matches(
                            &selection.patch_filters,
                            &value.config.id,
                            &value.config.name,
                        ) || selection
                            .patch_filters
                            .iter()
                            .any(|filter| filter.eq_ignore_ascii_case(&qualified)))
                    {
                        let key = PatchRef { project, patch };
                        if patches.insert(key) {
                            pending.push(key);
                        }
                    }
                }
            }
            if cursor == pending.len() {
                break;
            }
        }
        for (key, dependencies) in &patch_dependencies {
            for dependency in dependencies {
                if key.project != dependency.project {
                    mod_dependencies
                        .entry(key.project)
                        .or_default()
                        .insert(dependency.project);
                }
            }
        }
        let mods = order_mods(&projects, &mods, &mod_dependencies)?;
        let mod_order: HashMap<_, _> = mods
            .iter()
            .enumerate()
            .map(|(rank, id)| (*id, rank))
            .collect();
        let patches = order_patches(&projects, &patches, &patch_dependencies, &mod_order)?;
        for explanation in &mut explanations {
            if let Some(key) = patches.iter().find(|key| {
                projects[key.project].config.id == explanation.mod_id
                    && projects[key.project].patches[key.patch].config.id == explanation.patch_id
            }) && !explicitly_selected.contains(key)
            {
                explanation.included = true;
                explanation.reasons = vec![
                    crate::messages::text("plan.mod.new.included_as_a_required_dependency").into(),
                ];
            }
        }
        let mut unmatched = Vec::new();
        for filter in &selection.mod_filters {
            if !projects
                .iter()
                .any(|p| matches(std::slice::from_ref(filter), &p.config.id, &p.config.name))
            {
                unmatched.push(UnmatchedFilter {
                    option: "--mod".into(),
                    value: filter.clone(),
                    available_ids: projects.iter().map(|p| p.config.id.clone()).collect(),
                });
            }
        }
        for filter in &selection.patch_filters {
            if !projects.iter().any(|p| {
                p.patches.iter().any(|patch| {
                    matches(
                        std::slice::from_ref(filter),
                        &patch.config.id,
                        &patch.config.name,
                    ) || filter
                        .eq_ignore_ascii_case(&format!("{}:{}", p.config.id, patch.config.id))
                })
            }) {
                unmatched.push(UnmatchedFilter {
                    option: "--patch".into(),
                    value: filter.clone(),
                    available_ids: projects
                        .iter()
                        .flat_map(|p| {
                            p.patches
                                .iter()
                                .map(|patch| format!("{}:{}", p.config.id, patch.config.id))
                        })
                        .collect(),
                });
            }
        }
        Ok(Self {
            context,
            selection,
            projects,
            mods,
            patches,
            explanations,
            unmatched,
            mod_dependencies,
            patch_dependencies,
            generators: HashMap::new(),
            compiler: None,
        })
    }
    pub fn patch(&self, key: PatchRef) -> &Patch {
        &self.projects[key.project].patches[key.patch]
    }
    pub fn qualified(&self, key: PatchRef) -> String {
        format!(
            "{}:{}",
            self.projects[key.project].config.id,
            self.patch(key).config.id
        )
    }
    pub fn ordered_after(&self, later: usize, earlier: usize) -> bool {
        if self.projects[later].config.priority > self.projects[earlier].config.priority {
            return true;
        }
        let mut pending = vec![later];
        let mut seen = HashSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some(deps) = self.mod_dependencies.get(&id) {
                if deps.contains(&earlier) {
                    return true;
                }
                pending.extend(deps.iter().copied());
            }
        }
        false
    }
    pub fn can_layer(&self, later: usize, earlier: usize) -> bool {
        later != earlier
            && self.projects[later].config.allow_write_to_modified_files
            && self.ordered_after(later, earlier)
    }
    pub fn drop_optional(
        &self,
        removed: &mut HashMap<PatchRef, String>,
        failures: &[Diagnostic],
    ) -> bool {
        if self.selection.require_all {
            return false;
        }
        let before = removed.len();
        for failure in failures {
            if !matches!(failure.code.as_deref(), Some("E16" | "E8")) {
                continue;
            }
            let mod_id = failure
                .context
                .get("modId")
                .and_then(serde_json::Value::as_str);
            let patch_id = failure
                .context
                .get("patchId")
                .and_then(serde_json::Value::as_str);
            for key in &self.patches {
                if self.patch(*key).config.optional
                    && Some(self.projects[key.project].config.id.as_str()) == mod_id
                    && Some(self.patch(*key).config.id.as_str()) == patch_id
                {
                    removed.insert(*key, failure.reason.clone());
                }
            }
        }
        loop {
            let mut changed = false;
            for key in &self.patches {
                if removed.contains_key(key) {
                    continue;
                }
                if let Some(dependency) = self
                    .patch_dependencies
                    .get(key)
                    .and_then(|deps| deps.iter().find(|dep| removed.contains_key(dep)))
                {
                    removed.insert(
                        *key,
                        crate::messages::format(
                            "plan.mod.skip_dependent_patches.depends_on_skipped",
                            &[("DEPENDENCY", self.qualified(*dependency))],
                        ),
                    );
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        removed.len() > before
    }
}

mod dependencies;
use dependencies::*;
