// Vencord-style text patches for the app's bundled chunks. Pure functions: the loader feeds
// them chunk text; tests feed them strings.
//
// Patch shape (one entry of a mod's patches.cjs array):
//   {
//     id?: "palette",            // stable name for `requires`; defaults to the array index
//     find: string | RegExp,     // selects the chunk; should hit exactly one
//     replace?: [{ match: RegExp | string, flags?, replace: string | Function }],
//     transform?: (text, { self }) => text, // edits that need names captured elsewhere in the chunk
//     group?: true,              // all entries apply, or the chunk stays untouched
//     optional?: true,           // a failure does not degrade the mod
//     predicate?: ({ state }) => boolean, // false skips the patch (state = the mod's saved state)
//   }
// In replacements, `\i` matches one minified identifier and `$self` refers to the mod's
// renderer exports (`globalThis.__t3mods.exports[modId]`).
"use strict";

const IDENT = "(?:[A-Za-z_$][\\w$]*)";

function compileMatch(match, flags) {
  const source = match instanceof RegExp ? match.source : String(match);
  return new RegExp(source.replaceAll("\\i", IDENT), match instanceof RegExp ? match.flags : (flags ?? ""));
}

// Optional chaining keeps a patched chunk working when the runtime is missing.
const selfRef = (mod) => `(globalThis.__t3mods?.exports?.[${JSON.stringify(mod)}]??{})`;

function withSelf(replace, mod) {
  if (typeof replace === "function") return (...args) => String(replace(...args)).replaceAll("$self", selfRef(mod));
  return String(replace).replaceAll("$self", selfRef(mod));
}

function hasFind(p, text) {
  return p.find instanceof RegExp ? new RegExp(p.find.source, p.find.flags.replace("g", "")).test(text) : text.includes(p.find);
}

// Validates and annotates the array a mod's patches.cjs exports. Throws on a malformed patch,
// so one bad entry fails the whole file loudly instead of half-loading it.
function normalize(mod, list) {
  if (!Array.isArray(list)) throw new TypeError(`${mod}: patches.cjs must export an array`);
  return list.map((p, i) => {
    const id = String(p.id ?? i);
    const where = `${mod}/${id}`;
    if (typeof p.find !== "string" && !(p.find instanceof RegExp)) throw new TypeError(`${where}: find must be a string or RegExp`);
    if (p.replace !== undefined && !Array.isArray(p.replace)) throw new TypeError(`${where}: replace must be an array`);
    if (!p.replace?.length && typeof p.transform !== "function") throw new TypeError(`${where}: needs replace or transform`);
    for (const r of p.replace ?? []) {
      if (!r || r.match === undefined || r.replace === undefined) throw new TypeError(`${where}: each replace entry needs match and replace`);
    }
    return { ...p, id, mod, key: where, replace: p.replace ?? [] };
  });
}

// Applies one patch to one chunk. Never throws: a broken patch leaves the text as it was.
// `entries` has one boolean per replace entry (+ one for transform): did it change the text?
function applyPatch(p, text) {
  let out = text;
  const entries = [];
  try {
    for (const r of p.replace) {
      const next = out.replace(compileMatch(r.match, r.flags), withSelf(r.replace, p.mod));
      entries.push(next !== out);
      out = next;
    }
    if (p.transform) {
      const next = p.transform(out, { self: selfRef(p.mod) });
      if (typeof next !== "string") throw new TypeError("transform must return a string");
      entries.push(next !== out);
      out = next;
    }
  } catch (error) {
    return { text, ok: false, entries, error: String(error?.message ?? error) };
  }
  const ok = entries.every(Boolean);
  if (p.group && !ok) return { text, ok, entries };
  return { text: out, ok, entries };
}

function evalPredicate(p, ctx) {
  if (typeof p.predicate !== "function") return { active: true };
  try {
    return { active: Boolean(p.predicate(ctx)) };
  } catch (error) {
    return { active: false, error: String(error?.message ?? error) };
  }
}

