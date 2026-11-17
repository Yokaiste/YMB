use crate::config::Context;
use serde_json::{Value, json};
use std::fs;
use ymb_core::{Diagnostic, Result, hash, metadata, paths, resources};

pub fn choose(context: &Context, requested: Option<&str>, interactive: bool) -> Result<String> {
    let root = resources::directory(&context.root)?.join("examples");
    paths::assert_no_links(&root, &root)?;
    let mut examples = Vec::new();
    if root.is_dir() {
        for entry in fs::read_dir(&root).map_err(|error| Diagnostic::io(&root, error))? {
            let entry = entry.map_err(|error| Diagnostic::io(&root, error))?;
            paths::assert_no_links(&root, &entry.path())?;
            if entry.path().is_dir() {
                let name = entry.file_name().into_string().map_err(|_| {
                    crate::config::config_error(
                        &root,
                        crate::messages::text("init.choose.example_names_must_be_valid_unicode"),
                    )
                })?;
                paths::identifier(&name)?;
                examples.push(name);
            }
        }
    }
    examples.sort();
    if examples.is_empty() {
        return Err(Diagnostic::new(
            "ConfigError",
            crate::messages::text("init.choose.no_starter_examples_are_installed"),
            crate::messages::text("init.choose.restore_ymb_s_resources_examples_folder_or"),
        )
        .at(root));
    }
    if let Some(requested) = requested {
        return examples
            .iter()
            .find(|name| name.eq_ignore_ascii_case(requested))
            .cloned()
            .ok_or_else(|| {
                crate::arguments::suggest(
                    Diagnostic::new(
                        "CommandError",
                        crate::messages::format(
                            "init.choose.no_starter_example_matches_requested",
                            &[("REQUESTED", requested.to_string())],
                        ),
                        crate::messages::text("init.choose.choose_a_listed_example_with_example"),
                    ),
                    requested,
                    &examples,
                )
            });
    }
    if examples.len() == 1 {
        return Ok(examples.remove(0));
    }
    if !interactive {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("init.choose.choose_a_starter_example"),
            crate::messages::format(
                "init.choose.use_example_with_one_of_arg0",
                &[("ARG0", examples.join(", ").to_string())],
            ),
        )
        .with("examples", examples));
    }
    let keys: Vec<_> = (1..=examples.len())
        .map(|index| index.to_string())
        .collect();
    let choices: Vec<_> = keys
        .iter()
        .zip(&examples)
        .map(|(key, name)| (key.as_str(), name.as_str(), ""))
        .collect();
    let ui = crate::ui::Ui::stderr();
    eprint!(
        "{}{}",
        ui.rule(crate::messages::text("init.choose.starter_examples")),
        ui.rows(&choices, crate::ui::Tone::Muted)
    );
    let selected = crate::ui::command(
        &prompt(crate::messages::text("init.choose.choose_an_example"))?,
        &choices,
    )?;
    selected.map(str::to_owned).ok_or_else(|| {
        Diagnostic::new(
            "CommandError",
            crate::messages::text("init.choose.no_starter_example_was_selected"),
            crate::messages::text("init.choose.run_init_again_and_choose_an_example"),
        )
    })
}

