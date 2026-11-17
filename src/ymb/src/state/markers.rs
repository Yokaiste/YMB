use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Marker {
    pub(super) marker_id: String,
    pub(super) marker_hash: String,
    pub(super) builder_id: String,
    pub(super) contributors: Vec<Contributor>,
}
pub fn comment_style(path: &str) -> Option<(&'static str, &'static str)> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "ndf" | "c" | "cc" | "cpp" | "cs" | "h" | "js" | "rs" => Some(("// ", "")),
        "yaml" | "yml" | "py" | "toml" | "sh" => Some(("# ", "")),
        "ini" | "cfg" => Some(("; ", "")),
        "xml" | "html" | "md" => Some(("<!-- ", " -->")),
        _ => None,
    }
}
pub fn marked_bytes(
    content: &[u8],
    path: &str,
    contributors: &[Contributor],
    root: &Path,
    preserve: bool,
) -> Result<Vec<u8>> {
    if preserve {
        return Ok(content.to_vec());
    }
    let Some((open, close)) = comment_style(path) else {
        return Ok(content.to_vec());
    };
    let Ok(text) = std::str::from_utf8(content) else {
        return Ok(content.to_vec());
    };
    let marker_hash = hash(content);
    let root = root.to_string_lossy();
    let root = root.strip_prefix(r"\\?\").unwrap_or(&root);
    let marker = Marker {
        marker_id: hash(format!("{path}:{marker_hash}")),
        marker_hash,
        builder_id: hash(root)[..16].into(),
        contributors: contributors.to_vec(),
    };
    let payload = serde_json::to_string(&marker).unwrap();
    let header = format!("{open}YMB-START {payload}{close}\n");
    let footer = format!("{open}YMB-END {payload}{close}\n");
    let separator = usize::from(!text.ends_with('\n'));
    let mut output = Vec::with_capacity(header.len() + content.len() + separator + footer.len());
    output.extend_from_slice(header.as_bytes());
    output.extend_from_slice(content);
    if separator != 0 {
        output.push(b'\n');
    }
    output.extend_from_slice(footer.as_bytes());
    Ok(output)
}
pub fn unwrap_marked<'a>(content: &'a str, path: &str) -> Result<Option<&'a str>> {
    let Some((open, close)) = comment_style(path) else {
        return Ok(None);
    };
    let prefix = format!("{open}YMB-START ");
    if !content.starts_with(&prefix) {
        return Ok(None);
    }
    let first_end = content.find('\n').ok_or_else(|| {
        recovery(
            Path::new(path),
            crate::messages::text(
                "state.markers.unwrap_marked.tracked_marker_header_is_incomplete",
            ),
        )
    })?;
    let first = content[prefix.len()..first_end].trim_end_matches('\r');
    let first = first.strip_suffix(close).unwrap_or(first);
    let marker: Marker = serde_json::from_str(first).map_err(|_| {
        recovery(
            Path::new(path),
            crate::messages::text("state.markers.unwrap_marked.tracked_marker_header_is_invalid"),
        )
    })?;
    let tail = content.trim_end_matches(['\r', '\n']);
    let last_start = tail.rfind('\n').map_or(0, |i| i + 1);
    let end_prefix = format!("{open}YMB-END ");
    let last = tail[last_start..]
        .strip_prefix(&end_prefix)
        .ok_or_else(|| {
            recovery(
                Path::new(path),
                crate::messages::text(
                    "state.markers.unwrap_marked.tracked_marker_footer_is_missing",
                ),
            )
        })?;
    let last = last.strip_suffix(close).unwrap_or(last);
    let last: Marker = serde_json::from_str(last).map_err(|_| {
        recovery(
            Path::new(path),
            crate::messages::text("state.markers.unwrap_marked.tracked_marker_footer_is_invalid"),
        )
    })?;
    if marker != last || !valid_hash(&marker.marker_hash) || !valid_hash(&marker.marker_id) {
        return Err(recovery(
            Path::new(path),
            crate::messages::text(
                "state.markers.unwrap_marked.tracked_marker_headers_do_not_agree",
            ),
        ));
    }
    let with_newline = &content[first_end + 1..last_start];
    let no_newline = with_newline.strip_suffix('\n').unwrap_or(with_newline);
    let variants = [
        with_newline,
        no_newline,
        no_newline.strip_suffix('\r').unwrap_or(no_newline),
    ];
    let intact = variants.iter().any(|text| {
        hash(text) == marker.marker_hash
            && hash(format!("{path}:{}", marker.marker_hash)) == marker.marker_id
    });
    if !intact {
        return Err(recovery(
            Path::new(path),
            crate::messages::text("state.markers.unwrap_marked.tracked_marked_output_has_changed"),
        ));
    }
    Ok(Some(with_newline))
}
