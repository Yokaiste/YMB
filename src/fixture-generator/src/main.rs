use ymb_sdk::{Context, GeneratedFile, GeneratorEntry, Result, TestEntry, TestResult};
fn generate(ctx: &mut Context) -> Result<Vec<GeneratedFile>> {
    match ctx.value::<String>("behavior")?.as_str() {
        "warning" => {
            ctx.notice("Informational fixture notice.")?;
            ctx.warning("Recoverable fixture warning.")?;
            return Ok(Vec::new());
        }
        "config" => {
            let config: serde_json::Value = ctx.value("config")?;
            let scope = if config["patch"].is_null() {
                "mod"
            } else {
                "patch"
            };
            return Ok(vec![ctx.output_text(
                &format!("CommonData/config-{scope}.json"),
                config.to_string(),
            )?]);
        }
        "base-targets" => {
            let current = ctx.read_target("GameData/A.ndf")?;
            let base = ctx.read_base_targets(&["GameData/A.ndf"])?;
            ymb_sdk::ensure(
                current.contains("X = 8") && base["GameData/A.ndf"].contains("X = 4"),
                "Base target did not preserve the previous project.",
                "Read the project input snapshot.",
            )?;
            return Ok(vec![ctx.output_text(
                "GameData/A.ndf",
                current.replace("X = 8", "X = 9"),
            )?]);
        }
        "target-alias" => {
            let source = ctx.read_target(&ctx.value::<String>("inputPath")?)?;
            let target = ctx.value::<String>("outputPath")?;
            let mut output = ctx.output_text(&target, source.replace("X = 4", "X = 8"))?;
            output.target_relative_path = target;
            return Ok(vec![output]);
        }
        "seed-localisation" => {
            let source = ctx.read_target("GameData/A.ndf")?;
            ymb_sdk::ensure(
                source.contains("X = 7"),
                "Project generator ran before declarative patches.",
                "Prepare declarative targets before all generators.",
            )?;
            return Ok(vec![
                ctx.output_text("CommonData/locale.csv", "TOKEN;REFTEXT\n")?,
            ]);
        }
        "append-localisation" => {
            let mut source = ctx.read_target("CommonData/locale.csv")?;
            ctx.write_owned_text("scope.txt", "feature-owned")?;
            source.push_str("TEST;Feature text\n");
            return Ok(vec![ctx.output_text("CommonData/locale.csv", source)?]);
        }
        "invalid-utf8" => return Ok(vec![ctx.output_binary("GameData/invalid.ndf", [255])?]),
        "forged" => {
            let mut output = ctx.output_text("GameData/forged.txt", "data")?;
            output.payload.hash = "0".repeat(64);
            return Ok(vec![output]);
        }
        "escape" => {
            ctx.write_owned_text("../../outside.txt", "no")?;
            return Ok(Vec::new());
        }
        "persistent" => {
            ymb_sdk::ensure(
                ctx.value::<std::path::PathBuf>("modPersistentRoot")? == ctx.persistent_root()
                    && ctx.value::<std::path::PathBuf>("modSessionRoot")? == ctx.session_root()
                    && ctx
                        .persistent_path("identity.txt")?
                        .starts_with(&ctx.info.r#mod.root_path)
                    && ctx.session_path("scratch.txt")?.starts_with(
                        ctx.info
                            .builder
                            .root_path
                            .join(".ymb/mods")
                            .join(&ctx.info.r#mod.id),
                    ),
                "Storage paths escaped their owning mod.",
                "Use the SDK storage helpers.",
            )?;
            ctx.write_persistent_text("identity.txt", "persistent identity")?;
            ymb_sdk::ensure(
                ctx.read_persistent_text("identity.txt")? == "persistent identity",
                "Staged persistent data is not visible.",
                "Read the transaction overlay.",
            )?;
            return Ok(Vec::new());
        }
        "memory" => {
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(128 * 1024 * 1024).map_err(|_| {
                ymb_sdk::failure(
                    "Allocation exceeded the process memory limit.",
                    "Reduce the generator's memory use.",
                )
            })?;
            bytes.resize(128 * 1024 * 1024, 5u8);
            std::hint::black_box(bytes);
        }
        "write-stream" | "stream-fail" => {
            let fail = ctx.value::<String>("behavior")? == "stream-fail";
            let output = ctx.output_stream(
                "CommonData/stream.bin",
                ymb_sdk::ContentKind::Binary,
                |writer| {
                    let chunk = [42u8; 64 * 1024];
                    for _ in 0..96 {
                        writer.write_all(&chunk)?;
                    }
                    if fail {
                        return Err(std::io::Error::other("Deliberate writer failure"));
                    }
                    Ok(())
                },
            )?;
            return Ok(vec![output]);
        }
        "stream" => {
            let input = ctx.target_file("GameData/A.ndf", ymb_sdk::ContentKind::Text)?;
            return Ok(vec![ctx.output_file(
                "CommonData/stream.ndf",
                &input.path,
                ymb_sdk::ContentKind::Text,
            )?]);
        }
        "owned-case-replace" => {
            ctx.read_mod_text("replace/CommonData/new.txt")?;
            ctx.write_mod_text("REPLACE/CommonData/NEW.TXT", "new virtual source")?;
            return Ok(Vec::new());
        }
        "config-case" => {
            ctx.write_mod_text("YMB.MOD.YAML", "must fail")?;
            return Ok(Vec::new());
        }
        "owned-replace" => {
            ctx.write_mod_text("replace/CommonData/new.txt", "new virtual source")?;
            return Ok(Vec::new());
        }
        "descendant" => {
            let mut child = std::process::Command::new("powershell.exe");
            child.args(["-NoProfile","-NonInteractive","-WindowStyle","Hidden","-Command","Start-Sleep -Seconds 2; [IO.File]::WriteAllText('descendant.txt','unexpected')"]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                child.creation_flags(0x08000000);
            }
            let _child = child
                .spawn()
                .map_err(|e| ymb_sdk::failure(e.to_string(), "Check the fixture child process."))?;
            return Err(ymb_sdk::failure(
                "Deliberate failure after spawning a child.",
                "The host must close the complete process job.",
            ));
        }
        "regions" => {
            let owner = ctx.generator_id().to_owned();
            let name = format!(
                "Generated_{}_{}",
                ctx.info.r#mod.id,
                owner.rsplit(':').next().unwrap()
            );
            let region = ymb_sdk::generated::render(
                &owner,
                &[format!("{name} is T(Value = 1)")],
                None,
                None,
            )?;
            return Ok(vec![ctx.output_generated("GameData/regions.ndf", region)?]);
        }
        "foreign-claim" => {
            let mut output = ctx.output_text("CommonData/claim.txt", "data")?;
            output.generated_block_owners = vec!["another::generator".into()];
            return Ok(vec![output]);
        }
        "fail" => {
            return Err(ymb_sdk::failure(
                "Deliberate fixture failure.",
                "Use another fixture mode.",
            ));
        }
        "timeout" => std::thread::sleep(std::time::Duration::from_secs(5)),
        "bad-ndf" => return Ok(vec![ctx.output_text("GameData/Bad.ndf", "A is T(X = )")?]),
        "protocol" => {
            println!("not a protocol frame");
            return Ok(Vec::new());
        }
        "cache" => {
            let key = ctx.cache_key(&serde_json::json!({"version":1}))?;
            let previous: Option<String> = ctx.cache_read("example", &key)?;
            ctx.cache_write("example", &key, &"stored")?;
            return Ok(vec![ctx.output_text(
                "GameData/cache.txt",
                previous.as_deref().unwrap_or("cold"),
            )?]);
        }
        _ => (),
    }
    let input = ctx.read_target("GameData/A.ndf")?;
    ctx.write_owned_text("identity.txt", "stable identity")?;
    let next = input.replace("X = 1", "X = 3");
    Ok(vec![
        ctx.output_text("GameData/A.ndf", next)?,
        ctx.output_binary("CommonData/asset.bin", [0, 255, 42])?,
    ])
}
fn before(ctx: &mut Context) -> Result<Vec<TestResult>> {
    if ctx.value::<String>("behavior")? == "warning" {
        ctx.warning("Companion test fixture warning.")?;
        return Ok(vec![TestResult::passed("before")]);
    }
    ymb_sdk::ensure(
        ctx.info.builder.game_data_root == ctx.info.builder.game_root.join("GameData")
            && ctx.info.builder.output_root == ctx.info.builder.work_root.join("output")
            && ctx
                .info
                .r#mod
                .config_path
                .starts_with(&ctx.info.builder.mods_root)
            && ctx
                .info
                .builder
                .config_path
                .starts_with(&ctx.info.builder.root_path),
        "Builder paths are incomplete or inconsistent",
        "Pass the resolved configured roots to the generator",
    )?;
    ctx.write_owned_text("test-only.txt", "must never persist")?;
    let source = ctx.read_target("GameData/A.ndf")?;
    ymb_sdk::assert_text_present(&source, "Missing fixture", "Create the fixture")?;
    Ok(vec![TestResult::passed("before")])
}
fn after(ctx: &mut Context) -> Result<Vec<TestResult>> {
    if ctx.value::<String>("behavior")? == "persistent" {
        ymb_sdk::ensure(
            ctx.read_persistent_text("identity.txt")? == "persistent identity",
            "Persistent generation overlay missing",
            "Keep persistent writes visible to after-tests",
        )?;
        ctx.write_persistent_text("identity.txt", "test must not change this")?;
        return Ok(vec![TestResult::passed("after")]);
    }
    ymb_sdk::ensure(
        ctx.read_owned_text("identity.txt")? == "stable identity",
        "Generation overlay missing",
        "Keep staged writes visible to after-tests",
    )?;
    ctx.write_owned_text("identity.txt", "test must not change this")?;
    Ok(vec![TestResult::passed("after")])
}
fn main() {
    if std::env::current_exe().unwrap().file_stem().unwrap() == "blocked-input" {
        use ymb_sdk::protocol::{PluginMessage, write_frame};
        write_frame(
            &mut std::io::stdout(),
            &PluginMessage::Ready {
                protocol: ymb_sdk::core::metadata::PLUGIN_VERSION,
                requires: format!("^{}", ymb_sdk::core::metadata::VERSION),
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(10));
        return;
    }
    ymb_sdk::run(
        &[GeneratorEntry {
            name: "generate",
            generate,
        }],
        &[
            TestEntry {
                name: "before",
                run: before,
            },
            TestEntry {
                name: "after",
                run: after,
            },
        ],
    );
}
