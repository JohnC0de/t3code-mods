// preview-gpu: the preview browser's launch args trade --disable-gpu for D3D11 on Windows only.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../loader/patcher.cjs");

const [patch, htmlPatch] = P.normalize("preview-gpu", require(path.join(__dirname, "..", "mods", "preview-gpu", "server-patches.cjs")));
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

const HTML_FIXTURE = `const argv = [
		"--headless=new",
		"--remote-debugging-pipe",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--hide-scrollbars",
		"--block-new-web-contents"
	];`;

test("the html_preview renderer gets the same flag per platform", () => {
  const r = P.applyPatch(htmlPatch, HTML_FIXTURE);
  assert.equal(r.ok, true, r.error);
  const argv = (platform) => [...vm.runInNewContext(`${r.text}
argv`, { process: { platform } })];
  assert.deepEqual(argv("win32").slice(3, 6), ["--no-default-browser-check", "--use-angle=d3d11", "--hide-scrollbars"]);
  assert.ok(argv("linux").includes("--disable-gpu"));
  assert.ok(!argv("win32").includes("--disable-gpu"));
});
