use super::*;

pub(super) fn scan(root: &Path) -> Result<()> {
    let started = Instant::now();
    let mut files = 0;
    let mut bytes = 0;
    let mut errors = Vec::new();
    for name in ["GameData", "CommonData"] {
        let directory = root.join(name);
        if !directory.is_dir() {
            return Err(
                error(crate::messages::text("inspect.scan.missing_data_folder")).at(&directory),
            );
        }
        for path in paths::walk(&directory, true)? {
            if !path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("ndf"))
            {
                continue;
            }
            let source = fs::read_to_string(&path).map_err(|e| Diagnostic::io(&path, e))?;
            files += 1;
            bytes += source.len();
            if let Err(error) = ndf::validate(&source)
                && errors.len() < 30
            {
                errors.push(*error.at(&path));
            }
        }
    }
    println!("{}",serde_json::to_string_pretty(&json!({"files":files,"bytes":bytes,"seconds":started.elapsed().as_secs_f64(),"errors":errors})).unwrap());
    if errors.is_empty() {
        Ok(())
    } else {
        Err(error(crate::messages::text(
            "inspect.scan.real_folder_ndf_scan_failed",
        )))
    }
}

pub(super) fn bench(path: &Path) -> Result<()> {
    let source = fs::read_to_string(path).map_err(|e| Diagnostic::io(path, e))?;
    let mut validation = Vec::new();
    let mut indexing = Vec::new();
    let mut blocks = 0;
    for _ in 0..7 {
        let started = Instant::now();
        ndf::validate(std::hint::black_box(&source))?;
        validation.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = Instant::now();
        blocks = ndf::scan(std::hint::black_box(&source))?.len();
        indexing.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    validation.sort_by(f64::total_cmp);
    indexing.sort_by(f64::total_cmp);
    println!("{}",serde_json::to_string_pretty(&json!({"bytes":source.len(),"blocks":blocks,"validationMedianMs":validation[3],"indexingMedianMs":indexing[3],"validationRunsMs":validation,"indexingRunsMs":indexing})).unwrap());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_require_both_data_directories_and_report_invalid_ndf() {
        let root = tempfile::tempdir().unwrap();
        assert!(scan(root.path()).is_err());
        fs::create_dir(root.path().join("GameData")).unwrap();
        assert!(scan(root.path()).is_err());
        fs::create_dir(root.path().join("CommonData")).unwrap();
        paths::write_atomic(&root.path().join("GameData/input.ndf"), "A is T(Value = 1)").unwrap();
        scan(root.path()).unwrap();
        paths::write_atomic(&root.path().join("GameData/input.ndf"), "A is T(Value = )").unwrap();
        assert!(scan(root.path()).is_err());
    }
}
