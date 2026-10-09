// calm-thread logic: pure row logic (sentence titles, receipts, turn segmentation, Focus/Normal/Full rows,
// hidden-answer insert, "Since you left" brief). No DOM: rows in, rows out.
const test = require("node:test");
const assert = require("node:assert/strict");

let L;
test.before(async () => {
  L = await import("../mods/calm-thread/logic.mjs");
});

// ---- factories ----
const T0 = "2026-01-01T09:00:00Z";
const hour = (h) => `2026-01-01T${String(h).padStart(2, "0")}:00:00Z`;
const userRow = (id, text = "Please fix the bug in setup. Thanks") => ({
  kind: "message",
  id,
  createdAt: T0,
  message: { id, role: "user", text, createdAt: T0 },
});
const answerRow = (id, runId, text, updatedAt = hour(10), extra = {}) => ({
  kind: "message",
  id,
  createdAt: updatedAt,
  message: { id, role: "assistant", text, runId, streaming: false, createdAt: updatedAt, updatedAt, ...extra },
});
const foldRow = (runId, label = "Worked for 35m 12s", expanded = false) => ({
  kind: "turn-fold",
  id: `turn-fold:${runId}`,
  runId,
  label,
  expanded,
});
const row = (kind, id, extra = {}) => ({ kind, id, ...extra });
const errorEvent = (id) => row("event", id, { projectedItem: { item: { type: "error", runId: "r" } } });
const workEntry = (id, runId, itemType) => ({ kind: "work", id, entry: { runId, itemType } });
const assistantEntry = (id, runId, text, msgId = `msg-${id}`) => ({
  kind: "message",
  id,
  createdAt: hour(9),
  message: { id: msgId, role: "assistant", text, runId, createdAt: hour(9), updatedAt: hour(9) },
});

const view = (over = {}) => ({
  mode: "focus",
  overrides: undefined,
  titles: new Map(),
  needsYou: null,
  since: null,
  brief: true,
  dismissed: false,
  model: true,
  ...over,
});
const ctx = (over = {}) => ({ threadKey: "thread-1", entries: [], latestRun: null, isWorking: false, ...over });
const ids = (result) => result.rows.map((r) => r.id);

const answerText = (n) => `Fixed issue number ${n} in setup. Extra details follow here.`;
// Turn n: user un, fold rn, answer an (finished at hour 9+n).
const finishedTurn = (n, over = {}) => [
  userRow(`u${n}`),
  foldRow(`r${n}`),
  answerRow(`a${n}`, `r${n}`, over.text ?? answerText(n), hour(9 + n)),
];
const runningTurn = (extra = []) => [userRow("u4", "Now refactor the parser. Then run the tests"), row("work-live", "wl4", { expanded: false }), ...extra];
const threeFinishedPlusRunning = () => [...finishedTurn(1), ...finishedTurn(2), ...finishedTurn(3), ...runningTurn()];

// ---- 1. firstSentence ----
test("firstSentence: strips bold, links, code, list markers and headings", () => {
  assert.equal(L.firstSentence("**Fixed** the [login](https://x.test/a) `token` renewal. More."), "Fixed the login token renewal");
  assert.equal(L.firstSentence("- Fixed the token renewal. More."), "Fixed the token renewal");
  assert.equal(L.firstSentence("1. Fixed the token renewal. More."), "Fixed the token renewal");
  assert.equal(L.firstSentence("## Fixed the token renewal. More."), "Fixed the token renewal");
  assert.equal(L.firstSentence("```js\nconst a = 1.\n```\nFixed the token renewal. More."), "Fixed the token renewal");
});

test("firstSentence: stops at the first sentence end, keeps ? and !", () => {
  assert.equal(L.firstSentence("Fixed the token. Then I ran tests."), "Fixed the token");
  assert.equal(L.firstSentence("Fixed the token! Then I ran tests."), "Fixed the token!");
  assert.equal(L.firstSentence("Is the token fixed? Yes it is."), "Is the token fixed?");
});

test("firstSentence: does not stop inside e.g. before lowercase or inside version numbers", () => {
  assert.equal(L.firstSentence("Use a cache, e.g. the disk one, for titles. Next step."), "Use a cache, e.g. the disk one, for titles");
  assert.equal(L.firstSentence("Bumped the loader to v1.2 for the fix. Next."), "Bumped the loader to v1.2 for the fix");
});

test("firstSentence: drops only the final period and takes the first non-empty paragraph", () => {
  assert.equal(L.firstSentence("Fixed it."), "Fixed it");
  assert.equal(L.firstSentence("\n\n   \nFirst paragraph here.\n\nSecond paragraph here."), "First paragraph here");
  assert.equal(L.firstSentence("No end punctuation here"), "No end punctuation here");
  assert.equal(L.firstSentence(""), "");
  assert.equal(L.firstSentence(undefined), "");
});

