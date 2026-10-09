// calm-thread server: request shape, reply parsing, disk cache, dedupe, concurrency and errors,
// against a stubbed fetch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const make = require("../mods/calm-thread/server.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-ct-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const setup = (state = {}, home) => {
  const h = home || fs.mkdtempSync(path.join(root, "home-"));
  const keyFile = path.join(h, "key.txt");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, "  sk-test\n");
  const st = { modelUrl: "http://127.0.0.1:8317/", keyFile, ...state };
  const logs = [];
  const ctx = { id: "calm-thread", dir: root, app: { home: h }, log: (...a) => logs.push(a.join(" ")), state: () => st };
  return { h, st, logs, mod: make(ctx), cacheFile: path.join(h, "mod-data", "calm-thread", "titles.json"), remake: () => make(ctx) };
};

const reply = (text) => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text }] }) });
const json = (o) => reply(JSON.stringify(o));
const item = (over = {}) => ({ id: "m1", prompt: "fix the bug", answer: "Done.", needs: false, ...over });

// A fetch stub whose calls stay pending until the test settles them.
const deferredFetch = () => {
  const calls = [];
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => calls.push({ url, init, resolve, reject }));
  return calls;
};
const tick = () => new Promise((r) => setImmediate(r));

test("request: URL, both auth headers, model, max_tokens, prompt shape", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => (calls.push({ url, init }), json({ title: "Fixed the bug", needs: null }));
  const { mod } = setup({ model: "m-x" });
  await mod.title(item());
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "http://127.0.0.1:8317/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer sk-test");
  assert.equal(init.headers["x-api-key"], "sk-test");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers["content-type"], "application/json");
  assert.ok(init.signal instanceof AbortSignal);
  const body = JSON.parse(init.body);
  assert.equal(body.model, "m-x");
  assert.equal(body.max_tokens, 120);
  assert.match(body.system, /Reply with JSON only/);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "User prompt:\nfix the bug\n\nAgent answer:\nDone.\n\nSet needs to null.");
});

test("needs:true does not ask for a null needs", async () => {
  const calls = [];
  globalThis.fetch = async (_u, init) => (calls.push(JSON.parse(init.body)), json({ title: "T", needs: "Pick a path" }));
  const { mod } = setup();
  assert.deepEqual(await mod.title(item({ needs: true })), { title: "T", needs: "Pick a path" });
  assert.ok(!calls[0].messages[0].content.includes("Set needs to null"));
});

test("truncation: prompt cut at 600, long answer keeps its start and its last 400 chars", async () => {
  const bodies = [];
  globalThis.fetch = async (_u, init) => (bodies.push(JSON.parse(init.body).messages[0].content), json({ title: "T" }));
  const { mod } = setup();
  const answer = "S".repeat(3000) + "THE-END-QUESTION?" .padStart(400, "e");
  await mod.title(item({ prompt: "p".repeat(5000), answer }));
  const c = bodies[0];
  const [p, a] = c.replace(/\n\nSet needs to null\.$/, "").split("\n\nAgent answer:\n");
  assert.equal(p, "User prompt:\n" + "p".repeat(600));
  assert.ok(a.length <= 2000, `answer ${a.length}`);
  assert.ok(a.startsWith("SSSS"));
  assert.ok(a.endsWith(answer.slice(-400)));
  assert.ok(a.includes("\n…\n"));
});

test("short answer and prompt pass through unchanged", async () => {
  const bodies = [];
  globalThis.fetch = async (_u, init) => (bodies.push(JSON.parse(init.body).messages[0].content), json({ title: "T" }));
  const { mod } = setup();
  const answer = "a".repeat(2000);
  await mod.title(item({ answer }));
  assert.ok(bodies[0].includes(answer));
  assert.ok(!bodies[0].includes("…"));
});

test("parse: fenced JSON, trailing period and wrapping quotes stripped, 80 char cap, empty needs is null", async () => {
  const { mod } = setup();
  globalThis.fetch = async () => reply('Here you go:\n```json\n{"title": "\\"Fixed the login bug.\\"", "needs": ""}\n```');
  assert.deepEqual(await mod.title(item({ id: "a", needs: true })), { title: "Fixed the login bug", needs: null });
  globalThis.fetch = async () => json({ title: "x".repeat(200), needs: "  Approve the push " });
  const r = await mod.title(item({ id: "b", needs: true }));
  assert.equal(r.title.length, 80);
  assert.equal(r.needs, "Approve the push");
});

test("cache hit makes no second request and survives a new instance after dispose", async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, json({ title: "Fixed it", needs: null }));
  const s = setup();
  assert.deepEqual(await s.mod.title(item()), { title: "Fixed it", needs: null });
  assert.deepEqual(await s.mod.title(item()), { title: "Fixed it", needs: null });
  assert.equal(calls, 1);
  assert.equal(s.mod.status().cached, 1);
  s.mod.dispose();
  const disk = JSON.parse(fs.readFileSync(s.cacheFile, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.entries.m1.title, "Fixed it");
  assert.equal(disk.entries.m1.withNeeds, false);
  assert.ok(!Number.isNaN(Date.parse(disk.entries.m1.at)));
  assert.ok(!fs.existsSync(s.cacheFile + ".tmp"));
  const again = s.remake();
  assert.deepEqual(await again.title(item()), { title: "Fixed it", needs: null });
  assert.equal(calls, 1);
  again.dispose();
});

