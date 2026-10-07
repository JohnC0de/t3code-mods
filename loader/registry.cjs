// Client for the t3mods registry (contract: docs/architecture.md, "Registry"). Used by the CLI
// and by the main process (Browse tab, t3mods:// links). Node built-ins only.
// Rules that keep a registry entry from doing harm:
// - downloads must come from the registry's own origin, and no request follows a redirect
//   (a redirect on publish or login would carry the token along);
// - the bytes must match the sha256 in the registry's metadata, and the archive's mod.json
//   id must be the id that was asked for, so an entry can never overwrite another mod;
// - nothing is written before all checks pass.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const store = require("./store.cjs");

const DEFAULT_REGISTRY = "https://t3mods.jonn.cc";
const MAX_ARCHIVE = 5 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIMEOUT_MS = 30_000;

// ---------- base URL ----------

// The registry base URL: https, or http on loopback (tests). Without a trailing slash.
function baseUrl(raw = process.env.T3MODS_REGISTRY || DEFAULT_REGISTRY) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`bad registry URL: ${raw}`);
  }
  const loopback = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !loopback) throw new Error("the registry URL must be https (or http on 127.0.0.1 / localhost)");
  if (u.username || u.password) throw new Error("the registry URL must not hold credentials");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

// ---------- ids, links, versions ----------

// "id" or "id@version". Throws on anything else.
function parseSpec(spec) {
  const m = /^([^@]+)(?:@(.+))?$/.exec(String(spec ?? ""));
  if (!m || !ID_RE.test(m[1])) throw new Error(`not a registry mod id: ${spec}`);
  if (m[2] !== undefined && !parseSemver(m[2])) throw new Error(`not a version: ${m[2]}`);
  return { id: m[1], version: m[2] ?? null };
}

// Does this CLI argument name a registry mod? Archive paths and URLs never do.
const looksLikeSpec = (arg) => {
  try {
    if (/\.(zip|t3mod)$/i.test(arg) || /[\\/:]/.test(arg)) return false;
    parseSpec(arg);
    return true;
  } catch {
    return false;
  }
};

// t3mods://install/<id>[@<version>] -> { id, version }. Throws on anything else; the result
// is the only thing a link may influence.
function parseInstallLink(link) {
  if (/(^|\/)\.\.?(\/|$)/.test(String(link).replace(/^[a-z0-9]+:\/\//i, ""))) throw new Error("dot segments in the install link");
  let u;
  try {
    u = new URL(String(link));
  } catch {
    throw new Error("not a URL");
  }
  if (u.protocol !== "t3mods:") throw new Error("not a t3mods:// link");
  // t3mods://install/<id>: "install" is the host. Browsers differ on t3mods:/install/... forms.
  const parts = [u.hostname, ...u.pathname.split("/")].filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "install") throw new Error("only t3mods://install/<id> links are supported");
  if (u.username || u.password || u.port || u.search || u.hash) throw new Error("unexpected parts in the install link");
  let spec;
  try {
    spec = decodeURIComponent(parts[1]);
  } catch {
    throw new Error("bad escape in the install link");
  }
  return parseSpec(spec);
}

// The link in a process argv, if any.
const findInstallLink = (argv) => argv.find((a) => typeof a === "string" && /^t3mods:/i.test(a)) ?? null;

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? ""));
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
}

// Semver 2.0 precedence: negative, 0 or positive. Throws on a non-semver string.
function compareVersions(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semver version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// The version to install when none is named: what the registry calls `latest` (it decides about
// prereleases), unless that is yanked; then the newest non-yanked one by semver.
function pickLatest(detail) {
  const l = detail.latest;
  return l && !l.yanked && parseSemver(l.version) ? l : newestUsable(detail);
}

// The newest version that is not yanked, or null.
function newestUsable(detail) {
  const list = (detail.versions?.length ? detail.versions : [detail.latest]).filter((v) => v && !v.yanked && parseSemver(v.version));
  return list.reduce((best, v) => (!best || compareVersions(v.version, best.version) > 0 ? v : best), null);
}

// ---------- tokens ----------

const tokenFile = () => process.env.T3MODS_TOKEN_FILE || path.join(os.homedir(), ".t3", "t3mods-registry.json");

// The env var wins, and is the user's explicit choice. The saved token belongs to the registry
// it was checked against: for any other T3MODS_REGISTRY it is not sent.
function getToken() {
  if (process.env.T3MODS_TOKEN) return process.env.T3MODS_TOKEN.trim();
  try {
    const saved = JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
    return typeof saved.token === "string" && saved.token && saved.registry === baseUrl() ? saved.token : null;
  } catch {
    return null;
  }
}

function saveToken(token, registry = baseUrl()) {
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ registry, token }, null, 1)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // an existing tmp file keeps its old mode
  fs.renameSync(tmp, file);
}

