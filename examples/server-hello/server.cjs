// Server tier: runs inside the T3 Code backend process (Node). It adds a header to every
// HTTP response, so the effect shows from outside. The returned function undoes it on unload.
const http = require("node:http");

/** @type {import("../../loader/types/t3mods").ServerEntry} */
module.exports = () => {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, res) {
    if (event === "request") res.setHeader("x-t3mods", "server-hello");
    return emit.apply(this, arguments);
  };
  return () => {
    http.Server.prototype.emit = emit;
  };
};
