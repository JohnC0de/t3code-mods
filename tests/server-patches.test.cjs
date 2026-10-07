// Server patches: the asar rewrite, the agent-instructions patch on real bundle text, and the
// loader's module hook in a backend-like process.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const asar = require("../loader/asar.cjs");
const P = require("../loader/patcher.cjs");
const SP = require("../loader/server-patches.cjs");

const root = path.join(__dirname, "..");
const loader = path.join(root, "loader", "t3mods-loader.cjs");
const modSource = path.join(root, "mods", "agent-instructions", "server-patches.cjs");
const realAsar = path.join(root, "..", "t3code-modding", "sandbox", "app", "resources", "server.asar");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-sp-"));

const { buildAsar, rawFs } = require("./helpers/asar.cjs");

// A copy of the agent-instructions mod with its own instructions file (or none).
function modCopy(dir, instructions) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(modSource, path.join(dir, "server-patches.cjs"));
  fs.writeFileSync(path.join(dir, "mod.json"), JSON.stringify({ id: "agent-instructions" }));
  if (instructions !== undefined) fs.writeFileSync(path.join(dir, "instructions.md"), instructions);
  delete require.cache[require.resolve(path.join(dir, "server-patches.cjs"))];
  return P.normalize("agent-instructions", require(path.join(dir, "server-patches.cjs")));
}

const evalConst = (code) => vm.runInNewContext(`${code}\nT3_CODE_ORCHESTRATION_INSTRUCTIONS`, { process });

// One template literal with escaped backticks, backslashes and a literal "${", like the real one.
const FIXTURE = "const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `\n## T3 Code orchestration\n\nUse \\`delegate_task\\` with \\`{\"a\":1}\\` and C:\\\\path, not \\${x}.\n`;";

test("asar rewrite replaces one file and leaves the others byte-identical", () => {
  const dir = tmp();
  const file = path.join(dir, "a.asar");
  buildAsar(file, { "keep.txt": "keep me", "apps/server/dist/x.mjs": "export default 1;\n", "z.bin": Buffer.alloc(70000, 7) });
  const out = path.join(dir, "b.asar");
  const next = Buffer.from("export default 2; // longer, so the header and offsets change\n");
  asar.writeWithChanges(file, out, { "apps/server/dist/x.mjs": next });
  assert.equal(asar.readFile(out, "keep.txt").toString(), "keep me");
  assert.deepEqual(asar.readFile(out, "z.bin"), Buffer.alloc(70000, 7));
  assert.deepEqual(asar.readFile(out, "apps/server/dist/x.mjs"), next);
  const entry = asar.entryOf(asar.readHeader(out).header, "apps/server/dist/x.mjs");
  assert.deepEqual(entry.integrity, asar.integrity(next));
  assert.deepEqual(asar.listDir(out, "apps/server/dist"), ["x.mjs"]);
});

test("the real server.asar header serializes back to the same bytes", { skip: !fs.existsSync(realAsar) && "no sandbox app" }, () => {
  const { json, headerSize } = asar.readHeader(realAsar);
  const head = Buffer.alloc(8 + headerSize);
  const fd = fs.openSync(realAsar, "r");
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  assert.deepEqual(asar.serializeHeader(json), head);
});

test("agent-instructions keeps the text exact and appends the file", () => {
  const dir = tmp();
  const original = evalConst(FIXTURE);
  const [none] = modCopy(path.join(dir, "none"));
  assert.equal(evalConst(P.applyPatch(none, FIXTURE).text), original);
  const [empty] = modCopy(path.join(dir, "empty"), "  \n");
  assert.equal(evalConst(P.applyPatch(empty, FIXTURE).text), original);
  const [withText] = modCopy(path.join(dir, "text"), "## Local notes\n\n- use `x`, $1 and ${y}\n");
  const r = P.applyPatch(withText, FIXTURE);
  assert.ok(r.ok);
  assert.equal(evalConst(r.text), `${original}\n## Local notes\n\n- use \`x\`, $1 and \${y}\n`);
});

