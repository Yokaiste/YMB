# Step 3: Test, Sync, and Recover

This step covers the normal YMB loop once your source mod already exists.

> [!NOTE]
> This page assumes Bun is already installed, YMB is set up, and `doctor` is clean. If not, start with [Getting Started](getting-started.md).

## The Safe Syncing Loop

Use this order:

```bash
bun run ymb validate
bun run ymb build
bun run ymb sync --yes
```

That order is not just a suggestion. It is the workflow YMB is designed around.

## What Each Step Means

| Command      | What it does                                                     | What it writes          |
| ------------ | ---------------------------------------------------------------- | ----------------------- |
| `validate`   | Checks config, selectors, scripts, tests, targets, and conflicts | Nothing                 |
| `build`      | Materializes the generated logic of the current selection        | `YMB/.ymb-build/output` |
| `sync --yes` | Merges the approved result into the game                         | Live mod files          |

## If Something Looks Wrong

Start with these tools:

```bash
bun run ymb explain
bun run ymb build --dry-run
```

Useful examples:

```bash
bun run ymb explain --mod my_pack
bun run ymb build --mod my_pack --patch ui.branding.welcome_view
```

Use them when:

- a patch is missing from the result
- a patch is present when you did not expect it
- a dependency brought in extra work
- you want to narrow the build to one mod or patch

## How Recovery Works

If you want to restore tracked originals later, run:

```bash
bun run ymb recover --yes
```

Recovery uses the data saved in `YMB/.ymb-state` during earlier sync runs.

Important recovery rules:

- files that did not exist before sync can be deleted during recovery
- missing backups are treated as real errors
- filtered recovery with `--mod` and `--patch` still works

## Read Next

- [Workflow Guide](workflow.md) for the command model and selection logic
- [Configuration Reference](configuration.md) when you start editing configs directly
