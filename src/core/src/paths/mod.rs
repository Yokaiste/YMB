use crate::{Diagnostic, Result};
mod tree;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
pub use tree::{copy_tree, copy_tree_filtered, entries, walk};

pub fn display(path: impl AsRef<Path>) -> String {
    let original = path.as_ref().to_string_lossy();
    let normalized = original.replace('\\', "/");
    let plain = if let Some(path) = normalized.strip_prefix("//?/UNC/") {
        format!("//{path}")
    } else if let Some(path) = normalized.strip_prefix("//?/").filter(|path| {
        path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && path.as_bytes().get(1..3) == Some(b":/")
    }) {
        path.to_owned()
    } else {
        return if normalized.starts_with("//?/") {
            original.into_owned()
        } else {
            normalized
        };
    };
    let drive = !plain.starts_with("//");
    if plain.encode_utf16().count() < 260
        && plain
            .split('/')
            .skip(usize::from(drive))
            .all(|part| !unsafe_segment(part))
    {
        plain
    } else {
        original.into_owned()
    }
}

pub fn relative(value: &str) -> Result<String> {
    let value = value.replace('\\', "/");
    if value.starts_with('/') || value.as_bytes().get(1) == Some(&b':') {
        return Err(path_error(
            &value,
            crate::messages::text("paths.mod.relative.use_a_relative_path_without_a_drive"),
        ));
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => (),
            ".." => {
                if parts.pop().is_none() {
                    return Err(path_error(
                        &value,
                        crate::messages::text(
                            "paths.mod.relative.this_path_escapes_its_owning_folder",
                        ),
                    ));
                }
            }
            _ => {
                if unsafe_segment(part) {
                    return Err(path_error(
                        &value,
                        crate::messages::text(
                            "paths.mod.relative.this_path_contains_a_name_windows_cannot",
                        ),
                    ));
                }
                parts.push(part);
            }
        }
    }
    if parts.is_empty() {
        return Err(path_error(
            &value,
            crate::messages::text("paths.mod.relative.choose_a_file_or_subfolder_not_the"),
        ));
    }
    Ok(parts.join("/"))
}

pub fn game_relative(value: &str) -> Result<String> {
    let normalized = relative(value)?;
    if !(normalized.starts_with("GameData/") || normalized.starts_with("CommonData/")) {
        return Err(path_error(
            value,
            crate::messages::text(
                "paths.mod.game_relative.targets_must_be_files_below_gamedata_or",
            ),
        ));
    }
    Ok(normalized)
}

pub fn identifier(value: &str) -> Result<String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || unsafe_segment(value)
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(Diagnostic::new(
            "ConfigError",
            crate::messages::format(
                "paths.mod.identifier.invalid_id_value",
                &[("VALUE", value.to_string())],
            ),
            crate::messages::text(
                "paths.mod.identifier.use_letters_digits_dots_underscores_or_hyphens",
            ),
        ));
    }
    Ok(value.into())
}

pub fn unsafe_segment(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    segment
        .chars()
        .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        || segment.ends_with(['.', ' '])
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || segment.eq_ignore_ascii_case("CONIN$")
        || segment.eq_ignore_ascii_case("CONOUT$")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
}

pub fn key(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace('\\', "/")
        .trim_end_matches('/')
        .chars()
        .map(|ch| {
            // Windows folds individual characters, without expanding names such as ß to SS.
            let mut upper = ch.to_uppercase();
            let first = upper.next().unwrap();
            if upper.next().is_none() { first } else { ch }
        })
        .collect()
}
pub fn strip_prefix<'a>(root: &Path, path: &'a Path) -> Option<&'a Path> {
    let mut remaining = path.components();
    for part in root.components() {
        if key(part.as_os_str().to_string_lossy())
            != key(remaining.next()?.as_os_str().to_string_lossy())
        {
            return None;
        }
    }
    Some(remaining.as_path())
}
pub fn absolute(path: &Path) -> Result<PathBuf> {
    std::path::absolute(path).map_err(|e| Diagnostic::io(path, e))
}

