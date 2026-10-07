// `t3mods install` and `uninstall` on a fake Windows app folder: the shim switch, the
// junction for the unpacked files, and the refusal while the app holds app.asar open.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const cli = path.join(__dirname, "..", "loader", "t3mods.mjs");
const skip = process.platform !== "win32" && "Windows install layout";

function fakeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-app-"));
  const res = path.join(dir, "resources");
  fs.mkdirSync(path.join(res, "app.asar.unpacked", "native"), { recursive: true });
  fs.writeFileSync(path.join(res, "app.asar.unpacked", "native", "keyring.node"), "native");
  fs.writeFileSync(path.join(res, "app.asar"), "original bundle");
  fs.writeFileSync(path.join(dir, "T3 Code (Nightly).exe"), "");
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-kit-"));
  // T3MODS_POST_UPDATE: no scheduled task for a test kit.
  const run = (cmd) =>
    spawnSync(process.execPath, [cli, cmd, "--app", dir], { encoding: "utf8", env: { ...process.env, T3MODS_HOME: kit, T3MODS_POST_UPDATE: "1" } });
  return { res, run, p: (n) => path.join(res, n) };
}

test("install switches to the shim and links the unpacked files; uninstall restores them", { skip }, () => {
  const { run, p } = fakeApp();
  const install = run("install");
  assert.equal(install.status, 0, install.stderr);
  assert.ok(!fs.existsSync(p("app.asar")), "Electron would load app.asar before the shim");
  assert.equal(fs.readFileSync(p("_app.asar"), "utf8"), "original bundle");
  assert.equal(fs.readFileSync(p("app/index.cjs"), "utf8"), fs.readFileSync(path.join(__dirname, "..", "loader", "shim-index.cjs"), "utf8"));
  // A running app may hold its native modules locked, so they stay in place behind a junction.
  assert.ok(fs.lstatSync(p("_app.asar.unpacked")).isSymbolicLink());
  assert.equal(fs.readFileSync(p("_app.asar.unpacked/native/keyring.node"), "utf8"), "native");
  assert.match(install.stdout, /: installed/);

  // Again on an installed folder: no change but the shim.
  assert.equal(run("install").status, 0);
  assert.equal(fs.readFileSync(p("_app.asar"), "utf8"), "original bundle");

  const uninstall = run("uninstall");
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.readFileSync(p("app.asar"), "utf8"), "original bundle");
  assert.ok(!fs.existsSync(p("app")) && !fs.existsSync(p("_app.asar.unpacked")));
  // Removing the junction must not remove what it points to.
  assert.equal(fs.readFileSync(p("app.asar.unpacked/native/keyring.node"), "utf8"), "native");
});

test("install while the app holds app.asar fails and leaves the app as it was", { skip }, async () => {
  const { run, p } = fakeApp();
  // Like Electron: app.asar open without delete sharing, so it cannot be renamed.
  const holder = spawn("powershell", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${p("app.asar")}', 'Open', 'Read', 'Read'); 'open'; Start-Sleep 60`]);
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.on("data", (d) => String(d).includes("open") && resolve());
      holder.on("exit", () => reject(new Error("the holder exited early")));
    });
    const install = run("install");
    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /T3 Code is running; quit it first/);
    // app.asar still wins over the shim, so the open app and its next start run unmodded.
    assert.equal(fs.readFileSync(p("app.asar"), "utf8"), "original bundle");
    assert.equal(fs.readFileSync(p("app.asar.unpacked/native/keyring.node"), "utf8"), "native");
  } finally {
    holder.kill();
  }
  // Once the app quits, install completes.
  await new Promise((r) => (holder.exitCode !== null ? r() : holder.on("exit", r)));
  assert.equal(run("install").status, 0);
  assert.equal(fs.readFileSync(p("_app.asar"), "utf8"), "original bundle");
});

test("install refuses a folder without a bundle (an update installer is mid-way)", { skip }, () => {
  const { run, p } = fakeApp();
  fs.rmSync(p("app.asar"));
  const install = run("install");
  assert.notEqual(install.status, 0);
  assert.match(install.stderr, /is an update installing/);
  assert.ok(!fs.existsSync(p("app")), "a shim here could make the installer abort");
});
