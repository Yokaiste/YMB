use crate::{
    config::{self, Generator, ModProject, Patch, ReadValue},
    plan::{PatchRef, Plan, SkippedPatch},
    state::{self, Contributor, Manifest},
    store::{Cache, Snapshot, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    time::Instant,
};
use ymb_core::{Diagnostic, Result, generated, hash, ndf, parallel, paths, templates, text};
use ymb_sdk::protocol::{ContentKind, TestResult};

#[derive(Clone, Debug)]
pub struct Output {
    pub target: String,
    pub content: Option<Snapshot>,
    pub contributors: Vec<Contributor>,
    pub source_type: String,
    pub preserve: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub patched_files: usize,
    pub cache_hits: usize,
    pub generator_cache_hits: usize,
    pub generators: usize,
    pub tests: usize,
    pub staged_bytes: u64,
    pub timings_ms: BTreeMap<String, f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator_cpu_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator_peak_memory_bytes: Option<u64>,
}
impl Metrics {
    pub fn record(&mut self, phase: &str, started: Instant) {
        *self.timings_ms.entry(phase.into()).or_default() +=
            started.elapsed().as_secs_f64() * 1000.0;
    }
}
pub struct Materialized<'a> {
    pub plan: &'a Plan,
    pub store: Store,
    pub cache: Cache,
    pub generator_caches: HashMap<usize, std::sync::Arc<Cache>>,
    pub manifest: Manifest,
    pub originals: BTreeMap<String, Option<Snapshot>>,
    pub outputs: BTreeMap<String, Output>,
    pub project_base: BTreeMap<String, Output>,
    pub owned: BTreeMap<PathBuf, Snapshot>,
    pub owned_originals: BTreeMap<PathBuf, Option<String>>,
    replace_catalog: HashMap<usize, std::collections::BTreeSet<PathBuf>>,
    read_values_cache: HashMap<(String, String), Value>,
    pub notices: Vec<Value>,
    pub tests: Vec<TestResult>,
    pub skipped: Vec<SkippedPatch>,
    pub metrics: Metrics,
    pub compiled: HashMap<String, Snapshot>,
}
pub fn contributor(
    project: &ModProject,
    patch: Option<&Patch>,
    generator: Option<&str>,
) -> Contributor {
    Contributor {
        mod_id: project.config.id.clone(),
        mod_name: Some(project.config.name.clone()),
        patch_id: patch.map(|p| p.config.id.clone()),
        patch_name: patch.map(|p| p.config.name.clone()),
        generator_id: generator.map(str::to_owned),
        script_path: None,
    }
}
pub fn attach(
    mut error: Box<Diagnostic>,
    project: &ModProject,
    patch: Option<&Patch>,
) -> Box<Diagnostic> {
    fn annotate(
        error: &mut Diagnostic,
        project: &ModProject,
        patch: Option<&Patch>,
        generator: Option<&Value>,
    ) {
        error
            .context
            .insert("modId".into(), json!(project.config.id));
        error
            .context
            .insert("modName".into(), json!(project.config.name));
        if let Some(patch) = patch {
            error
                .context
                .insert("patchId".into(), json!(patch.config.id));
        }
        if let Some(generator) = generator {
            error
                .context
                .insert("generatorId".into(), generator.clone());
        }
        for related in &mut error.related {
            annotate(related, project, patch, generator);
        }
    }
    let generator = error.context.get("generatorId").cloned();
    annotate(&mut error, project, patch, generator.as_ref());
    error
}
pub fn missing(target: &str) -> Box<Diagnostic> {
    Diagnostic::new(
        "InputError",
        crate::messages::format(
            "engine.mod.missing.input_target_does_not_exist",
            &[("TARGET", target.to_string())],
        ),
        crate::messages::text("engine.mod.missing.correct_the_path_or_restore_the_missing"),
    )
    .at(target)
    .code("E8")
}
pub fn conflict(target: &str, reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConflictError",
        reason,
        crate::messages::text(
            "engine.mod.conflict.keep_independent_edits_disjoint_or_declare_ordering",
        ),
    )
    .at(target)
}
pub fn resolve_path_template(value: &str, variables: &Value) -> Result<String> {
    templates::resolve(&json!(value), variables)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| {
            Diagnostic::new(
                "ConfigError",
                crate::messages::text(
                    "engine.mod.resolve_path_template.a_path_template_resolved_to_a_non",
                ),
                crate::messages::text(
                    "engine.mod.resolve_path_template.use_a_string_variable_for_paths",
                ),
            )
        })
}
pub fn is_ndf(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ndf"))
}
pub fn kind(path: &str) -> ContentKind {
    if template_file(path) {
        ContentKind::Text
    } else {
        ContentKind::Binary
    }
}
fn template_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "csv" | "ini" | "json" | "md" | "ndf" | "txt" | "xml" | "yaml" | "yml"
            )
        })
}
mod files;
mod materialized;
mod pipeline;
use files::*;
pub use pipeline::materialize;
