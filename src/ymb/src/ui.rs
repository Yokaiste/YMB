use serde_json::Value;
use std::path::Path;
use std::{
    fmt::Write as _,
    io::IsTerminal,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use ymb_core::{Diagnostic, Result, metadata};

static HUMAN: AtomicBool = AtomicBool::new(true);
static SHOW_PROGRESS: AtomicBool = AtomicBool::new(true);
const SHORTCUT_WIDTH: usize = 3;
const COMMAND_WIDTH: usize = 8;
const COLUMN_GAP: &str = "   ";

enum Running {
    Animated {
        sender: mpsc::Sender<ProgressEvent>,
        thread: thread::JoinHandle<()>,
    },
    Plain(Vec<String>),
}
static PROGRESS: Mutex<Option<Running>> = Mutex::new(None);

pub fn configure(json: bool, verbose: bool) {
    HUMAN.store(!json, Ordering::Relaxed);
    SHOW_PROGRESS.store(!json || verbose, Ordering::Relaxed);
    if !json {
        ymb_core::terminal::enable_ansi();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Accent,
    Good,
    Warn,
    Bad,
    Muted,
    Strong,
}

pub struct Ui {
    pub rich: bool,
    color: bool,
    pub width: usize,
}
impl Ui {
    pub fn plain(width: usize) -> Self {
        Self {
            rich: false,
            color: false,
            width,
        }
    }
    pub fn stdout() -> Self {
        Self::new(std::io::stdout().is_terminal())
    }
    pub fn stderr() -> Self {
        Self::new(std::io::stderr().is_terminal())
    }
    fn new(terminal: bool) -> Self {
        let rich = terminal
            && HUMAN.load(Ordering::Relaxed)
            && std::env::var("TERM").as_deref() != Ok("dumb");
        Self {
            rich,
            color: rich && std::env::var_os("NO_COLOR").is_none(),
            width: terminal_width().clamp(32, 100).saturating_sub(1),
        }
    }
    pub fn paint(&self, text: &str, tone: Tone) -> String {
        let text = clean(text);
        if !self.color {
            return text;
        }
        let code = match tone {
            Tone::Accent => "36",
            Tone::Good => "1;32",
            Tone::Warn => "1;33",
            Tone::Bad => "1;31",
            Tone::Muted => "2",
            Tone::Strong => "1",
        };
        format!("\x1b[{code}m{text}\x1b[0m")
    }
    pub fn rule(&self, title: &str) -> String {
        format!("  {}\n", self.paint(title, Tone::Strong))
    }
    pub fn banner(&self, subtitle: &str) -> String {
        let mut out = self.title(&crate::messages::format(
            "ui.banner.yokaiste_s_mod_builder_arg0",
            &[("ARG0", metadata::VERSION.to_string())],
        ));
        if !subtitle.is_empty() {
            let _ = writeln!(out, "  {}", self.paint(subtitle, Tone::Strong));
        }
        out
    }
    pub fn title(&self, title: &str) -> String {
        format!("\n  {}\n\n", self.paint(title, Tone::Accent))
    }
    pub fn rows(&self, choices: &[(&str, &str, &str)], tone: Tone) -> String {
        let key_width = choices
            .iter()
            .map(|(key, _, _)| key.chars().count() + 2)
            .max()
            .unwrap_or(0)
            .max(SHORTCUT_WIDTH);
        let name_width = choices
            .iter()
            .map(|(_, name, _)| name.chars().count())
            .max()
            .unwrap_or(0)
            .clamp(COMMAND_WIDTH, 12);
        let value_column = 2 + key_width + 1 + name_width + COLUMN_GAP.len();
        let mut out = String::new();
        for (key, name, value) in choices {
            let mut lines = wrap(
                &clean(value),
                self.width.saturating_sub(value_column).max(1),
            );
            if lines.is_empty() {
                lines.push(String::new());
            }
            for (index, line) in lines.iter().enumerate() {
                let prefix = if index == 0 {
                    format!("  {}", self.option(key, name, key_width, name_width))
                } else {
                    " ".repeat(value_column)
                };
                let _ = writeln!(out, "{prefix}{}", self.paint(line, tone));
            }
        }
        out
    }
    fn option(&self, key: &str, name: &str, key_width: usize, name_width: usize) -> String {
        format!(
            "{} {}{COLUMN_GAP}",
            self.paint(&format!("{:<key_width$}", format!("[{key}]")), Tone::Accent),
            self.paint(
                &format!("{:<name_width$}", shorten(name, name_width)),
                Tone::Strong
            )
        )
    }
    pub fn actions(&self, commands: &[(&str, &str)]) -> String {
        let key_width = commands
            .iter()
            .map(|(key, _)| key.chars().count() + 2)
            .max()
            .unwrap_or(0)
            .max(SHORTCUT_WIDTH);
        let name_width = commands
            .iter()
            .map(|(_, name)| name.chars().count())
            .max()
            .unwrap_or(0)
            .clamp(COMMAND_WIDTH, 12);
        let cell_width = key_width + 1 + name_width + COLUMN_GAP.len();
        let columns = (self.width.saturating_sub(2) / cell_width).clamp(1, 3);
        let mut out = String::new();
        for row in commands.chunks(columns) {
            out.push_str("  ");
            for (key, name) in row {
                out.push_str(&self.option(key, name, key_width, name_width));
            }
            out.push('\n');
        }
        out
    }

    pub fn input_start(&self, label: &str) -> String {
        let label = clean(label);
        if self.color {
            format!("\x1b[0m\n\x1b[30;46m  {label}: \x1b[K")
        } else {
            format!("\n  {label}: ")
        }
    }
    pub fn input_end(&self) -> &'static str {
        if self.color { "\x1b[0m\x1b[K" } else { "" }
    }
    pub fn label(&self, key: &str, value: &str) -> String {
        let key = clean(key);
        let key_width = key.chars().count().max(12);
        let value = clean(value);
        let value_column = 2 + key_width + COLUMN_GAP.len();
        let mut lines = wrap(&value, self.width.saturating_sub(value_column + 1).max(1));
        if lines.is_empty() {
            lines.push(String::new());
        }
        let mut out = format!(
            "  {}{COLUMN_GAP}{}\n",
            self.paint(&format!("{key:<key_width$}"), Tone::Muted),
            lines[0]
        );
        for line in &lines[1..] {
            let _ = writeln!(out, "{:width$}{line}", "", width = value_column);
        }
        out
    }
    pub fn report(&self, data: &Value, verbose: bool) -> String {
        let mut groups = crate::diagnostics::data(data);
        let summary = groups.as_object_mut().unwrap().remove("I1");
        let dry_run = data["dryRun"] == true;
        if !verbose {
            groups.as_object_mut().unwrap().retain(|code, _| {
                code != "I4" && (dry_run || !matches!(code.as_str(), "I10" | "I11"))
            });
        }
        let mut out = self.messages(
            &groups,
            verbose,
            if verbose {
                usize::MAX
            } else if dry_run {
                8
            } else {
                1
            },
        );
        let mut next = None;
        if let Some(releases) = data["releases"].as_array() {
            for release in releases {
                out.push_str(
                    &self.rule(
                        release["modId"]
                            .as_str()
                            .unwrap_or(crate::messages::text("ui.report.release")),
                    ),
                );
                if let Some(path) = release["archive"].as_str() {
                    out.push_str(&self.label(crate::messages::text("ui.report.archive"), path));
                }
                if let Some(path) = release["deploy"].as_str() {
                    out.push_str(&self.label(crate::messages::text("ui.report.deploy"), path));
                }
                if let Some(reason) = release["deploySkippedReason"].as_str() {
                    out.push_str(&self.label(
                        crate::messages::text("ui.report.deploy"),
                        &crate::messages::format(
                            "ui.report.skipped_reason",
                            &[("REASON", reason.to_string())],
                        ),
                    ));
                }
            }
        }
        if let Some(outputs) = data["outputs"].as_array() {
            if verbose {
                let bytes = outputs
                    .iter()
                    .filter_map(|value| value["bytes"].as_u64())
                    .sum();
                let tests = data["tests"].as_array().map_or(0, Vec::len);
                out.push_str(&self.label(
                    crate::messages::text("ui.report.prepared"),
                    &crate::messages::format(
                        "ui.report.arg0_files_arg1_tests_checks",
                        &[
                            ("ARG0", format!("{}", outputs.len())),
                            ("ARG1", size(bytes).to_string()),
                            ("TESTS", format!("{}", tests)),
                        ],
                    ),
                ));
            }
            if data["previewPublished"] == true
                && let Some(path) = data["previewPath"].as_str()
            {
                out.push_str(&self.label(crate::messages::text("common.shared.preview"), path));
            }
            next = Some(
                if groups
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|group| group["severity"] == "error")
                {
                    if data["applied"] == true {
                        crate::messages::text(
                            "ui.report.review_the_reported_issues_before_running_generatemod",
                        )
                    } else if data["previewPublished"] == true {
                        crate::messages::text(
                            "ui.report.review_the_reported_issues_and_preview_before",
                        )
                    } else {
                        crate::messages::text(
                            "ui.report.review_the_reported_issues_before_building_a",
                        )
                    }
                } else if data["applied"] == true {
                    crate::messages::text("ui.report.run_generatemod_bat_then_enable_the_mod")
                } else if data["previewPublished"] == true {
                    crate::messages::text("ui.report.review_the_preview_then_run_sync_to")
                } else {
                    crate::messages::text("ui.report.run_build_to_save_a_preview_of")
                },
            );
        }
        if let Some(projects) = data["projects"].as_array()
            && (verbose || !data["explanations"].is_array())
        {
            out.push_str(&self.rule(crate::messages::text("common.shared.projects")));
            for project in projects {
                let patches = project["patches"].as_array().map_or(0, Vec::len);
                out.push_str(&self.block(
                    "  ",
                    &crate::messages::quantity(
                        "ui.report.project_patches",
                        patches,
                        &[
                            ("ID", project["id"].as_str().unwrap_or("").to_string()),
                            ("NAME", project["name"].as_str().unwrap_or("").to_string()),
                        ],
                    ),
                    Tone::Strong,
                ));
                if verbose {
                    out.push_str(&self.label(
                        crate::messages::text("ui.report.priority"),
                        &project["priority"].to_string(),
                    ));
                    out.push_str(&self.generators(&project["generators"], "    "));
                }
                if let Some(patches) = project["patches"].as_array() {
                    for patch in patches {
                        out.push_str(&self.block(
                            "    ",
                            &format!(
                                "{}  {}",
                                patch["id"].as_str().unwrap_or(""),
                                patch["name"].as_str().unwrap_or("")
                            ),
                            Tone::Muted,
                        ));
                        if verbose {
                            out.push_str(&self.generators(&patch["generators"], "      "));
                        }
                    }
                }
            }
        }
        if let Some(matches) = data["matches"].as_array().filter(|items| !items.is_empty()) {
            out.push_str(&self.rule(crate::messages::text("ui.report.matches")));
            for item in matches {
                let _ = writeln!(
                    out,
                    "  {}  {}",
                    self.paint(
                        item["name"]
                            .as_str()
                            .unwrap_or(crate::messages::text("ui.report.unnamed")),
                        Tone::Accent
                    ),
                    clean(item["type"].as_str().unwrap_or(""))
                );
                let _ = writeln!(
                    out,
                    "    {}:{}",
                    clean(item["file"].as_str().unwrap_or("")),
                    item["line"]
                );
            }
        }
        if let Some(items) = data["explanations"].as_array() {
            out.push_str(&self.rule(crate::messages::text("common.shared.selection")));
            for item in items {
                let included = item["included"] == true;
                let tag = self.paint(
                    if included {
                        crate::messages::text("ui.report.use")
                    } else {
                        crate::messages::text("ui.report.skip")
                    },
                    if included { Tone::Good } else { Tone::Muted },
                );
                let _ = writeln!(
                    out,
                    "  {tag}  {}:{}",
                    clean(item["modId"].as_str().unwrap_or("")),
                    clean(item["patchId"].as_str().unwrap_or(""))
                );
                if let Some(reasons) = item["reasons"].as_array() {
                    for reason in reasons {
                        if let Some(reason) = reason.as_str() {
                            let _ = writeln!(out, "        {}", clean(reason));
                        }
                    }
                }
            }
        }
        if data.get("trackedFiles").is_some() {
            out.push_str(&self.rule(crate::messages::text("ui.report.installation")));
            for (key, label) in [
                (
                    "builderRoot",
                    crate::messages::text("common.shared.builder"),
                ),
                ("gameRoot", crate::messages::text("common.shared.warno_mod")),
                (
                    "configPath",
                    crate::messages::text("common.shared.settings"),
                ),
                (
                    "localConfigPath",
                    crate::messages::text("common.shared.overrides"),
                ),
                ("workRoot", crate::messages::text("ui.report.build_work")),
                ("cacheRoot", crate::messages::text("common.shared.cache")),
                ("recoveryRoot", crate::messages::text("ui.report.recovery")),
            ] {
                if !verbose && key != "gameRoot" {
                    continue;
                }
                if let Some(value) = data[key].as_str() {
                    out.push_str(&self.label(label, value));
                }
            }
            out.push_str(&self.label(
                crate::messages::text("ui.report.operation"),
                if data["operationLock"] == true {
                    crate::messages::text("ui.report.a_command_holds_the_operation_lock")
                } else {
                    crate::messages::text("ui.report.ready")
                },
            ));
            out.push_str(&self.label(
                crate::messages::text("ui.report.recovery"),
                if data["pendingTransaction"] == true {
                    crate::messages::text("ui.report.an_interrupted_operation_needs_recovery")
                } else {
                    crate::messages::text("ui.report.no_pending_operation")
                },
            ));
            if let Some(files) = data["trackedFiles"].as_object() {
                let mut groups = std::collections::BTreeMap::<&str, Vec<&str>>::new();
                for (path, state) in files {
                    groups
                        .entry(state.as_str().unwrap_or("unknown"))
                        .or_default()
                        .push(path);
                }
                for (state, files) in groups {
                    out.push_str(&self.label(
                        state,
                        &crate::messages::format(
                            "ui.report.arg0_files",
                            &[("ARG0", format!("{}", files.len()))],
                        ),
                    ));
                    if verbose {
                        for path in files {
                            let _ = writeln!(out, "    {}", clean(path));
                            out.push_str(&self.contributors(&data["trackedContributors"][path]));
                        }
                    }
                }
            }
        }
        for key in ["paths", "protectedPaths", "files"] {
            if let Some(paths) = data[key].as_array().filter(|paths| !paths.is_empty()) {
                if !verbose && (!dry_run || key == "protectedPaths") {
                    if key == "protectedPaths" {
                        out.push_str(&self.label(
                            crate::messages::text("ui.report.kept"),
                            &crate::messages::quantity(
                                "ui.report.protected_paths",
                                paths.len(),
                                &[],
                            ),
                        ));
                    }
                    continue;
                }
                out.push_str(&self.rule(if key == "protectedPaths" {
                    crate::messages::text("ui.report.kept")
                } else {
                    crate::messages::text("ui.report.files_and_folders")
                }));
                let limit = if verbose { usize::MAX } else { 8 };
                for path in paths.iter().take(limit) {
                    if let Some(path) = path.as_str() {
                        out.push_str(&self.block("  ", path, Tone::Muted));
                    }
                }
                if paths.len() > limit {
                    out.push_str(&self.label(
                        crate::messages::text("common.shared.details"),
                        &crate::messages::quantity(
                            "ui.report.more_paths",
                            paths.len() - limit,
                            &[],
                        ),
                    ));
                }
            }
        }
        if let Some(path) = data["projectPath"].as_str() {
            out.push_str(&self.label(crate::messages::text("ui.report.project"), path));
        }
        if verbose && let Some(metrics) = data["metrics"].as_object() {
            out.push_str(&self.rule(crate::messages::text("ui.report.build_metrics")));
            for (key, value) in metrics {
                out.push_str(&self.label(key, &value.to_string()));
            }
        }
        if let Some(summary) = summary {
            out.push_str(&self.messages(&serde_json::json!({"I1":summary}), verbose, 0));
            if data["applied"] == true
                && let Some(changed) = data["changedFiles"].as_u64()
            {
                out.push_str(&self.label(
                    crate::messages::text("ui.report.changes"),
                    &crate::messages::quantity("ui.report.changed_files", changed as usize, &[]),
                ));
            }
            if !verbose
                && let Some(tests) = data["tests"].as_array().filter(|tests| !tests.is_empty())
            {
                out.push_str(&self.label(
                    crate::messages::text("ui.report.checks"),
                    &tests.len().to_string(),
                ));
            }
            out.push_str(&self.findings(&groups, verbose));
        }
        if let Some(next) = next {
            out.push_str(&self.label(crate::messages::text("common.shared.next"), next));
        }
        if !verbose && !groups.as_object().unwrap().is_empty() {
            out.push_str(&self.label(
                crate::messages::text("common.shared.details"),
                crate::messages::text("ui.report.use_d_in_the_menu_or_verbose"),
            ));
        }
        out
    }
    fn contributors(&self, contributors: &Value) -> String {
        let Some(contributors) = contributors.as_array().filter(|items| !items.is_empty()) else {
            return String::new();
        };
        let names = contributors
            .iter()
            .map(|owner| {
                let id = owner["modId"].as_str().unwrap_or("");
                owner["patchId"]
                    .as_str()
                    .map_or_else(|| id.to_owned(), |patch| format!("{id}:{patch}"))
            })
            .collect::<Vec<_>>();
        self.label(
            crate::messages::text("ui.messages.contributors"),
            &names.join(", "),
        )
    }
    fn generators(&self, generators: &Value, prefix: &str) -> String {
        let mut out = String::new();
        if let Some(generators) = generators.as_array() {
            for generator in generators {
                out.push_str(&self.block(
                    prefix,
                    &crate::messages::format(
                        if generator["enabled"] == false {
                            "ui.generators.disabled"
                        } else {
                            "ui.generators.enabled"
                        },
                        &[("ID", generator["id"].as_str().unwrap_or("").to_string())],
                    ),
                    Tone::Muted,
                ));
            }
        }
        out
    }
    fn findings(&self, groups: &Value, verbose: bool) -> String {
        let parts = ["error", "warning"]
            .into_iter()
            .filter_map(|severity| {
                let count = groups
                    .as_object()
                    .unwrap()
                    .values()
                    .filter(|group| group["severity"] == severity)
                    .filter_map(|group| group["count"].as_u64())
                    .sum::<u64>();
                (verbose || count != 0).then(|| {
                    crate::messages::quantity(
                        if severity == "error" {
                            "ui.findings.errors"
                        } else {
                            "ui.findings.warnings"
                        },
                        count as usize,
                        &[],
                    )
                })
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            String::new()
        } else {
            self.label(
                crate::messages::text("ui.findings.findings"),
                &parts.join(" / "),
            )
        }
    }
    fn messages(&self, groups: &Value, verbose: bool, target_limit: usize) -> String {
        let mut out = String::new();
        let Some(groups) = groups.as_object() else {
            return out;
        };
        let mut shown = 0;
        for (severity, tone) in [
            ("error", Tone::Bad),
            ("warning", Tone::Warn),
            ("info", Tone::Muted),
        ] {
            for (code, group) in groups
                .iter()
                .filter(|(_, group)| group["severity"] == severity)
            {
                for message in group["messages"].as_array().unwrap() {
                    if !verbose && shown == 5 {
                        return out;
                    }
                    shown += 1;
                    let heading_tone = if code == "I1" { Tone::Good } else { tone };
                    let text = message["message"].as_str().unwrap_or("");
                    let count = message["count"].as_u64().unwrap_or(1);
                    let heading = if count > 1 {
                        crate::messages::format(
                            "ui.messages.text_count_occurrences",
                            &[("TEXT", text.to_string()), ("COUNT", format!("{}", count))],
                        )
                    } else {
                        text.to_owned()
                    };
                    out.push('\n');
                    out.push_str(&self.block(&format!("  [{code}] "), &heading, heading_tone));
                    for target in message["targets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .take(target_limit)
                    {
                        if !verbose {
                            let source = target["patchConfigPath"]
                                .as_str()
                                .or_else(|| target["path"].as_str());
                            let line = if target["patchConfigPath"].is_string() {
                                target["operationLine"].as_u64()
                            } else {
                                target["line"].as_u64()
                            };
                            if let Some(source) = source {
                                let line = line.map_or(String::new(), |line| format!(":{line}"));
                                out.push_str(&self.block(
                                    "    ",
                                    &format!("{source}{line}"),
                                    Tone::Muted,
                                ));
                            } else if let Some(owner) = target["modName"]
                                .as_str()
                                .or_else(|| target["modId"].as_str())
                            {
                                let feature = target["patchId"].as_str().map_or_else(
                                    || owner.to_owned(),
                                    |patch| format!("{owner}: {patch}"),
                                );
                                out.push_str(&self.block("    ", &feature, Tone::Muted));
                            }
                            out.push_str(&self.contributors(&target["contributors"]));
                        } else {
                            let mut parts = Vec::new();
                            if let Some(path) = target["path"].as_str() {
                                let mut path = clean(path);
                                for key in ["line", "column"] {
                                    if let Some(number) = target[key].as_u64() {
                                        let _ = write!(path, ":{number}");
                                    }
                                }
                                parts.push(path);
                            }
                            let selector = &target["selector"];
                            if let Some(value) = selector["value"].as_str() {
                                parts.push(clean(value));
                            } else if let Some(value) = selector["where"].as_object() {
                                parts.push(clean(&serde_json::to_string(value).unwrap()));
                            }
                            let owners = ["modId", "patchId", "generatorId"]
                                .iter()
                                .filter_map(|key| target[*key].as_str())
                                .collect::<Vec<_>>();
                            if !owners.is_empty() {
                                parts.push(owners.join(":"));
                            }
                            if let Some(index) = target["operationIndex"].as_u64() {
                                parts.push(crate::messages::format(
                                    "ui.messages.operation_arg0",
                                    &[("ARG0", format!("{}", index + 1))],
                                ));
                            }
                            if let Some(option) = target["filter"]["option"].as_str() {
                                parts.push(format!(
                                    "{option} {}",
                                    clean(target["filter"]["value"].as_str().unwrap_or(""))
                                ));
                            }
                            if let Some(cache) = target["cacheRoot"].as_str() {
                                parts.push(clean(cache));
                            }
                            if let Some(bytes) = target["bytes"].as_u64() {
                                parts.push(size(bytes));
                            }
                            if !parts.is_empty() {
                                out.push_str(&self.block(
                                    "    - ",
                                    &parts.join(" / "),
                                    Tone::Strong,
                                ));
                            }
                            if let Some(source) = target["patchConfigPath"].as_str() {
                                let line = target["operationLine"]
                                    .as_u64()
                                    .map_or(String::new(), |n| format!(":{n}"));
                                out.push_str(&self.block(
                                    "      ",
                                    &format!("{}{line}", clean(source)),
                                    Tone::Muted,
                                ));
                            }
                        }
                        for (key, label) in [
                            ("cause", crate::messages::text("ui.messages.cause")),
                            ("expected", crate::messages::text("ui.messages.intentional")),
                            (
                                "conflictPreviewPath",
                                crate::messages::text("ui.messages.compare"),
                            ),
                        ] {
                            if let Some(value) = target[key].as_str() {
                                out.push_str(&self.label(label, value));
                            }
                        }
                        if verbose && let Some(details) = target["details"].as_array() {
                            for detail in details.iter().filter_map(Value::as_str) {
                                for line in detail.lines() {
                                    out.push_str(&self.block("      ", line, Tone::Muted));
                                }
                            }
                        }
                    }
                    if !verbose && target_limit == 0 {
                        continue;
                    }
                    for suggestion in message["suggestions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                        .take(if verbose { usize::MAX } else { 1 })
                    {
                        out.push_str(&self.label(
                            if severity == "error" {
                                crate::messages::text("ui.messages.fix")
                            } else {
                                crate::messages::text("ui.messages.review")
                            },
                            suggestion,
                        ));
                    }
                }
            }
        }
        out
    }
    pub fn errors(&self, errors: &[Diagnostic], verbose: bool) -> String {
        let groups = crate::diagnostics::errors(errors);
        let mut out = self.messages(&groups, verbose, if verbose { usize::MAX } else { 1 });
        out.push_str(&self.findings(&groups, verbose));
        if !verbose
            && groups
                .as_object()
                .unwrap()
                .values()
                .any(|group| group["severity"] == "error")
        {
            out.push_str(&self.label(
                crate::messages::text("common.shared.details"),
                crate::messages::text("ui.errors.use_d_in_the_menu_or_verbose"),
            ));
        }
        out
    }
    pub fn error(&self, error: &Diagnostic, verbose: bool) -> String {
        self.errors(std::slice::from_ref(error), verbose)
    }
    pub fn block(&self, prefix: &str, text: &str, tone: Tone) -> String {
        let clean = clean(text);
        let indent = prefix.chars().count();
        let mut out = String::new();
        for (index, line) in wrap(&clean, self.width.saturating_sub(indent).max(1))
            .iter()
            .enumerate()
        {
            let margin = if index == 0 {
                prefix.to_owned()
            } else {
                " ".repeat(indent)
            };
            let _ = writeln!(out, "{}", self.paint(&format!("{margin}{line}"), tone));
        }
        out
    }
}

pub fn clean(text: &str) -> String {
    let text = text.replace(r"\\?\UNC\", r"\\").replace(r"\\?\", "");
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
}
pub fn size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64 / 1024.;
    let mut index = 0;
    while value >= 1024. && index < units.len() - 1 {
        value /= 1024.;
        index += 1;
    }
    format!("{value:.1} {}", units[index])
}
fn shorten(text: &str, width: usize) -> String {
    let text = clean(text);
    if text.chars().count() <= width {
        return text;
    }
    format!(
        "{}...",
        text.chars()
            .take(width.saturating_sub(3))
            .collect::<String>()
    )
}
fn wrap(mut text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some((end, _)) = text.char_indices().nth(width) {
        let split = if text[end..].starts_with(' ') {
            end
        } else {
            text[..end]
                .rfind(' ')
                .filter(|index| *index > 0)
                .unwrap_or(end)
        };
        lines.push(text[..split].to_owned());
        text = text[split..].trim_start();
    }
    if !text.is_empty() {
        lines.push(text.to_owned());
    }
    lines
}
pub fn elapsed(duration: Duration) -> String {
    let seconds = duration.as_secs();
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}
pub fn help(text: &str) -> String {
    let mut out = String::new();
    let mut blank = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank = true;
            continue;
        }
        if blank && !line.trim_start().starts_with('-') {
            out.push('\n');
        }
        blank = false;
        if line.trim_start().starts_with('-') {
            let option = line.trim();
            if let Some((name, description)) = option.split_once("  ") {
                let _ = writeln!(out, "    {name:<26} {}", description.trim_start());
            } else {
                let _ = writeln!(out, "    {option}");
            }
        } else {
            let _ = writeln!(out, "  {line}");
        }
    }
    out
}
pub fn command<'a>(input: &str, commands: &[(&str, &'a str, &str)]) -> Result<Option<&'a str>> {
    let input = input.trim().trim_matches(['[', ']']);
    if let Some((_, name, _)) = commands
        .iter()
        .find(|(key, _, _)| key.eq_ignore_ascii_case(input))
    {
        return Ok(Some(name));
    }
    let input = input.to_ascii_lowercase();
    let input = match input.as_str() {
        "q" | "quit" => "exit",
        "--help" | "?" => "help",
        other => other,
    };
    if input.is_empty() {
        return Ok(None);
    }
    if let Some((_, name, _)) = commands.iter().find(|(_, name, _)| *name == input) {
        return Ok(Some(name));
    }
    let matches: Vec<_> = commands
        .iter()
        .filter(|(_, name, _)| name.starts_with(input))
        .collect();
    match matches.as_slice() {
        [(_, name, _)] => Ok(Some(name)),
        [] => Err(crate::arguments::suggest(
            Diagnostic::new(
                "CommandError",
                crate::messages::format(
                    "ui.command.no_command_matches_input",
                    &[("INPUT", input.to_string())],
                ),
                crate::messages::text("ui.command.type_a_listed_shortcut_or_command_name"),
            )
            .code("E2"),
            input,
            commands.iter().map(|(_, name, _)| *name),
        )),
        _ => Err(crate::arguments::suggest(
            Diagnostic::new(
                "CommandError",
                crate::messages::format(
                    "ui.command.input_matches_more_than_one_command",
                    &[("INPUT", input.to_string())],
                ),
                crate::messages::format(
                    "ui.command.type_more_letters_arg0",
                    &[(
                        "ARG0",
                        matches
                            .iter()
                            .map(|(_, name, _)| *name)
                            .collect::<Vec<_>>()
                            .join(", ")
                            .to_string(),
                    )],
                ),
            )
            .code("E3"),
            input,
            matches.iter().map(|(_, name, _)| *name),
        )),
    }
}

