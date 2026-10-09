// Calm thread: finished turns read as one-line titles; open one to see prompt, receipt and answer.
// patches.cjs calls `calmRows` with T3's timeline rows; logic.mjs does the row work.
// Density (Alt+D): Focus folds every finished turn but the latest, Normal keeps them open,
// Full also opens T3's work folds and tool groups.
import { createElement as h, useState, useSyncExternalStore } from "react";
import { MODES, calmRows as deriveCalmRows } from "./logic.mjs";

const MODE_LABEL = { focus: "Focus", normal: "Normal", full: "Full" };
// "Since you left" shows after this much time away.
const AWAY_MS = 10 * 60_000;

// Same shape as the store patches.cjs creates; whichever runs first makes it.
const store = (globalThis.__t3modCalm ??= (() => {
  const s = { v: 0, full: false, all: { has: () => true }, l: new Set() };
  s.sub = (f) => (s.l.add(f), () => s.l.delete(f));
  s.get = () => s.v;
  s.bump = () => {
    s.v++;
    s.l.forEach((f) => f());
  };
  return s;
})());

let active = null;
let inspect = null;

/** For checks from the dev tools: the mod's current view state. */
export function calmDebug() {
  return inspect?.() ?? null;
}

/** Called by patches.cjs inside T3's rows memo. Returns null to keep T3's rows. */
export function calmRows(rows, ctx) {
  return active ? active(rows, ctx) : null;
}

const threadIdOf = (key) => String(key ?? "").slice(String(key ?? "").indexOf(":") + 1);