pub fn canonical_missing(path: &Path) -> Result<PathBuf> {
    let path = absolute(path)?;
    let mut existing = path.as_path();
    let mut suffix = Vec::new();
    let mut resolved = loop {
        let mut attempts = 0;
        let resolved = loop {
            // Windows can expose a deleted directory's internal name during cleanup.
            let result = fs::canonicalize(existing).and_then(|resolved| {
                if fs::canonicalize(existing)? == resolved {
                    Ok(resolved)
                } else {
                    Err(std::io::ErrorKind::WouldBlock.into())
                }
            });
            match result {
                Err(error)
                    if error.kind() == std::io::ErrorKind::PermissionDenied && attempts < 8 =>
                {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                result => break result,
            }
        };
        match resolved {
            Ok(resolved) => break resolved,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Err(Diagnostic::new(
                    "CommandError",
                    crate::messages::text(
                        "paths.mod.canonical_missing.a_folder_moved_while_its_path_was",
                    ),
                    crate::messages::text(
                        "paths.mod.canonical_missing.retry_after_other_commands_finish_using_this",
                    ),
                )
                .at(existing)
                .code("E13"));
            }
            Err(error) => return Err(Diagnostic::io(existing, error)),
        }
        suffix.push(
            existing
                .file_name()
                .ok_or_else(|| {
                    path_error(
                        &path.display().to_string(),
                        crate::messages::text(
                            "paths.mod.canonical_missing.no_accessible_parent_folder",
                        ),
                    )
                })?
                .to_owned(),
        );
        existing = existing.parent().ok_or_else(|| {
            path_error(
                &path.display().to_string(),
                crate::messages::text("paths.mod.canonical_missing.no_accessible_parent_folder"),
            )
        })?;
    };
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

pub fn overlaps(a: &Path, b: &Path) -> Result<bool> {
    let a = key(canonical_missing(a)?.to_string_lossy());
    let b = key(canonical_missing(b)?.to_string_lossy());
    Ok(a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/")))
}

pub fn resolve(root: &Path, input: &str) -> Result<PathBuf> {
    let relative = relative(input)?;
    let candidate = root.join(relative);
    assert_no_links(root, &candidate)?;
    Ok(candidate)
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

pub fn assert_no_links(root: &Path, target: &Path) -> Result<()> {
    let relative = target.strip_prefix(root).map_err(|_| {
        path_error(
            &target.display().to_string(),
            crate::messages::text("paths.mod.assert_no_links.path_escapes_its_owning_folder"),
        )
    })?;
    let mut cursor = root.to_owned();
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            if !matches!(part, Component::Normal(_)) {
                return Err(path_error(
                    &target.display().to_string(),
                    crate::messages::text("paths.mod.assert_no_links.unsafe_path_component"),
                ));
            }
            cursor.push(part.as_os_str());
        }
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if is_link(&metadata) => {
                return Err(path_error(
                    &cursor.display().to_string(),
                    crate::messages::text(
                        "paths.mod.assert_no_links.symlinks_and_junctions_are_not_allowed_here",
                    ),
                ));
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(Diagnostic::io(&cursor, error)),
        }
    }
    Ok(())
}

pub fn temporary_sibling(path: &Path) -> PathBuf {
    path.with_file_name(format!(".ymb-{}.tmp", uuid::Uuid::new_v4()))
}

pub fn rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    retry_windows(|| fs::rename(source, destination))
}

fn retry_windows<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut attempts = 0;
    loop {
        match operation() {
            // Windows scanners may briefly hold files without delete sharing.
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && attempts < 20 =>
            {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            result => return result,
        }
    }
}

pub fn write_atomic(path: &Path, bytes: impl AsRef<[u8]>) -> Result<()> {
    atomic_write(path, true, |file| file.write_all(bytes.as_ref()))
}

/// Atomically replace disposable data without requiring it to survive a power loss.
pub fn write_atomic_volatile(path: &Path, bytes: impl AsRef<[u8]>) -> Result<()> {
    atomic_write(path, false, |file| file.write_all(bytes.as_ref()))
}

pub fn remove_tree(root: &Path, target: &Path) -> Result<()> {
    assert_no_links(root, target)?;
    let root = canonical_missing(root)?;
    let target = canonical_missing(target)?;
    if target == root || strip_prefix(&root, &target).is_none() {
        return Err(path_error(
            &target.to_string_lossy(),
            crate::messages::text("paths.mod.remove_tree.refusing_to_remove_the_owning_folder_or"),
        ));
    }
    if target
        .try_exists()
        .map_err(|e| Diagnostic::io(&target, e))?
    {
        entries(&target, &[])?;
        retry_windows(|| fs::remove_dir_all(&target)).map_err(|e| Diagnostic::io(&target, e))?;
    }
    Ok(())
}

