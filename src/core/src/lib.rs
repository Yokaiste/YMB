pub mod diagnostic;
pub mod generated;
pub mod layout;
pub mod messages;
pub mod ndf;
pub mod parallel;
pub mod paths;
pub mod resources;
pub mod storage;
pub mod templates;
pub mod terminal;
pub mod text;

pub mod metadata {
    include!(concat!(env!("OUT_DIR"), "/metadata.rs"));
    pub const VERSION: &str = env!("CARGO_PKG_VERSION");
    pub const RUST_VERSION: &str = env!("CARGO_PKG_RUST_VERSION");
}

pub use diagnostic::{Diagnostic, Result};

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
