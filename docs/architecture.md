# Architecture

T3 Code is an Electron app. The loader needs no change to the Electron binary and no
weaker CSP.

## Injection

1. `install` copies the loader, CLI and helper scripts to the **kit** (`~/.t3/t3mods`). It
   renames `resources/app.asar` to `_app.asar` and adds `resources/app/` with a small shim
   (`loader/shim-index.cjs`). Electron loads `app/` when no `app.asar` exists. The shim
   loads the loader from the kit, sets the app path and version back to the original, then
   loads `_app.asar`, so the app keeps its identity, data and native modules. Because the
   loader lives in the kit, loader updates never touch the app folder, which is root-owned
   on Linux packages.
2. The loader wraps `protocol.handle("t3code")` in the main process. Through it, the loader:
   - adds an import map and the runtime (`loader/runtime.js`) to `index.html`;
   - serves mod files from `t3code://app/__mods/...`, the app's own origin, which its CSP
     (`script-src 'self'`) already allows. `eval` stays blocked;
   - applies mod patches to JS chunks as they are served (`loader/patcher.cjs`).
3. The backend runs as an `ELECTRON_RUN_AS_NODE` child. Packaged Electron ignores
   `NODE_OPTIONS=--require` for the main process, but such children honor it. The loader
   adds itself there, then restores the original `NODE_OPTIONS` inside the backend, so
   agents and terminals that the backend starts do not inherit it.

If the loader fails, the app starts without mods.

## Mods at runtime

- **Renderer.** The runtime imports each `renderer.js` and gives it an `api` object. All
  that a mod registers through `api` has a disposer. On a change, the runtime disposes the
  old version and imports the new one with a versioned URL. The page does not reload.
- **React.** Mods use the app's own React instance (exposed as `globalThis.__clerkSharedModules`
  by the app's Clerk bundle). Shims in `loader/shims/` make `import "react"` resolve to it.
  This global is internal to the app, so a T3 Code update can remove it.
- **Slots and core patches.** The builtin `core` mod patches a few app surfaces (palette,
  timeline row, sidebar footer, settings page, UI components) and turns them into API
  calls such as `api.slot` and `api.command`. Third-party mods should use these, so that
  only core patches need fixes after an app update.
- **Threads.** The core patch `threads` hands over the app's atom registry and its thread,
  detail, project and command stores. The runtime turns them into `api.threads`: plain thread
  objects, and commands that check a request is still open before they answer it
  (`loader/threads-model.mjs` holds the pure part).
- **Server and main.** `server.cjs` runs in the backend, `main.cjs` in the Electron main
  process. `api.server()` and `api.main()` send calls to `/__mods/rpc/` on the app origin.
  The main process runs `main.cjs` calls itself and forwards `server.cjs` calls to the
  backend over a local HTTP port that needs a per-run token. `ctx.renderer()` goes the other
  way: main runs `__t3mods.callRenderer` in the app page, which calls the mod's renderer
  exports. Pages that a mod opens from its folder (`/__mods/<id>/*.html`) count as mod
  windows, not app windows: no runtime, no hot update, no install dialogs.

## Several apps

Apps with different `T3CODE_HOME` folders can share one mods folder, so everything under
`<mods>/.t3mods/` has to cope with more than one writer.

- **App identity.** `platform.appInfo(env, homedir)` gives `{ id, name, home }`: `"default"`
  for `~/.t3`, otherwise a hash of the data folder. Main puts it in `index.json` and in
  `ctx.app`. The backend computes it from the env that it inherits from main.
- **Health.** Main writes `run/health-<mainPid>.json` and `health.json` (the last writer's
  copy, for `t3mods list` and older backends). A backend reads and watches the file of its
  own main process, and falls back to `health.json` when that file is missing. Main removes
  its file on quit, like `run/server-<pid>.json`.
