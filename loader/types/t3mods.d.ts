// Types for t3mods mods. Use from JS with JSDoc:
//   /** @param {import("t3mods").RendererApi} api */
//   export default (api) => { ... }

import type * as React from "react";

/** mod.json */
export interface ModManifest {
  /** Folder name and stable id: letters, digits, ".", "_", "-". */
  id: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  /** false turns the mod off (the manager stores this in its own config instead). */
  enabled?: boolean;
  /** Mods ("core") or patches ("core/timeline-row") that must work; else the mod does not start. */
  requires?: string[];
}

// ---------- renderer.js ----------

export interface Cell<T> {
  readonly key: string;
  get(): T;
  set(next: T | ((current: T) => T)): void;
  /** Owned by the mod: removed on unload. Returns an early unsubscribe. Also called when another app changes the value. */
  subscribe(fn: (value: T) => void): () => void;
  /** Runs now and on each change, also one from another app; a returned function cleans up the previous run. */
  effect(fn: (value: T) => void | (() => void)): () => void;
}

/** Saved per mod in the mods folder, so all apps that share it see the same values. A save writes only the keys that changed. */
export interface StateApi {
  boolean(key: string, fallback: boolean): Cell<boolean>;
  number(key: string, fallback: number, range?: { min?: number; max?: number }): Cell<number>;
  string(key: string, fallback: string): Cell<string>;
  /** decode returns undefined for invalid stored values, which then read as the default. */
  value<T>(key: string, options: { default: T; decode: (raw: unknown) => T | undefined }): Cell<T>;
}

export interface Lifecycle {
  /** Aborted when the mod unloads (disable, hot reload, uninstall). */
  readonly signal: AbortSignal;
  /** Runs fn on unload. Returns fn. */
  own<F extends () => unknown>(fn: F): F;
  listen<K extends keyof WindowEventMap>(target: Window, type: K, handler: (e: WindowEventMap[K]) => void, options?: AddEventListenerOptions): () => void;
  listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): () => void;
  observe(target: Node, options: MutationObserverInit, callback: MutationCallback): () => void;
}

/** Core slot names and the props each one passes. */
export interface SlotProps {
  "timeline-row": { row: { kind: string; id: string; [key: string]: unknown } };
  "sidebar-footer": Record<string, never>;
  "settings-mods": Record<string, never>;
}

