// Ctrl+F finds text in the open thread. The timeline is virtualized: rows out of view are not
// in the DOM. So matches come from the row data (patches.cjs hands each timeline list and its
// rows to `track`), navigation scrolls the list to the row, and the CSS Custom Highlight API
// marks the matches in the rows on screen. Without the patch, only rows on screen are searched.

// Survives hot reload: lists register again only when the timeline renders.
const lists = (globalThis[Symbol.for("t3mod.find-in-thread.lists")] ??= new Map());
const wrappers = new WeakMap();
let onRows = null;

/**
 * Called by the patched timeline on each render with the list's ref and its rows. The ref is
 * an object ref, or (newer builds) a callback ref: that one is wrapped once, so the wrapper
 * stays stable across renders, and the returned `{ ref }` replaces it in the list's props.
 */
export function track(ref, rows) {
  let key = ref;
  let props;
  if (typeof ref === "function") {
    let wrapper = wrappers.get(ref);
    if (!wrapper) {
      const holder = { current: null };
      wrapper = Object.assign((handle) => ((holder.current = handle), ref(handle)), { holder });
      wrappers.set(ref, wrapper);
    }
    key = wrapper.holder;
    props = { ref: wrapper };
  }
  if (lists.get(key) !== rows) {
    lists.set(key, rows);
    onRows?.();
  }
  return props;
}

const HL = "t3mod-find";
const HL_CURRENT = "t3mod-find-current";
const isMac = navigator.platform.startsWith("Mac");
const ROW = "[data-timeline-row-id]";

// Searchable text of a timeline row, as close as the data gets to what the row shows.
function rowText(row) {
  if (row?.kind === "message") return row.message?.text ?? "";
  if (row?.kind === "work") {
    return (row.groupedEntries ?? []).map((e) => [e.toolTitle || e.label, e.command, e.detail].filter(Boolean).join("\n")).join("\n");
  }
  return "";
}

function count(text, q) {
  let n = 0;
  const hay = text.toLowerCase();
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) n++;
  return n;
}

// Ranges of every match in an element's visible text. Text nodes are joined first, so a match
// that crosses inline markup or syntax-highlight spans is found too.
function rangesIn(el, q) {
  const nodes = [];
  const starts = [];
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest("style,script,textarea,[aria-hidden=true],.sr-only")) return NodeFilter.FILTER_REJECT;
      return p.checkVisibility?.() === false ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const lower = n.data.toLowerCase();
    nodes.push(n);
    starts.push(text.length);
    text += lower.length === n.data.length ? lower : n.data;
  }
  const at = (pos, end) => {
    let i = starts.length - 1;
    while (i > 0 && (starts[i] > pos || (end && starts[i] === pos))) i--;
    return [nodes[i], pos - starts[i]];
  };
  const out = [];
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
    const r = new Range();
    r.setStart(...at(i, false));
    r.setEnd(...at(i + q.length, true));
    if (!clipped(r, el)) out.push(r);
  }
  return out;
}

const scrolls = (el) => {
  const { overflowX, overflowY } = getComputedStyle(el);
  return (/auto|scroll/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) || (/auto|scroll/.test(overflowX) && el.scrollWidth > el.clientWidth + 1);
};

// True when a box that cannot scroll (text cut off with an ellipsis, a collapsed preview) hides
// the match, so no scrolling can show it.
function clipped(range, row) {
  const box = range.getBoundingClientRect();
  if (!box.width && !box.height) return true;
  for (let el = range.startContainer.parentElement; el && el !== row; el = el.parentElement) {
    if (scrolls(el)) return false;
    const { overflowX, overflowY } = getComputedStyle(el);
    if (overflowX === "visible" && overflowY === "visible") continue;
    const view = el.getBoundingClientRect();
    if (box.left >= view.right - 1 || box.right <= view.left + 1 || box.top >= view.bottom - 1 || box.bottom <= view.top + 1) return true;
  }
  return false;
}

const visible = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

