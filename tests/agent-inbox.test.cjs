// The Agent Inbox model (mods/agent-inbox/model.mjs): which threads get dots and cards.
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../mods/agent-inbox/model.mjs");

const SINCE = Date.parse("2026-10-07T08:00:00.000Z");
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const thread = (id, over = {}) => ({
  key: `env/${id}`,
  ref: { environmentId: "env", threadId: id },
  title: id,
  project: "web",
  status: "ready",
  unread: false,
  subagent: false,
  archived: false,
  snoozedUntil: null,
  branch: null,
  runStatus: "completed",
  runId: `run-${id}`,
  completedAt: "2026-10-07T07:00:00.000Z",
  lastVisitedAt: "2026-10-07T07:30:00.000Z",
  updatedAt: "2026-10-07T07:00:00.000Z",
  error: null,
  ...over,
});
const question = (requestId) => ({
  requestId,
  createdAt: "2026-10-07T11:00:00.000Z",
  questions: [{ id: "c", header: "Color", question: "Which?", multiSelect: false, allowCustom: true, options: [{ label: "Red", description: "", value: "Red" }] }],
});
const build = async (threads, details = new Map(), dismissed = {}) => (await load()).buildInbox({ threads, details, dismissed, since: SINCE, now: NOW, shortcut: "Ctrl+Alt+Space" });

test("a finished thread gets a card until the user looks at it", async () => {
  const unseen = thread("a", { completedAt: "2026-10-07T10:00:00.000Z", unread: true });
  const seen = thread("b");
  const { model } = await build([unseen, seen]);
  assert.deepEqual(model.cards.map((c) => [c.kind, c.title]), [["done", "a"]]);
  assert.deepEqual(model.dots.map((d) => [d.title, d.status]), [["a", "done"]]);
  assert.equal(model.counts.done, 1);
});

test("threads never opened count only when they finished after the inbox started", async () => {
  const old = thread("old", { lastVisitedAt: null, completedAt: "2026-10-01T00:00:00.000Z" });
  const fresh = thread("fresh", { lastVisitedAt: null, completedAt: "2026-10-07T09:00:00.000Z" });
  const { model } = await build([old, fresh]);
  assert.deepEqual(model.cards.map((c) => c.title), ["fresh"]);
});

test("questions and approvals come first and use the request ids", async () => {
  const asking = thread("ask", { status: "input", runStatus: "running", completedAt: null });
  const approving = thread("ok", { status: "approval", runStatus: "running", completedAt: null });
  const done = thread("done", { completedAt: "2026-10-07T11:30:00.000Z", unread: true });
  const details = new Map([
    ["env/ask", { questions: [question("q1")], approvals: [], lastMessage: "One question first." }],
    ["env/ok", { questions: [], approvals: [{ requestId: "a1", kind: "command", detail: "rm x", appName: null, createdAt: "2026-10-07T11:10:00.000Z", options: [{ decision: "accept", label: "Approve", warning: null }] }], lastMessage: null }],
  ]);
  const { model } = await build([done, asking, approving], details);
  assert.deepEqual(model.cards.map((c) => c.key), ["env/ok|a|a1", "env/ask|q|q1", `env/done|done|${done.completedAt}`]);
  assert.equal(model.cards[1].message, "One question first.");
  assert.equal(model.cards[0].approval.detail, "rm x");
  assert.equal(model.counts.attention, 2);
});

test("a question waits for its thread's details before it gets a card, but its dot shows at once", async () => {
  const asking = thread("ask", { status: "input", runStatus: "running", completedAt: null });
  const { model } = await build([asking]);
  assert.equal(model.cards.length, 0);
  assert.deepEqual(model.dots.map((d) => d.status), ["input"]);
});

test("archived, snoozed and subagent threads stay out; failures count only while unseen", async () => {
  const threads = [
    thread("arch", { archived: true, status: "working" }),
    thread("snooze", { status: "working", snoozedUntil: "2026-10-08T00:00:00.000Z" }),
    thread("sub", { subagent: true, status: "working" }),
    thread("oldfail", { status: "failed", runStatus: "failed", completedAt: "2026-10-01T00:00:00.000Z", lastVisitedAt: "2026-10-02T00:00:00.000Z" }),
    thread("newfail", { status: "failed", runStatus: "failed", completedAt: "2026-10-07T11:00:00.000Z", error: "API error" }),
    thread("run", { status: "working", runStatus: "running", completedAt: null }),
  ];
  const { model } = await build(threads);
  assert.deepEqual(model.dots.map((d) => d.title), ["newfail", "run"]);
  assert.deepEqual(model.cards.map((c) => [c.kind, c.title, c.error]), [["failed", "newfail", "API error"]]);
});

