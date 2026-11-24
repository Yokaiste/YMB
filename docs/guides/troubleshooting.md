# Find and fix a failed change

[All documentation](../README.md#everyday-tasks)

| Previous | You are here | Next |
| --- | --- | --- |
| [Update, undo, and clean up](update-and-recover.md) | Guides · 3/3 · Find and fix a failed change | [Documentation](../README.md) |

[Changed files since sync](#changed-files-since-sync) · [NDF syntax errors](#ndf-syntax-errors) · [Interrupted operations](#interrupted-operations) · [Report a YMB problem](#report-a-ymb-problem)

Start with the failing stage. A perfect preview cannot rescue a compile step that never ran.

| What you see | Check first |
| --- | --- |
| YMB will not start | Executable location and command arguments |
| Build reports a failure | Named configuration, selector, or generator |
| Sync refuses a file | External edits and saved-original status |
| WARNO compilation fails | The compiler's type, reference, or resource diagnostic |
| Game still looks unchanged | Successful sync, successful compile, enabled mod, correct unit variant |

Read the reason, suggested fix, and source location. A run can report several independent failures at once. Fix the authored project files and build again.

| Problem                          | Next step                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Project missing from the list    | Check `mods/<project>/config/ymb.mod.yaml` and run `doctor`                                  |
| Patch excluded                   | Run `explain` with the same filters                                                          |
| YAML won't parse                 | Check indentation, colons, and tabs                                                          |
| Selector matches nothing         | Use `find --file <target> --name <part>` and correct the selector                            |
| Selector matches several objects | Use a more specific name, type, or field match                                               |
| NDF syntax error                 | Read the excerpt and fix the source patch, replacement, or generator                         |
| Conflicting output               | Check the named contributors and [layering rules](../learn/06-combine-projects.md#add-a-second-project) |
| Backup missing or damaged        | Restore it from a trusted backup before recovery or sync                                     |
| Optional feature missing         | Run `build --require-all` to expose the underlying failure                                   |

### Changed files since sync

`doctor` distinguishes two states:

- A file is back to its saved original. YMB can apply its changes again.
- A file contains unrecognized edits. Sync stops so it does not overwrite them.

Preserve any manual changes you need in your project or elsewhere first. Then, if you intend to discard the changed tracked files:

```text
.\YMB.exe sync --mod first_mod --yes --reset-changed
```

`recover --yes --reset-changed` discards the edits and restores originals without applying a new build. The flag cannot be combined with `--dry-run`. It is a discard instruction, not a stronger troubleshooting button.

### NDF syntax errors

The starter welcome-screen patch contains a `MagnifiableWidthHeight` list. Its two dimensions need a comma:

```ndf
// Broken:
MagnifiableWidthHeight = [1500.0 90.0]

// Correct:
MagnifiableWidthHeight = [1500.0, 90.0]
```

Check unfinished assignments, missing commas between list entries, and unclosed quotes or comments. The error location refers to the NDF being checked, which may be generated output. Use the listed contributor to find what to edit.

A failed output syntax check leaves game files and authored identities unchanged. A real build has already cleared its old preview; validation and dry runs keep that preview. Staged authored writes are discarded when the operation fails. Syntax checks cannot verify every WARNO type, reference, or gameplay rule.

### Interrupted operations

YMB records protected writes so it can roll back an interrupted operation. If it reports a rollback, read the affected paths before retrying. Do not delete state or lock folders while a YMB command is running. For damaged recovery records, see [advanced recovery](../advanced/composition.md#what-recovery-protects).

### Report a YMB problem

Use [YSM Community Discord](https://discord.gg/33Sqn6dTjf) for help, feedback, and bug reports. Post build failures and bugs in its troubleshooting forum.

Include the YMB version, exact command, error output, expected result, and the smallest project that reproduces it. For a mod-specific problem, include the mod's name and version too. Check logs for personal paths before posting. An AI assistant can draft that report for you.

| Previous | You are here | Next |
| --- | --- | --- |
| [Update, undo, and clean up](update-and-recover.md) | Guides · 3/3 · Find and fix a failed change | [Documentation](../README.md) |
