# Writing mods

A mod is a folder in `~/.t3/mods/<id>/`. The folder name is the mod id. For a mod that only
runs on your machine every file is optional; each one runs at its own level (see the table in
the README). To pack, share or publish a mod, it needs a `mod.json` with an `id` and a semver
`version` ([Publish to the registry](#publish-to-the-registry)).
`node loader/t3mods.mjs new <id>` creates one from a template, with editor types.

```
my-mod/
  mod.json       name, version, requires
  style.css      page CSS
  renderer.js    page code (ES module)
  patches.cjs    text patches on the app's bundled code; runs as Node code in Electron main
  server.cjs     backend code (Node)
  server-patches.cjs  text patches on the backend's bundled code
  main.cjs       Electron main process code
```

A folder whose name starts with `_` is off. The Mods page in Settings can also turn mods
on and off.

## mod.json

```json
{
  "id": "my-mod",
  "name": "My mod",
  "version": "1.0.0",
  "description": "What it does.",
  "requires": ["core/sidebar-footer", "core/palette"]
}
```

`requires` lists mods (`"core"`) or single patches (`"core/sidebar-footer"`). If one of them
fails on the installed app build, the mod does not start, and the Mods page shows why. The
example below draws in the sidebar footer and adds a palette command, so it requires those
two core patches.

## renderer.js

Export a function that gets the mod API. Everything you register through `api` is removed
when the mod unloads (disable, uninstall or hot reload). That is what makes hot reload safe.

```js
import { createElement as h, useState } from "react"; // the app's own React

/** @param {import("../../t3mods/types/t3mods").RendererApi} api */
export default (api) => {
  const shown = api.state.boolean("shown", true); // saved per mod
  api.settings.toggle({ title: "Show the counter", value: shown });
  api.command({ id: "hi", title: "My mod: say hi", run: () => api.log("hi") });
  api.slot("sidebar-footer", function Counter() {
    const [n, setN] = useState(0);
    return api.useCell(shown) ? h("button", { onClick: () => setN(n + 1) }, n) : null;
  });
};
```

Main parts of the API (full list in `loader/types/t3mods.d.ts`):

| API | Use |
|---|---|
| `api.slot(name, Component)` | Render in an app slot: `timeline-row` (gets `{ row }`), `sidebar-footer` |
| `api.command({ id, title, run })` | Add to the command palette (the id gets the mod id as prefix) |
| `api.state.boolean/number/string/value` | Saved values with `get`, `set`, `subscribe`, `effect` |
| `api.useCell(cell)` | React hook for a state value |
| `api.settings.toggle / section` | Controls in the mod's card on the Mods page |
| `api.css(text)`, `api.observe(selector, fn)` | Style and DOM work with automatic cleanup |
| `api.lifecycle.signal / own / listen` | Abort signal and cleanup for your own resources |
| `api.server()` / `api.main()` | Call the methods that `server.cjs` / `main.cjs` return |
| `api.threads` | The app's threads, their questions and approvals, and commands to answer them |
| `api.ui.Button / Switch / SidebarIconButton` | The app's own components |
| `api.unsafe.get(key)` | App internals that a patch provides; no stable contract |

`import` from `react`, `react-dom`, `react-dom/client` and `react/jsx-runtime` works without a
bundler. For TSX, build with `bun build --watch` and mark React as external; see
`examples/tsx-demo` and the `build:tsx-demo` script.

## Threads

`api.threads` reads the app's threads and answers them. It comes from the core patch
`core/threads`, so add `"requires": ["core/threads"]` to `mod.json`.

```js
api.threads.subscribe((threads) => {
  const waiting = threads.filter((t) => !t.archived && (t.status === "input" || t.status === "approval"));
  api.log(`${waiting.length} threads need you`);
});

// Questions and approvals load per thread, as when the user opens it.
api.threads.watch(ref, async ({ questions, approvals, lastMessage }) => {
  const q = questions[0];
  if (q) await api.threads.answer(ref, q.requestId, { [q.questions[0].id]: q.questions[0].options[0].value });
});
```

| Method | Does |
|---|---|
| `list()`, `subscribe(fn)`, `useList()` | Every thread: title, project, `status` (`working`, `waiting`, `approval`, `input`, `failed`, `limited`, `ready`), `unread`, ... |
| `watch(ref, fn)` | Open questions, open approvals and the last message of one thread |
| `answer(ref, requestId, answers)` | Answers a question; `answers[questionId]` is an option `value`, typed text, or an array for multi-select |
| `approve(ref, requestId, decision)` | Answers an approval with one of its options (`accept`, `acceptForSession`, `decline`, ...) |
| `send(ref, text)`, `stop(ref)` | A new message (a busy thread queues or steers it), or an interrupt |
| `markSeen(ref)`, `open(ref)` | Marks a thread as seen, or shows it in the app |

`answer` and `approve` check first that the request is still open and that the answer fits
it, and reject otherwise. `mods/agent-inbox` is a full example.

## server.cjs and main.cjs

Export a function. Return a cleanup function, or an object of methods. The renderer calls
the methods through `api.server()` or `api.main()`; an optional `dispose` method is the
cleanup.

The two files differ in when the cleanup runs. `server.cjs` hot-reloads: when you save it or
turn the mod off, the loader runs the cleanup, then requires the new file. `main.cjs` loads
once at app start and stops with the app: the loader never calls its cleanup, and a change
needs a restart.

```js
/** @type {import("../../t3mods/types/t3mods").ServerEntry} */
module.exports = (ctx) => ({
  info: (n) => ({ n, pid: process.pid, mod: ctx.id }),
});
```

In `main.cjs`, `ctx.renderer()` calls the other way: the named exports of the mod's
`renderer.js` in the app window, for example after a global shortcut. `ctx.electron` can open
windows of your own. A window can load a page from the mod folder,
`t3code://app/__mods/<id>/page.html`. Such a page gets no mod API and no app code; it calls
`main.cjs` with `fetch("/__mods/rpc/main/<id>/<method>", { method: "POST", body: JSON.stringify(args) })`.
Close your windows when the app's last window closes (`browser-window-created`, then
`closed`), or the app keeps running without a window.

```js
/** @type {import("../../t3mods/types/t3mods").MainEntry} */
module.exports = (ctx) => {
  ctx.electron.app.whenReady().then(() => {
    ctx.electron.globalShortcut.register("Control+Alt+K", () => ctx.renderer().ping("from main"));
  });
};
// renderer.js
export const ping = (from) => console.log("ping", from);
```

## patches.cjs

`patches.cjs` is a Node module that the loader `require()`s in the Electron main process as soon
as the mod is on. It has the same full access to the computer as `main.cjs`, and the registry,
the install dialog and `t3mods add` warn about it that way. Use patches only when the API has
no slot or value for what you need. Patches edit the
app's minified code, so an app update can break them. `t3mods doctor` shows which ones still
apply.

```js
module.exports = [
  {
    id: "turn-fold-entries",
    find: "kind:`turn-fold`,id:`turn-fold:",                    // selects exactly one chunk
    replace: [{ match: /(kind:`turn-fold`,id:`turn-fold:\$\{(\i)\.runId\}`,)/, replace: "$1modEntries:$2.modEntries," }],
  },
];
```

| Field | Meaning |
|---|---|
| `find` | String or RegExp that selects one chunk. More than one hit is an error. |
| `replace` | `{ match, replace }` entries. `\i` matches a minified identifier. |
| `$self` | In `replace`: this mod's renderer exports. |
| `transform(text)` | Free-form edit when names must be captured elsewhere in the chunk. |
| `group: true` | All entries apply, or the chunk stays as it was. |
| `optional: true` | A failure does not stop the mod. |
| `predicate({ state })` | `false` skips the patch. |

Anchor on source shapes (row kinds, prop names, strings), not on minified names. When an
app update breaks a patch:

```sh
ELECTRON_RUN_AS_NODE=1 "<app dir>/T3 Code (Nightly).exe" tools/extract-assets.cjs extracted/new
node loader/t3mods.mjs doctor --mods <your mods dir> --assets extracted/new
```

`extract-assets.cjs` also writes the backend's chunks to `extracted/new/server`, and `doctor` checks
server patches against them (`--server-dist <dir>` names another folder). Without them, `doctor`
says that server patches were not checked.

Then fix the `match` and run the doctor again. The Patch Helper on the Mods page tries a
patch against the live build.

## server-patches.cjs

Same shape as `patches.cjs`, applied to the backend's chunks (`apps/server/dist/*.mjs` in
`server.asar`) instead of the page's. `$self` has no meaning here. A change needs an app
restart. Use them for what only the backend decides, such as the instructions it gives
agents; `mods/agent-instructions` is the example.

The loader applies them as the backend loads each chunk. On Windows,
`t3mods server-patch` can also write them into `server.asar`, so they apply without the
loader. With the loader installed, its post-update task writes them again after an app
update; without the loader, run `server-patch` again after each update.
`server-patch --undo` puts the original file back. `t3mods doctor` checks both kinds of patch; a patch already written into
`server.asar` shows as `baked`.

## Share a mod

`pack` needs a `mod.json` with an `id` and a semver `version`.

```sh
node loader/t3mods.mjs pack ~/.t3/mods/my-mod      # my-mod-1.0.0.zip
node loader/t3mods.mjs add my-mod-1.0.0.zip        # or an https URL
```

## Publish to the registry

The registry at https://t3mods.jonn.cc lists mods that anyone can install with `t3mods add <id>`
or from the Browse section of the Mods page.

1. Sign in with GitHub at https://t3mods.jonn.cc/login. The registry uses your GitHub login as
   your author name.
2. Create a publishing token at https://t3mods.jonn.cc/settings/tokens (it is shown once) and run
   `t3mods login` (it reads the token from `T3MODS_TOKEN` or stdin, or asks on a terminal; a token on
   the command line stays in shell history). The token is saved in `~/.t3/t3mods-registry.json`
   (mode 0600 where the system supports it). `T3MODS_TOKEN` overrides the saved token.
3. Set `id` (lowercase letters, digits, `.`, `_`, `-`) and `version` (semver, for example `1.0.0`) in `mod.json`.
   A `README.md` in the mod folder becomes the mod's page.
4. Run `node loader/t3mods.mjs publish ~/.t3/mods/my-mod --changelog "What changed"`.

Versions are immutable: to change a published mod, publish a new version. The first publisher of
an id owns it. The registry shows what a mod contains (Styles, UI code, Runs in the backend, ...) and
the loader warns when a mod runs code with full access (`server.cjs`, `server-patches.cjs`,
`main.cjs`, `patches.cjs`). Browse in the app asks before it installs such a mod; `t3mods add`
prints the warning and installs. `t3mods update` and Browse ask when an update adds such a file.

Users run `t3mods search <words>`, `t3mods add <id>[@version]` and `t3mods update [id]`. A link
`t3mods://install/<id>[@version]` (the registry's Install button) opens T3 Code, shows a
confirmation with the author, version, contents and sha256, and installs only after the user
agrees. `T3MODS_REGISTRY` points the loader at another registry (https, or http on localhost).
