# Package and share your mod

[All documentation](../README.md#advanced)

| Previous                                               | You are here                                | Next                          |
| ------------------------------------------------------ | ------------------------------------------- | ----------------------------- |
| [Recovery records and interrupted writes](recovery.md) | Advanced · 3/3 · Package and share your mod | [Documentation](../README.md) |

## Prepare locally

From the YMB folder, run:

```powershell
.\YMB.exe release --mod first_mod --json
```

Your files go in `mods/first_mod/config/dist/`. Share the ZIP, any `Deploy-first_mod.exe`, and the license files beside them.

Use `--dry-run` to check what will be packaged. Generators need Rust when they have to be compiled; building an installer also needs Rust.

Set your version in `config/ymb.mod.yaml`:

```yaml
release:
  version: "1.0.0"
```

The archive includes your configuration, including hidden files. Use `release.include` for extras such as your license or README. See [release settings](../references/configuration.md#release-settings-and-download-dependencies) for the fields.

## Add an installer or dependencies

For an installer, add your archive's direct download URL. Replace the account and repository names below:

```yaml
release:
  version: "1.0.0"
  url: https://github.com/YOUR_NAME/YOUR_REPO/releases/latest/download/first_mod-config.zip
```

Leave `url` out if you only want a ZIP. Other HTTPS file hosts work too.

Declare other mods under `dependencies`. Each needs a direct archive URL. Required dependencies install automatically; optional ones ask first. Dependencies can have their own dependencies.

## Publish on GitHub

`init` includes a `.github` folder. Upload the contents of your project folder to your repository, including that hidden folder.

Push to `dev` for a preview release or `master` for stable. These defaults live in `.github/release.json`; override them in the `release` section of `config/ymb.mod.yaml`. The workflow checks other branches without publishing them. GitHub prepares the release with all declared dependencies, including optional ones. If it fails, open the failed step under Actions and check its error. The selected mods need a compatible published YMB.

By default, the title is the version. The description includes your mod's name and description, setup instructions, YMB links, and SHA-256 checksums. For example, to publish stable releases from `main` with a versioned tag:

```yaml
release:
  version: "1.0.0"
  title: "{{version}}"
  managedTags: '^v[0-9]+\.[0-9]+\.[0-9]+$'
  branches:
    - name: main
      tag: "v{{version}}"
      prerelease: false
      latest: true
```

## Install or update

Extract the project ZIP into `YMB/mods/`, or save its deploy EXE beside your WARNO mod's `GameData` and `CommonData` folders and run it. Run `GenerateMod.bat` after syncing, then enable the mod in WARNO.

The installer prefers a compatible stable YMB, then a compatible preview. If neither matches, it offers the latest stable with a warning. Cancel unless you want to test an unsupported combination.

The installer checks that the selected mods build against your game files before saving the new YMB folder. If this check fails during an update, the previous YMB folder is still available. Run `sync` from it to reapply your mods after the installer restores the game files.

> Updating restores all tracked files and replaces the whole YMB folder. Back up settings, identities, source edits, and other projects outside YMB first. Use `--preserve-user-data` to keep compatible settings and selected projects' persistent data; other projects and source edits are still removed.

| Previous                                               | You are here                                | Next                          |
| ------------------------------------------------------ | ------------------------------------------- | ----------------------------- |
| [Recovery records and interrupted writes](recovery.md) | Advanced · 3/3 · Package and share your mod | [Documentation](../README.md) |
