use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub url: Option<String>,
    pub include: Vec<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub assets: Option<Vec<String>>,
    pub draft: Option<bool>,
    pub generate_notes: Option<bool>,
    pub discussion_category: Option<String>,
    pub managed_tags: Option<String>,
    pub branches: Option<Vec<ReleaseBranch>>,
}

impl Default for Release {
    fn default() -> Self {
        Self {
            version: metadata::VERSION.into(),
            url: None,
            include: Vec::new(),
            title: None,
            description: None,
            assets: None,
            draft: None,
            generate_notes: None,
            discussion_category: None,
            managed_tags: None,
            branches: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseBranch {
    pub name: Option<String>,
    pub pattern: Option<String>,
    pub tag: String,
    pub prerelease: Option<ReleaseFlag>,
    pub latest: Option<ReleaseFlag>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReleaseFlag {
    Boolean(bool),
    Automatic(AutomaticReleaseFlag),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AutomaticReleaseFlag {
    #[serde(rename = "auto")]
    Auto,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Dependency {
    pub url: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DownloadSource {
    pub url: String,
    name: String,
}

impl DownloadSource {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn key(&self) -> String {
        self.url.clone()
    }
}

pub fn download_source(url: &str) -> Result<DownloadSource> {
    let invalid = || {
        Diagnostic::new(
            "ConfigError",
            crate::messages::text(
                "config.release.download_source.the_download_url_must_point_directly_to",
            ),
            crate::messages::text(
                "config.release.download_source.set_release_url_or_dependencies_url_to",
            ),
        )
    };
    if url
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '\\' | '#'))
    {
        return Err(invalid());
    }
    let address = url.strip_prefix("https://").ok_or_else(invalid)?;
    let (host, path) = address.split_once('/').ok_or_else(invalid)?;
    if host.is_empty()
        || !host
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b".-:[]".contains(&ch))
    {
        return Err(invalid());
    }
    let path = path.split('?').next().unwrap();
    let parts: Vec<_> = path.split('/').collect();
    if path.is_empty()
        || parts.iter().any(|part| matches!(*part, "." | ".."))
        || (host.eq_ignore_ascii_case("github.com")
            && (parts.len() <= 2
                || (parts.get(2) == Some(&"releases") && !parts.contains(&"download"))))
    {
        return Err(invalid());
    }
    let filename = parts.last().unwrap();
    let name = filename
        .strip_suffix(".zip")
        .map(|name| name.strip_suffix("-config").unwrap_or(name));
    Ok(DownloadSource {
        url: url.into(),
        name: if let Some(name) = name.filter(|name| paths::identifier(name).is_ok()) {
            name.into()
        } else {
            url.into()
        },
    })
}

pub fn validate_release(config: &ModConfig, path: &Path) -> Result<()> {
    semver::Version::parse(&config.release.version).map_err(|error| {
        config_error(
            path,
            crate::messages::format(
                "config.release.validate_release.invalid_release_version_error",
                &[("ERROR", format!("{}", error))],
            ),
        )
    })?;
    if let Some(url) = &config.release.url {
        download_source(url).map_err(|error| error.at(path))?;
    }
    for relative in &config.release.include {
        paths::relative(relative).map_err(|error| error.at(path))?;
    }
    validate_publication(&config.release, path)?;
    let mut seen = std::collections::HashSet::new();
    for dependency in &config.dependencies {
        let source = download_source(&dependency.url).map_err(|error| error.at(path))?;
        if !seen.insert(source.key()) {
            return Err(config_error(
                path,
                crate::messages::text(
                    "config.release.validate_release.duplicate_download_dependency",
                ),
            ));
        }
        if dependency
            .reason
            .as_ref()
            .is_some_and(|text| text.chars().any(char::is_control))
        {
            return Err(config_error(
                path,
                crate::messages::text(
                    "config.release.validate_release.dependency_reason_must_be_one_line_of",
                ),
            ));
        }
    }
    Ok(())
}

fn validate_publication(release: &Release, path: &Path) -> Result<()> {
    let single_line =
        |value: &str| !value.trim().is_empty() && !value.chars().any(char::is_control);
    if release.title.as_ref().is_some_and(|s| !single_line(s))
        || release
            .discussion_category
            .as_ref()
            .is_some_and(|s| s.chars().any(char::is_control))
    {
        return Err(config_error(
            path,
            "Release titles and discussion categories must be single lines; titles cannot be empty.",
        ));
    }
    let pattern = |value: &str| {
        value.starts_with('^') && value.ends_with('$') && !value.chars().any(char::is_control)
    };
    if release
        .managed_tags
        .as_ref()
        .is_some_and(|s| !s.is_empty() && !pattern(s))
    {
        return Err(config_error(
            path,
            "release.managedTags must be empty or an anchored pattern (^...$).",
        ));
    }
    if let Some(assets) = &release.assets
        && (assets.is_empty()
            || assets.iter().any(|s| {
                s.is_empty()
                    || s.starts_with('-')
                    || matches!(s.as_str(), "." | "..")
                    || s.chars().any(|c| c.is_control() || "/\\:".contains(c))
            }))
    {
        return Err(config_error(
            path,
            "release.assets needs filename patterns inside dist, without paths.",
        ));
    }
    if let Some(branches) = &release.branches {
        for branch in branches {
            if branch.name.is_some() == branch.pattern.is_some()
                || branch.name.as_ref().is_some_and(|s| !single_line(s))
                || branch.pattern.as_ref().is_some_and(|s| !pattern(s))
                || !single_line(&branch.tag)
            {
                return Err(config_error(
                    path,
                    "Each release branch rule needs either name or an anchored pattern, and a nonempty single-line tag.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_metadata_and_dependencies_have_no_arbitrary_size_caps() {
        let mut config: ModConfig = serde_json::from_value(json!({
            "version":metadata::CONFIG_VERSION,"id":"fixture","name":"Fixture",
            "release":{
                "title":"雪".repeat(300),"description":"x".repeat(70000),
                "discussionCategory":"x".repeat(300),"managedTags":format!("^{}$", "a".repeat(5000)),
                "assets":vec!["*".repeat(300); 65],
                "branches":(0..65).map(|i| json!({"name":format!("{}-{i}","a".repeat(5000)),"tag":"t".repeat(5000)})).collect::<Vec<_>>()
            },
            "dependencies":(0..65).map(|i| json!({"url":format!("https://example.com/{i}.zip"),"reason":"x".repeat(5000)})).collect::<Vec<_>>()
        })).unwrap();
        let path = Path::new("ymb.mod.yaml");
        validate_release(&config, path).unwrap();
        assert!(
            download_source(&format!(
                "https://example.com/mod.zip?token={}",
                "a".repeat(20000)
            ))
            .is_ok()
        );
        config.dependencies.push(config.dependencies[0].clone());
        assert!(validate_release(&config, path).is_err());
    }
    #[test]
    fn publication_overrides_validate_types_and_structure() {
        let release: Release = serde_json::from_value(json!({
            "title": "{{version}}", "description": "Setup\n{{checksums}}", "assets": ["*.zip"],
            "draft": true, "generateNotes": false, "managedTags": "^v.*$",
            "branches": [{"name":"main", "tag":"v{{version}}", "latest":true},
                         {"pattern":"^preview/.*$", "tag":"preview", "prerelease":"auto"}]
        }))
        .unwrap();
        validate_publication(&release, Path::new("ymb.mod.yaml")).unwrap();
        for invalid in [
            json!({"branches":[{"name":"main","tag":"stable","latest":"yes"}]}),
            json!({"draft":"false"}),
            json!({"unknown":true}),
        ] {
            assert!(serde_json::from_value::<Release>(invalid).is_err());
        }
        for invalid in [
            json!({"assets":["../secret.zip"]}),
            json!({"title":"two\nlines"}),
            json!({"managedTags":".*"}),
            json!({"branches":[{"name":"main","pattern":"^.*$","tag":"stable"}]}),
        ] {
            let release: Release = serde_json::from_value(invalid).unwrap();
            assert!(validate_publication(&release, Path::new("ymb.mod.yaml")).is_err());
        }
    }
    #[test]
    fn download_links_accept_direct_archives_with_queries_and_reject_repository_pages() {
        assert_eq!(
            download_source(
                "https://github.com/Yokaiste/YSM/releases/latest/download/YSM-config.zip"
            )
            .unwrap()
            .name(),
            "YSM"
        );
        assert_eq!(
            download_source("https://example.com/mods/Example-config.zip")
                .unwrap()
                .name(),
            "Example"
        );
        assert!(download_source("https://cdn.example.com/download?id=42&token=signed").is_ok());
        assert!(download_source("https://cdn.example.com/Example.zip?token=signed").is_ok());
        for url in [
            "http://example.com/Mod.zip",
            "https://github.com/owner/project",
            "https://github.com/owner/project/releases/tag/stable",
            "https://user@example.com/Mod.zip",
            "https://github.com/owner/../project",
            "https://example.com/Mod.zip\n",
        ] {
            assert!(download_source(url).is_err(), "{url}");
        }
    }
}
