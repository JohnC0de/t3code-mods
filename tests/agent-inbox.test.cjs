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
