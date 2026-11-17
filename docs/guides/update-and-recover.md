# Update, undo, and clean up

[All documentation](../README.md#everyday-tasks)

| Previous | You are here | Next |
| --- | --- | --- |
| [Build, apply, and play](build-and-play.md) | Guides · 2/3 · Update, undo, and clean up | [Find and fix a failed change](troubleshooting.md) |

[Undo a sync](#undo-a-sync) · [Free disk space](#free-disk-space) · [After a WARNO update](#after-a-warno-update) · [Update YMB or a mod project](#update-ymb-or-a-mod-project)

Start with `doctor` if you are unsure what is installed. Keep a backup of authored projects, local choices, and recovery records before updating.

## Undo a sync

```text
.\YMB.exe recover --dry-run
.\YMB.exe recover --yes
```

Recovery restores the originals saved before YMB first changed each file. Files created by YMB are removed. Recompile afterwards to update the playable mod.

You can narrow recovery:

```text
.\YMB.exe recover --mod first_mod --dry-run
.\YMB.exe recover --mod first_mod --yes
```

Use `doctor --verbose` to see which projects and patches contributed to each tracked file. Recovery checks every filter before restoring files, so a mistyped id stops the command.

> [!WARNING]
> Recovery works on whole files. If several patches contributed to the same file, selecting one contributor restores that entire file. Build and sync the remaining selection afterwards if you want those other changes back.

Keep `.ymb/state` while any synced output needs recovery. Copies of mod projects do not replace these backups.

## Free disk space

Start with `cleanup --dry-run` to review paths.

| Action | Removes | Keeps |
| --- | --- | --- |
| `cleanup` | Previews, result caches, selected mods' session caches/execution work, declared disposable paths | Compiler work, recovery data, mod `config/.ymb/`, paths marked `unsafeToRemove` |
| `cleanup --all` | Also selected mods' session compiler work and recovery data; refuses while tracked files need originals | Mod persistent storage |
| `Dev.bat clean` in a source checkout | Builder compilation and all mod session work | Mod persistent storage |

### Before resetting `.ymb`

> [!WARNING]
> Deleting builder `.ymb` removes local overrides and recovery records along with caches. It does not undo synced files. Recover first if you need the originals, or refresh WARNO mod data before rebuilding. Close YMB before deleting the folder.

The installed executable, SDK, root defaults, and projects stay usable. A source checkout can rebuild its disposable executable with `Dev.bat build`.

<details>
<summary>How previews, generators, and caches are reused</summary>

Build and sync replace old previews and remove abandoned work before generation. Validation and dry runs retain the preview and discard persistent-file writes.

Source-generator compiler work lives in `YMB/.ymb/mods/ID/compiler/`; reusable binaries, receipts, and identities live in mod `config/.ymb/`. Verified unchanged generators work without Rust; missing or changed binaries need a compatible compiler.

Result caches evict least-recently-used entries only to meet count and byte limits. Age alone does not expire entries. `--no-cache` bypasses result caching and keeps compilation reusable.

</details>

## After a WARNO update

For an existing YMB installation:

1. Back up your mod projects, authored `ymb.config.yaml` changes, `.ymb/config.yaml`, and `.ymb/state`.
2. Run `recover --yes` before updating the WARNO mod's data.
3. Run `UpdateMod.bat` from the WARNO mod folder, following the game's manual.
4. Return to YMB and run `doctor`, then `build` with your usual selection.
5. Fix reported changes, review the preview, run `sync --yes` with that selection, and compile again.

If files have already changed, read [changed files](troubleshooting.md#changed-files-since-sync) before using recovery. Do not overwrite the refreshed game data with old backups blindly.

Focused patches often continue to work after updates because they find their target again. A renamed field still needs a patch update. Whole-file replacements need comparison with the new game version.

Optional patches can be skipped when required data is absent. Use `build --require-all` when preparing a release so a missing feature cannot pass unnoticed.

## Update YMB or a mod project

Keep shared defaults in root ymb.config.yaml and local customization in .ymb/config.yaml.

| Update | What changes | Before you start |
| --- | --- | --- |
| Portable YMB archive | Root defaults, executable, SDK; retains local overrides, mods, recovery | Back up edited root defaults; read format requirements |
| Mod deploy installer | After confirmation and full recovery, replaces all YMB and syncs selected projects | Back up settings, identities, other projects, and source edits outside YMB |
| Downloaded project | Authored project files | Follow its instructions and preserve documented identity stores |

The [installer's `--preserve-user-data` option](../advanced/mod-releases.md#install-or-update) merges compatible settings from both config files, keeping local overrides, and retains selected projects' `config/.ymb/`. It drops settings for projects removed by the update. Other projects and source edits are still removed. Compile with GenerateMod.bat after deployment; restore compatible local choices and rebuild as needed.

Regenerating identity stores can break saved content. After updating a project, build with your usual selection, inspect, then sync and compile. Updated source cannot sneak itself into WARNO.

| Previous | You are here | Next |
| --- | --- | --- |
| [Build, apply, and play](build-and-play.md) | Guides · 2/3 · Update, undo, and clean up | [Find and fix a failed change](troubleshooting.md) |
