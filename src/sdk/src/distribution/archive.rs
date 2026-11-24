use super::*;

pub fn zip_directory(root: &Path, archive: &Path) -> Result<()> {
    if paths::overlaps(root, archive)? {
        return Err(error(crate::messages::text(
            "distribution.archive.zip_directory.the_archive_must_be_outside_its_source",
        )));
    }
    paths::assert_no_links(archive, archive)?;
    let temporary = paths::temporary_sibling(archive);
    let result = (|| {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| Diagnostic::io(&temporary, e))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for file in super::files::entries(root, &[])? {
            let relative = file
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if file.is_dir() {
                zip.add_directory(relative, options)
                    .map_err(|e| error(e.to_string()))?;
            } else {
                zip.start_file(relative, options)
                    .map_err(|e| error(e.to_string()))?;
                std::io::copy(
                    &mut fs::File::open(&file).map_err(|e| Diagnostic::io(&file, e))?,
                    &mut zip,
                )
                .map_err(|e| error(e.to_string()))?;
            }
        }
        let output = zip.finish().map_err(|e| error(e.to_string()))?;
        output
            .sync_all()
            .map_err(|e| Diagnostic::io(&temporary, e))?;
        drop(output);
        paths::rename(&temporary, archive).map_err(|e| Diagnostic::io(archive, e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    paths::write_atomic(
        &archive.with_extension("zip.sha256"),
        format!(
            "{}  {}\n",
            paths::hash_file(archive)?,
            archive.file_name().unwrap().to_string_lossy()
        ),
    )
}
pub fn extract(archive: &Path, target: &Path) -> Result<()> {
    paths::assert_no_links(target, target)?;
    if target.exists()
        && fs::read_dir(target)
            .map_err(|e| Diagnostic::io(target, e))?
            .next()
            .is_some()
    {
        return Err(error(crate::messages::text(
            "distribution.archive.extract.extract_archives_into_an_empty_staging_folder",
        )));
    }
    let file = fs::File::open(archive).map_err(|e| Diagnostic::io(archive, e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| error(e.to_string()))?;
    if zip.len() > 50_000 {
        return Err(error(crate::messages::text(
            "distribution.archive.extract.archive_contains_too_many_entries",
        )));
    }
    let mut seen = HashSet::new();
    let mut total = 0u64;
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| error(e.to_string()))?;
        let name = file.name().map_err(|e| error(e.to_string()))?;
        let raw = name.trim_end_matches('/');
        if raw == "." && file.is_dir() {
            continue;
        }
        let relative = paths::relative(raw)?;
        // Accept tar's leading ./, but never traversal, aliases, links or device paths.
        if raw.split(['\\', '/']).any(|p| p == "..")
            || !seen.insert(paths::key(&relative))
            || file.is_symlink()
            || file.unix_mode().is_some_and(|m| {
                m & 0o170000 != 0 && m & 0o170000 != 0o100000 && m & 0o170000 != 0o040000
            })
        {
            return Err(error(crate::messages::format(
                "distribution.archive.extract.unsafe_or_duplicated_archive_entry_raw",
                &[("RAW", raw.to_string())],
            )));
        }
        total = total.checked_add(file.size()).ok_or_else(|| {
            error(crate::messages::text(
                "distribution.archive.extract.archive_size_overflow",
            ))
        })?;
        if total > 2 << 30 || file.size() > 1 << 30 {
            return Err(error(crate::messages::text(
                "distribution.archive.extract.archive_exceeds_the_extraction_limit",
            )));
        }
        names.push((i, relative, file.is_dir()));
    }
    let file_paths: HashSet<_> = names
        .iter()
        .filter(|(_, _, directory)| !directory)
        .map(|(_, name, _)| paths::key(name))
        .collect();
    for (_, relative, _) in &names {
        for parent in Path::new(relative).ancestors().skip(1) {
            if file_paths.contains(&paths::key(parent.to_string_lossy())) {
                return Err(error(crate::messages::format(
                    "distribution.archive.extract.archive_file_directory_collision_relative",
                    &[("RELATIVE", relative.to_string())],
                )));
            }
        }
    }
    for (i, relative, directory) in &names {
        let path = paths::resolve(target, relative)?;
        if *directory {
            fs::create_dir_all(&path).map_err(|e| Diagnostic::io(&path, e))?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| Diagnostic::io(parent, e))?
        }
        let mut output = fs::File::create(&path).map_err(|e| Diagnostic::io(&path, e))?;
        let mut input = zip.by_index(*i).map_err(|e| error(e.to_string()))?;
        let expected = input.size();
        let written = std::io::copy(&mut input.by_ref().take(expected + 1), &mut output)
            .map_err(|e| error(e.to_string()))?;
        if written != expected {
            return Err(error(crate::messages::format(
                "distribution.archive.extract.archive_length_mismatch_relative",
                &[("RELATIVE", relative.to_string())],
            )));
        }
        output.flush().map_err(|e| Diagnostic::io(&path, e))?;
    }
    Ok(())
}

pub fn extract_builder(archive: &Path, target: &Path) -> Result<PathBuf> {
    extract(archive, target)?;
    let builder = if target.join("release-manifest.json").is_file() {
        // Published releases before the YMB folder wrapper used a flat archive.
        target.to_owned()
    } else {
        let builder = target.join("YMB");
        if !builder.is_dir() {
            return Err(error(crate::messages::text(
                "distribution.archive.extract_builder.the_builder_archive_must_contain_a_ymb",
            )));
        }
        for entry in fs::read_dir(target).map_err(|e| Diagnostic::io(target, e))? {
            let entry = entry.map_err(|e| Diagnostic::io(target, e))?;
            if entry.path() != builder {
                return Err(error(crate::messages::text(
                    "distribution.archive.extract_builder.the_builder_archive_contains_files_outside_ymb",
                )));
            }
        }
        builder
    };
    verify_package(&builder, "release-manifest.json")?;
    Ok(builder)
}