// Error messages must never carry a token, whatever the server echoes back.
const redact = (text) => String(text).replace(/t3m_[A-Za-z0-9_-]+/g, "t3m_…").replace(/(Bearer\s+)\S+/gi, "$1…");

// ---------- HTTP ----------

async function request(url, { method = "GET", headers = {}, body, token } = {}) {
  const h = { accept: "application/json", ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method, headers: h, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(redact(`registry request failed: ${e.cause?.message ?? e.message}`));
  }
  return res;
}

async function failure(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error?.message) msg = `${body.error.message} (${body.error.code ?? res.status})`;
  } catch {}
  return Object.assign(new Error(redact(`registry: ${msg}`)), { status: res.status });
}

async function getJson(pathAndQuery, token) {
  const res = await request(`${baseUrl()}${pathAndQuery}`, { token });
  if (!res.ok) throw await failure(res);
  return res.json();
}

// Reads a body up to `cap` bytes; stops at once when it is bigger (a chunked body has no
// length header to trust).
async function readCapped(res, cap) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > cap) throw new Error(`archive is larger than ${cap / 1024 / 1024} MiB`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > cap) {
      await res.body.cancel?.().catch(() => {});
      throw new Error(`archive is larger than ${cap / 1024 / 1024} MiB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Confirm dialogs show registry text: one line, bounded, so it cannot fake other lines.
const oneLine = (text, max = 120) => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ---------- API ----------

async function search(q = "", { sort, tag, page, limit } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  for (const [k, v] of Object.entries({ sort, tag, page, limit })) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return getJson(`/api/v1/mods${qs ? `?${qs}` : ""}`);
}

// Metadata for one mod and the version to install: the named one, else the newest that is
// not yanked. Returns { detail, info }.
async function resolve(id, version = null) {
  parseSpec(version ? `${id}@${version}` : id);
  const detail = await getJson(`/api/v1/mods/${encodeURIComponent(id)}`);
  if (detail.id !== id) throw new Error(`registry answered for ${detail.id}, not ${id}`);
  const info = version ? detail.versions?.find((v) => v.version === version) : pickLatest(detail);
  if (!info) throw new Error(version ? `${id} has no version ${version}` : `${id} has no installable version`);
  return { detail, info };
}

// Downloads one version and checks it. Nothing is installed. Returns { buf, manifest }.
async function download(id, info) {
  const base = baseUrl();
  let url;
  try {
    url = new URL(info.downloadUrl);
  } catch {
    throw new Error("the registry gave a bad download URL");
  }
  if (url.origin !== new URL(base).origin) throw new Error(`download URL ${url.origin} is not the registry's origin ${new URL(base).origin}`);
  if (!/^[0-9a-f]{64}$/.test(info.sha256 ?? "")) throw new Error("the registry gave no sha256 for this version");
  const res = await request(url, { headers: { accept: "application/zip" } });
  if (!res.ok) throw await failure(res);
  const buf = await readCapped(res, MAX_ARCHIVE);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== info.sha256) throw new Error(`sha256 mismatch for ${id}@${info.version}: expected ${info.sha256}, got ${sha}`);
  const { manifest, files } = store.inspectArchive(buf);
  // The consent text comes from the registry's tier list. The archive is what runs, so it must
  // not hold a tier that the list leaves out.
  const hidden = store.archiveTiers(files).filter((t) => !(info.tiers ?? []).includes(t));
  if (hidden.length) throw new Error(`the archive holds ${hidden.join(", ")} that the registry did not list for ${id}@${info.version}; refusing to install`);
  if (manifest.id !== id) throw new Error(`the archive is for "${manifest.id}", not "${id}"; refusing to install`);
  if (manifest.version !== info.version) throw new Error(`the archive holds version ${manifest.version}, not ${info.version}; refusing to install`);
  return { buf, manifest };
}

