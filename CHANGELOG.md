# Changelog

## Unreleased

- **New mod `compact-composer`:** the composer is one row, the prompt beside the model picker.
  The send, stop and attach buttons are gone (Enter sends, Esc stops, drop or paste attaches),
  and the permissions label shows inside the row only when it is not Full access.
- **Agent images, Calm thread and Working keeps background commands work on T3 Code 0.1.4.**
  0.1.4 splits a turn's fold at each steer message, derives the timeline rows in a hook
  instead of a memo, and adds a subagent-request check to the Working test, so the three
  patches matched nothing and the mods did not start. Each patch now handles the 0.1.4 shape
  and keeps the 0.1.3 one; steer folds ("Continued for …") list their hidden images too.
- **HTML path and Preview GPU server patches apply on T3 Code 0.1.4.** T3 reworded
  html_preview's width description and lists the preview browser's flags one per line with a
  third flag; both patches anchor on prop names and flags instead of exact text.
- **No taskkill for exited processes stays healthy where T3 already has the fix.** Its patch
  only selects the old helper and is optional, so 0.1.2 and later show `find-missing` instead
  of switching the mod's server patches off.
- **Settings Mods entry is back on T3 Code 0.1.4.** The nav now renders headed groups of
  paths, so `core/settings-nav` found nothing. The new `core/settings-nav-groups` adds the
  icon, the label and the path (after Archive) in the chunk that renders the nav.
- **Patches can replace an older patch** (`replaces: "<id>"` in the same mod). While the new
  one applies, the old one finding nothing shows as `replaced`, not `find-missing`: no startup
  log line, no count in the Mods page, and `requires` on the old id still holds.
  `core/settings-nav-groups` replaces `core/settings-nav`.
- **AppImage updates keep the app's switches.** electron-updater starts the new AppImage with
  no arguments, so `--ozone-platform`, `--user-data-dir` and the like were gone after the
  first update. The loader now hands the launcher this run's switches (not the link that
  opened it).
- **Two profiles on one AppImage.** An update in one profile deletes the AppImage the other was
  started from, so the other's update failed on the missing file. The loader follows the
  launcher's state to the new AppImage, and install keeps any version an app still runs.
- **t3code:// links reach the modded app after an update.** T3 Code writes its own link entry
  for the bare AppImage, which has no mods and is gone after the next update. The launcher
  sets `T3CODE_DESKTOP_LAUNCHER_PATH` to itself (unless you set it), so that entry starts the
  launcher.
- **`install --no-menu-entry`** hides **T3 Code (mods)** from the app menu, for setups with their
  own entries (one per profile); it keeps handling links, and the choice survives updates.
- **`doctor` checks server patches on Linux.** It looked for `server.asar`, which only Windows
  ships, and failed with `Invalid package`; it now reads the backend next to the client chunks.
  `tools/extract-assets.cjs` works on Linux installs too.
- **Mods survive updates of a self-extracted AppImage.** A folder you extract yourself (for
  example `~/.local/opt/t3code-nightly/<version>`) has no update hook, so every new version
  started without mods. Start the app through `~/.t3/t3mods/linux/launch.sh <t3code exe>`: it
  installs the shim when the folder lacks it, once even when two profiles start together.
- **Settings Mods page works on T3 Code 0.1.3.** T3 moved the settings routes under `/_chat`
  and split the nav labels, nav icons and route tree into three chunks, so the one group patch
  `core/settings-page` matched nothing. `core/settings-page` now adds only the route (both
  route names), and the new `core/settings-nav` adds the nav entry with its icon in the chunk
  that builds the nav.
- **`core/threads` matches T3 Code 0.1.2 and later**, where the project store takes more atoms.
  `api.threads` (used by `agent-inbox` and `calm-thread`) works again.
- **`no-dead-taskkill` is obsolete** from T3 Code 0.1.2: T3's spawner now skips `taskkill` for
  a child that already exited. Its patch reports `match-missing`; uninstall the mod.
- **New mod `no-dead-taskkill`:** on Windows, T3's backend no longer runs `taskkill /T /F` for a
  git or gh child that already exited with a non-zero code (two runs per failure, 97% exit 128,
  about 25 per minute). Live children that time out or get interrupted still get the tree kill.
- **New mod `working-bg-commands`:** with the Working section on, a thread whose agent ended its
  turn while a background command still runs stays in Working instead of dropping into the
  inbox. T3 counts only subagents and monitors there (#14872), so an agent that waits on a
  background Bash looked done. Port of t3code PR #15413: a failed run, an approval, a question
  or a ready plan still goes to the inbox, and alerts and auto-settle do not change.
- **New mod `thread-details-closed`:** the thread details panel (project, branch, Commit & push,
  Changes) starts closed in every thread instead of open. Its toolbar button opens it, and a
  thread where you open it keeps it open across restarts. T3 has no setting for this: the
  default lives in the right panel store, and the mod flips it at all four places that assume
  it, as one group patch.
- **Mods page scrolls and follows the app's settings layout.** The settings route gave the page
  no scroll container, so everything below the window was cut off. The page now brings the
  app's own scroller and top fade, a 56rem column and labelled sections over grouped cards:
  Installed first, then Browse, Install and Developer (Patch Helper). Long names, descriptions
  and patch errors wrap instead of running out of their cards, and rows reflow at narrow widths.
- **New mod `html-path`:** T3's `html_preview` and `html_render` tools take `path`, the absolute
  path of an `.html` file, as well as `html`. The backend reads the file, so an agent no longer
  pastes the page as tool input (a 17 KB page was about 4,000 tokens and 40 s of output).
- **`main.cjs` hot-reloads** (loader 0.4.0) when it returns a cleanup function or a `dispose`
  method. A save of `main.cjs`, of a file it required, or of an `.mjs` file in the mod folder
  runs the cleanup and loads it again; turning the mod off stops it, turning it on or
  installing it starts it, without a restart. Before a load, the loader drops all of the mod
  folder's files from the `require` cache (also for `server.cjs`). A `main.cjs` without a
  cleanup loads once, as before, and the Mods page asks for a restart.
  - `ctx.lifecycle` in both tiers: `own(fn)`, `listen(emitter, event, fn)` and `signal`, which
    run when the mod stops, after its cleanup.
  - Check a `dispose` that you wrote for an older loader: that loader never called it, and
    now it runs before each reload. It must release everything the mod made.
  - `agent-inbox` 0.3.0 and `app-badge` 0.2.0 hot-reload.
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
    over it. On Windows both windows are raised above the taskbar and other topmost windows
    each time they show.
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
