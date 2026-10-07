const test = require("node:test");
const assert = require("node:assert/strict");
const { normalize, applyPatch, doctor, resolveHealth, applyAll, tryPatch } = require("../loader/patcher.cjs");

const chunk = (name, text) => ({ name, text });
const patch = (mod, p) => normalize(mod, [p])[0];

test("\\i matches a minified identifier", () => {
  const p = patch("m", { find: "hello", replace: [{ match: /(\i)\.push\(1\)/, replace: "$1.push(2)" }] });
  assert.equal(applyPatch(p, "hello;Ke.push(1)").text, "hello;Ke.push(2)");
});

test("group keeps the original text when one entry fails", () => {
  const p = patch("m", { find: "a", group: true, replace: [{ match: /a/, replace: "A" }, { match: /zzz/, replace: "Z" }] });
  const r = applyPatch(p, "abc");
  assert.equal(r.text, "abc");
  assert.deepEqual(r.entries, [true, false]);
  assert.equal(r.ok, false);
});

test("without group, matching entries still apply", () => {
  const p = patch("m", { find: "a", replace: [{ match: /a/, replace: "A" }, { match: /zzz/, replace: "Z" }] });
  assert.equal(applyPatch(p, "abc").text, "Abc");
});

test("$self points at the mod's exports, in strings and in replacer functions", () => {
  const s = patch("my-mod", { find: "x", replace: [{ match: /x/, replace: "$self.go()" }] });
  assert.match(applyPatch(s, "x").text, /exports\?\.\["my-mod"\]/);
  const f = patch("my-mod", { find: "x", replace: [{ match: /x/, replace: () => "$self.go()" }] });
  assert.match(applyPatch(f, "x").text, /exports\?\.\["my-mod"\]/);
});

test("a throwing transform leaves the chunk untouched", () => {
  const p = patch("m", { find: "a", transform: () => { throw new Error("boom"); } });
  const r = applyPatch(p, "abc");
  assert.equal(r.text, "abc");
  assert.match(r.error, /boom/);
});

test("normalize rejects malformed patches", () => {
  assert.throws(() => normalize("m", [{ find: 1, replace: [] }]), /find/);
  assert.throws(() => normalize("m", [{ find: "a" }]), /replace or transform/);
  assert.throws(() => normalize("m", {}), /array/);
});

test("doctor reports each entry, so a partly broken patch is not ok", () => {
  const ps = normalize("m", [
    { id: "good", find: "alpha", replace: [{ match: /alpha/, replace: "A" }] },
    { id: "partial", find: "beta", replace: [{ match: /beta/, replace: "B" }, { match: /nope/, replace: "" }] },
    { id: "missing", find: "nowhere", replace: [{ match: /x/, replace: "" }] },
    { id: "ambiguous", find: "common", replace: [{ match: /common/, replace: "" }] },
    { id: "nomatch", find: "gamma", replace: [{ match: /nope/, replace: "" }] },
  ]);
  const report = doctor(ps, [chunk("a.js", "alpha beta gamma common"), chunk("b.js", "common")]);
  const status = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
  assert.deepEqual(status, { good: "ok", partial: "partial", missing: "find-missing", ambiguous: "find-ambiguous", nomatch: "match-missing" });
  assert.deepEqual(report.results[1].entries, [true, false]);
});

test("doctor applies patches in order, so a conflict with an earlier patch shows", () => {
  const ps = [
    ...normalize("core", [{ id: "slot", find: "x=row", replace: [{ match: /x=row/, replace: "x=[row]" }] }]),
    ...normalize("late", [{ id: "same", find: "row", replace: [{ match: /x=row/, replace: "x=row2" }] }]),
  ];
  const report = doctor(ps, [chunk("a.js", "x=row")]);
  assert.deepEqual(report.results.map((r) => r.status), ["ok", "match-missing"]);
});

test("predicate false skips a patch; a throwing predicate is an error", () => {
  const ps = normalize("m", [
    { id: "off", find: "a", predicate: ({ state }) => state.on, replace: [{ match: /a/, replace: "b" }] },
    { id: "bad", find: "a", predicate: () => { throw new Error("x"); }, replace: [{ match: /a/, replace: "b" }] },
  ]);
  const { evalPredicate } = require("../loader/patcher.cjs");
  const report = doctor(ps, [chunk("a.js", "a")], (p) => evalPredicate(p, { state: { on: false } }));
  assert.deepEqual(report.results.map((r) => r.status), ["skipped", "error"]);
});

test("a failed own patch degrades the mod, and mods that require it", () => {
  const mods = [
    { id: "core", enabled: true, manifest: {} },
    { id: "a", enabled: true, manifest: { requires: ["core/slot"] } },
    { id: "b", enabled: true, manifest: { requires: ["a"] } },
    { id: "c", enabled: true, manifest: {} },
    { id: "d", enabled: false, manifest: {} },
    { id: "e", enabled: true, manifest: { requires: ["d"] } },
  ];
  const results = [
    { key: "core/slot", mod: "core", status: "match-missing", optional: false },
    { key: "c/opt", mod: "c", status: "find-missing", optional: true },
  ];
  const h = resolveHealth(mods, results);
  assert.equal(h.get("core").status, "degraded");
  assert.equal(h.get("a").status, "degraded");
  assert.equal(h.get("b").status, "degraded");
  assert.equal(h.get("c").status, "ok", "optional patches do not degrade");
  assert.equal(h.get("d").status, "disabled");
  assert.equal(h.get("e").status, "degraded");
});

test("applyAll skips inactive patches and counts hits", () => {
  const ps = normalize("m", [
    { id: "x", find: "a", replace: [{ match: /a/, replace: "b" }] },
    { id: "y", find: "c", replace: [{ match: /c/, replace: "d" }] },
  ]);
  const stats = new Map();
  const out = applyAll(ps, "ac", (p) => p.id === "x", undefined, stats);
  assert.equal(out, "bc");
  assert.deepEqual([...stats], [["m/x", 1]]);
});

test("tryPatch shows a before/after window", () => {
  const [r] = tryPatch({ find: "needle", replace: [{ match: "needle", replace: "pin" }] }, [chunk("a.js", "hay needle hay")]);
  assert.equal(r.chunk, "a.js");
  assert.deepEqual(r.entries, [true]);
  assert.match(r.before, /needle/);
  assert.match(r.after, /pin/);
});