// Open timelines: { ref, rows, node } from the patch; { node } (rows on screen only) without it.
function panes() {
  const out = [];
  for (const [ref, rows] of lists) {
    if (!ref.current) {
      lists.delete(ref);
      continue;
    }
    const node = ref.current.getScrollableNode?.();
    if (node?.isConnected && visible(node)) out.push({ ref, rows, node });
  }
  if (out.length) return out;
  return [...document.querySelectorAll("[data-assistant-citation-viewport]")].filter(visible).map((node) => ({ node }));
}

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  const { lifecycle } = api;
  let lastPointer = null;
  lifecycle.listen(window, "pointerdown", (e) => (lastPointer = e.target), { capture: true });

  // The pane that holds the focus (the composer counts), else the one last clicked.
  function pickPane() {
    const all = panes();
    for (const start of [document.activeElement, lastPointer]) {
      for (let el = start instanceof Element ? start : null; el && el !== document.body; el = el.parentElement) {
        const hit = all.find((p) => el.contains(p.node));
        if (hit) return hit;
      }
    }
    return all[0] ?? null;
  }

  let s = null; // open session: { pane, path, bar, input, countEl, query, matches, index, ... }

  function buildBar() {
    const bar = document.createElement("div");
    bar.className = "t3mod-find";
    bar.setAttribute("role", "search");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find in thread";
    input.setAttribute("aria-label", "Find in thread");
    input.spellcheck = false;
    const countEl = document.createElement("span");
    countEl.className = "t3mod-find__count";
    countEl.setAttribute("aria-live", "polite");
    const button = (label, path, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
      b.addEventListener("click", onClick);
      return b;
    };
    const prev = button("Previous match (Shift+Enter)", "m18 15-6-6-6 6", () => step(-1));
    const next = button("Next match (Enter)", "m6 9 6 6 6-6", () => step(1));
    const close = button("Close (Esc)", "M18 6 6 18M6 6l12 12", () => closeFind());
    bar.append(input, countEl, prev, next, close);
    input.addEventListener("input", () => search(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
      else if (e.key === "Escape") closeFind();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    return { bar, input, countEl, prev, next };
  }

  function place() {
    if (!s) return;
    const r = s.pane.node.getBoundingClientRect();
    s.bar.style.top = `${Math.max(r.top, 0) + 8}px`;
    s.bar.style.right = `${Math.max(window.innerWidth - r.right, 0) + 20}px`;
  }

  function openFind() {
    const pane = pickPane();
    if (!pane) return false;
    const picked = window.getSelection()?.toString().trim();
    if (s && s.pane.node !== pane.node) closeFind();
    if (!s) {
      s = { pane, path: location.pathname, query: "", matches: [], index: -1, seen: new Map(), ranges: new Map(), ...buildBar() };
      document.body.append(s.bar);
      s.stop = [lifecycle.listen(window, "resize", schedulePaint)];
      attach();
      onRows = () => {
        clearTimeout(s?.rowsTimer);
        if (s) s.rowsTimer = setTimeout(() => search(false), 150);
      };
    } else {
      s.pane = pane;
      attach();
    }
    place();
    if (picked && !picked.includes("\n") && picked.length <= 200) {
      s.input.value = picked;
      search(true);
    }
    s.input.focus();
    s.input.select();
    return true;
  }

  function closeFind() {
    if (!s) return;
    clearTimeout(s.rowsTimer);
    clearTimeout(s.frame);
    for (const stop of [...s.stop, ...(s.watch ?? [])]) stop();
    s.bar.remove();
    s = null;
    onRows = null;
    CSS.highlights?.delete(HL);
    CSS.highlights?.delete(HL_CURRENT);
  }
  lifecycle.own(closeFind);

  // Repaints when the pane's rows change or scroll. The list can swap its scroll node, so this
  // runs again whenever the pane is re-read.
  function attach() {
    if (s.watched === s.pane.node) return;
    for (const stop of s.watch ?? []) stop();
    s.watched = s.pane.node;
    const root = s.pane.node.closest("[data-assistant-citation-viewport]") ?? s.pane.node;
    s.watch = [
      lifecycle.observe(root, { childList: true, subtree: true, characterData: true }, schedulePaint),
      lifecycle.listen(s.pane.node, "scroll", schedulePaint, { passive: true }),
    ];
  }

  // Scrolls the boxes between a match and the list (code blocks scroll on their own), then the
  // list, so the match ends up in view.
  function scrollIntoView(target) {
    const node = s.pane.node;
    for (let el = target instanceof Range ? target.startContainer.parentElement : target.parentElement; el && el !== node && node.contains(el); el = el.parentElement) {
      if (!scrolls(el)) continue;
      const box = target.getBoundingClientRect();
      const view = el.getBoundingClientRect();
      if (box.top < view.top || box.bottom > view.bottom) el.scrollTop += box.top - (view.top + view.height / 2);
      if (box.left < view.left || box.right > view.right) el.scrollLeft += box.left - (view.left + view.width / 2);
    }
    const box = target.getBoundingClientRect();
    const view = node.getBoundingClientRect();
    if (box.top < view.top + 48 || box.bottom > view.bottom - 24 || covered(box)) node.scrollBy({ top: box.top - (view.top + view.height / 3), behavior: "instant" });
  }

  // Something else (the composer floats over the list's bottom, the find bar over its top) is
  // on top of the match.
  function covered(box) {
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !hit || !s.pane.node.contains(hit);
  }

  // Match list: one entry per occurrence, { rowId, rowIndex, k } (k-th match in its row).
  // A row counts its matches in the DOM once it has been on screen (s.seen), since the data can
  // miss text the row shows (loaded later) or differ from it (Markdown); until then, in its data.
  function collect() {
    const out = [];
    const push = (rowId, rowIndex, n) => {
      for (let k = 0; k < n; k++) out.push({ rowId, rowIndex, k });
    };
    if (s.pane.rows) s.pane.rows.forEach((row, i) => push(row.id, i, s.seen.get(row.id) ?? count(rowText(row), s.query)));
    else for (const id of s.seen.keys()) push(id, -1, s.seen.get(id));
    return out;
  }

  // Rebuilds the match list and keeps the current match when it still exists.
  function remap() {
    const old = s.matches[s.index];
    s.matches = s.query ? collect() : [];
    // Same match, else the first one at or after where it was (its row lost matches).
    let same = old ? s.matches.findIndex((m) => m.rowId === old.rowId && m.k === old.k) : -1;
    if (same < 0 && old && old.rowIndex >= 0) same = s.matches.findIndex((m) => m.rowIndex > old.rowIndex || (m.rowIndex === old.rowIndex && m.k >= old.k));
    s.index = same >= 0 ? same : s.matches.length ? Math.max(0, Math.min(s.index, s.matches.length - 1)) : -1;
  }

  // reset: the query changed, so go to the first match. Otherwise (new rows while the agent
  // works, or a re-render) keep the current match and do not scroll.
  function search(reset) {
    if (!s) return;
    if (location.pathname !== s.path) return closeFind();
    // Re-read the pane: the list may have re-rendered with new rows since the bar opened.
    const fresh = panes().find((p) => p.node === s.pane.node);
    if (fresh) s.pane = fresh;
    attach();
    if (reset) {
      s.query = s.input.value.toLowerCase();
      s.seen = new Map();
      s.matches = [];
      s.index = 0;
    }
    measure();
    remap();
    if (reset && s.matches.length) return reveal();
    paint();
  }

  function step(dir) {
    if (!s || !s.matches.length) return;
    s.index = (s.index + dir + s.matches.length) % s.matches.length;
    reveal();
  }

  const rowEl = (id) => s.pane.node.querySelector(`[data-timeline-row-id="${CSS.escape(id)}"]`);
  // Timers, not animation frames: frames stop while the window is hidden.
  const frame = () => new Promise((r) => setTimeout(r, 16));

  // Scrolls the current match into view: the list brings its row in, then the match is centered.
  // When the row turns out to show fewer matches than its data had, the list is remapped and the
  // next match is tried.
  async function reveal() {
    const token = (s.reveal = {});
    for (let tries = 0; tries < 8; tries++) {
      const m = s?.matches[s.index];
      if (!m) return paint();
      let el = rowEl(m.rowId);
      if (!el && m.rowIndex >= 0) {
        s.pane.ref.current?.scrollToIndex({ index: m.rowIndex, animated: false, viewPosition: 0 });
        for (let i = 0; i < 30 && !(el = rowEl(m.rowId)); i++) await frame();
        await frame();
        if (!s || s.reveal !== token) return;
      }
      if (measure()) remap();
      const now = s.matches[s.index];
      if (now && (now.rowId !== m.rowId || now.k !== m.k)) continue;
      const current = paint();
      const target = current ?? el;
      if (!target) return;
      scrollIntoView(target);
      // Rows measured late (images, code blocks) can move the match again: check once more.
      await frame();
      await frame();
      if (!s || s.reveal !== token) return;
      const again = paint() ?? target;
      if (again.isConnected !== false) scrollIntoView(again);
      if (!current && el) el.animate([{ boxShadow: "inset 3px 0 0 rgb(249 115 22)" }, { boxShadow: "none" }], { duration: 1200 });
      return;
    }
    paint();
  }

  function schedulePaint() {
    if (!s) return;
    clearTimeout(s.frame);
    s.frame = setTimeout(() => {
      if (!s) return;
      if (measure()) remap();
      paint();
    }, 30);
  }

  // Finds the matches in the rows on screen: s.ranges (rowId -> ranges) and s.seen counts.
  // Returns true when a row's count changed.
  function measure() {
    let changed = false;
    s.ranges = new Map();
    if (!s.query) return false;
    for (const el of s.pane.node.querySelectorAll(ROW)) {
      const id = el.getAttribute("data-timeline-row-id");
      const ranges = rangesIn(el, s.query);
      s.ranges.set(id, ranges);
      if (s.seen.get(id) !== ranges.length) {
        s.seen.set(id, ranges.length);
        changed = true;
      }
    }
    return changed;
  }

  // A range collapses when React replaces its text; then it no longer holds the query.
  const live = (r, id) =>
    r.startContainer.nodeType === Node.TEXT_NODE &&
    r.startContainer.isConnected &&
    r.toString().toLowerCase() === s.query &&
    r.startContainer.parentElement.closest(ROW)?.getAttribute("data-timeline-row-id") === id;

  // Draws the highlights and the count. Returns the current match's range when its row is on
  // screen.
  function paint() {
    if (!s) return null;
    place();
    const n = s.matches.length;
    s.countEl.textContent = s.query ? (n ? `${s.index + 1} of ${n}` : "No results") : "";
    s.bar.toggleAttribute("data-empty", Boolean(s.query) && !n);
    s.prev.disabled = s.next.disabled = n < 2;
    if (!CSS.highlights) return null;
    for (const [id, ranges] of s.ranges) {
      if (ranges.some((r) => !live(r, id))) {
        s.ranges.clear();
        if (measure()) remap();
        break;
      }
    }
    const m = s.matches[s.index];
    const current = m ? (s.ranges.get(m.rowId)?.[m.k] ?? null) : null;
    CSS.highlights.set(HL, new Highlight(...[...s.ranges.values()].flat()));
    const cur = current ? new Highlight(current) : new Highlight();
    cur.priority = 1;
    CSS.highlights.set(HL_CURRENT, cur);
    return current;
  }

  lifecycle.listen(window, "keydown", (e) => {
    if (e.defaultPrevented || e.code !== "KeyF" || e.altKey || e.shiftKey) return;
    if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
    // Terminals and editors keep their own find.
    if (e.target instanceof Element && e.target.closest(".xterm,.cm-editor,.monaco-editor")) return;
    if (openFind()) e.preventDefault();
  });

  api.command({ id: "open", title: "Find in thread", run: () => openFind() });
};