// ---- 2. isWeakTitle ----
test("isWeakTitle: filler, short, long and colon endings are weak; a real sentence is not", () => {
  for (const weak of ["Done.", "You're right", "Let me check the file", "x".repeat(40) + " " + "y".repeat(80), "Here is what I changed:"]) {
    assert.equal(L.isWeakTitle(weak), true, weak);
  }
  assert.equal(L.isWeakTitle("Fixed the login token renewal in setup"), false);
});

test("isWeakTitle: question endings are weak and the 90/12 length edges hold", () => {
  assert.equal(L.isWeakTitle("Did the token renewal work?"), true);
  assert.equal(L.isWeakTitle("a ".repeat(45).trim()), false); // 89 chars
  assert.equal(L.isWeakTitle("a ".repeat(46).trim()), true); // 91 chars
  assert.equal(L.isWeakTitle("Fix the bug"), true); // 11 chars
  assert.equal(L.isWeakTitle("Fix the bugs"), false); // 12 chars
});

// ---- 3. shortDuration, receiptLabel ----
test("shortDuration: keeps the two largest units for hours, one unit otherwise", () => {
  assert.equal(L.shortDuration("Worked for 35m 12s"), "35m");
  assert.equal(L.shortDuration("Worked for 42s"), "42s");
  assert.equal(L.shortDuration("Worked for 1h 5m 3s"), "1h 5m");
  assert.equal(L.shortDuration("You stopped after 3m"), "3m");
  assert.equal(L.shortDuration("Something else"), null);
  assert.equal(L.shortDuration(undefined), null);
});

test("shortDuration: an hour label without seconds keeps its minutes", () => {
  assert.equal(L.shortDuration("Worked for 1h 5m"), "1h 5m");
});

test("receiptLabel: singular and plural counts in fixed order, duration last", () => {
  const counts = { commands: 1, edits: 2, searches: 1, tools: 3, agents: 1 };
  assert.equal(L.receiptLabel(counts, "Worked for 35m 12s"), "1 command · 2 edits · 1 search · 3 tool calls · 1 agent · 35m");
  assert.equal(L.receiptLabel({ commands: 2, edits: 1 }, "Worked for 42s"), "2 commands · 1 edit · 42s");
});

test("receiptLabel: no duration is omitted, stopped label passes through, nothing to count keeps the T3 label", () => {
  assert.equal(L.receiptLabel({ commands: 1 }, "Finished"), "1 command");
  assert.equal(L.receiptLabel({ commands: 4 }, "You stopped after 3m"), "You stopped after 3m");
  assert.equal(L.receiptLabel(undefined, "Worked for 35m 12s"), "Worked for 35m 12s");
  assert.equal(L.receiptLabel({ commands: 0, edits: 0, searches: 0, tools: 0, agents: 0 }, "Worked for 35m 12s"), "Worked for 35m 12s");
});

// ---- 4. countRunWork ----
test("countRunWork: counts per run by item type, ignores reasoning, counts subagents, skips entries without a run", () => {
  const entries = [
    workEntry("w1", "r1", "command_execution"),
    workEntry("w2", "r1", "command_execution"),
    workEntry("w3", "r1", "file_change"),
    workEntry("w4", "r1", "web_search"),
    workEntry("w5", "r1", "file_search"),
    workEntry("w6", "r1", "dynamic_tool"),
    workEntry("w7", "r1", "reasoning"),
    workEntry("w8", undefined, "command_execution"),
    workEntry("w9", "r2", "file_change"),
    row("event", "e1", { projectedItem: { item: { type: "subagent", runId: "r1" } } }),
    row("event", "e2", { projectedItem: { item: { type: "subagent" } } }),
    row("event", "e3", { projectedItem: { item: { type: "error", runId: "r1" } } }),
    assistantEntry("m1", "r1", "text"),
  ];
  const byRun = L.countRunWork(entries);
  assert.deepEqual(byRun.get("r1"), { commands: 2, edits: 1, searches: 2, tools: 1, agents: 1 });
  assert.deepEqual(byRun.get("r2"), { commands: 0, edits: 1, searches: 0, tools: 0, agents: 0 });
  assert.equal(byRun.size, 2);
  assert.equal(L.countRunWork(undefined).size, 0);
});

test("countRunWork: a run with only reasoning has no entry", () => {
  assert.equal(L.countRunWork([workEntry("w", "r1", "reasoning")]).has("r1"), false);
});

// ---- 5. segmentTurns ----
test("segmentTurns: rows before the first user message go to pre", () => {
  const setup = row("worktree-setup", "pre1");
  const { pre, turns } = L.segmentTurns([setup, ...finishedTurn(1)], { isWorking: false });
  assert.deepEqual(pre.map((r) => r.id), ["pre1"]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, "u1");
  assert.deepEqual(turns[0].rows.map((r) => r.id), ["u1", "turn-fold:r1", "a1"]);
  assert.equal(turns[0].answer.id, "a1");
  assert.equal(turns[0].fold.id, "turn-fold:r1");
  assert.equal(turns[0].finishedAt, hour(10));
});