/** Promise-returning view of the methods a server.cjs or main.cjs returns. */
export type Remote<T> = {
  [K in keyof T as K extends "dispose" ? never : T[K] extends (...args: any[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export interface PaletteCommand {
  id: string;
  title: string;
  description?: string;
  searchTerms?: string[];
  run(): unknown;
}

// ---------- api.threads (core patch "threads") ----------

export interface ThreadRef {
  environmentId: string;
  threadId: string;
}

/** The app's own sidebar status. "waiting": the session is open but idle. */
export type ThreadStatus = "working" | "waiting" | "approval" | "input" | "failed" | "limited" | "ready";

export interface ThreadInfo {
  /** `${environmentId}/${threadId}`: stable and unique, for maps and DOM keys. */
  key: string;
  ref: ThreadRef;
  title: string;
  projectId: string;
  /** The project's title; null for an unknown project. */
  project: string | null;
  status: ThreadStatus;
  /** Finished after the user last opened it (false for a thread never opened, as in the app). */
  unread: boolean;
  subagent: boolean;
  parentThreadId: string | null;
  archived: boolean;
  settled: boolean;
  snoozedUntil: string | null;
  pinned: boolean;
  branch: string | null;
  /** Status of the latest run ("running", "completed", "failed", ...), null before the first run. */
  runStatus: string | null;
  runId: string | null;
  completedAt: string | null;
  lastVisitedAt: string | null;
  updatedAt: string;
  /** The runtime's last error, e.g. after a failed run. */
  error: string | null;
  errorClass: string | null;
  provider: string | null;
  model: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
}

export interface ThreadQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  /** A typed answer is allowed besides the options. */
  allowCustom: boolean;
  /** `value` is what answer() takes (the label when the agent gave no value). */
  options: { label: string; description: string; value: string }[];
}

export interface ThreadDetail {
  /** Open user-input requests; each holds one or more questions answered together. */
  questions: { requestId: string; createdAt: string; questions: ThreadQuestion[] }[];
  /** Open approval requests (commands, file changes, tool access). */
  approvals: {
    requestId: string;
    /** "command", "file-change", "file-read", "mcp-elicitation", ... */
    kind: string;
    detail: string | null;
    appName: string | null;
    createdAt: string;
    /** `decision` is what approve() takes: "accept", "acceptForSession", "decline", ... */
    options: { decision: string; label: string; warning: string | null }[];
  }[];
  /** The agent's last message (Markdown), or null. */
  lastMessage: string | null;
}

/** The app's threads and thread commands. Needs the core/threads patch: add it to `requires`. */
export interface ThreadsApi {
  /** false until the app's thread stores loaded, or when this build lacks the patch. */
  available(): boolean;
  ready(): Promise<void>;
  /** Every thread (subagents and archived ones included), newest first. Throws when not available. */
  list(): ThreadInfo[];
  /** Calls fn with the list now and on each change. Owned by the mod; returns an early unsubscribe. */
  subscribe(fn: (threads: ThreadInfo[]) => void): () => void;
  /** React hook: the list; re-renders on change. */
  useList(): ThreadInfo[];
  /** Loads one thread like the app does when it is opened, and calls fn on each change. Owned. */
  watch(ref: ThreadRef, fn: (detail: ThreadDetail) => void): () => void;
  /** Rejects when the request is no longer open or an answer is missing or not an option. */
  answer(ref: ThreadRef, requestId: string, answers: Record<string, string | string[]>): Promise<void>;
  /** Rejects when the request is no longer open or the decision is not one of its options. */
  approve(ref: ThreadRef, requestId: string, decision: string): Promise<void>;
  /** A new message; a busy thread queues or steers it, as the composer does. */
  send(ref: ThreadRef, text: string): Promise<void>;
  /** Interrupts the running turn. */
  stop(ref: ThreadRef): Promise<void>;
  /** Marks the thread as seen now, so it is no longer unread. */
  markSeen(ref: ThreadRef): Promise<void>;
  /** Shows the thread in the app window. */
  open(ref: ThreadRef): void;
}

/** Which T3 Code app this is. Several apps can run at once, each with its own data folder, and share one mods folder. */
export interface AppInfo {
  /** "default" for the app that uses ~/.t3; otherwise a short stable hash of its data folder. */
  id: string;
  /** Display name: T3MODS_APP_NAME when set; null for the default app; else from the data folder name (".t3-work" -> "Work"). */
  name: string | null;
  /** The app's data folder: T3CODE_HOME, or ~/.t3. */
  home: string;
}

export interface RendererApi {
  readonly id: string;
  /** This app. Mod state is shared by all apps; threads are not. An older main process gives { id: "default", name: null, home: "" }. */
  readonly app: AppInfo;
  log(...args: unknown[]): void;
  lifecycle: Lifecycle;
  state: StateApi;
  /** React hook: the cell's current value; re-renders on change. */
  useCell<T>(cell: Cell<T>): T;
  /** Stable values. Other keys are app internals: use unsafe.get. */
  get(key: "React"): Promise<typeof React>;
  get(key: "ReactDOM" | "ReactDOMClient" | "jsx"): Promise<any>;
  get(key: `ui.${string}`): Promise<React.ComponentType<any>>;
  /** App components from core patches; undefined when this T3 Code build changed them. */
  ui: {
    Button?: React.ComponentType<{ variant?: "default" | "destructive" | "ghost" | "outline" | "secondary" | "link"; size?: "default" | "sm" | "xs" | "lg" | "icon" | "compact" } & React.ButtonHTMLAttributes<HTMLButtonElement>>;
    Switch?: React.ComponentType<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void; disabled?: boolean; "aria-label"?: string }>;
    SidebarIconButton?: React.ComponentType<{ icon: React.ReactNode; label: string; onClick(): void }>;
    [name: string]: React.ComponentType<any> | undefined;
  };
  slot<N extends keyof SlotProps>(name: N, component: React.ComponentType<SlotProps[N]>): () => void;
  slot(name: string, component: React.ComponentType<any>): () => void;
  css(text: string): () => void;
  /** fn runs for every current and future match; it may return a cleanup. */
  observe(selector: string, fn: (el: Element) => void | (() => void)): void;
  command(command: PaletteCommand): () => void;
  settings: {
    toggle(item: { title: string; description?: string; value: Cell<boolean> }): () => void;
    section(item: { title?: string; component: React.ComponentType }): () => void;
  };
  /** Calls methods that this mod's server.cjs returns. */
  server<T = Record<string, (...args: any[]) => unknown>>(): Remote<T>;
  /** Calls methods that this mod's main.cjs returns (main changes need a restart). */
  main<T = Record<string, (...args: any[]) => unknown>>(): Remote<T>;
  /** The app's threads: status, questions, approvals, and commands to answer them. */
  threads: ThreadsApi;
  navigate(to: string): void;
  /** App internals with no stable contract. They can change in any T3 Code build. */
  unsafe: {
    get<T = unknown>(key: string): Promise<T>;
    provide<T>(key: string, value: T): T;
    peek<T = unknown>(key: string): T | undefined;
    exports: Record<string, Record<string, unknown>>;
  };
  /** @deprecated use lifecycle.own */
  onDispose<F extends () => unknown>(fn: F): F;
  /** @deprecated use lifecycle.listen */
  on(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): () => void;
}

export type RendererEntry = (api: RendererApi) => void | (() => void) | Promise<void | (() => void)>;

// ---------- server.cjs / main.cjs ----------

/** Something with Node's EventEmitter on/removeListener: `app`, `screen`, a BrowserWindow, `process`. */
export interface Emitter {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): unknown;
}

/**
 * Cleanups that run when the mod stops (hot reload, turned off, uninstalled), after the
 * entry's own cleanup or dispose, newest first. Loader 0.4.0 and later; older loaders have none.
 */
export interface TierLifecycle {
  /** Aborted when the mod stops. */
  readonly signal: AbortSignal;
  /** Runs fn when the mod stops. Returns fn. After the stop it runs fn at once. */
  own<F extends () => unknown>(fn: F): F;
  /** emitter.on(event, listener) until the mod stops. Returns a function that removes it now. */
  listen(emitter: Emitter, event: string | symbol, listener: (...args: any[]) => void): () => void;
}

export interface TierContext {
  readonly id: string;
  readonly dir: string;
  /** The app that runs this tier (the backend of one app, or its main process). */
  readonly app: AppInfo;
  log(...args: unknown[]): void;
  /** The mod's saved state, read from disk on each call (read-only here; the renderer writes it). */
  state(): Record<string, unknown>;
  /** Missing on loaders older than 0.4.0. */
  readonly lifecycle: TierLifecycle;
}
export interface MainContext extends TierContext {
  electron: typeof import("electron");
  /**
   * Calls named exports of this mod's renderer.js in the app window. Arguments and results
   * cross as JSON-like values; a call rejects when the app window or the mod is not loaded.
   * Pages that main.cjs opens from the mod folder (t3code://app/__mods/<id>/page.html) get no
   * mod API: they call main through fetch("/__mods/rpc/main/<id>/<method>").
   */
  renderer<T = Record<string, (...args: any[]) => unknown>>(): Remote<T>;
}

/**
 * Return a cleanup function, or an object of methods (+ optional dispose) for api.server().
 * The cleanup, then ctx.lifecycle, runs before a hot reload and when the mod is turned off.
 */
export type ServerEntry = (ctx: TierContext) => void | (() => void) | ({ dispose?(): void } & Record<string, (...args: any[]) => unknown>);
/**
 * Like ServerEntry, for api.main(). With a cleanup function or dispose, main.cjs hot-reloads:
 * a save of it, of a file it required or of an .mjs file in the mod folder stops it and loads
 * it again, and turning the mod off stops it. The cleanup must release what the mod made
 * (windows, global shortcuts, timers, servers); listeners added with ctx.lifecycle.listen go by
 * themselves. Without a cleanup, main.cjs loads once and a change needs a restart.
 */
export type MainEntry = (ctx: MainContext) => void | (() => void) | ({ dispose?(): void } & Record<string, (...args: any[]) => unknown>);

// ---------- patches.cjs ----------

export interface Patch {
  /** Stable name for requires ("<mod>/<id>"); defaults to the array index. */
  id?: string;
  /** Selects the chunk; must match exactly one. */
  find: string | RegExp;
  /** `\i` matches a minified identifier; `$self` is this mod's renderer exports. */
  replace?: { match: RegExp | string; flags?: string; replace: string | ((substring: string, ...groups: string[]) => string) }[];
  transform?(text: string, helpers: { self: string }): string;
  /** All entries apply, or none. */
  group?: boolean;
  /** A failure does not stop the mod. */
  optional?: boolean;
  /** Evaluated when patches load; state is the mod's saved state. */
  predicate?(ctx: { state: Record<string, unknown> }): boolean;
}

/** One entry of a server-patches.cjs array: a Patch on the backend's chunks. `$self` has no meaning there. */
export type ServerPatch = Patch;
