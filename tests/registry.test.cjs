const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-registry-test-"));
process.env.T3MODS_DIR = path.join(dir, "mods");
process.env.T3MODS_TOKEN_FILE = path.join(dir, "home", "t3mods-registry.json");
delete process.env.T3MODS_TOKEN;
const store = require("../loader/store.cjs");
const registry = require("../loader/registry.cjs");
const { createFakeRegistry, makeZip, sha } = require("./helpers/fake-registry.cjs");

const CLI = path.join(__dirname, "..", "loader", "t3mods.mjs");
let reg;
let other; // a second server: the "foreign origin"
test.before(async () => {
  reg = await createFakeRegistry();
  other = await createFakeRegistry();
  process.env.T3MODS_REGISTRY = reg.url;
});
test.after(async () => {
  await reg.close();
  await other.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const modsOnDisk = () => (fs.existsSync(store.MODS_DIR) ? fs.readdirSync(store.MODS_DIR).filter((n) => !n.startsWith(".")).sort() : []);
const read = (id, f) => fs.readFileSync(path.join(store.MODS_DIR, id, f), "utf8");
// Async: the fake registry lives in this process, so a blocking spawn would starve it.
const cli = (args, env = {}) =>
  new Promise((resolve) =>
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env, T3MODS_HOME: path.join(dir, "kit") } }, (e, stdout, stderr) =>
      resolve({ status: e ? (e.code ?? 1) : 0, stdout, stderr }),
    ),
  );

// Puts a real mod on disk, as the victim of an overwrite attempt.
function installVictim() {
  store.installArchive(makeZip("victim", "1.0.0", { "style.css": "victim{}" }), "file:victim.zip");
}
// Asserts that a failed install changed nothing on disk.
function assertUntouched(before) {
  assert.deepEqual(modsOnDisk(), before.mods);
  assert.deepEqual(store.sources(), before.sources);
  if (before.victim) assert.equal(read("victim", "style.css"), "victim{}");
}
const snapshot = () => ({ mods: modsOnDisk(), sources: store.sources(), victim: modsOnDisk().includes("victim") });

test("resolve, download, verify and install record registry provenance", async () => {
  reg.addVersion("demo", "1.0.0", { "style.css": "a{}" });
  const prepared = await registry.prepare("demo");
  assert.equal(prepared.info.version, "1.0.0");
  assert.deepEqual(modsOnDisk(), [], "prepare writes nothing");
  const out = registry.install(prepared);
  assert.equal(out.id, "demo");
  assert.equal(read("demo", "style.css"), "a{}");
  const src = store.sources().demo;
  assert.equal(src.source, "registry:demo@1.0.0");
  assert.equal(src.registry, reg.url);
  assert.equal(src.version, "1.0.0");
  assert.equal(src.sha256, prepared.info.sha256);
  assert.equal(src.sha256, sha(prepared.buf));
});

test("without a version the newest non-yanked one wins; a named version is honored", async () => {
  reg.addVersion("pick", "1.0.0", { "style.css": "v1" });
  reg.addVersion("pick", "1.10.0", { "style.css": "v110" });
  reg.addVersion("pick", "1.2.0", { "style.css": "v12" });
  reg.addVersion("pick", "2.0.0", { "style.css": "v2" }, { yanked: true });
  assert.equal((await registry.resolve("pick")).info.version, "1.10.0");
  assert.equal((await registry.resolve("pick", "1.2.0")).info.version, "1.2.0");
  await assert.rejects(registry.resolve("pick", "9.9.9"), /no version 9\.9\.9/);
  await assert.rejects(registry.resolve("nope"), /No such mod/);
});

test("a sha256 mismatch is rejected and nothing is written", async () => {
  installVictim();
  // The registry metadata says one hash, the bytes it serves hash differently.
  reg.addVersion("victim", "2.0.0", { "style.css": "evil{}" }, { tamper: { serve: makeZip("victim", "2.0.0", { "style.css": "evil{}" , "x": "tampered" }) } });
  const before = snapshot();
  await assert.rejects(registry.prepare("victim@2.0.0"), /sha256 mismatch/);
  assertUntouched(before);
});

test("an archive for another id is rejected: a registry entry never overwrites another mod", async () => {
  installVictim();
  // "decoy" is a listing whose (correctly hashed) archive claims to be "victim".
  reg.addVersion("decoy", "1.0.0", {}, { tiers: ["css"], archive: makeZip("victim", "1.0.0", { "style.css": "evil{}" }) });
  const before = snapshot();
  await assert.rejects(registry.prepare("decoy"), /is for "victim", not "decoy"/);
  assertUntouched(before);
  assert.equal(store.sources().decoy, undefined);
});

