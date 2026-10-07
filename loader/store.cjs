// The mods folder: listing, enable/disable, per-mod state, archive install and removal.
// Layout:
//   <mods>/<id>/            one folder per mod (a leading "_" disables it)
//   <mods>/.t3mods/         loader data; dot-prefixed, so the watchers ignore it
//     config.json           { disabled: [ids] }
//     state/<id>.json       values of the mod's state cells
//     sources.json          { [id]: { source, sha256, at } } for archive installs; registry
//                           installs add { registry, version } and source "registry:<id>@<version>"
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { readZip, writeZip } = require("./zip.cjs");

const MODS_DIR = process.env.T3MODS_DIR || path.join(os.homedir(), ".t3", "mods");
const META_DIR = path.join(MODS_DIR, ".t3mods");
const BUILTIN_DIR = path.join(__dirname, "builtin");
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const TIER_FILES = { css: "style.css", renderer: "renderer.js", patches: "patches.cjs", server: "server.cjs", serverPatches: "server-patches.cjs", main: "main.cjs" };

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

const configFile = () => path.join(META_DIR, "config.json");
const readConfig = () => ({ disabled: [], ...readJson(configFile(), {}) });

function describe(dir, name, builtin, config) {
  const id = builtin ? name : name.replace(/^_/, "");
  let manifest = {};
  let manifestError;
  const file = path.join(dir, "mod.json");
  if (fs.existsSync(file)) {
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      manifestError = String(e.message);
    }
  }
  // Exact names: existsSync would also match MAIN.CJS for main.cjs on a case-insensitive file
  // system, and the loader would run a file that no tier check ever saw.
  const names = new Set(fs.readdirSync(dir));
  const files = Object.fromEntries(Object.entries(TIER_FILES).map(([tier, f]) => [tier, names.has(f)]));
  const enabled = builtin || (!name.startsWith("_") && manifest.enabled !== false && !config.disabled.includes(id));
  return { id, dir, builtin, manifest, manifestError, files, enabled };
}

// All mods, builtins first. A user mod that reuses a builtin id is ignored.
function listMods() {
  const config = readConfig();
  const out = [];
  const scan = (root, builtin) => {
    if (!fs.existsSync(root)) return;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const mod = describe(path.join(root, d.name), d.name, builtin, config);
      if (out.some((m) => m.id === mod.id)) continue;
      out.push(mod);
    }
  };
  scan(BUILTIN_DIR, true);
  scan(MODS_DIR, false);
  return out;
}

// What applying a change to this mod needs: hot swap, renderer reload, or app restart.
const reloadLevel = (mod) => (mod.files.main || mod.files.serverPatches ? "restart" : mod.files.patches ? "reload" : "hot");

function setEnabled(id, enabled) {
  const mod = listMods().find((m) => m.id === id);
  if (!mod) throw new Error(`no mod ${id}`);
  if (mod.builtin) throw new Error(`${id} is built in and cannot be disabled`);
  const config = readConfig();
  config.disabled = config.disabled.filter((x) => x !== id);
  if (!enabled) config.disabled.push(id);
  writeJson(configFile(), config);
  if (enabled && path.basename(mod.dir).startsWith("_")) fs.renameSync(mod.dir, path.join(MODS_DIR, id));
  return mod;
}

const STATE_DIR = path.join(META_DIR, "state");
const stateFile = (id) => path.join(STATE_DIR, `${id}.json`);
const readState = (id) => readJson(stateFile(id), {});
function writeState(id, value) {
  if (!ID_RE.test(id)) throw new Error("bad mod id");
  const text = JSON.stringify(value);
  if (text.length > 256 * 1024) throw new Error("state too large (256 KB max)");
  writeJson(stateFile(id), value);
}
// Changes some keys of the saved state and keeps the others, so two apps that share the mods
// folder do not overwrite each other. The write is atomic, but read-apply-write is not a lock:
// two apps that patch within the same few milliseconds can still lose one patch. Returns the
// new state.
function patchState(id, { set = {}, unset = [] } = {}) {
  if (!set || typeof set !== "object" || Array.isArray(set) || !Array.isArray(unset) || !unset.every((k) => typeof k === "string")) {
    throw new Error("a state patch is { set: { key: value }, unset: [key] }");
  }
  const next = { ...readState(id), ...set };
  for (const key of unset) delete next[key];
  writeState(id, next);
  return next;
}

function safeName(name) {
  const parts = name.split("/");
  return !name.startsWith("/") && !name.includes("\\") && !name.includes(":") && parts.every((p) => p && p !== "." && p !== "..");
}

