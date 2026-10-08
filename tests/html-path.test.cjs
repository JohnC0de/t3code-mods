// html-path: html_preview and html_render read the page from `path`. readHtmlInput on real files,
// the patches on T3's code shape (run with stand-ins for Effect and Schema), and on a real bundle.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const asar = require("../loader/asar.cjs");
const P = require("../loader/patcher.cjs");
const SP = require("../loader/server-patches.cjs");
const { readHtmlInput } = require("../mods/html-path/html-path.cjs");

const root = path.join(__dirname, "..");
const patches = () => P.normalize("html-path", require("../mods/html-path/server-patches.cjs"));
const realAsar = path.join(root, "sandbox", "app", "resources", "server.asar");
const win = process.platform === "win32";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-hp-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name, text) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const sys = (over = {}) => ({ fs, path, os, url, platform: process.platform, ...over });
const read = (input, over) => readHtmlInput(input, sys(over));
// Objects made inside a vm context have its prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("path becomes html: the file's text without a BOM, other fields kept, path dropped", () => {
  const p = file("page.html", "﻿<!doctype html><p>é</p>");
  assert.deepEqual(read({ path: p, title: "T", height: 400 }), { input: { title: "T", height: 400, html: "<!doctype html><p>é</p>" } });
  assert.deepEqual(read({ path: `  ${p}  ` }).input.html, "<!doctype html><p>é</p>");
  assert.deepEqual(read({ path: file("b.HTM", "<b>x</b>") }).input, { html: "<b>x</b>" });
});

test("html alone passes through; neither or both is an error", () => {
  assert.deepEqual(read({ html: "<p>x</p>", title: "T" }), { input: { html: "<p>x</p>", title: "T" } });
  assert.match(read({ title: "T" }).error, /Pass html .* or path/);
  assert.match(read({ html: "<p>x</p>", path: file("both.html", "<p>y</p>") }).error, /not both/);
});

test("~, file URLs and, on Windows, Git Bash drive paths reach the file", () => {
  const p = file("home/sub/h.html", "<i>home</i>");
  const home = { ...os, homedir: () => path.join(dir, "home") };
  assert.equal(read({ path: "~/sub/h.html" }, { os: home }).input.html, "<i>home</i>");
  assert.equal(read({ path: url.pathToFileURL(p).href }).input.html, "<i>home</i>");
  if (win) {
    const bash = `/${p[0].toLowerCase()}${p.slice(2).replaceAll("\\", "/")}`;
    assert.equal(read({ path: bash }).input.html, "<i>home</i>");
  }
});

test("relative, rootless and non-HTML paths are refused before any read", () => {
  assert.match(read({ path: "page.html" }).error, /must be absolute/);
  assert.match(read({ path: "./x/page.html" }).error, /must be absolute/);
  if (win) assert.match(read({ path: "/tmp/page.html" }).error, /must be absolute/);
  assert.match(read({ path: file("notes.md", "# x") }).error, /must name an \.html or \.htm file/);
  assert.match(read({ path: file("secret.html.txt", "k") }).error, /must name an \.html/);
});

test("a missing file, a folder, an empty file and a file over 25 MiB fail with their reason", () => {
  assert.match(read({ path: path.join(dir, "nope.html") }).error, /^No file at /);
  fs.mkdirSync(path.join(dir, "folder.html"));
  assert.match(read({ path: path.join(dir, "folder.html") }).error, /is not a file/);
  assert.match(read({ path: file("empty.html", " \n") }).error, /is empty/);
  const big = path.join(dir, "big.html");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 25 * 1024 * 1024 + 1);
  assert.match(read({ path: big }).error, /is 25\.0 MiB; the limit is 25\.0 MiB/);
  fs.truncateSync(big, 25 * 1024 * 1024);
  assert.equal(read({ path: big }).input.html.length, 25 * 1024 * 1024);
});

