// Writes a small .asar archive from { "dir/file": contents }.
const fs = require("node:fs");
const asar = require("../../loader/asar.cjs");

// Electron's fs (a test run on T3 Code's own Electron in Node mode, as tools/linux-test.sh does)
// opens a .asar path as an archive; original-fs writes the bytes.
const rawFs = process.versions.electron ? require("original-fs") : fs;

function buildAsar(file, files) {
  const header = { files: {} };
  let offset = 0;
  const bufs = [];
  for (const [rel, data] of Object.entries(files)) {
    const buf = Buffer.from(data);
    const parts = rel.split("/");
    let node = header;
    for (const p of parts.slice(0, -1)) node = node.files[p] ??= { files: {} };
    node.files[parts.at(-1)] = { size: buf.length, offset: String(offset), integrity: asar.integrity(buf) };
    offset += buf.length;
    bufs.push(buf);
  }
  rawFs.writeFileSync(file, Buffer.concat([asar.serializeHeader(JSON.stringify(header)), ...bufs]));
}

module.exports = { buildAsar, rawFs };