test("segmentTurns: the answer is the last assistant message of the turn", () => {
  const rows = [userRow("u1"), answerRow("a-first", "r1", "First note."), answerRow("a-last", "r1", "Last note.")];
  assert.equal(L.segmentTurns(rows, {}).turns[0].answer.id, "a-last");
});

test("segmentTurns: finishedAt falls back to the row createdAt without updatedAt", () => {
  const a = answerRow("a1", "r1", "Fixed the thing in setup.", hour(11));
  delete a.message.updatedAt;
  assert.equal(L.segmentTurns([userRow("u1"), a], {}).turns[0].finishedAt, hour(11));
});

test("segmentTurns: a work-live, thinking or working row marks a turn running", () => {
  for (const kind of ["work-live", "thinking", "working"]) {
    const { turns } = L.segmentTurns([...finishedTurn(1), userRow("u2"), row(kind, "x"), answerRow("a2", "r2", "Partial.")], {});
    assert.equal(turns[0].running, false, `${kind}: finished turn`);
    assert.equal(turns[1].running, true, kind);
  }
});

test("segmentTurns: isWorking runs only the last turn", () => {
  const { turns } = L.segmentTurns([...finishedTurn(1), ...finishedTurn(2)], { isWorking: true });
  assert.deepEqual(turns.map((t) => t.running), [false, true]);
  assert.deepEqual(L.segmentTurns([...finishedTurn(1), ...finishedTurn(2)], { isWorking: false }).turns.map((t) => t.running), [false, false]);
});

test("segmentTurns: a last turn with no answer and no fold runs; with a fold but no answer it is finished", () => {
  assert.equal(L.segmentTurns([userRow("u1")], {}).turns[0].running, true);
  assert.equal(L.segmentTurns([userRow("u1"), foldRow("r1", "You stopped after 3m")], {}).turns[0].running, false);
  assert.equal(L.segmentTurns([userRow("u1"), answerRow("a1", "r1", "Fixed the thing.")], {}).turns[0].running, false);
  // only the last turn may run for lack of an answer
  const { turns } = L.segmentTurns([userRow("u1"), userRow("u2"), answerRow("a2", "r2", "Fixed the thing.")], {});
  assert.deepEqual(turns.map((t) => t.running), [false, false]);
});

test("segmentTurns: failure from work-toggle, error tone in a work group, or an error event", () => {
  const failed = (extra) => L.segmentTurns([userRow("u1"), extra, foldRow("r1"), answerRow("a1", "r1", "Fixed it.")], {}).turns[0].failed;
  assert.equal(failed(row("work-toggle", "t", { hasFailure: true })), true);
  assert.equal(failed(row("work-toggle", "t", { hasFailure: false })), false);
  assert.equal(failed(row("work", "w", { groupedEntries: [{ tone: "info" }, { tone: "error" }] })), true);
  assert.equal(failed(row("work", "w", { groupedEntries: [{ tone: "info" }] })), false);
  assert.equal(failed(errorEvent("e")), true);
  assert.equal(failed(row("event", "e", { projectedItem: { item: { type: "subagent" } } })), false);
});

test("segmentTurns: failure stays with its own turn", () => {
  const rows = [userRow("u1"), errorEvent("e1"), answerRow("a1", "r1", "Fixed it."), userRow("u2"), answerRow("a2", "r2", "Fixed it.")];
  assert.deepEqual(L.segmentTurns(rows, {}).turns.map((t) => t.failed), [true, false]);
});

test("segmentTurns: latestRun failed marks the last finished turn, never a running one", () => {
  const latestRun = { status: "failed" };
  const finished = L.segmentTurns([...finishedTurn(1), ...finishedTurn(2)], { latestRun });
  assert.deepEqual(finished.turns.map((t) => t.failed), [false, true]);
  const running = L.segmentTurns([...finishedTurn(1), ...finishedTurn(2)], { latestRun, isWorking: true });
  assert.deepEqual(running.turns.map((t) => t.failed), [false, false]);
  const ok = L.segmentTurns([...finishedTurn(1)], { latestRun: { status: "completed" } });
  assert.equal(ok.turns[0].failed, false);
});

// ---- 6. calmRows in Focus ----
test("Focus: finished turns get one title before the user message; only the latest is open", () => {
  const out = L.calmRows(threeFinishedPlusRunning(), ctx({ isWorking: true }), view());
  assert.deepEqual(ids(out), [
    "calm-title:u1",
    "calm-title:u2",
    "calm-title:u3",
    "u3",
    "turn-fold:r3",
    "a3",
    "u4",
    "wl4",
  ]);
  const titles = out.rows.filter((r) => r.kind === "calm-title");
  assert.equal(titles.length, 3);
  assert.deepEqual(titles.map((t) => t.open), [false, false, true]);
  assert.deepEqual(titles.map((t) => t.title), [1, 2, 3].map((n) => `Fixed issue number ${n} in setup`));
  assert.deepEqual(titles.map((t) => t.turnId), ["u1", "u2", "u3"]);
  assert.equal(titles[0].duration, "35m");
  assert.equal(titles[0].at, hour(10));
  assert.equal(titles[0].createdAt, T0);
});

