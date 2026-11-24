use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest_path = root.join("Cargo.toml");
    let manifest: toml::Value =
        toml::from_str(&fs::read_to_string(&manifest_path).expect("read workspace manifest"))
            .expect("parse workspace manifest");
    let metadata = &manifest["workspace"]["metadata"]["ymb"];
    let mut generated = String::new();
    for key in ["config", "json", "plugin", "cache", "journal", "state"] {
        let version = metadata[format!("{key}-version")]
            .as_integer()
            .expect("format version");
        generated.push_str(&format!(
            "pub const {}_VERSION: u32 = {version};\n",
            key.to_uppercase()
        ));
    }
    let host = env::var("CARGO_PKG_NAME").as_deref() == Ok("ymb");
    let mut inputs = fingerprint_inputs(&root, host);
    inputs.push(manifest_path);
    let lock = root.join("Cargo.lock");
    if host && lock.exists() {
        inputs.push(lock);
    }
    inputs.sort();
    let mut digest = Sha256::new();
    for input in inputs {
        println!("cargo:rerun-if-changed={}", input.display());
        digest.update(
            input
                .strip_prefix(&root)
                .unwrap_or(&input)
                .to_string_lossy()
                .replace('\\', "/"),
        );
        digest.update(fs::read(&input).expect("read build fingerprint input"));
    }
    let fingerprint: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    generated.push_str(&format!("pub const BUILD_ID: &str = \"{fingerprint}\";\n"));
    if host {
        fs::write(
            Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("build-id.rs"),
            format!("{fingerprint:?}"),
        )
        .expect("write builder fingerprint");
    }
    fs::write(
        Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("metadata.rs"),
        generated,
    )
    .expect("write derived metadata");
}

fn fingerprint_inputs(root: &Path, host: bool) -> Vec<std::path::PathBuf> {
    let mut inputs = vec![root.join("src/core/build.rs")];
    for package in ["core", "sdk"].into_iter().chain(host.then_some("ymb")) {
        let catalog = root
            .join("resources/messages/en")
            .join(format!("{package}.json"));
        if catalog.is_file() {
            inputs.push(catalog);
        }
        let package = root.join("src").join(package);
        inputs.push(package.join("Cargo.toml"));
        collect(&package.join("src"), &mut inputs);
    }
    inputs
}

fn collect(root: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(root).expect("read source directory") {
        let entry = entry.expect("read source entry");
        let path = entry.path();
        if entry.file_type().expect("source file type").is_dir() {
            if entry.file_name() != "integration" {
                collect(&path, out);
            }
        } else if matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("rs" | "toml")
        ) && entry.file_name() != "tests.rs"
        {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_fingerprints_exclude_builder_code_and_test_fixtures() {
        let temp = tempfile::tempdir().unwrap();
        for file in [
            "core/src/lib.rs",
            "core/src/tests.rs",
            "sdk/src/lib.rs",
            "ymb/src/main.rs",
            "ymb/src/integration/test.rs",
        ] {
            let path = temp.path().join("src").join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "source").unwrap();
        }
        for package in ["core", "sdk", "ymb"] {
            let path = temp
                .path()
                .join(format!("resources/messages/en/{package}.json"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "{}").unwrap();
        }
        let core = fingerprint_inputs(temp.path(), false);
        let host = fingerprint_inputs(temp.path(), true);
        assert!(core.contains(&temp.path().join("src/sdk/src/lib.rs")));
        assert!(!core.contains(&temp.path().join("src/ymb/src/main.rs")));
        assert!(host.contains(&temp.path().join("src/ymb/src/main.rs")));
        assert!(core.contains(&temp.path().join("resources/messages/en/core.json")));
        assert!(core.contains(&temp.path().join("resources/messages/en/sdk.json")));
        assert!(!core.contains(&temp.path().join("resources/messages/en/ymb.json")));
        assert!(host.contains(&temp.path().join("resources/messages/en/ymb.json")));
        assert!(
            !host
                .iter()
                .any(|path| path.ends_with("test.rs") || path.ends_with("tests.rs"))
        );
    }
}
