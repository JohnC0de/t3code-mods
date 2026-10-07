// examples/tsx-demo/src/index.tsx
import { useEffect, useState } from "react";
import { jsxDEV } from "react/jsx-dev-runtime";
function Clock() {
  const [now, setNow] = useState(() => new Date);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date), 1000);
    return () => clearInterval(t);
  }, []);
  return /* @__PURE__ */ jsxDEV("span", {
    className: "text-xs text-muted-foreground tabular-nums",
    children: now.toLocaleTimeString()
  }, undefined, false, undefined, this);
}
var src_default = (api) => {
  api.slot("sidebar-footer", Clock);
};
export {
  src_default as default
};
