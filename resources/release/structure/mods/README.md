# Mod projects

Put each extracted mod project in its own folder here:

```text
YMB/
├── YMB.exe
└── mods/
    └── MyMod/
        └── config/
            ├── ymb.mod.yaml
            └── patch/
```

Keep the project's other files beside `config/`. Use YMB to select projects,
build previews, and sync them.

To create a project, run
`YMB.exe init --id my_mod --name "My Mod"` from the YMB folder.

See [the documentation](../docs/README.md) for setup and examples.
