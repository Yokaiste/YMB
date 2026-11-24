use super::*;
use semver::{Version, VersionReq};

pub(super) fn curl() -> Result<PathBuf> {
    let system = std::env::var_os("SystemRoot").ok_or_else(|| {
        error(crate::messages::text(
            "deploy.download.curl.windows_systemroot_is_missing",
        ))
    })?;
    let curl = PathBuf::from(system).join("System32/curl.exe");
    if !curl.is_file() {
        return Err(error(crate::messages::text(
            "deploy.download.curl.windows_curl_exe_is_missing_restore_the",
        )));
    }
    Ok(curl)
}
pub(super) fn download(url: &str, target: &Path) -> Result<()> {
    if !url.starts_with("https://") {
        return Err(error(crate::messages::text(
            "deploy.download.download.download_url_must_use_https",
        )));
    }
    let mut command = Command::new(curl()?);
    command
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--retry",
            "3",
            "--connect-timeout",
            "20",
            "--max-time",
            "600",
            "--max-filesize",
            "1073741824",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--user-agent",
            "YMB-Installer",
            "--output",
        ])
        .arg(target)
        .arg(url);
    if url.starts_with("https://api.github.com/") {
        command.args([
            "--header",
            "Accept: application/vnd.github+json",
            "--header",
            "X-GitHub-Api-Version: 2026-03-10",
        ]);
    }
    execute(&mut command)?;
    Ok(())
}
pub(super) fn project_asset(url: &str, output: &Path) -> Result<()> {
    config::download_source(url)?;
    download(url, output)
}

fn release_asset(repository: &str, wanted: &str, release: &Value, output: &Path) -> Result<()> {
    let matches: Vec<_> = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| {
            let name = a["name"].as_str().unwrap_or("");
            if wanted == "YMB" {
                name.starts_with("YMB-") && name.ends_with("-windows-x64.zip")
            } else {
                name == wanted
            }
        })
        .collect();
    if matches.len() != 1 {
        return Err(error(crate::messages::format(
            "deploy.download.release_asset.repository_has_no_unambiguous_compatible_wanted_asset",
            &[
                ("REPOSITORY", repository.to_string()),
                ("WANTED", wanted.to_string()),
            ],
        )));
    }
    let asset = matches[0];
    let url = asset["browser_download_url"]
        .as_str()
        .filter(|u| {
            u.starts_with(&format!(
                "https://github.com/{repository}/releases/download/"
            ))
        })
        .ok_or_else(|| {
            error(crate::messages::text(
                "deploy.download.release_asset.unexpected_release_download_url",
            ))
        })?;
    let digest = asset["digest"].as_str().ok_or_else(|| {
        error(crate::messages::text(
            "deploy.download.release_asset.the_release_asset_has_no_sha_256",
        ))
    })?;
    download(url, output)?;
    verify_archive(output, digest)
}

pub(super) fn requirement(source: &str) -> Result<VersionReq> {
    let document = config::yaml(source, Path::new("ymb.mod.yaml"))?;
    let Some(value) = document.value.get("requires") else {
        return Ok(VersionReq::STAR);
    };
    let value = value.as_str().ok_or_else(|| {
        error(crate::messages::text(
            "deploy.download.requirement.the_mod_s_requires_field_must_be",
        ))
    })?;
    VersionReq::parse(value).map_err(|e| error(e.to_string()))
}

pub(super) fn requirements(projects: &[(Project, PathBuf)]) -> Result<Vec<VersionReq>> {
    projects
        .iter()
        .map(|(_, source)| {
            let config = source.join("config/ymb.mod.yaml");
            let bytes = paths::read_limited(&config, 16 << 20)?;
            let text = std::str::from_utf8(&bytes).map_err(|e| error(e.to_string()).at(&config))?;
            requirement(text).map_err(|e| e.at(&config))
        })
        .collect()
}

fn api_pages(endpoint: &str, work: &Path) -> Result<Vec<Value>> {
    let metadata = work.join("github-page.json");
    let mut entries = Vec::new();
    for page in 1..=100 {
        download(
            &format!(
                "https://api.github.com/repos/Yokaiste/YMB/{endpoint}?per_page=100&page={page}"
            ),
            &metadata,
        )?;
        let batch: Vec<Value> = serde_json::from_slice(&paths::read_limited(&metadata, 4 << 20)?)
            .map_err(|e| error(e.to_string()))?;
        let last = batch.len() < 100;
        entries.extend(batch);
        if last {
            return Ok(entries);
        }
    }
    Err(error(crate::messages::text(
        "deploy.download.api_pages.ymb_metadata_exceeds_the_10_000_entry",
    )))
}

