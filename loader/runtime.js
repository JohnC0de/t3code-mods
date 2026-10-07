// Renderer half of the T3 Code mod loader. Served same-origin from t3code://app/__mods/.
// Each mod may ship style.css and/or renderer.js (`export default (api) => cleanup?`).
// Everything a mod registers goes through `api` and is owned by the mod's lifecycle, so a
// hot reload is dispose-then-import. Types: types/t3mods.d.ts.

import * as threadsModel from "./threads-model.mjs";

const log =(...a) => console.log("%c[t3mods]", "color:#818cf8", ...a);
const loaded = new Map(); // id -> { disposers, controller }

// ---------- small observable ----------
function signal() {
  const fns = new Set();
  let version = 0;
  return {
    subscribe: (fn) => (fns.add(fn), () => fns.delete(fn)),
    version: () => version,
    emit() {
      version++;
      for (const fn of [...fns]) fn();
    },
  };
}

// ---------- provide / get: values that patches hand over from app chunks ----------
const provided = new Map();
const waiters = new Map();
function provide(key, value) {
  provided.set(key, value);
  for (const resolve of waiters.get(key) ?? []) resolve(value);
  waiters.delete(key);
  return value;
}
function get(key) {
  if (provided.has(key)) return Promise.resolve(provided.get(key));
  return new Promise((resolve) => waiters.set(key, [...(waiters.get(key) ?? []), resolve]));
}
// Keys with a stable meaning. Anything else is an app internal: use api.unsafe.get.
const STABLE = /^(React|ReactDOM|ReactDOMClient|jsx|ui\..+)$/;
const React = () => provided.get("React") ?? globalThis.__clerkSharedModules?.react;

// ---------- slots: named mount points rendered by core patches ----------
const slots = new Map(); // name -> ReadonlyArray<{ key, Component }>
const slotsChanged = signal();
const EMPTY = [];
function setSlot(name, list) {
  slots.set(name, list);
  slotsChanged.emit();
}
let Slot = null;
function makeSlot(R) {
  const h = R.createElement;
  // A crashing mod component must not take the app down with it.
  class Boundary extends R.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      console.error(`[t3mods] ${this.props.modKey} crashed in a slot; hidden until next reload`, error);
    }
    render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  return function T3ModsSlot({ name, ...props }) {
    const list = R.useSyncExternalStore(slotsChanged.subscribe, () => slots.get(name) ?? EMPTY);
    if (list.length === 0) return null;
    return list.map(({ key, Component }) => h(Boundary, { key, modKey: key }, h(Component, props)));
  };
}
function render(name, props) {
  const R = React();
  if (!R) return null;
  Slot ??= makeSlot(R);
  return R.createElement(Slot, { name, ...props });
}

// ---------- palette commands ----------
const commands = new Map(); // key -> item
function paletteItems() {
  return [...commands.values()].map((c) => ({
    kind: "action",
    value: `mod:${c.key}`,
    searchTerms: c.searchTerms ?? [],
    title: c.title,
    description: c.description,
    icon: null,
    run: async () => c.run(),
  }));
}

// ---------- settings contributions, shown by the manager ----------
const settings = new Map(); // mod id -> [{ key, kind, ... }]
const settingsChanged = signal();

