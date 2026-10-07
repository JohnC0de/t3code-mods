// A command in the app's command palette. The id gets the mod id as a prefix automatically.

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  api.command({
    id: "hello",
    title: "Example: say hello",
    searchTerms: ["example", "hello"],
    run: () => api.log("hello from the palette"),
  });
};
