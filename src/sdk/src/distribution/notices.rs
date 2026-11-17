use super::*;

pub fn notices(stage: &Path, metadata: &Value, packages: &HashSet<String>) -> Result<()> {
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    notices_with_compiler(stage, metadata, packages, Path::new(&rustc))
}

pub fn notices_with_compiler(
    stage: &Path,
    metadata: &Value,
    packages: &HashSet<String>,
    rustc: &Path,
) -> Result<()> {
    let mut text = crate::messages::text("distribution.notices.templates.header").to_owned();
    let compiler = execute(Command::new(rustc).args(["--print", "sysroot"]))?;
    let compiler = PathBuf::from(
        String::from_utf8(compiler)
            .map_err(|e| error(e.to_string()))?
            .trim(),
    );
    paths::copy_atomic(
        &compiler.join("share/doc/rust/COPYRIGHT-library.html"),
        &stage.join("licenses/rust-standard-library.html"),
    )?;
    let version = execute(Command::new(rustc).arg("--version"))?;
    text.push_str(&crate::messages::format(
        "distribution.notices.templates.rust",
        &[(
            "VERSION",
            String::from_utf8_lossy(&version).trim().to_owned(),
        )],
    ));
    for p in metadata["packages"].as_array().ok_or_else(|| {
        error(crate::messages::text(
            "distribution.notices.notices_with_compiler.cargo_metadata_has_no_packages",
        ))
    })? {
        if p["source"].is_null() || !packages.contains(p["id"].as_str().unwrap_or("")) {
            continue;
        }
        text.push_str(&crate::messages::format(
            "distribution.notices.templates.package",
            &[
                ("NAME", p["name"].as_str().unwrap().to_owned()),
                ("VERSION", p["version"].as_str().unwrap().to_owned()),
                (
                    "LICENSE",
                    p["license"]
                        .as_str()
                        .unwrap_or(crate::messages::text(
                            "distribution.notices.notices_with_compiler.see_license_text",
                        ))
                        .to_owned(),
                ),
                (
                    "SOURCE",
                    p["repository"]
                        .as_str()
                        .unwrap_or("https://crates.io")
                        .to_owned(),
                ),
            ],
        ));
        let dir = Path::new(p["manifest_path"].as_str().unwrap())
            .parent()
            .unwrap();
        let mut licenses = Vec::new();
        if let Some(file) = p["license_file"].as_str() {
            licenses.push(dir.join(file))
        }
        for item in fs::read_dir(dir).map_err(|e| Diagnostic::io(dir, e))? {
            let path = item.map_err(|e| Diagnostic::io(dir, e))?.path();
            let name = path.file_name().unwrap().to_string_lossy().to_uppercase();
            if path.is_file()
                && (name.starts_with("LICENSE")
                    || name.starts_with("COPYING")
                    || name.starts_with("NOTICE")
                    || name == "COPYRIGHT")
            {
                licenses.push(path)
            } else if path.is_dir() && matches!(name.as_str(), "LICENSES" | ".LICENSES") {
                licenses.extend(files(&path, &[])?)
            }
        }
        licenses.sort();
        licenses.dedup();
        if licenses.is_empty() {
            if p["name"] == "qrcodegen" {
                let path = dir.join("src/lib.rs");
                let source = fs::read_to_string(&path).map_err(|e| Diagnostic::io(&path, e))?;
                let header = source
                    .split_once("*/")
                    .ok_or_else(|| error(crate::messages::text("distribution.notices.notices_with_compiler.qrcodegen_license_header_is_missing")))?
                    .0;
                if !header.contains("Permission is hereby granted") {
                    return Err(error(crate::messages::text(
                        "distribution.notices.notices_with_compiler.qrcodegen_license_text_changed",
                    )));
                }
                text.push_str(&crate::messages::format(
                    "distribution.notices.templates.source_license",
                    &[("HEADER", header.to_owned())],
                ));
                continue;
            }
            return Err(error(crate::messages::format(
                "distribution.notices.notices_with_compiler.arg0_has_no_bundled_license_text",
                &[("ARG0", format!("{}", p["name"]))],
            )));
        }
        for file in licenses {
            let contents = fs::read_to_string(&file).map_err(|e| Diagnostic::io(&file, e))?;
            text.push_str(&crate::messages::format(
                "distribution.notices.templates.file",
                &[
                    (
                        "PATH",
                        file.strip_prefix(dir)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    ("TEXT", contents.trim().to_owned()),
                ],
            ));
        }
    }
    paths::write_atomic(&stage.join("THIRD_PARTY_NOTICES.md"), text)
}