// ---------- index (mods, health, doctor) ----------
let index = null;
const indexChanged = signal();
async function refreshIndex() {
  index = await (await fetch("/__mods/index.json", { cache: "no-store" })).json();
  indexChanged.emit();
  return index;
}
async function apiCall(action, body, headers = {}) {
  const isBytes = body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob;
  const res = await fetch(`/__mods/api/${action}`, {
    method: "POST",
    headers: isBytes ? headers : { "content-type": "application/json", ...headers },
    body: isBytes ? body : JSON.stringify(body ?? {}),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error);
  return out;
}

// ---------- state cells, persisted per mod in <mods>/.t3mods/state/<id>.json ----------
// Several apps share these files. A save sends only the keys that this page changed, and
// stateChanged() takes in what other apps wrote.
const stores = new Map(); // id -> { values, subs: Map<key, Set<{ fn, read }>>, timer, dirty: Set<key>, flight: Set<key> }
function storeFor(id) {
  if (!stores.has(id)) stores.set(id, { values: { ...(index?.mods.find((m) => m.id === id)?.state ?? {}) }, subs: new Map(), timer: 0, dirty: new Set(), flight: new Set() });
  return stores.get(id);
}
// An older main process has no per-key endpoint and answers "unknown action": use the old
// whole-object one from then on.
let wholeStateOnly = false;
async function saveState(id, s) {
  const keys = [...s.dirty];
  s.dirty.clear();
  for (const k of keys) s.flight.add(k);
  try {
    let out;
    if (wholeStateOnly) out = await apiCall(`state/${encodeURIComponent(id)}`, s.values);
    else {
      const set = Object.fromEntries(keys.filter((k) => s.values[k] !== undefined).map((k) => [k, s.values[k]]));
      const unset = keys.filter((k) => s.values[k] === undefined);
      try {
        out = await apiCall(`state-patch/${encodeURIComponent(id)}`, { set, unset });
      } catch (e) {
        if (!/^unknown action/.test(e.message)) throw e;
        wholeStateOnly = true;
        out = await apiCall(`state/${encodeURIComponent(id)}`, s.values);
      }
    }
    if (out.reload) await refreshIndex();
  } catch (e) {
    for (const k of keys) s.dirty.add(k); // the next save retries them
    console.error(`[t3mods] ${id}: could not save state`, e);
  } finally {
    for (const k of keys) s.flight.delete(k);
  }
}
// The main process calls this when a state file changed on disk (another app wrote it, or this
// page's own save came back). Keys with a local write that is not saved yet keep the local value.
function stateChanged(id, values) {
  const mod = index?.mods.find((m) => m.id === id);
  if (mod) mod.state = values;
  const s = stores.get(id);
  if (!s) return;
  for (const key of new Set([...Object.keys(s.values), ...Object.keys(values)])) {
    if (s.dirty.has(key) || s.flight.has(key) || JSON.stringify(s.values[key]) === JSON.stringify(values[key])) continue;
    if (values[key] === undefined) delete s.values[key];
    else s.values[key] = values[key];
    for (const { fn, read } of [...(s.subs.get(key) ?? [])]) fn(read());
  }
}
function makeState(id, own) {
  const s = storeFor(id);
  const save = (key) => {
    s.dirty.add(key);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => saveState(id, s), 150);
  };
  const cell = (key, fallback, decode) => {
    const read = () => {
      const v = s.values[key];
      const d = v === undefined ? undefined : decode(v);
      return d === undefined ? fallback : d;
    };
    const listeners = () => s.subs.get(key) ?? s.subs.set(key, new Set()).get(key);
    const subscribeRaw = (fn) => {
      const entry = { fn, read }; // read: stateChanged() decodes with this cell's own decoder
      listeners().add(entry);
      return () => listeners().delete(entry);
    };
    return {
      key,
      get: read,
      set(next) {
        const d = decode(typeof next === "function" ? next(read()) : next);
        if (d === undefined) throw new TypeError(`${id}: invalid value for state "${key}"`);
        if (s.values[key] !== undefined && Object.is(d, read())) return;
        s.values[key] = d;
        save(key);
        for (const { fn } of [...listeners()]) fn(d);
      },
      subscribe: (fn) => own(subscribeRaw(fn)),
      // Runs now with the current value and again on each change; a returned function is
      // the cleanup for the previous value.
      effect(fn) {
        let cleanup = fn(read());
        const off = subscribeRaw((v) => {
          if (typeof cleanup === "function") cleanup();
          cleanup = fn(v);
        });
        return own(() => {
          off();
          if (typeof cleanup === "function") cleanup();
        });
      },
      _subscribe: subscribeRaw, // unowned, for React hooks
    };
  };
  return {
    boolean: (key, fallback) => cell(key, fallback, (v) => (typeof v === "boolean" ? v : undefined)),
    number: (key, fallback, { min = -Infinity, max = Infinity } = {}) =>
      cell(key, fallback, (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined)),
    string: (key, fallback) => cell(key, fallback, (v) => (typeof v === "string" ? v : undefined)),
    value: (key, { default: fallback, decode }) => cell(key, fallback, decode),
  };
}
function useCell(cell) {
  return React().useSyncExternalStore(cell._subscribe, cell.get);
}

