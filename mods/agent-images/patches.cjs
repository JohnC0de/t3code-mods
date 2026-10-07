// Surfaces images the agent viewed, even when their tool group, activity group or whole turn
// is collapsed. The patches only expose data; the gallery mounts in core's "timeline-row"
// slot (see mod.json requires) and renderer.js draws it.
// Anchors are MessagesTimeline source shapes (row kinds, prop names), not minified names.

// Group rows that hide entries get a `modEntries` field listing them.
const rowData = [
  {
    // Collapsed "Ran N commands..." tool group.
    id: "work-toggle-entries",
    find: "kind:`work-toggle`,id:`work-toggle:",
    replace: [{ match: /(kind:`work-toggle`,.{0,160}?hiddenCount:(\i)\.length,)/, replace: "$1modEntries:$2," }],
  },
  {
    // Turn fold ("Worked for 5m"): remember which of the turn's entries it hides...
    id: "turn-fold-hidden",
    find: "hiddenEntryIds:",
    replace: [
      {
        match: /((\i)\.startBoundary\?\?.{0,400}?hiddenEntryIds:(\i),label:\i)\}/,
        replace: "$1,modEntries:$2.entries.filter(__e=>$3.has(__e.id))}",
      },
    ],
  },
  {
    // ...and carry them onto the fold row.
    id: "turn-fold-entries",
    find: "kind:`turn-fold`,id:`turn-fold:",
    replace: [{ match: /(kind:`turn-fold`,id:`turn-fold:\$\{(\i)\.runId\}`,)/, replace: "$1modEntries:$2.modEntries," }],
  },
];

// Hand the renderer the app's own image pieces (module-scoped in the timeline chunk):
// the work-entry image path + asset resolvers, the row context, and the framed image view.
const internals = {
  id: "image-internals",
  find: "maxHeightRem:16,onImageExpand:",
  transform(text) {
    const paths = /let (\i)=(\i)\(\i\)[,;].{0,400}?\i=\1&&(\i)\?(\i)\(\1,\{threadId:\3\.threadId,workspaceRoot:\i\}\):null/;
    const ctx = /(\i)=\(0,\i\.use\)\((\i)\),\{threadRef:\i,onImageExpand:\i,timestampFormat:\i\}=\1/;
    const image = /children:\(0,\i\.jsx\)\((\i),\{environmentId:\i\.environmentId,resource:\i\.resource,alt:\i\.alt,srcFragment:\i\.srcFragment,workspaceRoot:\i,maxHeightRem:16,/;
    const id = "[A-Za-z_$][\\w$]*";
    const re = (r) => new RegExp(r.source.replaceAll("\\i", id));
    const p = text.match(re(paths));
    const c = text.match(re(ctx));
    const i = text.match(re(image));
    if (!p || !c || !i) return text;
    return (
      `${text}\n;globalThis.__t3mods?.provide?.("timeline",` +
      `{viewedImagePath:${p[2]},resolveViewedImage:${p[4]},RowContext:${c[2]},AssetImage:${i[1]}});`
    );
  },
};

module.exports = [...rowData, internals];
