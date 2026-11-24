use clap::{
    Arg, Command,
    error::{ContextKind, ContextValue, ErrorKind},
};
use std::ffi::OsString;
use ymb_core::{Diagnostic, Result};

pub fn split(input: &str) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if quote == Some(ch) {
            if chars.peek() == Some(&ch) {
                word.push(chars.next().unwrap());
            } else {
                quote = None;
            }
        } else if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
            started = true;
        } else if quote.is_none() && ch.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            word.push(ch);
            started = true;
        }
    }
    if quote.is_some() {
        return Err(Diagnostic::new(
            "CommandError",
            crate::messages::text("arguments.split.a_quoted_argument_is_not_closed"),
            crate::messages::text("arguments.split.close_the_matching_single_or_double_quote"),
        ));
    }
    if started {
        args.push(word);
    }
    Ok(args)
}

pub fn suggest(
    mut error: Box<Diagnostic>,
    input: &str,
    candidates: impl IntoIterator<Item = impl AsRef<str>>,
) -> Box<Diagnostic> {
    let query = input.trim_start_matches('-').to_ascii_lowercase();
    let mut matches = Vec::new();
    if !query.is_empty() {
        for candidate in candidates {
            let candidate = candidate.as_ref();
            let name = candidate.trim_start_matches('-').to_ascii_lowercase();
            if query.chars().count() > name.chars().count().saturating_mul(2) {
                continue;
            }
            let score = strsim::normalized_damerau_levenshtein(&query, &name);
            if name.contains(&query) || query.len() >= 3 && score >= 0.5 {
                matches.push((
                    candidate.to_owned(),
                    score + f64::from(name.starts_with(&query)),
                ));
            }
        }
    }
    matches.sort_by(|(a, left), (b, right)| right.total_cmp(left).then_with(|| a.cmp(b)));
    matches.dedup_by(|(a, _), (b, _)| a == b);
    let suggestions: Vec<_> = matches.into_iter().map(|(name, _)| name).collect();
    if !suggestions.is_empty() {
        error.suggestion = crate::messages::format(
            "arguments.suggest.did_you_mean_arg0",
            &[(
                "ARG0",
                suggestions
                    .iter()
                    .map(|name| format!("'{name}'"))
                    .collect::<Vec<_>>()
                    .join(", ")
                    .to_string(),
            )],
        );
    }
    error.with("input", input).with("suggestions", suggestions)
}

pub fn menu_parser(mut command: Command, choices: &[(&str, &str, &str)]) -> Command {
    command = command.disable_help_subcommand(true);
    for (key, name, _) in choices {
        if command.find_subcommand(name).is_none() {
            command = command.subcommand(Command::new(name.to_string()));
        }
        command = command.mut_subcommand(name, |subcommand| {
            let mut aliases = vec![
                key.to_ascii_lowercase(),
                key.to_string(),
                format!("[{key}]"),
                format!("[{}]", key.to_ascii_lowercase()),
                name.to_ascii_uppercase(),
            ];
            aliases.sort();
            aliases.dedup();
            subcommand.aliases(aliases)
        });
    }
    command
}

fn long_arg<'a>(command: &'a Command, name: &str) -> Option<&'a Arg> {
    let mut matches = command
        .get_arguments()
        .filter(|arg| arg.get_long().is_some_and(|long| long.starts_with(name)));
    command
        .get_arguments()
        .find(|arg| arg.get_long() == Some(name))
        .or_else(|| {
            let first = matches.next()?;
            matches.next().is_none().then_some(first)
        })
}

pub fn flag_requested(mut command: Command, args: &[OsString], id: &str) -> bool {
    command.build();
    args.iter()
        .skip(1)
        .take_while(|arg| *arg != "--")
        .any(|token| {
            let Some(token) = token.to_str() else {
                return false;
            };
            if let Some(name) = token.strip_prefix("--") {
                return long_arg(&command, name.split('=').next().unwrap())
                    .is_some_and(|arg| arg.get_id() == id && !arg.get_action().takes_values());
            }
            if let Some(shorts) = token.strip_prefix('-') {
                for short in shorts.chars() {
                    let Some(arg) = command
                        .get_arguments()
                        .find(|arg| arg.get_short() == Some(short))
                    else {
                        return false;
                    };
                    if arg.get_action().takes_values() {
                        return false;
                    }
                    if arg.get_id() == id {
                        return true;
                    }
                }
            }
            false
        })
}