test("a different model does not reuse the cached title", async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, json({ title: "T" }));
  const s = setup();
  await s.mod.title(item());
  s.st.model = "other-model";
  await s.mod.title(item());
  assert.equal(calls, 2);
});

test("needs:true after a cached needs:false entry makes a request; the reverse does not", async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, json({ title: "T", needs: calls === 1 ? "Ignored" : "Pick a path" }));
  const { mod } = setup();
  assert.deepEqual(await mod.title(item()), { title: "T", needs: null });
  assert.deepEqual(await mod.title(item({ needs: true })), { title: "T", needs: "Pick a path" });
  assert.equal(calls, 2);
  assert.deepEqual(await mod.title(item({ needs: true })), { title: "T", needs: "Pick a path" });
  assert.deepEqual(await mod.title(item({ needs: false })), { title: "T", needs: null });
  assert.equal(calls, 2);
});

test("in-flight dedupe: the same id shares one request and one promise", async () => {
  const calls = deferredFetch();
  const { mod } = setup();
  const a = mod.title(item());
  const b = mod.title(item());
  assert.equal(a, b);
  await tick();
  assert.equal(calls.length, 1);
  calls[0].resolve(json({ title: "Once" }));
  assert.deepEqual(await a, { title: "Once", needs: null });
  // After it settles the entry is cached, so there is still one request.
  await mod.title(item());
  assert.equal(calls.length, 1);
});

test("concurrency never exceeds 2 and the queue is FIFO", async () => {
  const calls = deferredFetch();
  let peak = 0;
  let done = 0;
  const { mod } = setup();
  const ps = ["a", "b", "c", "d", "e"].map((id) => mod.title(item({ id })));
  await tick();
  assert.equal(calls.length, 2);
  while (done < 5) {
    peak = Math.max(peak, calls.length - done);
    calls[done].resolve(json({ title: `T${done}` }));
    done++;
    await tick();
  }
  const results = await Promise.all(ps);
  assert.equal(calls.length, 5);
  assert.ok(peak <= 2);
  assert.deepEqual(results.map((r) => r.title), ["T0", "T1", "T2", "T3", "T4"]);
});

test("a failed request frees its slot for queued work", async () => {
  const calls = deferredFetch();
  const { mod } = setup();
  const ps = ["a", "b", "c"].map((id) => mod.title(item({ id })));
  ps.forEach((p) => p.catch(() => {}));
  await tick();
  assert.equal(calls.length, 2);
  calls[0].reject(new Error("boom"));
  await tick();
  assert.equal(calls.length, 3);
  await assert.rejects(ps[0], /boom/);
  calls[1].resolve(json({ title: "B" }));
  calls[2].resolve(json({ title: "C" }));
  assert.equal((await ps[2]).title, "C");
});

test("not configured: rejects with 'not configured' and sends nothing", async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, json({ title: "T" }));
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { mod } = setup({ keyFile: undefined });
    await assert.rejects(mod.title(item()), /^Error: not configured/);
    assert.equal(mod.status().configured, false);
    const missing = setup({ keyFile: path.join(root, "nope.txt") });
    await assert.rejects(missing.mod.title(item()), /^Error: not configured/);
    assert.equal(calls, 0);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("key falls back to ANTHROPIC_API_KEY and base URL to ANTHROPIC_BASE_URL", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => (calls.push({ url, init }), json({ title: "T" }));
  const saved = { k: process.env.ANTHROPIC_API_KEY, u: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = "sk-env";
  process.env.ANTHROPIC_BASE_URL = "https://proxy.example/";
  try {
    const { mod } = setup({ keyFile: undefined, modelUrl: undefined });
    assert.deepEqual({ ...mod.status(), cached: 0 }, { configured: true, url: "https://proxy.example", model: "claude-haiku-5-5", cached: 0 });
    await mod.title(item());
    assert.equal(calls[0].url, "https://proxy.example/v1/messages");
    assert.equal(calls[0].init.headers["x-api-key"], "sk-env");
  } finally {
    for (const [name, v] of [["ANTHROPIC_API_KEY", saved.k], ["ANTHROPIC_BASE_URL", saved.u]]) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  }
});

test("~ in keyFile expands to the home directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".t3mods-ct-"));
  try {
    fs.writeFileSync(path.join(dir, "k"), "sk-home\n");
    const calls = [];
    globalThis.fetch = async (_u, init) => (calls.push(init), json({ title: "T" }));
    const { mod } = setup({ keyFile: "~/" + path.basename(dir) + "/k" });
    await mod.title(item());
    assert.equal(calls[0].headers["x-api-key"], "sk-home");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP 500 rejects with status and body excerpt, and is not cached", async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, calls === 1 ? { ok: false, status: 500, text: async () => '{"error":"upstream exploded"}' } : json({ title: "Recovered" }));
  const { mod } = setup();
  await assert.rejects(mod.title(item()), (e) => /500/.test(e.message) && /upstream exploded/.test(e.message));
  assert.equal(mod.status().cached, 0);
  assert.deepEqual(await mod.title(item()), { title: "Recovered", needs: null });
  assert.equal(calls, 2);
});

