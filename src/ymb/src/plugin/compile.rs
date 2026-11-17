use super::*;
use ymb_sdk::compiler;

pub(crate) struct Prepared {
    executable: Option<PathBuf>,
    manifest: Option<PathBuf>,
}

fn key(root: &Path, generator: &Generator) -> String {
    hash(
        serde_json::to_vec(&(
            root,
            &generator.executable,
            &generator.project,
            &generator.binary,
        ))
        .unwrap(),
    )
}

fn inspect(
    builder: &Path,
    config_root: &Path,
    root: &Path,
    generator: &Generator,
    release: bool,
) -> Result<Prepared> {
    let executable = generator
        .executable
        .as_ref()
        .map(|path| paths::resolve(root, path))
        .transpose()?;
    let manifest = generator
        .project
        .as_ref()
        .map(|path| -> Result<PathBuf> {
            let path = paths::resolve(root, path)?;
            Ok(if path.is_dir() {
                path.join("Cargo.toml")
            } else {
                path
            })
        })
        .transpose()?;
    if let Some(manifest) = &manifest {
        paths::assert_no_links(root, manifest)?;
        if !manifest.is_file() {
            return Err(engine::missing(&manifest.to_string_lossy()));
        }
        let fingerprint =
            compiler::source_fingerprint(builder, manifest, generator.binary.as_deref())?;
        let cached =
            ymb_core::storage::generator(config_root, manifest, generator.binary.as_deref())?;
        for executable in std::iter::once(&cached).chain(executable.iter()) {
            if compiler::current_executable(executable, &fingerprint, generator.binary.as_deref())?
                && (!release || crate::release::licenses::available(executable)?)
            {
                if release {
                    crate::release::licenses::prune(executable)?;
                }
                return Ok(Prepared {
                    executable: Some(executable.clone()),
                    manifest: None,
                });
            }
        }
        return Ok(Prepared {
            executable: None,
            manifest: Some(manifest.clone()),
        });
    }
    let executable = executable.unwrap();
    if !executable.is_file() {
        return Err(Diagnostic::new(
            "GeneratorError",
            crate::messages::text("plugin.compile.inspect.the_generator_executable_is_missing"),
            crate::messages::text(
                "plugin.compile.inspect.restore_the_generator_executable_or_register_its",
            ),
        )
        .at(executable));
    }
    Ok(Prepared {
        executable: Some(executable),
        manifest: None,
    })
}

pub(crate) fn prepare(plan: &mut crate::plan::Plan) -> Result<()> {
    prepare_mode(plan, false)
}

pub(crate) fn prepare_release(plan: &mut crate::plan::Plan) -> Result<()> {
    prepare_mode(plan, true)
}

fn prepare_mode(plan: &mut crate::plan::Plan, release: bool) -> Result<()> {
    let mut generators = Vec::new();
    for project in &plan.mods {
        let owner = &plan.projects[*project];
        for (root, generator) in owner
            .config
            .generators
            .iter()
            .map(|generator| (&owner.config_root, generator))
            .chain(
                plan.patches
                    .iter()
                    .filter(|patch| patch.project == *project)
                    .flat_map(|patch| {
                        let patch = &owner.patches[patch.patch];
                        patch
                            .config
                            .generators
                            .iter()
                            .map(move |generator| (&patch.root, generator))
                    }),
            )
        {
            if generator.enabled {
                let root = match generator.root {
                    GeneratorRoot::Owner => root,
                    GeneratorRoot::Mod => &owner.config_root,
                };
                generators.push((root.clone(), owner.config_root.clone(), generator.clone()));
            }
        }
    }
    for (root, config_root, generator) in generators {
        let key = key(&root, &generator);
        if !plan.generators.contains_key(&key) {
            plan.generators.insert(
                key,
                inspect(&plan.context.root, &config_root, &root, &generator, release)?,
            );
        }
    }
    if plan
        .generators
        .values()
        .any(|generator| generator.manifest.is_some())
    {
        let mut requirement = semver::Version::parse(metadata::RUST_VERSION).unwrap();
        for manifest in plan
            .generators
            .values()
            .filter_map(|generator| generator.manifest.as_deref())
        {
            requirement = requirement.max(compiler::project_requirement(manifest)?);
        }
        let toolchain = crate::rust::discover_for(&plan.context.root, &requirement.to_string())?;
        crate::rust::verify(&plan.context.root, &toolchain)?;
        plan.compiler = Some(toolchain);
    }
    Ok(())
}

pub(super) fn resolve_executable(
    built: &mut Materialized<'_>,
    root: &Path,
    generator: &Generator,
) -> Result<Snapshot> {
    let key = key(root, generator);
    if let Some(snapshot) = built.compiled.get(&key) {
        return Ok(snapshot.clone());
    }
    let started = Instant::now();
    let executable = release_executable(built.plan, root, generator)?;
    let snapshot = capture_executable(built, key, &executable)?;
    built.metrics.record("compilation", started);
    Ok(snapshot)
}

