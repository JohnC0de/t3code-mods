// Appends instructions.md to T3_CODE_ORCHESTRATION_INSTRUCTIONS, the text the backend gives
// every provider session that has the t3-code MCP tools. The template literal stays as it
// is; a tag in front of it rebuilds the same string and adds the file, so the patch needs
// only the start of the declaration as an anchor. The file is read once, when the backend
// loads; a missing or empty file leaves the text unchanged.
const path = require("node:path");

const file = JSON.stringify(path.join(__dirname, "instructions.md"));
const tag = `((s, ...v) => {
  let t = s[0];
  for (let i = 0; i < v.length; i++) t += v[i] + s[i + 1];
  try {
    const extra = process.getBuiltinModule("node:fs").readFileSync(${file}, "utf8").trim();
    if (extra) t += "\\n" + extra + "\\n";
  } catch {}
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
