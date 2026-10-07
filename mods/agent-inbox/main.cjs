// Agent Inbox, main-process half: the edge strip and the inbox panel windows, the global
// shortcut, and the relay between them and the app page (renderer.js). Pages and transport:
// CONTRACT.md. A change here needs an app restart; the pages reload by themselves.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SHORTCUT = "Control+Alt+Space";
const PAGE = "t3code://app/__mods/agent-inbox/";
const PANEL = { inbox: { width: 460, height: 600 }, peek: { width: 340, height: 170 } };
const SHADOW = 8; // transparent margin around the pill and the card, in each page's CSS

/** @type {import("../../loader/types/t3mods").MainEntry} */
module.exports = (ctx) => {
  const { app, BrowserWindow, screen, globalShortcut } = ctx.electron;
  const renderer = ctx.renderer();
  const ours = new Set();
  const settingsFile = () => path.join(app.getPath("userData"), "agent-inbox.json");
  let saved = { y: 0.5 };
  let model = null;
  let strip = null;
  let panel = null;
  let view = null; // what the panel shows, or null when hidden
  let stripSize = { width: 56, height: 160 };
  let quitting = false;

  const readSaved = () => {
    try {
      saved = { ...saved, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
    } catch {}
  };
  const writeSaved = () => fs.writeFile(settingsFile(), JSON.stringify(saved), () => {});

  const alive = (w) => w && !w.isDestroyed();
  const push = (w, code) => {
    if (alive(w) && !w.webContents.isLoading()) w.webContents.executeJavaScript(code).catch(() => {});
  };
  const appWindow = () =>
    BrowserWindow.getAllWindows().find((w) => !ours.has(w) && !w.isDestroyed() && /^t3code/.test(w.webContents.getURL()) && !w.webContents.getURL().includes("/__mods/"));

  function makeWindow(file, options) {
    const w = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      ...options,
    });
    ours.add(w);
    w.setAlwaysOnTop(true, "floating");
    w.setMenu(null);
    w.on("closed", () => ours.delete(w));
    w.webContents.on("did-finish-load", () => {
      if (model) push(w, `window.inbox?.update(${JSON.stringify(model)})`);
      if (w === panel && view) push(w, `window.inbox?.show(${JSON.stringify(view)})`);
    });
    w.loadURL(PAGE + file).catch((e) => ctx.log(`could not load ${file}:`, e.message));
    return w;
  }

  // ---------- strip ----------
  const workArea = () => (alive(strip) ? screen.getDisplayMatching(strip.getBounds()) : screen.getPrimaryDisplay()).workArea;
  function placeStrip() {
    if (!alive(strip)) return;
    const wa = workArea();
    const { width, height } = stripSize;
    const y = Math.round(Math.min(Math.max(wa.y + saved.y * wa.height - height / 2, wa.y), wa.y + wa.height - height));
    // The pill's shadow margin goes off screen, so the pill touches the edge.
    strip.setBounds({ x: wa.x + wa.width - width + SHADOW - 2, y, width, height });
  }
  function ensureStrip() {
    if (alive(strip)) return strip;
    strip = makeWindow("strip.html", { width: stripSize.width, height: stripSize.height, focusable: false, title: "Agent Inbox strip" });
    placeStrip();
    strip.once("ready-to-show", () => model?.strip !== false && strip.showInactive());
    // A drag on the grip moves the window freely; keep the height and snap back to the edge.
    strip.on("moved", () => {
      const b = strip.getBounds();
      const wa = workArea();
      saved.y = Math.min(Math.max((b.y + b.height / 2 - wa.y) / wa.height, 0), 1);
      writeSaved();
      placeStrip();
    });
    return strip;
  }

  // ---------- panel ----------
  function ensurePanel() {
    if (alive(panel)) return panel;
    panel = makeWindow("panel.html", { width: PANEL.inbox.width, height: PANEL.inbox.height, title: "Agent Inbox" });
    // An inbox the user opened closes when they click elsewhere; a send in progress still finishes.
    panel.on("blur", () => {
      setTimeout(() => {
        if (alive(panel) && !panel.isFocused() && view && view.mode !== "peek") hidePanel();
      }, 120);
    });
    return panel;
  }
  function placePanel(size, centerY) {
    const wa = workArea();
    const s = alive(strip) && strip.isVisible() ? strip.getBounds() : { x: wa.x + wa.width, y: wa.y + wa.height / 2, height: 0 };
    const cy = centerY ?? s.y + s.height / 2;
    const y = Math.round(Math.min(Math.max(cy - size.height / 2, wa.y), wa.y + wa.height - size.height));
    panel.setBounds({ x: Math.round(s.x - size.width + SHADOW * 2), y, width: size.width, height: size.height });
  }
  function showPanel(next, { focus, centerY } = {}) {
    ensurePanel();
    view = next;
    placePanel(next.mode === "peek" ? PANEL.peek : PANEL.inbox, centerY);
    push(panel, `window.inbox?.show(${JSON.stringify(next)})`);
    if (focus) {
      panel.show();
      panel.focus();
    } else if (!panel.isVisible()) panel.showInactive();
  }
  function hidePanel() {
    view = null;
    if (alive(panel)) panel.hide();
  }
  const cardFor = (threadKey) => model?.cards.find((c) => c.threadKey === threadKey)?.key ?? null;
  function openInbox({ cardKey, threadKey } = {}) {
    if (!model) return false;
    if (threadKey && !cardKey && !cardFor(threadKey)) {
      // No card for this agent: take the user to the thread instead.
      const dot = model.agents.find((a) => a.threadKey === threadKey) ?? model.dots.find((d) => d.threadKey === threadKey);
      if (dot) return act({ type: "open", ref: dot.ref });
    }
    // Without a target, start at the most urgent card (the model lists them first).
    showPanel({ mode: "inbox", cardKey: cardKey ?? (threadKey ? cardFor(threadKey) : model.cards[0]?.key ?? null) }, { focus: true });
    return true;
  }

  // ---------- app window and quit ----------
  function focusApp() {
    const w = appWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  function destroyAll() {
    for (const w of [...ours]) if (alive(w)) w.destroy();
    strip = panel = null;
    view = null;
  }
  // Our windows must not keep the app running: when the last app window closes, close them too,
  // so the app quits as it would without the mod (and the loader's update task can run).
  app.on("browser-window-created", (_event, w) => {
    setImmediate(() => {
      if (ours.has(w)) return;
      w.once("closed", () => {
        if (BrowserWindow.getAllWindows().every((x) => ours.has(x) || x.isDestroyed())) destroyAll();
      });
    });
  });
  app.on("before-quit", () => {
    quitting = true;
    destroyAll();
  });

  // ---------- page reload while editing the mod ----------
  let reloadTimer = 0;
  const watcher = fs.watch(ctx.dir, { persistent: false }, (_e, file) => {
    if (!/^(strip|panel|shared)\.(html|js)$|^inbox\.css$/.test(file ?? "")) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      for (const w of ours) if (alive(w)) w.webContents.reloadIgnoringCache();
    }, 80);
  });

  app.whenReady().then(() => {
    readSaved();
    const toggle = () => (alive(panel) && panel.isVisible() && view?.mode !== "peek" ? hidePanel() : openInbox({}));
    if (!globalShortcut.register(SHORTCUT, toggle)) ctx.log(`could not register ${SHORTCUT}; another app may own it`);
    const replace = () => placeStrip();
    screen.on("display-metrics-changed", replace);
    screen.on("display-added", replace);
    screen.on("display-removed", replace);
  });

  async function act(action) {
    await renderer.act(action);
    if (action.type === "open") {
      hidePanel();
      focusApp();
    }
    return true;
  }

  return {
    // From renderer.js: the newest model, or null when the mod stopped in the app page.
    publish(next) {
      if (quitting) return false;
      model = next;
      if (!model) {
        if (alive(strip)) strip.hide();
        hidePanel();
        return true;
      }
      ensureStrip();
      for (const w of ours) push(w, `window.inbox?.update(${JSON.stringify(model)})`);
      if (model.strip === false) strip.hide();
      else if (!strip.isVisible() && !strip.webContents.isLoading()) strip.showInactive();
      return true;
    },
    // From the pages (CONTRACT.md).
    state: () => model,
    act,
    openInbox,
    openList() {
      if (!model) return false;
      showPanel({ mode: "list" }, { focus: true });
      return true;
    },
    peek({ threadKey, y }) {
      if (!model || (alive(panel) && panel.isVisible() && view && view.mode !== "peek")) return false;
      showPanel({ mode: "peek", threadKey }, { centerY: y });
      return true;
    },
    unpeek() {
      if (view?.mode === "peek") hidePanel();
      return true;
    },
    closePanel() {
      hidePanel();
      return true;
    },
    fit({ width, height }) {
      stripSize = { width: Math.ceil(width), height: Math.ceil(height) };
      placeStrip();
      return true;
    },
    dragEnd() {
      if (alive(strip)) strip.emit("moved");
      return true;
    },
    // The loader does not call dispose on main mods yet (they stop with the app); kept so a
    // future main reload has a clean exit.
    dispose() {
      watcher.close();
      globalShortcut.unregister(SHORTCUT);
      destroyAll();
    },
  };
};