// Checks every patch against every chunk of the installed build. Patches apply in order on
// top of each other, as at serve time, so two mods that edit the same code show up here.
// chunks: [{ name, text }]. activeOf(p) -> { active, error? } from evalPredicate.
function doctor(patches, chunks, activeOf = () => ({ active: true })) {
  const t0 = Date.now();
  chunks = chunks.map((c) => ({ ...c }));
  const results = patches.map((p) => {
    const base = { key: p.key, mod: p.mod, id: p.id, find: String(p.find), optional: Boolean(p.optional) };
    const pred = activeOf(p);
    if (pred.error) return { ...base, status: "error", error: `predicate: ${pred.error}`, chunks: [] };
    if (!pred.active) return { ...base, status: "skipped", chunks: [] };
    const hits = chunks.filter((c) => hasFind(p, c.text));
    if (hits.length === 0) return { ...base, status: "find-missing", chunks: [] };
    const names = hits.map((c) => c.name);
    if (hits.length > 1) return { ...base, status: "find-ambiguous", chunks: names };
    const r = applyPatch(p, hits[0].text);
    hits[0].text = r.text;
    const status = r.error ? "error" : r.ok ? "ok" : r.entries.some(Boolean) ? "partial" : "match-missing";
    return { ...base, status, chunks: names, entries: r.entries, ...(r.error ? { error: r.error } : {}) };
  });
  return { ms: Date.now() - t0, chunks: chunks.length, results };
}

const HEALTHY = new Set(["ok", "skipped"]);

// Decides which mods may run. A mod is degraded when one of its own non-optional patches
// fails, or when something in its manifest `requires` is missing or unhealthy:
//   "core"                 -> mod `core` is enabled and healthy
//   "core/timeline-row"    -> that patch is ok (or skipped)
// mods: [{ id, enabled, manifest }]; results: doctor results; extra: Map id -> [problems]
// found elsewhere (e.g. a patches.cjs that does not load).
function resolveHealth(mods, results, extra = new Map()) {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const health = new Map();
  for (const m of mods) {
    if (!m.enabled) {
      health.set(m.id, { status: "disabled", problems: [] });
      continue;
    }
    const problems = [...(extra.get(m.id) ?? []), ...results.filter((r) => r.mod === m.id && !r.optional && !HEALTHY.has(r.status)).map((r) => `patch ${r.key}: ${r.status}`)];
    health.set(m.id, { status: problems.length ? "degraded" : "ok", problems });
  }
  // Requirements can chain (a -> b -> core), so repeat until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of mods) {
      const h = health.get(m.id);
      if (h.status !== "ok") continue;
      for (const req of m.manifest?.requires ?? []) {
        const [modId, patchId] = String(req).split("/");
        const dep = health.get(modId);
        let problem = null;
        if (!dep) problem = `requires ${req}: mod not installed`;
        else if (dep.status !== "ok") problem = `requires ${req}: mod ${dep.status}`;
        else if (patchId !== undefined && !HEALTHY.has(byKey.get(req)?.status)) problem = `requires ${req}: ${byKey.get(req)?.status ?? "no such patch"}`;
        if (problem) {
          h.status = "degraded";
          h.problems.push(problem);
          changed = true;
        }
      }
    }
  }
  return health;
}

// Serve-time: applies the patches that `isActive(p)` allows to one chunk. stats: Map key -> hits.
function applyAll(patches, text, isActive, onIssue = () => {}, stats) {
  for (const p of patches) {
    if (!isActive(p) || !hasFind(p, text)) continue;
    const r = applyPatch(p, text);
    if (r.error) onIssue(p, `error: ${r.error}`);
    else if (!r.ok) onIssue(p, `entries ${JSON.stringify(r.entries)}${p.group ? " (group: not applied)" : ""}`);
    if (r.text !== text) stats?.set(p.key, (stats.get(p.key) ?? 0) + 1);
    text = r.text;
  }
  return text;
}

// Patch Helper: tries one ad-hoc patch against all chunks and returns small diffs.
function tryPatch(p, chunks, context = 120) {
  const patch = normalize("helper", [p])[0];
  return chunks
    .filter((c) => hasFind(patch, c.text))
    .slice(0, 5)
    .map((c) => {
      const r = applyPatch(patch, c.text);
      let i = 0;
      while (i < c.text.length && c.text[i] === r.text[i]) i++;
      const changed = r.text !== c.text;
      return {
        chunk: c.name,
        entries: r.entries,
        error: r.error,
        before: changed ? c.text.slice(Math.max(0, i - context), i + context) : null,
        after: changed ? r.text.slice(Math.max(0, i - context), i + context + (r.text.length - c.text.length)) : null,
      };
    });
}

module.exports = { IDENT, compileMatch, normalize, applyPatch, evalPredicate, doctor, resolveHealth, applyAll, tryPatch, selfRef };