- **State sync.** `state/<id>.json` has no owner. The runtime tracks the keys that the page
  changed and saves them with `state-patch/<id>`; `store.patchState` reads the file, applies
  the keys and writes it atomically. A page that talks to an older main process gets
  "unknown action" and falls back to the whole-object `state/<id>` call. Main also watches
  `state/` (the mods watcher skips dot paths), debounces, reads the changed file and calls
  `__t3mods.stateChanged(id, values)` in the app pages. The runtime updates each key whose
  value differs and that has no unsaved or in-flight local write, and notifies that cell's
  subscribers. A page's own save comes back through the watcher with equal values, so it
  changes nothing. Two patches within a few milliseconds can still lose one: the
  read-apply-write is not a lock. A change from another app does not re-evaluate patch
  predicates; that waits for the next reload.

## Server patches

`server-patches.cjs` patches the backend's chunks. In the backend, the loader runs a doctor
on the real chunks first; a mod whose non-optional server patch fails gets none of its
server patches (fail closed). It then registers a `module.registerHooks` load hook that
edits each chunk as Node reads it from `server.asar`. Any error in the hook loads the
chunk unpatched.

`t3mods server-patch` (Windows) writes the same patches into `server.asar` itself
(`loader/asar.cjs`): it appends the patched chunks to the end of the data section and
points only their header entries (offset, size, integrity) at them, so every other byte
stays in place. Each patched chunk is checked with `node --check` first, and starts with a
`/*t3mods:server-patched [keys]*/` line, so the load hook and the doctor skip patches that
are already there. The original stays as `server.asar.t3mods-orig`, and each run patches
from it. While `~/.t3/t3mods/server-patch.json` exists, `install` (and so the loader's
post-update task) patches the new `server.asar` after an app update. Without the loader,
nothing runs after an update, so `server-patch` must run again.

## Patch doctor

The doctor checks every enabled patch against every chunk of the installed build: does
`find` hit exactly one chunk, and does each `match` apply? It runs at app start and each
time a `patches.cjs` changes, and `t3mods doctor` runs it from the command line. A mod
whose required patch fails does not start (fail closed). The Mods page shows the reason.

## App updates

The Nightly build updates almost every day. Each install type keeps the shim differently:

| Install type | What an update does | What keeps the mods |
|---|---|---|
| Windows | The NSIS installer deletes `resources/app`. | The loader catches the installer start; a scheduled task reinstalls (below). |
| Linux AppImage | electron-updater replaces the AppImage file and starts the new one. | The loader starts the t3mods launcher instead, which extracts and patches the new version first. |
| Linux .deb | dpkg writes a new `app.asar`. | `dpkg-divert` sends it to `_app.asar`; the shim stays. |
| Linux pacman (AUR) | pacman writes a new `app.asar`. | Hooks restore the package files before the transaction and put the shim back after it. |

[Linux details](linux.md). On Windows:

1. The loader wraps the `child_process.spawn` call that starts the installer. It writes
   `~/.t3/t3mods/post-update.request.json`, starts the scheduled task
   `t3mods-post-update-<hash>`, and removes `--force-run`, so the installer does not start
   the app without mods.
2. The task (`loader/post-update.ps1`) waits for the old app to quit and for the installer to
   finish. It then runs `install` on the new build's own exe as Node, and starts the app
   again through WMI, so the app has no console parent.
