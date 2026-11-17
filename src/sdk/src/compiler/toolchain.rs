use crate::{
    Diagnostic, Result,
    core::{metadata, paths},
};
use semver::Version;
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

pub const PORTABLE_HOST: &str = "x86_64-pc-windows-gnullvm";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toolchain {
    pub cargo: PathBuf,
    pub rustc: PathBuf,
    pub sysroot: PathBuf,
    pub version: String,
    pub host: String,
    pub engine: Option<PathBuf>,
}

pub fn required() -> Box<Diagnostic> {
    Diagnostic::new(
        "RustRequired",
        crate::messages::text(
            "compiler.toolchain.required.install_rust_to_continue_with_this_action",
        ),
        crate::messages::text("compiler.toolchain.required.run_ymb_exe_install_rust_or_repeat"),
    )
    .with("requiredVersion", metadata::RUST_VERSION)
    .with("installCommand", "YMB.exe install-rust --json")
    .with("installOption", "--install-rust")
}

pub(super) fn load_manifest(manifest: &Path) -> Result<toml::Value> {
    let bytes = paths::read_limited(manifest, 16 << 20)?;
    let invalid = |reason: String| {
        Diagnostic::new(
            "ConfigError",
            reason,
            crate::messages::text(
                "compiler.toolchain.load_manifest.correct_the_generator_cargo_toml",
            ),
        )
        .at(manifest)
    };
    let text = std::str::from_utf8(&bytes).map_err(|error| invalid(error.to_string()))?;
    toml::from_str(text).map_err(|error: toml::de::Error| invalid(error.to_string()))
}

pub(super) fn dependencies(
    manifest: &toml::Value,
) -> impl Iterator<Item = (&String, &toml::Value)> {
    std::iter::once(manifest)
        .chain(
            manifest
                .get("target")
                .and_then(toml::Value::as_table)
                .into_iter()
                .flat_map(|targets| targets.values()),
        )
        .flat_map(|platform| {
            ["dependencies", "build-dependencies", "dev-dependencies"]
                .into_iter()
                .filter_map(|section| platform.get(section).and_then(toml::Value::as_table))
                .flat_map(|table| table.iter())
        })
}

pub fn project_requirement(manifest: &Path) -> Result<Version> {
    let cargo = load_manifest(manifest)?;
    let requested = cargo
        .get("package")
        .and_then(|package| package.get("rust-version"));
    let mut version = requested.and_then(toml::Value::as_str).map(str::to_owned);
    if requested
        .and_then(|value| value.get("workspace"))
        .and_then(toml::Value::as_bool)
        == Some(true)
    {
        let explicit = cargo
            .get("package")
            .and_then(|package| package.get("workspace"))
            .and_then(toml::Value::as_str)
            .map(|path| manifest.parent().unwrap().join(path).join("Cargo.toml"));
        let candidates = explicit.into_iter().chain(
            manifest
                .parent()
                .unwrap()
                .ancestors()
                .map(|root| root.join("Cargo.toml")),
        );
        for path in candidates {
            if !path.is_file() {
                continue;
            }
            let document = if path == manifest {
                cargo.clone()
            } else {
                load_manifest(&path)?
            };
            if let Some(workspace) = document.get("workspace") {
                version = workspace
                    .get("package")
                    .and_then(|package| package.get("rust-version"))
                    .and_then(toml::Value::as_str)
                    .map(str::to_owned);
                break;
            }
        }
        if version.is_none() {
            return Err(Diagnostic::new(
                "ConfigError",
                crate::messages::text("compiler.toolchain.project_requirement.the_inherited_rust_version_is_missing_from"),
                crate::messages::text("compiler.toolchain.project_requirement.set_workspace_package_rust_version"),
            )
            .at(manifest));
        }
    }
    if let Some(version) = version {
        let normalized = if version.matches('.').count() == 1 {
            format!("{version}.0")
        } else {
            version
        };
        let requirement = Version::parse(&normalized).map_err(|error| {
            crate::Diagnostic::new(
                "ConfigError",
                error.to_string(),
                crate::messages::text(
                    "compiler.toolchain.project_requirement.correct_package_rust_version",
                ),
            )
            .at(manifest)
        })?;
        return Ok(requirement.max(Version::parse(metadata::RUST_VERSION).unwrap()));
    }
    Ok(Version::parse(metadata::RUST_VERSION).unwrap())
}