test("network error rejects with its reason and is not cached", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("fetch failed");
  };
  const { mod } = setup();
  await assert.rejects(mod.title(item()), /fetch failed/);
  await assert.rejects(mod.title(item()), /fetch failed/);
  assert.equal(calls, 2);
});

test("replies without a usable title reject and are not cached", async () => {
  const { mod } = setup();
  for (const text of ['{"needs": null}', '{"title": ""}', '{"title": 5}', "no json here", '{"title": "unterminated']) {
    globalThis.fetch = async () => reply(text);
    await assert.rejects(mod.title(item()), /bad reply/, text);
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [] }) });
  await assert.rejects(mod.title(item()), /bad reply/);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "<html>" });
  await assert.rejects(mod.title(item()), /not JSON/);
  assert.equal(mod.status().cached, 0);
});

test("dispose rejects queued work with 'stopped' and later calls too", async () => {
  const calls = deferredFetch();
  const { mod } = setup();
  const ps = ["a", "b", "c"].map((id) => mod.title(item({ id })));
  const settled = ps.map((p) => p.then(() => "ok", (e) => e.message));
  await tick();
  assert.equal(calls.length, 2);
  mod.dispose();
  assert.equal(await settled[2], "stopped");
  assert.equal(calls.length, 2);
  await assert.rejects(mod.title(item({ id: "z" })), /stopped/);
  calls[0].resolve(json({ title: "late" }));
  calls[1].resolve(json({ title: "late" }));
  await Promise.all(settled);
});

test("corrupt cache file moves to titles.json.bad, is logged, and starts empty", async () => {
  globalThis.fetch = async () => json({ title: "Fresh" });
  const s = setup();
  fs.mkdirSync(path.dirname(s.cacheFile), { recursive: true });
  fs.writeFileSync(s.cacheFile, "{not json");
  assert.deepEqual(await s.mod.title(item()), { title: "Fresh", needs: null });
  assert.equal(fs.readFileSync(s.cacheFile + ".bad", "utf8"), "{not json");
  assert.ok(s.logs.some((l) => /corrupt/.test(l)));
  s.mod.dispose();
  assert.equal(JSON.parse(fs.readFileSync(s.cacheFile, "utf8")).entries.m1.title, "Fresh");
});

test("cache keeps the newest 5000 entries", async () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.cacheFile), { recursive: true });
  const entries = {};
  for (let i = 0; i < 5000; i++) {
    entries["old" + i] = { title: "t", needs: null, model: "claude-haiku-5-5", withNeeds: false, at: new Date(1_000_000 + i).toISOString() };
  }
  fs.writeFileSync(s.cacheFile, JSON.stringify({ version: 1, entries }));
  globalThis.fetch = async () => json({ title: "New" });
  await s.mod.title(item({ id: "fresh" }));
  s.mod.dispose();
  const disk = JSON.parse(fs.readFileSync(s.cacheFile, "utf8")).entries;
  assert.equal(Object.keys(disk).length, 5000);
  assert.ok(disk.fresh);
  assert.ok(!disk.old0);
  assert.ok(disk.old1);
});

test("cache writes are debounced: no file right after a request, one write after the delay", async () => {
  globalThis.fetch = async () => json({ title: "T" });
  const s = setup();
  await s.mod.title(item({ id: "a" }));
  await s.mod.title(item({ id: "b" }));
  assert.ok(!fs.existsSync(s.cacheFile));
  s.mod.dispose();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.cacheFile, "utf8")).entries).sort(), ["a", "b"]);
});

test("status reports config and cache size", async () => {
  globalThis.fetch = async () => json({ title: "T" });
  const s = setup({ model: "m-y" });
  assert.deepEqual(s.mod.status(), { configured: true, url: "http://127.0.0.1:8317", model: "m-y", cached: 0 });
  await s.mod.title(item());
  assert.equal(s.mod.status().cached, 1);
});

test("asks with thinking off, so a model that thinks by default still answers in budget", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => (calls.push(JSON.parse(init.body)), json({ title: "T" }));
  await setup().mod.title(item());
  assert.deepEqual(calls[0].thinking, { type: "disabled" });
});

test("a reply cut at max_tokens rejects and names the cause", async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"title": "F' }] }) });
  await assert.rejects(setup().mod.title(item()), /max_tokens/);
});

test("a keyFile that cannot be read is an error, not a silent switch to ANTHROPIC_API_KEY", async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, json({ title: "T" }));
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-env";
  try {
    const { mod } = setup({ keyFile: path.join(root, "missing-key.txt") });
    await assert.rejects(mod.title(item()), /^Error: not configured: cannot read keyFile/);
    assert.equal(calls, 0);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});
