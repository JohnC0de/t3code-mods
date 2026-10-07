// Agent Inbox, main-process half: the edge strip and the inbox panel windows, the global
// shortcut, and the relay between them and the app page (renderer.js). Several T3 Code apps can
// run from one mods folder: hub.cjs elects one of them leader; only the leader has the windows
// and the shortcut, and it shows the models of all apps merged. Pages and transport:
// CONTRACT.md. A change here needs an app restart; the pages reload by themselves.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHub, endpointFor } = require("./hub.cjs");

const SHORTCUT = "Control+Alt+Space";
const PAGE = "t3code://app/__mods/agent-inbox/";
const PANEL = { inbox: { width: 460, height: 600 }, peek: { width: 340, height: 170 } };
const SHADOW = 8; // transparent margin around the pill and the card, in each page's CSS
const DRAG_QUIET_MS = 1500; // after a drag, models that still carry the old position are ignored

/** @type {import("../../loader/types/t3mods").MainEntry} */
module.exports = (ctx) => {
  const { app, BrowserWindow, screen, globalShortcut } = ctx.electron;
  const renderer = ctx.renderer();
  const me = ctx.app ?? { id: "default", name: null, home: "" }; // an older loader has no ctx.app
  const ours = new Set();
  let model = null; // what the windows show: the merged model of all apps (leader only)
  let merge = null; // mergeModels from model.mjs, loaded below
  let leading = false;
  let ready = false;
  let strip = null;
  let panel = null;
  let view = null; // what the panel shows, or null when hidden
  let stripSize = { width: 56, height: 160 };
  let stripY = 0.5; // 0 top .. 1 bottom of the work area; the shared value lives in renderer.js
  let dragAt = 0;
  let shortcutTimer = 0;
  let quitting = false;

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
    const y = Math.round(Math.min(Math.max(wa.y + stripY * wa.height - height / 2, wa.y), wa.y + wa.height - height));
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
      const next = Math.min(Math.max((b.y + b.height / 2 - wa.y) / wa.height, 0), 1);
      if (Math.abs(next - stripY) > 0.0005) {
        stripY = next;
        dragAt = Date.now();
        // Saved in the app's state, which all running apps share.
        renderer.setStripY(next).catch((e) => ctx.log("could not save the strip position:", e.message));
      }
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
  function showInbox({ cardKey, threadKey } = {}) {
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
  function showList() {
    if (!model) return false;
    showPanel({ mode: "list" }, { focus: true });
    return true;
  }

  // ---------- app window and quit ----------
  // On Windows a process may take the keyboard focus only when it got the last input, and for a
  // thread of a follower app the leader got it. Topmost for a moment still brings the window up.
  function focusApp() {
    const w = appWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.setAlwaysOnTop(true);
    w.focus();
    w.setAlwaysOnTop(false);
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
    stopLeading();
    hub.close(); // followers elect a new leader at once
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

  // ---------- leader: shortcut and the merged model ----------
  const toggle = () => (alive(panel) && panel.isVisible() && view?.mode !== "peek" ? hidePanel() : showInbox({}));
  // The previous leader may still hold the shortcut for a moment after it quit.
  function registerShortcut(tries = 0) {
    if (!leading || globalShortcut.register(SHORTCUT, toggle)) return;
    if (tries >= 5) return ctx.log(`could not register ${SHORTCUT}; another app may own it`);
    shortcutTimer = setTimeout(() => registerShortcut(tries + 1), 1000);
  }
  function startLeading() {
    if (!ready || leading || quitting) return;
    leading = true;
    registerShortcut();
    refresh();
  }
  function stopLeading() {
    leading = false;
    clearTimeout(shortcutTimer);
    // A second launch quits before the app is ready, and globalShortcut throws until then.
    if (app.isReady()) globalShortcut.unregister(SHORTCUT);
    destroyAll();
  }

  // The leader shows all apps' models merged; with one app that is its own model.
  function refresh() {
    if (!leading || !merge || quitting) return;
    model = merge(hub.models());
    if (!model) {
      if (alive(strip)) strip.hide();
      hidePanel();
      return;
    }
    if (typeof model.stripY === "number" && Date.now() - dragAt > DRAG_QUIET_MS && Math.abs(model.stripY - stripY) > 0.0005) {
      stripY = model.stripY;
      placeStrip();
    }
    ensureStrip();
    for (const w of ours) push(w, `window.inbox?.update(${JSON.stringify(model)})`);
    if (model.strip === false) strip.hide();
    else if (!strip.isVisible() && !strip.webContents.isLoading()) strip.showInactive();
  }

  // Runs an action in this app (the hub calls it for threads this app owns).
  async function localAct(action) {
    await renderer.act(action);
    if (action.type === "open") focusApp();
    return true;
  }
  async function act(action) {
    await hub.act(action);
    if (action.type === "open") hidePanel();
    return true;
  }

  const hub = createHub({
    endpoint: endpointFor(fs.realpathSync(path.dirname(ctx.dir))),
    app: me,
    act: localAct,
    ui: { openInbox: showInbox, openList: showList },
    onChange: refresh,
    onRole: (isLeader) => {
      if (isLeader) app.whenReady().then(startLeading);
      else if (leading) stopLeading();
    },
    log: ctx.log,
  });

  import(pathToFileURL(path.join(ctx.dir, "model.mjs")).href).then(
    (m) => {
      merge = m.mergeModels;
      refresh();
    },
    (e) => ctx.log("could not load model.mjs:", e.message),
  );
  app.whenReady().then(() => {
    ready = true;
    if (hub.isLeader()) startLeading();
    const replace = () => placeStrip();
    screen.on("display-metrics-changed", replace);
    screen.on("display-added", replace);
    screen.on("display-removed", replace);
  });
  hub.start();

  return {
    // From renderer.js: the newest model of this app, or null when the mod stopped in the app page.
    publish(next) {
      if (quitting) return false;
      hub.setModel(next);
      return true;
    },
    // From the pages (CONTRACT.md); they run in the leader.
    state: () => model,
    act,
    // The palette commands run in any app; a follower's call goes to the leader.
    openInbox: (opts) => hub.ui("openInbox", opts),
    openList: () => hub.ui("openList"),
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
      stopLeading();
      hub.close();
    },
  };
};
