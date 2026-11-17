# Advanced: use YMB from scripts and AI tools

[All documentation](../README.md#advanced)

| Previous | You are here | Next |
| --- | --- | --- |
| [Advanced workflows](../README.md#advanced) | Advanced · Scripts and AI tools | [Commands and JSON reference](../references/commands.md) |

[The JSON contract](#the-json-contract)

This page is for people writing scripts or configuring AI tools. It assumes basic PowerShell and JSON knowledge. For everyday use, [build and apply through the CLI or menu](../guides/build-and-play.md).

Add --json for automation and AI agents. Stdout contains one JSON document, without human progress or prompts. Check both the exit status and status field. Exit status 0 means success, 1 an execution failure, and 2 invalid command arguments.

From PowerShell inside YMB:

~~~powershell
$result = & .\YMB.exe build --mod first_mod --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $result.status -ne 'ok' -or $result.diagnosticCounts.error -gt 0) {
    $result.diagnostics | ConvertTo-Json -Depth 20
    exit 1
}
$result.data.outputs | Select-Object targetRelativePath, sourceType
~~~

### The JSON contract

| Field | Meaning |
| --- | --- |
| schemaVersion | JSON contract version, currently 4 |
| ymbVersion | Application version derived from root Cargo.toml |
| command, status | Requested command and ok/error outcome |
| durationMs, selection | Timing and options for executed commands |
| data | Successful command results |
| errors | Structured execution failures |
| formats | Configuration, plugin, cache, state, and journal versions |
| sourceCompilerRequirement | Compiler requirement for editing source |

Use ids, categories, paths, and numbers for decisions. Reasons and suggestions are display text; their wording can change. Ignore unfamiliar additive fields. Help and argument errors include text rather than a command data object.

Check schemaVersion before interpreting a saved result. See [commands and automation](../references/commands.md#json-contract) for each command's result fields.

NDF diagnostics use a code, 1-based line and column, and 0-based UTF-16 offset. Available sourcePath, operationLine, owner, and related details connect generated errors to authored input. Not every error has every field.

Find still limits returned matches. Compare totalMatches with matches.Count and narrow the query or raise --limit. Verbose does not lift the limit.

Pass --yes explicitly for unattended writes after authorizing the action. Launcher failures before the executable starts may return ordinary text; handle failed JSON parsing as a launch failure.

A command can finish with `status: ok` and still report ineffective operations as error findings. Decide explicitly whether your script permits those findings. Do not parse jokes, progress lines, or summary wording to make that decision.

| Previous | You are here | Next |
| --- | --- | --- |
| [Advanced workflows](../README.md#advanced) | Advanced · Scripts and AI tools | [Commands and JSON reference](../references/commands.md) |