// resolve + download + verify. The result goes to install() (after the user confirmed).
async function prepare(spec) {
  const { id, version } = typeof spec === "string" ? parseSpec(spec) : spec;
  const { detail, info } = await resolve(id, version);
  const { buf, manifest } = await download(id, info);
  return { id, detail, info, buf, manifest };
}

// Writes a prepared archive into the mods folder, with provenance in sources.json.
function install(prepared) {
  const { id, info, buf } = prepared;
  return store.installArchive(buf, `registry:${id}@${info.version}`, { registry: baseUrl(), version: info.version });
}

// Installed registry mods with a newer, non-yanked version: [{ id, name, installed, latest, info }].
async function updates(only = null) {
  const base = baseUrl();
  const sources = store.sources();
  const out = [];
  for (const mod of store.listMods()) {
    const src = sources[mod.id];
    if (mod.builtin || !src?.registry || src.registry !== base || (only && mod.id !== only)) continue;
    const installed = mod.manifest.version ?? src.version;
    let detail;
    try {
      detail = await getJson(`/api/v1/mods/${encodeURIComponent(mod.id)}`);
    } catch (e) {
      if (e.status === 404) continue; // unlisted or removed: no update for this mod only
      throw e;
    }
    const latest = pickLatest(detail);
    if (latest && parseSemver(installed) && compareVersions(latest.version, installed) > 0) {
      out.push({ id: mod.id, name: detail.name ?? mod.id, installed, latest: latest.version, info: latest });
    }
  }
  return out;
}

// Tiers that run Node code with full access to the computer. patches.cjs is one of them: the
// loader require()s it in the Electron main process as soon as the mod is installed.
const FULL_ACCESS_TIERS = ["main", "server", "serverPatches", "patches"];
const hasFullAccess = (tiers = []) => tiers.some((t) => FULL_ACCESS_TIERS.includes(t));

// Which tiers run code outside the page, with a plain sentence for the confirm dialog.
function tierWarning(tiers = []) {
  const warn = [];
  if (tiers.includes("main")) warn.push("It runs code in the Electron main process, with full access to your computer.");
  if (tiers.includes("server")) warn.push("It runs code in the T3 Code backend, with full access to your computer.");
  if (tiers.includes("serverPatches")) warn.push("It patches the T3 Code backend, which then runs its code with full access to your computer.");
  if (tiers.includes("patches")) warn.push("It patches the app's own code, and its patches.cjs runs in the Electron main process, with full access to your computer.");
  if (tiers.includes("renderer")) warn.push("It runs code in the app window and can read your conversations.");
  return warn;
}

async function whoami(token) {
  return getJson("/api/v1/me", token);
}

async function login(token) {
  if (!/^t3m_[A-Za-z0-9_-]{20,}$/.test(token ?? "")) throw new Error("that is not a registry token (they start with t3m_)");
  const me = await whoami(token);
  saveToken(token);
  return me;
}

async function publish(dir, { token = getToken(), changelog } = {}) {
  if (!token) throw new Error("no token: run `t3mods login <token>` (create one at the registry's /settings/tokens) or set T3MODS_TOKEN");
  const buf = store.packDir(dir);
  if (buf.length > MAX_ARCHIVE) throw new Error(`the archive is ${buf.length} bytes; the registry accepts at most ${MAX_ARCHIVE}`);
  const qs = changelog ? `?${new URLSearchParams({ changelog })}` : "";
  const res = await request(`${baseUrl()}/api/v1/mods${qs}`, { method: "POST", headers: { "content-type": "application/zip" }, body: buf, token });
  if (!res.ok) throw await failure(res);
  return res.json();
}

module.exports = {
  DEFAULT_REGISTRY,
  MAX_ARCHIVE,
  baseUrl,
  parseSpec,
  looksLikeSpec,
  parseInstallLink,
  findInstallLink,
  parseSemver,
  compareVersions,
  newestUsable,
  pickLatest,
  tokenFile,
  getToken,
  saveToken,
  redact,
  search,
  resolve,
  download,
  prepare,
  install,
  updates,
  tierWarning,
  FULL_ACCESS_TIERS,
  hasFullAccess,
  oneLine,
  whoami,
  login,
  publish,
};
