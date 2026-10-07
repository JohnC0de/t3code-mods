const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classifyUpdaterSpawn, appImageVersion, clientAssetsDir, cleanEnv } = require("../loader/platform.cjs");

test("a relaunched app gets the user's NODE_OPTIONS back, not the loader's", () => {
  const loaderEnv = { PATH: "/usr/bin", NODE_OPTIONS: '--require "/k/t3mods-loader.cjs"', T3MODS_RPC_TOKEN: "t", T3MODS_MAIN_PID: "1" };
  const none = cleanEnv({ ...loaderEnv, T3MODS_PREV_NODE_OPTIONS: "" });
  assert.deepEqual(none, { PATH: "/usr/bin" });
  const own = cleanEnv({ ...loaderEnv, NODE_OPTIONS: '--max-old-space-size=4096 --require "/k/t3mods-loader.cjs"', T3MODS_PREV_NODE_OPTIONS: "--max-old-space-size=4096" });
  assert.equal(own.NODE_OPTIONS, "--max-old-space-size=4096");
  // Without the loader's marker, NODE_OPTIONS is the user's own and stays.
  assert.equal(cleanEnv({ NODE_OPTIONS: "--inspect" }).NODE_OPTIONS, "--inspect");
});

test("updater spawns: NSIS installer, new AppImage, and everything else", () => {
  const launcher = { T3MODS_LAUNCHER: "/home/u/.local/bin/t3code-mods" };
  assert.equal(classifyUpdaterSpawn("win32", ["--updated", "/S", "--force-run"], {}, {}), "windows-installer");
  assert.equal(classifyUpdaterSpawn("win32", ["/S"], {}, {}), "pass");
  const appimage = { detached: true, env: { APPIMAGE_SILENT_INSTALL: "true" } };
  assert.equal(classifyUpdaterSpawn("linux", [], appimage, launcher), "appimage");
  // Without the launcher (app started from the AppImage itself) there is nothing to hand over to.
  assert.equal(classifyUpdaterSpawn("linux", [], appimage, {}), "pass");
  // Agents and terminals spawned by the app must never be redirected.
  assert.equal(classifyUpdaterSpawn("linux", ["-c", "ls"], { env: { PATH: "/usr/bin" } }, launcher), "pass");
  assert.equal(classifyUpdaterSpawn("linux", ["--updated"], {}, launcher), "pass");
});

test("AppImage versions come from the release file name", () => {
  assert.equal(appImageVersion("/home/u/Downloads/T3-Code-0.0.46-nightly.20261005.2702-x86_64.AppImage"), "0.0.46-nightly.20261005.2702");
  assert.equal(appImageVersion("T3-Code-0.1.0-arm64.AppImage"), "0.1.0");
  assert.equal(appImageVersion("/home/u/t3code.AppImage"), null);
});

test("client chunks: server.asar (Windows) before the renamed app asar (Linux)", () => {
  // The test uses plain folders named *.asar; Electron's Node (used in the Linux tests) would
  // read them as archives.
  process.noAsar = true;
  const res = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-res-"));
  const rel = path.join("apps", "server", "dist", "client", "assets");
  assert.equal(clientAssetsDir(res), null);
  fs.mkdirSync(path.join(res, "_app.asar", rel), { recursive: true });
  assert.equal(clientAssetsDir(res), path.join(res, "_app.asar", rel));
  fs.mkdirSync(path.join(res, "server.asar", rel), { recursive: true });
  assert.equal(clientAssetsDir(res), path.join(res, "server.asar", rel));
});
