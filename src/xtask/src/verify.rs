use super::*;

pub(super) fn verify_release(dist: &Path) -> Result<()> {
    let root = root();
    let archive = dist.join(package::archive_name());
    let checksum = archive.with_extension("zip.sha256");
    let expected = paths::read_limited(&checksum, 4096)?;
    let expected = std::str::from_utf8(&expected).map_err(|e| error(e.to_string()))?;
    ymb_sdk::distribution::verify_archive(
        &archive,
        expected.split_whitespace().next().unwrap_or_default(),
    )?;
    ymb_sdk::distribution::with_work(&root.join(".ymb"), "portable test 雪", |extracted| {
        let builder = ymb_sdk::distribution::extract_builder(&archive, extracted)?;
        if builder != extracted.join("YMB") {
            return Err(error(crate::messages::text(
                "verify.verify_release.the_release_archive_must_contain_its_ymb",
            )));
        }
        fs::create_dir_all(extracted.join("GameData")).map_err(|e| Diagnostic::io(extracted, e))?;
        fs::create_dir_all(extracted.join("CommonData"))
            .map_err(|e| Diagnostic::io(extracted, e))?;
        let structure = root.join("resources/release/structure");
        for source in paths::walk(&structure, true)? {
            let relative = source.strip_prefix(&structure).unwrap();
            if paths::hash_file(&source)? != paths::hash_file(&builder.join(relative))? {
                return Err(error(crate::messages::format(
                    "verify.verify_release.release_tree_file_was_changed_or_omitted",
                    &[("ARG0", format!("{}", relative.display()))],
                )));
            }
        }
        for path in paths::walk(&builder, true)? {
            if path.starts_with(builder.join("resources/examples")) {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_lowercase();
            if name == "package.json"
                || name.starts_with("bun.lock")
                || path.extension().is_some_and(|e| e == "ts" || e == "js")
            {
                return Err(error(crate::messages::text(
                    "verify.verify_release.release_contains_obsolete_runtime_files",
                )));
            }
        }
        for source in paths::walk(&root.join("resources"), true)? {
            if source.starts_with(&structure) {
                continue;
            }
            let relative = source.strip_prefix(&root).unwrap();
            if paths::hash_file(&source)? != paths::hash_file(&builder.join(relative))? {
                return Err(error(crate::messages::text(
                    "verify.verify_release.missing_resources",
                )));
            }
        }
        if builder.join("resources/release/structure").exists()
            || builder.join(layout::LOCAL_CONFIG).exists()
            || !builder.join(layout::CONFIG).is_file()
            || !builder.join(layout::SDK).is_dir()
            || !builder.join("mods/README.md").is_file()
            || builder.join("YMB.bat").exists()
        {
            return Err(error(crate::messages::text(
                "verify.verify_release.release_must_keep_the_executable_sdk_and",
            )));
        }
        let executable = builder.join(layout::EXECUTABLE);
        let system =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32");
        let portable = || {
            let mut command = Command::new(&executable);
            command
                .current_dir(&builder)
                .env("PATH", &system)
                .env("USERPROFILE", extracted.join("empty-profile"))
                .env("HOME", extracted.join("empty-profile"))
                .env("CARGO_HOME", extracted.join("empty-cargo"))
                .env("RUSTUP_HOME", extracted.join("empty-rustup"))
                .env_remove("CARGO")
                .env_remove("RUSTC")
                .env_remove("RUSTDOC")
                .env_remove("RUSTUP_TOOLCHAIN");
            command
        };
        let run = |args: &[&str]| -> Result<Value> {
            let output = portable()
                .args(args)
                .arg("--json")
                .output()
                .map_err(|e| error(e.to_string()))?;
            if !output.status.success() || !output.stderr.is_empty() {
                return Err(error(crate::messages::text(
                    "verify.verify_release.portable_json_command_failed_or_wrote_unexpected",
                ))
                .detail(String::from_utf8_lossy(&output.stderr))
                .detail(String::from_utf8_lossy(&output.stdout)));
            }
            serde_json::from_slice(&output.stdout).map_err(|e| error(e.to_string()))
        };
        let version = run(&["--version"])?;
        if version["ymbVersion"] != metadata::VERSION {
            return Err(error(crate::messages::text(
                "verify.verify_release.portable_version_differs_from_the_root_manifest",
            )));
        }
        let starter = run(&["init", "--id", "starter", "--name", "Portable starter"])?;
        if starter["data"]["example"] != "welcome"
            || !builder
                .join("mods/starter/.github/workflows/release.yml")
                .is_file()
            || !builder
                .join("mods/starter/.github/scripts/releases.ps1")
                .is_file()
        {
            return Err(error(crate::messages::text(
                "verify.verify_release.missing_starter_workflow",
            )));
        }
        paths::write_atomic(
            &builder.join("resources/examples/welcome/added.txt"),
            "@PROJECT_ID@",
        )?;
        run(&["init", "--id", "edited", "--name", "Edited starter"])?;
        if fs::read_to_string(builder.join("mods/edited/added.txt"))
            .map_err(|cause| error(cause.to_string()))?
            != "edited"
        {
            return Err(error(crate::messages::text(
                "verify.verify_release.template_edit_ignored",
            )));
        }
        for name in ["starter", "edited"] {
            remove(&builder, &builder.join("mods").join(name))?;
        }
        let external = portable()
            .current_dir(&root)
            .args(["doctor", "--json"])
            .output()
            .map_err(|e| error(e.to_string()))?;
        let external: Value =
            serde_json::from_slice(&external.stdout).map_err(|e| error(e.to_string()))?;
        if external["status"] != "ok"
            || external["data"]["builderRoot"]
                .as_str()
                .map(|path| paths::canonical_missing(Path::new(path)))
                .transpose()?
                != Some(paths::canonical_missing(&builder)?)
        {
            return Err(error(crate::messages::text(
                "verify.verify_release.an_external_caller_s_working_directory_must",
            )));
        }
        for (args, code) in [
            (["--version", "--json"], 0),
            (["unknown-command", "--json"], 2),
        ] {
            let result = portable()
                .args(args)
                .output()
                .map_err(|e| error(e.to_string()))?;
            if result.status.code() != Some(code)
                || serde_json::from_slice::<Value>(&result.stdout).is_err()
            {
                return Err(error(crate::messages::text(
                    "verify.verify_release.the_executable_lost_its_json_output_or",
                )));
            }
        }
        let source = "A is T(\n    Value = 1\n)\n";
        paths::write_atomic(&extracted.join("GameData/A.ndf"), source)?;
        let project = builder.join("mods/portable/config");
        paths::write_atomic(
            &project.join("ymb.mod.yaml"),
            serde_json::to_vec(
                &json!({"version":metadata::CONFIG_VERSION,"id":"portable","name":"Portable"}),
            )
            .unwrap(),
        )?;
        paths::write_atomic(&project.join("patch/main/ymb.patch.yaml"),serde_json::to_vec(&json!({"version":metadata::CONFIG_VERSION,"id":"main","name":"Main","scope":"prod","targets":[{"file":"GameData/A.ndf","operations":[{"op":"modify","selector":{"kind":"field","by":"path","value":"A.Value"},"value":2}]}]})).unwrap())?;
        for args in [
            &["validate"][..],
            &["build"][..],
            &["sync", "--yes"][..],
            &["recover", "--yes"][..],
        ] {
            let value = run(args)?;
            if value["status"] != "ok" {
                return Err(error(crate::messages::text(
                    "verify.verify_release.portable_command_failed",
                ))
                .detail(value.to_string()));
            }
        }
        if fs::read_to_string(extracted.join("GameData/A.ndf"))
            .map_err(|e| Diagnostic::io(extracted, e))?
            != source
        {
            return Err(error(crate::messages::text(
                "verify.verify_release.portable_recovery_did_not_restore_exact_bytes",
            )));
        }
        let preview = builder.join(".ymb/build/output/GameData/A.ndf");
        let output = portable()
            .args(["build", "--mod", "portable", "--json", "--verbose"])
            .output()
            .map_err(|cause| error(cause.to_string()))?;
        let report: Value =
            serde_json::from_slice(&output.stdout).map_err(|cause| error(cause.to_string()))?;
        let progress = String::from_utf8_lossy(&output.stderr);
        if !output.status.success()
            || report["status"] != "ok"
            || !progress.contains("[1/1] Read projects")
            || !progress.contains("[6/6] Save preview")
            || !progress.contains("GameData/A.ndf")
            || progress.contains('\x1b')
        {
            return Err(error(crate::messages::text(
                "verify.verify_release.verbose_json_progress",
            ))
            .detail(progress)
            .detail(report.to_string()));
        }
        let previous = fs::read(&preview).map_err(|cause| Diagnostic::io(&preview, cause))?;
        for args in [
            &["build", "--mod", "typo"][..],
            &["build", "--mod", "portable", "--mod", "typo"][..],
            &["build", "--patch", "typo"][..],
        ] {
            let output = portable()
                .args(args)
                .arg("--json")
                .output()
                .map_err(|cause| error(cause.to_string()))?;
            let report: Value =
                serde_json::from_slice(&output.stdout).map_err(|cause| error(cause.to_string()))?;
            if output.status.code() != Some(1)
                || !output.stderr.is_empty()
                || report["status"] != "error"
                || report["errors"][0]["code"] != "E1"
                || fs::read(&preview).map_err(|cause| Diagnostic::io(&preview, cause))? != previous
            {
                return Err(error(crate::messages::text(
                    "verify.verify_release.unknown_filters_must_fail_and_preserve_the",
                ))
                .detail(report.to_string()));
            }
        }
        let source_project = builder.join("mods/rust-required/config");
        paths::write_atomic(&source_project.join("ymb.mod.yaml"), serde_json::to_vec(&json!({"version":metadata::CONFIG_VERSION,"id":"rust_required","name":"Rust required","generators":[{"id":"source","project":"generator/Cargo.toml"}]})).unwrap())?;
        paths::write_atomic(
            &source_project.join("generator/Cargo.toml"),
            "[package]\nname='fixture'\nversion='0.1.0'\nedition='2024'\n[workspace]\n",
        )?;
        paths::write_atomic(
            &source_project.join("generator/src/main.rs"),
            "fn main() {}\n",
        )?;
        for args in [
            &["validate"][..],
            &["build"][..],
            &["build", "--dry-run"][..],
            &["sync", "--yes"][..],
        ] {
            let output = portable()
                .args(args)
                .args(["--mod", "rust_required", "--json", "--verbose"])
                .output()
                .map_err(|cause| error(cause.to_string()))?;
            let report: Value =
                serde_json::from_slice(&output.stdout).map_err(|cause| error(cause.to_string()))?;
            if output.status.code() != Some(1)
                || !String::from_utf8_lossy(&output.stderr).contains("[!]")
                || report["status"] != "error"
                || report["errors"][0]["code"] != "E38"
                || report["diagnosticCounts"]["error"] != 1
                || report["errors"][0]["requiredVersion"] != metadata::RUST_VERSION
                || fs::read(&preview).map_err(|cause| Diagnostic::io(&preview, cause))? != previous
            {
                return Err(error(crate::messages::text(
                    "verify.verify_release.missing_rust_must_return_e38_without_prompts",
                ))
                .detail(report.to_string()));
            }
        }
        remove(&builder, &builder.join("mods/rust-required"))?;
        paths::write_atomic(
            &builder.join(layout::LOCAL_CONFIG),
            "version: 2\nvariables: {localOnly: true}\n",
        )?;
        remove(&builder, &builder.join(".ymb"))?;
        if run(&["doctor"])?["status"] != "ok" || run(&["validate"])?["status"] != "ok" {
            return Err(error(crate::messages::text(
                "verify.verify_release.removing_ymb_must_leave_the_installed_executable",
            )));
        }
        Ok(())
    })
}