pub fn create(
    context: &Context,
    id: &str,
    name: &str,
    description: &str,
    example: Option<&str>,
) -> Result<Value> {
    paths::identifier(id)?;
    if name.trim().is_empty() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("init.create.project_name_must_not_be_empty"),
            crate::messages::text("init.create.supply_name"),
        ));
    }
    let example = choose(context, example, false)?;
    let source = resources::directory(&context.root)?
        .join("examples")
        .join(&example);
    let destination = paths::resolve(&context.mods, id)?;
    if destination.exists() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("init.create.that_project_folder_already_exists"),
            crate::messages::text("init.create.choose_another_id_or_edit_the_existing"),
        )
        .at(&destination));
    }
    if let Some(project) = crate::config::discover(context)?
        .iter()
        .find(|project| project.config.id.eq_ignore_ascii_case(id))
    {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("init.create.that_project_id_is_already_in_use"),
            crate::messages::text("init.create.choose_another_id_or_edit_the_existing"),
        )
        .at(&project.config_path));
    }
    crate::ui::step(1);
    fs::create_dir_all(&context.mods).map_err(|error| Diagnostic::io(&context.mods, error))?;
    let staged = context
        .mods
        .join(format!(".ymb-init-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        // WARNO localisation keys must fit in ten characters.
        let token = hash(format!("ymb:welcome:{id}"))[..8].to_ascii_uppercase();
        let major = semver::Version::parse(metadata::VERSION).unwrap().major;
        let safe_id: String = id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
            .collect();
        let values = [
            ("FORMAT", metadata::CONFIG_VERSION.to_string()),
            ("ID", json!(id).to_string()),
            ("NAME", json!(name).to_string()),
            ("DESCRIPTION", json!(description).to_string()),
            (
                "REQUIRES",
                json!(format!(">={}, <{}", metadata::VERSION, major + 1)).to_string(),
            ),
            ("RELEASE_VERSION", json!(metadata::VERSION).to_string()),
            ("TITLE", json!(format!("{token}_T")).to_string()),
            ("DETAIL", json!(format!("{token}_I")).to_string()),
            ("SAFE_ID", safe_id),
            ("PROJECT_ID", id.to_owned()),
            ("PROJECT_NAME", name.to_owned()),
            ("PROJECT_DESCRIPTION", description.to_owned()),
            ("REPOSITORY", env!("CARGO_PKG_REPOSITORY").to_owned()),
        ];
        let project = staged.join(id);
        paths::copy_tree(&source, &project)?;
        for path in paths::walk(&project, true)? {
            // shortcut: files over 16 MiB are copied without substitution; raise this bound for larger text templates.
            if fs::metadata(&path)
                .map_err(|error| Diagnostic::io(&path, error))?
                .len()
                > 16 << 20
            {
                continue;
            }
            let bytes = paths::read_limited(&path, 16 << 20)?;
            let Ok(text) = std::str::from_utf8(&bytes) else {
                continue;
            };
            if text.contains('\0') {
                continue;
            }
            let rendered = resources::render(text, &values).map_err(|key| {
                crate::config::config_error(
                    &path,
                    crate::messages::format(
                        "init.create.unknown_starter_placeholder_key",
                        &[("KEY", key.to_string())],
                    ),
                )
            })?;
            if rendered != text {
                paths::write_atomic(&path, rendered)?;
            }
        }
        let mut check = context.clone();
        check.mods = staged.clone();
        check.config.mods.retain(|project_id, _| project_id == id);
        let projects = crate::config::discover(&check)?;
        if projects.len() != 1 || projects[0].config.id != id {
            return Err(crate::config::config_error(
                &source,
                crate::messages::text("init.create.the_example_must_contain_config_ymb_mod"),
            ));
        }
        paths::rename(&project, &destination).map_err(|error| Diagnostic::io(&destination, error))
    })();
    let cleanup = paths::remove_tree(&context.mods, &staged);
    result?;
    cleanup?;
    Ok(
        json!({"summary":crate::messages::format("init.create.created_project_id", &[("ID", id.to_string())]),"projectPath":destination,"id":id,"name":name,"example":example}),
    )
}