pub fn copy_atomic(source: &Path, destination: &Path) -> Result<()> {
    let mut input = fs::File::open(source).map_err(|e| Diagnostic::io(source, e))?;
    atomic_write(destination, true, |output| {
        std::io::copy(&mut input, output).map(|_| ())
    })
}

pub fn copy_atomic_volatile(source: &Path, destination: &Path) -> Result<()> {
    let mut input = fs::File::open(source).map_err(|e| Diagnostic::io(source, e))?;
    atomic_write(destination, false, |output| {
        std::io::copy(&mut input, output).map(|_| ())
    })
}

fn atomic_write(
    path: &Path,
    durable: bool,
    write: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| Diagnostic::io(parent, e))?;
    }
    let temporary = temporary_sibling(path);
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| Diagnostic::io(&temporary, e))?;
        write(&mut file).map_err(|e| Diagnostic::io(&temporary, e))?;
        if durable {
            file.sync_all().map_err(|e| Diagnostic::io(&temporary, e))?;
        }
        drop(file);
        rename(&temporary, path).map_err(|e| Diagnostic::io(path, e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn hash_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|e| Diagnostic::io(path, e))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| Diagnostic::io(path, e))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn path_error(path: &str, reason: &str) -> Box<Diagnostic> {
    Diagnostic::new(
        "LayoutError",
        reason,
        crate::messages::text("paths.mod.path_error.keep_a_regular_file_or_folder_inside"),
    )
    .at(path)
}

pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let input = fs::File::open(path).map_err(|e| Diagnostic::io(path, e))?;
    let metadata = input.metadata().map_err(|e| Diagnostic::io(path, e))?;
    let too_large = || {
        Diagnostic::new(
            "InputError",
            crate::messages::format(
                "paths.mod.read_limited.file_exceeds_the_limit_byte_input_limit",
                &[("LIMIT", format!("{}", limit))],
            ),
            crate::messages::text("paths.mod.read_limited.reduce_the_input_size_or_restore_the"),
        )
        .at(path)
        .code("E9")
    };
    if !metadata.is_file() {
        return Err(Diagnostic::new(
            "InputError",
            crate::messages::text("paths.mod.read_limited.input_is_not_a_regular_file"),
            crate::messages::text("paths.mod.read_limited.choose_a_file"),
        )
        .at(path));
    }
    if metadata.len() > limit {
        return Err(too_large());
    }
    let capacity = usize::try_from(metadata.len().saturating_add(1)).map_err(|_| too_large())?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(capacity).map_err(|error| {
        Diagnostic::new(
            "InputError",
            error.to_string(),
            crate::messages::text(
                "paths.mod.read_limited.reduce_concurrent_work_or_the_input_file",
            ),
        )
        .at(path)
    })?;
    input
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| Diagnostic::io(path, e))?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_writes_and_copies_preserve_the_destination_on_failure() {
        let root = std::env::temp_dir().join(format!("ymb-atomic-{}", uuid::Uuid::new_v4()));
        let source = root.join("source.bin");
        let target = root.join("target.bin");
        write_atomic(&source, [0, 255, 42]).unwrap();
        write_atomic(&target, "keep").unwrap();
        for durable in [true, false] {
            assert!(
                atomic_write(&target, durable, |file| {
                    file.write_all(b"partial")?;
                    Err(std::io::Error::other("deliberate write failure"))
                })
                .is_err()
            );
            assert_eq!(fs::read(&target).unwrap(), b"keep");
        }
        assert!(copy_atomic(&root.join("missing"), &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        copy_atomic(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), [0, 255, 42]);
        write_atomic_volatile(&target, "volatile").unwrap();
        copy_atomic_volatile(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), [0, 255, 42]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_file_reads_avoid_geometric_buffer_growth() {
        let path = std::env::temp_dir().join(format!("ymb-read-{}.bin", uuid::Uuid::new_v4()));
        let bytes = vec![42; 5 * 1024 * 1024];
        write_atomic(&path, &bytes).unwrap();
        let read = read_limited(&path, bytes.len() as u64).unwrap();
        assert_eq!(read, bytes);
        assert!(read.capacity() < bytes.len() * 11 / 10);
        assert!(read_limited(&path, bytes.len() as u64 - 1).is_err());
        std::fs::remove_file(&path).unwrap();
    }
    #[test]
    fn windows_paths_have_valid_neighbors() {
        assert_eq!(key(r"c:\Mod\A.txt/"), key("C:/mod/a.TXT"));
        assert_ne!(key("İ.txt"), key("i\u{307}.txt"));
        assert_ne!(key("ß.txt"), key("ss.txt"));
        assert_eq!(
            strip_prefix(
                Path::new("C:/Mod/replace"),
                Path::new("c:/mod/REPLACE/CommonData/A.ndf")
            ),
            Some(Path::new("CommonData/A.ndf"))
        );
        assert!(
            strip_prefix(
                Path::new("C:/Mod/replace"),
                Path::new("c:/mod/replaced/A.ndf")
            )
            .is_none()
        );
        for name in [
            "GameData/COM¹.ndf",
            "GameData/LPT².bin",
            "GameData/com³.txt",
        ] {
            assert!(game_relative(name).is_err());
        }
        assert!(game_relative("GameData/COM⁴.ndf").is_ok());
        for bad in [
            "",
            ".",
            "../outside",
            "C:drive",
            "//server/share",
            "a/NUL.txt",
            "a/x.",
            "a/a:b",
            "GameData",
        ] {
            assert!(game_relative(bad).is_err(), "{bad}");
        }
        for good in [
            "GameData/Units.ndf",
            "CommonData/a/../b.bin",
            "GameData/..prefix/a",
        ] {
            assert!(game_relative(good).is_ok(), "{good}");
        }
        assert_eq!(relative("a/../b\\c").unwrap(), "b/c");
        for bad in ["CON", "nul.txt", "LPT1", "..", "bad id"] {
            assert!(identifier(bad).is_err());
        }
        for good in ["mod_1", "patch.health", "..prefix"] {
            assert!(identifier(good).is_ok());
        }
    }

    #[test]
    fn displayed_paths_omit_only_unneeded_windows_prefixes() {
        assert_eq!(display(r"\\?\C:\Mods\雪\file.ndf"), "C:/Mods/雪/file.ndf");
        assert_eq!(display("//?/C:/Mods/file.ndf"), "C:/Mods/file.ndf");
        assert_eq!(
            display(r"\\?\UNC\server\share\file.ndf"),
            "//server/share/file.ndf"
        );
        for path in [
            format!(r"\\?\C:\{}\file.ndf", "雪".repeat(250)),
            r"\\?\C:\folder.\file.ndf".into(),
            r"\\?\C:\NUL.txt".into(),
            r"\\?\Volume{volume}\file.ndf".into(),
        ] {
            assert_eq!(display(&path), path);
        }
    }

    #[test]
    fn console_devices_are_not_file_paths() {
        for name in ["CONIN$", "conout$"] {
            assert!(relative(&format!("GameData/{name}")).is_err());
        }
        for name in ["CONIN$.txt", "CONOUT$.bin", "console.txt"] {
            assert!(relative(&format!("GameData/{name}")).is_ok());
        }
    }

    #[test]
    fn missing_paths_resolve_while_another_thread_removes_their_parent() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let root = std::env::temp_dir().join(format!("ymb-path-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let transient = root.join("transient");
        let missing = transient.join("child");
        let expected = fs::canonicalize(&root).unwrap().join("transient/child");
        let stop = AtomicBool::new(false);
        let results = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !stop.load(Ordering::Relaxed) {
                    let _ = fs::create_dir(&transient);
                    let _ = fs::remove_dir(&transient);
                }
            });
            let results: Vec<_> = (0..1000).map(|_| canonical_missing(&missing)).collect();
            stop.store(true, Ordering::Relaxed);
            results
        });
        let _ = fs::remove_dir(&transient);
        fs::remove_dir(&root).unwrap();
        for result in results {
            match result {
                Ok(path) => assert_eq!(path, expected),
                Err(error) => assert_eq!(error.code.as_deref(), Some("E13"), "{error}"),
            }
        }
    }
}
