// Appends instructions.md, and instructions.<app>.md for a named app, to
// T3_CODE_ORCHESTRATION_INSTRUCTIONS, the text the backend gives every provider session that
// has the t3-code MCP tools. The template literal stays as it is; a tag in front of it
// rebuilds the same string and adds the files, so the patch needs only the start of the
// declaration as an anchor. The files are read once, when the backend loads; a missing or
// empty file adds nothing.
//
// The tag runs in the backend, which has no ctx.app. It derives the app name like the loader
// does (appInfo in loader/platform.cjs): T3MODS_APP_NAME, else the T3CODE_HOME folder (".t3"
// is the nameless default app, ".t3-work" is "Work"). Keep the two in step. The file name uses the lower case name, e.g. instructions.work.md.
const dir = JSON.stringify(__dirname);
const tag = `((s, ...v) => {
  let t = s[0];
  for (let i = 0; i < v.length; i++) t += v[i] + s[i + 1];
  const get = (m) => process.getBuiltinModule(m);
  const app = () => {
    const env = process.env.T3MODS_APP_NAME?.trim();
    if (env) return env;
    const p = get("node:path");
    const fold = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
    const home = p.resolve(process.env.T3CODE_HOME || p.join(get("node:os").homedir(), ".t3"));
    if (fold(home) === fold(p.join(get("node:os").homedir(), ".t3"))) return null;
    const base = p.basename(home).replace(/^\\.+/, "");
    const word = base.replace(/^t3(code)?-/i, "") || base;
    return word ? word[0].toUpperCase() + word.slice(1) : null;
  };
  const read = (file) => {
    try {
      const extra = get("node:fs").readFileSync(get("node:path").join(${dir}, file), "utf8").trim();
      if (extra) t += "\\n" + extra + "\\n";
    } catch {}
  };
  read("instructions.md");
  const name = app()?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (name) read("instructions." + name + ".md");
  return t;
})`;

/** @type {import("../../loader/types/t3mods").ServerPatch[]} */
module.exports = [
  {
    id: "orchestration-text",
    find: "const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `",
    replace: [{ match: /const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `/, replace: () => `const T3_CODE_ORCHESTRATION_INSTRUCTIONS = ${tag}\`` }],
  },
];
