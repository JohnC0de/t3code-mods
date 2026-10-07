// T3 Code mod loader.
// Main process: required by the resources/app shim (packaged Electron ignores --require in
// NODE_OPTIONS). Children: reached via NODE_OPTIONS, which ELECTRON_RUN_AS_NODE children
// (backend server, snapshot workers) do honor, so it gates on process type first.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./store.cjs");
const P = require("./patcher.cjs");
const platform = require("./platform.cjs");

const LOADER_VERSION = "0.3.0";
const { MODS_DIR, META_DIR } = store;
const LOG = (...a) => console.log("[t3mods]", ...a);
const RUN_DIR = path.join(META_DIR, "run");
const HEALTH_FILE = path.join(META_DIR, "health.json");
const errText = (e) => String(e?.message ?? e);

// A tier entry (server.cjs, main.cjs) exports `(ctx) => result`. The result is either a
// cleanup function, or an object of methods that the renderer can call through
// api.server() / api.main(); its optional `dispose` method is the cleanup.
function startEntry(file, ctx) {
  const start = require(file);
  const result = typeof start === "function" ? start(ctx) : undefined;
  if (typeof result === "function") return { cleanup: result, methods: {} };
  if (result && typeof result === "object") {
    const { dispose, ...methods } = result;
    return { cleanup: typeof dispose === "function" ? dispose.bind(result) : () => {}, methods };
  }
  return { cleanup: () => {}, methods: {} };
}

const tierContext = (mod) => ({
  id: mod.id,
  dir: mod.dir,
  log: (...a) => LOG(`[${mod.id}]`, ...a),
  state: () => store.readState(mod.id),
});

const readHealth = () => {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8"));
  } catch {
    return {};
  }
};

// ---------- server tier: plain Node modules inside the backend process ----------
// On change, the cleanup runs and the module is re-required, so server mods hot-reload.
function loadServerMods(rpc) {
  const active = new Map(); // id -> { cleanup, methods }
  const wanted = () => {
    const health = readHealth();
    return new Map(store.listMods().filter((m) => m.enabled && m.files.server && health[m.id]?.status !== "degraded").map((m) => [m.id, m]));
  };
  const load = (mod) => {
    const entry = path.join(mod.dir, "server.cjs");
    try {
      delete require.cache[require.resolve(entry)];
      active.set(mod.id, startEntry(entry, tierContext(mod)));
      LOG("server mod loaded:", mod.id);
    } catch (e) {
      console.error("[t3mods] server mod failed:", mod.id, e);
    }
  };
  const unload = (id) => {
    try {
      active.get(id)?.cleanup();
    } catch (e) {
      console.error("[t3mods] server mod cleanup failed:", id, e);
    }
    active.delete(id);
  };
  for (const mod of wanted().values()) load(mod);
  startServerRpc(rpc, active);

  let timer;
  const changed = new Set();
  let resync = false;
  // persistent:false, not .unref(): on Linux (Node 24) a recursive watcher ignores unref(), and a
  // backend-like process that has nothing else to do (a test, a worker) then never exits.
  fs.watch(MODS_DIR, { recursive: true, persistent: false }, (_evt, file) => {
    if (!file) return;
    const f = file.replace(/\\/g, "/");
    if (f === ".t3mods/config.json" || f === ".t3mods/health.json") resync = true;
    else if (/^[^.][^/]*\/(server\.cjs|mod\.json)$/.test(f) || /^[^./][^/]*$/.test(f)) changed.add(f.split("/")[0].replace(/^_/, ""));
    else return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const mods = wanted();
      const ids = new Set(changed);
      if (resync) for (const id of new Set([...active.keys(), ...mods.keys()])) if (active.has(id) !== mods.has(id)) ids.add(id);
      for (const id of ids) {
        unload(id);
        if (mods.has(id)) load(mods.get(id));
      }
      changed.clear();
      resync = false;
    }, 60);
  });
}

