#![cfg(windows)]
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path, process::Command};
use ymb_core::{metadata, paths};

fn release(root: &Path, rust: bool, filter: &str) -> (Value, bool) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ymb"));
    command
        .args(["release", "--mod", filter, "--json"])
        .arg("--ymb-path")
        .arg(root);
    if !rust {
        command
            .env(
                "PATH",
                Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32"),
            )
            .env("USERPROFILE", root.join("empty-profile"))
            .env("HOME", root.join("empty-profile"))
            .env("CARGO_HOME", root.join("empty-cargo"))
            .env("RUSTUP_HOME", root.join("empty-rustup"))
            .env_remove("CARGO")
            .env_remove("RUSTC")
            .env_remove("RUSTDOC")
            .env_remove("RUSTUP_TOOLCHAIN");
    }
    let output = command.output().unwrap();
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value = serde_json::from_slice(&output.stdout).expect("one JSON document");
    (value, output.status.success())
}

#[test]
fn yaml_only_releases_need_neither_rust_nor_a_warno_installation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("YMB");
    paths::write_atomic(
        &root.join("mods/Yaml/config/ymb.mod.yaml"),
        "version: 2\nid: yaml\nname: YAML-only project\n",
    )
    .unwrap();
    paths::write_atomic(&root.join("mods/Yaml/README.md"), "development notes").unwrap();
    paths::write_atomic(&root.join("mods/Yaml/LICENSE"), "mod license").unwrap();
    paths::write_atomic(
        &root.join("mods/Yaml/config/.ymb/identities.json"),
        "persistent data",
    )
    .unwrap();
    let (report, success) = release(&root, false, "yaml");
    assert!(success, "{report}");
    assert!(root.join("mods/Yaml/config/dist/Yaml-config.zip").is_file());
    assert!(report["data"]["releases"][0]["deploy"].is_null());
    let archive = root.join("mods/Yaml/config/dist/Yaml-config.zip");
    let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
    assert!(zip.by_name("Yaml/config/.ymb/identities.json").is_ok());
    assert!(zip.by_name("Yaml/README.md").is_err());
    assert!(zip.by_name("Yaml/LICENSE").is_err());
    assert!(
        zip.file_names()
            .all(|name| !name.unwrap().contains("/dist/"))
    );
    drop(zip);
    paths::write_atomic(
        &root.join("mods/Yaml/config/ymb.mod.yaml"),
        "version: 2\nid: yaml\nname: YAML-only project\nrelease:\n  include: [LICENSE, legal]\n",
    )
    .unwrap();
    paths::write_atomic(&root.join("mods/Yaml/legal/NOTICE"), "extra legal file").unwrap();
    let (report, success) = release(&root, false, "yaml");
    assert!(success, "{report}");
    let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
    assert!(zip.by_name("Yaml/LICENSE").is_ok());
    assert!(zip.by_name("Yaml/legal/NOTICE").is_ok());
    assert!(zip.by_name("Yaml/README.md").is_err());
}

#[test]
fn a_missing_deploy_runtime_identifies_the_incomplete_builder_and_preserves_the_release() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("YMB");
    paths::write_atomic(
        &root.join("mods/Example/config/ymb.mod.yaml"),
        "version: 2\nid: example\nname: Example\nrelease:\n  url: https://downloads.example.com/Example-config.zip\n",
    )
    .unwrap();
    let archive = root.join("mods/Example/config/dist/Example-config.zip");
    paths::write_atomic(&archive, "previous release").unwrap();
    let (report, success) = release(&root, true, "example");
    assert!(!success, "{report}");
    assert_eq!(report["errors"][0]["code"], "E31", "{report}");
    assert_eq!(
        report["errors"][0]["path"],
        paths::display(paths::canonical_missing(&root).unwrap()),
        "{report}"
    );
    assert_eq!(fs::read_to_string(archive).unwrap(), "previous release");
    assert!(!root.join(".ymb/releases/builder").exists());
}

