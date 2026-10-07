// api.threads model (loader/threads-model.mjs) and the core/threads patch on a chunk shaped like
// the app's entities chunk.
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../loader/threads-model.mjs");

const shell = (over = {}) => ({
  environmentId: "env",
  id: "t1",
  projectId: "p1",
  title: "Fix the login test",
  lineage: { relationshipToParent: null, parentThreadId: null },
  latestRun: { runId: "run-1", status: "completed", completedAt: "2026-10-07T10:00:00.000Z" },
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  lastVisitedAt: "2026-10-07T09:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  ...over,
});

test("status follows the app: approval beats input beats a running turn", async () => {
  const { threadStatus } = await load();
  const running = { status: "running" };
  assert.equal(threadStatus(shell({ runtime: running, hasPendingApprovals: true, hasPendingUserInput: true })), "approval");
  assert.equal(threadStatus(shell({ runtime: running, hasPendingUserInput: true })), "input");
  assert.equal(threadStatus(shell({ runtime: running })), "working");
  assert.equal(threadStatus(shell({ runtime: { status: "idle" } })), "waiting");
  assert.equal(threadStatus(shell({ runtime: { status: "failed", lastErrorClass: "usage_limit" } })), "limited");
  assert.equal(threadStatus(shell({ runtime: { status: "failed", lastErrorClass: "provider_error" } })), "failed");
  assert.equal(threadStatus(shell({ runtime: { status: "completed" } })), "ready");
});

test("unread means finished after the last visit; a thread never opened is not unread", async () => {
  const { isUnread } = await load();
  assert.equal(isUnread(shell()), true);
  assert.equal(isUnread(shell({ lastVisitedAt: "2026-10-07T11:00:00.000Z" })), false);
  assert.equal(isUnread(shell({ lastVisitedAt: null })), false);
  assert.equal(isUnread(shell({ latestRun: null })), false);
});

test("the thread list names projects, marks subagents and drops deleted threads", async () => {
  const { toThreadList } = await load();
  const list = toThreadList(
    [
      shell({ id: "old", updatedAt: "2026-10-01T00:00:00.000Z" }),
      shell({ id: "sub", lineage: { relationshipToParent: "subagent", parentThreadId: "old" } }),
      shell({ id: "gone", deletedAt: "2026-10-02T00:00:00.000Z" }),
    ],
    [{ id: "p1", title: "web" }],
  );
  assert.deepEqual(list.map((t) => t.ref.threadId), ["sub", "old"]);
  assert.equal(list[0].subagent, true);
  assert.equal(list[0].parentThreadId, "old");
  assert.equal(list[1].project, "web");
  assert.equal(list[1].key, "env/old");
});

test("pending requests keep only what can still be answered, with the app's default choices", async () => {
  const { toPending } = await load();
  const p = toPending({
    approvals: [
      { requestId: "a1", requestKind: "command", detail: "rm x", createdAt: "t", responseCapability: "live" },
      { requestId: "a2", requestKind: "command", createdAt: "t", responseCapability: "not_resumable" },
      { requestId: "a3", requestKind: "mcp-elicitation", createdAt: "t", responseCapability: "live", options: [{ decision: "accept", label: "Allow", warning: "careful" }] },
    ],
    userInputs: [
      { requestId: "q1", createdAt: "t", responseCapability: "live", questions: [{ id: "c", header: "Color", question: "Which?", options: [{ label: "Red", description: "r" }, { label: "Green", value: "g" }] }] },
      { requestId: "q2", createdAt: "t", responseCapability: "not_resumable", questions: [] },
    ],
  });
  assert.deepEqual(p.approvals.map((a) => a.requestId), ["a1", "a3"]);
  assert.deepEqual(p.approvals[0].options.map((o) => o.decision), ["accept", "acceptForSession", "decline"]);
  assert.deepEqual(p.approvals[1].options, [{ decision: "accept", label: "Allow", warning: "careful" }]);
  assert.deepEqual(p.questions.map((q) => q.requestId), ["q1"]);
  // value falls back to the label, as the app sends it
  assert.deepEqual(p.questions[0].questions[0].options.map((o) => o.value), ["Red", "g"]);
  assert.equal(p.questions[0].questions[0].allowCustom, true);
});

test("answers are checked against the questions before they are sent", async () => {
  const { checkAnswers } = await load();
  const qs = [
    { id: "color", question: "Color?", multiSelect: false, allowCustom: false, options: [{ value: "red" }, { value: "green" }] },
    { id: "tools", question: "Tools?", multiSelect: true, allowCustom: true, options: [{ value: "lint" }] },
  ];
  assert.deepEqual(checkAnswers(qs, { color: "green", tools: ["lint", "my own"] }), { color: "green", tools: ["lint", "my own"] });
  assert.deepEqual(checkAnswers(qs, { color: "red", tools: "lint" }), { color: "red", tools: ["lint"] });
  assert.throws(() => checkAnswers(qs, { color: "green" }), /no answer for "Tools\?"/);
  assert.throws(() => checkAnswers(qs, { color: "blue", tools: "lint" }), /only takes one of its options/);
  assert.throws(() => checkAnswers(qs, { color: ["red", "green"], tools: "lint" }), /takes one answer/);
});

test("the last message is the newest assistant text", async () => {
  const { lastAssistantMessage } = await load();
  const projection = { messages: [{ role: "assistant", text: "first" }, { role: "user", text: "hi" }, { role: "assistant", text: "  " }, { role: "user", text: "x" }] };
  assert.equal(lastAssistantMessage(projection), "first");
  assert.equal(lastAssistantMessage({ messages: [] }), null);
});

test("a failed command gives the deepest message it carries", async () => {
  const { failureText } = await load();
  assert.equal(failureText({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "RpcError", message: "thread is busy" } } }), "thread is busy");
  assert.equal(failureText({ _tag: "Failure", cause: {} }), "the app refused the command");
});

test("core/threads hands over the registry and the stores of the entities chunk", () => {
  const patch = require("../loader/builtin/core/patches.cjs").find((p) => p.id === "threads");
  // The shape of the app's entities chunk (0.0.46 nightly), with other minified names.
  const chunk = [
    "var aa=Ve({catalogValueAtom:M.catalogValueAtom,snapshotAtom:I}),Jx=Se(j,I),Yq=be(j),Xd=ye(Yq.stateAtom),Zs=ve({catalogValueAtom:M.catalogValueAtom,snapshotAtom:Jx.snapshotAtom}),$e=m(he(k)).pipe(g(`web-environment-thread:empty`));",
    "function Yt(){return vv.get(Zs.threadShellsAtom)}",
  ].join("");
  assert.ok(chunk.includes(patch.find));
  const out = patch.transform(chunk, { self: "S" });
  assert.equal(out.slice(chunk.length), '\n;S.provide?.("threads.internals",{registry:vv,shells:Zs,details:Xd,projects:aa,commands:Jx});');
  // Without one of the anchors the chunk stays as it was, so the doctor reports the patch.
  assert.equal(patch.transform(chunk.replace("threadShellsAtom", "x"), { self: "S" }), chunk.replace("threadShellsAtom", "x"));
});
