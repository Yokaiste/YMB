# Your mod projects

Put each editable mod project in its own folder here:

```text
YMB/
  mods/
    my_mod/
      config/
        ymb.mod.yaml
```

Open `YMB.bat` from the YMB folder and run `list` to check that the project was found.
Follow that project's setup guide, then run `build --mod my_mod` to create a preview.
Use the id from its `ymb.mod.yaml`; the folder name may differ.

To start your own project, run `init`. Follow [Your first build](../docs/getting-started.md)
to put its title on WARNO's menu, then keep the same project for the unit-health
and bulk-edit lessons.

Workshop subscriptions and compiled game files cannot go here. YMB needs the
editable project supplied by its author. Check its license before sharing changes.
