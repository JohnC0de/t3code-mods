// End-to-end check against a running dev instance:
//   node loader/t3mods.mjs dev --isolated --mods <dir> --cdp 9333   (in another terminal)
//   node tools/e2e.mjs [--port 9333] [--mods <dir>]
// It adds and removes its own temporary mods in the mods folder; other mods are left alone.
//
// Registry steps (Browse tab and t3mods:// links) run when --registry is given; `bun run e2e:registry`
// (tools/e2e-registry.mjs) starts the fake registry and the instance, then does all of this.
// Without --registry they are skipped, and the final line says so. The instance
// must have been started with T3MODS_REGISTRY=<url> and T3MODS_TEST_CONFIRM=install, against
// the fake registry: node tests/helpers/fake-registry.cjs --port 4873
//   node tools/e2e.mjs --mods <dir> --registry http://127.0.0.1:4873 --exe <T3 Code.exe> --profile <dir>
// --exe and --profile (the --profile of `dev`) let it start a second process with a link.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = opt("--port", "9333");
const modsDir = path.resolve(opt("--mods", path.join(os.homedir(), ".t3", "mods")));
const registryUrl = opt("--registry");
const exeFile = opt("--exe");
const profileDir = opt("--profile");
const require = createRequire(import.meta.url);
const { writeZip } = require("../loader/zip.cjs");

// A port can stay bound after its app died (a child process kept the socket), and then
// requests hang: fail with a clear message instead.
setTimeout(() => {
  console.log("FAIL the run took longer than 3 min; is the app on this CDP port alive?");
  process.exit(1);
}, 180_000).unref();
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("t3code://app") && !t.url.includes("/__mods/"));
if (!page) throw new Error(`no T3 Code page on CDP port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
};
await new Promise((r) => (ws.onopen = r));
async function evaluate(expression) {
  const id = ++seq;
  const d = await new Promise((r) => {
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? JSON.stringify(d.result.exceptionDetails));
  return d.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, expr, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await evaluate(expr);
      if (v) return v;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timed out: ${what}`);
}
const api = (action, body) => evaluate(`fetch('/__mods/api/${action}',{method:'POST',body:${JSON.stringify(JSON.stringify(body ?? {}))}}).then(r=>r.json())`);
const installZip = (files) => {
  const b64 = writeZip(files.map(([name, text]) => ({ name, data: Buffer.from(text) }))).toString("base64");
  return evaluate(`fetch('/__mods/api/install',{method:'POST',headers:{'x-t3mods-filename':'e2e.zip'},body:Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0))}).then(r=>r.json())`);
};
const loaded = (id) => `window.__t3mods?.loaded.has(${JSON.stringify(id)})`;
const pageId = () => evaluate("performance.timeOrigin");

let failures = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await step("runtime and builtins are up", async () => {
  await until("runtime", "window.__t3mods?.loaded.has('manager')");
  const idx = await evaluate("fetch('/__mods/index.json').then(r=>r.json())");
  const bad = idx.mods.filter((m) => m.enabled && m.status !== "ok");
  assert(!bad.length, `not started: ${bad.map((m) => `${m.id} (${m.problems.join("; ")})`).join(", ")}`);
});

await step("CSS-only mod installs from a zip and applies without a reload", async () => {
  const before = await pageId();
  const r = await installZip([["mod.json", JSON.stringify({ id: "e2e-css", version: "1.0.0" })], ["style.css", "body{--e2e-css:1}"]]);
  assert(r.ok && r.installed.id === "e2e-css" && r.level === "hot", JSON.stringify(r));
  await until("css applied", "getComputedStyle(document.body).getPropertyValue('--e2e-css').trim()==='1'");
  assert((await pageId()) === before, "the window reloaded");
});

await step("renderer edit hot-reloads in place", async () => {
  const dir = path.join(modsDir, "e2e-css");
  fs.writeFileSync(path.join(dir, "renderer.js"), "export const v = 1; export default (api) => { window.__e2e = 1; return () => { window.__e2e = 0; }; };");
  await until("renderer v1", `window.__e2e===1 && ${loaded("e2e-css")}`);
  const before = await pageId();
  fs.writeFileSync(path.join(dir, "renderer.js"), "export const v = 2; export default () => { window.__e2e = 2; };");
  await until("renderer v2", "window.__e2e===2 && window.__t3mods.exports['e2e-css'].v===2");
  assert((await pageId()) === before, "the window reloaded");
  const ms = await evaluate("window.__t3mods.lastHotUpdate?.ms");
  console.log(`     hot update took ${ms} ms in the renderer`);
});

