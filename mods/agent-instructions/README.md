# Agent instructions

Adds your own text to the instructions that T3 Code gives every agent that has the T3 tools
(Claude, Codex, OpenCode, Pi, Cursor, ACP agents).

1. Edit `instructions.md` in the mod folder (`~/.t3/mods/agent-instructions/`). Every app gets it.
2. Optional: add `instructions.<app>.md` for one app, for example `instructions.work.md` for an
   app named "Work". That file comes after `instructions.md`, only in that app.
3. Restart T3 Code. The backend reads the files once, when it starts.

The app name is the lower case `T3MODS_APP_NAME` of that app. Without it, the backend takes the
name from the `T3CODE_HOME` folder: `.t3-work` is "Work". The default app (`.t3`) has no name and
reads only `instructions.md`.

An empty or missing file leaves the instructions unchanged. The mod patches the backend's code
at load time, so a T3 Code update can break it; `t3mods doctor` shows the state.

## After an update of this mod

Restart T3 Code. That is enough when the loader applies the patch (the default).

If you wrote the patches into `server.asar` with `t3mods server-patch` (Windows), the old code
stays baked in. Quit T3 Code and run `t3mods server-patch` again. It starts from the original
file, so the new code replaces the old.
