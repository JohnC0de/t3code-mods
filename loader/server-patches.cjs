// Text patches on the backend's bundled code (apps/server/dist/*.mjs), from each enabled
// mod's server-patches.cjs. Same patch shape and engine as renderer patches (patcher.cjs);
// `$self` has no meaning here. Two routes apply them:
// - the loader, in the backend process: a module load hook edits each chunk as Node loads
//   it, so patches follow app updates without touching the app folder;
// - `t3mods server-patch`: writes the patched chunks into server.asar itself (Windows), for
//   machines without the loader. A chunk patched that way starts with a marker that lists
//   the patch keys it holds, so the load hook and the doctor skip those patches.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const P = require("./patcher.cjs");

const FILE = "server-patches.cjs";
const DIST = "apps/server/dist";
const MARKER = "/*t3mods:server-patched ";
const HEALTHY = new Set(["ok", "skipped", "baked"]);

// Keys of the patches written into this chunk by `t3mods server-patch`.
function bakedKeys(text) {
  const head = text.slice(0, 4096);
  const at = head.indexOf(MARKER);
  if (at === -1) return new Set();
  const end = head.indexOf("*/", at);
  try {
    return new Set(JSON.parse(head.slice(at + MARKER.length, end)));
  } catch {
    return new Set();
  }
}

// Puts the marker on its own line, after a shebang if there is one.
function markText(text, keys) {
  const line = `${MARKER}${JSON.stringify(keys)}*/\n`;
  if (!text.startsWith("#!")) return line + text;
  const nl = text.indexOf("\n") + 1;
  return text.slice(0, nl) + line + text.slice(nl);
}

function loadPatches(mods) {
  const patches = [];
  const errors = new Map();
  for (const m of mods) {
    if (!m.enabled || !m.files?.serverPatches) continue;
    try {
      const file = path.join(m.dir, FILE);
      delete require.cache[require.resolve(file)];
      patches.push(...P.normalize(m.id, require(file)));
    } catch (e) {
      errors.set(m.id, [`${FILE}: ${String(e?.message ?? e)}`]);
    }
  }
  return { patches, errors };
}

// Doctor plus health for server patches. A mod with a failed non-optional server patch runs
// none of its server patches (fail closed); the rest of the backend is unaffected.
// chunks: [{ name, text }]; activeOf(p) -> { active, error? } as in patcher.doctor.
function check(patches, chunks, activeOf = () => ({ active: true }), errors = new Map()) {
  const baked = new Set(chunks.flatMap((c) => [...bakedKeys(c.text)]));
  const live = patches.filter((p) => !baked.has(p.key));
  const report = P.doctor(live, chunks, activeOf);
  const byKey = new Map(report.results.map((r) => [r.key, r]));
  const results = patches.map((p) => byKey.get(p.key) ?? { key: p.key, mod: p.mod, id: p.id, find: String(p.find), optional: Boolean(p.optional), status: "baked", chunks: [] });
  const health = new Map();
  for (const id of new Set([...patches.map((p) => p.mod), ...errors.keys()])) {
    const problems = [...(errors.get(id) ?? []), ...results.filter((r) => r.mod === id && !r.optional && !HEALTHY.has(r.status)).map((r) => `server patch ${r.key}: ${r.status}`)];
    health.set(id, { status: problems.length ? "degraded" : "ok", problems });
  }
  const active = new Set(results.filter((r) => r.status === "ok" && health.get(r.mod)?.status === "ok").map((r) => r.key));
  return { results, health, active, ms: report.ms, chunks: report.chunks };
}

function readDistChunks(distDir) {
  return fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".mjs"))
    .map((name) => ({ name, text: fs.readFileSync(path.join(distDir, name), "utf8") }));
}

// Applies the active, not yet baked patches to one chunk.
function patchChunk(patches, active, text, onIssue) {
  const baked = bakedKeys(text);
  return P.applyAll(patches, text, (p) => active.has(p.key) && !baked.has(p.key), onIssue);
}

// Loader route: runs in the backend before bin.mjs loads. Never throws into a module load:
// on any error the chunk loads unpatched.
function installHooks({ distDir, mods, log }) {
  const { patches, errors } = loadPatches(mods);
  if (!patches.length && !errors.size) return null;
  const store = require("./store.cjs");
  const result = check(patches, readDistChunks(distDir), (p) => P.evalPredicate(p, { state: store.readState(p.mod) }), errors);
  for (const r of result.results) if (!HEALTHY.has(r.status)) log(`server patch ${r.status}:`, r.key);
  for (const [id, h] of result.health) if (h.status === "degraded") log(`server patches off for ${id}:`, h.problems.join("; "));
  if (!result.active.size) return result;
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const prefix = fold(`${pathToFileURL(distDir).href}/`);
  require("node:module").registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      try {
        if (loaded.source == null || !url.endsWith(".mjs") || !fold(url).startsWith(prefix)) return loaded;
        const text = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
        const out = patchChunk(patches, result.active, text, (p, msg) => log(`server patch ${p.key} on ${path.basename(url)}: ${msg}`));
        return out === text ? loaded : { ...loaded, source: out };
      } catch (e) {
        log("server patch hook failed; chunk loads unpatched:", url, String(e?.message ?? e));
        return loaded;
      }
    },
  });
  log(`server patches active: ${[...result.active].join(", ")}`);
  return result;
}

// asar route: builds the patched chunks of `asarFile`. Returns the check result and
// { name: Buffer } of changed chunks, each marked with the keys it now holds.
function bakeAsar(asarFile, patches, activeOf, errors) {
  const asar = require("./asar.cjs");
  const chunks = asar
    .listDir(asarFile, DIST)
    .filter((n) => n.endsWith(".mjs"))
    .map((name) => ({ name, text: asar.readFile(asarFile, `${DIST}/${name}`).toString("utf8") }));
  const result = check(patches, chunks, activeOf, errors);
  const changes = {};
  for (const c of chunks) {
    const keys = [];
    let text = c.text;
    for (const p of patches) {
      if (!result.active.has(p.key)) continue;
      const next = P.applyAll([p], text, () => true);
      if (next !== text) keys.push(p.key);
      text = next;
    }
    if (keys.length) changes[c.name] = Buffer.from(markText(text, [...bakedKeys(c.text), ...keys]), "utf8");
  }
  return { result, changes };
}

module.exports = { FILE, DIST, MARKER, bakedKeys, markText, loadPatches, check, readDistChunks, patchChunk, installHooks, bakeAsar };