// ---------- api.server() / api.main(): typed calls into the mod's Node tiers ----------
function remote(tier, id, signal) {
  return new Proxy(
    {},
    {
      get(_, method) {
        if (typeof method !== "string" || method === "then") return undefined;
        return async (...args) => {
          const res = await fetch(`/__mods/rpc/${tier}/${encodeURIComponent(id)}/${encodeURIComponent(method)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args),
            signal,
          });
          const out = await res.json();
          if (!out.ok) throw new Error(`${id}.${method} (${tier}): ${out.error}`);
          return out.value;
        };
      },
    },
  );
}

// ---------- api.threads: the app's threads and thread commands (core patch "threads") ----------
// The patch hands over the app's atom registry and its thread stores; this turns them into plain
// objects and promise-returning commands.
const internals = () => provided.get("threads.internals");
function needInternals() {
  const t = internals();
  if (!t) throw new Error("api.threads needs the core/threads patch, which does not apply to this T3 Code build");
  return t;
}
const plainRef = (ref) => ({ environmentId: ref.environmentId, threadId: ref.threadId });
const listThreads = () => {
  const t = needInternals();
  return threadsModel.toThreadList(t.registry.get(t.shells.threadShellsAtom), t.registry.get(t.projects.projectsAtom));
};
// Runs start(internals) once the patch has provided them; the result is the unsubscribe, safe
// to call more than once (a mod may stop a watch early, and unload stops it again).
function whenInternals(start) {
  let stop = null;
  let cancelled = false;
  get("threads.internals").then((t) => {
    if (!cancelled) stop = start(t);
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    stop?.();
  };
}
function watchThreadList(fn) {
  return whenInternals((t) => {
    let queued = false;
    const emit = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        fn(listThreads());
      });
    };
    const offs = [t.registry.subscribe(t.shells.threadShellsAtom, emit), t.registry.subscribe(t.projects.projectsAtom, emit)];
    emit();
    return () => offs.forEach((off) => off());
  });
}
// One shared list for React components (useSyncExternalStore needs a stable snapshot).
const threadList = { value: [], subs: new Set(), stop: null };
function subscribeThreadList(fn) {
  threadList.subs.add(fn);
  threadList.stop ??= watchThreadList((list) => {
    threadList.value = list;
    for (const sub of [...threadList.subs]) sub();
  });
  return () => {
    threadList.subs.delete(fn);
    if (threadList.subs.size === 0) {
      threadList.stop?.();
      threadList.stop = null;
    }
  };
}
// Questions, approvals and the last message of one thread. Mounting the detail atoms makes the
// app load the thread from the backend, as when the user opens it.
function watchThread(ref, fn) {
  return whenInternals((t) => {
    const projection = t.details.threadAtom(plainRef(ref));
    const pending = t.details.pendingRequestsAtom(plainRef(ref));
    const emit = () => {
      const p = t.registry.get(projection)?.projection;
      if (p) fn({ ...threadsModel.toPending(t.registry.get(pending)), lastMessage: threadsModel.lastAssistantMessage(p) });
    };
    const offs = [t.registry.subscribe(projection, emit), t.registry.subscribe(pending, emit)];
    emit();
    return () => offs.forEach((off) => off());
  });
}
// The open requests right now, loading the thread first when it is not loaded (at most 5 s).
async function pendingNow(ref) {
  const t = needInternals();
  const projection = t.details.threadAtom(plainRef(ref));
  const pending = t.details.pendingRequestsAtom(plainRef(ref));
  const offs = [t.registry.subscribe(projection, () => {}), t.registry.subscribe(pending, () => {})];
  try {
    for (let i = 0; i < 50 && !t.registry.get(projection); i++) await new Promise((r) => setTimeout(r, 100));
    if (!t.registry.get(projection)) throw new Error("the thread did not load");
    return threadsModel.toPending(t.registry.get(pending));
  } finally {
    offs.forEach((off) => off());
  }
}
async function runThreadCommand(name, ref, input) {
  const t = needInternals();
  const result = await t.commands[name].run(t.registry, { environmentId: ref.environmentId, input: { threadId: ref.threadId, ...input } });
  if (result?._tag === "Failure") throw new Error(threadsModel.failureText(result));
}
const threadsApi = (own) => ({
  available: () => Boolean(internals()),
  ready: () => get("threads.internals").then(() => undefined),
  list: listThreads,
  subscribe: (fn) => own(watchThreadList(fn)),
  useList: () => React().useSyncExternalStore(subscribeThreadList, () => threadList.value),
  watch: (ref, fn) => own(watchThread(ref, fn)),
  async answer(ref, requestId, answers) {
    const request = (await pendingNow(ref)).questions.find((q) => q.requestId === requestId);
    if (!request) throw new Error("This question was already answered, or it changed");
    await runThreadCommand("respondToUserInput", ref, { requestId, answers: threadsModel.checkAnswers(request.questions, answers) });
  },
  async approve(ref, requestId, decision) {
    const request = (await pendingNow(ref)).approvals.find((a) => a.requestId === requestId);
    if (!request) throw new Error("This approval was already answered, or it changed");
    if (!request.options.some((o) => o.decision === decision)) throw new Error(`"${decision}" is not a choice for this approval`);
    await runThreadCommand("respondToApproval", ref, { requestId, decision });
  },
  async send(ref, text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("the message is empty");
    const thread = listThreads().find((x) => x.ref.environmentId === ref.environmentId && x.ref.threadId === ref.threadId);
    if (!thread) throw new Error("no such thread");
    // dispatchMode "auto" (the default): a busy thread queues or steers, as the app's composer does.
    const message = { messageId: crypto.randomUUID(), role: "user", text, attachments: [] };
    await runThreadCommand("startTurn", ref, { message, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdAt: new Date().toISOString() });
  },
  stop: (ref) => runThreadCommand("interruptTurn", ref, {}),
  markSeen: (ref) => runThreadCommand("visit", ref, { visitedAt: new Date().toISOString() }),
  open(ref) {
    window.__TSR_ROUTER__?.navigate({ to: "/$environmentId/$threadId", params: plainRef(ref) });
  },
});

// Renderer exports of each mod; patches reach them as `$self`.
const exportsById = Object.create(null);

// main.cjs calls named exports of its mod's renderer.js through ctx.renderer().
async function callRenderer(id, method, args) {
  try {
    const fn = exportsById[id]?.[method];
    if (typeof fn !== "function") throw new Error(`no renderer export ${id}.${method}`);
    return { ok: true, value: await fn(...args) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

const warned = new Set();
function makeApi(mod, entry) {
  const { id } = mod;
  const own = (fn) => (entry.disposers.push(fn), fn);
  const lifecycle = {
    signal: entry.controller.signal,
    own,
    listen(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      return own(() => target.removeEventListener(type, handler, opts));
    },
    observe(target, options, callback) {
      const mo = new MutationObserver(callback);
      mo.observe(target, options);
      return own(() => mo.disconnect());
    },
  };
  const addSetting = (item) => {
    const key = `${id}:${Math.random().toString(36).slice(2)}`;
    settings.set(id, [...(settings.get(id) ?? []), { key, ...item }]);
    settingsChanged.emit();
    return own(() => {
      settings.set(id, (settings.get(id) ?? []).filter((s) => s.key !== key));
      settingsChanged.emit();
    });
  };
  const api = {
    id,
    // An older main process serves no app info (a kit is refreshed under a running app).
    app: index?.app ?? { id: "default", name: null, home: "" },
    log: (...a) => log(`[${id}]`, ...a),
    lifecycle,
    state: makeState(id, own),
    useCell,
    // Stable app values: React, ReactDOM, ReactDOMClient, jsx and ui.* components.
    get(key) {
      if (!STABLE.test(key) && !warned.has(`${id}:${key}`)) {
        warned.add(`${id}:${key}`);
        console.warn(`[t3mods] ${id}: api.get("${key}") reads an app internal; use api.unsafe.get`);
      }
      return get(key);
    },
    // App components exposed by core patches (Button, Switch, SidebarIconButton). Undefined
    // when the app changed and the core patch no longer applies.
    ui: new Proxy({}, { get: (_, k) => provided.get(`ui.${String(k)}`) }),
    // Render `Component` wherever the app has a slot: "timeline-row" ({ row }),
    // "sidebar-footer", "settings-mods". Props come from the app.
    slot(name, Component) {
      const key = `${id}:${name}:${Math.random().toString(36).slice(2)}`;
      setSlot(name, [...(slots.get(name) ?? EMPTY), { key, Component }]);
      return own(() => setSlot(name, (slots.get(name) ?? EMPTY).filter((s) => s.key !== key)));
    },
    css(text) {
      const el = document.createElement("style");
      el.dataset.t3mod = id;
      el.textContent = text;
      document.head.append(el);
      return own(() => el.remove());
    },
    // Run `fn(el)` for every current and future element matching `selector`.
    // fn may return a cleanup that runs when the mod is disposed.
    observe(selector, fn) {
      const seen = new WeakSet();
      const scan = () => {
        for (const el of document.querySelectorAll(selector)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const cleanup = fn(el);
          if (typeof cleanup === "function") own(cleanup);
        }
      };
      lifecycle.observe(document.documentElement, { childList: true, subtree: true }, scan);
      scan();
    },
    command({ id: cmdId, ...item }) {
      const key = `${id}.${cmdId}`;
      commands.set(key, { key, ...item });
      return own(() => commands.delete(key));
    },
    settings: {
      // A switch in the mod's card on the Mods settings page.
      toggle: ({ title, description, value }) => addSetting({ kind: "toggle", title, description, value }),
      // Free-form content in the mod's card.
      section: ({ title, component }) => addSetting({ kind: "section", title, component }),
    },
    server: () => remote("server", id, entry.controller.signal),
    main: () => remote("main", id, entry.controller.signal),
    threads: threadsApi(own),
    navigate: (to) => window.__TSR_ROUTER__?.navigate({ to }),
    // App internals without a stable contract: values provided by patches, and $self targets.
    unsafe: { get, provide, peek: (key) => provided.get(key), exports: exportsById },
    // Old names, kept for existing mods.
    onDispose: own,
    on: lifecycle.listen,
  };
  if (mod.builtin) api.admin = admin;
  return api;
}

// For builtin mods (the manager): the index and the loader's actions.
const admin = {
  index: () => index,
  refresh: refreshIndex,
  subscribe: indexChanged.subscribe,
  call: apiCall,
  settings: () => settings,
  settingsVersion: settingsChanged.version,
  subscribeSettings: settingsChanged.subscribe,
};

async function unload(id) {
  const m = loaded.get(id);
  if (!m) return;
  loaded.delete(id);
  m.controller.abort();
  for (const fn of m.disposers.reverse()) {
    try {
      await fn();
    } catch (e) {
      console.error(`[t3mods] dispose failed for ${id}`, e);
    }
  }
  const ex = exportsById[id];
  if (ex && id !== "core") for (const k of Object.keys(ex)) delete ex[k];
}

async function load(mod, version) {
  const entry = { disposers: [], controller: new AbortController() };
  loaded.set(mod.id, entry);
  const api = makeApi(mod, entry);
  const base = `/__mods/@${version}/${mod.base}`;
  try {
    if (mod.files.css) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${base}/style.css`;
      link.dataset.t3mod = mod.id;
      document.head.append(link);
      api.lifecycle.own(() => link.remove());
    }
    if (mod.files.renderer) {
      const module = await import(`${base}/renderer.js`);
      const { default: start, ...named } = module;
      Object.assign((exportsById[mod.id] ??= {}), named);
      const cleanup = await start?.(api);
      if (typeof cleanup === "function") api.lifecycle.own(cleanup);
    }
    log("loaded", mod.id);
  } catch (e) {
    console.error(`[t3mods] ${mod.id} failed; other mods keep running`, e);
    await unload(mod.id);
  }
}

const runnable = (m) => m.enabled && m.status === "ok" && (m.files.css || m.files.renderer);

async function boot() {
  await refreshIndex();
  for (const m of index.mods) if (m.status === "degraded") console.warn(`[t3mods] ${m.id} not started:`, m.problems.join("; "));
  await Promise.all(index.mods.filter(runnable).map((m) => load(m, index.version)));
}

// Called by the main process after a debounced fs.watch batch.
async function hotUpdate({ files, ids }) {
  const t0 = performance.now();
  await refreshIndex();
  const changed = new Set(ids);
  const ok = new Set(index.mods.filter(runnable).map((m) => m.id));
  for (const id of [...loaded.keys()]) if (!ok.has(id) || changed.has(id)) await unload(id);
  await Promise.all(index.mods.filter((m) => ok.has(m.id) && !loaded.has(m.id)).map((m) => load(m, index.version)));
  const ms = Math.round(performance.now() - t0);
  window.__t3mods.lastHotUpdate = { files, ms, at: Date.now() };
  log(`hot update in ${ms}ms`, files);
}

// ---------- core exports: what core patches reach as $self ----------
function ModsIcon(props) {
  const h = React().createElement;
  return h(
    "svg",
    { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props },
    h("path", { d: "M14 3h4a1 1 0 0 1 1 1v4a2 2 0 1 0 0 4v4a1 1 0 0 1-1 1h-4a2 2 0 1 0-4 0H6a1 1 0 0 1-1-1v-4a2 2 0 1 0 0-4V4a1 1 0 0 1 1-1h4a2 2 0 1 0 4 0Z" }),
  );
}
function SettingsPage() {
  return render("settings-mods", {});
}
exportsById.core = { render, paletteItems, provide, ModsIcon, SettingsPage };

window.__t3mods = {
  loaded,
  exports: exportsById,
  hotUpdate,
  unload,
  boot,
  provide,
  get,
  render,
  paletteItems,
  refreshIndex,
  callRenderer,
  stateChanged,
  lastHotUpdate: null,
  // Older mod patches render `__t3mods.Slot` directly.
  get Slot() {
    const R = React();
    return R ? (Slot ??= makeSlot(R)) : undefined;
  },
};

// The app publishes its React instances for Clerk on this global before mods need them, so
// no patch is required for React.
(function provideShared() {
  const m = globalThis.__clerkSharedModules;
  if (!m) return void setTimeout(provideShared, 16);
  provide("React", m.react);
  provide("ReactDOM", m["react-dom"]);
  provide("ReactDOMClient", m["react-dom/client"]);
  provide("jsx", m["react/jsx-runtime"]);
})();
boot();
