# App badge

Tells your T3 Code apps apart when you run more than one from one install.

In an app that has a name, the mod does two things:

- It renames the window to `T3 <name>`. The app's own "T3 Code" (or "T3 Code (Nightly)") in the
  title becomes `T3 <name>`. A title without it gets ` — T3 <name>` at the end.
- On Windows it puts a badge on the taskbar button: the first letter of the name on a colored disc.
  Other systems get the title only.

The default app (data in `~/.t3`, no name) is left alone.

## The name

The name is `ctx.app.name`: the `T3MODS_APP_NAME` variable of that app, else a name taken from
its data folder (`T3CODE_HOME`): `.t3-work` is "Work". Start the second app with the variables:

```
T3CODE_HOME=~/.t3-work  T3MODS_APP_NAME=Work  T3MODS_APP_COLOR=#F59E0B
```

| Variable | Use |
|---|---|
| `T3MODS_APP_NAME` | The name in the title and on the badge. |
| `T3MODS_APP_COLOR` | Badge color as CSS hex (`#rgb` or `#rrggbb`). Default: a color from a fixed palette, picked by the name (amber for "Work"). |

Both apps load the same mods folder, so install the mod once. With loader 0.4.0 or later a
change applies at once, and turning the mod off removes the badge and the new title; older
loaders need an app restart.

## Replaces `work-badge`

This mod does what a hand-made `work-badge` mod does, for any name. Turn `work-badge` off
(rename its folder to `_work-badge`). If both run, they rename the window twice.
