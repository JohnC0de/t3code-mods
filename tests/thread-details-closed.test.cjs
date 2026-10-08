// thread-details-closed: the patched right panel store keeps the thread details panel closed by
// default and remembers threads where it was opened. The store code below is T3's minified
// code, cut down to the panel visibility parts; the last test runs the patches on a real bundle.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const asar = require("../loader/asar.cjs");
const P = require("../loader/patcher.cjs");

const root = path.join(__dirname, "..");
const patches = () => P.normalize("thread-details-closed", require("../mods/thread-details-closed/patches.cjs"));
const realAsar = path.join(root, "sandbox", "app", "resources", "server.asar");
const ASSETS = "apps/server/dist/client/assets";

const STORE =
  "var d=e=>e,E={inlineOpen:!0,popoverOpen:!1};" +
  "function G(e,t){return t?e[d(t)]??E:E}" +
  "var I=(e,t,n)=>{let r=e[t]??E,i=n(r);if(i.inlineOpen&&!i.popoverOpen){if(!(t in e))return e;let{[t]:n,...r}=e;return r}return i===r?e:{...e,[t]:i}};" +
  "var partialize=e=>({threadPanelVisibilityByThreadKey:Object.fromEntries(Object.entries(e.threadPanelVisibilityByThreadKey).flatMap(([e,t])=>t.inlineOpen?[]:[[e,{inlineOpen:!1,popoverOpen:!1}]]))});" +
  "function H(e){return{threadPanelVisibilityByThreadKey:`threadPanelVisibilityByThreadKey`in e&&e.threadPanelVisibilityByThreadKey&&typeof e.threadPanelVisibilityByThreadKey==`object`?Object.fromEntries(Object.entries(e.threadPanelVisibilityByThreadKey).flatMap(([e,t])=>!t||typeof t!=`object`||!(`inlineOpen`in t)?[]:t.inlineOpen===!1?[[e,{inlineOpen:!1,popoverOpen:!1}]]:[])):{}}}";

// The thread details card's layout effect, as in the chat chunk.
const EFFECT = "/*data-thread-details-card*/var P=()=>{a(d),d===`inline`&&h&&gc.getState().setThreadPanelOpen(n,`popover`,!1)};";

// As the loader serves a chunk.
const patch = (text) => P.applyAll(patches(), text, () => true);

// A store like T3's: the panel state lives in `vis`; the actions are the store's own.
function makeStore(code, saved) {
  const ctx = vm.createContext({});
  vm.runInContext(`${code};this.api={G,I,partialize,H,d}`, ctx);
  const { G, I, partialize, H, d } = ctx.api;
  let vis = saved ? H(JSON.parse(saved)).threadPanelVisibilityByThreadKey : {};
  const store = {
    open: (key) => G(vis, key).inlineOpen,
    popover: (key) => G(vis, key).popoverOpen,
    has: (key) => key in vis,
    toggleThreadPanel: (key) => (vis = I(vis, d(key), (e) => ({ ...e, inlineOpen: !e.inlineOpen }))),
    setThreadPanelOpen: (key, n, r) =>
      (vis = I(vis, d(key), (e) => {
        const k = n === "inline" ? "inlineOpen" : "popoverOpen";
        return e[k] === r ? e : { ...e, [k]: r };
      })),
    save: () => JSON.stringify(partialize({ threadPanelVisibilityByThreadKey: vis })),
  };
  return store;
}

test("unpatched store: the panel opens by default (the fixture is T3's behavior)", () => {
  const s = makeStore(STORE);
  assert.equal(s.open("t1"), true);
});

test("both patches apply to T3's code shape", () => {
  const report = P.doctor(patches(), [{ name: "chunk.js", text: STORE + EFFECT }]);
  assert.deepEqual(
    report.results.map((r) => [r.id, r.status, r.entries]),
    [
      ["default-closed", "ok", [true, true, true, true]],
      ["popover-to-inline", "ok", [true]],
    ],
  );
});

test("patched: closed by default; an opened thread stays open and is saved, a closed one is pruned", () => {
  const s = makeStore(patch(STORE));
  assert.equal(s.open("t1"), false);
  assert.equal(s.popover("t1"), false);
  assert.equal(s.save(), '{"threadPanelVisibilityByThreadKey":{}}');

  s.toggleThreadPanel("t1");
  assert.equal(s.open("t1"), true, "an opened panel must not be pruned as the default");
  assert.equal(s.open("t2"), false, "other threads stay closed");
  const saved = s.save();
  assert.deepEqual(JSON.parse(saved).threadPanelVisibilityByThreadKey, { t1: { inlineOpen: true, popoverOpen: false } });

  const reloaded = makeStore(patch(STORE), saved);
  assert.equal(reloaded.open("t1"), true, "the open thread survives a reload");

  s.toggleThreadPanel("t1");
  assert.equal(s.open("t1"), false);
  assert.equal(s.has("t1"), false, "closing returns the thread to the default");
  assert.equal(s.save(), '{"threadPanelVisibilityByThreadKey":{}}');
});

test("patched: closed entries saved before the mod are dropped; an open popover is kept but not saved", () => {
  const before = JSON.stringify({ threadPanelVisibilityByThreadKey: { old: { inlineOpen: false, popoverOpen: false } } });
  const s = makeStore(patch(STORE), before);
  assert.equal(s.has("old"), false);
  assert.equal(s.open("old"), false);

  s.setThreadPanelOpen("t1", "popover", true);
  assert.equal(s.popover("t1"), true);
  assert.equal(s.save(), '{"threadPanelVisibilityByThreadKey":{}}');
});

test("patched: an open popover that becomes the inline panel stays open", () => {
  const ctx = vm.createContext({});
  const s = makeStore(patch(STORE));
  const text = patch(EFFECT);
  s.setThreadPanelOpen("t1", "popover", true);
  Object.assign(ctx, { a() {}, d: "inline", h: true, n: "t1", gc: { getState: () => s } });
  vm.runInContext(`${text};P()`, ctx);
  assert.equal(s.open("t1"), true);
  assert.equal(s.popover("t1"), false);

  const s2 = makeStore(patch(STORE));
  Object.assign(ctx, { h: false, gc: { getState: () => s2 } });
  vm.runInContext(`${text};P()`, ctx);
  assert.equal(s2.open("t1"), false, "a closed popover does not open the inline panel");
});

test("on the sandbox app's bundle both patches apply to one chunk each and the chunks still parse", { skip: !fs.existsSync(realAsar) && "no sandbox app" }, () => {
  // All client chunks, so `find` must select exactly one. One header read: asar.readFile parses
  // the header on each call, which takes 20 s over 2,000+ chunks.
  const { header, dataOffset } = asar.readHeader(realAsar);
  const files = asar.entryOf(header, ASSETS).files;
  const fd = fs.openSync(realAsar, "r");
  const chunks = Object.keys(files)
    .filter((n) => n.endsWith(".js"))
    .map((name) => {
      const buf = Buffer.alloc(files[name].size);
      fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(files[name].offset));
      return { name, text: buf.toString("utf8") };
    });
  fs.closeSync(fd);
  const report = P.doctor(patches(), chunks);
  assert.deepEqual(
    report.results.map((r) => [r.id, r.status]),
    [
      ["default-closed", "ok"],
      ["popover-to-inline", "ok"],
    ],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-tdc-"));
  try {
    for (const r of report.results) {
      const name = r.chunks[0];
      const out = path.join(dir, name.replace(/\.js$/, ".mjs"));
      fs.writeFileSync(out, patch(chunks.find((c) => c.name === name).text));
      const check = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
