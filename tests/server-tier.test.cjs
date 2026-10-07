// Starts the loader the way the backend does (a --require in a Node process whose argv names
// apps/server/dist/bin.mjs) and calls a server mod through the RPC endpoint.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const loader = path.join(__dirname, "..", "loader", "t3mods-loader.cjs");

function startBackend(modsDir, env = {}) {
  const fakeBin = path.join(modsDir, "..", "apps", "server", "dist", "bin.mjs");
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.writeFileSync(fakeBin, "setInterval(() => {}, 1000);\n");
  return spawn(process.execPath, ["--require", loader, fakeBin], {
    env: { ...process.env, T3MODS_DIR: modsDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

test("server mods load, answer RPC with the token, and refuse without it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-server-"));
  const mods = path.join(root, "mods");
  fs.mkdirSync(path.join(mods, "echo"), { recursive: true });
  fs.writeFileSync(path.join(mods, "echo", "server.cjs"), "module.exports = (ctx) => ({ echo: (x) => ({ x, id: ctx.id, token: process.env.T3MODS_RPC_TOKEN ?? null }) });");
  const child = startBackend(mods, { T3MODS_RPC_TOKEN: "secret-token-0123456789", T3MODS_MAIN_PID: "4242" });
  t.after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runFile = path.join(mods, ".t3mods", "run", "server-4242.json");
  const { port } = await waitFor(() => fs.existsSync(runFile) && JSON.parse(fs.readFileSync(runFile, "utf8")));
  const call = (token) =>
    fetch(`http://127.0.0.1:${port}/echo/echo`, { method: "POST", headers: { "x-t3mods-token": token }, body: JSON.stringify([7]) }).then(async (r) => [r.status, await r.json()]);

  const [status, body] = await call("secret-token-0123456789");
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, value: { x: 7, id: "echo", token: null } }, "the token is not left in the backend's env");
  assert.equal((await call("wrong-token-0123456789x"))[0], 403);
});

// A server mod that leaves a marker file while it is loaded.
function markerMod(mods) {
  fs.mkdirSync(path.join(mods, "mark"), { recursive: true });
  fs.writeFileSync(
    path.join(mods, "mark", "server.cjs"),
    "const fs = require('node:fs'), path = require('node:path'); const f = path.join(__dirname, 'loaded'); module.exports = () => { fs.writeFileSync(f, '1'); return () => fs.rmSync(f, { force: true }); };",
  );
  return path.join(mods, "mark", "loaded");
}
const writeHealth = (file, status) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mark: { status, problems: [] } }));
};

test("a backend follows the health file of its own main process, not the last one written", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-server-"));
  const mods = path.join(root, "mods");
  const marker = markerMod(mods);
  const meta = path.join(mods, ".t3mods");
  // Another app's main wrote health.json last and calls the mod fine; this app's main says degraded.
  writeHealth(path.join(meta, "health.json"), "ok");
  writeHealth(path.join(meta, "run", "health-4242.json"), "degraded");
  const child = startBackend(mods, { T3MODS_RPC_TOKEN: "secret-token-0123456789", T3MODS_MAIN_PID: "4242" });
  t.after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(path.join(meta, "run", "server-4242.json")));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(marker), false, "the mod started although this app's health says degraded");
  writeHealth(path.join(meta, "run", "health-4242.json"), "ok");
  await waitFor(() => fs.existsSync(marker));
  // The other app's file does not stop it, and its own file does.
  writeHealth(path.join(meta, "health.json"), "degraded");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(marker), true, "another app's health.json unloaded the mod");
  writeHealth(path.join(meta, "run", "health-4242.json"), "degraded");
  await waitFor(() => !fs.existsSync(marker));
});

test("without a health file of its own (an older main process), a backend falls back to health.json", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-server-"));
  const mods = path.join(root, "mods");
  const marker = markerMod(mods);
  const meta = path.join(mods, ".t3mods");
  writeHealth(path.join(meta, "health.json"), "degraded");
  const child = startBackend(mods, { T3MODS_RPC_TOKEN: "secret-token-0123456789", T3MODS_MAIN_PID: "4243" });
  t.after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(path.join(meta, "run", "server-4243.json")));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(marker), false);
  writeHealth(path.join(meta, "health.json"), "ok");
  await waitFor(() => fs.existsSync(marker));
});

test("ctx.app in a server mod names the app that started the backend", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-server-"));
  const mods = path.join(root, "mods");
  fs.mkdirSync(path.join(mods, "who"), { recursive: true });
  fs.writeFileSync(path.join(mods, "who", "server.cjs"), "module.exports = (ctx) => ({ app: () => ctx.app });");
  const home = path.join(root, ".t3-work");
  const child = startBackend(mods, { T3MODS_RPC_TOKEN: "secret-token-0123456789", T3MODS_MAIN_PID: "4244", T3CODE_HOME: home, T3MODS_APP_NAME: "" });
  t.after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runFile = path.join(mods, ".t3mods", "run", "server-4244.json");
  const { port } = await waitFor(() => fs.existsSync(runFile) && JSON.parse(fs.readFileSync(runFile, "utf8")));
  const res = await fetch(`http://127.0.0.1:${port}/who/app`, { method: "POST", headers: { "x-t3mods-token": "secret-token-0123456789" }, body: "[]" });
  const { value } = await res.json();
  assert.deepEqual(value, require("../loader/platform.cjs").appInfo({ T3CODE_HOME: home }, os.homedir()));
  assert.equal(value.name, "Work");
});

test("a broken server mod does not stop the backend", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-server-"));
  const mods = path.join(root, "mods");
  fs.mkdirSync(path.join(mods, "bad"), { recursive: true });
  fs.writeFileSync(path.join(mods, "bad", "server.cjs"), "throw new Error('bad mod');");
  const child = startBackend(mods);
  t.after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(exited, false);
});
