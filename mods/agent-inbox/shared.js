// Shared helpers for the Agent Inbox strip and panel pages.
//
// Preview mode: preview.html loads each page as `strip.html?preview` / `panel.html?preview`
// inside an iframe. With that query flag, `rpc` calls `window.parent.__inboxRpc(method, args, frameName)`
// instead of fetch. A page can also get a stub by setting `window.__inboxRpc` on its own window
// before the first rpc call; that takes priority. The stub gets the same args array that the real
// transport would send as the POST body, and it resolves with the value or throws to reject.

const PREVIEW = new URLSearchParams(location.search).has("preview");
const BASE = "/__mods/rpc/main/agent-inbox/";

export async function rpc(method, ...args) {
  const stub = window.__inboxRpc ?? (PREVIEW ? window.parent.__inboxRpc : null);
  if (stub) return stub(method, args, window.name);
  const res = await fetch(BASE + method, { method: "POST", body: JSON.stringify(args) });
  const reply = await res.json();
  if (!reply.ok) throw new Error(reply.error || `${method} failed`);
  return reply.value;
}

// Small DOM builder. All text goes in as text nodes, never as HTML.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (val == null || val === false) continue;
    if (key === "class") el.className = val;
    else if (key === "style") el.style.cssText = val;
    else if (key === "value") el.value = val;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), val);
    else el.setAttribute(key, val === true ? "" : String(val));
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

export const kbd = (text) => h("kbd", {}, text);

export const STATUS_LABEL = {
  working: "Working",
  approval: "Needs approval",
  input: "Waiting for your answer",
  done: "Finished",
  failed: "Failed",
  limited: "Limit reached",
  idle: "Idle",
};

export function statusLabel(status) {
  return STATUS_LABEL[status] ?? "Idle";
}

export function timeAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

// The status line on a card: "Finished 2 min ago", "Needs approval", ...
export function cardStatusLine(card) {
  if (card.kind === "done") return `Finished ${timeAgo(card.at)}`;
  if (card.kind === "failed") return "Failed";
  if (card.kind === "approval") return "Needs approval";
  return "Waiting for your answer";
}

// Tiny safe Markdown: paragraphs, bullet and numbered lines, headings (as bold lines),
// fenced code, `inline code` and **bold**. Builds DOM nodes, never HTML.
export function renderText(text) {
  const out = document.createDocumentFragment();
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para = [];
  let list = null;
  let code = null;
  const flushPara = () => {
    if (!para.length) return;
    const p = h("p");
    para.forEach((line, i) => {
      if (i) p.append(h("br"));
      inline(p, line);
    });
    out.append(p);
    para = [];
  };
  const flushList = () => {
    if (list) out.append(list);
    list = null;
  };
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (code) {
      if (fence) {
        out.append(h("pre", {}, code.join("\n")));
        code = null;
      } else code.push(line);
      continue;
    }
    if (fence) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      list ??= h("ul");
      const item = h("li");
      inline(item, li[1]);
      list.append(item);
      continue;
    }
    flushList();
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      flushPara();
      const p = h("p", { class: "hd" });
      inline(p, head[1]);
      out.append(p);
      continue;
    }
    para.push(line);
  }
  if (code) out.append(h("pre", {}, code.join("\n")));
  flushPara();
  flushList();
  return out;
}

function inline(parent, s) {
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) parent.append(s.slice(last, m.index));
    parent.append(m[1] != null ? h("code", {}, m[1]) : h("strong", {}, m[2]));
    last = re.lastIndex;
  }
  if (last < s.length) parent.append(s.slice(last));
}

// Plain text version for the peek card: markers removed, empty lines dropped.
export function toPlain(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*```/.test(l))
    .map((l) =>
      l
        .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .trim(),
    )
    .filter(Boolean);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