// Local HTTP endpoint for api.server(). Only the main process knows the token; it forwards
// renderer calls here, so the renderer never talks to this port directly.
function startServerRpc({ token, mainPid }, active) {
  if (!token) return;
  const http = require("node:http");
  const expected = Buffer.from(token);
  const srv = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const given = Buffer.from(String(req.headers["x-t3mods-token"] ?? ""));
    if (req.method !== "POST" || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return reply(403, { ok: false, error: "forbidden" });
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      const [id, method] = req.url.split("/").slice(1).map(decodeURIComponent);
      const fn = active.get(id)?.methods?.[method];
      if (typeof fn !== "function") return reply(404, { ok: false, error: `no server method ${id}.${method}` });
      try {
        const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
        reply(200, { ok: true, value: await fn(...args) });
      } catch (e) {
        reply(200, { ok: false, error: errText(e) });
      }
    });
  });
  srv.listen(0, "127.0.0.1", () => {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUN_DIR, `server-${mainPid}.json`), JSON.stringify({ port: srv.address().port, pid: process.pid }));
  });
  srv.unref();
}

// ---------- app updates ----------
// The kit (CLI, loader, helper scripts) that `t3mods install` keeps outside the app folder.
const KIT_HOME = platform.kitHome();

// Scheduled task that runs post-update.ps1; registered by `t3mods install`. Named per kit
// home so a test kit never triggers the real one. Keep in sync with t3mods.mjs.
function postUpdateTaskName() {
  const id = crypto.createHash("sha1").update(path.resolve(KIT_HOME).toLowerCase()).digest("hex").slice(0, 8);
  return `t3mods-post-update-${id}`;
}

// electron-updater reads child_process.spawn at call time, so wrapping it catches the
// update install:
// - Windows: it runs the NSIS installer (`installer.exe --updated /S [--force-run]`), which
//   replaces the install folder and drops the shim. Queue the post-update task, which
//   reinstalls once the installer exits and relaunches the app if the update asked for it,
//   and drop --force-run so the installer doesn't start the app unmodded.
// - Linux AppImage: it replaces the AppImage file, then starts the new one. Start the t3mods
//   launcher instead, which extracts and patches the new version before it runs it.
// - Linux packages (.deb, pacman) need nothing here: dpkg-divert or the pacman hook keeps
//   the shim in place.
function hookUpdaterInstall() {
  const cp = require("node:child_process");
  const spawn = cp.spawn;
  cp.spawn = function (cmd, args, options) {
    const kind = platform.classifyUpdaterSpawn(process.platform, args, options, process.env);
    if (kind === "windows-installer") {
      const relaunch = args.includes("--force-run");
      const queued = queuePostUpdate(cp, /elevate\.exe$/i.test(cmd) ? args[0] : cmd, relaunch);
      return spawn.call(this, cmd, queued ? args.filter((a) => a !== "--force-run") : args, options);
    }
    if (kind === "appimage") {
      LOG("update install intercepted; the launcher prepares", cmd);
      // The launcher waits for this process to exit, so two app versions never run at once.
      const env = { ...platform.cleanEnv(options.env), T3MODS_NEW_APPIMAGE: cmd, T3MODS_OLD_PID: String(process.pid) };
      return spawn.call(this, process.env.T3MODS_LAUNCHER, args ?? [], { ...options, env });
    }
    return spawn.apply(this, arguments);
  };
}

// The helper runs from Task Scheduler because no child of the app survives the quit
// reliably: attached children die with it, and PowerShell spawned detached exits at once.
function queuePostUpdate(cp, installer, relaunch) {
  try {
    // The task starts with the user's default environment; carry over what selects the
    // app's data and mods so the relaunched app matches this one.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(T3CODE_|T3MODS_(?!PREV_|RPC_|MAIN_)|APPDATA$|LOCALAPPDATA$)/.test(k)),
    );
    // pid: the task waits for this process to quit before it waits for the installer.
    const request = { exe: process.execPath, installer, relaunch, env, pid: process.pid, at: new Date().toISOString() };
    fs.writeFileSync(path.join(KIT_HOME, "post-update.request.json"), JSON.stringify(request));
    cp.execFileSync("schtasks.exe", ["/Run", "/TN", postUpdateTaskName()], { stdio: "ignore", windowsHide: true });
    LOG("update install intercepted; post-update task queued");
    return true;
  } catch (e) {
    console.error("[t3mods] could not queue the post-update task; this update runs unmodded", e);
    return false;
  }
}

