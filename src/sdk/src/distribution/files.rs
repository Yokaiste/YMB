use super::*;
pub use paths::copy_tree_filtered as copy_tree;
pub(super) use paths::entries;
pub use paths::remove_tree as remove;

pub fn execute(command: &mut Command) -> Result<Vec<u8>> {
    let output = command.output().map_err(|e| error(e.to_string()))?;
    if !output.status.success() {
        return Err(error(crate::messages::format(
            "distribution.files.execute.command_failed_arg0",
            &[("ARG0", format!("{}", output.status))],
        ))
        .detail(String::from_utf8_lossy(&output.stderr))
        .detail(String::from_utf8_lossy(
            &output.stdout[..output.stdout.len().min(16384)],
        )));
    }
    Ok(output.stdout)
}
pub fn files(root: &Path, skip: &[&str]) -> Result<Vec<PathBuf>> {
    Ok(entries(root, skip)?
        .into_iter()
        .filter(|path| path.is_file())
        .collect())
}
pub fn with_work<T>(
    parent: &Path,
    name: &str,
    action: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    let work = paths::resolve(parent, name)?;
    remove(parent, &work)?;
    fs::create_dir_all(&work).map_err(|e| Diagnostic::io(&work, e))?;
    let result = action(&work);
    let cleanup = remove(parent, &work);
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) | (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(error.detail(crate::messages::format(
            "distribution.files.with_work.work_cleanup_also_failed_cleanup",
            &[("CLEANUP", format!("{}", cleanup))],
        ))),
    }
}
