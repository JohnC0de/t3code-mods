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
const { stripBounds, panelBounds } = require("./place.cjs");

const SHORTCUT = "Control+Alt+Space";
const PAGE = "t3code://app/__mods/agent-inbox/";
// CSS px: the size before the page measured its card, and the largest the window gets.
const PANEL = { inbox: { width: 444, height: 600 }, peek: { width: 340, height: 220 } };
// On Windows "floating" (the default) puts a window behind the taskbar, under other topmost windows.
const LEVEL = "pop-up-menu";
const DRAG_QUIET_MS = 1500; // after a drag, models that still carry the old position are ignored
const STRIP_SHOW_MS = 1000; // show the strip without its measured size after this long

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
  let stripSize = { width: 56, height: 160 }; // CSS px, as strip.js measured the pill
  let stripFitted = false; // the strip waits for its size, so it does not show clipped
  let panelSize = null; // CSS px, as panel.js measured the card; null: PANEL
  let panelTop = null; // DIP; the top edge stays put while the inbox is open
  let panelAnchor = null; // DIP; a peek's center, next to its dot
  let panelFocus = false; // the panel takes the keyboard when it shows
  let renderSeq = 0; // the newest panel render; older page answers are ignored
  let stripY = 0.5; // 0 top .. 1 bottom of the work area; the shared value lives in renderer.js
  let dragAt = 0;
  let shortcutTimer = 0;
  let quitting = false;

  const alive = (w) => w && !w.isDestroyed();
  const zoom = (w) => (alive(w) && w.webContents.getZoomFactor()) || 1;
  // Topmost again and above the other topmost windows; the level can drop on Windows. Only for
  // a shown window: on a hidden one (Windows) it leaves the window blank when it shows.
  const raise = (w) => {
    if (!alive(w) || !w.isVisible()) return;
    w.setAlwaysOnTop(true, LEVEL);
    w.moveTop();
  };
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
    w.setAlwaysOnTop(true, LEVEL);
    w.setMenu(null);
    w.on("closed", () => ours.delete(w));
    // isLoading() is still true here, so push() would drop these.
    w.webContents.on("did-finish-load", () => {
      if (model) w.webContents.executeJavaScript(`window.inbox?.update(${JSON.stringify(model)})`).catch(() => {});
      if (w === panel && view) renderPanel();
    });
    w.loadURL(PAGE + file).catch((e) => ctx.log(`could not load ${file}:`, e.message));
    return w;
  }

  // ---------- strip ----------
  const workArea = () => (alive(strip) ? screen.getDisplayMatching(strip.getBounds()) : screen.getPrimaryDisplay()).workArea;
  function placeStrip() {
    if (!alive(strip)) return;
    strip.setBounds(stripBounds({ area: workArea(), size: stripSize, z: zoom(strip), y: stripY }));
  }
  function showStrip() {
    if (!alive(strip) || !stripFitted || model?.strip === false || strip.isVisible()) return;
    strip.showInactive();
    raise(strip);
  }
  function ensureStrip() {
    if (alive(strip)) return strip;
    stripFitted = false;
    strip = makeWindow("strip.html", { width: stripSize.width, height: stripSize.height, focusable: false, title: "Agent Inbox strip" });
    placeStrip();
    strip.once("ready-to-show", () => {
      setTimeout(() => {
        stripFitted = true;
        showStrip();
      }, STRIP_SHOW_MS);
    });
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
    panelSize = null;
    panel = makeWindow("panel.html", { width: PANEL.inbox.width, height: PANEL.inbox.height, title: "Agent Inbox" });
    // An inbox the user opened closes when they click elsewhere; a send in progress still finishes.
    panel.on("blur", () => {
      setTimeout(() => {
        if (alive(panel) && !panel.isFocused() && view && view.mode !== "peek") hidePanel();
      }, 120);
    });
    return panel;
  }
  // The panel's size comes from the page: show() renders the view and returns the card's size,
  // and fitPanel() reports later changes. The window shows only once it has that size.
  const panelMax = (mode) => PANEL[mode === "peek" ? "peek" : "inbox"];
  function placePanel() {
    if (!alive(panel) || !view) return;
    const s = alive(strip) && strip.isVisible() ? strip.getBounds() : null;
    const max = panelMax(view.mode);
    const size = { width: panelSize?.width ?? max.width, height: Math.min(panelSize?.height ?? max.height, max.height) };
    const b = panelBounds({ area: workArea(), strip: s, size, z: zoom(panel), centerY: panelAnchor ?? undefined, top: panelTop ?? undefined });
    if (view.mode !== "peek") panelTop = b.y;
    panel.setBounds(b);
  }
  function showPanel(next, { focus, centerY } = {}) {
    ensurePanel();
    // A new inbox, or a change to or from a peek, is placed anew; a change inside the inbox
    // (another card, the list) keeps the top edge.
    if (!panel.isVisible() || next.mode === "peek" || view?.mode === "peek") panelTop = null;
    view = next;
    panelAnchor = next.mode === "peek" ? (centerY ?? null) : null;
    panelFocus = !!focus;
    // A peek is a picture only: the pointer and clicks go through it.
    panel.setIgnoreMouseEvents(next.mode === "peek");
    if (panel.webContents.isLoading()) return; // did-finish-load renders it
    if (panelFocus) {
      // Take the keyboard now: Windows lets this app come to the front only right after the
      // user's key or click. The page is empty while hidden, so the old card does not flash;
      // the render below fills and sizes the window.
      panelFocus = false;
      if (!panel.isVisible()) placePanel();
      panel.show(); // also for a shown peek: show() makes an inactive window active
      panel.focus();
    }
    renderPanel();
  }
  async function renderPanel() {
    const seq = ++renderSeq;
    const limits = { id: seq, maxHeight: Math.floor(Math.min(panelMax(view.mode).height, workArea().height / zoom(panel))) };
    const size = await panel.webContents.executeJavaScript(`window.inbox?.show(${JSON.stringify(view)}, ${JSON.stringify(limits)})`).catch(() => null);
    if (seq !== renderSeq || !view || !alive(panel)) return;
    panelSize = size?.width > 0 && size?.height > 0 ? size : null; // an older page returns nothing
    placePanel();
    if (panelFocus) {
      panelFocus = false;
      panel.show();
      panel.focus();
    } else if (!panel.isVisible()) panel.showInactive();
    raise(strip);
    raise(panel);
  }
  function hidePanel() {
    view = null;
    panelTop = panelAnchor = null;
    panelFocus = false;
    renderSeq++;
    if (!alive(panel)) return;
    panel.hide();
    push(panel, "window.inbox?.clear?.()");
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
    else showStrip();
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
    const replace = () => {
      placeStrip();
      placePanel();
    };
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
    // `offset`: the dot's center in the strip page (CSS px). `y` (screen) is for an older main.
    peek({ threadKey, y, offset }) {
      if (!model || (alive(panel) && panel.isVisible() && view && view.mode !== "peek")) return false;
      const centerY = typeof offset === "number" && alive(strip) ? strip.getBounds().y + offset * zoom(strip) : y;
      showPanel({ mode: "peek", threadKey }, { centerY });
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
    // Strip only: the pill's size in CSS px. strip.js calls it again when the zoom changes.
    fit({ width, height }) {
      stripSize = { width: Math.ceil(width), height: Math.ceil(height) };
      placeStrip();
      stripFitted = true;
      showStrip();
      return true;
    },
    // Panel only: the card's size after a change in the page (CSS px). `id` is the render it
    // belongs to; a size from an older render is ignored.
    fitPanel({ id, width, height }) {
      if (id !== renderSeq || !view || !(width > 0 && height > 0)) return false;
      panelSize = { width, height };
      if (alive(panel) && panel.isVisible()) placePanel();
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
