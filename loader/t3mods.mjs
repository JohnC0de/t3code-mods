#!/usr/bin/env node
// t3mods CLI. Run without arguments for help.
// install puts a small shim into the app's resources folder (the original app.asar becomes
// _app.asar). The shim loads the loader from the kit (~/.t3/t3mods), which install also
// refreshes, so the app folder only ever holds the shim.
//   Windows          resources/app; a scheduled task reinstalls after each app update.
//   Linux AppImage   extracted into ~/.local/share/t3mods/appimage, started by a launcher
//                    (~/.local/bin/t3code-mods) that prepares each new AppImage version.
//   Linux packages   (.deb, AUR, /opt): one sudo step; dpkg-divert or pacman hooks keep the
//                    shim through updates (loader/linux/system.sh).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const HELP = `t3mods <command> [options]

  status                     Is the loader installed in T3 Code?
  install | uninstall        Add or remove the loader (Windows: quit T3 Code first)
  kit                        Refresh the kit copy (and the Windows post-update task) only
  new <id>                   Create a mod folder from a template
  list                       Mods in the mods folder and their state
  search <words>             Search the registry (T3MODS_REGISTRY overrides the URL)
  add <id>[@version]         Install a mod from the registry (checks its sha256)
  add <file.zip | https-url> Install a mod archive
  update [id] [--yes]        Update mods installed from the registry; --yes accepts new
                             code tiers (main, server, patches) without asking
  publish <dir> [--changelog <text>]
                             Publish a mod folder to the registry (needs login or T3MODS_TOKEN)
  login                      Check a registry token and save it (~/.t3/t3mods-registry.json).
                             Reads it from T3MODS_TOKEN or stdin, not from the command line
                             (which shell history keeps)
  pack <mod-dir> [out.zip]   Zip a mod folder for sharing
  doctor [--assets <dir>] [--server-dist <dir>]
                             Check all patches against the installed build, or against
                             extracted chunks (tools/extract-assets.cjs also writes <dir>/server)
  server-patch [--undo]      Windows: write the mods' server patches into server.asar, so
                             they apply without the loader. With the loader installed, its
                             post-update task re-applies them; without it, run this again
                             after each app update
  dev [--isolated] [--copy-data] [--profile <dir>] [--cdp <port>]
                             Start T3 Code with the loader from this folder.
                             --isolated uses a separate profile (no real threads or sign-in);
                             --copy-data copies threads and settings into it once

Options:
  --app <install dir>        T3 Code folder (found automatically in the usual places)
  --appimage <file>          Linux: use this AppImage
  --mods <mods dir>          Mods folder (default ~/.t3/mods)`;

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const platform = require("./platform.cjs");
const kitHome = platform.kitHome();
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";
// Everything the kit holds: the loader and its files, the CLI and the helper scripts.
const KIT = ["t3mods-loader.cjs", "patcher.cjs", "store.cjs", "zip.cjs", "platform.cjs", "runtime.js", "threads-model.mjs", "shims", "builtin", "types", "t3mods.mjs", "shim-index.cjs", "post-update.ps1", "post-update.cmd", "server-patches.cjs", "asar.cjs", "registry.cjs", "linux"];

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
if (opt("--mods")) process.env.T3MODS_DIR = path.resolve(opt("--mods"));

// ---------- finding the app ----------

const appImageRoot = () => path.join(platform.dataHome(), "appimage");
const appImageStateFile = () => path.join(appImageRoot(), "current.env");
const launcherPath = () => path.join(os.homedir(), ".local", "bin", "t3code-mods");
const desktopFile = () => path.join(os.homedir(), ".local", "share", "applications", "t3code-mods.desktop");

// KEY='value' lines, readable by the launcher (POSIX sh) and by this CLI.
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)='(.*)'$/.exec(line);
    if (m) out[m[1]] = m[2].replaceAll(`'\\''`, "'");
  }
  return out;
}
const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
function writeAtomic(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

// AppImages in the usual download folders, newest first.
function findAppImages(dirs) {
  const home = os.homedir();
  const where = dirs ?? ["Applications", "AppImages", "Downloads", "Desktop", "bin", ".local/bin"].map((d) => path.join(home, d));
  return where
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => platform.APPIMAGE_NAME.test(f)).map((f) => path.join(d, f)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

// What install and the other commands work on: { kind: "dir", dir } or { kind: "appimage", file }.
function target() {
  if (opt("--appimage")) return { kind: "appimage", file: opt("--appimage") };
  if (opt("--app")) return { kind: "dir", dir: path.resolve(opt("--app")) };
  if (isWin) return { kind: "dir", dir: path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "t3code") };
  if (isLinux) {
    if (readEnvFile(appImageStateFile()).T3MODS_APPDIR) return { kind: "appimage", file: "auto" };
    const dir = platform.LINUX_SYSTEM_DIRS.find((d) => fs.existsSync(path.join(d, "resources")));
    if (dir) return { kind: "dir", dir };
    const [file] = findAppImages();
    if (file) return { kind: "appimage", file };
  }
  throw new Error("T3 Code not found. Pass --app <install dir>, or --appimage <file> on Linux.");
}

// The app folder that holds resources/ (for an AppImage: the extracted copy).
function appDirOf(t) {
  if (t.kind === "dir") return t.dir;
  const dir = readEnvFile(appImageStateFile()).T3MODS_APPDIR;
  if (!dir) throw new Error("the AppImage is not set up yet; run install first");
  return dir;
}

function appExe(dir) {
  const exe = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => (isWin ? /^T3 Code.*\.exe$/i.test(f) : f === "t3code"));
  if (!exe) throw new Error(`no T3 Code executable in ${dir}; pass --app`);
  return path.join(dir, exe);
}