test("a dismissed card stays hidden, and is forgotten once its request is gone", async () => {
  const asking = thread("ask", { status: "input", runStatus: "running", completedAt: null });
  const details = new Map([["env/ask", { questions: [question("q1")], approvals: [], lastMessage: null }]]);
  const first = await build([asking], details, { "env/ask|q|q1": 1 });
  assert.equal(first.model.cards.length, 0);
  assert.deepEqual(first.stale, []);
  // Answered elsewhere: the thread works again and the dismissal can go.
  const later = await build([{ ...asking, status: "working" }], details, { "env/ask|q|q1": 1 });
  assert.deepEqual(later.stale, ["env/ask|q|q1"]);
});

test("details load only for threads that can have a card, most urgent first", async () => {
  const { wantDetails, MAX_DETAILS } = await load();
  const many = Array.from({ length: 30 }, (_, i) => thread(`d${i}`, { completedAt: "2026-10-07T10:00:00.000Z", unread: true }));
  const asking = thread("ask", { status: "input" });
  const idle = thread("idle");
  const want = wantDetails([...many, idle, asking], { since: SINCE, now: NOW });
  assert.equal(want.length, MAX_DETAILS);
  assert.equal(want[0].title, "ask");
  assert.ok(!want.some((t) => t.title === "idle"));
});

test("a dismissal of another app's environment is not forgotten here", async () => {
  // Dismissed keys are shared by every running app; this app knows only environment "env".
  const first = await build([thread("a")], new Map(), { "other/x|q|q1": 1, "env/gone|q|q9": 1 });
  assert.deepEqual(first.stale, ["env/gone|q|q9"]);
});

test("without threads there is nothing to judge a dismissal by", async () => {
  assert.deepEqual((await build([], new Map(), { "env/ask|q|q1": 1 })).stale, []);
});

// ---------- mergeModels ----------
const appInfo = (id, name = null) => ({ id, name, home: "" });
const MS = (iso) => Date.parse(iso);
async function modelOf(threads, details = new Map()) {
  return (await build(threads, details)).model;
}
const inEnv = (env, id, over = {}) => thread(id, { key: `${env}/${id}`, ref: { environmentId: env, threadId: id }, ...over });
const asking = (env, id, updatedAt) => inEnv(env, id, { status: "input", runStatus: "running", completedAt: null, updatedAt });
const finished = (env, id, completedAt) => inEnv(env, id, { unread: true, completedAt, updatedAt: completedAt });
const detailsFor = (...ts) => new Map(ts.map((t) => [t.key, { questions: [question(`q-${t.ref.threadId}`)], approvals: [], lastMessage: null }]));

test("one app merges into its own model, with no app labels", async () => {
  const { mergeModels } = await load();
  const ask = asking("env", "ask", "2026-10-07T11:00:00.000Z");
  const done = finished("env", "done", "2026-10-07T11:30:00.000Z");
  const m = await modelOf([done, ask], detailsFor(ask));
  const merged = mergeModels([{ app: appInfo("default"), model: m }]);
  assert.deepEqual(merged.apps, [{ id: "default", name: null }]);
  assert.deepEqual(merged.cards.map((c) => c.key), m.cards.map((c) => c.key));
  assert.deepEqual(merged.dots.map((d) => d.threadKey), m.dots.map((d) => d.threadKey));
  assert.ok([...merged.cards, ...merged.dots, ...merged.agents].every((i) => i.app === null));
  assert.deepEqual(merged.counts, m.counts);
  assert.equal(mergeModels([]), null);
  assert.equal(mergeModels([{ app: appInfo("default"), model: null }]), null);
});

test("merged cards put every app's questions first, then failures, then finished work, newest first", async () => {
  const { mergeModels } = await load();
  const ask1 = asking("env-a", "ask1", "2026-10-07T10:00:00.000Z");
  const ask2 = asking("env-b", "ask2", "2026-10-07T10:30:00.000Z");
  const fail = inEnv("env-b", "fail", { status: "failed", runStatus: "failed", completedAt: "2026-10-07T11:50:00.000Z", updatedAt: "2026-10-07T11:50:00.000Z" });
  const doneA = finished("env-a", "doneA", "2026-10-07T11:55:00.000Z");
  const doneB = finished("env-b", "doneB", "2026-10-07T11:58:00.000Z");
  // Question times come from the request, not the thread.
  const detA = new Map([[ask1.key, { questions: [{ ...question("qa"), createdAt: "2026-10-07T10:00:00.000Z" }], approvals: [], lastMessage: null }]]);
  const detB = new Map([[ask2.key, { questions: [{ ...question("qb"), createdAt: "2026-10-07T10:30:00.000Z" }], approvals: [], lastMessage: null }]]);
  const a = await modelOf([doneA, ask1], detA);
  const b = await modelOf([doneB, fail, ask2], detB);
  const merged = mergeModels([{ app: appInfo("default"), model: a }, { app: appInfo("work", "Work"), model: b }]);
  assert.deepEqual(merged.cards.map((c) => [c.kind, c.title, c.app]), [
    ["question", "ask2", "Work"],
    ["question", "ask1", "Personal"],
    ["failed", "fail", "Work"],
    ["done", "doneB", "Work"],
    ["done", "doneA", "Personal"],
  ]);
  assert.deepEqual(merged.apps, [{ id: "default", name: "Personal" }, { id: "work", name: "Work" }]);
});

