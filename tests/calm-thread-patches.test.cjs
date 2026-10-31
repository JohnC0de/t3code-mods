// calm-thread: the timeline-rows patch hands T3's rows to the renderer's `calmRows`, and Full
// density opens every fold. VAR_017 (the 0.1.4 hooks, with the input object cached in a variable
// by the compiler), HOOK_014 (React Compiler output, a derive hook plus a stabilizer)
// and MEMO_013 (a useMemo with a ref) are MessagesTimeline's rows code, trimmed, as 0.1.4 and
// 0.1.3 ship it. A fake React runs them: useMemo recomputes when a dependency changes.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const P = require("../loader/patcher.cjs");

const patches = () => P.normalize("calm-thread", require("../mods/calm-thread/patches.cjs"));

const HOOK_014 =
  "function rowsOf(Z,eb,$y,ct,he,E,M,u,vn,gt){let[a]=(0,Z.useState)(0);" +
  "let Tn=new Set,En=eb($y(`${ct}\\0${he??``}`,{timelineEntries:E,pendingApprovalRequestIds:Tn,latestRun:M,expandedRunIds:vn,expandedWorkGroupIds:gt,isWorking:u,continuesWorkLog:!0}),ct);return En}";

const VAR_017 =
  "function rowsOf(Z,eb,$y,ct,he,E,M,u,vn,gt,t){let[a]=(0,Z.useState)(0);let Fn;" +
  "t[0]!==E||t[1]!==M||t[2]!==u||t[3]!==vn||t[4]!==gt?(Fn={timelineEntries:E,latestRun:M,expandedRunIds:vn,expandedWorkGroupIds:gt,isWorking:u,continuesWorkLog:!0},t[0]=E,t[1]=M,t[2]=u,t[3]=vn,t[4]=gt,t[5]=Fn):Fn=t[5];" +
  "let X=eb($y(`${ct}\\0${he??``}`,Fn),ct);return X}";

const MEMO_013 =
  "function rowsOf(R,useStableRows,derive,reuse,key,E,M,u,vn,gt){let ref=(0,R.useRef)(null),rows=useStableRows((0,R.useMemo)(()=>{" +
  "let prev=ref.current,projection=derive({timelineEntries:E,latestRun:M,expandedRunIds:vn,expandedWorkGroupIds:gt,isWorking:u,continuesWorkLog:!0},reuse);" +
  "return ref.current={threadKey:key,projection},projection.rows},[E,M,vn,gt,u,key]),key);return rows}";

function fakeReact() {
  let slots = [];
  let i = 0;
  const R = {
    useState: (v) => [v, () => {}],
    useRef: (v) => (slots[i] ??= { current: v }, slots[i++]),
    useSyncExternalStore: (_sub, get) => get(),
    useMemo(fn, deps) {
      const prev = slots[i];
      const same = prev && prev.deps.length === deps.length && prev.deps.every((d, k) => Object.is(d, deps[k]));
      if (!same) slots[i] = { deps, value: fn() };
      return slots[i++].value;
    },
  };
  return { R, render: () => (i = 0) };
}

function setup(code) {
  const calls = [];
  const ctx = vm.createContext({});
  ctx.__t3mods = { exports: { "calm-thread": { calmRows: (rows, c) => (calls.push(c), ["calm", ...rows]) } } };
  vm.runInContext(`globalThis.__t3mods=__t3mods;${code};this.rowsOf=rowsOf`, ctx);
  return { ctx, calls, store: () => ctx.__t3modCalm };
}

for (const [name, code] of [["0.1.7", VAR_017], ["0.1.4", HOOK_014], ["0.1.3", MEMO_013]]) {
  test(`${name} shape: the patch applies`, () => {
    const report = P.doctor(patches(), [{ name: "chunk.js", text: code }]);
    assert.deepEqual(report.results.map((r) => [r.id, r.status]), [["timeline-rows", "ok"]]);
  });
}

for (const [name, code] of [["0.1.7", VAR_017], ["0.1.4", HOOK_014]]) test(`${name} shape: calmRows gets T3's rows and the thread, and runs again on a bump`, () => {
  const { ctx, calls, store } = setup(P.applyAll(patches(), code, () => true));
  const cache = [];
  const { R, render } = fakeReact();
  const inputs = [];
  // Like T3's derive hook: the same rows while every input field is the same (Sets by content).
  let last = null;
  // The vm's Sets are not this realm's Set, so no instanceof.
  const isSet = (x) => Object.prototype.toString.call(x) === "[object Set]";
  const sameField = (a, b) => Object.is(a, b) || (isSet(a) && isSet(b) && a.size === b.size && [...a].every((x) => b.has(x)));
  const derive = (_key, input) => {
    inputs.push(input);
    const same = last && Object.keys(input).every((k) => sameField(input[k], last.input[k]));
    if (!same) last = { input, rows: ["row-1", "row-2"] };
    return last.rows;
  };
  const stable = (rows) => rows;
  const entries = [{ id: "e1" }];
  const run = { runId: "run-1" };
  const open = new Set();
  const draw = () => (render(), ctx.rowsOf(R, stable, derive, "env:thread-1", "/repo", entries, run, true, open, open, cache));

  assert.deepEqual(draw(), ["calm", "row-1", "row-2"]);
  // The context object comes from the vm's realm: compare its fields.
  const { threadKey, entries: e, latestRun, isWorking } = calls[0];
  assert.deepEqual([threadKey, e, latestRun, isWorking], ["env:thread-1", entries, run, true]);
  assert.equal(inputs[0].expandedRunIds, open);

  draw();
  assert.equal(calls.length, 1, "same inputs: calmRows does not run again");

  store().full = true;
  store().bump();
  draw();
  assert.equal(calls.length, 2, "a bump runs calmRows again");
  assert.equal(inputs.at(-1).expandedRunIds.has("any-run"), true, "Full opens every run fold");
  assert.equal(inputs.at(-1).expandedWorkGroupIds.has("any-group"), true, "Full opens every work group");
});

test("0.1.4 shape: without the mod's renderer T3's rows pass through", () => {
  const { ctx } = setup(P.applyAll(patches(), HOOK_014, () => true));
  ctx.__t3mods.exports = {};
  const { R, render } = fakeReact();
  render();
  assert.deepEqual(ctx.rowsOf(R, (r) => r, () => ["row-1"], "k", null, [], null, false, new Set(), new Set()), ["row-1"]);
});

test("0.1.3 shape: calmRows gets the rows, and Full opens every fold", () => {
  const { ctx, calls, store } = setup(P.applyAll(patches(), MEMO_013, () => true));
  const { R, render } = fakeReact();
  const inputs = [];
  const derive = (input) => (inputs.push(input), { rows: ["row-1"] });
  const open = new Set();
  const draw = () => (render(), ctx.rowsOf(R, (r) => r, derive, null, "env:thread-1", [], null, false, open, open));
  assert.deepEqual(draw(), ["calm", "row-1"]);
  assert.equal(calls[0].threadKey, "env:thread-1");
  store().full = true;
  store().bump();
  draw();
  assert.equal(calls.length, 2);
  assert.equal(inputs.at(-1).expandedRunIds.has("x"), true);
});
