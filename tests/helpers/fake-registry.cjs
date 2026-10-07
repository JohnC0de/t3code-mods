// A small fake of the t3mods registry (docs/architecture.md, "Registry"), shared by the unit
// tests and tools/e2e.mjs. Run it alone: node tests/helpers/fake-registry.cjs [--port 4873]
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { writeZip } = require("../../loader/zip.cjs");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// files: { "style.css": "a{}" }; mod.json is added. Returns the zip bytes.
function makeZip(id, version, files = {}, manifest = {}) {
  const all = { "mod.json": JSON.stringify({ id, name: id, version, ...manifest }), ...files };
  return writeZip(Object.entries(all).map(([name, text]) => ({ name, data: Buffer.from(text) })));
}

async function createFakeRegistry({ port = 0 } = {}) {
  const mods = new Map(); // id -> { author, versions: [{ version, buf, tiers, yanked, tamper }] }
  const log = []; // every request: { method, url, auth }
  const published = [];
  const tokens = new Set(["t3m_validtokenvalidtokenvalidtoken1"]);
  let origin = "";

  const tiersOf = (files) => ["css", "renderer", "patches", "server", "serverPatches", "main"].filter((t) => files[{ css: "style.css", renderer: "renderer.js", patches: "patches.cjs", server: "server.cjs", serverPatches: "server-patches.cjs", main: "main.cjs" }[t]] !== undefined);

  // tiers: what the registry lists, when it should differ from the files (a lying registry)
  // tamper: { sha256, downloadUrl, serve (Buffer), redirect (url), chunkedBytes (number) }
  function addVersion(id, version, files = {}, { manifest = {}, yanked = false, tamper = {}, author = "alice", archive, tiers } = {}) {
    const entry = mods.get(id) ?? { author, versions: [] };
    mods.set(id, entry);
    entry.versions.push({ version, buf: archive ?? makeZip(id, version, files, manifest), tiers: tiers ?? tiersOf(files), yanked, tamper, manifest });
  }

  const versionInfo = (id, v) => ({
    version: v.version,
    sha256: v.tamper.sha256 ?? sha(v.buf),
    size: v.buf.length,
    tiers: v.tiers,
    requires: [],
    changelog: null,
    yanked: v.yanked,
    downloads: 3,
    publishedAt: "2026-01-01T00:00:00.000Z",
    downloadUrl: v.tamper.downloadUrl ?? `${origin}/api/v1/mods/${id}/versions/${v.version}/download`,
  });

  const detail = (id) => {
    const m = mods.get(id);
    const infos = m.versions.map((v) => versionInfo(id, v));
    // Like the site: the newest non-yanked version, unless a test pinned another one.
    const { compareVersions } = require("../../loader/registry.cjs");
    const usable = infos.filter((i) => !i.yanked).sort((a, b) => compareVersions(a.version, b.version));
    const latest = infos.find((i) => i.version === m.latest) ?? usable.at(-1) ?? infos.at(-1);
    return {
      id,
      name: m.versions.at(-1).manifest.name ?? id,
      description: m.versions.at(-1).manifest.description ?? `The ${id} mod`,
      author: { login: m.author, name: null, avatarUrl: null },
      latestVersion: latest.version,
      tags: [],
      tiers: latest.tiers,
      downloads: 12,
      rating: { average: 4.5, count: 2 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: `${origin}/mods/${id}`,
      readme: null,
      homepage: null,
      repository: null,
      license: null,
      latest,
      versions: [...infos].reverse(),
      installUrl: `t3mods://install/${id}@${latest.version}`,
    };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin || "http://127.0.0.1");
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const err = (status, code, message) => json(status, { error: { code, message } });
    const authed = () => tokens.has(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));

    if (req.method === "GET" && url.pathname === "/api/v1/mods") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const found = [...mods.keys()].filter((id) => !q || id.includes(q) || (detail(id).description ?? "").toLowerCase().includes(q));
      const list = found.map((id) => {
        const { readme, homepage, repository, license, latest, versions, installUrl, ...summary } = detail(id);
        return summary;
      });
      return json(200, { mods: list, total: list.length, page: 1, limit: 24 });
    }
    let m = /^\/api\/v1\/mods\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && m) return mods.has(m[1]) ? json(200, detail(m[1])) : err(404, "not_found", "No such mod.");
    m = /^\/api\/v1\/mods\/([^/]+)\/versions\/([^/]+)\/download$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const v = mods.get(m[1])?.versions.find((x) => x.version === m[2]);
      if (!v) return err(404, "not_found", "No such version.");
      if (v.tamper.redirect) {
        res.writeHead(302, { location: v.tamper.redirect });
        return res.end();
      }
      if (v.tamper.chunkedBytes) {
        // No content-length: the client must count the bytes itself.
        res.writeHead(200, { "content-type": "application/zip" });
        const chunk = Buffer.alloc(64 * 1024, 1);
        let sent = 0;
        const pump = () => {
          while (sent < v.tamper.chunkedBytes) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        res.on("error", () => {});
        return pump();
      }
      const body = v.tamper.serve ?? v.buf;
      res.writeHead(200, { "content-type": "application/zip", "x-content-sha256": sha(body), "content-length": body.length });
      return res.end(body);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/me") return authed() ? json(200, { login: "alice", name: "Alice", avatarUrl: null }) : err(401, "unauthorized", "Bad token.");
    if (req.method === "POST" && url.pathname === "/api/v1/mods") {
      if (!authed()) return err(401, "unauthorized", `Bad token ${req.headers.authorization ?? ""}.`);
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        published.push({ type: req.headers["content-type"], changelog: url.searchParams.get("changelog"), buf });
        json(201, { id: "published", version: "1.0.0", sha256: sha(buf), url: `${origin}/mods/published` });
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/__e2e/publish") {
      // Test hook (not part of the contract): add a version, as a publish would.
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const { id, version, files } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        addVersion(id, version, files);
        json(200, { ok: true });
      });
      return;
    }
    return err(404, "not_found", "No such route.");
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get url() {
      return origin;
    },
    mods,
    log,
    published,
    tokens,
    addVersion,
    setLatest: (id, version) => (mods.get(id).latest = version),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

module.exports = { createFakeRegistry, makeZip, sha };

if (require.main === module) {
  const i = process.argv.indexOf("--port");
  createFakeRegistry({ port: i > 0 ? Number(process.argv[i + 1]) : 4873 }).then((reg) => {
    reg.addVersion("e2e-reg-demo", "1.0.0", { "style.css": "body{--e2e-reg:1}" }, { manifest: { name: "Registry demo", description: "A CSS mod from the fake registry" } });
    reg.addVersion("e2e-reg-server", "1.0.0", { "server.cjs": "module.exports = () => {};" }, { manifest: { name: "Registry server demo", description: "Runs in the backend" } });
    console.log(`fake registry on ${reg.url}`);
  });
}