function state(dir) {
  const res = path.join(dir, "resources");
  const has = (n) => fs.existsSync(path.join(res, n));
  // After an update the app has a fresh app.asar; Electron prefers it over app/, so the app
  // runs unmodded until install runs again.
  if (has("app/index.cjs") && has("_app.asar") && !has("app.asar")) return "installed";
  if (has("app/index.cjs") && has("app.asar")) return "stale (app updated; run install again)";
  if (has("app.asar")) return "not installed";
  return "broken";
}

function running(dir) {
  const prefix = path.resolve(dir).toLowerCase() + path.sep;
  if (isWin) {
    // Skips this process: after an update the app's own exe runs this CLI as Node.
    const out = execFileSync("powershell", ["-NoProfile", "-Command", 'Get-Process | ForEach-Object { "$($_.Id)|$($_.Path)" }'], { encoding: "utf8" });
    return out.split(/\r?\n/).some((line) => {
      const [pid, file = ""] = line.split("|");
      return Number(pid) !== process.pid && file.toLowerCase().startsWith(prefix);
    });
  }
  return fs.readdirSync("/proc").some((pid) => {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`).toLowerCase().startsWith(prefix);
    } catch {
      return false;
    }
  });
}

// ---------- install ----------

// Shim into a resources folder this user can write (Windows, an extracted AppImage).
// Electron loads app.asar before resources/app, so the original bundle moves to _app.asar.
// The order keeps the folder valid at every moment, so an app that starts in between runs,
// with or without mods: the shim first (ignored while app.asar exists), then the unpacked
// files under their new name, then the app.asar rename, which switches over. On Windows the
// new name is a junction: a running app can hold the native modules in app.asar.unpacked
// locked. Windows also refuses the app.asar rename while the app runs, which leaves it
// unmodded and makes install fail with nothing switched.
function applyShim(res) {
  const p = (n) => path.join(res, n);
  // Neither bundle: an update installer is between moving the old folder out and writing the
  // new one. A shim now would be lost, or would block the installer.
  if (!fs.existsSync(p("app.asar")) && !fs.existsSync(p("_app.asar"))) throw new Error(`no app.asar in ${res}; is an update installing?`);
  fs.rmSync(p("app"), { recursive: true, force: true });
  fs.mkdirSync(p("app"), { recursive: true });
  fs.writeFileSync(p("app/package.json"), JSON.stringify({ name: "t3code", main: "index.cjs" }));
  fs.copyFileSync(path.join(here, "shim-index.cjs"), p("app/index.cjs"));
  if (!fs.existsSync(p("app.asar"))) return;
  removeLinkOrDir(p("_app.asar.unpacked"));
  if (fs.existsSync(p("app.asar.unpacked"))) {
    if (isWin) fs.symlinkSync(p("app.asar.unpacked"), p("_app.asar.unpacked"), "junction");
    else fs.renameSync(p("app.asar.unpacked"), p("_app.asar.unpacked"));
  }
  fs.rmSync(p("_app.asar"), { force: true });
  try {
    fs.renameSync(p("app.asar"), p("_app.asar"));
  } catch (e) {
    if (isWin && (e.code === "EBUSY" || e.code === "EPERM")) throw new Error("T3 Code is running; quit it first.");
    throw e;
  }
}

// Removes a link without touching its target (fs.rmSync would follow a junction).
function removeLinkOrDir(file) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) fs.unlinkSync(file);
  else if (st) fs.rmSync(file, { recursive: true, force: true });
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Root-owned app folders (Linux packages): loader/linux/system.sh does the root part.
function runAsRoot(argv) {
  const root = process.getuid?.() === 0;
  const tool = root ? null : ["sudo", "pkexec"].find((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);
  if (!root && !tool) throw new Error("this needs root, and neither sudo nor pkexec is available");
  console.log(`root needed once: ${[tool, ...argv].filter(Boolean).join(" ")}`);
  const r = root ? spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }) : spawnSync(tool, argv, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`root step failed (exit ${r.status ?? r.signal})`);
}

function installDir(dir) {
  const res = path.join(dir, "resources");
  if (!fs.existsSync(res)) throw new Error(`no resources folder in ${dir}`);
  // On Windows a running app makes applyShim fail (no running() check first: it takes a
  // second, and the post-update task installs the moment the app quits, before a restart).
  // On Linux a rename keeps the running app's open file, so a restart is enough.
  refreshKit();
  if (writable(res)) applyShim(res);
  else if (isLinux) runAsRoot(["sh", path.join(kitHome, "linux", "system.sh"), "install", res, path.join(kitHome, "shim-index.cjs")]);
  else throw new Error(`cannot write to ${res}`);
  if (isLinux) writeLinkEntry(dir);
  if (isLinux && running(dir)) console.log("T3 Code is running: restart it to load the mods.");
  if (isWin && fs.existsSync(serverPatchFlag())) {
    try {
      applyServerPatch(dir);
    } catch (e) {
      console.error(`server-patch failed; the loader still applies server patches: ${e.message}`);
    }
  }
}

// ---------- server-patch (Windows) ----------
// Writes the server patches of enabled mods into resources/server.asar, so they apply
// without the loader. The original stays as server.asar.t3mods-orig and each run patches
// from it, so a run after a mod change starts from clean chunks. An app update writes a new
// server.asar; install (which the post-update task runs) patches it again while the flag
// file exists.
const serverPatchFlag = () => path.join(kitHome, "server-patch.json");
// After an update this runs on the app's exe as Node, where plain fs treats .asar files as
// folders; original-fs handles them as files.
const ofs = process.versions.electron ? require("original-fs") : fs;

function serverPatch() {
  if (!isWin) throw new Error("server-patch is for Windows; on Linux the loader applies server patches");
  const dir = appDirOf(target());
  if (running(dir)) throw new Error("T3 Code is running; quit it first.");
  if (flag("--undo")) {
    undoServerPatch(dir);
    fs.rmSync(serverPatchFlag(), { force: true });
    return;
  }
  applyServerPatch(dir);
  fs.mkdirSync(kitHome, { recursive: true });
  fs.writeFileSync(serverPatchFlag(), JSON.stringify({ on: true, at: new Date().toISOString() }));
}

function serverAsarFiles(dir) {
  const res = path.join(dir, "resources");
  return { live: path.join(res, "server.asar"), orig: path.join(res, "server.asar.t3mods-orig"), tmp: path.join(res, "server.asar.t3mods-tmp") };
}

// Does any backend chunk in this archive hold patches from an earlier run?
function asarBaked(file) {
  const asar = require("./asar.cjs");
  const SP = require("./server-patches.cjs");
  return asar
    .listDir(file, SP.DIST)
    .filter((n) => n.endsWith(".mjs"))
    .some((n) => SP.bakedKeys(asar.readFile(file, `${SP.DIST}/${n}`).subarray(0, 4096).toString("utf8")).size > 0);
}

function applyServerPatch(dir) {
  const { live, orig, tmp } = serverAsarFiles(dir);
  const store = require("./store.cjs");
  const P = require("./patcher.cjs");
  const SP = require("./server-patches.cjs");
  const asar = require("./asar.cjs");
  // live is the app's own file unless an earlier run patched it; after an app update it is
  // the new build's file, and orig is stale.
  if (!asarBaked(live)) ofs.copyFileSync(live, orig);
  const { patches, errors } = SP.loadPatches(store.listMods());
  const { result, changes } = SP.bakeAsar(orig, patches, (p) => P.evalPredicate(p, { state: store.readState(p.mod) }), errors);
  for (const r of result.results) console.log(`server ${r.key.padEnd(32)} ${r.status}`);
  for (const [id, h] of result.health) if (h.status === "degraded") console.log(`mod ${id}: server patches not applied (${h.problems.join("; ")})`);
  const names = Object.keys(changes);
  if (!names.length) {
    ofs.copyFileSync(orig, tmp);
    ofs.renameSync(tmp, live);
    console.log("server.asar: no server patches to apply; original restored");
    return;
  }
  // A syntax error in a backend chunk would stop the backend: check each one first.
  const scratch = ofs.mkdtempSync(path.join(os.tmpdir(), "t3mods-server-"));
  try {
    for (const name of names) {
      const file = path.join(scratch, name);
      ofs.writeFileSync(file, changes[name]);
      const r = spawnSync(process.execPath, ["--check", file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`patched ${name} does not parse: ${(r.stderr || r.error?.message || "").trim()}`);
    }
  } finally {
    ofs.rmSync(scratch, { recursive: true, force: true });
  }
  asar.writeWithChanges(orig, tmp, Object.fromEntries(names.map((n) => [`${SP.DIST}/${n}`, changes[n]])));
  ofs.renameSync(tmp, live);
  console.log(`server.asar: patched ${names.join(", ")}; original kept as ${path.basename(orig)}`);
}

function undoServerPatch(dir) {
  const { live, orig } = serverAsarFiles(dir);
  if (ofs.existsSync(orig) && asarBaked(live)) {
    ofs.renameSync(orig, live);
    console.log("server.asar: original restored");
  } else {
    ofs.rmSync(orig, { force: true });
    console.log("server.asar: not patched");
  }
}

// Extracts the AppImage (once per version) into appImageRoot(), puts the shim into the
// extracted copy, and points the launcher at it. `auto` reuses the recorded AppImage or,
// after an update deleted it, the newest one in the same folder.
function installAppImage(spec) {
  const prev = readEnvFile(appImageStateFile());
  let file = spec === "auto" ? null : path.resolve(spec);
  if (!file) {
    file = prev.T3MODS_APPIMAGE && fs.existsSync(prev.T3MODS_APPIMAGE) ? prev.T3MODS_APPIMAGE : findAppImages(prev.T3MODS_APPIMAGE ? [path.dirname(prev.T3MODS_APPIMAGE)] : undefined)[0];
  }
  if (!file || !fs.existsSync(file)) throw new Error(`AppImage not found${file ? `: ${file}` : ""}; pass --appimage <file>`);
  const stat = fs.statSync(file);
  const version = platform.appImageVersion(file) ?? `sha-${createHash("sha1").update(`${file}:${stat.size}:${stat.mtimeMs}`).digest("hex").slice(0, 12)}`;
  const dir = path.join(appImageRoot(), version);
  const appDir = path.join(dir, "squashfs-root");
  if (!fs.existsSync(path.join(appDir, "AppRun"))) {
    console.log(`extracting ${path.basename(file)} ...`);
    const tmp = `${dir}.part`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    if (!(stat.mode & 0o100)) fs.chmodSync(file, stat.mode | 0o755);
    execFileSync(file, ["--appimage-extract"], { cwd: tmp, stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  }
  refreshKit();
  applyShim(path.join(appDir, "resources"));
  writeAtomic(appImageStateFile(), `T3MODS_APPIMAGE=${shQuote(file)}\nT3MODS_APPDIR=${shQuote(appDir)}\nT3MODS_VERSION=${shQuote(version)}\n`);
  writeLauncher();
  writeDesktopEntry(appDir);
  // Keep this version and the one before it; a failed update can fall back to the old one.
  const keep = new Set([version, prev.T3MODS_VERSION].filter(Boolean));
  for (const d of fs.readdirSync(appImageRoot())) {
    const full = path.join(appImageRoot(), d);
    if (fs.statSync(full).isDirectory() && !keep.has(d)) fs.rmSync(full, { recursive: true, force: true });
  }
  console.log(`start T3 Code with mods from your app menu ("T3 Code (mods)") or: ${launcherPath()}`);
}

function writeLauncher() {
  const log = path.join(kitHome, "launcher.log");
  // bash, not sh: closing inherited file descriptors above 9 needs it (AppRun needs it too).
  const text = `#!/usr/bin/env bash
# T3 Code with mods (AppImage). Written by \`t3mods install\`; install rewrites it.
# After an app update (T3MODS_NEW_APPIMAGE, set by the loader, or the recorded AppImage is
# gone) it extracts and patches the new version first.
if [ -n "\${T3MODS_OLD_PID:-}" ]; then
  # Started by the old app: close the sockets and files it leaked to us (for example its
  # listening sockets), or the new version could not open its own. 255 is this script.
  for fd in /proc/$$/fd/*; do
    fd=\${fd##*/}
    if [ "$fd" -gt 2 ] && [ "$fd" -ne 255 ]; then eval "exec $fd>&-"; fi
  done 2>/dev/null
fi
state=${shQuote(appImageStateFile())}
kit=${shQuote(kitHome)}
. "$state"
if [ -n "\${T3MODS_NEW_APPIMAGE:-}" ] || [ ! -e "$T3MODS_APPIMAGE" ]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S') preparing \${T3MODS_NEW_APPIMAGE:-the newest AppImage}" >>${shQuote(log)}
  ELECTRON_RUN_AS_NODE=1 "$T3MODS_APPDIR/t3code" "$kit/t3mods.mjs" install --appimage "\${T3MODS_NEW_APPIMAGE:-auto}" >>${shQuote(log)} 2>&1 ||
    echo "t3mods: could not prepare the new version; starting the previous one. Log: ${log}" >&2
  . "$state"
fi
# Started by an update: the old version may still be quitting. Two versions must not run at once.
if [ -n "\${T3MODS_OLD_PID:-}" ]; then
  i=0
  while kill -0 "$T3MODS_OLD_PID" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
fi
unset T3MODS_NEW_APPIMAGE T3MODS_OLD_PID APPIMAGE_SILENT_INSTALL APPDIR
export APPIMAGE="$T3MODS_APPIMAGE" T3MODS_LAUNCHER=${shQuote(launcherPath())}
exec "$T3MODS_APPDIR/AppRun" "$@"
`;
  writeAtomic(launcherPath(), text, 0o755);
}

function writeDesktopEntry(appDir) {
  writeAtomic(
    desktopFile(),
    `[Desktop Entry]
Name=T3 Code (mods)
Comment=T3 Code with the t3mods loader
Exec="${launcherPath()}" %U
Icon=${path.join(appDir, "t3code.png")}
Terminal=false
Type=Application
StartupWMClass=t3code
MimeType=x-scheme-handler/t3code;x-scheme-handler/t3mods;
Categories=Development;
`,
  );
  registerSchemes(desktopFile(), ["t3code", "t3mods"]);
}

// A .deb or AUR install has no desktop entry that lists t3mods://, so the browser cannot hand
// the site's Install link over. This user-level entry (no menu item) points it at the app.
const linkEntryFile = () => path.join(os.homedir(), ".local", "share", "applications", "t3mods-link.desktop");
function writeLinkEntry(dir) {
  writeAtomic(
    linkEntryFile(),
    `[Desktop Entry]
Name=T3 Code (t3mods links)
Exec="${appExe(dir)}" %U
Terminal=false
Type=Application
NoDisplay=true
MimeType=x-scheme-handler/t3mods;
`,
  );
  registerSchemes(linkEntryFile(), ["t3mods"]);
}

// Desktop integration is optional, so a missing tool only gets a note.
function registerSchemes(file, schemes) {
  for (const [tool, toolArgs] of [
    ...schemes.map((s) => ["xdg-mime", ["default", path.basename(file), `x-scheme-handler/${s}`]]),
    ["update-desktop-database", [path.dirname(file)]],
  ]) {
    const r = spawnSync(tool, toolArgs, { stdio: "ignore" });
    if (r.status !== 0) console.log(`note: ${tool} ${r.error ? "is not installed" : `failed (exit ${r.status})`}; t3code:// and t3mods:// links may not reach the modded app`);
  }
}