pub(crate) fn release_executable(
    plan: &crate::plan::Plan,
    root: &Path,
    generator: &Generator,
) -> Result<PathBuf> {
    let key = key(root, generator);
    let prepared = plan.generators.get(&key).ok_or_else(|| {
        Diagnostic::new(
            "GeneratorError",
            crate::messages::text(
                "plugin.compile.release_executable.the_generator_was_not_prepared",
            ),
            crate::messages::text("plugin.compile.release_executable.retry_this_command"),
        )
    })?;
    if let Some(executable) = &prepared.executable {
        return Ok(executable.clone());
    }
    let manifest = prepared.manifest.as_ref().unwrap();
    let owner = plan
        .projects
        .iter()
        .find(|project| root.starts_with(&project.config_root))
        .ok_or_else(|| {
            Diagnostic::new(
                "GeneratorError",
                crate::messages::text("plugin.compile.release_executable.generator_has_no_owning_mod_configuration"),
                crate::messages::text("plugin.compile.release_executable.keep_generators_inside_their_mod_configuration_folder"),
            )
        })?;
    let mut command = compiler::build_command(
        &plan.context.root,
        &owner.config.id,
        manifest,
        plan.compiler.as_ref().unwrap(),
    )?;
    if let Some(binary) = &generator.binary {
        command.args(["--bin", binary]);
    }
    command.current_dir(root);
    if plan.selection.progress() {
        let display = paths::strip_prefix(&plan.context.mods, manifest).unwrap_or(manifest);
        crate::ui::phase(crate::messages::format(
            "plugin.compile.release_executable.preparing_generator_arg0",
            &[(
                "ARG0",
                if plan.selection.verbose {
                    display.display().to_string()
                } else {
                    owner.config.name.clone()
                },
            )],
        ));
    }
    let output = crate::platform::capture(
        &mut command,
        Duration::from_secs(600.max(plan.context.config.settings.generator_timeout_seconds)),
    )
    .map_err(|error| {
        if error.category == "IoError" {
            Diagnostic::new(
                "GeneratorError",
                crate::messages::text("plugin.compile.release_executable.the_generator_compiler_could_not_start"),
                crate::messages::text("plugin.compile.release_executable.check_the_compiler_installation_and_permissions"),
            )
            .at(manifest)
            .detail(error.to_string())
        } else {
            error.at(manifest)
        }
    })?;
    let mut artifacts = Vec::new();
    let mut diagnostics = String::from_utf8_lossy(&output.stderr).into_owned();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Ok(message) = serde_json::from_str::<Value>(line) {
            if message["reason"] == "compiler-artifact"
                && let Some(executable) = message["executable"].as_str()
            {
                artifacts.push(PathBuf::from(executable));
            }
            if message["reason"] == "compiler-message"
                && diagnostics.len() < 1024 * 1024
                && let Some(rendered) = message["message"]["rendered"].as_str()
            {
                diagnostics.push_str(rendered);
            }
        }
    }
    if !output.status.success() {
        return Err(Diagnostic::new(
            "GeneratorError",
            crate::messages::text("plugin.compile.release_executable.generator_compilation_failed"),
            crate::messages::text(
                "plugin.compile.release_executable.fix_compiler_errors_in_the_owning_generator",
            ),
        )
        .at(manifest)
        .detail(diagnostics));
    }
    artifacts.sort();
    artifacts.dedup();
    if artifacts.len() != 1 {
        return Err(Diagnostic::new(
            "ConfigError",
            crate::messages::text(
                "plugin.compile.release_executable.the_generator_project_did_not_produce_exactly",
            ),
            crate::messages::text(
                "plugin.compile.release_executable.set_generator_binary_to_select_one_binary",
            ),
        )
        .at(manifest));
    }
    let executable =
        ymb_core::storage::generator(&owner.config_root, manifest, generator.binary.as_deref())?;
    paths::copy_atomic(&artifacts.remove(0), &executable)?;
    compiler::stamp_executable(
        &plan.context.root,
        manifest,
        generator.binary.as_deref(),
        &executable,
    )?;
    crate::release::licenses::save(&executable, plan.compiler.as_ref().unwrap(), &output.stdout)?;
    Ok(executable)
}

pub(super) fn capture_executable(
    built: &mut Materialized<'_>,
    key: String,
    path: &Path,
) -> Result<Snapshot> {
    let snapshot = built.store.capture(path, ContentKind::Binary)?;
    let executable = built
        .store
        .root
        .join("executables")
        .join(&snapshot.hash)
        .join(path.file_name().unwrap());
    if !executable.exists() {
        paths::copy_atomic_volatile(&snapshot.path, &executable)?;
        #[cfg(unix)]
        fs::set_permissions(
            &executable,
            fs::metadata(path)
                .map_err(|e| Diagnostic::io(path, e))?
                .permissions(),
        )
        .map_err(|e| Diagnostic::io(&executable, e))?;
    }
    let snapshot = Snapshot {
        path: executable,
        ..snapshot
    };
    built.compiled.insert(key, snapshot.clone());
    Ok(snapshot)
}