function ago(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  const mode = api.state.value("mode", { default: "focus", decode: (raw) => (MODES.includes(raw) ? raw : undefined) });
  // Off by default: it sends prompts and answers to the endpoint set below.
  const model = api.state.boolean("modelTitles", false);
  const brief = api.state.boolean("sinceYouLeft", true);
  const width = api.state.boolean("readableWidth", true);
  const modelUrl = api.state.string("modelUrl", "");
  const keyFile = api.state.string("keyFile", "");
  const modelName = api.state.string("model", "");

  /** threadKey -> Map<turnId, open> */
  const overrides = new Map();
  /** messageId -> { title, needs, withNeeds } */
  const titles = new Map();
  const pending = new Set();
  let modelError = null;
  /** threadId -> { cur, prev } lastVisitedAt values, newest first */
  const visits = new Map();
  /** threadId -> T3 status */
  const statuses = new Map();
  let shown = { key: null, since: null };
  const dismissed = new Set();
  const synthetic = new Map();

  const bump = () => store.bump();

  api.threads
    .ready()
    .then(() => {
      api.threads.subscribe((threads) => {
        let changed = false;
        for (const t of threads) {
          const id = t.ref.threadId;
          const rec = visits.get(id);
          if (!rec) visits.set(id, { cur: t.lastVisitedAt, prev: null });
          else if (rec.cur !== t.lastVisitedAt) visits.set(id, { cur: t.lastVisitedAt, prev: rec.cur });
          if (statuses.get(id) !== t.status) {
            if (id === threadIdOf(shown.key)) changed = true;
            statuses.set(id, t.status);
          }
        }
        if (changed) bump();
      });
    })
    .catch((e) => api.log("threads unavailable; no 'Since you left' card or open-question mark", e));

  // The visit before this one: T3 may already have stamped the current open.
  function sinceFor(threadId) {
    const rec = visits.get(threadId);
    if (!rec) return null;
    const recent = (iso) => iso && Date.now() - Date.parse(iso) < 15_000;
    const since = recent(rec.cur) ? rec.prev : rec.cur;
    return since && Date.now() - Date.parse(since) >= AWAY_MS ? since : null;
  }

  function needsYou(threadId) {
    const status = statuses.get(threadId);
    if (status === "input") return "Answer the question";
    if (status === "approval") return "Approve or decline";
    return null;
  }

  async function requestTitles(wants) {
    const server = api.server();
    for (const want of wants) {
      const key = `${want.id}:${want.needs}`;
      if (pending.has(key) || modelError) continue;
      pending.add(key);
      server
        .title(want)
        .then((r) => {
          titles.set(want.id, { title: r.title, needs: r.needs, withNeeds: want.needs || titles.get(want.id)?.withNeeds === true });
          bump();
        })
        .catch((e) => {
          // One failure (no key, endpoint down) stops requests until a setting changes.
          modelError = String(e?.message ?? e);
          api.log("model title failed:", modelError);
        })
        .finally(() => pending.delete(key));
    }
  }
  for (const cell of [model, modelUrl, keyFile, modelName]) cell.subscribe(() => ((modelError = null), bump()));

  // T3 caches each row's markup by row id (React Compiler), so a slot can get stale props.
  // The slot reads its row from `latest` instead and redraws when a row it shows changes.
  // Rows keep their identity while their content stays the same.
  const latest = new Map();
  const rowListeners = new Set();
  let notify = false;
  function stable(row) {
    if (row.kind !== "calm-title" && row.kind !== "calm-brief") return row;
    const sig = JSON.stringify(row);
    const prev = synthetic.get(row.id);
    if (prev && prev.sig === sig) return prev.row;
    synthetic.set(row.id, { sig, row });
    latest.set(row.id, row);
    notify = true;
    return row;
  }
  const subscribeRows = (f) => (rowListeners.add(f), () => rowListeners.delete(f));
  const useLatest = (row) => useSyncExternalStore(subscribeRows, () => latest.get(row.id) ?? row);

  active = (rows, ctx) => {
    try {
      if (ctx.threadKey !== shown.key) {
        shown = { key: ctx.threadKey, since: sinceFor(threadIdOf(ctx.threadKey)) };
        synthetic.clear();
        latest.clear();
      }
      const threadId = threadIdOf(ctx.threadKey);
      const view = {
        mode: mode.get(),
        overrides: overrides.get(ctx.threadKey),
        titles,
        needsYou: needsYou(threadId),
        since: shown.since,
        brief: brief.get(),
        dismissed: dismissed.has(`${ctx.threadKey}|${shown.since}`),
        model: model.get() && !modelError,
      };
      const out = deriveCalmRows(rows, ctx, view);
      if (out.wants.length) queueMicrotask(() => requestTitles(out.wants));
      const next = out.rows.map(stable);
      // Not during T3's render: tell the slots after it.
      if (notify) {
        notify = false;
        queueMicrotask(() => rowListeners.forEach((f) => f()));
      }
      return next;
    } catch (e) {
      api.log("calmRows failed; showing T3's rows", e);
      return null;
    }
  };
  inspect = () => ({ mode: mode.get(), titles: Object.fromEntries(titles), pending: [...pending], modelError, shown, overrides: [...overrides].map(([k, m]) => [k, [...m]]) });
  api.lifecycle.own(() => {
    inspect = null;
    active = null;
    store.full = false;
    bump();
  });

  function toggleTurn(threadKey, turnId, open) {
    const map = overrides.get(threadKey) ?? new Map();
    map.set(turnId, !open);
    overrides.set(threadKey, map);
    bump();
  }

  // ---------- density ----------
  let toast = null;
  function showMode(next) {
    toast?.remove();
    toast = document.createElement("div");
    toast.className = "t3mod-calm-toast";
    toast.textContent = MODE_LABEL[next];
    document.body.append(toast);
    const el = toast;
    setTimeout(() => el.remove(), 1100);
  }
  function setMode(next, announce) {
    mode.set(next);
    if (announce) showMode(next);
  }
  mode.effect((m) => {
    store.full = m === "full";
    overrides.clear();
    document.documentElement.setAttribute("data-t3mod-calm", m);
    bump();
    return () => document.documentElement.removeAttribute("data-t3mod-calm");
  });
  width.effect((on) => {
    if (!on) return;
    document.documentElement.setAttribute("data-t3mod-calm-width", "");
    return () => document.documentElement.removeAttribute("data-t3mod-calm-width");
  });
  api.lifecycle.listen(
    window,
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== "KeyD") return;
      e.preventDefault();
      e.stopPropagation();
      setMode(MODES[(MODES.indexOf(mode.get()) + 1) % MODES.length], true);
    },
    { capture: true },
  );
  for (const m of MODES) {
    api.command({ id: m, title: `Calm thread: ${MODE_LABEL[m]}`, searchTerms: ["density", "calm", "focus"], run: () => setMode(m, true) });
  }

  // ---------- rows ----------
  function TitleRow({ row }) {
    const meta = [row.duration, clock(row.at)].filter(Boolean).join(" · ");
    return h(
      "button",
      {
        type: "button",
        className: "t3mod-calm-title",
        "data-open": row.open ? "" : undefined,
        "data-from-prompt": row.fromPrompt ? "" : undefined,
        "aria-expanded": row.open,
        title: row.open ? "Fold this turn" : "Open this turn",
        onClick: () => toggleTurn(row.threadKey, row.turnId, row.open),
      },
      h("span", { className: "t3mod-calm-chevron", "aria-hidden": true }, row.open ? "▾" : "▸"),
      h("span", { className: "t3mod-calm-text" }, row.title),
      row.failed ? h("span", { className: "t3mod-calm-failed" }, "failed") : null,
      row.needs ? h("span", { className: "t3mod-calm-needs" }, row.needs) : null,
      h("span", { className: "t3mod-calm-meta" }, meta),
    );
  }

  function BriefRow({ row }) {
    const line = (label, text, cls) => (text ? h("div", { className: `t3mod-calm-line ${cls ?? ""}` }, h("b", null, label), h("span", null, text)) : null);
    const list = (items) => (items.length > 3 ? `${items.slice(0, 3).join(" · ")} · +${items.length - 3} more` : items.join(" · "));
    return h(
      "section",
      { className: "t3mod-calm-brief", "aria-label": "Since you left" },
      h(
        "header",
        null,
        h("span", null, `Since you left · ${ago(row.since)}`),
        h(
          "button",
          {
            type: "button",
            onClick: () => {
              dismissed.add(`${row.threadKey}|${row.since}`);
              bump();
            },
          },
          "Dismiss",
        ),
      ),
      line("Done", list(row.done)),
      line("Needs you", row.needs, "t3mod-calm-line-needs"),
      line("Running", row.running),
      line("Failed", row.failed.length ? list(row.failed) : null, "t3mod-calm-line-failed"),
    );
  }

  function Latest({ row, View }) {
    return h(View, { row: useLatest(row) });
  }
  api.slot("timeline-row", function CalmRow({ row }) {
    if (row.kind === "calm-title") return h(Latest, { row, View: TitleRow });
    if (row.kind === "calm-brief") return h(Latest, { row, View: BriefRow });
    return null;
  });

  // ---------- settings ----------
  api.settings.section({
    title: "Density",
    component: function Density() {
      const current = api.useCell(mode);
      return h(
        "div",
        { className: "t3mod-calm-seg", role: "radiogroup", "aria-label": "Density" },
        MODES.map((m) =>
          h("button", { key: m, type: "button", role: "radio", "aria-checked": current === m, onClick: () => setMode(m, false) }, MODE_LABEL[m]),
        ),
        h("span", { className: "t3mod-calm-hint" }, "Alt+D cycles"),
      );
    },
  });
  api.settings.toggle({ title: "Model titles", description: "When an answer's first sentence makes a poor title, a small model writes one. It also names what the latest answer waits on.", value: model });
  api.settings.toggle({ title: "Since you left", description: "After 10 minutes away, a card at the end of the thread lists what finished and what waits on you.", value: brief });
  api.settings.toggle({ title: "Readable width", description: "Answers wrap at about 70 characters. Code and tables keep the full width.", value: width });
  api.settings.section({
    title: "Model endpoint",
    component: function Endpoint() {
      const [status, setStatus] = useState(null);
      const field = (cell, label, placeholder) =>
        h(
          "label",
          { className: "t3mod-calm-field" },
          h("span", null, label),
          h("input", {
            defaultValue: cell.get(),
            placeholder,
            spellCheck: false,
            onBlur: (e) => cell.set(e.currentTarget.value.trim()),
          }),
        );
      return h(
        "div",
        { className: "t3mod-calm-fields" },
        field(modelUrl, "URL", "ANTHROPIC_BASE_URL or https://api.anthropic.com"),
        field(keyFile, "Key file", "ANTHROPIC_API_KEY"),
        field(modelName, "Model", "claude-haiku-5-5"),
        h(
          "button",
          {
            type: "button",
            onClick: () =>
              api
                .server()
                .status()
                .then((s) => setStatus(s.configured ? `Ready: ${s.model} at ${s.url}, ${s.cached} titles saved` : "Not configured: set a key file or ANTHROPIC_API_KEY"))
                .catch((e) => setStatus(String(e?.message ?? e))),
          },
          "Check",
        ),
        status || modelError ? h("span", { className: "t3mod-calm-hint" }, status ?? `Last error: ${modelError}`) : null,
      );
    },
  });
};
