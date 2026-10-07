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
  /** Owned by the mod: removed on unload. Returns an early unsubscribe. */
  subscribe(fn: (value: T) => void): () => void;
  /** Runs now and on each change; a returned function cleans up the previous run. */
  effect(fn: (value: T) => void | (() => void)): () => void;
}

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

export interface RendererApi {
  readonly id: string;
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

export interface TierContext {
  readonly id: string;
  readonly dir: string;
  log(...args: unknown[]): void;
  /** The mod's saved state (read-only here; the renderer writes it). */
  state(): Record<string, unknown>;
}
export interface MainContext extends TierContext {
  electron: typeof import("electron");
}

/** Return a cleanup function, or an object of methods (+ optional dispose) for api.server(). */
export type ServerEntry = (ctx: TierContext) => void | (() => void) | ({ dispose?(): void } & Record<string, (...args: any[]) => unknown>);
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