test("merged dots sort by status, then newest, across apps; the cap is 12 and the overflow adds up", async () => {
  const { mergeModels, MAX_DOTS } = await load();
  const working = (env, id, mins) => inEnv(env, id, { status: "working", runStatus: "running", completedAt: null, updatedAt: new Date(NOW - mins * 60_000).toISOString() });
  const a = await modelOf([working("env-a", "a-old", 50), working("env-a", "a-new", 1), asking("env-a", "a-ask", "2026-10-07T09:00:00.000Z")]);
  const b = await modelOf([working("env-b", "b-mid", 10), ...Array.from({ length: 12 }, (_, i) => working("env-b", `b${i}`, 100 + i))]);
  assert.equal(b.overflow, 1);
  const merged = mergeModels([{ app: appInfo("default"), model: a }, { app: appInfo("work", "Work"), model: b }]);
  assert.equal(merged.dots.length, MAX_DOTS);
  assert.deepEqual(merged.dots.slice(0, 3).map((d) => d.title), ["a-ask", "a-new", "b-mid"]);
  // 3 + 12 dots in, 12 out; the one app b dropped before stays counted.
  assert.equal(merged.overflow, 1 + (3 + 12 - MAX_DOTS));
  assert.equal(merged.dots[0].app, "Personal");
});

test("merged agents are capped at 40 and newest first, and the strip settings come from the first model", async () => {
  const { mergeModels, MAX_AGENTS } = await load();
  const many = (env, n, base) => Array.from({ length: n }, (_, i) => inEnv(env, `${env}${i}`, { updatedAt: new Date(base + i * 1000).toISOString() }));
  const a = await modelOf(many("a", 30, MS("2026-10-07T01:00:00.000Z")));
  const b = await modelOf(many("b", 30, MS("2026-10-07T02:00:00.000Z")));
  const lead = { ...a, strip: false, shortcut: "Alt+X", undoMs: 900, stripY: 0.25, counts: { attention: 1, working: 2, done: 3 } };
  const merged = mergeModels([{ app: appInfo("default"), model: lead }, { app: appInfo("work", "Work"), model: { ...b, strip: true, stripY: 0.9, counts: { attention: 10, working: 20, done: 30 } } }]);
  assert.equal(merged.agents.length, MAX_AGENTS);
  assert.ok(merged.agents.every((x, i, all) => i === 0 || all[i - 1].updatedAt >= x.updatedAt));
  assert.equal(merged.agents[0].app, "Work");
  assert.deepEqual([merged.strip, merged.shortcut, merged.undoMs, merged.stripY], [false, "Alt+X", 900, 0.25]);
  assert.deepEqual(merged.counts, { attention: 11, working: 22, done: 33 });
});

test("a thread two apps both show stays with the first app; a nameless extra app is labelled by its id", async () => {
  const { mergeModels } = await load();
  const t = finished("env", "same", "2026-10-07T11:00:00.000Z");
  const a = await modelOf([t]);
  const b = await modelOf([t]);
  const merged = mergeModels([{ app: appInfo("default"), model: a }, { app: appInfo("second"), model: b }]);
  assert.equal(merged.dots.length, 1);
  assert.equal(merged.dots[0].app, "Personal");
  assert.equal(merged.agents.length, 1);
  assert.deepEqual(merged.apps.map((x) => x.name), ["Personal", "second"]);
});

test("a null model (the mod stopped in that app) leaves the merge; its name does not label the rest", async () => {
  const { mergeModels } = await load();
  const a = await modelOf([finished("env", "x", "2026-10-07T11:00:00.000Z")]);
  const merged = mergeModels([{ app: appInfo("work", "Work"), model: null }, { app: appInfo("default"), model: a }]);
  assert.deepEqual(merged.apps, [{ id: "default", name: null }]);
  assert.equal(merged.dots[0].app, null);
});
