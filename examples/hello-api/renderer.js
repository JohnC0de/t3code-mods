// Example mod: state cells, a settings toggle, a palette command and api.server().

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  const enabled = api.state.boolean("showInTitle", true);
  const calls = api.state.number("calls", 0, { min: 0 });
  api.settings.toggle({ title: "Show the answer in the window title", value: enabled });

  /** @type {import("../../loader/types/t3mods").Remote<ReturnType<typeof import("./server.cjs")>>} */
  const server = api.server();

  api.command({
    id: "ask",
    title: "Hello API: ask the backend",
    searchTerms: ["hello", "server"],
    run: async () => {
      calls.set((n) => n + 1);
      const info = await server.info(calls.get());
      api.log("backend answered", info);
      if (enabled.get()) document.title = `Hello #${info.call} from backend pid ${info.pid}`;
    },
  });
};
