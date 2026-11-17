# Errors, warnings, and message codes

[All documentation](../README.md#reference)

| Previous | You are here | Next |
| --- | --- | --- |
| [Commands and JSON output](commands.md) | Reference · 6/7 · Errors, warnings, and message codes | [Executable plugin protocol](plugin-protocol.md) |

[Errors](#errors) · [Warnings](#warnings) · [Information](#information) · [JSON dictionary](#json-dictionary)

Messages start with a stable code: `[W9] Removal target is already absent.`

| Prefix | Meaning |
| --- | --- |
| E | Error |
| W | Warning |
| I | Information |

Numbers identify conditions even when wording changes. Retired numbers stay retired.

Tolerated no-ops are warnings in a successful build. Intentional no-ops declared with `allowNoChange` are informational. A generator can require its rules to change data and fail on an unexpected no-op; that failure remains an error.

Failed or cancelled commands return exit code 1; invalid CLI arguments return 2. Warnings do not undo completed work.

## Read a diagnostic

Normal reports show up to five grouped messages and the outcome. Repeats include counts. Use --verbose or [D] for every message and target; JSON always includes the full dictionary and target lists.

A target can identify the game file, selector, project, patch, generator, operation, and source config location. Screen operation numbers start at 1; JSON `operationIndex` starts at 0. Intentional no-ops declared with `allowNoChange` use `I4`.

## Errors

| Code | Condition | What to do |
| --- | --- | --- |
| E1 | Invalid command arguments or project selection | Follow the message or run `ymb --help`. |
| E2 | No command matches the input | Type a listed shortcut or command name. |
| E3 | A command prefix matches several commands | Type more letters or use its listed shortcut. |
| E4 | Invalid configuration or unsupported settings | Fix the named configuration and location. |
| E5 | Invalid YAML syntax | Fix indentation, quoting or syntax at the reported line. |
| E6 | Unsupported configuration version | Use the required format or a compatible builder. |
| E7 | Invalid installation layout or configured roots | Correct the paths; keep recovery data. |
| E8 | Required input is missing | Restore the named file or correct its path. |
| E9 | Input exceeds its size limit | Reduce the input or use the documented limit. |
| E10 | A filesystem operation failed | Check the path, permissions and free space. |
| E11 | Recovery records, saved originals or transaction state cannot be used safely | Keep the recovery files and follow the reported fix. |
| E12 | A tracked live file has external edits | Save those edits before using `--reset-changed`. |
| E13 | A path changed while it was being checked | Stop the other writer and retry. |
| E14 | Invalid NDF syntax | Correct the named source and location. |
| E15 | An invalid or unsupported selector | Correct its kind, path or match conditions. |
| E16 | An NDF selector found no target | Check the selector against the current game data. |
| E17 | An NDF selector found multiple targets | Make the selector more specific. |
| E18 | A generator requires an operation to change data, but it changed nothing | Review its rules or declare an intentional no-op where the generator permits it. |
| E19 | A generator requires a removal target that is already absent | Review the generator's required targets. |
| E20 | Retired; tolerated empty file removals now use W10 | Read W10. |
| E21 | Contributions conflict or sync would erase an excluded contributor | Include the listed contributors or recover shared files before changing the selection. For conflicting edits, compare the saved files and fix ordering or ownership. |
| E22 | A generator failed, returned invalid output or cannot start | Follow the generator diagnostic. |
| E23 | A generator exceeded its run time limit | Fix the stalled work or adjust a measured timeout. |
| E24 | Generator compilation exceeded its time limit | Check compiler work and dependency downloads. |
| E25 | Invalid generator protocol data | Rebuild the generator with a compatible SDK. |
| E26 | Recovery metadata exceeds its supported size | Preserve recovery data and reduce the operation. |
| E27 | Text comparison exceeded its work budget | Reduce conflicting edits or declare deliberate layering. |
| E28 | Template expansion exceeded its memory budget | Reduce expansion or its input data. |
| E30 | The cache cannot be used safely | Follow the message; derived cache data can be rebuilt. |
| E31 | A deployment or package check failed | Keep the existing installation and fix the reported problem. |
| E32 | A development command failed | Read its output and exit code, fix it, then retry. |
| E33 | A generator check failed | Fix the generator or the input it checks. |
| E34 | An NDF scan starts at an invalid byte offset | Correct the caller's source boundary. |
| E35 | An NDF block comment is not closed | Close the comment at the named source location. |
| E36 | An NDF string is not closed | Correct the quote or escape at the named location. |
| E37 | An error with no built-in category | Use its category, details and suggested fix. |
| E38 | A compatible Rust toolchain is required | Choose Install Rust, run `install-rust`, or repeat with `--install-rust`. |
| E39 | Automatic Rust installation failed | Retry or follow the manual installation guide. |

## Warnings

| Code | Condition | What to do |
| --- | --- | --- |
| W1 | A selection filter matched nothing | Check each listed filter and the selected scope. |
| W2 | An optional patch was skipped | Read its cause; `--require-all` requires every patch. |
| W3 | A saved override refers to an unknown patch | Correct or remove the override when appropriate. |
| W4 | External edits to a tracked file will be reset | Keep an external copy before accepting the command. |
| W5 | Recovery restores a whole file shared by contributors | Review the affected files before accepting recovery. |
| W6 | Cached data was ignored, discarded or unavailable | YMB rebuilds derived results; investigate repeated failures. |
| W7 | Another warning from a supported producer | Read the message and its target context. |
| W8 | An operation unexpectedly changed nothing | Review it; declare `allowNoChange` only when intentional. |
| W9 | A removal target is already absent | Review each listed selector and its patch location. |
| W10 | A file removal matches no files | Correct the path or remove the redundant operation. |

## Information

| Code | Condition |
| --- | --- |
| I1 | A command completed; its summary states the result. |
| I2 | The user cancelled before work started. |
| I3 | Terminal input was closed. |
| I4 | A declared intentional no-change operation. |
| I5 | A generator's informational message. |
| I6 | An interrupted operation was rolled back before this command. |
| I7 | Another informational message, such as an empty project list. |
| I8 | Command help was requested. |
| I9 | Version information was requested. |
| I10 | Output files are prepared for writing. This alone does not mean they were applied. |
| I11 | Output files are prepared for removal. This alone does not mean they were removed. |

## JSON dictionary

JSON schema version 4 adds `diagnostics` and `diagnosticCounts` to the envelope.
Existing command data, warnings, notices and errors remain available. Diagnostic
`code` fields now use the numeric identifiers above.

| Level | Fields |
| --- | --- |
| Code entry | `severity`, occurrence `count`, `messages` |
| Message | Exact text, occurrence `count`, unique `targets`, unique `suggestions` |
| Target | Available metadata, including selector and config locations |

Different wordings under one code stay in separate message groups. The compact terminal view hides no targets or sources from JSON.

```json
{
  "diagnosticCounts": { "error": 0, "warning": 2, "info": 0 },
  "diagnostics": {
    "W9": {
      "severity": "warning",
      "count": 2,
      "messages": [
        {
          "message": "Removal target is already absent.",
          "count": 2,
          "targets": [
            {
              "path": "GameData/Example.ndf",
              "selector": { "kind": "object", "by": "name", "value": "OldA" },
              "modId": "example",
              "patchId": "cleanup",
              "operationIndex": 0,
              "patchConfigPath": "mods/example/config/patch/cleanup/ymb.patch.yaml",
              "operationLine": 12
            },
            {
              "path": "GameData/Example.ndf",
              "selector": { "kind": "object", "by": "name", "value": "OldB" },
              "modId": "example",
              "patchId": "cleanup",
              "operationIndex": 1,
              "patchConfigPath": "mods/example/config/patch/cleanup/ymb.patch.yaml",
              "operationLine": 17
            }
          ],
          "suggestions": [
            "Check whether this operation is still needed for the current game data."
          ]
        }
      ]
    }
  }
}
```

Read `diagnostics.W9.messages[].targets[]` to handle absent removal targets.
An absent key means that condition was not reported. Count occurrences with
`count`; a repeated identical target appears once in `targets`.


| Previous | You are here | Next |
| --- | --- | --- |
| [Commands and JSON output](commands.md) | Reference · 6/7 · Errors, warnings, and message codes | [Executable plugin protocol](plugin-protocol.md) |
