// Core patches: the stable surfaces that other mods use through the runtime API instead of
// patching the app themselves. When T3 Code changes, only this file should need updates.
// `$self` is the runtime's core exports (render, paletteItems, provide, SettingsPage, ModsIcon).
// Every patch is optional: one broken surface must not switch off the others. A mod that
// needs a surface declares it, e.g. "requires": ["core/timeline-row"].
"use strict";

const ID = "[A-Za-z_$][\\w$]*";
const re = (r) => new RegExp(r.source.replaceAll("\\i", ID), r.flags);

// Appends `provide(key, Component)` to the chunk. Compiled React components are hoisted
// function declarations, so the call can go at the end. `locate` finds the name: a string
// anchor means "the named function that contains it"; a RegExp captures the name in group 1.
function provideComponent(id, find, locate, key) {
  return {
    id,
    find,
    optional: true,
    transform(text, { self }) {
      let name;
      if (locate instanceof RegExp) name = text.match(re(locate))?.[1];
      else name = [...text.slice(0, text.indexOf(locate)).matchAll(re(/function (\i)\(/g))].at(-1)?.[1];
      return name ? `${text}\n;${self}.provide?.(${JSON.stringify(key)},${name});` : text;
    },
  };
}

module.exports = [
  {
    // Command palette: mod commands follow the built-in "Open settings" action.
    id: "palette",
    optional: true,
    find: "value:`action:settings`",
    replace: [{ match: /(\i)\.push\(\{kind:`action`,value:`action:settings`.*?\}\}\);/, replace: "$&$1.push(...($self.paletteItems?.()??[]));" }],
  },
  {
    // Every timeline row renders the "timeline-row" slot after its content, with { row }.
    id: "timeline-row",
    optional: true,
    find: '"data-timeline-row-kind"',
    replace: [
      {
        match: /("data-timeline-row-kind":(\i)\.kind,[^{}]*?children:\[[^\]]*)\]/,
        replace: '$1,$self.render?.("timeline-row",{row:$2})??null]',
      },
    ],
  },
  {
    // Sidebar footer: the "sidebar-footer" slot follows the Settings / Usage icon buttons.
    id: "sidebar-footer",
    optional: true,
    find: "label:`Usage`,onClick:",
    replace: [
      {
        match: /(\(0,\i\.jsx\)\((\i),\{icon:\(0,\i\.jsx\)\(\i,\{\}\),label:`Usage`,onClick:\i\}\))\]/,
        replace: '$1,$self.render?.("sidebar-footer",{})??null]',
      },
    ],
  },
  {
    // Settings: a "Mods" section at /settings/mods that renders the "settings-mods" slot.
    // Three edits in the main chunk: nav label, nav icon, and a route in the settings tree.
    id: "settings-page",
    optional: true,
    find: '"/settings/archived":`Archive`}',
    group: true,
    replace: [
      { match: /"\/settings\/archived":`Archive`\}/, replace: '"/settings/archived":`Archive`,"/settings/mods":`Mods`}' },
      { match: /("\/settings\/archived":\i)\}(,\i=Object\.keys\()/, replace: '$1,"/settings/mods":$self.ModsIcon}$2' },
    ],
    transform(text, { self }) {
      const create = text.match(re(/(\i)\(`\/settings\/archived`\)\(\{component:/));
      const parent = text.match(re(/\.update\(\{id:`\/archived`,path:`\/archived`,getParentRoute:\(\)=>(\i)\}\)/));
      if (!create || !parent) return text;
      const route = `T3ModsRoute:${create[1]}(\`/settings/mods\`)({component:${self}.SettingsPage}).update({id:\`/mods\`,path:\`/mods\`,getParentRoute:()=>${parent[1]}}),`;
      return text.replace(re(/SettingsArchivedRoute:\i,/), (m) => m + route);
    },
  },
  {
    // Thread state and thread commands for api.threads. The app keeps them in one atom
    // registry: the thread shell store (a summary per thread, built on the thread command
    // store's snapshot), the thread detail store (the full projection, loaded on demand) and
    // the project store.
    id: "threads",
    optional: true,
    find: "`web-environment-thread:empty`",
    transform(text, { self }) {
      const stores = text.match(re(/(\i)=\i\((\i)\.stateAtom\),(\i)=\i\(\{catalogValueAtom:\i\.catalogValueAtom,snapshotAtom:(\i)\.snapshotAtom\}\)/));
      const registry = text.match(re(/function \i\(\)\{return (\i)\.get\(\i\.threadShellsAtom\)\}/));
      const projects = text.match(re(/(\i)=\i\(\{catalogValueAtom:\i\.catalogValueAtom,snapshotAtom:\i\}\)/));
      if (!stores || !registry || !projects) return text;
      const internals = `{registry:${registry[1]},shells:${stores[3]},details:${stores[1]},projects:${projects[1]},commands:${stores[4]}}`;
      return `${text}\n;${self}.provide?.("threads.internals",${internals});`;
    },
  },
  // App components for mods (api.ui.*). Optional: a mod that needs one declares it in requires.
  provideComponent("ui-button", '"data-slot":`button`', '"data-slot":`button`', "ui.Button"),
  provideComponent("ui-switch", '"data-slot":`switch`', '"data-slot":`switch`', "ui.Switch"),
  provideComponent("ui-sidebar-button", "label:`Usage`,onClick:", /\(0,\i\.jsx\)\((\i),\{icon:\(0,\i\.jsx\)\(\i,\{\}\),label:`Usage`/, "ui.SidebarIconButton"),
];