3. Windows locks `app.asar` while the app runs, so install needs the app closed. If the user
   opened the app again in the meantime, the task shows a Windows notification ("restart to
   turn the mods back on") and installs the moment `app.asar` is free and no installer runs,
   before a restart can open it again. It checks twice a second with an exclusive open of `app.asar`, which is
   the exact condition for the install, and does not restart the app.
4. The task also runs at logon and every 15 minutes, through `loader/post-update.cmd`, which
   exits at once unless a request waits or the default install has an `app.asar` (no
   loader). This catches updates the loader did not see, for example from a manual installer.
   A wait for the app lasts at most a day; the next run starts it over, with a new reminder.

Install switches in an order that keeps the folder valid at every moment: the shim goes into
`resources/app` first (Electron ignores it while `app.asar` exists), then
`_app.asar.unpacked` becomes a junction to `app.asar.unpacked` (a running app can hold the
native modules there locked), and the `app.asar` → `_app.asar` rename switches over last. If
the rename fails, the app stays unmodded and nothing breaks.

### Compared with Discord and Spotify mods

Discord's Squirrel updater writes each new version into a new `app-x.y.z` folder while the
old version still runs. So Vencord, BetterDiscord, moonlight, Replugged and OpenAsar re-patch
from inside the running app: they hook the updater, or find the new folder at startup, and
copy their shim into it. T3 Code uses electron-builder's NSIS installer, which replaces the
install folder only after the app quits, so t3mods needs a helper outside the app. Spicetify
has no automatic step: after a Spotify update the user runs `spicetify apply` again, or
blocks Spotify updates.

## Registry and install links

`loader/registry.cjs` is the client for the mod registry (default `https://t3mods.jonn.cc`, override with
`T3MODS_REGISTRY`). The CLI (`search`, `add <id>`, `update`, `publish`, `login`) and the main process share it;
the renderer cannot call the registry itself (the CSP stays as it is), so the Mods page's Browse
section uses the loader actions `registry-search`, `registry-install` and `registry-updates`.

An install checks, before it writes anything: the download URL has the registry's origin; no request
follows a redirect (a redirect on login or publish would carry the token); the body is at most 5 MiB
(counted while it streams); its sha256 equals the one in the metadata; and the archive's `mod.json`
`id` and `version` equal the requested ones, so an entry can never overwrite another mod.
`sources.json` records `registry:<id>@<version>`, the registry and the sha256, which is how
`update` finds the mods that came from the registry.
Without a version, `add` installs the `latest` that the registry names (the newest non-yanked version if that one is yanked). The saved token is sent only to the registry it was saved for; `T3MODS_TOKEN` is sent wherever `T3MODS_REGISTRY` points.

`t3mods://install/<id>[@<version>]` links: T3 Code holds Electron's single-instance lock (its Clerk
bridge takes it) and listens to `second-instance` and `open-url`. A later launch with the link as an
argument therefore quits at once, and the running instance gets the argv. A link that starts the app
reaches `process.argv` of the first instance. A second process loads the loader too, so a link
is only handled by the process that holds the lock. The loader downloads and checks the archive, then
shows a native confirm dialog (name, author, version, contents, a warning for code that runs in the
backend or main process (including `patches.cjs`), a note for a withdrawn (yanked) version, sha256 prefix, registry host; the default button is Cancel), installs, and
asks the router for the Mods page. On Windows a packaged start registers the `t3mods` protocol with
`app.setAsDefaultProtocolClient`; `t3mods dev` (which sets `T3MODS_LOADER`) never does. On Linux the
AppImage desktop entry lists `x-scheme-handler/t3mods`; for .deb and AUR installs `t3mods install` writes the user-level `t3mods-link.desktop` for it. Only with `T3MODS_LOADER` set,
`T3MODS_TEST_CONFIRM=install|cancel` answers the dialog and records it in `.t3mods/run/` for `tools/e2e.mjs`.

## Files

| File | Role |
|---|---|
| `loader/t3mods.mjs` | CLI: install, uninstall, kit, new, dev, doctor, list, add, search, update, publish, login, pack |
| `loader/platform.cjs` | Paths and update decisions that differ by OS (unit tested) |
| `loader/linux/system.sh` | Root part of Linux package installs: dpkg-divert, pacman hooks |
| `install.sh` | Linux installer that needs no Node |
| `loader/t3mods-loader.cjs` | Main and backend loader: protocol handler, watcher, tiers, update hook |
| `loader/runtime.js` | Renderer runtime and the mod `api` |
| `loader/patcher.cjs` | Patch engine and doctor (pure functions, unit tested) |
| `loader/server-patches.cjs` | Server patches: load hook, doctor, asar baking |
| `loader/asar.cjs` | Reads and rewrites `.asar` archives with plain Node |
| `loader/store.cjs` | Mod folders, state, enable and disable, zip install |
| `loader/registry.cjs` | Registry client: search, verified download, update, publish, tokens, install links |
| `loader/builtin/` | `core` (surface patches) and `manager` (Mods page) |
| `loader/post-update.ps1` | Scheduled task that reinstalls after an update |
| `loader/post-update.cmd` | Task action: starts `post-update.ps1` only when there is work |
| `sandbox/` | Scripts that run a copy of the app with separate data (Windows) |
| `tools/linux-test.sh`, `tools/linux/` | Linux install, update and e2e tests in Docker |