test("Focus: rows before the first user message stay first", () => {
  const out = L.calmRows([row("worktree-setup", "pre1"), ...finishedTurn(1)], ctx(), view());
  assert.deepEqual(ids(out), ["pre1", "calm-title:u1", "u1", "turn-fold:r1", "a1"]);
});

test("Focus: the fold keeps id and runId, its label becomes the receipt, the input row is untouched", () => {
  const rows = finishedTurn(1);
  const entries = [workEntry("w1", "r1", "command_execution"), workEntry("w2", "r1", "command_execution"), workEntry("w3", "r1", "file_change"), workEntry("w4", "r2", "file_change")];
  const out = L.calmRows(rows, ctx({ entries }), view());
  const fold = out.rows.find((r) => r.kind === "turn-fold");
  assert.equal(fold.id, "turn-fold:r1");
  assert.equal(fold.runId, "r1");
  assert.equal(fold.label, "2 commands · 1 edit · 35m");
  assert.equal(fold.expanded, false);
  assert.equal(rows[1].label, "Worked for 35m 12s");
});

test("Focus: a fold with nothing to count keeps its T3 label", () => {
  const rows = finishedTurn(1);
  const fold = L.calmRows(rows, ctx(), view()).rows.find((r) => r.kind === "turn-fold");
  assert.equal(fold.label, "Worked for 35m 12s");
});

test("Focus running turn: keeps the prompt, the LAST live row, streaming answer, plans, pages, errors, active compaction", () => {
  const extra = [
    row("work", "w-stale", { isExpandedToolGroup: true, groupedEntries: [] }),
    row("work-live", "wl-last", { expanded: true }),
    row("work", "w-open", { isExpandedToolGroup: true, groupedEntries: [] }),
    row("work", "w-late", { isExpandedToolGroup: true, groupedEntries: [] }),
    answerRow("m-stream", "r4", "Streaming", hour(12), { streaming: true }),
    answerRow("m-done", "r4", "Finished note", hour(12)),
    row("proposed-plan", "plan"),
    row("html-render", "html"),
    errorEvent("err"),
    row("event", "ev-other", { projectedItem: { item: { type: "subagent", runId: "r4" } } }),
    row("context-compaction", "cc-on", { active: true }),
    row("context-compaction", "cc-off", { active: false }),
    row("working", "working"),
    row("assistant-meta", "meta"),
    row("work-toggle", "toggle", { hasFailure: false }),
    row("thinking", "think-old"),
  ];
  // thinking comes last, so it is the live row; wl4 / wl-last drop out and so does the group after wl-last.
  const out = L.calmRows(runningTurn(extra), ctx({ isWorking: true }), view());
  assert.deepEqual(ids(out), ["u4", "m-stream", "plan", "html", "err", "cc-on", "think-old"]);
});

test("Focus running turn: an expanded group right after an expanded live row stays", () => {
  const extra = [row("work", "w-open", { isExpandedToolGroup: true }), row("work", "w-late", { isExpandedToolGroup: true }), row("working", "working")];
  const rows = [userRow("u4"), row("work-live", "wl", { expanded: true }), ...extra];
  assert.deepEqual(ids(L.calmRows(rows, ctx({ isWorking: true }), view())), ["u4", "wl", "w-open"]);
  const collapsed = [userRow("u4"), row("work-live", "wl", { expanded: false }), ...extra];
  assert.deepEqual(ids(L.calmRows(collapsed, ctx({ isWorking: true }), view())), ["u4", "wl"]);
  const notExpanded = [userRow("u4"), row("work-live", "wl", { expanded: true }), row("work", "w", { isExpandedToolGroup: false })];
  assert.deepEqual(ids(L.calmRows(notExpanded, ctx({ isWorking: true }), view())), ["u4", "wl"]);
});

test("Focus running turn: the working row stays only when there is no live row", () => {
  const noLive = [userRow("u1"), row("working", "working"), answerRow("m1", "r1", "Done note", hour(10))];
  assert.deepEqual(ids(L.calmRows(noLive, ctx({ isWorking: true }), view())), ["u1", "working"]);
  const withLive = [userRow("u1"), row("working", "working"), row("thinking", "think")];
  assert.deepEqual(ids(L.calmRows(withLive, ctx({ isWorking: true }), view())), ["u1", "think"]);
});

test("Focus: a running turn gets no title and finished turns before it still fold", () => {
  const out = L.calmRows(threeFinishedPlusRunning(), ctx({ isWorking: true }), view());
  assert.equal(out.rows.some((r) => r.kind === "calm-title" && r.turnId === "u4"), false);
});

