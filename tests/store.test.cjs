const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-test-"));
process.env.T3MODS_DIR = dir;
const store = require("../loader/store.cjs");
const { readZip, writeZip } = require("../loader/zip.cjs");

const file = (name, text) => ({ name, data: Buffer.from(text) });
const manifest = (id, extra = {}) => file("mod.json", JSON.stringify({ id, name: id, ...extra }));

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("zip round trip, including a deflated entry", () => {
  const files = [file("a.txt", "hello"), file("dir/b.txt", "world")];
  assert.deepEqual(readZip(writeZip(files)).map((f) => [f.name, String(f.data)]), [["a.txt", "hello"], ["dir/b.txt", "world"]]);
  // Turn the first entry into a deflated one by hand.
  const data = Buffer.from("deflated text ".repeat(20));
  const zipped = writeZip([{ name: "c.txt", data }]);
  const comp = zlib.deflateRawSync(data);
  const local = Buffer.from(zipped.subarray(0, 30));
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  const name = Buffer.from("c.txt");
  const central = Buffer.from(zipped.subarray(30 + name.length + data.length, 30 + name.length + data.length + 46));
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  const end = Buffer.from(zipped.subarray(zipped.length - 22));
  end.writeUInt32LE(30 + name.length + comp.length, 16);
  const rebuilt = Buffer.concat([local, name, comp, central, name, end]);
  assert.equal(String(readZip(rebuilt)[0].data), String(data));
});

test("install, list, disable, enable, uninstall", () => {
  const r = store.installArchive(writeZip([manifest("demo", { version: "1.0.0" }), file("style.css", "a{}")]), "test");
  assert.equal(r.id, "demo");
  assert.equal(r.replaced, false);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  let mod = store.listMods().find((m) => m.id === "demo");
  assert.equal(mod.enabled, true);
  assert.equal(mod.files.css, true);
  assert.equal(store.reloadLevel(mod), "hot");

  store.setEnabled("demo", false);
  assert.equal(store.listMods().find((m) => m.id === "demo").enabled, false);
  store.setEnabled("demo", true);
  assert.equal(store.listMods().find((m) => m.id === "demo").enabled, true);

  assert.equal(store.installArchive(writeZip([manifest("demo"), file("patches.cjs", "module.exports=[]")])).replaced, true);
  mod = store.listMods().find((m) => m.id === "demo");
  assert.equal(mod.files.css, false, "replacing removes old files");
  assert.equal(store.reloadLevel(mod), "reload");

  store.uninstall("demo");
  assert.equal(store.listMods().some((m) => m.id === "demo"), false);
});

test("archives with one top folder (GitHub zips) install", () => {
  const r = store.installArchive(writeZip([file("repo-main/mod.json", JSON.stringify({ id: "nested" })), file("repo-main/style.css", "")]));
  assert.equal(r.id, "nested");
  assert.ok(fs.existsSync(path.join(dir, "nested", "style.css")));
});

test("unsafe archives are refused", () => {
  assert.throws(() => store.installArchive(writeZip([manifest("evil"), file("../x.js", "")])), /unsafe path/);
  assert.throws(() => store.installArchive(writeZip([manifest("evil"), file("C:/x.js", "")])), /unsafe path/);
  assert.throws(() => store.installArchive(writeZip([manifest("../evil")])), /id/);
  assert.throws(() => store.installArchive(writeZip([file("style.css", "")])), /no mod.json/);
  assert.throws(() => store.installArchive(writeZip([manifest("core")])), /built-in/);
});

test("a leading underscore disables a mod; enabling renames it", () => {
  fs.mkdirSync(path.join(dir, "_old"));
  assert.equal(store.listMods().find((m) => m.id === "old").enabled, false);
  store.setEnabled("old", true);
  assert.ok(fs.existsSync(path.join(dir, "old")));
});

test("builtins cannot be disabled or removed", () => {
  assert.throws(() => store.setEnabled("core", false), /built in/);
  assert.throws(() => store.uninstall("manager"), /built in/);
});

test("state round trip and size limit", () => {
  store.writeState("demo2", { a: 1 });
  assert.deepEqual(store.readState("demo2"), { a: 1 });
  assert.throws(() => store.writeState("demo2", { big: "x".repeat(300 * 1024) }), /too large/);
});

test("an archive cannot hide a tier file in another case or a doubled name", () => {
  assert.throws(() => store.inspectArchive(writeZip([manifest("sneaky"), file("style.css", ""), file("MAIN.CJS", "")])), /wrong case/);
  assert.throws(() => store.inspectArchive(writeZip([manifest("sneaky"), file("renderer.js", "a"), file("RENDERER.JS", "b")])), /differ only in case/);
  assert.throws(() => store.inspectArchive(writeZip([manifest("sneaky"), file("main.cjs.", "")])), /ends in/);
  assert.throws(() => store.inspectArchive(writeZip([manifest("sneaky"), file("server.cjs ", "")])), /ends in/);
  assert.deepEqual(store.archiveTiers(store.inspectArchive(writeZip([manifest("fine"), file("style.css", ""), file("main.cjs", "")])).files), ["css", "main"]);
});

test("describe sees tier files by exact name, whatever the file system does with case", () => {
  const mod = path.join(dir, "casey");
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, "mod.json"), JSON.stringify({ id: "casey" }));
  fs.writeFileSync(path.join(mod, "MAIN.CJS"), "throw new Error('payload')");
  assert.equal(store.listMods().find((m) => m.id === "casey").files.main, false);
});

test("a registry-style install never replaces a local mod it does not know, in any case", () => {
  const local = path.join(dir, "Mine");
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "mod.json"), JSON.stringify({ id: "Mine" }));
  fs.writeFileSync(path.join(local, "my-work.js"), "work");
  assert.throws(() => store.installArchive(writeZip([manifest("mine")]), "registry:mine@1.0.0"), /exists|not installed by t3mods/);
  assert.equal(fs.readFileSync(path.join(local, "my-work.js"), "utf8"), "work");
  // Same case, but no record of a source: a hand-made folder is not replaced either.
  const same = path.join(dir, "handmade");
  fs.mkdirSync(same, { recursive: true });
  fs.writeFileSync(path.join(same, "mod.json"), JSON.stringify({ id: "handmade" }));
  fs.writeFileSync(path.join(same, "notes.txt"), "keep");
  assert.throws(() => store.installArchive(writeZip([manifest("handmade")]), "registry:handmade@1.0.0"), /not installed by t3mods/);
  assert.equal(fs.readFileSync(path.join(same, "notes.txt"), "utf8"), "keep");
});

test("replacing an installed mod keeps the old folder in the trash", () => {
  store.installArchive(writeZip([manifest("swap"), file("old.txt", "old")]), "test");
  assert.equal(store.installArchive(writeZip([manifest("swap")]), "test").replaced, true);
  const trash = fs.readdirSync(path.join(store.META_DIR, "trash")).filter((n) => n.startsWith("swap-"));
  assert.equal(trash.length, 1);
  assert.equal(fs.readFileSync(path.join(store.META_DIR, "trash", trash[0], "old.txt"), "utf8"), "old");
});
