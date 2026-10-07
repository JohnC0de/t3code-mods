// Runs in the T3 Code backend process. The returned methods are what api.server() calls.

/** @type {import("../../loader/types/t3mods").ServerEntry} */
module.exports = (ctx) => ({
  info(call) {
    return { call, pid: process.pid, node: process.version, mod: ctx.id };
  },
});