test("an archive with another version than the metadata is rejected", async () => {
  reg.addVersion("liar", "1.0.0", {}, { archive: makeZip("liar", "0.0.1", {}) });
  const before = snapshot();
  await assert.rejects(registry.prepare("liar"), /holds version 0\.0\.1, not 1\.0\.0/);
  assertUntouched(before);
});

test("a download URL on a foreign origin is rejected before any request", async () => {
  const bytes = makeZip("far", "1.0.0", {});
  other.addVersion("far", "1.0.0", {}, { archive: bytes });
  reg.addVersion("far", "1.0.0", {}, { archive: bytes, tamper: { downloadUrl: `${other.url}/api/v1/mods/far/versions/1.0.0/download` } });
  const before = snapshot();
  const seen = other.log.length;
  await assert.rejects(registry.prepare("far"), /not the registry's origin/);
  assert.equal(other.log.length, seen, "the foreign server got no request");
  assertUntouched(before);
  // Same host, other port: the port counts as part of the origin.
  assert.notEqual(new URL(other.url).origin, new URL(reg.url).origin);
});

test("a redirect to another origin is not followed", async () => {
  const bytes = makeZip("hop", "1.0.0", {});
  other.addVersion("hop", "1.0.0", {}, { archive: bytes });
  reg.addVersion("hop", "1.0.0", {}, { archive: bytes, tamper: { redirect: `${other.url}/api/v1/mods/hop/versions/1.0.0/download` } });
  const before = snapshot();
  const seen = other.log.length;
  await assert.rejects(registry.prepare("hop"), /redirect/i);
  assert.equal(other.log.length, seen, "the redirect target got no request");
  assertUntouched(before);
});

test("the 5 MiB cap holds for a declared length and for a chunked body", async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 7);
  reg.addVersion("big", "1.0.0", {}, { archive: makeZip("big", "1.0.0", {}), tamper: { serve: big } });
  reg.addVersion("chunky", "1.0.0", {}, { tamper: { chunkedBytes: 20 * 1024 * 1024 } });
  const before = snapshot();
  await assert.rejects(registry.prepare("big"), /larger than 5 MiB/);
  await assert.rejects(registry.prepare("chunky"), /larger than 5 MiB/);
  assertUntouched(before);
});

test("install links: good and bad inputs", () => {
  const ok = (url, id, version = null) => assert.deepEqual(registry.parseInstallLink(url), { id, version });
  ok("t3mods://install/clean-tools", "clean-tools");
  ok("t3mods://install/clean-tools@1.2.3", "clean-tools", "1.2.3");
  ok("t3mods://install/a.b_c-1@1.0.0-beta.1", "a.b_c-1", "1.0.0-beta.1");
  ok("t3mods://install/clean-tools/", "clean-tools");
  ok("T3MODS://install/clean-tools", "clean-tools");
  for (const bad of [
    "",
    "not a url",
    "https://install/clean-tools",
    "t3mods://install/",
    "t3mods://install",
    "t3mods://remove/clean-tools",
    "t3mods://install/Clean-Tools", // ids are lowercase
    "t3mods://install/../etc",
    "t3mods://install/a/b",
    "t3mods://install/a%2Fb",
    "t3mods://install/a%ZZ",
    "t3mods://install/-x",
    "t3mods://install/x@",
    "t3mods://install/x@latest",
    "t3mods://install/x@1.0",
    "t3mods://install/x?evil=1",
    "t3mods://install/x#frag",
    "t3mods://user:pw@install/x",
    "t3mods://install:80/x",
    `t3mods://install/${"a".repeat(65)}`,
  ]) assert.throws(() => registry.parseInstallLink(bad), undefined, bad);
  assert.equal(registry.findInstallLink(["C:\\app.exe", "--flag", "t3mods://install/x"]), "t3mods://install/x");
  assert.equal(registry.findInstallLink(["app.exe", "--flag"]), null);
});

test("CLI arguments: registry id versus file", () => {
  for (const spec of ["clean-tools", "clean-tools@1.0.0", "a.b"]) assert.equal(registry.looksLikeSpec(spec), true, spec);
  for (const file of ["foo-1.0.0.zip", "mod.t3mod", "./mod", "dir/mod", "C:\\x\\y", "https://x/y.zip", "Upper"]) assert.equal(registry.looksLikeSpec(file), false, file);
});

