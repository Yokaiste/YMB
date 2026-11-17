use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use ymb_core::{Diagnostic, Result, metadata};

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OUTPUTS: usize = 10_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentKind {
    Text,
    Binary,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Payload {
    pub token: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub hash: String,
    pub kind: ContentKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GeneratedFile {
    pub target_relative_path: String,
    pub payload: Payload,
    #[serde(default)]
    pub generated_block_owners: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnerInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub root_path: PathBuf,
    pub config_path: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BuilderInfo {
    pub root_path: PathBuf,
    pub config_path: PathBuf,
    pub version: String,
    pub game_root: PathBuf,
    pub game_data_root: PathBuf,
    pub common_data_root: PathBuf,
    pub mods_root: PathBuf,
    pub work_root: PathBuf,
    pub output_root: PathBuf,
    pub cache_root: PathBuf,
    pub conflicts_root: PathBuf,
    pub recovery_root: PathBuf,
    pub operation_lock_root: PathBuf,
    pub state_transaction_root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContextInfo {
    pub builder: BuilderInfo,
    pub selection: Value,
    pub r#mod: OwnerInfo,
    pub patch: Option<OwnerInfo>,
    pub storage: StorageInfo,
    pub generator_id: String,
    pub variables: Value,
    pub cache_enabled: bool,
    #[serde(default)]
    pub cache_max_bytes: u64,
    pub cache_salt: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageInfo {
    pub persistent_root: PathBuf,
    pub session_root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub suggestion: Option<String>,
    #[serde(default)]
    pub details: Vec<String>,
}
impl TestResult {
    pub fn passed(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: "passed".into(),
            reason: None,
            suggestion: None,
            details: Vec::new(),
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnedScope {
    Owner,
    Mod,
    Persistent,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostMessage {
    Hello {
        protocol: u32,
        ymb: String,
        execution: String,
    },
    Run {
        entry: String,
        phase: String,
        test_id: Option<String>,
        context: Box<ContextInfo>,
    },
    Reply {
        id: u64,
        reply: HostReply,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PluginMessage {
    Ready {
        protocol: u32,
        requires: String,
    },
    Call {
        id: u64,
        call: HostCall,
    },
    Complete {
        outputs: Vec<GeneratedFile>,
        tests: Vec<TestResult>,
    },
    Failed {
        error: Diagnostic,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostCall {
    ReadBaseTargets {
        paths: Vec<String>,
        kind: ContentKind,
    },
    Notice {
        reason: String,
    },
    Warning {
        reason: String,
    },
    ReadTargets {
        paths: Vec<String>,
        kind: ContentKind,
    },
    ReadOwned {
        path: String,
        scope: OwnedScope,
    },
    ResolveOwned {
        path: String,
        scope: OwnedScope,
    },
    CreateOutput {
        target: String,
        kind: ContentKind,
    },
    CreateOwned {
        path: String,
        scope: OwnedScope,
    },
    CommitOwned {
        payload: Payload,
    },
    CacheRead {
        namespace: String,
        key: String,
    },
    CacheCreate {
        namespace: String,
        key: String,
    },
    CacheCommit {
        payload: Payload,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostReply {
    Payloads { files: Vec<(String, Payload)> },
    OptionalPayload { payload: Option<Payload> },
    Path { token: String, path: PathBuf },
    Changed { changed: bool },
    Error { error: Diagnostic },
}

pub fn write_frame<T: Serialize>(writer: &mut impl Write, message: &T) -> Result<()> {
    let encoded = serde_json::to_vec(message).map_err(|e| protocol_error(e.to_string()))?;
    if encoded.len() > MAX_FRAME_BYTES {
        return Err(protocol_error(crate::messages::text(
            "protocol.write_frame.protocol_frame_exceeds_its_limit",
        )));
    }
    writer
        .write_all(&(encoded.len() as u32).to_le_bytes())
        .and_then(|()| writer.write_all(&encoded))
        .and_then(|()| writer.flush())
        .map_err(|e| protocol_error(e.to_string()))
}
pub fn read_frame<T: DeserializeOwned>(reader: &mut impl Read) -> Result<T> {
    let mut header = [0; 4];
    reader
        .read_exact(&mut header)
        .map_err(|e| protocol_error(e.to_string()))?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(protocol_error(crate::messages::text(
            "protocol.read_frame.invalid_protocol_frame_length",
        )));
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|e| protocol_error(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| protocol_error(e.to_string()))
}
pub fn check_protocol(version: u32) -> Result<()> {
    if version != metadata::PLUGIN_VERSION {
        return Err(protocol_error(crate::messages::format(
            "protocol.check_protocol.plugin_protocol_version_is_unsupported_expected_arg1",
            &[
                ("VERSION", format!("{}", version)),
                ("ARG1", format!("{}", metadata::PLUGIN_VERSION)),
            ],
        )));
    }
    Ok(())
}
pub fn protocol_error(reason: impl Into<String>) -> Box<Diagnostic> {
    Diagnostic::new(
        "GeneratorError",
        reason,
        crate::messages::text(
            "protocol.protocol_error.use_a_compatible_generator_executable_and_keep",
        ),
    )
    .code("E25")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_rejects_truncation_oversized_and_wrong_versions() {
        let message = PluginMessage::Ready {
            protocol: metadata::PLUGIN_VERSION,
            requires: "^2".into(),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).unwrap();
        let read: PluginMessage = read_frame(&mut bytes.as_slice()).unwrap();
        assert!(matches!(read, PluginMessage::Ready { .. }));
        assert!(read_frame::<PluginMessage>(&mut &bytes[..bytes.len() - 1]).is_err());
        assert!(read_frame::<PluginMessage>(&mut &(u32::MAX.to_le_bytes())[..]).is_err());
        assert!(check_protocol(metadata::PLUGIN_VERSION + 1).is_err());
    }
}