test("agent-instructions on the installed bundle's constant", { skip: !fs.existsSync(realAsar) && "no sandbox app" }, () => {
  const name = asar.listDir(realAsar, SP.DIST).find((n) => n.startsWith("binCli-"));
  const text = asar.readFile(realAsar, `${SP.DIST}/${name}`).toString("utf8");
  const start = text.indexOf("const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `");
  const end = text.indexOf("\n`;\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  const decl = text.slice(start, end);
  const original = evalConst(decl);
  assert.match(original, /## T3 Code orchestration/);
  const [patch] = modCopy(path.join(tmp(), "real"), "MARKER-real-7");
  assert.equal(evalConst(P.applyPatch(patch, decl).text), `${original}\nMARKER-real-7\n`);
  const report = SP.check([patch], [{ name, text }]);
  assert.equal(report.results[0].status, "ok");
});

test("a baked chunk reports baked and is not patched twice", () => {
  const dir = tmp();
  const patches = modCopy(path.join(dir, "mod"), "BAKED-1");
  const file = path.join(dir, "s.asar");
  buildAsar(file, { [`${SP.DIST}/binCli-a.mjs`]: `${FIXTURE}\nexport default T3_CODE_ORCHESTRATION_INSTRUCTIONS;\n`, [`${SP.DIST}/bin.mjs`]: "#!/usr/bin/env node\nimport './binCli-a.mjs';\n" });
  const { result, changes } = SP.bakeAsar(file, patches);
  assert.deepEqual(Object.keys(changes), ["binCli-a.mjs"]);
  const baked = changes["binCli-a.mjs"].toString("utf8");
  assert.deepEqual([...SP.bakedKeys(baked)], ["agent-instructions/orchestration-text"]);
  assert.equal(result.results[0].status, "ok");
  const again = SP.check(patches, [{ name: "binCli-a.mjs", text: baked }]);
  assert.equal(again.results[0].status, "baked");
  assert.equal(again.health.get("agent-instructions").status, "ok");
  assert.equal(SP.patchChunk(patches, new Set(patches.map((p) => p.key)), baked), baked);
  assert.equal(SP.markText("#!/usr/bin/env node\nx", ["k"]), `#!/usr/bin/env node\n${SP.MARKER}["k"]*/\nx`);
});

// The backend loads through the loader's --require; the hook must patch the chunk it imports.
function runBackend(mods) {
  const dir = path.join(mods, "..");
  const dist = path.join(dir, "apps", "server", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "binCli-t.mjs"), `${FIXTURE}\nexport default T3_CODE_ORCHESTRATION_INSTRUCTIONS;\n`);
  fs.writeFileSync(path.join(dist, "bin.mjs"), "import text from './binCli-t.mjs';\nprocess.stdout.write('\\nRESULT:' + JSON.stringify(text));\n");
  return spawnSync(process.execPath, ["--require", loader, path.join(dist, "bin.mjs")], { env: { ...process.env, T3MODS_DIR: mods }, encoding: "utf8", timeout: 20_000 });
}

// A backend-like process must exit on its own: a watcher that keeps the loop alive (Linux, Node 24) shows up as a timeout.
const result = (r) => JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("RESULT:") + 7));

test("the loader's hook patches backend chunks as they load", () => {
  const dir = tmp();
  const mods = path.join(dir, "mods");
  modCopy(path.join(mods, "agent-instructions"), "HOOK-MARKER-42");
  const r = runBackend(mods);
  assert.equal(r.status, 0, r.stderr);
  const text = result(r);
  assert.equal(text, `${evalConst(FIXTURE)}\nHOOK-MARKER-42\n`);
});

test("a server patch that does not match leaves the backend running unpatched", () => {
  const dir = tmp();
  const mods = path.join(dir, "mods");
  fs.mkdirSync(path.join(mods, "broken"), { recursive: true });
  fs.writeFileSync(path.join(mods, "broken", "mod.json"), JSON.stringify({ id: "broken" }));
  fs.writeFileSync(path.join(mods, "broken", "server-patches.cjs"), 'module.exports = [{ find: "T3_CODE_ORCHESTRATION_INSTRUCTIONS", replace: [{ match: /no such text/, replace: "x" }] }];');
  const r = runBackend(mods);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result(r), evalConst(FIXTURE));
  assert.match(r.stdout + r.stderr, /server patches off for broken/);
});
