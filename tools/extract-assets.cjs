// Copies the installed build's client chunks (<out-dir>/*.js) and backend chunks (<out-dir>/server/*.mjs)
// out of server.asar, for patch work with
// `t3mods doctor --assets <dir>` (e.g. after an update breaks a patch). Plain Node cannot
// read .asar, so run it on the app's own exe:
//   ELECTRON_RUN_AS_NODE=1 "<app>/T3 Code (Nightly).exe" tools/extract-assets.cjs <out-dir> [app-dir]
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const out = process.argv[2];
if (!out) throw new Error("usage: extract-assets.cjs <out-dir> [app-dir]");
const app = process.argv[3] ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "t3code");
const src = path.join(app, "resources", "server.asar", "apps", "server", "dist", "client", "assets");
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith(".js"));
for (const f of files) fs.writeFileSync(path.join(out, f), fs.readFileSync(path.join(src, f)));
const dist = path.dirname(path.dirname(src));
const serverOut = path.join(out, "server");
fs.mkdirSync(serverOut, { recursive: true });
const serverFiles = fs.readdirSync(dist).filter((f) => f.endsWith(".mjs"));
for (const f of serverFiles) fs.writeFileSync(path.join(serverOut, f), fs.readFileSync(path.join(dist, f)));
console.log(`${files.length} client chunks -> ${out}, ${serverFiles.length} backend chunks -> ${serverOut}`);