test("Focus: overrides open an old turn and close the latest", () => {
  const open1 = L.calmRows(finishedTurn(1).concat(finishedTurn(2)), ctx(), view({ overrides: new Map([["u1", true]]) }));
  assert.deepEqual(ids(open1), ["calm-title:u1", "u1", "turn-fold:r1", "a1", "calm-title:u2", "u2", "turn-fold:r2", "a2"]);
  const close2 = L.calmRows(finishedTurn(1).concat(finishedTurn(2)), ctx(), view({ overrides: new Map([["u2", false]]) }));
  assert.deepEqual(ids(close2), ["calm-title:u1", "calm-title:u2"]);
  assert.deepEqual(close2.rows.map((r) => r.open), [false, false]);
});

test("wants: weak first sentence asks for a model title; the latest turn asks with needs", () => {
  const rows = [...finishedTurn(1, { text: "Done." }), ...finishedTurn(2), ...finishedTurn(3)];
  const { wants } = L.calmRows(rows, ctx(), view());
  assert.deepEqual(wants.map((w) => ({ id: w.id, needs: w.needs })), [
    { id: "a1", needs: false },
    { id: "a3", needs: true },
  ]);
  assert.equal(wants[0].answer, "Done.");
  assert.equal(wants[0].prompt, "Please fix the bug in setup. Thanks");
});

test("wants: stops once titles has an entry; the latest needs withNeeds", () => {
  const rows = [...finishedTurn(1, { text: "Done." }), ...finishedTurn(2)];
  const known = (over) => view({ titles: new Map([["a1", { title: "Fixed setup" }], ["a2", over]]) });
  assert.deepEqual(L.calmRows(rows, ctx(), known({ title: "x" })).wants.map((w) => w.id), ["a2"]);
  assert.deepEqual(L.calmRows(rows, ctx(), known({ title: "x", withNeeds: true })).wants, []);
});

test("wants: not asked when the model is off or the turn has no answer", () => {
  const rows = [...finishedTurn(1, { text: "Done." }), userRow("u2"), foldRow("r2", "You stopped after 3m")];
  assert.deepEqual(L.calmRows(rows, ctx(), view({ model: false })).wants, []);
  assert.deepEqual(L.calmRows(rows, ctx(), view()).wants.map((w) => w.id), ["a1"]);
});

test("title: a weak first sentence takes the model title; a strong one keeps its own", () => {
  const rows = [...finishedTurn(1, { text: "Done." }), ...finishedTurn(2)];
  const titles = new Map([["a1", { title: "Fixed the setup flow" }], ["a2", { title: "Model title" }]]);
  const out = L.calmRows(rows, ctx(), view({ titles }));
  const t = out.rows.filter((r) => r.kind === "calm-title");
  assert.equal(t[0].title, "Fixed the setup flow");
  assert.equal(t[1].title, "Fixed issue number 2 in setup");
  assert.equal(t[0].fromPrompt, false);
});

test("title: a weak first sentence with no model title keeps the sentence", () => {
  const t = L.calmRows(finishedTurn(1, { text: "Done." }), ctx(), view()).rows[0];
  assert.equal(t.title, "Done");
});

test("needs: the view's needsYou wins over a model needs, on the latest finished turn only", () => {
  const rows = [...finishedTurn(1), ...finishedTurn(2)];
  const titles = new Map([["a1", { title: "x", needs: "Old question?" }], ["a2", { title: "x", needs: "Model question?" }]]);
  const wins = L.calmRows(rows, ctx(), view({ titles, needsYou: "Approve the plan" })).rows.filter((r) => r.kind === "calm-title");
  assert.deepEqual(wins.map((t) => t.needs), [null, "Approve the plan"]);
  const model = L.calmRows(rows, ctx(), view({ titles })).rows.filter((r) => r.kind === "calm-title");
  assert.deepEqual(model.map((t) => t.needs), [null, "Model question?"]);
});

test("needs: a running last turn leaves the latest finished turn as the one that needs you", () => {
  const out = L.calmRows(threeFinishedPlusRunning(), ctx({ isWorking: true }), view({ needsYou: "Approve" }));
  assert.deepEqual(out.rows.filter((r) => r.kind === "calm-title").map((t) => t.needs), [null, null, "Approve"]);
});

test("title row: failed turn is flagged", () => {
  const rows = [userRow("u1"), row("work-toggle", "t", { hasFailure: true }), foldRow("r1"), answerRow("a1", "r1", answerText(1))];
  assert.equal(L.calmRows(rows, ctx(), view()).rows[0].failed, true);
  assert.equal(L.calmRows(finishedTurn(1), ctx(), view()).rows[0].failed, false);
});

// ---- 7. Normal and Full ----
test("Normal: every finished turn is open; the running turn keeps all its rows", () => {
  const extra = [row("working", "working"), answerRow("m-done", "r4", "Note", hour(12))];
  const out = L.calmRows([...finishedTurn(1), ...finishedTurn(2), ...runningTurn(extra)], ctx({ isWorking: true }), view({ mode: "normal" }));
  assert.deepEqual(ids(out), [
    "calm-title:u1", "u1", "turn-fold:r1", "a1",
    "calm-title:u2", "u2", "turn-fold:r2", "a2",
    "u4", "wl4", "working", "m-done",
  ]);
});

