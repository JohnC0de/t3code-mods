// The Agent Inbox hub (mods/agent-inbox/hub.cjs): leader election and relay between apps.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createHub, endpointFor } = require("../mods/agent-inbox/hub.cjs");

const tempEndpoint = () => {
  const id = crypto.randomBytes(5).toString("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\t3mods-test-${id}` : path.join(os.tmpdir(), `t3ai-test-${id}.sock`);
};
const waitFor = async (cond, what, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const ref = (t, env = "env") => ({ environmentId: env, threadId: t });
const modelWith = (...threads) => ({ cards: threads.map((t) => ({ ref: ref(t), threadKey: `env/${t}` })), dots: [], agents: [] });

// Starts hubs one by one on one endpoint; `calls` records what each app was asked to do.
function cluster(t, { timeoutMs = 15_000 } = {}) {
  const endpoint = tempEndpoint();
  const hubs = [];
  const add = async (id, { act, ui, name = null } = {}) => {
    const calls = { act: [], ui: [], changes: 0, roles: [] };
    const hub = createHub({
      endpoint,
      app: { id, name, home: `/home/${id}` },
      act: async (a) => {
        calls.act.push(a);
        return act ? act(a) : `${id} did it`;
      },
      ui: { openInbox: async (o) => (calls.ui.push(["openInbox", o]), "opened"), openList: async () => (calls.ui.push(["openList"]), true), ...ui },
      onChange: () => calls.changes++,
      onRole: (r) => calls.roles.push(r),
      timeoutMs,
      retryMs: [10, 50],
    });
    hubs.push(hub);
    hub.start();
    await waitFor(() => calls.roles.length > 0, `${id} to get a role`);
    return { hub, calls };
  };
  t.after(() => hubs.forEach((h) => h.close()));
  return { endpoint, add, hubs };
}
const ids = (hub) => hub.models().map((e) => e.app.id);

test("the endpoint depends on user and mods folder, and ignores the case of the folder", () => {
  const a = endpointFor("C:\\Mods", { platform: "win32", user: "ann" });
  assert.match(a, /^\\\\\.\\pipe\\t3mods-agent-inbox-[0-9a-f]{12}$/);
  assert.equal(endpointFor("c:\\mods", { platform: "win32", user: "ann" }), a);
  assert.notEqual(endpointFor("C:\\Mods", { platform: "win32", user: "bob" }), a);
  assert.notEqual(endpointFor("C:\\Other", { platform: "win32", user: "ann" }), a);
});

test("the first hub leads and the others follow, whatever their start order", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b");
  const d = await c.add("d");
  assert.deepEqual([a, b, d].map((x) => x.hub.isLeader()), [true, false, false]);
  assert.deepEqual([a.calls.roles, b.calls.roles], [[true], [false]]);
});

test("the leader merges every app's latest model, its own first, and a new model replaces the old one", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b");
  const d = await c.add("d");
  a.hub.setModel(modelWith("a1"));
  d.hub.setModel(modelWith("d1"));
  b.hub.setModel(modelWith("b1"));
  await waitFor(() => ids(a.hub).length === 3, "three models");
  assert.equal(ids(a.hub)[0], "a");
  assert.deepEqual(ids(a.hub).sort(), ["a", "b", "d"]);
  const before = a.calls.changes;
  b.hub.setModel(modelWith("b2"));
  await waitFor(() => a.hub.models().find((e) => e.app.id === "b").model.cards[0].threadKey === "env/b2", "b's new model");
  assert.equal(a.hub.models().filter((e) => e.app.id === "b").length, 1);
  assert.ok(a.calls.changes > before, "the leader hears about a change");
});

test("a model set before the follower connected arrives after hello, and null removes it from the merge", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  a.hub.setModel(modelWith("a1"));
  const b = createHub({ endpoint: c.endpoint, app: { id: "b", name: "B", home: "" }, act() {}, retryMs: [10, 50] });
  c.hubs.push(b);
  b.setModel(modelWith("b1")); // before start: nothing to send to yet
  b.start();
  await waitFor(() => ids(a.hub).includes("b"), "b's model");
  assert.equal(a.hub.models()[1].app.name, "B");
  b.setModel(null); // the mod stopped in that app
  await waitFor(() => !ids(a.hub).includes("b"), "b's model to go");
});

test("an action goes to the app that owns the thread and the answer comes back", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b", { act: (x) => ({ answered: x.requestId }) });
  a.hub.setModel(modelWith("a1"));
  b.hub.setModel(modelWith("b1"));
  await waitFor(() => ids(a.hub).length === 2, "both models");

  const action = { type: "approve", ref: ref("b1"), requestId: "r1", decision: "accept" };
  assert.deepEqual(await a.hub.act(action), { answered: "r1" });
  assert.deepEqual(b.calls.act, [action]);
  assert.deepEqual(a.calls.act, [], "the leader's own app must not run it");

  assert.equal(await a.hub.act({ type: "stop", ref: ref("a1") }), "a did it");
  assert.equal(a.calls.act.length, 1);
  assert.equal(b.calls.act.length, 1, "an action for the leader's thread must stay local");
});

test("a thread is matched by environment and thread id together", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b");
  a.hub.setModel({ cards: [{ ref: ref("t1", "env-a") }], dots: [], agents: [] });
  b.hub.setModel({ cards: [{ ref: ref("t1", "env-b") }], dots: [], agents: [] });
  await waitFor(() => ids(a.hub).length === 2, "both models");
  await a.hub.act({ type: "stop", ref: ref("t1", "env-b") });
  assert.equal(b.calls.act.length, 1);
  assert.equal(a.calls.act.length, 0);
});

