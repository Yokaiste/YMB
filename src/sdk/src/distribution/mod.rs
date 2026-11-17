pub use crate::core::{layout, paths};
pub use crate::{Diagnostic, Result};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};
pub fn error(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "DeploymentError",
        reason,
        crate::messages::text(
            "distribution.mod.error.keep_your_existing_installation_and_recovery_files",
        ),
    )
}

mod archive;
pub mod builder;
mod config;
mod files;
mod manifest;
mod notices;
mod output;
pub use archive::*;
pub use config::migrate_config;
pub use files::*;
pub use manifest::*;
pub use notices::{notices, notices_with_compiler};
pub use output::with_dist;
#[cfg(test)]
mod tests;