test("a .html link to another kind of file is refused", (t) => {
  const secret = file("secret.txt", "TOKEN");
  const link = path.join(dir, "innocent.html");
  try {
    fs.symlinkSync(secret, link, "file");
  } catch (e) {
    return t.skip(`no symlinks here: ${e.code}`);
  }
  const r = read({ path: link });
  assert.match(r.error, /links to .*secret\.txt, which is not an \.html/);
  assert.equal(r.input, undefined);
});

// T3's tools.ts and handlers.ts for the two tools, shortened; the anchors are verbatim.
const FIXTURE = `
const Html = String$7.check(isMinLength(1), isMaxLength(512e3)).annotate({ description: "A complete, self-contained HTML document." });
const HtmlPreviewTool = make$16("html_preview", {
	parameters: Struct({
		html: Html,
		width: optional$8(Int$6.annotate({ description: \`Viewport width in CSS pixels, 240-1600.\` }))
	})
});
const HtmlRenderTool = make$16(HTML_RENDER_TOOL_NAME, {
	parameters: Struct({
		html: Html,
		title: String$7
	}),
	success: Struct({ heights: optional$8(ArraySchema(Int$6)) })
});
const INVALID_PAGE_ERRORS = new Set(["HtmlRenderPageTooLargeError"]);
const toFailure = (error) => new OrchestratorMcpFailure({
	code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
	message: error.message
});
const handlers = {
	html_preview: readsAsCaller((input) => gen$1(function* () {
		const preview = yield* (yield* HtmlRender).preview(input).pipe(mapError(toFailure));
		return { preview };
	})),
	html_render: actsAsCaller((input) => gen$1(function* () {
		const scope = yield* McpInvocationContext;
		const { thread } = yield* requireThreadScope(scope, "html_render");
		return { htmlRender: yield* (yield* HtmlRender).publish({ threadId: thread.threadId, ...input }).pipe(mapError(toFailure)) };
	}))
};
({ HtmlPreviewTool, HtmlRenderTool, handlers, Html });
`;

// Effect and Schema stand-ins: an effect is a value you can yield*, a failure ends the run.
function sandbox() {
  const effect = (value) => ({ value, pipe() { return this; }, *[Symbol.iterator]() { return yield this; } });
  class OrchestratorMcpFailure {
    constructor(fields) { Object.assign(this, fields); }
    *[Symbol.iterator]() { return yield this; }
  }
  const schema = (kind) => ({ kind, check() { return this; }, annotate(a) { return { ...this, ...a }; } });
  const calls = [];
  const service = {
    preview: (input) => (calls.push(["preview", input]), effect({ width: 728 })),
    publish: (input) => (calls.push(["publish", input]), effect({ attachmentId: "a1" })),
  };
  const gen$1 = (body) => {
    const it = body();
    let step = it.next();
    while (!step.done) {
      if (step.value instanceof OrchestratorMcpFailure) return { failure: { ...step.value } };
      step = it.next(step.value.value);
    }
    return { value: step.value };
  };
  return {
    calls,
    context: {
      process, String$7: schema("string"), Int$6: schema("int"), isMinLength: () => 0, isMaxLength: () => 0,
      optional$8: (s) => ({ optional: s }), Struct: (fields) => ({ fields }), ArraySchema: (s) => ({ array: s }),
      make$16: (name, def) => ({ name, ...def }), HTML_RENDER_TOOL_NAME: "html_render",
      OrchestratorMcpFailure, readsAsCaller: (h) => h, actsAsCaller: (h) => h, gen$1, mapError: () => 0,
      HtmlRender: effect(service), McpInvocationContext: effect({ thread: { threadId: "t1" } }),
      requireThreadScope: (scope) => effect(scope),
    },
  };
}

function patchAll(text) {
  let out = text;
  for (const p of patches()) {
    const r = P.applyPatch(p, out);
    assert.ok(r.ok, `${p.key}: ${r.error ?? "no change"}`);
    out = r.text;
  }
  return out;
}

