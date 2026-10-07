// Test mod for tools/linux/scenario.sh: does what electron-updater's AppImageUpdater does at
// the end of an update (start the new AppImage with APPIMAGE_SILENT_INSTALL, then quit), so
// the test runs the loader's real spawn hook. It records what was actually started in
// /tmp/e2e-update.json, because the app quits right after.
module.exports = ({ electron }) => ({
  update(file, args = []) {
    const child = require("node:child_process").spawn(file, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, APPIMAGE_SILENT_INSTALL: "true" },
    });
    child.unref();
    require("node:fs").writeFileSync("/tmp/e2e-update.json", JSON.stringify({ spawned: child.spawnfile }));
    setTimeout(() => electron.app.quit(), 1000);
    return { spawned: child.spawnfile };
  },
});
