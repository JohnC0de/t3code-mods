// Paths and decisions that differ by OS, shared by the CLI and the loader. No Electron here.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// The kit: a per-user copy of the loader, CLI and helper scripts. The shim in the app folder
// loads the loader from here, so loader updates never need to touch the app folder (which
// is root-owned on Linux packages and replaced by every app update).
const kitHome = () => process.env.T3MODS_HOME || path.join(os.homedir(), ".t3", "t3mods");

// User data for Linux AppImage installs: extracted app versions and the launcher state.
const dataHome = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "t3mods");

// The web client's JS chunks. Windows ships them in server.asar; Linux (and macOS) in the
// app asar, which the loader renames to _app.asar.
function clientAssetsDir(resourcesPath) {
  const rel = path.join("apps", "server", "dist", "client", "assets");
  const candidates = ["server.asar", "_app.asar", "app.asar"].map((a) => path.join(resourcesPath, a, rel));
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}

// Where Linux packages put the app. AppImage installs live under dataHome() instead.
const LINUX_SYSTEM_DIRS = ["/opt/T3 Code (Nightly)", "/opt/T3 Code", "/opt/t3code-nightly-bin", "/opt/t3code-bin"];

const APPIMAGE_NAME = /^T3-Code-(.+)-(x86_64|arm64|aarch64)\.AppImage$/;
const appImageVersion = (file) => APPIMAGE_NAME.exec(path.basename(file))?.[1] ?? null;

// electron-updater starts the app update with child_process.spawn. Decides what the loader
// does with one spawn call:
//   "windows-installer": the NSIS installer (`--updated`); the post-update task reinstalls.
//   "appimage": the new AppImage after an update, when the app runs from the t3mods launcher;
//               the launcher extracts and patches the new version, then starts it.
//   "pass": anything else.
function classifyUpdaterSpawn(platform, args, options, env) {
  if (platform === "win32" && Array.isArray(args) && args.includes("--updated")) return "windows-installer";
  if (platform === "linux" && options?.env?.APPIMAGE_SILENT_INSTALL === "true" && env.T3MODS_LAUNCHER) return "appimage";
  return "pass";
}

// The environment a new app process should start with: this process's, minus what the
// loader added (its NODE_OPTIONS --require and the per-run RPC values). Otherwise the next
// app would pass the --require on to agents and terminals.
function cleanEnv(env) {
  const out = { ...env };
  const prev = out.T3MODS_PREV_NODE_OPTIONS;
  if (prev) out.NODE_OPTIONS = prev;
  else if (prev !== undefined) delete out.NODE_OPTIONS;
  for (const k of ["T3MODS_PREV_NODE_OPTIONS", "T3MODS_RPC_TOKEN", "T3MODS_MAIN_PID"]) delete out[k];
  return out;
}

// Which T3 Code app this is. Several apps can run at once, each with its own data folder
// (T3CODE_HOME), and share one mods folder. The default app uses ~/.t3. Pure, so the main
// process and the backend (which inherits T3CODE_HOME and T3MODS_APP_NAME) get the same answer.
function appInfo(env, homedir, platform = process.platform) {
  const fold = (p) => (platform === "win32" ? p.toLowerCase() : p);
  const home = env.T3CODE_HOME ? path.resolve(env.T3CODE_HOME) : path.join(homedir, ".t3");
  const isDefault = fold(home) === fold(path.join(homedir, ".t3"));
  const id = isDefault ? "default" : crypto.createHash("sha1").update(fold(home)).digest("hex").slice(0, 8);
  // ".t3-work" -> "Work", "t3code-dev" -> "Dev"; a folder that is only the prefix keeps its name.
  const base = path.basename(home).replace(/^\.+/, "");
  const word = base.replace(/^t3(code)?-/i, "") || base;
  const derived = word ? word[0].toUpperCase() + word.slice(1) : null;
  const named = env.T3MODS_APP_NAME?.trim();
  return { id, name: named || (isDefault ? null : derived), home };
}

module.exports = { kitHome, dataHome, clientAssetsDir, LINUX_SYSTEM_DIRS, APPIMAGE_NAME, appImageVersion, classifyUpdaterSpawn, cleanEnv, appInfo };