// ---------- main process ----------
function installMain() {
  const electron = require("electron");
  const { protocol, app } = electron;
  hookUpdaterInstall();

  const rpcToken = crypto.randomBytes(24).toString("hex");
  process.env.T3MODS_RPC_TOKEN = rpcToken;
  process.env.T3MODS_MAIN_PID = String(process.pid);

  let version = Date.now();
  const assetsDir = platform.clientAssetsDir(process.resourcesPath);
  if (!assetsDir) LOG("web client chunks not found; patches cannot apply");
  const readChunks = () =>
    assetsDir
      ? fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js")).map((name) => ({ name, text: fs.readFileSync(path.join(assetsDir, name), "utf8") }))
      : [];

  let mods = [];
  let patches = [];
  let activeKeys = new Set(); // patches that apply at serve time
  let health = new Map();
  let doctorReport = null;
  const patchStats = new Map();
  const pending = { reload: new Set(), restart: new Set() };
  const mainMethods = new Map();

  // The doctor reads every chunk (~100 ms), so this runs only when patches or mods change.
  function reloadPatches() {
    mods = store.listMods();
    patches = [];
    const loadErrors = new Map();
    for (const mod of mods) {
      if (!mod.enabled || !mod.files.patches) continue;
      const file = path.join(mod.dir, "patches.cjs");
      try {
        delete require.cache[require.resolve(file)];
        patches.push(...P.normalize(mod.id, require(file)));
      } catch (e) {
        loadErrors.set(mod.id, [`patches.cjs: ${errText(e)}`]);
        console.error("[t3mods] patches failed:", mod.id, e);
      }
    }
    for (const m of mods) if (m.manifestError) loadErrors.set(m.id, [`mod.json: ${m.manifestError}`]);
    const predicates = new Map(patches.map((p) => [p.key, P.evalPredicate(p, { state: store.readState(p.mod) })]));
    doctorReport = P.doctor(patches, readChunks(), (p) => predicates.get(p.key));
    health = P.resolveHealth(mods, doctorReport.results, loadErrors);
    activeKeys = new Set(patches.filter((p) => health.get(p.mod)?.status === "ok" && predicates.get(p.key)?.active).map((p) => p.key));
    for (const r of doctorReport.results) if (!["ok", "skipped"].includes(r.status)) LOG(`patch ${r.status}:`, r.key);
    for (const [id, h] of health) if (h.status === "degraded") LOG(`mod degraded: ${id}:`, h.problems.join("; "));
    try {
      fs.mkdirSync(META_DIR, { recursive: true });
      fs.writeFileSync(HEALTH_FILE, JSON.stringify(Object.fromEntries(health)));
    } catch {}
  }
  reloadPatches();

  const origHandle = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) => {
    if (!/^t3code/.test(scheme)) return origHandle(scheme, handler);
    LOG("wrapping protocol", scheme);
    return origHandle(scheme, async (request) => {
      try {
        return await handleModded(request, handler);
      } catch (e) {
        console.error("[t3mods] handler error", request.url, e);
        throw e;
      }
    });
  };

  async function handleModded(request, handler) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__mods/")) return serveMods(request, url);
    const res = await handler(request);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) return rewrite(res, (html) => html.replace("<head>", `<head>${runtimeTag()}`), { "cache-control": "no-store" });
    // no-store: chunk names are content hashes of the *unpatched* file, so any cached copy
    // may carry stale patches. Everything is read from local disk anyway.
    if (activeKeys.size && type.includes("javascript")) {
      const onIssue = (p, msg) => LOG(`patch ${p.key} on ${url.pathname}: ${msg}`);
      return rewrite(res, (js) => P.applyAll(patches, js, (p) => activeKeys.has(p.key), onIssue, patchStats), { "cache-control": "no-store" });
    }
    return res;
  }

  // Renderer runtime + mods are same-origin (t3code://app/__mods/...), so CSP 'self' allows them.
  // The version is a path segment so a mod's relative imports also get fresh URLs on reload.
  // The import map lets mods `import { useState } from "react"` and get the app's own React,
  // so bundlers can keep React external. It must precede every module script.
  const importMap = JSON.stringify({
    imports: {
      react: "/__mods/_runtime/shims/react.js",
      "react/jsx-runtime": "/__mods/_runtime/shims/jsx-runtime.js",
      "react/jsx-dev-runtime": "/__mods/_runtime/shims/jsx-dev-runtime.js",
      "react-dom": "/__mods/_runtime/shims/react-dom.js",
      "react-dom/client": "/__mods/_runtime/shims/react-dom-client.js",
    },
  });
  const runtimeTag = () =>
    `<script type="importmap">${importMap}</script><script type="module" src="/__mods/@${version}/_runtime/runtime.js"></script>`;

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  function modIndex() {
    const sources = store.sources();
    return mods.map((m) => {
      const h = health.get(m.id) ?? { status: m.enabled ? "ok" : "disabled", problems: [] };
      return {
        id: m.id,
        name: m.manifest.name ?? m.id,
        description: m.manifest.description ?? "",
        version: m.manifest.version ?? null,
        author: m.manifest.author ?? null,
        builtin: m.builtin,
        enabled: m.enabled,
        status: h.status,
        problems: h.problems,
        files: m.files,
        level: store.reloadLevel(m),
        base: `${m.builtin ? "_builtin/" : ""}${encodeURIComponent(m.id)}`,
        state: store.readState(m.id),
        source: sources[m.id] ?? null,
        requires: m.manifest.requires ?? [],
      };
    });
  }

  async function serveMods(request, url) {
    if (url.pathname === "/__mods/index.json") {
      const body = {
        loader: LOADER_VERSION,
        version,
        modsDir: MODS_DIR,
        mods: modIndex(),
        doctor: doctorReport,
        served: [...patchStats].map(([key, hits]) => ({ key, hits })),
        pending: { reload: [...pending.reload], restart: [...pending.restart] },
      };
      // The renderer runtime fetches this on boot, so this file proves mods reached the page.
      fs.writeFile(path.join(MODS_DIR, ".status.json"), JSON.stringify({ at: new Date().toISOString(), ...body }, null, 1), () => {});
      return json(body);
    }
    if (url.pathname.startsWith("/__mods/api/")) {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      try {
        return json({ ok: true, ...(await apiCall(url.pathname.slice("/__mods/api/".length), request)) });
      } catch (e) {
        return json({ ok: false, error: errText(e) }, 400);
      }
    }
    if (url.pathname.startsWith("/__mods/rpc/")) {
      const [tier, id, method] = url.pathname.slice("/__mods/rpc/".length).split("/").map(decodeURIComponent);
      try {
        const args = JSON.parse((await request.text()) || "[]");
        if (tier === "main") {
          const fn = mainMethods.get(id)?.[method];
          if (typeof fn !== "function") throw new Error(`no main method ${id}.${method}`);
          return json({ ok: true, value: await fn(...args) });
        }
        if (tier === "server") return json(await callServer(id, method, args));
        throw new Error(`unknown tier ${tier}`);
      } catch (e) {
        return json({ ok: false, error: errText(e) });
      }
    }
    return serveFile(url);
  }

  async function callServer(id, method, args) {
    const file = path.join(RUN_DIR, `server-${process.pid}.json`);
    if (!fs.existsSync(file)) throw new Error("the backend has not started its mod endpoint");
    const { port } = JSON.parse(fs.readFileSync(file, "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(id)}/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: { "x-t3mods-token": rpcToken, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return res.json();
  }

  async function readBody(request, limit) {
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.length > limit) throw new Error("request too large");
    return buf;
  }

  async function apiCall(action, request) {
    if (action === "toggle") {
      const { id, enabled } = JSON.parse(await request.text());
      const mod = store.setEnabled(id, Boolean(enabled));
      return afterChange(mod);
    }
    if (action === "install") {
      const name = request.headers.get("x-t3mods-filename") ?? "archive";
      const result = store.installArchive(await readBody(request, 50 * 1024 * 1024), `file:${name}`);
      return { installed: result, ...afterChange(store.listMods().find((m) => m.id === result.id)) };
    }
    if (action === "install-url") {
      const { url: target } = JSON.parse(await request.text());
      const u = new URL(target);
      const local = u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname);
      if (u.protocol !== "https:" && !local) throw new Error("only https URLs");
      const res = await fetch(u, { redirect: "follow" });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 50 * 1024 * 1024) throw new Error("archive too large");
      const result = store.installArchive(buf, u.href);
      return { installed: result, ...afterChange(store.listMods().find((m) => m.id === result.id)) };
    }
    if (action === "registry-search") {
      const { q, sort, page } = JSON.parse((await request.text()) || "{}");
      return { registry: registryClient().baseUrl(), result: await registryClient().search(q ?? "", { sort, page }) };
    }
    if (action === "registry-updates") {
      const list = await registryClient().updates();
      return { updates: list.map(({ info, ...u }) => ({ ...u, tiers: info.tiers })) };
    }
    if (action === "registry-install") {
      const { id, version } = JSON.parse(await request.text());
      return installFromRegistry({ id, version: version ?? null });
    }
    if (action === "uninstall") {
      const { id } = JSON.parse(await request.text());
      return afterChange(store.uninstall(id));
    }
    if (action.startsWith("state/")) {
      const id = decodeURIComponent(action.slice("state/".length));
      store.writeState(id, JSON.parse(await request.text()));
      // State can switch patches on and off through `predicate`; that needs a renderer reload.
      if (!patches.some((p) => p.mod === id && typeof p.predicate === "function")) return { reload: false };
      const before = [...activeKeys].join();
      reloadPatches();
      const reload = before !== [...activeKeys].join();
      if (reload) pending.reload.add(id);
      return { reload };
    }
    if (action === "open-folder") {
      const { id } = JSON.parse((await request.text()) || "{}");
      const mod = id ? store.listMods().find((m) => m.id === id) : null;
      const error = await electron.shell.openPath(mod?.dir ?? MODS_DIR);
      if (error) throw new Error(error);
      return {};
    }
    if (action === "reload") {
      pending.reload.clear();
      reloadRenderers();
      return {};
    }
    if (action === "restart") {
      setTimeout(() => {
        // The new process inherits this env; give it the user's own NODE_OPTIONS back
        // (packaged Electron rejects most of them) and let it make its own RPC token.
        const env = platform.cleanEnv(process.env);
        for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
        Object.assign(process.env, env);
        app.relaunch();
        app.exit(0);
      }, 50);
      return {};
    }
    if (action === "patch-test") {
      const p = JSON.parse(await request.text());
      const replace = p.match ? [{ match: p.match, flags: p.flags ?? "", replace: p.replace ?? "" }] : [];
      return { results: P.tryPatch({ find: p.find, replace, group: p.group }, readChunks()) };
    }
    throw new Error(`unknown action ${action}`);
  }

  // Required on use, not at load: the loader also starts in the backend, and a kit that lacks
  // registry.cjs must not stop the app from starting.
  const registryClient = () => require("./registry.cjs");
  // The link in an argv, or null; a kit without registry.cjs just has no link support.
  const linkIn = (argv) => {
    try {
      return registryClient().findInstallLink(argv);
    } catch (e) {
      LOG("t3mods:// links are off:", errText(e));
      return null;
    }
  };

  // A browse install or update has no link dialog, so it asks here when it brings code that
  // runs with full access (for an update: a tier that the installed version does not have),
  // or a version that its author withdrew.
  async function installFromRegistry(spec, prepared) {
    return (prepared ? Promise.resolve(prepared) : registryClient().prepare(spec)).then(async (p) => {
      if (!prepared) {
        const have = findInstalled(p.id);
        const added = p.info.tiers.filter((t) => registryClient().FULL_ACCESS_TIERS.includes(t) && !have?.files[t]);
        if ((added.length || p.info.yanked) && !(await confirmInstall(p, have, added))) throw new Error("install cancelled");
      }
      const result = registryClient().install(p);
      return { installed: result, ...afterChange(store.listMods().find((m) => m.id === result.id)) };
    });
  }

  // ---------- t3mods://install/<id>[@<version>] ----------
  // T3 Code holds Electron's single-instance lock (its Clerk bridge takes it) and listens to
  // "second-instance" (argv of a later launch, Windows and Linux) and "open-url" (macOS).
  // A second process loads this loader too, so a link is only acted on by the process that
  // holds the lock.
  const testMode = Boolean(process.env.T3MODS_LOADER); // `t3mods dev`: test hooks and no protocol registration
  let linkQueue = Promise.resolve();
  const handleInstallLink = (link) => {
    linkQueue = linkQueue.then(() => runInstallLink(link)).catch((e) => console.error("[t3mods] install link failed", e));
  };

  const showBox = async (options) => {
    const parent = electron.BrowserWindow.getFocusedWindow() ?? electron.BrowserWindow.getAllWindows()[0];
    const answer = testMode && process.env.T3MODS_TEST_CONFIRM;
    // Test mode only (T3MODS_LOADER is set by `t3mods dev`, never in a normal start): record the
    // dialog instead of showing it, so a test can check what the user would have seen.
    if (answer) {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(path.join(RUN_DIR, `confirm-${process.pid}-${Date.now()}.json`), JSON.stringify({ pid: process.pid, options, answer }));
      return { response: answer === "install" ? options.buttons.length - 1 : options.cancelId ?? 0 };
    }
    return parent ? electron.dialog.showMessageBox(parent, options) : electron.dialog.showMessageBox(options);
  };

  // The installed mod for an id, found without case: Windows and macOS see "Foo" and "foo" as one folder.
  const findInstalled = (id) => store.listMods().find((m) => !m.builtin && m.id.toLowerCase() === id.toLowerCase());

  // The confirm dialog for a prepared registry install. `added`: the full-access tiers that
  // this install brings and the installed version lacks.
  async function confirmInstall({ id, detail, info }, installed, added) {
    const reg = registryClient();
    const warnings = reg.tierWarning(info.tiers);
    const runsCode = reg.hasFullAccess(info.tiers);
    const lines = [
      `Version ${info.version}, by @${reg.oneLine(detail.author?.login ?? "unknown", 40)}`,
      reg.oneLine(detail.description, 200),
      "",
      info.yanked ? "The author withdrew this version (yanked). It may have a known problem." : "",
      installed && added.length ? `This update adds code that the installed version does not have: ${added.join(", ")}.` : "",
      `Contains: ${info.tiers.join(", ") || "nothing that runs"}`,
      ...warnings,
      runsCode ? "Only install it if you trust its author." : "",
      "",
      `sha256 ${info.sha256.slice(0, 16)}...`,
      `From ${new URL(reg.baseUrl()).host}`,
      installed ? `Replaces the installed version ${installed.manifest.version ?? "(unknown)"}.` : "",
    ].filter((l, i, all) => l !== "" || (all[i - 1] !== "" && i > 0));
    const { response } = await showBox({
      type: runsCode || info.yanked ? "warning" : "question",
      title: "Install mod",
      message: `Install "${reg.oneLine(detail.name ?? id, 60)}"?`,
      detail: lines.join("\n"),
      buttons: ["Cancel", "Install"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  }

  async function runInstallLink(link) {
    await app.whenReady();
    const reg = registryClient();
    let spec;
    try {
      spec = reg.parseInstallLink(link);
    } catch (e) {
      LOG("ignored install link:", errText(e));
      if (!testMode) electron.dialog.showErrorBox("t3mods", `This install link is not valid: ${errText(e)}`);
      return;
    }
    let prepared;
    try {
      prepared = await reg.prepare(spec);
    } catch (e) {
      LOG("install link: could not fetch", spec.id, errText(e));
      await showBox({ type: "error", title: "t3mods", message: `Could not get ${spec.id}`, detail: errText(e), buttons: ["OK"], defaultId: 0 });
      return;
    }
    const { info } = prepared;
    const installed = findInstalled(spec.id);
    const added = info.tiers.filter((t) => reg.FULL_ACCESS_TIERS.includes(t) && !installed?.files[t]);
    if (!(await confirmInstall(prepared, installed, added))) return LOG("install link: cancelled", spec.id);
    const out = await installFromRegistry(spec, prepared);
    LOG("installed from link:", spec.id, info.version, out.level);
    for (const wc of appContents()) wc.executeJavaScript('window.__TSR_ROUTER__?.navigate({ to: "/settings/mods" })').catch(() => {});
    const win = electron.BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  }

  // Applies a manager change. Main-tier code cannot be swapped, so it only marks a restart.
  function afterChange(mod) {
    const level = mod ? store.reloadLevel(mod) : "reload";
    if (level === "restart") pending.restart.add(mod.id);
    flush([`${mod?.id ?? "?"}/mod.json`]);
    return { level };
  }

  function serveFile(url) {
    const rel = decodeURIComponent(url.pathname.replace(/^\/__mods\/(@\d+\/)?/, ""));
    let base = MODS_DIR;
    let sub = rel;
    if (rel.startsWith("_runtime/")) [base, sub] = [__dirname, rel.slice("_runtime/".length)];
    else if (rel.startsWith("_builtin/")) [base, sub] = [store.BUILTIN_DIR, rel.slice("_builtin/".length)];
    const file = path.resolve(base, sub);
    if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response(null, { status: 404 });
    const type = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)] ?? "application/octet-stream";
    return new Response(fs.readFileSync(file), { headers: { "content-type": type, "cache-control": "no-store" } });
  }

  async function rewrite(res, fn, extraHeaders = {}) {
    const text = fn(await res.text());
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    return new Response(text, { status: res.status, headers });
  }

  const appContents = () => electron.webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith("t3code"));
  function reloadRenderers() {
    // Chunks keep their hashed names across patch edits, so drop the HTTP cache first.
    for (const wc of appContents()) wc.session.clearCache().then(() => wc.reloadIgnoringCache());
  }

  // Hot reload. CSS and renderer.js swap in place; patches.cjs and mod.json need a renderer
  // reload (chunks are re-served through the patcher); main.cjs needs an app restart;
  // server.cjs is reloaded by the backend's own watcher.
  function flush(files, forceReload = false) {
    version = Date.now();
    // The index lists each mod's files, and a new or deleted renderer.js or style.css changes
    // what the page loads. Windows also reports the mod folder itself on such changes, Linux
    // does not, so refresh the list on every change (cheap: no chunk reads).
    mods = store.listMods();
    const ids = new Set(files.map((f) => f.split("/")[0].replace(/^_/, "")));
    for (const f of files) if (/main\.cjs$/.test(f)) pending.restart.add(f.split("/")[0]);
    // Edited patches of an enabled mod always need a reload. Other structural changes
    // (mod.json, a mod added, removed or toggled) need one only when they change which
    // patches apply: removing a mod whose patches never applied must not reload the page.
    const enabled = new Set(mods.filter((m) => m.enabled).map((m) => m.id));
    let needsReload = forceReload || files.some((f) => /patches\.cjs$/.test(f) && enabled.has(f.split("/")[0]));
    if (needsReload || files.some((f) => /(mod\.json|patches\.cjs)$/.test(f) || !f.includes("/"))) {
      const before = [...activeKeys].join();
      reloadPatches();
      if ([...activeKeys].join() !== before) needsReload = true;
    }
    if (needsReload) {
      pending.reload.clear();
      reloadRenderers();
    } else {
      for (const wc of appContents()) wc.executeJavaScript(`window.__t3mods?.hotUpdate(${JSON.stringify({ version, files, ids: [...ids] })})`).catch(() => {});
    }
    LOG(needsReload ? "reloaded renderer for" : "hot-updated", files.join(", "));
  }

  app.on("second-instance", (_event, argv) => {
    const link = linkIn(argv);
    if (link) handleInstallLink(link);
  });
  app.on("open-url", (event, url) => {
    if (!/^t3mods:/i.test(url)) return;
    event.preventDefault();
    handleInstallLink(url);
  });
  // First launch with a link (the protocol handler started the app). The lock is taken a little
  // after this file loads, and a launch that loses the lock quits: only the winner acts.
  {
    const link = linkIn(process.argv);
    if (link) {
      let tries = 0;
      const timer = setInterval(() => {
        if (app.hasSingleInstanceLock()) handleInstallLink(link);
        else if (++tries < 80) return;
        clearInterval(timer);
      }, 250);
      app.on("quit", () => clearInterval(timer));
    }
  }
  // Windows: make t3mods:// links open the modded app. Never from a dev run or a test, which
  // would hijack the user's real association.
  if (process.platform === "win32" && !process.env.T3MODS_LOADER && app.isPackaged) {
    try {
      app.setAsDefaultProtocolClient("t3mods");
    } catch (e) {
      LOG("could not register t3mods://", errText(e));
    }
  }

  app.on("quit", () => fs.rmSync(path.join(RUN_DIR, `server-${process.pid}.json`), { force: true }));
  app.whenReady().then(() => {
    fs.mkdirSync(MODS_DIR, { recursive: true });
    let timer;
    const queued = new Set();
    fs.watch(MODS_DIR, { recursive: true }, (_evt, file) => {
      if (!file || /(^|[\\/])\./.test(file)) return;
      queued.add(file.replace(/\\/g, "/"));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...queued];
        queued.clear();
        flush(files);
      }, 60);
    });
    LOG("watching", MODS_DIR);
    // `t3mods dev` runs the loader from a checkout: also watch the builtins and the runtime.
    if (process.env.T3MODS_LOADER) {
      let devTimer;
      let runtimeChanged = false;
      const devQueued = new Set();
      fs.watch(__dirname, { recursive: true }, (_evt, file) => {
        const f = file?.replace(/\\/g, "/");
        if (!f) return;
        if (f.startsWith("builtin/")) devQueued.add(f.slice("builtin/".length));
        else if (/^(runtime\.js|shims\/)/.test(f)) runtimeChanged = true;
        else if (f.endsWith(".cjs")) return void LOG(`${f} changed; restart T3 Code to load it`);
        else return;
        clearTimeout(devTimer);
        devTimer = setTimeout(() => {
          flush([...devQueued], runtimeChanged);
          devQueued.clear();
          runtimeChanged = false;
        }, 60);
      });
      LOG("watching", __dirname);
    }
  });

  // Main-process mods (Node + Electron APIs). Restart required on change.
  for (const mod of mods) {
    if (!mod.enabled || !mod.files.main || health.get(mod.id)?.status === "degraded") continue;
    try {
      const { methods } = startEntry(path.join(mod.dir, "main.cjs"), { ...tierContext(mod), electron });
      mainMethods.set(mod.id, methods);
      LOG("main mod loaded:", mod.id);
    } catch (e) {
      console.error("[t3mods] main mod failed:", mod.id, e);
    }
  }
}

