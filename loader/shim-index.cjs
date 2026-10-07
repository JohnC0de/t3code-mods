// resources/app/index.cjs: the Vencord-style shim. Electron loads resources/app when app.asar
// is missing; this loads the mod loader from the user's kit, then hands control to the
// renamed original bundle. On Linux this file is root-owned and shared by all users: each
// user's app loads that user's own kit, as that user.
const path = require("node:path");
const os = require("node:os");
const { app } = require("electron");
const asar = path.join(process.resourcesPath, "_app.asar");
const pkg = require(path.join(asar, "package.json"));
const kit = process.env.T3MODS_HOME || path.join(os.homedir(), ".t3", "t3mods");
try {
  require(process.env.T3MODS_LOADER || path.join(kit, "t3mods-loader.cjs"));
} catch (e) {
  console.error("[t3mods] loader failed, starting unmodded", e);
}
app.setAppPath(asar);
app.setVersion(pkg.version);
require.main.filename = path.join(asar, pkg.main);
require(path.join(asar, pkg.main));
