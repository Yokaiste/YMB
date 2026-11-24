use crate::{Result, hash, paths};
use std::path::{Path, PathBuf};

pub fn persistent(config_root: &Path) -> Result<PathBuf> {
    paths::resolve(config_root, ".ymb")
}

pub fn session(builder: &Path, mod_id: &str) -> Result<PathBuf> {
    paths::identifier(mod_id)?;
    paths::resolve(builder, &format!(".ymb/mods/{mod_id}"))
}

pub fn generator(config_root: &Path, manifest: &Path, binary: Option<&str>) -> Result<PathBuf> {
    let relative = manifest.strip_prefix(config_root).map_err(|_| {
        crate::Diagnostic::new(
            "ConfigError",
            crate::messages::text(
                "storage.generator.generator_source_lies_outside_the_mod_configuration",
            ),
            crate::messages::text(
                "storage.generator.keep_generator_sources_inside_the_folder_containing",
            ),
        )
    })?;
    let binary = binary.unwrap_or("generator");
    paths::identifier(binary)?;
    let key = hash(relative.to_string_lossy().replace('\\', "/"));
    paths::resolve(
        &persistent(config_root)?,
        &format!("g/{}/{binary}{}", &key[..16], std::env::consts::EXE_SUFFIX),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_is_scoped_and_generator_paths_survive_moving_an_installation() {
        let root = std::env::current_dir()
            .unwrap()
            .join(".ymb/storage-fixture");
        let first = root.join("first/config");
        let second = root.join("second/config");
        let relative = Path::new("generator/Cargo.toml");
        assert_eq!(
            generator(&first, &first.join(relative), Some("example"))
                .unwrap()
                .strip_prefix(&first)
                .unwrap(),
            generator(&second, &second.join(relative), Some("example"))
                .unwrap()
                .strip_prefix(&second)
                .unwrap()
        );
        assert!(session(&root, "../escape").is_err());
        assert!(generator(&first, &second.join(relative), None).is_err());
    }
}