pub use crate::ui::{confirm, prompt};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn examples_are_discovered_and_copied_with_hidden_files_assets_and_edits() {
        let temp = tempfile::tempdir().unwrap();
        for folder in ["GameData", "CommonData"] {
            fs::create_dir(temp.path().join(folder)).unwrap();
        }
        let context = Context::resolve(Some(&temp.path().join("YMB"))).unwrap();
        let examples = context.root.join("resources/examples");
        fs::create_dir_all(&examples).unwrap();
        assert!(
            choose(&context, None, false)
                .unwrap_err()
                .reason
                .contains("No starter")
        );
        assert!(!context.mods.exists());
        let source = examples.join("one");
        paths::write_atomic(
            &source.join("config/ymb.mod.yaml"),
            "version: @FORMAT@\nid: @ID@\nname: @NAME@\n",
        )
        .unwrap();
        paths::write_atomic(
            &source.join(".github/workflows/release.yml"),
            "project: @PROJECT_ID@\n",
        )
        .unwrap();
        paths::write_atomic(&source.join("assets/雪.bin"), [0, 255, 42]).unwrap();
        fs::create_dir_all(source.join("empty/nested")).unwrap();
        assert_eq!(choose(&context, None, false).unwrap(), "one");
        create(&context, "first", "A @NAME@ title", "", None).unwrap();
        assert_eq!(
            fs::read_to_string(context.mods.join("first/.github/workflows/release.yml")).unwrap(),
            "project: first\n"
        );
        assert_eq!(
            fs::read(context.mods.join("first/assets/雪.bin")).unwrap(),
            [0, 255, 42]
        );
        assert!(context.mods.join("first/empty/nested").is_dir());
        paths::write_atomic(
            &source.join("updated.txt"),
            "An edit made after the first init.",
        )
        .unwrap();
        create(&context, "second", "Second", "", None).unwrap();
        assert!(context.mods.join("second/updated.txt").is_file());
        paths::copy_tree(&source, &examples.join("two")).unwrap();
        assert!(choose(&context, None, false).is_err());
        assert_eq!(choose(&context, Some("two"), false).unwrap(), "two");
        create(&context, "third", "Third", "", Some("two")).unwrap();
        assert!(choose(&context, Some("missing"), false).is_err());
        paths::write_atomic(&examples.join("two/broken.txt"), "@UNKNOWN@").unwrap();
        assert!(create(&context, "failed", "Failed", "", Some("two")).is_err());
        assert!(!context.mods.join("failed").exists());
        assert!(!fs::read_dir(&context.mods).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".ymb-init-")
        }));
    }
    #[test]
    fn commented_starter_templates_cover_project_and_patch_fields_and_preserve_quoted_text() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("GameData")).unwrap();
        fs::create_dir_all(temp.path().join("CommonData")).unwrap();
        let context = Context::resolve(Some(&temp.path().join("YMB"))).unwrap();
        let name = "Name with @DESCRIPTION@, quotes \" and a newline\n";
        create(&context, "example", name, "Description # @NAME@", None).unwrap();
        let path = context.mods.join("example/config/ymb.mod.yaml");
        let (config, document): (crate::config::ModConfig, _) = crate::config::load(&path).unwrap();
        assert_eq!(config.name, name);
        assert_eq!(config.description, "Description # @NAME@");
        for key in serde_json::to_value(&config)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
        {
            assert!(
                document.value.get(key).is_some(),
                "missing project key {key}"
            );
        }
        let path = context
            .mods
            .join("example/config/patch/welcome/ymb.patch.yaml");
        let (patch, document): (crate::config::PatchConfig, _) =
            crate::config::load(&path).unwrap();
        for key in serde_json::to_value(&patch)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
        {
            assert!(document.value.get(key).is_some(), "missing patch key {key}");
        }
        assert!(!patch.targets.is_empty());
        for relative in [
            ".github/workflows/release.yml",
            ".github/scripts/releases.ps1",
            ".github/scripts/test-releases.ps1",
            ".github/scripts/release-config.ps1",
            ".github/release.json",
        ] {
            assert!(context.mods.join("example").join(relative).is_file());
        }
    }
    #[test]
    fn new_projects_keep_existing_installation_overrides() {
        let temp = tempfile::tempdir().unwrap();
        for folder in ["GameData", "CommonData"] {
            fs::create_dir(temp.path().join(folder)).unwrap();
        }
        let mut context = Context::resolve(Some(&temp.path().join("YMB"))).unwrap();
        create(&context, "first", "First", "", None).unwrap();
        let custom = serde_json::from_value(json!({"variables":{"health":2}})).unwrap();
        context.config.mods.insert("first".into(), custom);
        create(&context, "second", "Second", "", None).unwrap();
        assert_eq!(crate::config::discover(&context).unwrap().len(), 2);
        assert_eq!(context.config.mods["first"].variables["health"], 2);
    }

    #[test]
    fn confirmation_accepts_y_and_yes() {
        for answer in ["Y", "y", " Y ", "yes", "YES", " Yes "] {
            assert!(crate::ui::accepted(answer));
        }
        for answer in ["", "N", "n", "no", "yep", "1", "true"] {
            assert!(!crate::ui::accepted(answer));
        }
    }
}