test("Normal: an override can close a turn", () => {
  const out = L.calmRows(finishedTurn(1).concat(finishedTurn(2)), ctx(), view({ mode: "normal", overrides: new Map([["u1", false]]) }));
  assert.deepEqual(ids(out), ["calm-title:u1", "calm-title:u2", "u2", "turn-fold:r2", "a2"]);
});

test("Full: every turn open, even against an override", () => {
  const out = L.calmRows(finishedTurn(1).concat(finishedTurn(2)), ctx(), view({ mode: "full", overrides: new Map([["u1", false]]) }));
  assert.deepEqual(ids(out), ["calm-title:u1", "u1", "turn-fold:r1", "a1", "calm-title:u2", "u2", "turn-fold:r2", "a2"]);
  assert.equal(out.rows.filter((r) => r.kind === "calm-title").every((t) => t.open), true);
});

test("Full: the running turn keeps all rows", () => {
  const extra = [row("working", "working"), row("assistant-meta", "meta")];
  const out = L.calmRows(runningTurn(extra), ctx({ isWorking: true }), view({ mode: "full" }));
  assert.deepEqual(ids(out), ["u4", "wl4", "working", "meta"]);
});

// ---- 8. Hidden answer (T3 #8879) ----
const hiddenText = (n) => "H".repeat(n);
const hiddenCase = ({ shown = "Short note after the real answer.", hidden = hiddenText(600), fold = foldRow("r1"), mode = "focus", extraEntries = [] } = {}) => {
  const rows = [userRow("u1"), fold, answerRow("a1", "r1", shown, hour(10))];
  const entries = [assistantEntry("e-hidden", "r1", hidden, "msg-hidden"), assistantEntry("a1", "r1", shown, "a1"), ...extraEntries];
  return L.calmRows(rows, ctx({ entries }), view({ mode }));
};

test("hidden answer: a long earlier message is inserted right before the short shown answer", () => {
  const out = hiddenCase();
  assert.deepEqual(ids(out), ["calm-title:u1", "u1", "turn-fold:r1", "e-hidden", "a1"]);
  const inserted = out.rows.find((r) => r.id === "e-hidden");
  assert.equal(inserted.kind, "message");
  assert.equal(inserted.message.id, "msg-hidden");
  assert.equal(inserted.showAssistantMeta, false);
  assert.equal(inserted.showAssistantCopyButton, false);
});

test("hidden answer: the longest hidden message of the run wins", () => {
  const out = hiddenCase({ extraEntries: [assistantEntry("e-longer", "r1", hiddenText(900), "msg-longer")] });
  assert.ok(ids(out).includes("e-longer"));
  assert.equal(ids(out).includes("e-hidden"), false);
});

test("hidden answer: no insert when the shown answer is long (280 chars), insert at 279", () => {
  assert.equal(ids(hiddenCase({ shown: "s".repeat(280), hidden: hiddenText(900) })).includes("e-hidden"), false);
  assert.equal(ids(hiddenCase({ shown: "s".repeat(279), hidden: hiddenText(900) })).includes("e-hidden"), true);
});

test("hidden answer: no insert when the fold is expanded", () => {
  assert.equal(ids(hiddenCase({ fold: foldRow("r1", "Worked for 35m 12s", true) })).includes("e-hidden"), false);
});

test("hidden answer: no insert when the turn has no fold", () => {
  const rows = [userRow("u1"), answerRow("a1", "r1", "Short note.", hour(10))];
  const out = L.calmRows(rows, ctx({ entries: [assistantEntry("e-hidden", "r1", hiddenText(600))] }), view());
  assert.equal(ids(out).includes("e-hidden"), false);
});

test("hidden answer: the hidden message needs max(400, 2x shown) chars", () => {
  assert.equal(ids(hiddenCase({ hidden: hiddenText(399) })).includes("e-hidden"), false);
  assert.equal(ids(hiddenCase({ hidden: hiddenText(400) })).includes("e-hidden"), true);
  const shown = "s".repeat(250);
  assert.equal(ids(hiddenCase({ shown, hidden: hiddenText(499) })).includes("e-hidden"), false);
  assert.equal(ids(hiddenCase({ shown, hidden: hiddenText(500) })).includes("e-hidden"), true);
});

test("hidden answer: never from another run, from a row already shown, or the shown message itself", () => {
  const other = L.calmRows(
    [userRow("u1"), foldRow("r1"), answerRow("a1", "r1", "Short note.", hour(10))],
    ctx({ entries: [assistantEntry("e-other", "r2", hiddenText(900))] }),
    view(),
  );
  assert.equal(ids(other).includes("e-other"), false);
  // an entry whose id is already a row (a1) must not be inserted twice
  const dup = L.calmRows(
    [userRow("u1"), foldRow("r1"), answerRow("a1", "r1", "Short note.", hour(10))],
    ctx({ entries: [assistantEntry("a1", "r1", hiddenText(900), "other-msg")] }),
    view(),
  );
  assert.equal(ids(dup).filter((id) => id === "a1").length, 1);
  // same message id under a different entry id is the shown message
  const same = L.calmRows(
    [userRow("u1"), foldRow("r1"), answerRow("a1", "r1", "Short note.", hour(10))],
    ctx({ entries: [assistantEntry("e-same", "r1", hiddenText(900), "a1")] }),
    view(),
  );
  assert.equal(ids(same).includes("e-same"), false);
});

