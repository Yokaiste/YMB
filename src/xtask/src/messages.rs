use std::sync::LazyLock;
use ymb_core::resources::Catalog;

static MESSAGES: LazyLock<Catalog> = LazyLock::new(|| {
    Catalog::new(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/messages/en/development.json"
    )))
});

pub fn text(key: &str) -> &'static str {
    MESSAGES.text(key)
}

pub fn format(key: &str, values: &[(&str, String)]) -> String {
    MESSAGES.format(key, values)
}
