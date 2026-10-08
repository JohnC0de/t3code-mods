# App badge

Tells your T3 Code apps apart when you run more than one from one install, for example a
personal app and a work app.

In an app that has a name, the mod does two things:

- It renames the window to `T3 <name>`. The app's own "T3 Code" (or "T3 Code (Nightly)") in
  the title becomes `T3 <name>`. A title without it gets ` — T3 <name>` at the end.
- On Windows it puts a badge on the taskbar button: the first letter of the name on a colored
  disc. Other systems get the title only.

The default app (data in `~/.t3`, no name) is left alone.

## Set the name

Start the second app with its own data folder and a name:

```
T3CODE_HOME=~/.t3-work  T3MODS_APP_NAME=Work  T3MODS_APP_COLOR=#F59E0B
```

| Variable           | Use                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `T3MODS_APP_NAME`  | The name in the title and on the badge. Without it, the name comes from the data folder: `.t3-work` is "Work". |
| `T3MODS_APP_COLOR` | Badge color as CSS hex (`#rgb` or `#rrggbb`). Default: a color from a fixed palette, picked by the name.      |

Both apps load the same mods folder, so install the mod once. With loader 0.4.0 or later a
change applies at once, and turning the mod off removes the badge and the new title. Older
loaders need an app restart.
