// Text patches on the app's bundled code. `find` selects one chunk; `match` edits it.
// Run `t3mods doctor` to see whether each patch still applies to the installed build.

/** @type {import("../../loader/types/t3mods").Patch[]} */
module.exports = [
  { id: "title", find: "Connect your computers", replace: [{ match: /Connect your computers/, replace: "Connect your computers (patched by a mod)" }] },
  // Matches nothing on purpose: the doctor reports it, and `optional` lets the mod start anyway.
  { id: "missing-on-purpose", optional: true, find: "this string is not in any chunk", replace: [{ match: /x/, replace: "y" }] },
];
