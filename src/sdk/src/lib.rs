pub mod compiler;
#[cfg(feature = "deploy")]
pub mod distribution;
pub mod localisation;
pub mod protocol;
pub mod values;
use protocol::*;
pub use protocol::{ContentKind, GeneratedFile, TestResult};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufReader, BufWriter, Stdin, Stdout},
    path::{Path, PathBuf},
};
pub use ymb_core as core;
pub use ymb_core::{Diagnostic, Result, generated, ndf, parallel, text};

pub type GeneratorFn = fn(&mut Context) -> Result<Vec<GeneratedFile>>;
pub type TestFn = fn(&mut Context) -> Result<Vec<TestResult>>;
pub struct GeneratorEntry {
    pub name: &'static str,
    pub generate: GeneratorFn,
}
pub struct TestEntry {
    pub name: &'static str,
    pub run: TestFn,
}
struct Client {
    reader: BufReader<Stdin>,
    writer: BufWriter<Stdout>,
    next_id: u64,
}
impl Client {
    fn call(&mut self, call: HostCall) -> Result<HostReply> {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(&mut self.writer, &PluginMessage::Call { id, call })?;
        match read_frame(&mut self.reader)? {
            HostMessage::Reply {
                id: reply_id,
                reply,
            } if reply_id == id => match reply {
                HostReply::Error { error } => Err(Box::new(error)),
                reply => Ok(reply),
            },
            _ => Err(protocol_error(crate::messages::text(
                "lib.call.unexpected_host_reply_or_request_id",
            ))),
        }
    }
}
pub struct Context {
    pub info: ContextInfo,
    pub variables: Value,
    client: Client,
    fixtures: HashMap<String, Vec<u8>>,
}
fn check_cache_name(value: &str) -> Result<()> {
    core::paths::identifier(value).map(|_| ())
}
fn write_created(created: HostReply, bytes: &[u8], kind: ContentKind) -> Result<Payload> {
    let HostReply::Path { token, path } = created else {
        return Err(protocol_error(crate::messages::text(
            "lib.write_created.expected_a_staging_path",
        )));
    };
    core::paths::write_atomic_volatile(&path, bytes)?;
    Ok(Payload {
        token,
        path,
        bytes: bytes.len() as u64,
        hash: core::hash(bytes),
        kind,
    })
}
fn read_payload(payload: &Payload) -> Result<Vec<u8>> {
    let bytes = core::paths::read_limited(&payload.path, payload.bytes)?;
    if bytes.len() as u64 != payload.bytes || core::hash(&bytes) != payload.hash {
        return Err(protocol_error(crate::messages::text(
            "lib.read_payload.input_payload_has_changed_or_is_incomplete",
        )));
    }
    Ok(bytes)
}
fn read_text(payload: &Payload) -> Result<String> {
    String::from_utf8(read_payload(payload)?).map_err(|_| {
        failure(
            crate::messages::text("lib.read_text.input_is_not_valid_utf_8"),
            crate::messages::text("lib.read_text.use_the_binary_reader_for_binary_assets"),
        )
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assertions_collect_named_failures_and_support_patterns() {
        assert!(assert_text_matches("A is T()", "^A is", "missing", "fix").is_ok());
        assert!(assert_text_matches("text", "[", "bad pattern", "fix").is_err());
        let error = assert_all([
            ("first", ensure(false, "first failed", "fix")),
            ("second", ensure(false, "second failed", "fix")),
        ])
        .unwrap_err();
        assert_eq!(error.related.len(), 2);
        assert_eq!(error.related[0].context["check"], "first");
    }
}

mod checks;
mod context;
mod runtime;
pub use checks::*;
pub use runtime::run;
pub mod messages;