await step("disable and enable through the manager API", async () => {
  await api("toggle", { id: "e2e-css", enabled: false });
  await until("unloaded", `!${loaded("e2e-css")} && getComputedStyle(document.body).getPropertyValue('--e2e-css').trim()===''`);
  await api("toggle", { id: "e2e-css", enabled: true });
  await until("loaded again", loaded("e2e-css"));
});

await step("a mod whose patch fails does not start, and the indicator shows it", async () => {
  await installZip([
    ["mod.json", JSON.stringify({ id: "e2e-broken" })],
    ["patches.cjs", "module.exports=[{id:'nowhere',find:'this text is in no chunk',replace:[{match:/x/,replace:'y'}]}]"],
    ["renderer.js", "export default () => { window.__e2eBroken = true; };"],
  ]);
  await until("index shows degraded", "fetch('/__mods/index.json').then(r=>r.json()).then(i=>i.mods.find(m=>m.id==='e2e-broken')?.status==='degraded')");
  await sleep(500);
  assert(!(await evaluate("window.__e2eBroken === true")), "renderer of a degraded mod ran");
  await until("indicator is red", "document.querySelector('.t3m-icon')?.dataset.tone==='bad' || !document.querySelector('.t3m-icon')");
});

await step("a mod that requires a broken patch does not start either", async () => {
  await installZip([["mod.json", JSON.stringify({ id: "e2e-dependent", requires: ["e2e-broken/nowhere"] })], ["style.css", ""]]);
  const m = await until("dependent degraded", "fetch('/__mods/index.json').then(r=>r.json()).then(i=>i.mods.find(m=>m.id==='e2e-dependent')).then(m=>m?.status==='degraded'&&m)");
  assert(m.problems.some((p) => p.includes("e2e-broken/nowhere")), JSON.stringify(m.problems));
});

await step("unsafe archives are refused", async () => {
  const r = await installZip([["mod.json", JSON.stringify({ id: "e2e-evil" })], ["../evil.js", ""]]);
  assert(!r.ok && /unsafe path/.test(r.error), JSON.stringify(r));
});

await step("Patch Helper finds the palette anchor", async () => {
  const r = await api("patch-test", { find: "value:`action:settings`", match: "(\\i)\\.push\\(\\{kind:`action`", replace: "$&" });
  assert(r.ok && r.results.length === 1, JSON.stringify(r));
});

await step("api.threads lists threads, and callRenderer reaches a mod's renderer exports", async () => {
  await installZip([
    ["mod.json", JSON.stringify({ id: "e2e-threads", requires: ["core/threads"] })],
    ["renderer.js", "let api; export default (a) => { api = a; }; export const probe = async (n) => { await api.threads.ready(); const list = api.threads.list(); return { n: n * 2, available: api.threads.available(), isArray: Array.isArray(list), keysOk: list.every((t) => t.key === t.ref.environmentId + '/' + t.ref.threadId) }; };"],
  ]);
  // An install can arrive as two watcher batches; the second reloads the mod, so wait for an answer.
  const out = await until("probe answers", "window.__t3mods?.callRenderer('e2e-threads', 'probe', [21]).then((o) => o.ok && o)", 15000);
  assert(out.ok && out.value.n === 42 && out.value.available && out.value.isArray && out.value.keysOk, JSON.stringify(out));
  const missing = await evaluate("window.__t3mods.callRenderer('e2e-threads', 'nope', [])");
  assert(!missing.ok && /no renderer export/.test(missing.error), JSON.stringify(missing));
});

await step("the loader serves a mod's .html page as HTML", async () => {
  const dir = path.join(modsDir, "e2e-threads");
  fs.writeFileSync(path.join(dir, "page.html"), "<!doctype html><title>e2e</title>");
  const type = await evaluate("fetch('/__mods/e2e-threads/page.html').then(r=>r.headers.get('content-type'))");
  assert(/^text\/html/.test(type), type);
});

