use super::*;

pub(super) fn yes() -> bool {
    true
}
pub(super) fn object() -> Value {
    json!({})
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PatchCustomization {
    pub enabled: Option<bool>,
    #[serde(default = "object")]
    pub variables: Value,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModCustomization {
    pub enabled: Option<bool>,
    pub allow_unsupported_ymb: Option<String>,
    pub priority: Option<i64>,
    pub allow_write_to_modified_files: Option<bool>,
    #[serde(default)]
    pub ignore_unknown_patches: bool,
    #[serde(default = "object")]
    pub variables: Value,
    #[serde(default)]
    pub patches: BTreeMap<String, PatchCustomization>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ConfigPaths {
    pub game_root: String,
    pub source_mods: String,
    pub work_root: String,
    pub cache_root: String,
    pub recovery_root: String,
    pub operation_lock_root: String,
    pub state_transaction_root: String,
}
impl Default for ConfigPaths {
    fn default() -> Self {
        Self {
            game_root: "..".into(),
            source_mods: "mods".into(),
            work_root: ".ymb/build".into(),
            cache_root: ".ymb/cache".into(),
            recovery_root: ".ymb/state".into(),
            operation_lock_root: ".ymb/lock".into(),
            state_transaction_root: ".ymb/transaction".into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_threads: Option<usize>,
    pub cache_max_entries: usize,
    pub cache_max_bytes: u64,
    pub generator_cache_max_entries_per_namespace: usize,
    pub generator_cache_max_bytes_per_namespace: u64,
    pub generator_timeout_seconds: u64,
    pub memory_budget_mib: usize,
    pub merge_max_estimated_diff_work: u64,
    pub merge_max_text_bytes_per_side: usize,
    pub merge_max_text_bytes_combined: usize,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            worker_threads: None,
            cache_max_entries: 512,
            cache_max_bytes: 1 << 30,
            generator_cache_max_entries_per_namespace: 4,
            generator_cache_max_bytes_per_namespace: 256 << 20,
            generator_timeout_seconds: 120,
            memory_budget_mib: 512,
            merge_max_estimated_diff_work: 50_000_000,
            merge_max_text_bytes_per_side: 4_000_000,
            merge_max_text_bytes_combined: 6_000_000,
        }
    }
}
impl Settings {
    pub fn parallel_limits(&self) -> ymb_core::parallel::Limits {
        let available = ymb_core::parallel::Limits::default().threads;
        ymb_core::parallel::Limits {
            threads: self
                .worker_threads
                .unwrap_or(available)
                .min(available)
                .max(1),
            memory_bytes: self.memory_budget_mib.saturating_mul(1 << 20),
        }
    }
    pub fn diff_budget(&self) -> ymb_core::text::DiffBudget {
        ymb_core::text::DiffBudget {
            max_work: self.merge_max_estimated_diff_work,
            max_side_bytes: self.merge_max_text_bytes_per_side,
            max_combined_bytes: self.merge_max_text_bytes_combined,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BuilderConfig {
    pub version: u32,
    #[serde(default)]
    pub paths: ConfigPaths,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default = "object")]
    pub variables: Value,
    #[serde(default)]
    pub mods: BTreeMap<String, ModCustomization>,
}
impl Default for BuilderConfig {
    fn default() -> Self {
        Self {
            version: metadata::CONFIG_VERSION,
            paths: ConfigPaths::default(),
            settings: Settings::default(),
            variables: object(),
            mods: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModConfig {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub release: super::Release,
    #[serde(default)]
    pub dependencies: Vec<super::Dependency>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub allow_write_to_modified_files: bool,
    #[serde(default = "object")]
    pub variables: Value,
    #[serde(default)]
    pub read_values: BTreeMap<String, ReadValue>,
    #[serde(default)]
    pub generators: Vec<Generator>,
    #[serde(default)]
    pub temp_paths: Vec<TempPath>,
    #[serde(default)]
    pub requires: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PatchConfig {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub scope: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "object")]
    pub variables: Value,
    #[serde(default)]
    pub read_values: BTreeMap<String, ReadValue>,
    #[serde(default)]
    pub files: Vec<FileOperation>,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub generators: Vec<Generator>,
    #[serde(default)]
    pub temp_paths: Vec<TempPath>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadValue {
    pub file: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub file: String,
    pub operations: Vec<Value>,
    #[serde(default)]
    pub expect: Option<ReferenceExpectation>,
    #[serde(skip)]
    pub operation_lines: Vec<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceExpectation {
    pub referenced: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileSource {
    pub root: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileExpectation {
    pub files: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileOperation {
    pub op: String,
    #[serde(default)]
    pub source: Option<FileSource>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub expect: Option<FileExpectation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum TempPath {
    Path(String),
    Config {
        path: String,
        #[serde(default, rename = "unsafeToRemove")]
        unsafe_to_remove: bool,
    },
}
impl TempPath {
    pub fn path(&self) -> &str {
        match self {
            Self::Path(path) | Self::Config { path, .. } => path,
        }
    }
    pub fn protected(&self) -> bool {
        matches!(
            self,
            Self::Config {
                unsafe_to_remove: true,
                ..
            }
        )
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeneratorRoot {
    #[default]
    Owner,
    Mod,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Generator {
    #[serde(default)]
    pub root: GeneratorRoot,
    pub id: String,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub tests: Vec<GeneratorTest>,
}
impl Generator {
    pub fn entry(&self) -> &str {
        self.entry.as_deref().unwrap_or(&self.id)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum GeneratorTest {
    Id(String),
    Config {
        id: String,
        #[serde(default = "before")]
        when: String,
    },
}
pub(super) fn before() -> String {
    "before".into()
}
impl GeneratorTest {
    pub fn id(&self) -> &str {
        match self {
            Self::Id(id) | Self::Config { id, .. } => id,
        }
    }
    pub fn when(&self) -> &str {
        match self {
            Self::Id(_) => "before",
            Self::Config { when, .. } => when,
        }
    }
}