fn scope<'a>(command: &'a Command, args: &[OsString]) -> &'a Command {
    let mut active = command;
    let mut args = args.iter().skip(1);
    while let Some(token) = args.next() {
        let Some(token) = token.to_str() else { break };
        if token == "--" {
            break;
        }
        if let Some(option) = token.strip_prefix("--") {
            let (name, value) = option
                .split_once('=')
                .map_or((option, None), |(name, value)| (name, Some(value)));
            let Some(arg) = long_arg(active, name) else {
                break;
            };
            if value.is_none() && arg.get_action().takes_values() {
                args.next();
            }
        } else if let Some(shorts) = token.strip_prefix('-').filter(|s| !s.is_empty()) {
            let mut shorts = shorts.chars().peekable();
            while let Some(short) = shorts.next() {
                let Some(arg) = active
                    .get_arguments()
                    .find(|arg| arg.get_short() == Some(short))
                else {
                    return active;
                };
                if arg.get_action().takes_values() {
                    if shorts.peek().is_none() {
                        args.next();
                    }
                    break;
                }
            }
        } else {
            let mut matches = active.get_subcommands().filter(|sub| {
                sub.get_name().starts_with(token)
                    || sub.get_all_aliases().any(|alias| alias.starts_with(token))
            });
            let sub = active.find_subcommand(token).or_else(|| {
                let first = matches.next()?;
                matches.next().is_none().then_some(first)
            });
            let Some(sub) = sub else { break };
            active = sub;
        }
    }
    active
}

pub fn diagnostic(error: &clap::Error, mut command: Command, args: &[OsString]) -> Box<Diagnostic> {
    let text = error.to_string();
    let diagnostic = Diagnostic::new(
        "CommandError",
        text.lines()
            .next()
            .unwrap_or(crate::messages::text(
                "arguments.diagnostic.invalid_command_arguments",
            ))
            .trim_start_matches("error: "),
        crate::messages::format(
            "arguments.diagnostic.run_arg0_help_for_available_commands_and",
            &[("ARG0", command.get_name().to_string())],
        ),
    )
    .detail(&text);
    command.build();
    let active = scope(&command, args);
    let (input, candidates) = match error.kind() {
        ErrorKind::InvalidSubcommand => (
            error.get(ContextKind::InvalidSubcommand),
            active
                .get_subcommands()
                .filter(|sub| !sub.is_hide_set())
                .map(|sub| sub.get_name().to_owned())
                .collect::<Vec<_>>(),
        ),
        ErrorKind::UnknownArgument => (
            error.get(ContextKind::InvalidArg),
            active
                .get_arguments()
                .filter(|arg| !arg.is_hide_set())
                .flat_map(|arg| {
                    arg.get_long()
                        .map(|long| format!("--{long}"))
                        .into_iter()
                        .chain(arg.get_short().map(|short| format!("-{short}")))
                })
                .collect(),
        ),
        ErrorKind::InvalidValue => (
            error.get(ContextKind::InvalidValue),
            match error.get(ContextKind::ValidValue) {
                Some(ContextValue::Strings(values)) => values.clone(),
                _ => Vec::new(),
            },
        ),
        _ => (None, Vec::new()),
    };
    match input {
        Some(ContextValue::String(input)) => suggest(diagnostic, input, candidates),
        _ => diagnostic,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_arguments_preserve_quotes_empty_values_and_windows_paths() {
        assert_eq!(
            split(r#"init --name "My mod" --description '' --id='a b' --ymb-path "D:\My mods\""#)
                .unwrap(),
            [
                "init",
                "--name",
                "My mod",
                "--description",
                "",
                "--id=a b",
                "--ymb-path",
                "D:\\My mods\\"
            ]
        );
        assert_eq!(
            split("--name 'Bob''s mod'").unwrap(),
            ["--name", "Bob's mod"]
        );
        assert!(split("build --mod 'unfinished").is_err());
    }

    #[test]
    fn suggestions_are_ranked_deduplicated_and_exclude_unrelated_names() {
        let error = suggest(
            Diagnostic::new("CommandError", "Invalid", "Use help."),
            "buil",
            ["rebuild", "build", "doctor", "builder", "build"],
        );
        assert_eq!(
            error.context["suggestions"],
            serde_json::json!(["build", "builder", "rebuild"])
        );
        assert!(error.suggestion.starts_with("Did you mean"));
        let error = suggest(error, "zzzz", ["build", "doctor"]);
        assert_eq!(error.context["suggestions"], serde_json::json!([]));
        let error = suggest(error, &"x".repeat(100_000), ["build", "doctor"]);
        assert_eq!(error.context["suggestions"], serde_json::json!([]));
    }
}
