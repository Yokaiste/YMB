use super::*;
#[test]
fn work_folders_are_cleaned_after_success_and_failure() {
    let temp = tempfile::tempdir().unwrap();
    for fail in [false, true] {
        let result = with_work(temp.path(), "work", |work| {
            paths::write_atomic(&work.join("large/nested/file"), "disposable")?;
            if fail {
                Err(error("deliberate failure"))
            } else {
                Ok(7)
            }
        });
        assert_eq!(result.is_err(), fail);
        assert!(!temp.path().join("work").exists());
    }
    assert!(with_work(temp.path(), "../outside", |_| Ok(())).is_err());
    assert!(with_work(temp.path(), ".", |_| Ok(())).is_err());
}
#[test]
fn zip_round_trip_integrity_and_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("input");
    fs::create_dir(&root).unwrap();
    paths::write_atomic(&root.join("雪/data.txt"), b"fixture").unwrap();
    fs::create_dir_all(root.join(".hidden/empty/nested")).unwrap();
    manifest(&root, "manifest.json", "1").unwrap();
    let archive = temp.path().join("test.zip");
    zip_directory(&root, &archive).unwrap();
    let archive_bytes = fs::read(&archive).unwrap();
    assert!(zip_directory(&root.join("missing"), &archive).is_err());
    assert_eq!(fs::read(&archive).unwrap(), archive_bytes);
    verify_archive(&archive, &paths::hash_file(&archive).unwrap()).unwrap();
    assert!(verify_archive(&archive, &"0".repeat(64)).is_err());
    let target = temp.path().join("output");
    extract(&archive, &target).unwrap();
    assert!(target.join(".hidden/empty/nested").is_dir());
    verify_manifest(&target, "manifest.json").unwrap();
    paths::write_atomic(&target.join("雪/data.txt"), "changed").unwrap();
    assert!(verify_manifest(&target, "manifest.json").is_err());
    let bad = temp.path().join("bad.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&bad).unwrap());
    for name in ["File.txt", "file.TXT"] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"x").unwrap();
    }
    zip.finish().unwrap();
    assert!(extract(&bad, &temp.path().join("bad")).is_err());
    // Mutate equal-length names to exercise a traversal archive independently of writer validation.
    let mut zip = zip::ZipWriter::new(fs::File::create(&bad).unwrap());
    zip.start_file("safe.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"x").unwrap();
    zip.finish().unwrap();
    let bytes = fs::read(&bad).unwrap();
    let mut bytes = bytes.clone();
    for i in 0..bytes.len() - 7 {
        if &bytes[i..i + 8] == b"safe.txt" {
            bytes[i..i + 8].copy_from_slice(b"../x.txt")
        }
    }
    fs::write(&bad, bytes).unwrap();
    assert!(extract(&bad, &temp.path().join("escape")).is_err());
    assert!(!temp.path().join("x.txt").exists());
}

#[test]
fn unlisted_package_files_and_archive_hierarchy_collisions_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("src");
    paths::write_atomic(&source.join("data.txt"), "valid").unwrap();
    manifest(&source, "manifest.json", "1").unwrap();
    verify_package(&source, "manifest.json").unwrap();
    paths::write_atomic(&source.join("unlisted.exe"), "unexpected").unwrap();
    assert!(verify_package(&source, "manifest.json").is_err());
    assert!(zip_directory(&source, &source.join("self.zip")).is_err());
    assert!(!source.join("self.zip").exists());
    let bad = temp.path().join("collision.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&bad).unwrap());
    for name in ["Directory", "directory/child"] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"data").unwrap();
    }
    zip.finish().unwrap();
    let target = temp.path().join("target");
    assert!(extract(&bad, &target).is_err());
    assert!(!target.exists());
    paths::write_atomic(&target.join("keep"), "authored").unwrap();
    assert!(extract(&bad, &target).is_err());
    assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "authored");
}

#[test]
fn builder_archives_accept_wrapped_and_legacy_layouts_and_verify_all_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("src");
    let builder = source.join("YMB");
    paths::write_atomic(&builder.join("YMB.exe"), "executable").unwrap();
    paths::write_atomic(&builder.join("mods/README.md"), "projects").unwrap();
    manifest(&builder, "release-manifest.json", "1").unwrap();
    let archive = temp.path().join("builder.zip");
    zip_directory(&source, &archive).unwrap();
    let target = temp.path().join("wrapped");
    assert_eq!(
        extract_builder(&archive, &target).unwrap(),
        target.join("YMB")
    );
    assert!(!target.join("YMB/YMB").exists());
    assert!(target.join("YMB/mods/README.md").is_file());
    zip_directory(&builder, &archive).unwrap();
    let target = temp.path().join("legacy");
    assert_eq!(extract_builder(&archive, &target).unwrap(), target);
    paths::write_atomic(&source.join("unlisted.exe"), "outside").unwrap();
    zip_directory(&source, &archive).unwrap();
    assert!(extract_builder(&archive, &temp.path().join("outside")).is_err());
    paths::write_atomic(&builder.join("YMB.exe"), "corrupt").unwrap();
    zip_directory(&builder, &archive).unwrap();
    assert!(extract_builder(&archive, &temp.path().join("corrupt")).is_err());
}
#[test]
fn settings_migrate_once_without_changing_mod_variables() {
    let source = "version: 1 # keep comment\r\nsettings:\r\n  scriptTimeoutSeconds: 90\r\n  scriptCacheMaxBytesPerNamespace: 512\r\nmods:\r\n  example:\r\n    variables:\r\n      scriptTimeoutSeconds: 7\r\n";
    let result = migrate_config(source, u64::from(crate::core::metadata::CONFIG_VERSION));
    assert!(result.starts_with(&format!(
        "version: {} # keep comment\r\n",
        crate::core::metadata::CONFIG_VERSION
    )));
    assert!(result.contains("  generatorTimeoutSeconds: 90\r\n"));
    assert!(result.contains("      scriptTimeoutSeconds: 7\r\n"));
    assert_eq!(
        migrate_config(&result, u64::from(crate::core::metadata::CONFIG_VERSION)),
        result
    );
}

#[test]
fn filtered_tree_copies_reject_overlapping_roots_before_writing() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("src");
    paths::write_atomic(&source.join("file.txt"), "authored").unwrap();
    let nested = source.join("nested");
    assert!(copy_tree(&source, &nested, &["ignored"]).is_err());
    assert!(!nested.exists());
    assert!(copy_tree(&source, temp.path(), &["ignored"]).is_err());
    assert!(!temp.path().join("file.txt").exists());
    assert!(copy_tree(&source, &source, &["ignored"]).is_err());
    assert_eq!(fs::read(source.join("file.txt")).unwrap(), b"authored");
    let stage = source.join("dist/stage");
    copy_tree(&source, &stage, &["dist"]).unwrap();
    assert_eq!(fs::read(stage.join("file.txt")).unwrap(), b"authored");
    assert!(!stage.join("dist").exists());
    let empty = temp.path().join("empty");
    copy_tree(&source, &empty, &["file.txt", "dist"]).unwrap();
    assert!(empty.is_dir());
    assert!(fs::read_dir(empty).unwrap().next().is_none());
}