function install() {
  // After an update this CLI runs on the app's own exe as Node, whose fs opens .asar files as
  // archives and keeps them open, so renaming app.asar would fail with EBUSY.
  process.noAsar = true;
  const t = target();
  if (t.kind === "appimage") installAppImage(t.file);
  else installDir(t.dir);
}

function uninstall() {
  process.noAsar = true;
  const t = target();
  if (t.kind === "appimage") {
    for (const f of [launcherPath(), desktopFile()]) fs.rmSync(f, { force: true });
    fs.rmSync(appImageRoot(), { recursive: true, force: true });
    console.log("removed the launcher, the menu entry and the extracted app; your AppImage is unchanged");
    return;
  }
  const res = path.join(t.dir, "resources");
  if (isLinux) fs.rmSync(linkEntryFile(), { force: true });
  if (isWin) {
    if (running(t.dir)) throw new Error("T3 Code is running; quit it first.");
    unregisterPostUpdateTask();
    // Server patches written into server.asar outlive the shim; without the flag, a later
    // install would write them again.
    if (fs.existsSync(serverAsarFiles(t.dir).orig) || fs.existsSync(serverPatchFlag())) {
      undoServerPatch(t.dir);
      fs.rmSync(serverPatchFlag(), { force: true });
    }
  }
  if (!writable(res) && isLinux) runAsRoot(["sh", path.join(kitHome, "linux", "system.sh"), "uninstall", res]);
  else {
    const p = (n) => path.join(res, n);
    fs.rmSync(p("app"), { recursive: true, force: true });
    if (fs.existsSync(p("_app.asar")) && !fs.existsSync(p("app.asar"))) {
      fs.renameSync(p("_app.asar"), p("app.asar"));
      // A junction (installs since 0.3.0) or the renamed folder (older installs).
      if (fs.existsSync(p("app.asar.unpacked"))) removeLinkOrDir(p("_app.asar.unpacked"));
      else if (fs.existsSync(p("_app.asar.unpacked"))) fs.renameSync(p("_app.asar.unpacked"), p("app.asar.unpacked"));
    }
  }
  console.log(`${t.dir}: ${state(t.dir)}`);
}