pub fn prompt(label: &str) -> Result<String> {
    use std::io::{self, Write};
    let ui = Ui::stderr();
    eprint!("{}", ui.input_start(label));
    io::stderr()
        .flush()
        .map_err(|e| Diagnostic::io(Path::new("stderr"), e))?;
    let mut value = String::new();
    let result = io::stdin().read_line(&mut value);
    eprintln!("{}", ui.input_end());
    let count = result.map_err(|e| Diagnostic::io(Path::new("stdin"), e))?;
    if count == 0 {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("ui.prompt.terminal_input_was_closed"),
            crate::messages::text("ui.prompt.run_a_command_with_arguments_or_open"),
        )
        .code("I3"));
    }
    Ok(value.trim().to_owned())
}

pub fn confirm(items: &[String]) -> Result<bool> {
    eprint!(
        "{}",
        Ui::stderr().rule(crate::messages::text("ui.confirm.confirm_this_command"))
    );
    for item in items {
        eprint!("{}", Ui::stderr().block("    - ", item, Tone::Strong));
    }
    match prompt(crate::messages::text("ui.confirm.continue_y_n")) {
        Ok(answer) => Ok(accepted(&answer)),
        Err(error) if error.code.as_deref() == Some("I3") => Ok(false),
        Err(error) => Err(error),
    }
}
pub fn accepted(answer: &str) -> bool {
    let answer = answer.trim();
    answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
}

