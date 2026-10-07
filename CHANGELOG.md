# Changelog

## Unreleased

- **Several apps at once:** apps with their own `T3CODE_HOME` can share one mods folder.
  `ctx.app` (main and server tiers) and `api.app` (renderer) give `{ id, name, home }`;
  `T3MODS_APP_NAME` sets the name, and `t3mods dev --isolated` sets it to `Dev`.
  - Each main process writes `.t3mods/run/health-<pid>.json`, and its backend follows that file
    instead of the shared `health.json`, so apps no longer overwrite each other's health.
  - Mod state saves per key (`POST /__mods/api/state-patch/<id>`, `store.patchState`), so one
    app no longer overwrites another's keys. A change in one app reaches the cells of the others
    live. A runtime on an older main process falls back to the old whole-object save.
  - `agent-inbox` 0.2.0: all running apps share one strip, one shortcut and one merged inbox.
    The first app to start shows them; when it quits, another app takes over.
  - `agent-inbox` 0.2.1: the strip and the inbox follow the app's zoom, so they are no longer
    cut off at 110 % or more. Each window takes the size of its card. The peek shows the peek
    card (not the inbox card), its clicks go through to the window below, and it has no tooltip
    over it. On Windows both windows stay above the taskbar and other topmost windows.
  - New mod `app-badge`: a named app gets "T3 <name>" in its window title and, on Windows, a
    letter badge on its taskbar button.
  - `agent-instructions` 1.1.0: `instructions.<name>.md` adds notes for one app only.
- **Windows update from a copy of the app:** the installer updates the app's registered install
  folder, not the copy that started the update. The post-update task now finds that folder
  (`InstallLocation` in the registry), installs the loader there and starts that app. Before,
  it installed into the copy, and the updated app ran without mods.
- **Threads API:** `api.threads` lists the app's threads with their status, and reads and
  answers their questions and approvals (`answer`, `approve`, `send`, `stop`, `markSeen`,
  `open`). It comes from the new core patch `core/threads`. Example: `examples/threads-waiting`.
- **Main to renderer:** `ctx.renderer()` in `main.cjs` calls the named exports of the mod's
  `renderer.js` in the app window.
- **Mod pages:** the loader serves `.html` (and common image, audio and font files) from a mod
  folder, so `main.cjs` can open its own windows on `t3code://app/__mods/<id>/page.html`. Such
  windows never count as the app window for reloads, hot updates or install dialogs.
- New mod `agent-inbox`: a status strip at the screen edge and a keyboard inbox
  (Ctrl+Alt+Space) for agent questions, approvals and finished work.

## 0.3.0 (2026-10-07)

- **Registry:** browse, install, review and publish mods at https://t3mods.jonn.cc.
  `t3mods search`, `add <id>[@version]`, `update [id]`, `publish <dir>` and `login` work with it
  (`T3MODS_REGISTRY` overrides the URL). Downloads must come from the registry's origin, match
  their sha256 and carry the requested mod id. The Mods page has a Browse section: search,
  install, update.
- **Install links:** `t3mods://install/<id>[@version]` opens T3 Code, asks in a native dialog,
  then installs. Windows registers the handler at the first start of the modded app; Linux
  AppImage, .deb and AUR installs register it too. `t3mods dev` never registers it.
- **Consent:** every install and update that adds Node code (`patches.cjs`, `server.cjs`,
  `server-patches.cjs`, `main.cjs`) warns and asks first. The loader refuses archives with
  case-variant or trailing-dot names and archives whose tiers differ from the registry's list.
  A registry install never deletes a local mod that t3mods did not install.
- `t3mods login` reads the token from a hidden prompt, stdin or `T3MODS_TOKEN`. `--help` works
  on every command. `bun run e2e:registry` runs the registry e2e steps.
- Fix: on Linux the server-tier watcher kept the backend-like process alive.
- **Server patches:** `server-patches.cjs` patches the backend's code, through a module load
  hook in the loader or, on Windows, written into `server.asar` by `t3mods server-patch`
  (`--undo` restores it). `t3mods doctor` checks them.
- New mod `agent-instructions`: adds your own `instructions.md` to the T3 Code instructions
  that every agent with the T3 tools gets (Claude, Codex, OpenCode, Pi, Cursor, ACP agents).
- **Linux support:** AppImage (extract + launcher, survives in-app updates), .deb
  (`dpkg-divert`) and AUR or other `/opt` installs (pacman hooks). `install.sh` needs no Node.
- The shim now loads the loader from the kit (`~/.t3/t3mods`), so loader updates never touch
  the app folder.
- Windows updates: the reinstall no longer gives up. If T3 Code is open when the loader is
  missing, a Windows notification asks for a restart, and the reinstall runs the moment the
  app quits. A check at logon and every 15 minutes also catches updates the loader did not
  see. The install step can no longer leave a half-switched app folder.
- Fix: `t3mods uninstall` failed on Windows when the scheduled task was already gone.
- New mod `clean-tools`: a quieter, easier to scan tool and command list in the chat.
- `t3mods new <id>` creates a mod from a template.
- Docker test harness for Linux: `bun run test:linux`.
- Fix: a `renderer.js` or `style.css` added to an existing mod did not load until a restart
  on Linux (the mod index kept an old file list).
- Fix: removing a mod whose patches never applied no longer reloads the window.
- Fix: an app restarted by the loader no longer passes the loader's `NODE_OPTIONS` on to
  agents and terminals.

## 0.2.0

- Patch engine: grouped replacements, per-entry doctor status, `requires`, `$self`,
  `predicate`, fail-closed mods.
- Mod API: state cells, `lifecycle.signal`, typed `api.server()` / `api.main()`, slots,
  `api.ui`, `api.unsafe`.
- Builtin Mods page in Settings: toggles, install from a file or URL, Patch Helper.
- Windows: the post-update task waits for the app to quit and repairs the install at logon.
- Fixes for T3 Code 0.0.46 (`turnId` became `runId`).

## 0.1.0

- Prototype: shim injection, same-origin runtime, four hot-reload levels, patch doctor,
  Windows update survival.
