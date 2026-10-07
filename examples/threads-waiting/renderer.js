// Example mod: api.threads. A sidebar button counts the threads that wait for an answer or
// an approval; a click opens the oldest one.
import { createElement as h } from "react";

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  api.slot("sidebar-footer", function Waiting() {
    const waiting = api.threads
      .useList()
      .filter((t) => !t.archived && !t.subagent && (t.status === "input" || t.status === "approval"))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (!waiting.length) return null;
    const label = `${waiting.length} waiting for you`;
    return h("button", { title: label, "aria-label": label, onClick: () => api.threads.open(waiting[0].ref) }, String(waiting.length));
  });
};