pub fn wait(label: &str) -> Result<()> {
    use std::io::Write;
    let ui = Ui::stderr();
    eprint!("{}", ui.input_start(label));
    std::io::stderr()
        .flush()
        .map_err(|e| Diagnostic::io(std::path::Path::new("stderr"), e))?;
    let result = ymb_core::terminal::wait_for_enter();
    eprintln!("{}\n", ui.input_end());
    result
}
fn terminal_width() -> usize {
    if let Some(width) = std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
    {
        return width;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::*;
        // The returned screen bounds are used only after a successful console query.
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(GetStdHandle(STD_ERROR_HANDLE), &mut info) != 0 {
                return (info.srWindow.Right - info.srWindow.Left + 1).max(1) as usize;
            }
        }
    }
    88
}

enum ProgressEvent {
    Step(usize),
    Extend(Vec<String>),
    Failed(usize),
    Detail(String),
}
struct ProgressView {
    steps: Vec<String>,
    current: usize,
    detail: String,
    completed: std::collections::HashSet<usize>,
    failed: std::collections::HashSet<usize>,
}
impl ProgressView {
    fn update(&mut self, event: ProgressEvent) {
        match event {
            ProgressEvent::Step(index) if index < self.steps.len() => {
                if index > self.current {
                    if !self.failed.contains(&self.current) {
                        self.completed.insert(self.current);
                    }
                } else {
                    self.completed.retain(|completed| *completed < index);
                    self.failed.retain(|failed| *failed < index);
                }
                self.current = index;
                self.detail.clear();
            }
            ProgressEvent::Step(_) => (),
            ProgressEvent::Extend(steps) => self.steps.extend(steps),
            ProgressEvent::Failed(index) if index < self.steps.len() => {
                self.completed.remove(&index);
                self.failed.insert(index);
            }
            ProgressEvent::Failed(_) => (),
            ProgressEvent::Detail(detail) => self.detail = detail,
        }
    }
    fn lines(&self, ui: &Ui, elapsed: Duration, frame: usize) -> Vec<String> {
        let mut lines = vec![format!(
            "  {}",
            ui.paint(
                &crate::messages::format(
                    "ui.lines.arg0_arg1_elapsed_arg2",
                    &[
                        ("ARG0", format!("{}", self.current + 1)),
                        ("ARG1", format!("{}", self.steps.len())),
                        ("ARG2", self::elapsed(elapsed).to_string())
                    ]
                ),
                Tone::Muted
            )
        )];
        for offset in -2isize..=2 {
            let index = self.current as isize + offset;
            if index < 0 || index >= self.steps.len() as isize {
                lines.push(String::new());
                continue;
            }
            let failed = self.failed.contains(&(index as usize));
            let tag = if failed {
                "[!]"
            } else if self.completed.contains(&(index as usize)) {
                "[OK]"
            } else if offset == 0 {
                ["[/]", "[-]", "[\\]", "[|]"][frame % 4]
            } else {
                "[ ]"
            };
            let tone = if failed {
                Tone::Bad
            } else if offset == 0 {
                Tone::Accent
            } else {
                Tone::Muted
            };
            lines.push(format!(
                "  {}",
                ui.paint(
                    &shorten(
                        &format!("{tag} {}", self.steps[index as usize]),
                        ui.width.saturating_sub(2)
                    ),
                    tone
                )
            ));
        }
        lines.push(format!(
            "  {}",
            ui.paint(
                &shorten(&self.detail, ui.width.saturating_sub(2)),
                Tone::Muted
            )
        ));
        lines
    }
}
pub struct Progress(bool);
impl Progress {
    pub fn start(steps: Vec<String>) -> Self {
        let ui = Ui::stderr();
        if !SHOW_PROGRESS.load(Ordering::Relaxed) || steps.is_empty() {
            return Self(false);
        }
        stop_progress();
        if !ui.rich {
            *PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running::Plain(steps));
            step(0);
            return Self(true);
        }
        let (sender, receiver) = mpsc::channel();
        let thread = thread::spawn(move || {
            use std::io::Write;
            let started = Instant::now();
            let mut view = ProgressView {
                steps,
                current: 0,
                detail: String::new(),
                completed: Default::default(),
                failed: Default::default(),
            };
            let mut frame = 0;
            let mut previous = Vec::<String>::new();
            eprint!("\x1b[?25l");
            loop {
                let lines = view.lines(&ui, started.elapsed(), frame);
                if previous.is_empty() {
                    for line in &lines {
                        eprintln!("{line}");
                    }
                } else {
                    for (index, (line, old)) in lines.iter().zip(&previous).enumerate() {
                        if line != old {
                            let distance = lines.len() - index;
                            eprint!("\x1b[{distance}A\r{line}\x1b[K\x1b[{distance}B\r");
                        }
                    }
                }
                let _ = std::io::stderr().flush();
                previous = lines;
                frame += 1;
                let deadline = Instant::now() + Duration::from_millis(400);
                let mut disconnected = false;
                loop {
                    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    {
                        Ok(event) => view.update(event),
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                }
                if disconnected {
                    break;
                }
            }
            for _ in previous {
                eprint!("\x1b[1A\r\x1b[2K");
            }
            eprint!("\x1b[?25h");
            let _ = std::io::stderr().flush();
        });
        *PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Running::Animated { sender, thread });
        Self(true)
    }
}
impl Drop for Progress {
    fn drop(&mut self) {
        if self.0 {
            stop_progress();
        }
    }
}
pub fn stop_progress() {
    let running = PROGRESS.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(Running::Animated { sender, thread }) = running {
        drop(sender);
        let _ = thread.join();
    }
}
pub fn phase(message: String) {
    if progress_event(ProgressEvent::Detail(message.trim().to_owned())) {
        return;
    }
    if !SHOW_PROGRESS.load(Ordering::Relaxed) {
        return;
    }
    eprintln!("  {}", Ui::stderr().paint(&message, Tone::Muted));
}
pub fn step(index: usize) {
    progress_event(ProgressEvent::Step(index));
}
pub fn extend_steps(steps: Vec<String>) {
    progress_event(ProgressEvent::Extend(steps));
}
pub fn failed_step(index: usize) {
    progress_event(ProgressEvent::Failed(index));
}
fn progress_event(event: ProgressEvent) -> bool {
    let mut running = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    match running.as_mut() {
        Some(Running::Animated { sender, .. }) => sender.send(event).is_ok(),
        Some(Running::Plain(steps)) => {
            let message = match event {
                ProgressEvent::Step(index) => steps
                    .get(index)
                    .map(|label| format!("[{}/{}] {label}", index + 1, steps.len())),
                ProgressEvent::Extend(more) => {
                    steps.extend(more);
                    None
                }
                ProgressEvent::Failed(index) => {
                    steps.get(index).map(|label| format!("[!] {label}"))
                }
                ProgressEvent::Detail(detail) => Some(detail),
            };
            if let Some(message) = message {
                eprintln!("  {}", Ui::stderr().paint(&message, Tone::Muted));
            }
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_reports_hide_inventories_and_keep_a_short_outcome() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 79,
        };
        let data = serde_json::json!({"summary":"Synced 1 file.","applied":true,"changedFiles":0,"previewPublished":true,"previewPath":"D:/private/preview",
            "outputs":[{"targetRelativePath":"GameData/A.ndf","state":"present","bytes":1024}],
            "notices":[{"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf","selector":{"value":"OldA"},"patchConfigPath":"mods/example/patch.yaml","operationLine":12},{"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf","selector":{"value":"OldB"}}],
            "metrics":{"cacheHits":3},"tests":[]});
        let compact = ui.report(&data, false);
        for text in [
            "[I1] Synced 1 file.",
            "[E19] Removal target is already absent. (2 occurrences)",
            "2 errors",
            "0 files",
            "[D]",
            "before running GenerateMod.bat",
            "patch.yaml:12",
            "D:/private/preview",
        ] {
            assert!(compact.contains(text), "Missing {text}");
        }
        for text in [
            "[I10]",
            "Prepared",
            "GameData/A.ndf",
            "OldA",
            "OldB",
            "cacheHits",
            "0 warnings",
        ] {
            assert!(!compact.contains(text), "Unexpected detail: {text}");
        }
        assert_eq!(compact.matches("patch.yaml").count(), 1);
        let detailed = ui.report(&data, true);
        for text in [
            "[I10]",
            "GameData/A.ndf",
            "OldA",
            "OldB",
            "patch.yaml:12",
            "D:/private/preview",
            "cacheHits",
            "1.0 KiB",
        ] {
            assert!(detailed.contains(text), "Missing detail: {text}");
        }
        assert_eq!(
            crate::diagnostics::data(&data)["E19"]["messages"][0]["targets"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn dry_runs_show_affected_paths_without_dumping_unbounded_inventories() {
        let ui = Ui::plain(79);
        let paths: Vec<_> = (0..12)
            .map(|index| format!("GameData/planned-{index}.ndf"))
            .collect();
        for key in ["paths", "files"] {
            let data = serde_json::json!({"summary":"Plan ready.","dryRun":true,key:paths,"protectedPaths":["private/identities"]});
            let compact = ui.report(&data, false);
            assert!(compact.contains(&paths[0]) && compact.contains(&paths[7]));
            assert!(!compact.contains(&paths[8]) && !compact.contains("private/identities"));
            assert!(compact.contains("--verbose"));
            assert!(ui.report(&data, true).contains(&paths[11]));
        }
        let data = serde_json::json!({"summary":"Plan ready.","dryRun":true,"outputs":[{"targetRelativePath":paths[0],"state":"present"},{"targetRelativePath":paths[1],"state":"absent"}]});
        let compact = ui.report(&data, false);
        assert!(compact.contains(&paths[0]) && compact.contains(&paths[1]));
    }

    #[test]
    fn compact_diagnostics_are_bounded_and_failures_keep_a_location() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 79,
        };
        let notices: Vec<_> = (0..8)
            .map(|index| serde_json::json!({"code":"E19","reason":format!("Issue {index}")}))
            .collect();
        let data = serde_json::json!({"summary":"Built 0 files.","notices":notices});
        let compact = ui.report(&data, false);
        assert_eq!(compact.matches("[E19]").count(), 5);
        assert!(compact.contains("8 errors") && compact.contains("[D]"));
        assert_eq!(ui.report(&data, true).matches("[E19]").count(), 8);
        let errors = [
            *Diagnostic::new("ConfigError", "Invalid option.", "Correct the option.")
                .at("a.yaml")
                .detail("Private excerpt"),
            *Diagnostic::new("ConfigError", "Invalid option.", "Correct the option.").at("b.yaml"),
        ];
        let compact = ui.errors(&errors, false);
        assert!(compact.contains("a.yaml") && compact.contains("Correct the option."));
        assert!(!compact.contains("b.yaml") && !compact.contains("Private excerpt"));
        let detailed = ui.errors(&errors, true);
        assert!(
            detailed.contains("a.yaml")
                && detailed.contains("b.yaml")
                && detailed.contains("Private excerpt")
        );
    }
    #[test]
    fn compact_reports_keep_explicitly_requested_results() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 79,
        };
        let projects = serde_json::json!({"summary":"1 project and 1 patch selected.","projects":[{"id":"example","name":"Example project","priority":4,"generators":[{"id":"seed"}],"patches":[{"id":"patch","name":"Patch detail","generators":[{"id":"output"}]}]}]});
        let listed = ui.report(&projects, false);
        assert!(listed.contains("example  Example project (1 patch)"));
        assert!(!listed.contains("Priority"));
        for requested in ["patch", "Patch detail"] {
            assert!(listed.contains(requested), "{listed}");
        }
        assert!(!listed.contains("Generator:"));
        let detailed = ui.report(&projects, true);
        for requested in ["Generator: seed", "Generator: output"] {
            assert!(detailed.contains(requested), "{detailed}");
        }
        let conflict =
            Diagnostic::new("ConflictError", "Shared file.", "Include its contributors.")
                .at("GameData/shared.ndf")
                .with(
                    "contributors",
                    serde_json::json!([{"modId":"alpha","patchId":"health"},{"modId":"beta"}]),
                );
        let report = ui.error(&conflict, false);
        for required in ["GameData/shared.ndf", "alpha:health", "beta"] {
            assert!(report.contains(required), "{report}");
        }
        let found = ui.report(&serde_json::json!({"summary":"1 match; 1 shown.","matches":[{"name":"UnitA","type":"TUnit","file":"GameData/A.ndf","line":3}]}), false);
        assert!(found.contains("UnitA") && found.contains("GameData/A.ndf:3"));
        let explained = ui.report(&serde_json::json!({"projects":projects["projects"],"explanations":[{"modId":"example","patchId":"patch","included":false,"reasons":["Disabled by scope"]}]}), false);
        assert!(explained.contains("example:patch") && explained.contains("Disabled by scope"));
        assert!(!explained.contains("Projects"));
        let data = serde_json::json!({"summary":"1 tracked file; 0 problems.","gameRoot":"WARNO mod","cacheRoot":"private/cache","trackedFiles":{"GameData/private.ndf":"synced"},"trackedContributors":{"GameData/private.ndf":[{"modId":"example","patchId":"health"}]}});
        let doctor = ui.report(&data, false);
        assert!(doctor.contains("WARNO mod") && doctor.contains("synced"));
        assert!(!doctor.contains("private/cache") && !doctor.contains("GameData/private.ndf"));
        assert!(ui.report(&data, true).contains("example:health"));
        let skipped = ui.report(&serde_json::json!({"warnings":[{"code":"W2","reason":"An optional patch could not run.","modName":"Example project","patchId":"hud","cause":"Missing input CommonData/Hud.ndf"}]}), false);
        assert!(skipped.contains("Example project: hud") && skipped.contains("CommonData/Hud.ndf"));
        let conflict = conflict.with("conflictPreviewPath", "preview/comparison");
        assert!(ui.error(&conflict, false).contains("preview/comparison"));
    }
    #[test]
    fn input_frames_separate_prompts_and_clear_the_background() {
        let ui = Ui {
            rich: true,
            color: true,
            width: 79,
        };
        assert!(
            ui.input_start("Command")
                .starts_with("\x1b[0m\n\x1b[30;46m")
        );
        assert_eq!(ui.input_end(), "\x1b[0m\x1b[K");
        let plain = Ui { color: false, ..ui };
        assert_eq!(plain.input_start("Command"), "\n  Command: ");
        assert_eq!(plain.input_end(), "");
    }
    #[test]
    fn reports_end_with_the_outcome_and_finding_counts() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 79,
        };
        let report = ui.report(&serde_json::json!({
            "summary":"Built 2 output files.",
            "outputs":[{"targetRelativePath":"GameData/A.ndf","state":"present","bytes":1},{"targetRelativePath":"GameData/Z.ndf","state":"present","bytes":2}],
            "notices":[{"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf"},{"code":"E19","reason":"Removal target is already absent.","path":"GameData/Z.ndf"}],
            "warnings":[{"code":"W1","reason":"Selection filters matched no projects or patches."}]
        }), true);
        let summary = report.find("[I1] Built 2 output files.").unwrap();
        assert!(summary > report.rfind("GameData/Z.ndf").unwrap());
        assert_eq!(report.matches("[I1] Built 2 output files.").count(), 1);
        assert!(report.contains("2 errors / 1 warning"));
        let empty = ui.report(
            &serde_json::json!({"summary":"Restored 0 tracked files.","files":[]}),
            false,
        );
        assert!(empty.contains("[I1] Restored 0 tracked files."));
        assert!(!empty.contains("Findings"));
    }
    #[test]
    fn confirmation_paths_are_readable_inside_wrapped_messages() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 79,
        };
        let local = ui.block(
            "    - ",
            r"Build this selection and replace the preview at \\?\D:\SteamLibrary\steamapps\common\WARNO\Mods\YSM\YMB\.ymb\build\output.",
            Tone::Strong,
        );
        let network = ui.block(
            "    - ",
            r"Apply its files and removals to \\?\UNC\server\WARNO Mods\YSM. Save originals for recovery.",
            Tone::Strong,
        );
        assert!(
            local.contains(
                r"D:\SteamLibrary\steamapps\common\WARNO\Mods\YSM\YMB\.ymb\build\output."
            )
        );
        assert!(network.contains(r"\\server\WARNO Mods\YSM"));
        for output in [local, network] {
            assert!(!output.contains(r"\\?\"));
            assert!(output.starts_with("    - "));
            assert!(
                output
                    .lines()
                    .skip(1)
                    .all(|line| line.starts_with("      "))
            );
            assert!(output.lines().all(|line| line.chars().count() <= ui.width));
        }
    }
    #[test]
    fn option_columns_align_across_groups() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 88,
        };
        let preferences = ui.rows(
            &[("B", "projects", "all projects"), ("C", "scope", "normal")],
            Tone::Accent,
        );
        let lines: Vec<_> = preferences.lines().collect();
        assert_eq!(lines[0].find("all projects"), lines[1].find("normal"));
        assert!(lines[1].starts_with("  [C] scope"));
        let build = ui.rows(&[("1", "build", "Save a preview")], Tone::Muted);
        let description_column = build.find("Save a preview");
        assert_eq!(build.find("build"), lines[1].find("scope"));
        assert_eq!(build.find("Save a preview"), lines[1].find("normal"));
        assert_eq!(
            ui.label("Preview", "saved output").find("saved output"),
            lines[1].find("normal")
        );
        let commands = [
            ("5", "list"),
            ("6", "explain"),
            ("7", "find"),
            ("8", "doctor"),
            ("9", "init"),
            ("A", "cleanup"),
        ];
        let actions = ui.actions(&commands);
        let lines: Vec<_> = actions.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].find("list"), Some(6));
        assert_eq!(lines[0].find("[6]"), Some(17));
        assert_eq!(lines[0].find("[6]"), description_column);
        for (first, second) in [("[5]", "[8]"), ("[6]", "[9]"), ("[7]", "[A]")] {
            assert_eq!(lines[0].find(first), lines[1].find(second));
        }
        assert_eq!(lines[0].find("list"), lines[1].find("doctor"));
        let build = ui.actions(&[("1", "run"), ("2", "build")]);
        assert_eq!(build.find("[2]"), lines[0].find("[6]"));
        let footer = ui.actions(&[("E", "settings"), ("H", "help"), ("0", "exit")]);
        assert!(footer.contains("settings   [H]"));
        assert_eq!(footer.find("[H]"), lines[0].find("[6]"));
        assert_eq!(footer.find("settings"), lines[0].find("list"));
        let project = ui.rows(&[("1", "ExampleModId", "Example project")], Tone::Muted);
        assert!(project.contains("ExampleModId"));
        for width in [32, 44, 88] {
            let ui = Ui { width, ..ui };
            let actions = ui.actions(&commands);
            for (key, name) in commands {
                assert_eq!(actions.matches(&format!("[{key}]")).count(), 1);
                assert!(actions.contains(name));
            }
            assert!(
                actions
                    .lines()
                    .all(|line| line.starts_with("  ") && line.chars().count() <= width)
            );
        }
    }
    #[test]
    fn progress_keeps_the_plan_around_the_current_step() {
        let ui = Ui {
            rich: true,
            color: false,
            width: 44,
        };
        let view = ProgressView {
            steps: vec![
                "Prepare".into(),
                "Build".into(),
                "Validate".into(),
                "Save".into(),
            ],
            current: 2,
            detail: "Checking files".into(),
            completed: [0, 1].into_iter().collect(),
            failed: Default::default(),
        };
        let lines = view.lines(&ui, Duration::from_secs(65), 0);
        let text = lines.join("\n");
        assert!(text.contains("[3/4]  Elapsed 01:05"));
        assert!(text.find("[OK] Build").unwrap() < text.find("[/] Validate").unwrap());
        assert!(text.find("[/] Validate").unwrap() < text.find("[ ] Save").unwrap());
        assert!(lines.iter().all(|line| line.chars().count() <= ui.width));
    }
    #[test]
    fn progress_never_marks_unvisited_or_failed_stages_complete_and_resets_retries() {
        let mut view = ProgressView {
            steps: ["Check", "Unvisited", "Build", "Save"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            current: 0,
            detail: String::new(),
            completed: Default::default(),
            failed: Default::default(),
        };
        view.update(ProgressEvent::Step(2));
        assert!(view.completed.contains(&0));
        assert!(!view.completed.contains(&1));
        view.update(ProgressEvent::Failed(2));
        view.update(ProgressEvent::Step(3));
        assert!(!view.completed.contains(&2));
        let text = view.lines(&Ui::plain(79), Duration::ZERO, 0).join("\n");
        assert!(text.contains("[ ] Unvisited"));
        assert!(text.contains("[!] Build"));
        assert!(!text.contains("[OK] Build"));
        view.update(ProgressEvent::Step(1));
        assert!(view.failed.is_empty());
        assert_eq!(view.completed, [0].into_iter().collect());
        view.update(ProgressEvent::Extend(vec!["Discovered work".into()]));
        assert_eq!(view.steps.len(), 5);
        assert_eq!(view.current, 1);
        view.update(ProgressEvent::Step(99));
        assert_eq!(view.current, 1);
    }
    #[test]
    fn long_labels_keep_wrapped_values_aligned_and_inside_the_terminal() {
        let ui = Ui::plain(44);
        let text = ui.label(
            "A longer label",
            "A value that wraps over several lines in a narrow terminal.",
        );
        assert!(text.lines().count() > 1);
        assert!(text.lines().all(|line| line.chars().count() <= ui.width));
        let first = text.lines().next().unwrap().find("A value").unwrap();
        assert!(text.lines().skip(1).all(|line| {
            line.chars()
                .take_while(|character| *character == ' ')
                .count()
                == first
        }));
    }
    #[test]
    fn grouped_errors_show_every_target_with_one_message() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 88,
        };
        let report = ui.report(&serde_json::json!({"notices":[
            {"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf","selector":{"value":"OldA"},"patchConfigPath":"patch.yaml","operationLine":12},
            {"code":"E19","reason":"Removal target is already absent.","path":"GameData/A.ndf","selector":{"value":"OldB"},"patchConfigPath":"patch.yaml","operationLine":15}
        ]}), true);
        assert_eq!(
            report
                .matches("[E19] Removal target is already absent.")
                .count(),
            1
        );
        for text in ["OldA", "OldB", "patch.yaml:12", "patch.yaml:15"] {
            assert!(report.contains(text));
        }
        for width in [44, 72, 100] {
            let ui = Ui { width, ..ui };
            for line in [
                ui.rows(&[("A", "cleanup", "Remove temporary files")], Tone::Muted),
                ui.rows(&[("B", "projects", "all projects")], Tone::Accent),
            ] {
                assert!(
                    line.lines()
                        .all(|line| line.starts_with("  ") && line.chars().count() <= width)
                );
            }
        }
    }
    #[test]
    fn help_keeps_options_together_and_aligns_their_margin() {
        let help =
            help("Options:\n      --json  JSON\n\n  --mod <ID>  Project\n  -h, --help  Help\n");
        assert!(!help.contains("JSON\n\n"));
        assert!(
            help.lines()
                .filter(|line| line.contains("--"))
                .all(|line| line.starts_with("    -") && !line.starts_with("     "))
        );
        assert_eq!(
            wrap("review this preview before syncing", 19),
            ["review this preview", "before syncing"]
        );
        let ui = Ui {
            rich: false,
            color: false,
            width: 44,
        };
        let error = Diagnostic::new(
            "TestError",
            "A long message that must wrap while preserving the margin on every line.",
            "Review the input.",
        )
        .at(format!("config/{}.yaml", "long-path".repeat(12)));
        assert!(
            ui.error(&error, false)
                .lines()
                .filter(|line| !line.is_empty())
                .all(|line| line.starts_with("  ") && line.chars().count() <= ui.width)
        );
    }
    #[test]
    fn plain_reports_keep_results_actionable_without_terminal_controls() {
        let ui = Ui {
            rich: false,
            color: false,
            width: 72,
        };
        let report = ui.report(&serde_json::json!({"summary":"Ready","outputs":[{"targetRelativePath":"GameData/A.ndf","state":"present","bytes":1024}],"tests":[]}), true);
        assert!(report.contains("GameData/A.ndf") && report.contains("1.0 KiB"));
        assert!(!report.contains('\x1b'));
        let error = Diagnostic::new("TestError", "Bad \x1b[31minput", "Correct the input.")
            .at("config/test.yaml");
        let rendered = ui.error(&error, false);
        assert!(rendered.contains("config/test.yaml") && rendered.contains("Correct the input."));
        assert!(!rendered.contains('\x1b'));
        assert_eq!(clean(r"\\?\D:\YMB"), r"D:\YMB");
        assert_eq!(clean(r"\\?\UNC\server\YMB"), r"\\server\YMB");
        let wrapped = ui.label("Settings", &"a".repeat(150));
        assert!(wrapped.lines().all(|line| line.chars().count() < ui.width));
        assert_eq!(wrapped.matches('a').count(), 150);
        assert_eq!(size(1024 * 1024 * 1024), "1.0 GiB");
    }
}
