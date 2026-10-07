// App badge: marks a named app (ctx.app.name) in the window title ("T3 <name>") and, on
// Windows, with a taskbar overlay badge: the first letter of the name on a colored disc.
// The nameless default app is left alone. A change needs an app restart.
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

const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);

function badgeSvg(letter, color) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<circle cx="16" cy="16" r="15" fill="${color}"/>` +
    `<text x="16" y="16" text-anchor="middle" dominant-baseline="central" fill="#fff" ` +
    `font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="21">${escapeXml(letter)}</text></svg>`
  );
}

// A plain disc in a BGRA bitmap, for when the SVG cannot be rendered. 4x supersampled edge.
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
  if (!name) return;
  const { app, BrowserWindow, nativeImage } = ctx.electron;
  const label = `T3 ${name}`;
  const letter = Array.from(name)[0].toUpperCase();
  const { color, custom, bad } = pickColor(name, process.env);
  if (bad) ctx.log(`T3MODS_APP_COLOR "${bad}" is not a CSS hex color (#rgb or #rrggbb); using the palette`);
  const overlay = process.platform === "win32";

  // The letter is drawn as SVG in a hidden window and captured: the system's fonts give any
  // letter or digit. Rendered once.
  async function render() {
    const w = new BrowserWindow({
      show: false,
      x: -32000,
      y: -32000,
      width: SIZE,
      height: SIZE,
      transparent: true,
      frame: false,
      skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    try {
      const html = `<!doctype html><body style="margin:0;background:transparent;overflow:hidden">${badgeSvg(letter, color)}`;
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      w.showInactive(); // a hidden window cannot be captured; this one sits far off screen
      for (let i = 0; i < 10; i++) {
        const shot = await w.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
        if (!shot.isEmpty()) return shot.resize({ width: SIZE, height: SIZE });
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("empty capture");
    } finally {
      w.destroy();
    }
  }

  let badge = null; // a Promise of the image, started on first use
  const image = () =>
    (badge ??= render().catch((e) => {
      ctx.log("badge letter not rendered, using a plain disc:", e.message);
      return nativeImage.createFromBitmap(discBitmap(color), { width: SIZE, height: SIZE });
    }));

  const isMain = (w) => {
    if (w.isDestroyed()) return false;
    const url = w.webContents.getURL();
    return /^t3code:/.test(url) && !url.includes("/__mods/");
  };
  const retitle = (title) => (OWN_NAME.test(title) ? title.replace(OWN_NAME, label) : title.includes(label) ? title : `${title} — ${label}`);

  let logged = false;
  const apply = (w) => {
    if (!isMain(w)) return;
    const title = retitle(w.getTitle());
    if (title !== w.getTitle()) w.setTitle(title);
    if (!overlay) return;
    image().then((img) => {
      if (w.isDestroyed()) return;
      w.setOverlayIcon(img, label);
      if (!logged) ctx.log(`overlay badge set: ${label} ${letter} ${color}${custom ? " (T3MODS_APP_COLOR)" : ""}`);
      logged = true;
    });
  };

  const watch = (w) => {
    w.on("page-title-updated", (e, title) => {
      if (!isMain(w)) return;
      e.preventDefault();
      w.setTitle(retitle(title));
    });
    for (const ev of ["ready-to-show", "show", "restore", "focus"]) w.on(ev, () => apply(w));
    for (const ev of ["did-finish-load", "did-navigate", "did-navigate-in-page"]) w.webContents.on(ev, () => apply(w));
  };

  app.whenReady().then(() => {
    app.on("browser-window-created", (_e, w) => watch(w));
    for (const w of BrowserWindow.getAllWindows()) {
      watch(w);
      apply(w);
    }
    ctx.log(`app-badge active: ${label}`);
  });
};