fn builder_version(release: &Value) -> Option<Version> {
    let mut assets = release["assets"].as_array()?.iter().filter(|asset| {
        asset["name"]
            .as_str()
            .is_some_and(|name| name.starts_with("YMB-") && name.ends_with("-windows-x64.zip"))
    });
    let name = assets.next()?["name"].as_str()?;
    if assets.next().is_some() {
        return None;
    }
    let version = name
        .strip_prefix("YMB-")?
        .strip_suffix("-windows-x64.zip")?;
    Version::parse(version.strip_prefix('v').unwrap_or(version)).ok()
}

pub(super) fn compatible_release<'a>(
    releases: &'a [Value],
    tags: &HashSet<String>,
    requirements: &[VersionReq],
    previews: bool,
) -> Option<&'a Value> {
    releases
        .iter()
        .filter_map(|release| {
            if release["draft"] != false {
                return None;
            }
            let tag = release["tag_name"].as_str()?;
            if !tags.contains(tag) {
                return None;
            }
            let version = builder_version(release)?;
            let preview =
                release["prerelease"] == true || tag.ends_with("-pre") || !version.pre.is_empty();
            if preview && !previews {
                return None;
            }
            requirements
                .iter()
                .all(|required| required.matches(&version))
                .then_some((!preview, version, release))
        })
        .max_by(|(left_stable, left, _), (right_stable, right, _)| {
            (left_stable, left).cmp(&(right_stable, right))
        })
        .map(|(_, _, release)| release)
}

pub(super) fn choose_builder<'a>(
    releases: &'a [Value],
    tags: &HashSet<String>,
    requirements: &[VersionReq],
    choose_latest: &mut impl FnMut(&Value) -> Result<bool>,
) -> Result<Option<(&'a Value, bool)>> {
    if let Some(release) = compatible_release(releases, tags, requirements, true) {
        return Ok(Some((release, false)));
    }
    let latest = compatible_release(releases, tags, &[], false).ok_or_else(|| {
        error(crate::messages::text(
            "deploy.download.choose_builder.no_downloadable_stable_ymb_release_was_found",
        ))
    })?;
    Ok(choose_latest(latest)?.then_some((latest, true)))
}

pub(super) fn builder_asset(
    requirements: &[VersionReq],
    work: &Path,
    output: &Path,
    try_latest: bool,
) -> Result<Option<bool>> {
    let result = (|| {
        let interactive = std::io::stdin().is_terminal();
        let (tags, releases) = {
            let _input = platform::InputBlock::new(interactive);
            let _progress = Progress::start(vec![
                crate::messages::text("deploy.download.builder_asset.find_compatible_ymb").into(),
            ]);
            let tags = api_pages("tags", work)?
                .iter()
                .filter_map(|tag| tag["name"].as_str().map(str::to_owned))
                .collect();
            (tags, api_pages("releases", work)?)
        };
        let selected = choose_builder(&releases, &tags, requirements, &mut |latest| {
            let version = builder_version(latest).unwrap();
            println!(
                "{}",
                crate::messages::format(
                    "deploy.download.builder_asset.no_supported_stable_or_preview_ymb_version",
                    &[("VERSION", format!("{}", version))]
                )
            );
            if try_latest {
                return Ok(true);
            }
            if !std::io::stdin().is_terminal() {
                return Err(error(crate::messages::text(
                    "deploy.download.builder_asset.trying_an_unsupported_ymb_version_requires_confirmation",
                )));
            }
            Ok(crate::ui::accepted(&prompt(crate::messages::text(
                "deploy.download.builder_asset.try_the_latest_stable_ymb_y_n",
            ))?))
        })?;
        let Some((release, unsupported)) = selected else {
            return Ok(None);
        };
        println!(
            "{}",
            crate::messages::format(
                if unsupported {
                    "deploy.download.builder_asset.using_unsupported"
                } else {
                    "deploy.download.builder_asset.using_supported"
                },
                &[("VERSION", builder_version(release).unwrap().to_string())]
            )
        );
        let _input = platform::InputBlock::new(interactive);
        let _progress = Progress::start(vec![
            crate::messages::text("deploy.download.builder_asset.download_ymb").into(),
        ]);
        release_asset("Yokaiste/YMB", "YMB", release, output)?;
        Ok(Some(unsupported))
    })();
    result.map_err(|e: Box<Diagnostic>| {
        e.detail(crate::messages::text(
            "deploy.download.builder_asset.visit_https_github_com_yokaiste_ymb_for",
        ))
    })
}
pub(super) fn local_archive(path: &Path) -> Result<PathBuf> {
    let path = paths::absolute(path)?;
    let checksum = paths::read_limited(&path.with_extension("zip.sha256"), 4096)?;
    let checksum = std::str::from_utf8(&checksum).map_err(|e| error(e.to_string()))?;
    verify_archive(&path, checksum.split_whitespace().next().unwrap_or(""))?;
    Ok(path)
}
