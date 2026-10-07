import { useEffect, useState } from "react";
import type { RendererApi } from "../../../loader/types/t3mods";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="text-xs text-muted-foreground tabular-nums">{now.toLocaleTimeString()}</span>;
}

export default (api: RendererApi) => {
  api.slot("sidebar-footer", Clock);
};
