// Where the strip and the panel windows go. Window bounds are in DIP; the pages measure in CSS px,
// and `z` is the pages' zoom factor (they share the app's origin, so they follow its zoom).
"use strict";

const STRIP_MARGIN = 8; // transparent margin around the pill for its shadow (#wrap in inbox.css)

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** The strip at the right edge of `area`, its center at `y` (0 top .. 1 bottom). */
function stripBounds({ area, size, z = 1, y = 0.5 }) {
  const width = Math.ceil(size.width * z);
  const height = Math.min(Math.ceil(size.height * z), area.height);
  const top = Math.round(clamp(area.y + y * area.height - height / 2, area.y, area.y + area.height - height));
  // The pill's right margin goes off screen, so the pill sits 2 px from the edge.
  return { x: area.x + area.width - width + Math.round((STRIP_MARGIN - 2) * z), y: top, width, height };
}

/**
 * The panel left of the strip window, never over it (a window over the pill would take its
 * clicks). Centered on `centerY` (DIP), or on the strip; a given `top` keeps the top edge.
 */
function panelBounds({ area, strip, size, z = 1, centerY, top }) {
  const width = Math.ceil(size.width * z);
  const height = Math.min(Math.ceil(size.height * z), area.height);
  const right = strip ? strip.x : area.x + area.width;
  const cy = centerY ?? (strip ? strip.y + strip.height / 2 : area.y + area.height / 2);
  const y = Math.round(clamp(top ?? cy - height / 2, area.y, area.y + area.height - height));
  return { x: Math.round(right - width), y, width, height };
}

module.exports = { stripBounds, panelBounds, STRIP_MARGIN };
