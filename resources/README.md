# Resources

`examples/` holds the starter projects offered by `init`. Each folder is copied as a whole, including hidden files and empty folders. Edit a starter here to change future projects; existing projects keep their files.

With one starter, `init` uses it automatically. Add another folder to offer a choice, or select one with `--example NAME`. With no starters, `init` fails.

Text files support these placeholders:

| Placeholder | Value |
| --- | --- |
| `@PROJECT_ID@`, `@PROJECT_NAME@`, `@PROJECT_DESCRIPTION@` | Project details as plain text |
| `@ID@`, `@NAME@`, `@DESCRIPTION@` | The same details, quoted for YAML |
| `@FORMAT@`, `@REQUIRES@`, `@RELEASE_VERSION@` | Current format and YMB versions |
| `@TITLE@`, `@DETAIL@`, `@SAFE_ID@` | Stable welcome-screen identities |
| `@REPOSITORY@` | YMB's repository URL |

Use `@@` for a literal `@`. Binary files are copied unchanged. Text files over 16 MiB are copied without substitution.

`messages/en/` groups English text by component: shared tools, SDK, YMB, and development commands. Keep keys and named placeholders when translating. Counted messages use `one` and `other` variants. Executable messages take effect after rebuilding; the bundled language is currently English.
