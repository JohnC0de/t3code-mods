// app-badge: title rewrite and the no-op for the nameless app, against a fake Electron.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const entry = require(path.join(__dirname, "..", "mods", "app-badge", "main.cjs"));

function fakeWindow(title) {
  const w = new EventEmitter();
  w.title = title;
  w.getTitle = () => w.title;
  w.setTitle = (t) => (w.title = t);
  w.setOverlayIcon = () => {};
  w.isDestroyed = () => false;
  w.webContents = Object.assign(new EventEmitter(), { getURL: () => "t3code://app/#/x" });
  return w;
}

function start(name, w) {
  const app = Object.assign(new EventEmitter(), { whenReady: () => Promise.resolve() });
  // The letter render fails here (no Electron), so the plain disc is the overlay image.
  const BrowserWindow = Object.assign(function () { throw new Error("no electron"); }, { getAllWindows: () => [w] });
  const electron = { app, BrowserWindow, nativeImage: { createFromBitmap: () => ({}) } };
  const ctx = { app: { id: "x", name, home: "" }, electron, log() {} };
  entry(ctx);
  return new Promise((r) => setImmediate(r));
}

test("a named app gets T3 <name> in place of the app's own name, or appended", async () => {
  for (const [from, to] of [
    ["T3 Code (Nightly)", "T3 Beta"],
    ["T3 Code", "T3 Beta"],
    ["Thread - T3 Code (Nightly)", "Thread - T3 Beta"],
    ["Settings", "Settings — T3 Beta"],
    ["T3 Beta", "T3 Beta"],
  ]) {
    const w = fakeWindow(from);
    await start("Beta", w);
    assert.equal(w.title, to);
    // A later title from the page is rewritten too, and the default title is blocked.
    let blocked = false;
    w.emit("page-title-updated", { preventDefault: () => (blocked = true) }, "Other - T3 Code (Nightly)");
    assert.ok(blocked);
    assert.equal(w.title, "Other - T3 Beta");
  }
});

test("the nameless app keeps its title", async () => {
  const w = fakeWindow("T3 Code (Nightly)");
  const keep = { T3MODS_APP_NAME: process.env.T3MODS_APP_NAME, T3CODE_HOME: process.env.T3CODE_HOME };
  delete process.env.T3MODS_APP_NAME;
  delete process.env.T3CODE_HOME;
  try {
    await start(null, w);
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v;
  }
  assert.equal(w.title, "T3 Code (Nightly)");
  assert.equal(w.listenerCount("page-title-updated"), 0);
});