test("hidden answer: user messages in entries are ignored", () => {
  const userEntry = { kind: "message", id: "e-user", createdAt: T0, message: { id: "mu", role: "user", text: hiddenText(900), runId: "r1" } };
  assert.equal(ids(hiddenCase({ extraEntries: [userEntry], hidden: hiddenText(10) })).includes("e-user"), false);
});

test("hidden answer: Normal inserts it, Full never does, and a closed Focus turn shows nothing", () => {
  assert.equal(ids(hiddenCase({ mode: "normal" })).includes("e-hidden"), true);
  assert.equal(ids(hiddenCase({ mode: "full" })).includes("e-hidden"), false);
  const rows = [...finishedTurn(1), ...finishedTurn(2)];
  const entries = [assistantEntry("e-hidden", "r1", hiddenText(900))];
  const out = L.calmRows(rows.map((r) => (r.id === "a1" ? answerRow("a1", "r1", "Short note.", hour(10)) : r)), ctx({ entries }), view());
  assert.equal(ids(out).includes("e-hidden"), false);
});

// ---- 9. Brief ----
const briefRows = () => {
  const failedTurn = [userRow("u2"), row("work-toggle", "tg2", { hasFailure: true }), foldRow("r2"), answerRow("a2", "r2", answerText(2), hour(11))];
  return [...finishedTurn(1), ...failedTurn, ...finishedTurn(3), ...runningTurn()];
};
const since = "2026-01-01T10:30:00Z";

test("brief: appended last, lists titles finished after since, failures, latest needs and the running prompt", () => {
  const out = L.calmRows(briefRows(), ctx({ isWorking: true }), view({ since, needsYou: "Approve the plan" }));
  const last = out.rows.at(-1);
  assert.equal(last.kind, "calm-brief");
  assert.equal(last.id, "calm-brief");
  assert.equal(last.since, since);
  // A failed turn is listed under Failed only, not also under Done.
  assert.deepEqual(last.done, ["Fixed issue number 3 in setup"]);
  assert.deepEqual(last.failed, ["Fixed issue number 2 in setup"]);
  assert.equal(last.needs, "Approve the plan");
  assert.equal(last.running, "Now refactor the parser");
  assert.equal(out.rows.filter((r) => r.kind === "calm-brief").length, 1);
});

test("brief: a turn finished exactly at since is not new", () => {
  const out = L.calmRows(briefRows(), ctx({ isWorking: true }), view({ since: hour(11) }));
  assert.deepEqual(out.rows.at(-1).done, ["Fixed issue number 3 in setup"]);
});

test("brief: a failed turn from before since stays out of failed", () => {
  const out = L.calmRows(briefRows(), ctx({ isWorking: true }), view({ since: hour(11) }));
  assert.deepEqual(out.rows.at(-1).failed, []);
});

test("brief: running is null when no turn runs", () => {
  const out = L.calmRows(finishedTurn(1).concat(finishedTurn(2)), ctx(), view({ since: hour(9) }));
  assert.equal(out.rows.at(-1).running, null);
  assert.equal(out.rows.at(-1).needs, null);
});

test("brief: absent when dismissed, when brief is off, with no since, or when nothing finished after since", () => {
  const kinds = (v) => L.calmRows(briefRows(), ctx({ isWorking: true }), view(v)).rows.some((r) => r.kind === "calm-brief");
  assert.equal(kinds({ since }), true);
  assert.equal(kinds({ since, dismissed: true }), false);
  assert.equal(kinds({ since, brief: false }), false);
  assert.equal(kinds({ since: null }), false);
  assert.equal(kinds({ since: hour(23) }), false);
});

test("brief: a running turn alone does not make a brief", () => {
  const out = L.calmRows(runningTurn(), ctx({ isWorking: true }), view({ since: hour(1) }));
  assert.equal(out.rows.some((r) => r.kind === "calm-brief"), false);
});

// ---- 10. synthetic rows ----
test("synthetic rows carry threadKey from ctx", () => {
  const out = L.calmRows(briefRows(), ctx({ threadKey: "env:thread-42", isWorking: true }), view({ since }));
  const synthetic = out.rows.filter((r) => r.kind === "calm-title" || r.kind === "calm-brief");
  assert.equal(synthetic.length, 4);
  assert.deepEqual([...new Set(synthetic.map((r) => r.threadKey))], ["env:thread-42"]);
});

