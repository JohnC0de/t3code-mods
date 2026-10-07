// Always-visible gallery of images the agent viewed, under the row that would otherwise hide
// them (collapsed tool group, activity group, folded turn, or a single collapsed tool call).
import { createElement as h, useContext, useMemo } from "react";

// Entries a row keeps out of sight, as work-log entries. Expanded containers skip rows whose
// entries render as their own rows (which get their own gallery).
function hiddenWorkEntries(row) {
  switch (row.kind) {
    case "work-toggle":
      return row.modEntries ?? [];
    case "work-live":
      return row.groupedEntries ?? [];
    case "turn-fold":
      return row.expanded ? [] : (row.modEntries ?? []).flatMap((e) => (e.kind === "work" ? [e.entry] : []));
    case "work":
      return row.isExpandedToolGroup ? [] : row.groupedEntries;
    default:
      return [];
  }
}

export default async (api) => {
  // Provided by this mod's image-internals patch; app internals, hence api.unsafe.
  const t = await api.unsafe.get("timeline");

  function AgentImages({ row }) {
    const ctx = useContext(t.RowContext);
    const threadRef = ctx?.threadRef;
    const images = useMemo(() => {
      if (!threadRef) return [];
      const seen = new Set();
      const out = [];
      for (const entry of hiddenWorkEntries(row)) {
        const path = t.viewedImagePath(entry);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const asset = t.resolveViewedImage(path, { threadId: threadRef.threadId, workspaceRoot: ctx.workspaceRoot });
        if (asset) out.push({ key: `${entry.id}:${path}`, asset });
      }
      return out;
    }, [row, threadRef, ctx?.workspaceRoot]);
    if (images.length === 0) return null;
    return h(
      "div",
      { className: "t3mod-agent-images", "data-count": images.length, role: "group", "aria-label": "Images viewed by the agent" },
      images.map(({ key, asset }) =>
        h(
          "div",
          { key, className: "t3mod-agent-images__item" },
          h(t.AssetImage, {
            environmentId: threadRef.environmentId,
            resource: asset.resource,
            alt: asset.alt,
            srcFragment: asset.srcFragment,
            workspaceRoot: ctx.workspaceRoot,
            maxHeightRem: images.length === 1 ? 16 : 10,
            onImageExpand: ctx.onImageExpand,
          }),
        ),
      ),
    );
  }

  api.slot("timeline-row", AgentImages);
};
