use super::*;

pub fn resolve(
    url: &str,
    fetch: &mut impl FnMut(&str) -> Result<(Installer, PathBuf)>,
    choose: &mut impl FnMut(&Dependency) -> Result<bool>,
) -> Result<Vec<(Project, PathBuf)>> {
    enum Work {
        Visit(String),
        Choose(Dependency),
        Finish(Installer, PathBuf),
    }
    let mut selected = Vec::new();
    let mut visiting = HashSet::new();
    let mut done = HashSet::new();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut pending = vec![Work::Visit(url.into())];
    while let Some(work) = pending.pop() {
        match work {
            Work::Visit(url) => {
                let key = config::download_source(&url)?.key();
                if done.contains(&key) {
                    continue;
                }
                if !visiting.insert(key) {
                    return Err(error(crate::messages::text(
                        "deploy.dependencies.visit.download_dependencies_contain_a_cycle",
                    )));
                }
                let (mut installer, archive) = fetch(&url)?;
                installer.project.url = url;
                let dependencies = installer.project.dependencies.clone();
                pending.push(Work::Finish(installer, archive));
                pending.extend(dependencies.into_iter().rev().map(Work::Choose));
            }
            Work::Choose(dependency) => {
                let include = choose(&dependency)?;
                if dependency.required || include {
                    pending.push(Work::Visit(dependency.url));
                }
            }
            Work::Finish(installer, archive) => {
                if !ids.insert(installer.project.id.to_ascii_lowercase())
                    || !names.insert(installer.project.name.to_ascii_lowercase())
                {
                    return Err(error(crate::messages::text(
                        "deploy.dependencies.visit.different_download_links_name_the_same_project",
                    )));
                }
                visiting.remove(&installer.project.url);
                done.insert(installer.project.url.clone());
                selected.push((installer.project, archive));
            }
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wide_and_deep_dependency_graphs_preserve_order_and_shared_projects() {
        for deep in [false, true] {
            let mut calls = Vec::new();
            let mut fetch = |url: &str| {
                let index: usize = url
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .trim_end_matches(".zip")
                    .parse()
                    .unwrap();
                calls.push(index);
                let dependencies = if deep {
                    (index + 1..300).take(1).collect::<Vec<_>>()
                } else if index == 0 {
                    (1..300).chain([1]).collect()
                } else {
                    Vec::new()
                };
                Ok((
                    fixture(
                        &format!("P{index}"),
                        dependencies
                            .into_iter()
                            .map(|i| Dependency {
                                url: format!("https://example.com/{i}.zip"),
                                required: true,
                                reason: None,
                            })
                            .collect(),
                    ),
                    PathBuf::new(),
                ))
            };
            let selected =
                resolve("https://example.com/0.zip", &mut fetch, &mut |_| Ok(false)).unwrap();
            assert_eq!(selected.len(), 300);
            assert_eq!(calls, (0..300).collect::<Vec<_>>());
            assert_eq!(selected.last().unwrap().0.name, "P0");
            assert_eq!(
                selected.first().unwrap().0.name,
                if deep { "P299" } else { "P1" }
            );
        }
        let mut fetch = |url: &str| {
            Ok((
                fixture(
                    "Same",
                    if url.ends_with("root.zip") {
                        vec![Dependency {
                            url: "https://example.com/other.zip".into(),
                            required: true,
                            reason: None,
                        }]
                    } else {
                        Vec::new()
                    },
                ),
                PathBuf::new(),
            ))
        };
        assert!(
            resolve("https://example.com/root.zip", &mut fetch, &mut |_| Ok(
                false
            ))
            .unwrap_err()
            .reason
            .contains("same project")
        );
    }
    fn fixture(name: &str, dependencies: Vec<Dependency>) -> Installer {
        Installer {
            project: Project {
                name: name.into(),
                id: name.to_lowercase(),
                url: format!("https://downloads.example.com/{name}-config.zip"),
                dependencies,
            },
            version: "1.0.0".into(),
        }
    }
    #[test]
    fn required_dependencies_are_automatic_optional_dependencies_are_chosen_and_cycles_fail() {
        let dependency = |name: &str, required| Dependency {
            url: format!("https://downloads.example.com/{name}-config.zip"),
            required,
            reason: Some("More content".into()),
        };
        let root = fixture(
            "Root",
            vec![dependency("Required", true), dependency("Optional", false)],
        );
        for include in [false, true] {
            let mut fetch = |url: &str| {
                Ok((
                    if url.ends_with("/Root-config.zip") {
                        root.clone()
                    } else {
                        fixture(
                            url.rsplit('/')
                                .next()
                                .unwrap()
                                .trim_end_matches("-config.zip"),
                            vec![],
                        )
                    },
                    PathBuf::from("archive.zip"),
                ))
            };
            let result = resolve(&root.project.url, &mut fetch, &mut |_| Ok(include)).unwrap();
            assert_eq!(result.len(), if include { 3 } else { 2 });
            assert_eq!(result.first().unwrap().0.name, "Required");
            assert_eq!(result.last().unwrap().0.name, "Root");
        }
        let mut fetch = |_: &str| {
            Ok((
                fixture("Root", vec![dependency("Root", true)]),
                PathBuf::new(),
            ))
        };
        assert!(resolve(&root.project.url, &mut fetch, &mut |_| Ok(false)).is_err());
    }
}
