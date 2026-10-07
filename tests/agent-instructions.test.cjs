// agent-instructions: the baked tag adds instructions.md and, in a named app, instructions.<app>.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../loader/patcher.cjs");
const { appInfo } = require("../loader/platform.cjs");

const modSource = path.join(__dirname, "..", "mods", "agent-instructions", "server-patches.cjs");
const FIXTURE = "const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `\n## T3 Code orchestration\n\nUse \\`x\\`.\n`;";

// Runs the patched constant in a context whose process has the given env, like the backend.
function run(files, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-ai-"));
  fs.mkdirSync(path.join(dir, "mod"));
  fs.copyFileSync(modSource, path.join(dir, "mod", "server-patches.cjs"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, "mod", name), text);
  const [patch] = P.normalize("agent-instructions", require(path.join(dir, "mod", "server-patches.cjs")));
  delete require.cache[require.resolve(path.join(dir, "mod", "server-patches.cjs"))];
  const code = P.applyPatch(patch, FIXTURE).text;
  const fake = { env: { ...env }, platform: process.platform, getBuiltinModule: (m) => process.getBuiltinModule(m) };
  const base = vm.runInNewContext(`${FIXTURE}\nT3_CODE_ORCHESTRATION_INSTRUCTIONS`, { process: fake });
  const out = vm.runInNewContext(`${code}\nT3_CODE_ORCHESTRATION_INSTRUCTIONS`, { process: fake });
  fs.rmSync(dir, { recursive: true, force: true });
  return { base, out };
}

const FILES = { "instructions.md": "ALL", "instructions.work.md": "WORK-ONLY" };
const home = (name) => path.join(os.homedir(), name);

test("a named app appends its own file after instructions.md", () => {
  const { base, out } = run(FILES, { T3CODE_HOME: home(".t3-work") });
  assert.equal(out, `${base}\nALL\n\nWORK-ONLY\n`);
});

test("T3MODS_APP_NAME picks the file, in any case, and wins over the folder", () => {
  assert.match(run(FILES, { T3MODS_APP_NAME: "Work" }).out, /WORK-ONLY/);
  assert.doesNotMatch(run(FILES, { T3MODS_APP_NAME: "Beta", T3CODE_HOME: home(".t3-work") }).out, /WORK-ONLY/);
});

test("the default app and other apps read only instructions.md", () => {
  for (const env of [{}, { T3CODE_HOME: home(".t3") }, { T3CODE_HOME: home(".t3-play") }]) {
    const { base, out } = run(FILES, env);
    assert.equal(out, `${base}\nALL\n`);
  }
});

test("a missing instructions.md does not hide the app file; no files leave the text unchanged", () => {
  const only = run({ "instructions.work.md": "WORK-ONLY" }, { T3MODS_APP_NAME: "Work" });
  assert.equal(only.out, `${only.base}\nWORK-ONLY\n`);
  const none = run({}, { T3MODS_APP_NAME: "Work" });
  assert.equal(none.out, none.base);
});

test("an app name cannot reach outside the mod folder", () => {
  const { base, out } = run({ "instructions.md": "ALL" }, { T3MODS_APP_NAME: "../../x" });
  assert.equal(out, `${base}\nALL\n`);
});

test("the backend derives the same name as the loader", () => {
  for (const [env, expected] of [
    [{ T3CODE_HOME: home(".t3-work") }, "work"],
    [{ T3CODE_HOME: home("t3code-dev") }, "dev"],
    [{ T3MODS_APP_NAME: " Job " }, "job"],
    [{}, null],
  ]) {
    const name = appInfo(env, os.homedir()).name?.toLowerCase() ?? null;
    assert.equal(name, expected);
    const { base, out } = run({ "instructions.md": "ALL", ...(expected && { [`instructions.${expected}.md`]: "NAMED" }) }, env);
    assert.equal(out, expected ? `${base}\nALL\n\nNAMED\n` : `${base}\nALL\n`);
  }
});