test("registry URL: https or loopback http only", () => {
  assert.equal(registry.baseUrl("https://t3mods.jonn.cc/"), "https://t3mods.jonn.cc");
  assert.equal(registry.baseUrl("http://127.0.0.1:9/"), "http://127.0.0.1:9");
  for (const bad of ["http://t3mods.jonn.cc", "ftp://x", "file:///etc", "nonsense", "https://u:p@x.cc"]) assert.throws(() => registry.baseUrl(bad), undefined, bad);
});

test("semver precedence, including prereleases", () => {
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(Math.sign(registry.compareVersions(order[i], order[j])), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  }
  assert.equal(registry.compareVersions("1.0.0+build1", "1.0.0+build2"), 0);
  assert.throws(() => registry.compareVersions("1.0", "1.0.0"));
});

test("updates: newer, non-yanked, registry-installed mods only", async () => {
  reg.mods.clear();
  fs.rmSync(store.MODS_DIR, { recursive: true, force: true });
  const addInstalled = (id, version) => {
    reg.addVersion(id, version, { "style.css": "x" });
    registry.install({ id, info: { version }, buf: makeZip(id, version, { "style.css": "x" }) });
  };
  addInstalled("up-newer", "1.0.0");
  reg.addVersion("up-newer", "1.1.0", {});
  addInstalled("up-same", "1.0.0");
  addInstalled("up-yanked", "1.0.0");
  reg.addVersion("up-yanked", "1.5.0", {}, { yanked: true });
  addInstalled("up-pre", "1.0.0-beta.2");
  reg.addVersion("up-pre", "1.0.0-beta.10", {});
  addInstalled("up-pre-stable", "1.0.0-rc.1");
  reg.addVersion("up-pre-stable", "1.0.0", {});
  addInstalled("up-ahead", "3.0.0"); // installed is newer than the registry
  reg.addVersion("up-ahead", "2.0.0", {});
  addInstalled("up-gone", "1.0.0");
  reg.addVersion("up-gone", "1.1.0", {});
  store.uninstall("up-gone"); // sources.json keeps its entry
  // Not from the registry at all:
  store.installArchive(makeZip("up-local", "1.0.0", {}), "file:x.zip");
  reg.addVersion("up-local", "9.0.0", {});
  // From another registry:
  store.installArchive(makeZip("up-elsewhere", "1.0.0", {}), "registry:up-elsewhere@1.0.0", { registry: "https://example.org", version: "1.0.0" });
  reg.addVersion("up-elsewhere", "9.0.0", {});

  const found = await registry.updates();
  assert.deepEqual(found.map((u) => `${u.id} ${u.installed}->${u.latest}`).sort(), ["up-newer 1.0.0->1.1.0", "up-pre 1.0.0-beta.2->1.0.0-beta.10", "up-pre-stable 1.0.0-rc.1->1.0.0"]);
  assert.deepEqual((await registry.updates("up-same")).length, 0);
  assert.deepEqual((await registry.updates("up-newer")).map((u) => u.id), ["up-newer"]);
});

test("search sends the words and returns the registry's result", async () => {
  reg.mods.clear();
  reg.addVersion("findme", "1.0.0", {}, { manifest: { description: "pretty things" } });
  reg.addVersion("other", "1.0.0", {});
  const r = await registry.search("pretty");
  assert.deepEqual(r.mods.map((m) => m.id), ["findme"]);
  assert.match(reg.log.at(-1).url, /^\/api\/v1\/mods\?q=pretty$/);
});

test("login saves the token with mode 0600 and never prints it", { skip: process.platform === "win32" && "Windows has no POSIX modes; the Docker run covers this" }, async () => {
  const token = [...reg.tokens][0];
  const r = await cli(["login", token]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "token reached the output");
  assert.equal(fs.statSync(process.env.T3MODS_TOKEN_FILE).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(process.env.T3MODS_TOKEN_FILE, "utf8")).token, token);
});

test("login with a bad token fails, saves nothing, and does not echo the token", async () => {
  fs.rmSync(process.env.T3MODS_TOKEN_FILE, { force: true });
  const bad = "t3m_thisIsNotAValidTokenAtAllNope1234";
  // The fake echoes the Authorization header in its 401 message, as a careless server might.
  const r = await cli(["login", bad]);
  assert.notEqual(r.status, 0);
  assert.ok(!r.stdout.includes(bad) && !r.stderr.includes(bad), `token leaked: ${r.stderr}`);
  assert.equal(fs.existsSync(process.env.T3MODS_TOKEN_FILE), false);
  assert.match(r.stderr, /registry: /);
});