#[test]
fn release_reuses_generators_without_rust_skips_deploy_and_preserves_previous_outputs_on_failure() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("YMB");
    for name in ["GameData", "CommonData"] {
        fs::create_dir_all(temp.path().join(name)).unwrap();
    }
    paths::write_atomic(&root.join("ymb.config.yaml"), "version: 2\n").unwrap();
    paths::write_atomic(&root.join("sdk/Cargo.toml"), "[workspace]\nmembers = []\n").unwrap();
    paths::write_atomic(
        &root.join("sdk/src/core/src/lib.rs"),
        "// fixture SDK input\n",
    )
    .unwrap();
    paths::write_atomic(
        &root.join("sdk/src/sdk/src/lib.rs"),
        "// fixture SDK input\n",
    )
    .unwrap();
    for name in ["core", "sdk"] {
        paths::write_atomic(
            &root.join(format!("sdk/src/{name}/Cargo.toml")),
            "[package]\nname='fixture'\nversion='1.0.0'\n",
        )
        .unwrap();
    }
    ymb_sdk::distribution::manifest(&root, "release-manifest.json", metadata::VERSION).unwrap();
    let config = root.join("mods/Example/config/ymb.mod.yaml");
    let mut settings = json!({"version":2,"id":"example","name":"Example","generators":[{"id":"example","project":"program/Cargo.toml","binary":"release-fixture"}]});
    paths::write_atomic(&config, serde_json::to_vec(&settings).unwrap()).unwrap();
    let manifest = config.parent().unwrap().join("program/Cargo.toml");
    paths::write_atomic(&manifest, format!("[package]\nname = \"release-fixture\"\nversion = \"1.0.0\"\nedition = \"2024\"\nrust-version = \"{}\"\n[workspace]\n", metadata::RUST_VERSION)).unwrap();
    let source = manifest.parent().unwrap().join("src/main.rs");
    paths::write_atomic(&source, "fn main() { println!(\"fixture\"); }\n").unwrap();
    paths::write_atomic(
        &manifest.parent().unwrap().join("target/old.bin"),
        "compiler scratch",
    )
    .unwrap();
    let (first, success) = release(&root, true, "example");
    assert!(success, "{first}");
    let dist = root.join("mods/Example/config/dist");
    let archive = dist.join("Example-config.zip");
    assert!(archive.is_file());
    let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
    assert!(
        zip.file_names()
            .all(|name| !name.unwrap().contains("/target/"))
    );
    let mut lockfile = String::new();
    zip.by_name("Example/config/program/Cargo.lock")
        .unwrap()
        .read_to_string(&mut lockfile)
        .unwrap();
    assert_eq!(
        lockfile,
        fs::read_to_string(manifest.parent().unwrap().join("Cargo.lock")).unwrap()
    );
    drop(zip);
    let relocated = temp.path().join("Moved YMB 雪");
    paths::copy_tree(&root.join("sdk"), &relocated.join("sdk")).unwrap();
    ymb_sdk::distribution::extract(&archive, &relocated.join("mods")).unwrap();
    let (moved, success) = release(&relocated, false, "example");
    assert!(success, "{moved}");
    assert!(!relocated.join("mods/Example/config/program/bin").exists());
    paths::write_atomic(&dist.join("stale.exe"), "old output").unwrap();
    settings["release"] = json!({"url":"https://downloads.example.com/Example-config.zip"});
    paths::write_atomic(&config, serde_json::to_vec(&settings).unwrap()).unwrap();
    let (cached, success) = release(&root, false, "example");
    assert!(success, "{cached}");
    assert!(cached["data"]["releases"][0]["deploy"].is_null());
    assert!(cached["data"]["releases"][0]["deploySkippedReason"].is_string());
    assert!(!dist.join("Deploy-Example.exe").exists());
    assert!(!dist.join("stale.exe").exists());
    let checksum = paths::hash_file(&archive).unwrap();
    paths::write_atomic(&root.join(".ymb/build/keep"), "preview").unwrap();
    let (unknown, success) = release(&root, false, "typo");
    assert!(
        !success && unknown["errors"][0]["code"] == "E1",
        "{unknown}"
    );
    paths::write_atomic(&source, "fn main() { println!(\"changed\"); }\n").unwrap();
    let (changed, success) = release(&root, false, "example");
    assert!(
        !success && changed["errors"][0]["code"] == "E38",
        "{changed}"
    );
    assert_eq!(paths::hash_file(&archive).unwrap(), checksum);
    assert_eq!(
        fs::read_to_string(root.join(".ymb/build/keep")).unwrap(),
        "preview"
    );
}
