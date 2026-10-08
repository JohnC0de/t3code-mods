// working-bg-commands: the patched Working check keeps a thread with a live background command
// in the Working section. WORKING is T3's minified `isThreadWorking` as it ships, with its
// runtime-active helper inlined; the last test runs the patch on a real bundle.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const asar = require("../loader/asar.cjs");
const P = require("../loader/patcher.cjs");

const root = path.join(__dirname, "..");
const patches = () => P.normalize("working-bg-commands", require("../mods/working-bg-commands/patches.cjs"));
const realAsar = path.join(root, "sandbox", "app", "resources", "server.asar");
const ASSETS = "apps/server/dist/client/assets";

// threadRuntimeIsActive, as in client-runtime models.ts.
const ACTIVE = "var y=e=>e!=null&&[`preparing`,`queued`,`starting`,`running`,`waiting`].includes(e.status);";
const WORKING =
  "function ge(e){if(e.hasPendingApprovals||e.hasPendingUserInput||!y(e.runtime)&&e.runtime?.status!==`idle`)return!1;" +
  "let t=e.latestRun,n=t!==null&&t.status!==`preparing`&&t.status!==`queued`&&t.status!==`starting`&&t.status!==`running`&&t.status!==`waiting`&&e.runtime?.activeRunId!==t.runId;" +
  "return!(e.interactionMode===`plan`&&e.hasActionableProposedPlan&&n)}";

const patch = (text) => P.applyAll(patches(), text, () => true);

function load(code, name = "ge") {
  const ctx = vm.createContext({});
  vm.runInContext(`${ACTIVE}${code};this.working=${name}`, ctx);
  return (thread) => ctx.working(structuredClone(thread));
}

const run = { runId: "run-1", status: "completed" };
const thread = (over = {}) => ({
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default",
  latestRun: run,
  pendingBackgroundTasks: [],
  runtime: { status: "completed", activeRunId: null },
  ...over,
});
const command = [{ taskId: "bg-1", kind: "command", description: "Run the eval round" }];

test("unpatched: a thread waiting on a background command is not Working (T3's behavior)", () => {
  const working = load(WORKING);
  assert.equal(working(thread({ pendingBackgroundTasks: command })), false);
  // A subagent parks the runtime at idle, so it already counts.
  assert.equal(working(thread({ runtime: { status: "idle", activeRunId: null } })), true);
});

test("the patch applies to T3's code shape", () => {
  const report = P.doctor(patches(), [{ name: "chunk.js", text: WORKING }]);
  assert.deepEqual(
    report.results.map((r) => [r.id, r.status, r.entries]),
    [["working-keeps-background-commands", "ok", [true]]],
  );
});

test("patched: any live background task keeps a finished thread in Working", () => {
  const working = load(patch(WORKING));
  for (const kind of ["command", "monitor", "subagent", "background_task"]) {
    assert.equal(working(thread({ pendingBackgroundTasks: [{ taskId: "bg-1", kind }] })), true, kind);
  }
  assert.equal(working(thread()), false, "a finished thread without background work goes to the inbox");
  assert.equal(working(thread({ runtime: { status: "running", activeRunId: "run-1" } })), true);
  assert.equal(working(thread({ runtime: { status: "idle", activeRunId: null } })), true);
});

test("patched: work that needs the user still goes to the inbox", () => {
  const working = load(patch(WORKING));
  const waiting = { pendingBackgroundTasks: command };
  assert.equal(working(thread({ ...waiting, runtime: { status: "failed", activeRunId: null } })), false, "failed run");
  assert.equal(working(thread({ ...waiting, hasPendingApprovals: true })), false, "approval");
  assert.equal(working(thread({ ...waiting, hasPendingUserInput: true })), false, "question");
  assert.equal(working(thread({ ...waiting, interactionMode: "plan", hasActionableProposedPlan: true })), false, "ready plan");
});

test("on the sandbox app's bundle the patch selects one chunk, which still parses and keeps a command in Working", { skip: !fs.existsSync(realAsar) && "no sandbox app" }, () => {
  // One header read: asar.readFile parses the header on each call.
  const { header, dataOffset } = asar.readHeader(realAsar);
  const files = asar.entryOf(header, ASSETS).files;
  const fd = fs.openSync(realAsar, "r");
  const chunks = Object.keys(files)
    .filter((n) => n.endsWith(".js"))
    .map((name) => {
      const buf = Buffer.alloc(files[name].size);
      fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(files[name].offset));
      return { name, text: buf.toString("utf8") };
    });
  fs.closeSync(fd);
  const report = P.doctor(patches(), chunks);
  assert.deepEqual(report.results.map((r) => [r.id, r.status, r.chunks.length]), [["working-keeps-background-commands", "ok", 1]]);

  const patched = patch(chunks.find((c) => c.name === report.results[0].chunks[0]).text);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-wbc-"));
  try {
    const out = path.join(dir, "chunk.mjs");
    fs.writeFileSync(out, patched);
    const check = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The shipped function itself, with the bundle's runtime-active helper renamed to ours.
  const fn = patched.match(/function ([\w$]+)\(([\w$]+)\)\{if\(\2\.hasPendingApprovals\|\|\2\.hasPendingUserInput\|\|\2\.runtime\?\.status===`failed`[^{}]*\}/);
  assert.ok(fn, "the patched Working check is in the chunk");
  const helper = fn[0].match(/!([\w$]+)\(\w+\.runtime\)/)[1];
  const working = load(`var ${helper}=y;${fn[0]}`, fn[1]);
  assert.equal(working(thread({ pendingBackgroundTasks: command })), true);
  assert.equal(working(thread()), false);
});
