// Options for style.css: each one sets a data attribute on <html> while it is on.

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  const options = [
    { key: "hideThinking", attr: "data-t3mod-ct-hide-thinking", title: "Hide thinking rows", description: "Hide thinking lines between tool calls; inside a tool list they fade." },
    { key: "noIcons", attr: "data-t3mod-ct-no-icons", title: "Hide tool icons", description: "Text only, aligned to the left." },
  ];
  for (const { key, attr, title, description } of options) {
    const cell = api.state.boolean(key, false);
    api.settings.toggle({ title, description, value: cell });
    cell.effect((on) => {
      if (!on) return;
      document.documentElement.setAttribute(attr, "");
      return () => document.documentElement.removeAttribute(attr);
    });
  }
};
