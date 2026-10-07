// React without a build step: "react" resolves to the app's own React (same instance, so
// hooks work). The component renders in the sidebar footer slot; its state resets on hot reload.
import { createElement as h, useState } from "react";

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  function Counter() {
    const [n, setN] = useState(0);
    const Button = api.ui.Button ?? "button";
    return h(Button, { variant: "ghost", size: "xs", onClick: () => setN(n + 1) }, `Clicked ${n}`);
  }
  api.slot("sidebar-footer", Counter);
};