await step("app identity: api.app matches the index, and main wrote its own health file", async () => {
  const idx = await evaluate("fetch('/__mods/index.json').then(r=>r.json())");
  assert(idx.app && typeof idx.app.id === "string" && idx.app.home, `no app in the index: ${JSON.stringify(idx.app)}`);
  console.log(`     app ${JSON.stringify(idx.app)}`);
  const runDir = path.join(modsDir, ".t3mods", "run");
  const health = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((n) => /^health-\d+\.json$/.test(n)) : [];
  assert(health.length >= 1, "no run/health-<pid>.json");
});

await step("mod state: a write from another app reaches the cell, and a page write changes only its own keys", async () => {
  await installZip([
    ["mod.json", JSON.stringify({ id: "e2e-state" })],
    [
      "renderer.js",
      "export default (api) => { const a = api.state.string('a', 'none'); const b = api.state.string('b', 'none'); const w = (window.__e2eState = { app: api.app, a, b, seenA: [], seenB: [] }); a.subscribe((v) => w.seenA.push(v)); b.subscribe((v) => w.seenB.push(v)); };",
    ],
  ]);
  await until("state mod loaded", `${loaded("e2e-state")} && !!window.__e2eState`, 15000);
  const idx = await evaluate("fetch('/__mods/index.json').then(r=>r.json())");
  assert((await evaluate("JSON.stringify(window.__e2eState.app)")) === JSON.stringify(idx.app), "api.app differs from the index");
  const file = path.join(modsDir, ".t3mods", "state", "e2e-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Another app writes key a.
  fs.writeFileSync(file, JSON.stringify({ a: "from-outside" }));
  await until("cell a follows the file", "window.__e2eState.a.get()==='from-outside' && window.__e2eState.seenA.join()==='from-outside'");
  // Another app writes key "other" and, at once, the page sets b. The page must not overwrite "other" or "a".
  fs.writeFileSync(file, JSON.stringify({ a: "from-outside", other: "kept" }));
  await evaluate("window.__e2eState.b.set('from-page')");
  const end = Date.now() + 8000;
  let saved = {};
  while (saved.b !== "from-page" && Date.now() < end) {
    await sleep(100);
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  assert(saved.b === "from-page" && saved.a === "from-outside" && saved.other === "kept", `state file: ${JSON.stringify(saved)}`);
  // The page's own save comes back through the watcher and must not notify again.
  await sleep(800);
  const seen = await evaluate("JSON.stringify([window.__e2eState.seenA, window.__e2eState.seenB])");
  assert(seen === JSON.stringify([["from-outside"], ["from-page"]]), `cell notifications: ${seen}`);
  // Another app removes a key: the cell goes back to its default.
  fs.writeFileSync(file, JSON.stringify({ a: "from-outside", other: "kept" }));
  await until("cell b unset", "window.__e2eState.b.get()==='none'");
});

await step("uninstall removes the test mods", async () => {
  for (const id of ["e2e-css", "e2e-broken", "e2e-dependent", "e2e-threads", "e2e-state"]) {
    const r = await api("uninstall", { id });
    assert(r.ok, `${id}: ${r.error}`);
  }
  await until("gone", `!${loaded("e2e-css")}`);
  await until("indicator back to normal", "document.querySelector('.t3m-icon')?.dataset.tone!=='bad'", 12000);
});

if (!registryUrl) console.log("SKIPPED registry steps (Browse, install, update, t3mods:// links): no --registry. Run `bun run e2e:registry` for them.");
if (registryUrl) {
  const field = (sel, text) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const click = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const indexMod = (id) => evaluate(`fetch('/__mods/index.json').then(r=>r.json()).then(i=>i.mods.find(m=>m.id===${JSON.stringify(id)})??null)`);
  const modIds = () => evaluate("fetch('/__mods/index.json').then(r=>r.json()).then(i=>i.mods.map(m=>m.id).join())");
  const runDir = path.join(modsDir, ".t3mods", "run");
  const confirms = () => (fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((n) => n.startsWith("confirm-")).map((n) => JSON.parse(fs.readFileSync(path.join(runDir, n), "utf8"))) : []);
  for (const f of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) if (f.startsWith("confirm-")) fs.rmSync(path.join(runDir, f));
  // A second process of the isolated instance, with a link as its argument. No --cdp, so it
  // cannot clash with the running instance's debug port.
  const launch = (link) => {
    const env = { ...process.env, APPDATA: path.join(profileDir, "appdata"), XDG_CONFIG_HOME: path.join(profileDir, "config"), T3CODE_HOME: path.join(profileDir, "home"), T3CODE_DISABLE_AUTO_UPDATE: "1", T3MODS_LOADER: path.resolve("loader/t3mods-loader.cjs"), T3MODS_DIR: modsDir, T3MODS_REGISTRY: registryUrl, T3MODS_TEST_CONFIRM: "install" };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(exeFile, [link], { env, stdio: "ignore" });
    const t0 = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => (child.kill(), resolve({ pid: child.pid, exited: false })), 25000);
      child.on("exit", (code) => (clearTimeout(timer), resolve({ pid: child.pid, exited: true, code, ms: Date.now() - t0 })));
    });
  };

  // The isolated profile is signed out, so the app redirects every /settings route to the
  // welcome screen. Mount the Mods page (the settings-mods slot) into a host element instead.
  const mountMods = () =>
    evaluate(`(async () => {
      document.getElementById("e2e-host")?.remove();
      const R = await window.__t3mods.get("React");
      const { createRoot } = await window.__t3mods.get("ReactDOMClient");
      const host = document.createElement("div");
      host.id = "e2e-host";
      document.body.append(host);
      createRoot(host).render(R.createElement(window.__t3mods.exports.core.SettingsPage));
      return true;
    })()`);

  await step("Browse: search, tier warning, install through the fake registry", async () => {
    await mountMods();
    await until("browse card", "!!document.querySelector('[data-t3m=browse] [data-t3m-result]')", 15000);
    await field("[data-t3m=browse-q]", "demo");
    await click("[data-t3m=browse-go]");
    await until("filtered results", "!!document.querySelector('[data-t3m-result=e2e-reg-demo]') && !document.querySelector('[data-t3m-result=e2e-reg-server]')");
    const card = await evaluate("document.querySelector('[data-t3m-result=e2e-reg-demo]').innerText");
    assert(/Registry demo/.test(card) && /@alice/.test(card) && /1\.0\.0/.test(card) && /downloads/.test(card) && /4\.5/.test(card) && /Styles/.test(card), card);
    await field("[data-t3m=browse-q]", "e2e-reg");
    await click("[data-t3m=browse-go]");
    await until("both results", "!!document.querySelector('[data-t3m-result=e2e-reg-server] [data-t3m-warning=server]')");
    assert(!(await evaluate("!!document.querySelector('[data-t3m-result=e2e-reg-demo] [data-t3m-warning]')")), "a CSS-only mod got a code warning");
    assert(await click("[data-t3m-install=e2e-reg-demo]"), "no Install button");
    await until("installed badge", "!!document.querySelector('[data-t3m-installed=e2e-reg-demo]')");
    await until("css applied", "getComputedStyle(document.body).getPropertyValue('--e2e-reg').trim()==='1'");
    const m = await indexMod("e2e-reg-demo");
    assert(m.source.source === "registry:e2e-reg-demo@1.0.0" && m.source.registry === registryUrl && m.source.version === "1.0.0", JSON.stringify(m.source));
  });

  await step("Browse: an update is offered and applied", async () => {
    const r = await fetch(`${registryUrl}/__e2e/publish`, { method: "POST", body: JSON.stringify({ id: "e2e-reg-demo", version: "1.1.0", files: { "style.css": "body{--e2e-reg:2}" } }) });
    assert(r.ok, `fake registry publish: HTTP ${r.status}`);
    await mountMods();
    await until("browse card", "!!document.querySelector('[data-t3m=browse-q]')", 15000);
    await field("[data-t3m=browse-q]", "e2e-reg-demo");
    await click("[data-t3m=browse-go]");
    await until("update button", "!!document.querySelector('[data-t3m-update=e2e-reg-demo]')", 15000);
    await click("[data-t3m-update=e2e-reg-demo]");
    await until("v1.1.0 applied", "getComputedStyle(document.body).getPropertyValue('--e2e-reg').trim()==='2'");
    assert((await indexMod("e2e-reg-demo")).version === "1.1.0", "version after update");
  });

  await step("t3mods:// link: a second launch hands over to the running instance", async () => {
    assert(exeFile && profileDir, "--exe and --profile are needed for this step");
    // Record the router calls: the signed-out profile redirects /settings/mods to the welcome
    // screen, so the proof that the loader asked for the Mods page is the call itself.
    await evaluate("(() => { document.getElementById('e2e-host')?.remove(); window.__e2eNav = []; const r = window.__TSR_ROUTER__; const nav = r.navigate.bind(r); r.navigate = (o) => (window.__e2eNav.push(o?.to), nav(o)); return true; })()");
    const before = confirms().length;
    const second = await launch("t3mods://install/e2e-reg-server@1.0.0");
    assert(second.exited, "the second process did not exit by itself (it may be a second full instance)");
    console.log(`     second process ${second.pid} exited after ${second.ms} ms`);
    const end = Date.now() + 15000;
    while (confirms().length === before && Date.now() < end) await sleep(200);
    const [c] = confirms().slice(before);
    assert(c, "no confirm dialog in the running instance");
    assert(c.pid !== second.pid, "the dialog came from the second process");
    assert(fs.existsSync(path.join(runDir, `server-${c.pid}.json`)), `pid ${c.pid} is not the running instance's main process`);
    const o = c.options;
    assert(o.buttons[0] === "Cancel" && o.defaultId === 0 && o.cancelId === 0, `Cancel must be the default: ${JSON.stringify(o.buttons)} ${o.defaultId}`);
    assert(/Registry server demo/.test(o.message) && /@alice/.test(o.detail) && /1\.0\.0/.test(o.detail), o.detail);
    assert(/backend/.test(o.detail) && /full access/.test(o.detail), `no code warning: ${o.detail}`);
    assert(/sha256 [0-9a-f]{16}/.test(o.detail) && o.detail.includes(new URL(registryUrl).host), o.detail);
    await until("installed", "fetch('/__mods/index.json').then(r=>r.json()).then(i=>i.mods.some(m=>m.id==='e2e-reg-server'&&m.source?.registry))", 15000);
    await until("asked the router for the Mods page", "window.__e2eNav.includes('/settings/mods')");
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page" && t.url.startsWith("t3code://app") && !t.url.includes("/__mods/"));
    assert(pages.length === 1, `${pages.length} app windows`);
  });

  await step("t3mods:// link: bad links change nothing", async () => {
    const before = confirms().length;
    const mods = await modIds();
    for (const bad of ["t3mods://install/../x", "t3mods://remove/e2e-reg-demo", "t3mods://install/E2E"]) await launch(bad);
    await sleep(1500);
    assert(confirms().length === before, "a bad link reached the confirm dialog");
    assert((await modIds()) === mods, "mods changed");
  });

  await step("Browse: a patches.cjs mod gets the full-access warning and a confirm dialog", async () => {
    const r = await fetch(`${registryUrl}/__e2e/publish`, { method: "POST", body: JSON.stringify({ id: "e2e-reg-patch", version: "1.0.0", files: { "patches.cjs": "module.exports = [];" } }) });
    assert(r.ok, `fake registry publish: HTTP ${r.status}`);
    await mountMods();
    await until("browse card", "!!document.querySelector('[data-t3m=browse-q]')", 15000);
    await field("[data-t3m=browse-q]", "e2e-reg-patch");
    await click("[data-t3m=browse-go]");
    await until("patch card", "!!document.querySelector('[data-t3m-result=e2e-reg-patch] [data-t3m-warning=patches]')", 15000);
    const before = confirms().length;
    assert(await click("[data-t3m-install=e2e-reg-patch]"), "no Install button");
    await until("installed badge", "!!document.querySelector('[data-t3m-installed=e2e-reg-patch]')");
    const [c] = confirms().slice(before);
    assert(c, "Browse installed a patches mod without a confirm dialog");
    assert(c.options.type === "warning" && /main process/.test(c.options.detail) && /trust its author/.test(c.options.detail), c.options.detail);
  });

  await step("registry test mods are removed", async () => {
    for (const id of ["e2e-reg-demo", "e2e-reg-server", "e2e-reg-patch"]) {
      const r = await api("uninstall", { id });
      assert(r.ok, `${id}: ${r.error}`);
    }
  });
}

ws.close();
console.log(failures ? `${failures} failed` : registryUrl ? "all passed" : "all passed, but the registry steps did not run (bun run e2e:registry)");
process.exit(failures ? 1 : 0);