impl Toolchain {
    pub fn portable(directory: &Path, version: &str) -> Self {
        let sysroot = directory
            .join("rustup/toolchains")
            .join(format!("{version}-{PORTABLE_HOST}"));
        Self {
            cargo: sysroot.join("bin/cargo.exe"),
            rustc: sysroot.join("bin/rustc.exe"),
            sysroot,
            version: version.into(),
            host: PORTABLE_HOST.into(),
            engine: Some(directory.to_owned()),
        }
    }

    pub fn command(&self, program: &Path) -> Command {
        let mut command = Command::new(program);
        command
            .env("RUSTC", &self.rustc)
            .env("RUSTUP_AUTO_INSTALL", "0");
        if !self.sysroot.as_os_str().is_empty() {
            let tools = self
                .sysroot
                .join("lib/rustlib")
                .join(&self.host)
                .join("bin");
            // LLD accepts the long verbatim paths used by Windows compiler workspaces.
            let gnu = self.host.ends_with("windows-gnu") || self.host.ends_with("windows-gnullvm");
            if gnu || self.host.ends_with("windows-msvc") {
                let linker = tools.join("rust-lld.exe");
                let target = self.host.to_ascii_uppercase().replace('-', "_");
                command.env(format!("CARGO_TARGET_{target}_LINKER"), &linker);
                if gnu {
                    command.env(
                        format!("CARGO_TARGET_{target}_RUSTFLAGS"),
                        "-C linker-flavor=ld.lld -C link-self-contained=yes",
                    );
                }
                if program == self.rustc {
                    command.args(["-C", &format!("linker={}", linker.display())]);
                    if gnu {
                        command.args([
                            "-C",
                            "linker-flavor=ld.lld",
                            "-C",
                            "link-self-contained=yes",
                        ]);
                    }
                }
            }
            let mut search = vec![
                self.sysroot.join("bin"),
                tools.join("self-contained"),
                tools,
            ];
            if let Some(path) = env::var_os("PATH") {
                search.extend(env::split_paths(&path));
            }
            if let Ok(path) = env::join_paths(search) {
                command.env("PATH", path);
            }
            command
                .env(
                    "RUSTDOC",
                    self.sysroot
                        .join(format!("bin/rustdoc{}", env::consts::EXE_SUFFIX)),
                )
                .env("RUSTUP_TOOLCHAIN", &self.sysroot);
        }
        if let Some(engine) = &self.engine {
            command
                .env("CARGO_HOME", engine.join("cargo"))
                .env("RUSTUP_HOME", engine.join("rustup"));
        }
        command
    }

    pub fn check<F>(&mut self, capture: &mut F) -> Result<()>
    where
        F: FnMut(&mut Command) -> Result<Output>,
    {
        let mut rustc = self.command(&self.rustc);
        let version = output(capture(rustc.arg("-vV"))?)?;
        let rust_version = parse_version(&version, "rustc")?;
        self.host = line(&version, "host: ").ok_or_else(required)?.into();
        if rust_version < Version::parse(metadata::RUST_VERSION).unwrap() {
            return Err(required().with("foundVersion", rust_version.to_string()));
        }
        let mut rustc = self.command(&self.rustc);
        let sysroot = output(capture(rustc.args(["--print", "sysroot"]))?)?;
        self.sysroot = PathBuf::from(sysroot.trim());
        self.rustc = self
            .sysroot
            .join(format!("bin/rustc{}", env::consts::EXE_SUFFIX));
        let cargo = self
            .sysroot
            .join(format!("bin/cargo{}", env::consts::EXE_SUFFIX));
        if cargo.is_file() {
            self.cargo = cargo;
        }
        let cargo_version = parse_version(
            &output(capture(self.command(&self.cargo).arg("-vV"))?)?,
            "cargo",
        )?;
        if (cargo_version.major, cargo_version.minor) != (rust_version.major, rust_version.minor) {
            return Err(required()
                .with("rustVersion", rust_version.to_string())
                .with("cargoVersion", cargo_version.to_string()));
        }
        let libraries = self
            .sysroot
            .join("lib/rustlib")
            .join(&self.host)
            .join("lib");
        if !self.rustc.is_file() || !libraries.is_dir() {
            return Err(required().detail(crate::messages::text(
                "compiler.toolchain.check.the_compiler_or_host_standard_library_is",
            )));
        }
        self.version = rust_version.to_string();
        Ok(())
    }
}

