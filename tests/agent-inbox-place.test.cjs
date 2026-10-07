// Where the Agent Inbox windows go (mods/agent-inbox/place.cjs): zoom, screen edges, no overlap.
const test = require("node:test");
const assert = require("node:assert/strict");
const { stripBounds, panelBounds } = require("../mods/agent-inbox/place.cjs");

const area = { x: 0, y: 0, width: 2560, height: 1400 };

test("the strip window grows with the zoom, and its pill stays 2 px from the right edge", () => {
  const size = { width: 56, height: 250 };
  const one = stripBounds({ area, size, z: 1, y: 0.5 });
  assert.deepEqual(one, { x: 2560 - 56 + 6, y: 575, width: 56, height: 250 });
  const big = stripBounds({ area, size, z: 1.2, y: 0.5 });
  assert.equal(big.width, 68);
  assert.equal(big.height, 300);
  // 6 of the 8 CSS px of margin right of the pill go off screen, at any zoom.
  assert.equal(big.x, 2560 - 68 + Math.round(6 * 1.2));
});

test("the strip stays inside the work area at the top and the bottom", () => {
  const size = { width: 56, height: 400 };
  assert.equal(stripBounds({ area, size, y: 0 }).y, 0);
  const low = stripBounds({ area, size, y: 1 });
  assert.equal(low.y + low.height, area.height);
  const other = { x: 2560, y: 40, width: 1920, height: 1040 };
  const b = stripBounds({ area: other, size, y: 0 });
  assert.equal(b.y, 40);
  assert.equal(b.x, 2560 + 1920 - 56 + 6);
});

test("a strip taller than the work area gets the work area's height", () => {
  const b = stripBounds({ area: { x: 0, y: 0, width: 800, height: 300 }, size: { width: 56, height: 280 }, z: 1.5, y: 0.5 });
  assert.equal(b.height, 300);
  assert.equal(b.y, 0);
});

test("the panel ends where the strip window starts, so it never covers the pill", () => {
  const strip = { x: 2510, y: 575, width: 56, height: 250 };
  for (const z of [1, 1.2, 1.5]) {
    const b = panelBounds({ area, strip, size: { width: 444, height: 300 }, z });
    assert.equal(b.x + b.width, strip.x, `zoom ${z}`);
    assert.equal(b.width, Math.ceil(444 * z));
    assert.equal(b.height, Math.ceil(300 * z));
  }
});

test("the panel centers on the strip, or on a peeked dot", () => {
  const strip = { x: 2510, y: 575, width: 56, height: 250 };
  const b = panelBounds({ area, strip, size: { width: 340, height: 100 } });
  assert.equal(b.y + b.height / 2, strip.y + strip.height / 2);
  const p = panelBounds({ area, strip, size: { width: 340, height: 100 }, centerY: 600 });
  assert.equal(p.y, 550);
});

test("a kept top edge stays, unless the panel would go below the work area", () => {
  const strip = { x: 2510, y: 575, width: 56, height: 250 };
  assert.equal(panelBounds({ area, strip, size: { width: 444, height: 300 }, top: 400 }).y, 400);
  const tall = panelBounds({ area, strip, size: { width: 444, height: 600 }, top: 1000 });
  assert.equal(tall.y + tall.height, area.height);
});

test("the panel never leaves the work area and is never taller than it", () => {
  const strip = { x: 2510, y: 0, width: 56, height: 250 };
  assert.equal(panelBounds({ area, strip, size: { width: 444, height: 300 }, centerY: 0 }).y, 0);
  const small = { x: 0, y: 0, width: 1280, height: 500 };
  const b = panelBounds({ area: small, strip: null, size: { width: 444, height: 600 }, z: 1.2 });
  assert.equal(b.height, 500);
  assert.equal(b.y, 0);
  assert.equal(b.x + b.width, 1280); // no strip: at the right edge of the work area
});
