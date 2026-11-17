use super::*;
#[test]
fn oversized_journals_never_replace_readable_recovery_metadata() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["YMB", "GameData", "CommonData"] {
        fs::create_dir(temp.path().join(name)).unwrap();
    }
    let context = Context::resolve(Some(&temp.path().join("YMB"))).unwrap();
    let large = "x".repeat(MAX_METADATA_BYTES + 1);
    assert!(Transaction::begin(&context, &large).is_err());
    assert!(!context.journal.exists());
    let mut transaction = Transaction::begin(&context, "test").unwrap();
    let path = context.journal.join("transaction.json");
    let previous = fs::read(&path).unwrap();
    transaction.journal.command = large;
    assert_eq!(transaction.save().unwrap_err().code.as_deref(), Some("E26"));
    assert_eq!(fs::read(&path).unwrap(), previous);
    transaction.journal.command = "test".into();
    transaction.rollback().unwrap();
    assert!(!context.journal.exists());
}
