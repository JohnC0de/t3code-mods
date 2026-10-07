// The full e2e run, registry steps included, in one command:
//   node tools/e2e-registry.mjs [--mods <dir>] [--app <T3 Code folder>] [--cdp 9333] [--registry-port 4873]
// It starts the fake registry (tests/helpers/fake-registry.cjs) on 127.0.0.1, an isolated dev
// instance with T3MODS_REGISTRY and T3MODS_TEST_CONFIRM=install set, runs tools/e2e.mjs against
// them, and stops both. The registry URL must be exactly http://127.0.0.1:<port>: the download
// origin check and the e2e source check both compare it as written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const root = path.resolve(import.meta.dirname, "..");
const cdp = opt("--cdp", "9333");
const modsDir = path.resolve(opt("--mods", "mods"));
const app = opt("--app");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "t3mods-e2e-"));
const { createFakeRegistry } = createRequire(import.meta.url)("../tests/helpers/fake-registry.cjs");

const registry = await createFakeRegistry({ port: Number(opt("--registry-port", "4873")) });
registry.addVersion("e2e-reg-demo", "1.0.0", { "style.css": "body{--e2e-reg:1}" }, { manifest: { name: "Registry demo", description: "A CSS mod from the fake registry" } });
registry.addVersion("e2e-reg-server", "1.0.0", { "server.cjs": "module.exports = () => {};" }, { manifest: { name: "Registry server demo", description: "Runs in the backend" } });

const dev = ["loader/t3mods.mjs", "dev", "--isolated", "--mods", modsDir, "--cdp", cdp, "--profile", profile, ...(app ? ["--app", app] : [])];
const child = spawn(process.execPath, dev, { cwd: root, env: { ...process.env, T3MODS_REGISTRY: registry.url, T3MODS_TEST_CONFIRM: "install" }, stdio: "ignore" });

// The dev command starts the app as its own child, so stop the whole tree.
const stop = () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};
let code = 1;
try {
  const end = Date.now() + 90_000;
  let ready = false;
  while (!ready && Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      ready = list.some((t) => t.type === "page" && t.url.startsWith("t3code://app"));
    } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error(`the instance did not open a page on CDP port ${cdp} within 90 s`);
  await new Promise((r) => setTimeout(r, 4000)); // the mod runtime boots after the page loads
  const exe = app && fs.readdirSync(app).find((f) => /^T3 Code.*\.exe$|^t3code$/i.test(f));
  // Async: the fake registry lives in this process, and a blocking spawn would starve it.
  const run = await new Promise((resolve) => spawn(process.execPath, ["tools/e2e.mjs", "--port", cdp, "--mods", modsDir, "--registry", registry.url, "--profile", profile, ...(exe ? ["--exe", path.join(app, exe)] : [])], { cwd: root, stdio: "inherit" }).on("exit", (c) => resolve({ status: c })));
  code = run.status ?? 1;
} catch (e) {
  console.error(`e2e-registry: ${e.message}`);
} finally {
  stop();
  await registry.close();
  // On Windows the killed app can hold its profile files for some seconds. A leftover temp
  // folder is not a test result, so it only warns.
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    console.warn(`e2e-registry: could not remove ${profile}: ${e.code}`);
  }
}
process.exit(code);
