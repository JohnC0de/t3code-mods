// App badge: marks a named app (ctx.app.name) in the window title ("T3 <name>") and, on
// Windows, with a taskbar overlay badge: the first letter of the name on a colored disc.
// The nameless default app is left alone. On loader 0.4.0 or later a save here reloads it, and
// turning the mod off takes the badge and the title away; older loaders need an app restart.
"use strict";

const os = require("node:os");
const path = require("node:path");

const SIZE = 32;
// Index 0 is amber, which a hash of "work" picks.
const PALETTE = ["#F59E0B", "#2563EB", "#16A34A", "#DC2626", "#9333EA", "#0891B2", "#DB2777", "#EA580C"];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
// The app's own name in a window title: "T3 Code", maybe followed by "(Nightly)" or similar.
const OWN_NAME = /T3 Code(?: \([^)]*\))?/;

// The same name as ctx.app.name; the fallback is for a loader without ctx.app.
function appName(ctx) {
  if (ctx.app) return ctx.app.name;
  const named = process.env.T3MODS_APP_NAME?.trim();
  if (named) return named;
  const dot = path.join(os.homedir(), ".t3");
  const home = path.resolve(process.env.T3CODE_HOME || dot);
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (fold(home) === fold(dot)) return null;
  const base = path.basename(home).replace(/^\.+/, "");
  const word = base.replace(/^t3(code)?-/i, "") || base;
  return word ? word[0].toUpperCase() + word.slice(1) : null;
}

function pickColor(name, env) {
  const set = env.T3MODS_APP_COLOR?.trim();
  if (set && HEX.test(set)) return { color: set, custom: true };
  let h = 2166136261; // FNV-1a over the lower case name
  for (const c of name.toLowerCase()) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return { color: PALETTE[h % PALETTE.length], custom: false, bad: set || undefined };
}

// Runs in the app page: the disc and the letter on a canvas, as a PNG data URL (2x for sharp edges).
const badgeScript = (letter, color) => `(() => {
  const c = document.createElement("canvas");
  c.width = c.height = ${SIZE * 2};
  const g = c.getContext("2d");
  g.scale(2, 2);
  g.fillStyle = ${JSON.stringify(color)};
  g.beginPath();
  g.arc(16, 16, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "700 21px 'Segoe UI', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(${JSON.stringify(letter)}, 16, 17);
  return c.toDataURL("image/png");
})()`;

// A plain disc in a BGRA bitmap, for when the letter cannot be drawn. 4x supersampled edge.
function discBitmap(color) {
  const hex = color.slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const N = 4;
  const c = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let inside = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) if (Math.hypot(x + (sx + 0.5) / N - c, y + (sy + 0.5) / N - c) <= c - 1) inside++;
      const o = (y * SIZE + x) * 4;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = Math.round((255 * inside) / (N * N));
    }
  }
  return buf;
}

/** @type {import("../../loader/types/t3mods").MainEntry} */
module.exports = (ctx) => {
  const name = appName(ctx);
  if (!name) return () => {}; // nothing to undo; a cleanup still lets the loader reload it
  // Listeners that go when the mod stops. An older loader has no lifecycle and never stops main.
  const listen = ctx.lifecycle?.listen ?? ((emitter, event, fn) => emitter.on(event, fn));
  let stopped = false;
  const { app, BrowserWindow, nativeImage } = ctx.electron;
  const label = `T3 ${name}`;
  const letter = Array.from(name)[0].toUpperCase();
  const { color, custom, bad } = pickColor(name, process.env);
  if (bad) ctx.log(`T3MODS_APP_COLOR "${bad}" is not a CSS hex color (#rgb or #rrggbb); using the palette`);
  const overlay = process.platform === "win32";

  // The letter is drawn on a canvas in the app page, so the system's fonts give any letter or
  // digit. (A capture of a hidden window fails on some setups with UnknownVizError.) Drawn once.
  async function render(w) {
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once("did-finish-load", r));
    const img = nativeImage.createFromDataURL(await w.webContents.executeJavaScript(badgeScript(letter, color)));
    if (img.isEmpty()) throw new Error("empty image");
    return img.resize({ width: SIZE, height: SIZE, quality: "best" });
  }

  let badge = null; // a Promise of the image, started on first use
  const image = (w) =>
    (badge ??= render(w).catch((e) => {
      ctx.log("badge letter not rendered, using a plain disc:", e.message);
      return nativeImage.createFromBitmap(discBitmap(color), { width: SIZE, height: SIZE });
    }));

  const isMain = (w) => {
    if (w.isDestroyed()) return false;
    const url = w.webContents.getURL();
    return /^t3code:/.test(url) && !url.includes("/__mods/");
  };
  // The app's own name in each title we changed, so the cleanup can put it back.
  const ownNames = new Map();
  const retitle = (title, w) => {
    const own = title.match(OWN_NAME)?.[0];
    if (own) ownNames.set(w, own);
    return own ? title.replace(OWN_NAME, label) : title.includes(label) ? title : `${title} — ${label}`;
  };
  const untitle = (title, w) => (ownNames.has(w) ? title.replace(label, ownNames.get(w)) : title.replace(` — ${label}`, ""));

  let logged = false;
  const apply = (w) => {
    if (!isMain(w) || stopped) return;
    const title = retitle(w.getTitle(), w);
    if (title !== w.getTitle()) w.setTitle(title);
    if (!overlay) return;
    image(w).then((img) => {
      if (w.isDestroyed() || stopped) return;
      w.setOverlayIcon(img, label);
      if (!logged) ctx.log(`overlay badge set: ${label} ${letter} ${color}${custom ? " (T3MODS_APP_COLOR)" : ""}`);
      logged = true;
    });
  };

  const watch = (w) => {
    listen(w, "page-title-updated", (e, title) => {
      if (!isMain(w)) return;
      e.preventDefault();
      w.setTitle(retitle(title, w));
    });
    for (const ev of ["ready-to-show", "show", "restore", "focus"]) listen(w, ev, () => apply(w));
    for (const ev of ["did-finish-load", "did-navigate", "did-navigate-in-page"]) listen(w.webContents, ev, () => apply(w));
  };

  app.whenReady().then(() => {
    if (stopped) return;
    listen(app, "browser-window-created", (_e, w) => watch(w));
    for (const w of BrowserWindow.getAllWindows()) {
      watch(w);
      apply(w);
    }
    ctx.log(`app-badge active: ${label}`);
  });

  // Before a reload and when the mod is turned off: the plain title and no badge again.
  return () => {
    stopped = true;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!isMain(w)) continue;
      const title = untitle(w.getTitle(), w);
      if (title !== w.getTitle()) w.setTitle(title);
      if (overlay) w.setOverlayIcon(null, "");
    }
  };
};
