# Workflow and Safety

Open `YMB.bat` and use this order:

```text
doctor
validate
build
sync --yes
```

## Commands

### `doctor`

Confirms the YMB root, WARNO mod root, live data folders, preview folder, and recovery folder. Stop if any path is unexpected.

### `validate`

Checks configuration, dependencies, selectors, scripts, script tests, generated NDF, and output conflicts. It does not write the preview or live WARNO files.

### `build`

Runs the selected patches and scripts and writes the result to:

```text
YMB/.ymb-build/output
```

Inspect the changed files before syncing. `build --dry-run` performs validation and planning without writing the preview.

### `sync --yes`

Builds the selection and applies it to `GameData` and `CommonData`. Original files are saved under `YMB/.ymb-state` for recovery. YMB rejects live files that were changed outside its tracked state instead of silently overwriting them.

### `recover --yes`

Restores tracked originals and removes generated files created by the selected source mods or patches.

Do not delete `YMB/.ymb-state` before recovery. A filtered recovery restores only matching entries:

```text
recover --mod my_pack --yes
recover --patch ui.branding --yes
```

### Supporting commands

```text
list
explain --scope dev
cleanup
init --id my_pack --name "My Pack"
```

- `list` shows discovered source mods and patches.
- `explain` shows why each patch is selected or excluded.
- `cleanup` removes disposable preview and cache data but keeps recovery data.
- `cleanup --all --yes` also removes recovery data and paths marked as unsafe to remove. Recover first if necessary.
- `init` creates a starter source mod under `YMB/mods`.

## Selection options

Common options can be combined:

```text
validate --mod my_pack
build --patch ui.branding
build --scope dev
build --no-cache
build --verbose
```

| Option         | Meaning                                    |
| -------------- | ------------------------------------------ |
| `--mod <id>`   | Include the named source mod               |
| `--patch <id>` | Include the exact patch                    |
| `--scope prod` | Include production patches                 |
| `--scope dev`  | Include production and development patches |
| `--dry-run`    | Plan and validate without writing output   |
| `--no-cache`   | Recompute patch and script-test results    |
| `--verbose`    | Print full diagnostic details              |

Required dependencies are added automatically. A disabled or missing dependency is an error.

## Updating WARNO data

Recover synced files before using WARNO's native update operation when possible:

```text
recover --yes
```

Update the generated WARNO mod, then run:

```text
doctor
validate
build
```

Review changed targets and selectors before syncing again.

## Troubleshooting

1. Run `doctor`.
2. Run `list` and `explain` if selection is wrong.
3. Run `validate --no-cache --verbose` for complete errors.
4. Fix the source mod rather than editing preview output.
5. Rebuild and inspect `YMB/.ymb-build/output`.

If a command reports an interrupted operation, YMB rolls back its transaction. Review the reported files and rerun the command only after the state is understood.