test("the token file is rewritten with 0600 even when an old one had wider modes", { skip: process.platform === "win32" && "no POSIX modes on Windows" }, () => {
  fs.mkdirSync(path.dirname(process.env.T3MODS_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(process.env.T3MODS_TOKEN_FILE, "{}", { mode: 0o644 });
  registry.saveToken("t3m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(fs.statSync(process.env.T3MODS_TOKEN_FILE).mode & 0o777, 0o600);
});

test("T3MODS_TOKEN wins over the saved token", () => {
  registry.saveToken("t3m_saved_saved_saved_saved_saved_00");
  assert.equal(registry.getToken(), "t3m_saved_saved_saved_saved_saved_00");
  process.env.T3MODS_TOKEN = "t3m_from_env";
  try {
    assert.equal(registry.getToken(), "t3m_from_env");
  } finally {
    delete process.env.T3MODS_TOKEN;
  }
});

test("publish posts the packed folder as application/zip with the bearer token", async () => {
  const mod = path.join(dir, "to-publish");
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, "mod.json"), JSON.stringify({ id: "to-publish", version: "1.0.0" }));
  fs.writeFileSync(path.join(mod, "style.css"), "a{}");
  const token = [...reg.tokens][0];
  const r = await cli(["publish", mod, "--changelog", "first release"], { T3MODS_TOKEN: token });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
  const post = reg.published.at(-1);
  assert.equal(post.type, "application/zip");
  assert.equal(post.changelog, "first release");
  assert.deepEqual(store.inspectArchive(post.buf).manifest.id, "to-publish");
  assert.equal(reg.log.filter((l) => l.method === "POST").at(-1).auth, `Bearer ${token}`);
  // Without any token: refuse before a request.
  const seen = reg.log.length;
  fs.rmSync(process.env.T3MODS_TOKEN_FILE, { force: true });
  const none = await cli(["publish", mod]);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no token/);
  assert.equal(reg.log.length, seen);
});

test("CLI add <id> installs from the registry; add of an existing file stays a file install", async () => {
  reg.mods.clear();
  reg.addVersion("cli-demo", "1.2.3", { "style.css": "c{}" });
  const r = await cli(["add", "cli-demo", "--mods", store.MODS_DIR]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed cli-demo 1\.2\.3/);
  assert.equal(read("cli-demo", "style.css"), "c{}");
  const zip = path.join(dir, "foo-1.0.0.zip");
  fs.writeFileSync(zip, makeZip("from-file", "1.0.0", {}));
  const f = await cli(["add", zip, "--mods", store.MODS_DIR]);
  assert.equal(f.status, 0, f.stderr);
  assert.equal(store.sources()["from-file"].source, "file:foo-1.0.0.zip");
  // The 404 path prints a message, not a stack.
  const miss = await cli(["add", "no-such-mod", "--mods", store.MODS_DIR]);
  assert.notEqual(miss.status, 0);
  assert.ok(!/\n\s+at /.test(miss.stderr), miss.stderr);
});

test("the saved token is sent only to the registry it was saved for", async () => {
  const mod = path.join(dir, "to-publish");
  const token = [...reg.tokens][0];
  registry.saveToken(token, reg.url);
  assert.equal(registry.getToken(), token);
  process.env.T3MODS_REGISTRY = other.url;
  try {
    assert.equal(registry.getToken(), null);
    const seen = other.log.length;
    const r = await cli(["publish", mod], { T3MODS_REGISTRY: other.url });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no token/);
    assert.deepEqual(other.log.slice(seen).filter((l) => l.auth), [], "the token reached another registry");
  } finally {
    process.env.T3MODS_REGISTRY = reg.url;
  }
});

test("an unlisted mod (404) does not stop the update check of the others", async () => {
  reg.mods.clear();
  fs.rmSync(store.MODS_DIR, { recursive: true, force: true });
  for (const id of ["gone-mod", "live-mod"]) {
    reg.addVersion(id, "1.0.0", {});
    registry.install({ id, info: { version: "1.0.0" }, buf: makeZip(id, "1.0.0", {}) });
  }
  reg.addVersion("live-mod", "1.1.0", {});
  reg.mods.delete("gone-mod");
  assert.deepEqual((await registry.updates()).map((u) => u.id), ["live-mod"]);
  // Other errors still surface, so the UI can show them.
  await reg.close();
  try {
    await assert.rejects(registry.updates(), /registry request failed/);
  } finally {
    reg = await createFakeRegistry();
    process.env.T3MODS_REGISTRY = reg.url;
  }
});

