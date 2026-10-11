// no-dead-taskkill: the taskkill helper skips a child that already exited and still kills a live one.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../loader/patcher.cjs");

const [patch] = P.normalize("no-dead-taskkill", require(path.join(__dirname, "..", "mods", "no-dead-taskkill", "server-patches.cjs")));
const FIXTURE = `const taskkill = (childProcess, onExit = () => {}) => NodeChildProcess.execFile("taskkill", [
	"/pid",
	String(childProcess.pid),
	"/T",
	"/F"
], { windowsHide: true }, onExit);
taskkill`;

function patched() {
  const r = P.applyPatch(patch, FIXTURE);
  assert.equal(r.ok, true, r.error);
  const calls = [];
  const NodeChildProcess = { execFile: (...a) => (calls.push(a), { fake: true }) };
  return { taskkill: vm.runInNewContext(r.text, { NodeChildProcess }), calls };
}

test("an exited child (exit code or signal set) gets no taskkill, and the callback still runs", () => {
  for (const child of [{ pid: 1, exitCode: 1, signalCode: null }, { pid: 1, exitCode: 128, signalCode: null }, { pid: 1, exitCode: null, signalCode: "SIGTERM" }]) {
    const { taskkill, calls } = patched();
    let done = 0;
    taskkill(child, (err) => { assert.equal(err, null); done++; });
    assert.equal(calls.length, 0);
    assert.equal(done, 1);
  }
});

test("a live child still gets the tree kill", () => {
  const { taskkill, calls } = patched();
  const cb = () => {};
  taskkill({ pid: 42, exitCode: null, signalCode: null }, cb);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].slice(0, 3)), JSON.stringify(["taskkill", ["/pid", "42", "/T", "/F"], { windowsHide: true }]));
  assert.equal(calls[0][3], cb);
});

test("a build whose helper changed fails the patch and leaves the text alone", () => {
  const changed = FIXTURE.replace('"/T",', '"/T", "/X",');
  const r = P.applyPatch(patch, changed);
  assert.equal(r.ok, false);
  assert.equal(r.text, changed);
});