// ---------- entry (last, so every const above is initialized) ----------
const serverBin = process.argv.find((a) => /apps[\\/]server[\\/]dist[\\/]bin\.mjs$/.test(a));
const isServer = Boolean(serverBin);
if (process.type !== "browser") {
  // Restore the user's NODE_OPTIONS so agents and tools spawned by the server don't inherit
  // the loader.
  if ("T3MODS_PREV_NODE_OPTIONS" in process.env) {
    process.env.NODE_OPTIONS = process.env.T3MODS_PREV_NODE_OPTIONS;
    if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
    delete process.env.T3MODS_PREV_NODE_OPTIONS;
  }
  const rpc = { token: process.env.T3MODS_RPC_TOKEN, mainPid: process.env.T3MODS_MAIN_PID };
  delete process.env.T3MODS_RPC_TOKEN;
  delete process.env.T3MODS_MAIN_PID;
  // An exception here would stop the backend (it is a --require), so the server tier fails
  // open: the backend starts without mods.
  if (isServer) {
    // Before bin.mjs loads: the hook must be in place when Node reads the backend chunks.
    try {
      require("./server-patches.cjs").installHooks({ distDir: path.dirname(serverBin), mods: store.listMods(), log: LOG });
    } catch (e) {
      console.error("[t3mods] server patches failed; backend starts without them", e);
    }
    try {
      loadServerMods(rpc);
    } catch (e) {
      console.error("[t3mods] server tier failed; backend starts without mods", e);
    }
  }
} else {
  // Errors here reach the shim, which starts the app without mods.
  installMain();
  process.env.T3MODS_PREV_NODE_OPTIONS = process.env.NODE_OPTIONS ?? "";
  // Forward slashes: NODE_OPTIONS parsing treats backslashes as escapes.
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require "${__filename.replaceAll("\\", "/")}"`.trim();
}
