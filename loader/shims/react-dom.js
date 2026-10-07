// Mods may be imported before the app has evaluated React; wait for the shared instance.
while (!globalThis.__clerkSharedModules) await new Promise((r) => setTimeout(r, 16));
const m = globalThis.__clerkSharedModules["react-dom"];
export default m;
export const { createPortal, flushSync } = m;