fn line<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.lines().find_map(|line| line.strip_prefix(prefix))
}

fn parse_version(text: &str, program: &str) -> Result<Version> {
    text.lines()
        .next()
        .and_then(|line| line.strip_prefix(program))
        .and_then(|line| line.split_whitespace().next())
        .and_then(|version| Version::parse(version).ok())
        .ok_or_else(|| {
            required().detail(crate::messages::format(
                "compiler.toolchain.parse_version.invalid_program_version_output",
                &[("PROGRAM", program.to_string())],
            ))
        })
}

fn output(output: Output) -> Result<String> {
    if !output.status.success() {
        return Err(required().detail(String::from_utf8_lossy(&output.stderr)));
    }
    String::from_utf8(output.stdout).map_err(|error| required().detail(error.to_string()))
}

pub fn discover<F>(builder: &Path, mut capture: F) -> Result<Toolchain>
where
    F: FnMut(&mut Command) -> Result<Output>,
{
    discover_for(builder, metadata::RUST_VERSION, &mut capture)
}

pub fn discover_for<F>(builder: &Path, minimum: &str, mut capture: F) -> Result<Toolchain>
where
    F: FnMut(&mut Command) -> Result<Output>,
{
    let minimum = Version::parse(minimum).map_err(|error| required().detail(error.to_string()))?;
    let mut candidates = Vec::new();
    let engines = paths::resolve(builder, ".ymb/engine")?;
    if engines.is_dir() {
        let mut installed = Vec::new();
        for entry in fs::read_dir(&engines).map_err(|error| Diagnostic::io(&engines, error))? {
            let entry = entry.map_err(|error| Diagnostic::io(&engines, error))?;
            if let Some(version) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix("-windows-x64"))
                .and_then(|version| Version::parse(version).ok())
                && version >= minimum
            {
                paths::assert_no_links(&engines, &entry.path())?;
                installed.push((version, entry.path()));
            }
        }
        installed.sort_by(|left, right| right.0.cmp(&left.0));
        candidates.extend(
            installed
                .into_iter()
                .map(|(version, directory)| Toolchain::portable(&directory, &version.to_string())),
        );
    }
    let mut cargos = Vec::new();
    if let Some(path) = env::var_os("CARGO") {
        cargos.push(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("PATH") {
        cargos.extend(
            env::split_paths(&path)
                .map(|directory| directory.join(format!("cargo{}", env::consts::EXE_SUFFIX))),
        );
    }
    if let Some(directory) = env::var_os("CARGO_HOME") {
        cargos.push(PathBuf::from(directory).join(format!("bin/cargo{}", env::consts::EXE_SUFFIX)));
    }
    if let Some(profile) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        cargos.push(
            PathBuf::from(profile).join(format!(".cargo/bin/cargo{}", env::consts::EXE_SUFFIX)),
        );
    }
    let mut seen = std::collections::HashSet::new();
    for cargo in cargos {
        if !cargo.is_file() || !seen.insert(paths::key(cargo.to_string_lossy())) {
            continue;
        }
        let bin = cargo.parent().unwrap();
        candidates.push(Toolchain {
            rustc: env::var_os("RUSTC")
                .map(PathBuf::from)
                .unwrap_or_else(|| bin.join(format!("rustc{}", env::consts::EXE_SUFFIX))),
            sysroot: PathBuf::new(),
            cargo,
            host: String::new(),
            version: String::new(),
            engine: None,
        });
    }
    let mut error = required().with("requiredVersion", minimum.to_string());
    for mut candidate in candidates {
        match candidate.check(&mut |command| {
            if builder.is_dir() {
                command.current_dir(builder);
            }
            capture(command)
        }) {
            Ok(()) if Version::parse(&candidate.version).unwrap() >= minimum => {
                return Ok(candidate);
            }
            Ok(()) => error.details.push(crate::messages::format(
                "compiler.toolchain.discover_for.found_rust_arg0_need_minimum_or_newer",
                &[
                    ("ARG0", candidate.version.to_string()),
                    ("MINIMUM", format!("{}", minimum)),
                ],
            )),
            Err(cause) => {
                error
                    .details
                    .push(format!("{}: {}", candidate.cargo.display(), cause));
                error.details.extend(cause.details);
            }
        }
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_scanning_includes_each_section_and_target() {
        let mut source = String::new();
        for scope in [
            "",
            "target.'cfg(windows)'.",
            "target.x86_64-unknown-linux-gnu.",
        ] {
            for section in ["dependencies", "build-dependencies", "dev-dependencies"] {
                source.push_str(&format!(
                    "[{scope}{section}]\ninherited.workspace=true\nlocal.path='helper'\nregistry='1'\n"
                ));
            }
        }
        let manifest = toml::from_str(&source).unwrap();
        let entries: Vec<_> = dependencies(&manifest).collect();
        assert_eq!(entries.len(), 27);
        assert_eq!(
            entries
                .iter()
                .filter(
                    |(_, value)| value.get("workspace").and_then(toml::Value::as_bool)
                        == Some(true)
                )
                .count(),
            9
        );
        assert_eq!(
            entries
                .iter()
                .filter(
                    |(_, value)| value.get("path").and_then(toml::Value::as_str) == Some("helper")
                )
                .count(),
            9
        );
    }

    #[test]
    fn version_output_is_parsed_and_missing_rust_is_structured() {
        assert_eq!(
            parse_version("rustc 1.100.0 (commit date)\nhost: target\n", "rustc").unwrap(),
            Version::new(1, 100, 0)
        );
        for text in ["", "cargo broken", "rustc version", "rustc 1.100"] {
            assert!(parse_version(text, "rustc").is_err());
        }
        let error = required();
        assert_eq!(error.code.as_deref(), Some("E38"));
        assert!(error.context.contains_key("requiredVersion"));
        assert!(error.context.contains_key("installCommand"));
    }

    #[test]
    fn generator_requirements_include_workspace_versions_and_reject_invalid_manifests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let manifest = root.join("member/Cargo.toml");
        paths::write_atomic(
            &root.join("Cargo.toml"),
            "[workspace]\nmembers=['member']\n[workspace.package]\nrust-version='999.1'\n",
        )
        .unwrap();
        paths::write_atomic(
            &manifest,
            "[package]\nname='member'\nversion='0.1.0'\nrust-version.workspace=true\n",
        )
        .unwrap();
        assert_eq!(
            project_requirement(&manifest).unwrap(),
            Version::new(999, 1, 0)
        );
        paths::write_atomic(&manifest, "[package]\nrust-version='1.0'\n").unwrap();
        assert_eq!(
            project_requirement(&manifest).unwrap(),
            Version::parse(metadata::RUST_VERSION).unwrap()
        );
        paths::write_atomic(&manifest, [255, 0]).unwrap();
        assert_eq!(
            project_requirement(&manifest).unwrap_err().code.as_deref(),
            Some("E4")
        );
    }

    #[cfg(windows)]
    #[test]
    fn discovery_uses_the_installation_directory_for_every_probe() {
        use std::os::windows::process::ExitStatusExt;
        let temp = tempfile::tempdir().unwrap();
        let builder = temp.path();
        let engine = builder.join(".ymb/engine/999.0.0-windows-x64");
        let toolchain = Toolchain::portable(&engine, "999.0.0");
        paths::write_atomic(&toolchain.rustc, "fixture").unwrap();
        paths::write_atomic(&toolchain.cargo, "fixture").unwrap();
        fs::create_dir_all(
            toolchain
                .sysroot
                .join("lib/rustlib")
                .join(PORTABLE_HOST)
                .join("lib"),
        )
        .unwrap();
        let found = discover(builder, |command| {
            assert_eq!(command.get_current_dir(), Some(builder));
            let text = if command.get_args().any(|argument| argument == "--print") {
                toolchain.sysroot.to_string_lossy().into_owned()
            } else if command.get_program() == toolchain.cargo {
                "cargo 999.0.0 (fixture)\n".into()
            } else {
                format!("rustc 999.0.0 (fixture)\nhost: {PORTABLE_HOST}\n")
            };
            Ok(Output {
                status: std::process::ExitStatus::from_raw(0),
                stdout: text.into_bytes(),
                stderr: Vec::new(),
            })
        })
        .unwrap();
        assert_eq!(found.version, "999.0.0");
    }
}
