use crate::{
    commands,
    config::{self, Context},
    init,
    plan::Selection,
    state::{self, Manifest, OperationLock, Root, Transaction},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};
use tempfile::TempDir;
use ymb_core::{hash, metadata, paths};
const SOURCE: &str = "A is T(
    X = 1
    Y = 2
    Items = [1, 2]
)
B is T(
    X = 5
)
";
struct Workspace {
    _temp: TempDir,
    context: Context,
}
impl Workspace {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("YMB");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(temp.path().join("GameData")).unwrap();
        fs::create_dir(temp.path().join("CommonData")).unwrap();
        paths::write_atomic(&temp.path().join("GameData/A.ndf"), SOURCE).unwrap();
        let context = Context::resolve(Some(&root)).unwrap();
        Self {
            _temp: temp,
            context,
        }
    }
    fn write(&self, path: &str, value: impl AsRef<[u8]>) {
        paths::write_atomic(&self.context.root.join(path), value).unwrap();
    }
    fn project(&self, id: &str, extra: Value) {
        let mut config = json!({"version":metadata::CONFIG_VERSION,"id":id,"name":id});
        ymb_core::templates::merge(&mut config, &extra);
        self.write(
            &format!("mods/{id}/config/ymb.mod.yaml"),
            serde_json::to_vec(&config).unwrap(),
        );
    }
    fn patch(&self, owner: &str, id: &str, extra: Value) {
        let mut config =
            json!({"version":metadata::CONFIG_VERSION,"id":id,"name":id,"scope":"prod"});
        if extra.get("targets").is_none()
            && extra.get("files").is_none()
            && extra.get("generators").is_none()
        {
            config["targets"] = json!([{"file":"GameData/A.ndf","operations":[{"op":"remove","selector":{"kind":"object","by":"name","value":"Missing"}}]}]);
        }
        ymb_core::templates::merge(&mut config, &extra);
        self.write(
            &format!("mods/{owner}/config/patch/{id}/ymb.patch.yaml"),
            serde_json::to_vec(&config).unwrap(),
        );
    }
    fn field(&self, owner: &str, id: &str, field: &str, value: i64) {
        self.patch(owner,id,json!({"targets":[{"file":"GameData/A.ndf","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":field},"value":value}]}]}));
    }
    fn run(&self, command: &str) -> Value {
        commands::build(self.context.clone(), Selection::default(), command).unwrap()
    }
    fn game(&self) -> String {
        fs::read_to_string(self.context.game.join("GameData/A.ndf")).unwrap()
    }
    fn native(&self, behavior: &str) {
        self.project("native",json!({"variables":{"behavior":behavior},"generators":[{"id":"generate","executable":"fixture.exe","tests":[{"id":"before","when":"before"},{"id":"after","when":"after"}]}]}));
        paths::copy_atomic(
            &fixture(),
            &self.context.mods.join("native/config/fixture.exe"),
        )
        .unwrap();
    }
}
fn fixture() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let output = Command::new(env!("CARGO"))
            .args([
                "build",
                "--offline",
                "--package",
                "ymb-fixture",
                "--message-format=json",
            ])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|v| v["reason"] == "compiler-artifact")
            .find_map(|v| v["executable"].as_str().map(PathBuf::from))
            .unwrap()
    })
    .clone()
}

mod build;
mod configuration;
mod generators;
mod recovery;
