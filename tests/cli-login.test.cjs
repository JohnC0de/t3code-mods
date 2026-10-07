// `t3mods login` as an agent runs it: no TTY and a stdin pipe that stays open.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const cli = path.join(__dirname, "..", "loader", "t3mods.mjs");

function runLogin(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-login-"));
  const env = { ...process.env, T3MODS_DIR: path.join(dir, "mods"), T3MODS_TOKEN_FILE: path.join(dir, "token.json") };
  delete env.T3MODS_TOKEN;
  const child = spawn(process.execPath, [cli, "login"], { env, stdio: ["pipe", "pipe", "pipe"] });
  if (input !== undefined) child.stdin.write(input); // the pipe stays open either way
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const t0 = Date.now();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill(), 15000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      child.stdin.destroy();
      resolve({ code, err, ms: Date.now() - t0, saved: fs.existsSync(path.join(dir, "token.json")) });
    });
  });
}

test("login with an open, empty stdin fails fast instead of waiting for EOF", async () => {
  const r = await runLogin();
  assert.equal(r.code, 1);
  assert.match(r.err, /no token/);
  assert.ok(r.ms < 10000, `took ${r.ms} ms`);
  assert.equal(r.saved, false);
});

test("login reads one line from an open stdin", async () => {
  const r = await runLogin("not-a-token\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /not a registry token/);
  assert.ok(r.ms < 10000, `took ${r.ms} ms`);
});