test("a follower's error reaches the caller, and a thread nobody owns is refused", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b", { act: () => Promise.reject(new Error("The question changed")) });
  a.hub.setModel(modelWith("a1"));
  b.hub.setModel(modelWith("b1"));
  await waitFor(() => ids(a.hub).length === 2, "both models");
  await assert.rejects(a.hub.act({ type: "answer", ref: ref("b1") }), /The question changed/);
  await assert.rejects(a.hub.act({ type: "stop", ref: ref("nobody") }), /No running app has this thread/);
  assert.equal(a.calls.act.length + b.calls.act.length, 1);
});

test("a follower that does not answer times out with a clear error instead of hanging", async (t) => {
  const c = cluster(t, { timeoutMs: 150 });
  const a = await c.add("a");
  const b = await c.add("b", { name: "Work", act: () => new Promise(() => {}) });
  b.hub.setModel(modelWith("b1"));
  await waitFor(() => ids(a.hub).includes("b"), "b's model");
  await assert.rejects(a.hub.act({ type: "stop", ref: ref("b1") }), /The Work app did not answer within/);
});

test("an action waiting on a follower that quits fails at once", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b", { name: "Work", act: () => new Promise(() => {}) });
  b.hub.setModel(modelWith("b1"));
  await waitFor(() => ids(a.hub).includes("b"), "b's model");
  const started = Date.now();
  const result = assert.rejects(a.hub.act({ type: "stop", ref: ref("b1") }), /Work app quit before it answered/);
  await waitFor(() => b.calls.act.length === 1, "b to get the action");
  b.hub.close();
  await result;
  assert.ok(Date.now() - started < 5000);
});

test("a follower's openInbox and openList run in the leader with their arguments", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b");
  assert.equal(await b.hub.ui("openInbox", { threadKey: "env/x" }), "opened");
  assert.equal(await b.hub.ui("openList"), true);
  assert.deepEqual(a.calls.ui, [["openInbox", { threadKey: "env/x" }], ["openList"]]);
  assert.deepEqual(b.calls.ui, []);
  assert.equal(await a.hub.ui("openInbox", {}), "opened", "the leader's own call stays local");
  assert.equal(a.calls.ui.length, 3);
});

test("a leader error in a UI call reaches the follower", async (t) => {
  const c = cluster(t);
  await c.add("a", { ui: { openInbox: () => Promise.reject(new Error("no panel")) } });
  const b = await c.add("b");
  await assert.rejects(b.hub.ui("openInbox", {}), /no panel/);
});

test("when the leader quits, a follower takes over and the others rejoin it with their models", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b");
  const d = await c.add("d");
  a.hub.setModel(modelWith("a1"));
  b.hub.setModel(modelWith("b1"));
  d.hub.setModel(modelWith("d1"));
  await waitFor(() => ids(a.hub).length === 3, "all models");
  a.hub.close();
  await waitFor(() => b.hub.isLeader() !== d.hub.isLeader(), "exactly one new leader");
  const [lead, rest] = b.hub.isLeader() ? [b, d] : [d, b];
  await waitFor(() => ids(lead.hub).length === 2, "the other app to rejoin");
  assert.deepEqual(ids(lead.hub).sort(), ["b", "d"]);
  assert.ok(lead.calls.roles.includes(true), "the new leader is told to take over the windows");
  // The routes work through the new leader.
  const owner = rest === b ? "b1" : "d1";
  await lead.hub.act({ type: "stop", ref: ref(owner) });
  assert.equal(rest.calls.act.length, 1);
});

test("a follower that quits leaves the merge", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const b = await c.add("b");
  const d = await c.add("d");
  a.hub.setModel(modelWith("a1"));
  b.hub.setModel(modelWith("b1"));
  d.hub.setModel(modelWith("d1"));
  await waitFor(() => ids(a.hub).length === 3, "all models");
  const before = a.calls.changes;
  b.hub.close();
  await waitFor(() => ids(a.hub).length === 2, "b to leave");
  assert.deepEqual(ids(a.hub).sort(), ["a", "d"]);
  assert.ok(a.calls.changes > before, "the leader hears about it");
  await assert.rejects(a.hub.act({ type: "stop", ref: ref("b1") }), /No running app has this thread/);
});

test("an app that speaks another protocol version never joins the merge", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const sock = net.connect(c.endpoint);
  t.after(() => sock.destroy());
  await new Promise((r) => sock.once("connect", r));
  sock.write(`${JSON.stringify({ t: "hello", v: 999, app: { id: "future", name: null, home: "" } })}\n${JSON.stringify({ t: "model", model: modelWith("f1") })}\n`);
  await new Promise((r) => sock.once("close", r));
  assert.deepEqual(ids(a.hub), []);
});

test("a garbled line or a model sent before hello does not hurt the leader", async (t) => {
  const c = cluster(t);
  const a = await c.add("a");
  const sock = net.connect(c.endpoint);
  t.after(() => sock.destroy());
  await new Promise((r) => sock.once("connect", r));
  sock.write(`not json\n${JSON.stringify({ t: "model", model: modelWith("x1") })}\n`);
  const b = await c.add("b");
  b.hub.setModel(modelWith("b1"));
  await waitFor(() => ids(a.hub).includes("b"), "b's model");
  assert.deepEqual(ids(a.hub), ["b"]);
});

test("hub.close frees the endpoint so a later hub can lead", async () => {
  const endpoint = tempEndpoint();
  const roles = [];
  const mk = () => createHub({ endpoint, app: { id: "x", name: null, home: "" }, act() {}, onRole: (r) => roles.push(r), retryMs: [10, 50] });
  const one = mk();
  one.start();
  await waitFor(() => roles.length === 1, "first role");
  one.close();
  const two = mk();
  two.start();
  await waitFor(() => roles.length === 2, "second role");
  assert.deepEqual(roles, [true, true]);
  two.close();
});
