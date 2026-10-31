// agent-images: the turn fold carries the entries it hides (`modEntries`), so the gallery can
// show images from a folded turn. FOLDS_013 and FOLDS_014 are MessagesTimeline's fold builders,
// trimmed to the fold metadata, as 0.1.3 and 0.1.4 ship them.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const P = require("../loader/patcher.cjs");

const patches = () => P.normalize("agent-images", require("../mods/agent-images/patches.cjs"));
const hidden = () => patches().filter((p) => p.id === "turn-fold-hidden");

// 0.1.3: one fold per turn; the hidden set is built before the fold.
const FOLDS_013 =
  "function folds(o,r){let c=new Map,u=o.entries[0],h=new Set(o.entries.flatMap(e=>r.has(e.id)?[e.id]:[])),g=`Worked`;" +
  "c.set(o.anchorEntryId,{runId:`run-1`,anchorEntryId:o.anchorEntryId,createdAt:o.startBoundary??u.createdAt,hiddenEntryIds:h,label:g});return c}";

// 0.1.4: a fold for the part before the first steer message, then one per steer segment.
const FOLDS_014 =
  "function folds(o,r){let c=new Map,u=o.entries[0],g=`Worked`,_=e=>new Set(e.flatMap(e=>r.has(e.id)?[e.id]:[])),v=o.entries.slice(0,o.steerSegments[0]?.startIndex);" +
  "c.set(o.anchorEntryId,{runId:`run-1`,anchorEntryId:o.anchorEntryId,createdAt:o.startBoundary??u.createdAt,hiddenEntryIds:_(v),entryIds:new Set(v.map(e=>e.id)),label:g});" +
  "for(let[e,{startIndex:t,steer:r}]of o.steerSegments.entries()){let i=o.entries.slice(t,o.steerSegments[e+1]?.startIndex),a=i[0];if(a===void 0)continue;" +
  "c.set(a.id,{runId:`run-1:steer:${r.id}`,anchorEntryId:a.id,createdAt:r.createdAt,hiddenEntryIds:_(i),entryIds:new Set(i.map(e=>e.id)),label:`Continued`})}return c}";

function load(code) {
  const ctx = vm.createContext({});
  vm.runInContext(`${code};this.folds=folds`, ctx);
  return ctx.folds;
}

const entry = (id) => ({ id, kind: "work", createdAt: "2026-10-28T10:00:00Z" });
const ids = (list) => list.map((e) => e.id);

test("0.1.3 shape: the fold lists the entries it hides", () => {
  const report = P.doctor(hidden(), [{ name: "chunk.js", text: FOLDS_013 }]);
  assert.deepEqual(report.results.map((r) => [r.id, r.status]), [["turn-fold-hidden", "ok"]]);
  const folds = load(P.applyAll(hidden(), FOLDS_013, () => true));
  const turn = { anchorEntryId: "a", startBoundary: null, entries: [entry("a"), entry("b"), entry("c")] };
  const fold = folds(turn, new Set(["a", "c"])).get("a");
  assert.deepEqual(ids(fold.modEntries), ["a", "c"]);
});

test("0.1.4 shape: every fold, steer segments too, lists the entries it hides", () => {
  const report = P.doctor(hidden(), [{ name: "chunk.js", text: FOLDS_014 }]);
  assert.deepEqual(report.results.map((r) => [r.id, r.status]), [["turn-fold-hidden", "ok"]]);
  const folds = load(P.applyAll(hidden(), FOLDS_014, () => true));
  const turn = {
    anchorEntryId: "a",
    startBoundary: null,
    entries: [entry("a"), entry("b"), entry("c"), entry("d"), entry("e")],
    steerSegments: [{ startIndex: 3, steer: { id: "s1", createdAt: "2026-10-28T10:05:00Z" } }],
  };
  const out = folds(turn, new Set(["b", "c", "e"]));
  const main = out.get("a");
  assert.deepEqual(ids(main.modEntries), ["b", "c"]);
  assert.deepEqual([...main.hiddenEntryIds], ["b", "c"], "T3's own hidden set is unchanged");
  assert.deepEqual([...main.entryIds], ["a", "b", "c"]);
  assert.equal(main.label, "Worked");
  assert.deepEqual(ids(out.get("d").modEntries), ["e"]);
});

test("the fold row carries the entries", () => {
  const ROW = "function row(u){return{kind:`turn-fold`,id:`turn-fold:${u.runId}`,createdAt:u.createdAt,runId:u.runId}}";
  const p = patches().filter((x) => x.id === "turn-fold-entries");
  const ctx = vm.createContext({});
  vm.runInContext(`${P.applyAll(p, ROW, () => true)};this.row=row`, ctx);
  assert.deepEqual(ctx.row({ runId: "r", createdAt: null, modEntries: [1] }).modEntries, [1]);
});