// ---------- kit and the Windows post-update task ----------

// Runs post-update.ps1 when the loader queues it during an app update (see
// hookUpdaterInstall in t3mods-loader.cjs, which derives the same name).
const taskName = `t3mods-post-update-${createHash("sha1").update(path.resolve(kitHome).toLowerCase()).digest("hex").slice(0, 8)}`;

function registerPostUpdateTask() {
  // post-update.ps1 runs this install from inside the task; replacing the task then would
  // replace it mid-run, so it keeps the current registration.
  if (!isWin || process.env.T3MODS_POST_UPDATE) return;
  const script = path.join(kitHome, "post-update.cmd");
  // conhost --headless gives the script a console with no window. -WindowStyle Hidden is not
  // enough: with Windows Terminal as the default terminal the window still shows, and the
  // relaunched app attaches to that console and prints its logs there.
  // The logon and 15-minute triggers repair an install that an update the loader did not see
  // (or a failed run) left without the loader; post-update.cmd exits at once when nothing is
  // to do. IgnoreNew: a run that waits for the app to quit is not stacked up by the repeat
  // trigger. A loader request that hits a running check stays on disk for the next run.
  const ps = `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless cmd.exe /d /c "${script}"'
$t = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15))
)
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 25) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
}

function unregisterPostUpdateTask() {
  // A filter, not -TaskName: a missing task is then no error (uninstall without the task).
  const ps = `Get-ScheduledTask -TaskPath '\\' | Where-Object TaskName -eq '${taskName}' | Unregister-ScheduledTask -Confirm:$false`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
}

// Refreshes the kit copy (and the Windows task) without touching the app, so it is safe
// while the app runs.
function refreshKit() {
  if (path.resolve(here).toLowerCase() !== path.resolve(kitHome).toLowerCase()) {
    for (const f of KIT) fs.cpSync(path.join(here, f), path.join(kitHome, f), { recursive: true });
  }
  registerPostUpdateTask();
}

// ---------- dev ----------

// Starts the installed app with the loader from this folder (the shim honors T3MODS_LOADER),
// so loader edits here apply on the next start without `install`.
function dev() {
  const dir = appDirOf(target());
  if (state(dir) !== "installed") throw new Error(`the loader is not installed in ${dir} (${state(dir)}); run install first`);
  const env = { ...process.env, T3MODS_LOADER: path.join(here, "t3mods-loader.cjs") };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (flag("--isolated")) {
    const root = path.resolve(opt("--profile") ?? path.join(kitHome, "dev"));
    const home = path.join(root, "home");
    // Electron keeps its profile in APPDATA (Windows) or XDG_CONFIG_HOME (Linux).
    Object.assign(env, { APPDATA: path.join(root, "appdata"), XDG_CONFIG_HOME: path.join(root, "config"), T3CODE_HOME: home, T3CODE_DISABLE_AUTO_UPDATE: "1" });
    if (flag("--copy-data")) copyUserData(path.join(os.homedir(), ".t3", "userdata"), path.join(home, "userdata"));
    console.log(`isolated profile: ${root}`);
  } else if (running(dir)) {
    throw new Error("T3 Code is running; quit it first, or use --isolated");
  }
  const appArgs = opt("--cdp") ? [`--remote-debugging-port=${opt("--cdp")}`] : [];
  console.log(`mods: ${env.T3MODS_DIR ?? path.join(os.homedir(), ".t3", "mods")}`);
  const appRun = path.join(dir, "AppRun");
  const child = spawn(fs.existsSync(appRun) ? appRun : appExe(dir), appArgs, { env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// Threads, settings and themes; not secrets or sign-in tokens. SQLite is copied with its
// WAL files, so copy while T3 Code is idle.
function copyUserData(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "settings.json", "client-settings.json", "keybindings.json", "themes", "attachments"]) {
    if (fs.existsSync(path.join(from, f))) fs.cpSync(path.join(from, f), path.join(to, f), { recursive: true });
  }
  console.log(`copied user data from ${from}`);
}

// ---------- mods ----------

function list() {
  const store = require("./store.cjs");
  const health = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.META_DIR, "health.json"), "utf8"));
    } catch {
      return {};
    }
  })();
  console.log(`mods folder: ${store.MODS_DIR}`);
  for (const m of store.listMods()) {
    const h = health[m.id];
    const status = !m.enabled ? "off" : h?.status === "degraded" ? "not started" : h ? "active" : "unknown";
    const tiers = Object.entries(m.files).filter(([, v]) => v).map(([k]) => k).join(",");
    console.log(`${m.builtin ? "*" : " "} ${m.id.padEnd(24)} ${status.padEnd(12)} ${tiers}${h?.problems?.length ? `  ${h.problems.join("; ")}` : ""}`);
  }
}

function newMod(id) {
  const store = require("./store.cjs");
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("usage: t3mods new <id>  (lowercase letters, digits, '.', '_', '-'; the registry accepts no capitals)");
  const dir = path.join(store.MODS_DIR, id);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  const types = path.relative(dir, path.join(kitHome, "types", "t3mods")).replaceAll("\\", "/");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mod.json"), `${JSON.stringify({ id, name: id, version: "0.1.0", description: "" }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(dir, "renderer.js"),
    `// Runs in the T3 Code window. Save this file and the change applies at once.
// API: docs/writing-mods.md in the t3code-mods repo; types: ${types}.d.ts

/** @param {import("${types}").RendererApi} api */
export default (api) => {
  api.command({ id: "hello", title: "${id}: say hello", run: () => api.log("hello") });
};
`,
  );
  console.log(`created ${dir}; it is active now. Open the command palette and search "${id}".`);
}

// `add <id>[@version]`: an argument that is no existing file and looks like an id.
async function addFromRegistry(spec) {
  const registry = require("./registry.cjs");
  const prepared = await registry.prepare(spec);
  // Before the install, so the notes can be read while the code is not on disk yet.
  if (prepared.info.yanked) console.log(`note: the author withdrew ${prepared.id} ${prepared.info.version} (yanked); it may have a known problem.`);
  for (const w of registry.tierWarning(prepared.info.tiers).filter((w) => !/^It runs code in the app window/.test(w))) console.log(`note: ${w}`);
  const out = registry.install(prepared);
  console.log(`installed ${out.id} ${out.version} from ${registry.baseUrl()} (sha256 ${out.sha256})`);
}

async function add(source) {
  if (!source) throw new Error("usage: t3mods add <id>[@version] | <file.zip | https-url>");
  if (!source.startsWith("https://") && !fs.existsSync(source) && require("./registry.cjs").looksLikeSpec(source)) return addFromRegistry(source);
  const store = require("./store.cjs");
  let buf;
  const remote = source.startsWith("https://");
  if (remote) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else buf = fs.readFileSync(source);
  const out = store.installArchive(buf, remote ? source : `file:${path.basename(source)}`);
  console.log(`installed ${out.id}${out.version ? ` ${out.version}` : ""} into ${store.MODS_DIR} (sha256 ${out.sha256})`);
}

async function search() {
  const registry = require("./registry.cjs");
  const words = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  const { mods, total } = await registry.search(words);
  for (const m of mods) {
    const stars = m.rating?.average == null ? "-" : m.rating.average.toFixed(1);
    console.log(`${m.id.padEnd(24)} ${m.latestVersion.padEnd(10)} ${String(m.downloads).padStart(6)} dl  ${stars.padStart(3)} stars  by ${m.author.login}  ${m.tiers.join(",")}`);
    if (m.description) console.log(`  ${m.description}`);
  }
  console.log(`${mods.length} of ${total} mods`);
}

// A yes/no question on the terminal. Without one (a script) the answer is no.
async function askYes(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function update(id) {
  const registry = require("./registry.cjs");
  const list = await registry.updates(id);
  if (!list.length) return console.log(id ? `${id} is up to date` : "all registry mods are up to date");
  const store = require("./store.cjs");
  for (const u of list) {
    const prepared = await registry.prepare({ id: u.id, version: u.latest });
    // A new full-access tier is new code that the user never agreed to: ask first.
    const have = store.listMods().find((m) => m.id === u.id);
    const added = prepared.info.tiers.filter((t) => registry.FULL_ACCESS_TIERS.includes(t) && !have?.files[t]);
    if (added.length) {
      console.log(`${u.id} ${u.latest} adds code that ${u.installed} does not have: ${added.join(", ")}`);
      for (const w of registry.tierWarning(added)) console.log(`  ${w}`);
      if (!flag("--yes") && !(await askYes(`Update ${u.id}?`))) {
        console.log(`skipped ${u.id} (run again with --yes to accept)`);
        process.exitCode = 1;
        continue;
      }
    }
    registry.install(prepared);
    console.log(`updated ${u.id} ${u.installed} -> ${u.latest}`);
  }
}

async function publish(dir) {
  if (!dir || dir.startsWith("--")) throw new Error("usage: t3mods publish <dir> [--changelog <text>]");
  const registry = require("./registry.cjs");
  const r = await registry.publish(dir, { changelog: opt("--changelog") });
  console.log(`published ${r.id} ${r.version} (sha256 ${r.sha256})${r.url ? ` ${r.url}` : ""}`);
}

// The token comes from T3MODS_TOKEN or stdin (a prompt without echo on a terminal). On the
// command line it would stay in shell history and show in the process list; still accepted,
// with a warning, for old scripts.
async function readToken(arg) {
  if (arg && !arg.startsWith("--")) {
    console.error("t3mods: a token on the command line stays in your shell history; use T3MODS_TOKEN or pipe it to stdin instead.");
    return arg;
  }
  if (process.env.T3MODS_TOKEN) return process.env.T3MODS_TOKEN.trim();
  if (!process.stdin.isTTY) {
    // Agents often run commands with stdin open and no TTY, which never ends: read one line,
    // and give up when nothing arrives within 3 s instead of waiting for EOF.
    return new Promise((resolve) => {
      let buf = "";
      const done = () => {
        clearTimeout(timer);
        process.stdin.destroy();
        resolve(buf.split("\n")[0].trim());
      };
      const timer = setTimeout(done, 3000);
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => ((buf += c), buf.includes("\n") && done()));
      process.stdin.on("end", done);
    });
  }
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (text) => rl.output.write(text.includes("Token") ? text : "");
  const token = await new Promise((resolve) => rl.question("Token (hidden): ", resolve));
  rl.close();
  console.log("");
  return token.trim();
}

async function login(arg) {
  const token = await readToken(arg);
  if (!token) throw new Error("no token: set T3MODS_TOKEN, pipe it to stdin, or run `t3mods login` on a terminal (create one at <registry>/settings/tokens)");
  const registry = require("./registry.cjs");
  const me = await registry.login(token);
  console.log(`logged in as ${me.login}; token saved to ${registry.tokenFile()}`);
}

function pack(dir, out) {
  if (!dir) throw new Error("usage: t3mods pack <mod-dir> [out.zip]");
  const store = require("./store.cjs");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "mod.json"), "utf8"));
  const file = out ?? `${manifest.id ?? path.basename(path.resolve(dir))}${manifest.version ? `-${manifest.version}` : ""}.zip`;
  const buf = store.packDir(dir);
  fs.writeFileSync(file, buf);
  console.log(`${file} (${buf.length} bytes, sha256 ${createHash("sha256").update(buf).digest("hex")})`);
}