// Reads a mod archive (.zip with mod.json at the root, or inside one top folder as in GitHub
// downloads) without writing anything. Returns { files, manifest } with the top folder
// stripped; throws on unsafe paths, a missing mod.json or a bad id.
function inspectArchive(buf) {
  let files = readZip(buf);
  if (!files.some((f) => f.name === "mod.json")) {
    const tops = new Set(files.map((f) => f.name.split("/")[0]));
    const [top] = tops;
    if (tops.size !== 1 || !files.some((f) => f.name === `${top}/mod.json`)) throw new Error("archive has no mod.json");
    files = files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) }));
  }
  for (const f of files) if (!safeName(f.name)) throw new Error(`unsafe path in archive: ${f.name}`);
  // Names are compared exactly by tier checks but case-insensitively by Windows and macOS file
  // systems: two names that fold together, or a tier file in another case, would hide code.
  const folded = new Set();
  const tierFiles = new Set(Object.values(TIER_FILES));
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (folded.has(key)) throw new Error(`archive has two entries that differ only in case: ${f.name}`);
    folded.add(key);
    if (f.name.split("/").some((p) => /[. ]$/.test(p))) throw new Error(`archive entry name ends in "." or a space: ${f.name}`);
    if (!f.name.includes("/") && !tierFiles.has(f.name) && [...tierFiles].some((t) => t === key)) throw new Error(`archive entry ${f.name} is a tier file in the wrong case`);
  }
  const manifest = JSON.parse(files.find((f) => f.name === "mod.json").data.toString("utf8"));
  const id = manifest.id;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error('mod.json needs an "id" (letters, digits, ".", "_", "-")');
  if (fs.existsSync(path.join(BUILTIN_DIR, id))) throw new Error(`${id} is a built-in mod id`);
  return { files, manifest };
}

// The tiers whose files an archive holds, from the exact names in it.
const archiveTiers = (files) => Object.entries(TIER_FILES).filter(([, f]) => files.some((x) => x.name === f)).map(([tier]) => tier);

// Installs a mod archive. Replaces an installed mod with the same id. `extra` is stored next
// to the source in sources.json. Returns what was installed.
function installArchive(buf, source = "file", extra = {}) {
  const { files, manifest } = inspectArchive(buf);
  const id = manifest.id;
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const tmp = path.join(META_DIR, "tmp", `${id}-${crypto.randomBytes(4).toString("hex")}`);
  for (const f of files) {
    const file = path.join(tmp, ...f.name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, f.data);
  }
  let replaced = false;
  // Folders that are this mod, matched without case: on Windows and macOS "Foo" is the folder
  // that "foo" names, and a local mod must not be replaced by a different id's install.
  const existing = fs.existsSync(MODS_DIR) ? fs.readdirSync(MODS_DIR).filter((n) => [id, `_${id}`].some((x) => x.toLowerCase() === n.toLowerCase())) : [];
  const known = readJson(path.join(META_DIR, "sources.json"), {});
  for (const name of existing) {
    const mine = name.replace(/^_/, "");
    if (mine !== id) throw new Error(`a mod folder named ${name} exists; refusing to replace it with ${id}`);
    if (!known[id]) throw new Error(`${id} is in your mods folder but was not installed by t3mods (no record of a source); remove or rename ${path.join(MODS_DIR, name)} first`);
  }
  for (const name of existing) {
    // Kept in the trash, so a replaced folder can be got back.
    const trash = path.join(META_DIR, "trash", `${name}-${Date.now()}`);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(path.join(MODS_DIR, name), trash);
    replaced = true;
  }
  fs.mkdirSync(MODS_DIR, { recursive: true });
  fs.renameSync(tmp, path.join(MODS_DIR, id));
  const sources = readJson(path.join(META_DIR, "sources.json"), {});
  sources[id] = { source, ...extra, sha256, at: new Date().toISOString() };
  writeJson(path.join(META_DIR, "sources.json"), sources);
  return { id, name: manifest.name ?? id, version: manifest.version ?? null, sha256, replaced };
}

function uninstall(id) {
  const mod = listMods().find((m) => m.id === id);
  if (!mod) throw new Error(`no mod ${id}`);
  if (mod.builtin) throw new Error(`${id} is built in`);
  fs.rmSync(mod.dir, { recursive: true, force: true });
  const config = readConfig();
  config.disabled = config.disabled.filter((x) => x !== id);
  writeJson(configFile(), config);
  fs.rmSync(stateFile(id), { force: true });
  return mod;
}

// Zips a mod folder (dotfiles and node_modules left out) for sharing.
function packDir(dir) {
  const files = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (d.name.startsWith(".") || d.name === "node_modules") continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else files.push({ name: r, data: fs.readFileSync(path.join(dir, r)) });
    }
  };
  walk("");
  if (!files.some((f) => f.name === "mod.json")) throw new Error(`${dir} has no mod.json`);
  return writeZip(files);
}

const sources = () => readJson(path.join(META_DIR, "sources.json"), {});

module.exports = {
  MODS_DIR,
  META_DIR,
  BUILTIN_DIR,
  ID_RE,
  listMods,
  reloadLevel,
  readConfig,
  setEnabled,
  STATE_DIR,
  readState,
  writeState,
  patchState,
  inspectArchive,
  archiveTiers,
  installArchive,
  uninstall,
  packDir,
  sources,
};
