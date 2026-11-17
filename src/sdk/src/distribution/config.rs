pub fn migrate_config(source: &str, version: u64) -> String {
    // shortcut: converts block-style YAML only; use YAML nodes if older flow-style configs need conversion.
    let version_line =
        regex::Regex::new(r"(?m)^version:[ \t]*1([ \t]*(?:#[^\r\n]*)?)(\r?)$").unwrap();
    let source = version_line.replace(source, |c: &regex::Captures| {
        format!("version: {version}{}{}", &c[1], &c[2])
    });
    let mut settings = false;
    source
        .split_inclusive('\n')
        .map(|line| {
            if !line.starts_with(char::is_whitespace)
                && !line.trim_start().starts_with('#')
                && !line.trim().is_empty()
            {
                settings = line.trim() == "settings:"
            }
            if settings {
                for (old, new) in [
                    ("scriptTimeoutSeconds", "generatorTimeoutSeconds"),
                    (
                        "scriptCacheMaxEntriesPerNamespace",
                        "generatorCacheMaxEntriesPerNamespace",
                    ),
                    (
                        "scriptCacheMaxBytesPerNamespace",
                        "generatorCacheMaxBytesPerNamespace",
                    ),
                ] {
                    if let Some(tail) = line.strip_prefix(&format!("  {old}:")) {
                        return format!("  {new}:{tail}");
                    }
                }
            }
            line.to_string()
        })
        .collect()
}
