// Plain DOM, no React: add an element and remove it on unload (disable or hot reload).

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  const el = document.createElement("div");
  el.className = "t3mod-badge";
  el.textContent = "mods on";
  document.body.append(el);
  api.lifecycle.own(() => el.remove());
  api.css(".t3mod-badge{position:fixed;right:12px;bottom:12px;z-index:50;padding:2px 8px;border-radius:6px;background:#4f46e5;color:#fff;font:12px system-ui}");
};