// Reads the installed build's chunks. Plain Node cannot read .asar files, so without --assets
// this re-runs itself on the app's own executable in Node mode, which can.
function doctor() {
  let assets = opt("--assets");
  let serverDist = opt("--server-dist");
  if (!assets) {
    const dir = appDirOf(target());
    if (!process.versions.electron) {
      const r = spawnSync(appExe(dir), [fileURLToPath(import.meta.url), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    assets = platform.clientAssetsDir(path.join(dir, "resources"));
    if (!assets) throw new Error(`no web client chunks found in ${dir}`);
    serverDist ??= path.join(dir, "resources", "server.asar", "apps", "server", "dist");
  } else if (!serverDist && fs.existsSync(path.join(assets, "server"))) serverDist = path.join(assets, "server"); // from tools/extract-assets.cjs
  const store = require("./store.cjs");
  const P = require("./patcher.cjs");
  const chunks = fs.readdirSync(assets).filter((f) => f.endsWith(".js")).map((name) => ({ name, text: fs.readFileSync(path.join(assets, name), "utf8") }));
  const mods = store.listMods();
  const patches = [];
  const errors = new Map();
  for (const m of mods.filter((m) => m.enabled && m.files.patches)) {
    try {
      patches.push(...P.normalize(m.id, require(path.join(m.dir, "patches.cjs"))));
    } catch (e) {
      errors.set(m.id, [`patches.cjs: ${e.message}`]);
    }
  }
  const report = P.doctor(patches, chunks, (p) => P.evalPredicate(p, { state: store.readState(p.mod) }));
  for (const r of report.results) {
    const entries = r.entries && r.entries.length > 1 ? ` [${r.entries.map((e) => (e ? "+" : "-")).join("")}]` : "";
    console.log(`${r.key.padEnd(32)} ${r.status.padEnd(15)}${r.optional ? "optional " : ""}${r.chunks.join(",")}${entries}${r.error ? ` ${r.error}` : ""}`);
  }
  for (const [id, h] of P.resolveHealth(mods, report.results, errors)) if (h.status === "degraded") console.log(`mod ${id}: not started (${h.problems.join("; ")})`);
  console.log(`${report.results.length} patches, ${report.chunks} chunks, ${report.ms} ms`);
  if (report.results.some((r) => !r.optional && !["ok", "skipped"].includes(r.status))) process.exitCode = 1;
  if (!serverDist) {
    const withServerPatches = mods.filter((m) => m.enabled && m.files.serverPatches).map((m) => m.id);
    if (withServerPatches.length) console.log(`server patches NOT checked for ${withServerPatches.join(", ")}: pass --server-dist <dir with the backend's .mjs chunks>`);
    return;
  }
  // Backend chunks: Electron's fs reads inside server.asar.
  const SP = require("./server-patches.cjs");
  const { patches: sp, errors: se } = SP.loadPatches(mods);
  if (!sp.length && !se.size) return;
  const server = SP.check(sp, SP.readDistChunks(serverDist), (p) => P.evalPredicate(p, { state: store.readState(p.mod) }), se);
  for (const r of server.results) console.log(`${r.key.padEnd(32)} ${r.status.padEnd(15)}${r.optional ? "optional " : ""}server ${r.chunks.join(",")}${r.error ? ` ${r.error}` : ""}`);
  for (const [id, h] of server.health) if (h.status === "degraded") console.log(`mod ${id}: server patches off (${h.problems.join("; ")})`);
  if (server.results.some((r) => !r.optional && !["ok", "skipped", "baked"].includes(r.status))) process.exitCode = 1;
}

function status() {
  const t = target();
  if (t.kind === "appimage") {
    const s = readEnvFile(appImageStateFile());
    if (!s.T3MODS_APPDIR) return console.log("AppImage: not installed");
    console.log(`AppImage ${s.T3MODS_APPIMAGE}${fs.existsSync(s.T3MODS_APPIMAGE) ? "" : " (gone; the launcher picks the newest)"}`);
    console.log(`${s.T3MODS_APPDIR}: ${state(s.T3MODS_APPDIR)}; launcher ${fs.existsSync(launcherPath()) ? launcherPath() : "missing"}`);
    return;
  }
  console.log(`${t.dir}: ${state(t.dir)}`);
}

const commands = {
  install: () => (install(), status()),
  uninstall,
  kit: refreshKit,
  status,
  dev,
  new: () => newMod(args[1]),
  list,
  add: () => add(args[1]),
  search,
  update: () => update(args[1]),
  publish: () => publish(args[1]),
  login: () => login(args[1]),
  pack: () => pack(args[1], args[2]?.startsWith("--") ? undefined : args[2]),
  doctor,
  "server-patch": serverPatch,
};
// `t3mods <command> --help` prints the help too: without this, `login --help` waits for a token.
if (!commands[cmd] || args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(!commands[cmd] && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 1 : 0);
}
try {
  await commands[cmd]();
} catch (e) {
  // A message, never a stack: registry errors must not leak a token through one.
  const text = require("./registry.cjs").redact(process.env.T3MODS_DEBUG ? (e?.stack ?? e) : (e?.message ?? e));
  console.error(`t3mods: ${text}`);
  process.exit(1);
}
