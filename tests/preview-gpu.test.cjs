// preview-gpu: the preview browser's launch args trade --disable-gpu for D3D11 on Windows only.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../loader/patcher.cjs");

const [patch] = P.normalize("preview-gpu", require(path.join(__dirname, "..", "mods", "preview-gpu", "server-patches.cjs")));
const FIXTURE = `const options = {
			executablePath,
			env,
			args: ["--disable-gpu", "--force-device-scale-factor=2"],
			headless: true
		};`;

const argsOn = (platform) => {
  const r = P.applyPatch(patch, FIXTURE);
  assert.equal(r.ok, true, r.error);
  const code = r.text;
  return vm.runInNewContext(`${code}\noptions.args`, { process: { platform }, executablePath: "x", env: {} });
};

test("Windows draws on the GPU and keeps the 2x scale", () => {
  assert.deepEqual([...argsOn("win32")], ["--use-angle=d3d11", "--force-device-scale-factor=2"]);
});

test("other platforms keep --disable-gpu", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual([...argsOn(platform)], ["--disable-gpu", "--force-device-scale-factor=2"]);
  }
});

test("a build whose args changed fails the patch instead of half-applying", () => {
  const changed = FIXTURE.replace('"--disable-gpu", ', "");
  const r = P.applyPatch(patch, changed);
  assert.equal(r.ok, false);
  assert.equal(r.text, changed);
});