test("title row for a turn with no answer uses the prompt's first sentence and fromPrompt", () => {
  const rows = [userRow("u1", "**Rename** the helper in `logic.mjs`. Then update docs"), foldRow("r1", "You stopped after 3m")];
  const out = L.calmRows(rows, ctx(), view());
  const title = out.rows[0];
  assert.equal(title.kind, "calm-title");
  assert.equal(title.title, "Rename the helper in logic.mjs");
  assert.equal(title.fromPrompt, true);
  assert.equal(title.at, T0, "a stopped turn ends at its last dated row (here the prompt)");
  assert.equal(title.duration, "3m");
  assert.equal(out.wants.length, 0);
  // a turn you stopped is no news: never part of a brief
  assert.equal(L.calmRows(rows, ctx(), view({ since: hour(1) })).rows.some((r) => r.kind === "calm-brief"), false);
});

test("title row: empty prompt and empty answer get placeholders", () => {
  const noPrompt = L.calmRows([userRow("u1", ""), foldRow("r1", "You stopped after 3m")], ctx(), view());
  assert.equal(noPrompt.rows[0].title, "Empty prompt");
  const noText = L.calmRows([userRow("u1"), answerRow("a1", "r1", "")], ctx(), view());
  assert.equal(noText.rows[0].title, "No text");
  assert.equal(noText.rows[0].fromPrompt, false);
});

test("title row for an answered turn is not fromPrompt", () => {
  assert.equal(L.calmRows(finishedTurn(1), ctx(), view()).rows[0].fromPrompt, false);
});

test("every fold in a turn with two runs gets its own receipt", () => {
  const user = { kind: "message", id: "u1", createdAt: "2026-10-08T10:00:00Z", message: { id: "u1", role: "user", text: "Plan the mod.", runId: null, streaming: false, createdAt: "2026-10-08T10:00:00Z" } };
  const fold = (run, label) => ({ kind: "turn-fold", id: `turn-fold:${run}`, runId: run, label, expanded: false });
  const answer = (id, run, text) => ({ kind: "message", id, createdAt: "2026-10-08T10:05:00Z", message: { id, role: "assistant", text, runId: run, streaming: false, createdAt: "2026-10-08T10:05:00Z", updatedAt: "2026-10-08T10:05:00Z" } });
  const rows = [user, fold("r1", "Worked for 3m 5s"), answer("a1", "r1", "Agents are still running."), fold("r2", "Worked for 1m 2s"), answer("a2", "r2", "Built the plan for the calm mod.")];
  const entries = [
    { kind: "work", id: "w1", entry: { runId: "r1", itemType: "command_execution" } },
    { kind: "work", id: "w2", entry: { runId: "r1", itemType: "command_execution" } },
    { kind: "work", id: "w3", entry: { runId: "r2", itemType: "file_change" } },
  ];
  const view = { mode: "normal", titles: new Map(), needsYou: null, since: null, brief: false, dismissed: false, model: false };
  const { rows: out } = L.calmRows(rows, { threadKey: "e:t", entries, isWorking: false }, view);
  assert.deepEqual(out.filter((r) => r.kind === "turn-fold").map((r) => r.label), ["2 commands · 3m", "1 edit · 1m"]);
});

test("a last turn that failed before any answer is finished and failed, not running", () => {
  const user = { kind: "message", id: "u1", createdAt: "2026-10-08T10:00:00Z", message: { id: "u1", role: "user", text: "Benchmark the checkers.", runId: null, streaming: false, createdAt: "2026-10-08T10:00:00Z" } };
  const toggle = { kind: "work-toggle", id: "wt1", hasFailure: false };
  const work = { kind: "work", id: "w1", groupedEntries: [{ tone: "tool" }], isExpandedToolGroup: false };
  const err = { kind: "event", id: "e1", createdAt: "2026-10-08T10:01:00Z", projectedItem: { item: { type: "system_notice", runId: "r1" } } };
  const view = { mode: "focus", titles: new Map(), needsYou: null, since: "2026-10-08T09:00:00Z", brief: true, dismissed: false, model: false };
  for (const status of ["failed", "interrupted"]) {
    const ctx = { threadKey: "e:t", entries: [], isWorking: false, latestRun: { runId: "r1", status } };
    const { turns } = L.segmentTurns([user, toggle, work, err], ctx);
    assert.equal(turns[0].running, false, status);
    assert.equal(turns[0].failed, status === "failed");
    const { rows } = L.calmRows([user, toggle, work, err], ctx, view);
    const title = rows.find((r) => r.kind === "calm-title");
    assert.ok(title, `${status}: the turn has a title row`);
    assert.equal(title.open, true, `${status}: the latest finished turn is open, so its work stays visible`);
    assert.deepEqual(rows.filter((r) => r.kind !== "calm-title" && r.kind !== "calm-brief").map((r) => r.id), ["u1", "wt1", "w1", "e1"]);
    const brief = rows.find((r) => r.kind === "calm-brief");
    assert.deepEqual(brief?.failed ?? [], status === "failed" ? ["Benchmark the checkers"] : [], `${status}: the card lists a failure`);
  }
  // Still running while T3 works, even with no answer yet.
  const working = L.segmentTurns([user, toggle], { isWorking: true, latestRun: { runId: "r1", status: "running" } });
  assert.equal(working.turns[0].running, true);
});
