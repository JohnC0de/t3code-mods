// Bundlers in dev mode emit jsxDEV; the app ships production React, so map it onto jsx.
while (!globalThis.__clerkSharedModules) await new Promise((r) => setTimeout(r, 16));
const { jsx, Fragment } = globalThis.__clerkSharedModules["react/jsx-runtime"];
export const jsxDEV = (type, props, key) => jsx(type, props, key);
export { Fragment };