test("without a version the registry's own latest wins over a newer prerelease", async () => {
  reg.addVersion("chan", "1.5.0", {});
  reg.addVersion("chan", "2.0.0-beta.1", {});
  reg.setLatest("chan", "1.5.0");
  assert.equal((await registry.resolve("chan")).info.version, "1.5.0");
  assert.equal((await registry.resolve("chan", "2.0.0-beta.1")).info.version, "2.0.0-beta.1");
  // A yanked latest falls back to the newest usable version.
  reg.addVersion("chan2", "1.0.0", {});
  reg.addVersion("chan2", "1.1.0", {}, { yanked: true });
  reg.setLatest("chan2", "1.1.0");
  assert.equal((await registry.resolve("chan2")).info.version, "1.0.0");
});

test("text from the registry is one bounded line in a confirm dialog", () => {
  const forged = "nice mod\nsha256 0000000000000000\nFrom t3mods.jonn.cc";
  assert.equal(registry.oneLine(forged).includes("\n"), false);
  assert.equal(registry.oneLine("x".repeat(500)).length, 120);
});

test("an archive that holds a tier the registry did not list is refused", async () => {
  reg.addVersion("liar", "1.0.0", { "style.css": "a{}", "main.cjs": "module.exports = () => {}" }, { tiers: ["css"] });
  const before = snapshot();
  await assert.rejects(() => registry.prepare("liar"), /main that the registry did not list/);
  assertUntouched(before);
});

test("patches.cjs counts as full access in the warnings", () => {
  assert.equal(registry.hasFullAccess(["css", "patches"]), true);
  assert.equal(registry.hasFullAccess(["css", "renderer"]), false);
  assert.match(registry.tierWarning(["patches"]).join(), /Electron main process.*full access/);
});

test("t3mods update asks before a new code tier: no answer is no, --yes is yes", async () => {
  reg.addVersion("grow", "1.0.0", { "style.css": "a{}" });
  registry.install(await registry.prepare("grow"));
  reg.addVersion("grow", "1.0.1", { "style.css": "a{}", "patches.cjs": "module.exports = []" });
  const refused = await cli(["update", "grow", "--mods", store.MODS_DIR]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /adds code.*patches/);
  assert.equal(fs.existsSync(path.join(store.MODS_DIR, "grow", "patches.cjs")), false, "the code was installed without consent");
  const yes = await cli(["update", "grow", "--yes", "--mods", store.MODS_DIR]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(fs.existsSync(path.join(store.MODS_DIR, "grow", "patches.cjs")), true);
  // An update that adds nothing risky needs no answer.
  reg.addVersion("grow", "1.0.2", { "style.css": "b{}", "patches.cjs": "module.exports = []" });
  assert.equal((await cli(["update", "grow", "--mods", store.MODS_DIR])).status, 0);
});

test("t3mods add names a withdrawn version and a patches tier before it installs", async () => {
  reg.addVersion("old-sec", "1.0.0", { "patches.cjs": "module.exports = []" }, { yanked: true });
  const r = await cli(["add", "old-sec@1.0.0", "--mods", store.MODS_DIR]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /withdrew old-sec 1.0.0/);
  assert.match(r.stdout, /note: It patches the app's own code.*main process/);
  assert.ok(r.stdout.indexOf("note:") < r.stdout.indexOf("installed old-sec"), "the notes must come first");
});

test("t3mods login takes the token from stdin or T3MODS_TOKEN, not only argv", async () => {
  const token = [...reg.tokens][0];
  const viaEnv = await cli(["login"], { T3MODS_TOKEN: token });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  const viaArgv = await cli(["login", token]);
  assert.match(viaArgv.stderr, /shell history/);
  const child = execFile(process.execPath, [CLI, "login"], { encoding: "utf8", env: { ...process.env, T3MODS_TOKEN: "", T3MODS_HOME: path.join(dir, "kit") } });
  const out = await new Promise((resolve) => {
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(`${token}
`);
  });
  assert.equal(out.code, 0, out.stdout);
  assert.match(out.stdout, /logged in as/);
});

test("t3mods new takes lowercase ids only, like the registry", async () => {
  const r = await cli(["new", "MyMod", "--mods", store.MODS_DIR]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lowercase/);
});
