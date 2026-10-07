// Reads and rewrites Electron .asar archives with plain Node (Node alone cannot open them).
// Layout: an 8-byte pickle holding the header size, then the header pickle
// ([payload size][JSON length][JSON][padding to 4]), then the file data. Each file entry has
// an `offset` (a decimal string) relative to the end of the header, a `size`, and an
// `integrity` block. Rewriting appends the new file contents after the old data and moves
// only the changed entries, so every other byte of the data section stays where it was.
"use strict";

// Under Electron (the CLI re-runs itself on the app's exe), plain fs treats .asar files as
// folders; original-fs reads the archive bytes.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BLOCK_SIZE = 4 * 1024 * 1024;

function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonSize = headerBuf.readInt32LE(4);
    const json = headerBuf.subarray(8, 8 + jsonSize).toString("utf8");
    return { header: JSON.parse(json), json, headerSize, dataOffset: 8 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

// The same bytes that @electron/asar writes for a header string.
function serializeHeader(json) {
  const str = Buffer.from(json, "utf8");
  const payload = 4 + str.length;
  const padded = payload + ((4 - (payload % 4)) % 4);
  const headerBuf = Buffer.alloc(4 + padded);
  headerBuf.writeUInt32LE(padded, 0);
  headerBuf.writeInt32LE(str.length, 4);
  str.copy(headerBuf, 8);
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(headerBuf.length, 4);
  return Buffer.concat([sizeBuf, headerBuf]);
}

function entryOf(header, rel) {
  let node = header;
  for (const part of rel.split("/").filter(Boolean)) {
    node = node.files?.[part];
    if (!node) return null;
  }
  return node;
}

// Names of the files directly inside a folder of the archive.
function listDir(file, rel) {
  const dir = entryOf(readHeader(file).header, rel);
  if (!dir?.files) throw new Error(`${rel}: no such folder in ${file}`);
  return Object.keys(dir.files).filter((n) => !dir.files[n].files);
}

function readFile(file, rel) {
  const { header, dataOffset } = readHeader(file);
  const entry = entryOf(header, rel);
  if (!entry || entry.files) throw new Error(`${rel}: no such file in ${file}`);
  if (entry.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, ...rel.split("/")));
  const buf = Buffer.alloc(entry.size);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) blocks.push(crypto.createHash("sha256").update(buf.subarray(i, i + BLOCK_SIZE)).digest("hex"));
  return { algorithm: "SHA256", hash: crypto.createHash("sha256").update(buf).digest("hex"), blockSize: BLOCK_SIZE, blocks };
}

// Writes `out`: a copy of `file` with the files in `changes` ({ rel: Buffer }) replaced.
function writeWithChanges(file, out, changes) {
  const { header, dataOffset } = readHeader(file);
  const dataSize = fs.statSync(file).size - dataOffset;
  let end = dataSize;
  const appended = [];
  for (const [rel, buf] of Object.entries(changes)) {
    const entry = entryOf(header, rel);
    if (!entry || entry.files || entry.unpacked) throw new Error(`${rel}: not a packed file in ${file}`);
    entry.offset = String(end);
    entry.size = buf.length;
    entry.integrity = integrity(buf);
    appended.push(buf);
    end += buf.length;
  }
  const fdIn = fs.openSync(file, "r");
  const fdOut = fs.openSync(out, "w");
  try {
    fs.writeSync(fdOut, serializeHeader(JSON.stringify(header)));
    const chunk = Buffer.alloc(BLOCK_SIZE);
    for (let pos = 0; pos < dataSize; ) {
      const n = fs.readSync(fdIn, chunk, 0, Math.min(BLOCK_SIZE, dataSize - pos), dataOffset + pos);
      if (n === 0) throw new Error(`${file}: unexpected end of data`);
      fs.writeSync(fdOut, chunk, 0, n);
      pos += n;
    }
    for (const buf of appended) fs.writeSync(fdOut, buf);
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
}

module.exports = { readHeader, serializeHeader, entryOf, listDir, readFile, writeWithChanges, integrity };
