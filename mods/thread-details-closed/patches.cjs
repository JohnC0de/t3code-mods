// The thread details panel starts closed; a thread where you open it keeps it open.
// T3's right panel store keeps the panel's state per thread as { inlineOpen, popoverOpen },
// with "inline open" as the default. Four places in the store assume that default, so they
// flip together (group): if only some flipped, an opened panel would be pruned as "default"
// and close again at once.
const store = {
  id: "default-closed",
  find: "inlineOpen:!0,popoverOpen:!1",
  group: true,
  replace: [
    // The default for a thread without an entry.
    { match: /(\i)=\{inlineOpen:!0,popoverOpen:!1\}/, replace: "$1={inlineOpen:!1,popoverOpen:!1}" },
    // An entry equal to the default is dropped: now "both closed" instead of "inline open".
    { match: /if\((\i)\.inlineOpen&&!\1\.popoverOpen\)\{/, replace: "if(!$1.inlineOpen&&!$1.popoverOpen){" },
    // Saved to localStorage: the threads where the panel is open, not the ones where it is closed.
    {
      match: /(\i)\.inlineOpen\?\[\]:\[\[(\i),\{inlineOpen:!1,popoverOpen:!1\}\]\]/,
      replace: "$1.inlineOpen?[[$2,{inlineOpen:!0,popoverOpen:!1}]]:[]",
    },
    // Loaded from an older saved version: the same.
    {
      match: /(\i)\.inlineOpen===!1\?\[\[(\i),\{inlineOpen:!1,popoverOpen:!1\}\]\]:\[\]/,
      replace: "$1.inlineOpen===!0?[[$2,{inlineOpen:!0,popoverOpen:!1}]]:[]",
    },
  ],
};

// When an open popover becomes the inline panel (the window gets wider), T3 closes the popover
// and relies on the inline default to keep the panel on screen. Open it inline first.
// Optional: without it the panel closes in that case.
const carryOver = {
  id: "popover-to-inline",
  optional: true,
  find: "data-thread-details-card",
  replace: [
    {
      match: /(\i)===`inline`&&(\i)&&(\i)\.getState\(\)\.setThreadPanelOpen\((\i),`popover`,!1\)/,
      replace: "$1===`inline`&&$2&&($3.getState().setThreadPanelOpen($4,`inline`,!0),$3.getState().setThreadPanelOpen($4,`popover`,!1))",
    },
  ],
};

module.exports = [store, carryOver];