test("patched tools take an optional html and a path; the handlers read the file", () => {
  const { context, calls } = sandbox();
  const t = vm.runInNewContext(patchAll(FIXTURE), context);
  for (const tool of [t.HtmlPreviewTool, t.HtmlRenderTool]) {
    assert.equal(tool.parameters.fields.html.optional, t.Html);
    assert.match(tool.parameters.fields.path.optional.description, /absolute path of an \.html or \.htm file/);
  }
  assert.ok(t.HtmlPreviewTool.parameters.fields.width.optional, "other fields stay");

  const p = file("render.html", "<h1>from disk</h1>");
  assert.deepEqual(plain(t.handlers.html_render({ path: p, title: "T" }).value), { htmlRender: { attachmentId: "a1" } });
  assert.deepEqual(plain(calls.pop()), ["publish", { threadId: "t1", title: "T", html: "<h1>from disk</h1>" }]);
  t.handlers.html_preview({ path: p, width: 390 });
  assert.deepEqual(plain(calls.pop()), ["preview", { width: 390, html: "<h1>from disk</h1>" }]);
  t.handlers.html_render({ html: "<p>pasted</p>", title: "T" });
  assert.deepEqual(plain(calls.pop()), ["publish", { threadId: "t1", html: "<p>pasted</p>", title: "T" }]);

  for (const [name, input, reason] of [
    ["html_render", { title: "T" }, /Pass html/],
    ["html_preview", { path: "rel.html" }, /must be absolute/],
    ["html_render", { path: path.join(dir, "gone.html"), title: "T" }, /No file at/],
  ]) {
    const r = t.handlers[name](input);
    assert.equal(r.failure?.code, "invalid_request", `${name} ${JSON.stringify(input)}`);
    assert.match(r.failure.message, reason);
  }
  assert.equal(calls.length, 0, "no call reached T3's service after a failure");
});

test("the patches follow other minified names, $ included", () => {
  const renamed = FIXTURE.replace(/Html/g, "Html$$2").replaceAll("String$7", "String$1").replaceAll("optional$8", "optional$3").replaceAll("OrchestratorMcpFailure", "Failure$4").replaceAll("(input)", "(input$1)").replaceAll("...input", "...input$1").replaceAll("preview(input)", "preview(input$1)");
  const { context, calls } = sandbox();
  Object.assign(context, { String$1: context.String$7, optional$3: context.optional$8, Failure$4: context.OrchestratorMcpFailure });
  const t = vm.runInNewContext(patchAll(renamed), context);
  assert.ok(t.HtmlRenderTool.parameters.fields.path);
  t.handlers.html_render({ path: file("r2.html", "<p>2</p>"), title: "T" });
  assert.equal(calls.pop()[1].html, "<p>2</p>");
  assert.equal(t.handlers.html_render({ title: "T" }).failure.code, "invalid_request");
});

test("a changed shape fails the patch and leaves the code as it was", () => {
  const [schema, handlers] = patches();
  const third = FIXTURE.replace("const INVALID", "const Other = make$16(\"x\", { parameters: Struct({ html: Html, }) });\nconst INVALID");
  const r = P.applyPatch(schema, third);
  assert.equal(r.ok, false);
  assert.match(r.error, /3 matches, expected 2/);
  assert.equal(r.text, third);
  const noFailure = FIXTURE.replace('? "invalid_request"', '? "bad_request"');
  assert.equal(P.applyPatch(handlers, noFailure).ok, false);
});

test("on the sandbox app's bundle both patches apply and the chunk still parses", { skip: !fs.existsSync(realAsar) && "no sandbox app" }, () => {
  const name = asar.listDir(realAsar, SP.DIST).find((n) => n.startsWith("binCli-"));
  const text = asar.readFile(realAsar, `${SP.DIST}/${name}`).toString("utf8");
  const result = SP.check(patches(), [{ name, text }]);
  assert.deepEqual(result.results.map((r) => r.status), ["ok", "ok"]);
  const out = path.join(dir, "patched.mjs");
  fs.writeFileSync(out, SP.patchChunk(patches(), result.active, text));
  const check = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
