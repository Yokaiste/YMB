use saphyr::{LoadableYamlNode, MarkedYaml, Scalar, YamlData};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use ymb_core::{Diagnostic, Result, metadata, paths, templates};
pub fn config_error(path: &Path, reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "ConfigError",
        reason,
        crate::messages::text("config.mod.config_error.correct_the_named_project_file_see_docs"),
    )
    .at(path)
}

mod context;
mod project;
mod release;
mod schema;
mod yaml;
pub use context::Context;
pub use project::{ModProject, Patch, check_requirement, discover, variables};
pub use release::{
    AutomaticReleaseFlag, Dependency, DownloadSource, Release, ReleaseBranch, ReleaseFlag,
    download_source, validate_release,
};
pub use schema::*;
use yaml::decode;
pub use yaml::{load, write, yaml};
#[cfg(test)]
mod tests;
