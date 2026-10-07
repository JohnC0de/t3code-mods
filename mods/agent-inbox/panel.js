import { rpc, h, kbd, renderText, toPlain, timeAgo, statusLabel, cardStatusLine, reducedMotion, where } from "./shared.js";

const root = document.getElementById("app");
const live = document.getElementById("live");

let model = null;
let view = { mode: "inbox", cardKey: null };
let curKey = null; // the card the user is on
let curIdx = 0; // its position, used when it disappears
let wantKey = null; // card key requested by show() before it exists
let listSel = 0;
let help = false;
let lastRendered = null;
let limits = null; // { id, maxHeight } from main; an older main sends none
let lastFit = "";
let quiet = false; // inside show(), which returns the size itself
let cleared = false; // hidden by main: nothing renders until the next show()
const dismissed = new Set(); // cards that left locally
const states = new Map(); // card.key -> per-card UI state

const say = (text) => (live.textContent = text);
const fieldKey = (card, s) => (card.kind === "question" ? `q${s.qi}` : "reply");

function st(card) {
  let s = states.get(card.key);
  if (!s) {
    s = { qi: 0, answers: {}, multi: {}, drafts: {}, picked: null, sending: null, error: null };
    states.set(card.key, s);
  }
  return s;
}

const cards = () => (model?.cards ?? []).filter((c) => !dismissed.has(c.key));

function syncCur() {
  const list = cards();
  let i = -1;
  if (wantKey) {
    i = list.findIndex((c) => c.key === wantKey);
    if (i >= 0) wantKey = null;
  }
  if (i < 0) i = list.findIndex((c) => c.key === curKey);
  if (i < 0) i = Math.min(curIdx, list.length - 1); // same position: the next card
  curIdx = Math.max(i, 0);
  curKey = list[curIdx]?.key ?? null;
}

/* ---------- main-process hooks ---------- */

function update(next) {
  model = next;
  const keys = new Set(next.cards.map((c) => c.key));
  for (const k of [...dismissed]) if (!keys.has(k)) dismissed.delete(k);
  for (const [k, s] of states) {
    if (keys.has(k) || s.sending?.inflight) continue;
    clearTimeout(s.sending?.timer); // the card is gone: do not send
    states.delete(k);
  }
  syncCur();
  render();
}

// Main sizes the window to the card: show() returns the size, and fit() reports later changes.
function show(next, lim) {
  if (lim) {
    limits = lim;
    document.documentElement.style.setProperty("--win-max", `${lim.maxHeight}px`);
    document.body.classList.add("sized");
  }
  view = next;
  help = false;
  cleared = false;
  if (next.mode === "inbox" && next.cardKey) {
    wantKey = next.cardKey;
    syncCur();
  }
  if (next.mode === "list") listSel = 0;
  quiet = !!lim; // a call from main gets the size back; a key here (L, Esc) reports it
  render();
  quiet = false;
  const size = measure();
  lastFit = JSON.stringify(size);
  return size;
}

function measure() {
  const r = root.getBoundingClientRect();
  return { id: limits?.id ?? 0, width: Math.ceil(r.width), height: Math.ceil(r.height) };
}

function fit() {
  if (!limits || quiet) return;
  const size = measure();
  const key = JSON.stringify(size);
  if (key === lastFit) return;
  lastFit = key;
  rpc("fitPanel", size).catch(() => {});
}

// The zoom of the app (and so of this page) changed: main converts the size again.
(function watchZoom() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    "change",
    () => {
      lastFit = "";
      fit();
      watchZoom();
    },
    { once: true },
  );
})();

// Main hid the window: drop the card, so the next show does not flash the old one.
function clear() {
  cleared = true;
  lastRendered = null;
  root.replaceChildren();
}

window.inbox = { update, show, clear };

/* ---------- sending ---------- */

function startSend(card, action) {
  const s = st(card);
  s.error = null;
  s.sending = { action, start: performance.now(), inflight: false, timer: setTimeout(() => commit(card), model.undoMs) };
  say("Sending. Press Escape to undo.");
  render();
}

function resetPicks(card, s) {
  s.picked = null;
  if (card.kind === "question") {
    const last = card.questions[s.qi];
    delete s.answers[last.id];
  }
}

function undo(card) {
  const s = st(card);
  clearTimeout(s.sending.timer);
  s.sending = null;
  resetPicks(card, s);
  say("Cancelled. Nothing was sent.");
  render();
}

async function commit(card) {
  const s = states.get(card.key);
  if (!s?.sending) return;
  s.sending.inflight = true;
  render();
  try {
    await rpc("act", s.sending.action);
  } catch (e) {
    if (states.get(card.key) !== s) return;
    s.sending = null;
    s.error = e.message;
    resetPicks(card, s);
    say(`Not sent: ${e.message}`);
    render();
    return;
  }
  const type = s.sending.action.type;
  s.sending = null;
  say("Sent.");
  if (type === "reply") s.drafts.reply = "";
  leave(card.key);
}

function leave(key) {
  const finish = () => {
    dismissed.add(key);
    states.delete(key);
    syncCur();
    render();
  };
  const el = root.querySelector(".card");
  if (el && curKey === key && !reducedMotion()) {
    el.classList.add("leaving");
    setTimeout(finish, 170);
  } else finish();
}

/* ---------- card actions ---------- */

function advance(card) {
  const s = st(card);
  if (s.qi < card.questions.length - 1) {
    s.qi++;
    render();
    return;
  }
  startSend(card, { type: "answer", ref: card.ref, requestId: card.requestId, answers: { ...s.answers } });
}

function pickOption(card, i) {
  const s = st(card);
  const q = card.questions[s.qi];
  const o = q.options[i];
  if (!o) return;
  if (q.multiSelect) {
    const set = (s.multi[q.id] ??= new Set());
    set.has(o.value) ? set.delete(o.value) : set.add(o.value);
    render();
    return;
  }
  s.answers[q.id] = o.value;
  advance(card);
}

const selectedValues = (card, s) => {
  const q = card.questions[s.qi];
  const set = s.multi[q.id] ?? new Set();
  return q.options.map((o) => o.value).filter((v) => set.has(v));
};

function submitMulti(card) {
  const s = st(card);
  const vals = selectedValues(card, s);
  if (!vals.length) return;
  s.answers[card.questions[s.qi].id] = vals;
  advance(card);
}

function pickApproval(card, i) {
  const o = card.approval.options[i];
  if (!o) return;
  const s = st(card);
  s.picked = o.decision;
  startSend(card, { type: "approve", ref: card.ref, requestId: card.requestId, decision: o.decision });
}

function submitText(card) {
  const s = st(card);
  const text = (s.drafts[fieldKey(card, s)] ?? "").trim();
  if (!text) return;
  if (card.kind === "question") {
    const q = card.questions[s.qi];
    s.answers[q.id] = q.multiSelect ? [...selectedValues(card, s), text] : text;
    advance(card);
  } else if (card.canReply) {
    startSend(card, { type: "reply", ref: card.ref, text });
  }
}

function clearCard(card) {
  leave(card.key);
  rpc("act", { type: "clear", ref: card.ref, cardKey: card.key }).catch((e) => {
    dismissed.delete(card.key);
    st(card).error = e.message;
    curKey = card.key;
    syncCur();
    render();
  });
}

function openThread(ref, card) {
  rpc("act", { type: "open", ref }).catch((e) => {
    if (card) st(card).error = e.message;
    render();
  });
}

function move(d) {
  const list = cards();
  if (!list.length) return;
  curIdx = Math.min(list.length - 1, Math.max(0, curIdx + d));
  curKey = list[curIdx].key;
  render();
}

/* ---------- views ---------- */

function field(card, s, placeholder) {
  const key = fieldKey(card, s);
  const input = h("input", { class: "txt", type: "text", placeholder, "aria-label": placeholder, autocomplete: "off", disabled: !!s.sending });
  input.value = s.drafts[key] ?? "";
  input.addEventListener("input", () => (s.drafts[key] = input.value));
  return h("div", { class: "field" }, input, h("span", { class: "hk on-blur" }, kbd("Space")), h("span", { class: "hk on-focus" }, kbd("Enter")));
}

function optBtn(n, label, desc, warn, on, pressed, chosen) {
  return h(
    "button",
    { class: `opt${chosen ? " chosen" : ""}`, type: "button", "aria-pressed": pressed == null ? null : String(pressed), onclick: on },
    n <= 9 ? kbd(String(n)) : h("span", { class: "n" }),
    h("span", { class: "t" }, h("span", { class: "l" }, label), desc ? h("span", { class: "d" }, desc) : null, warn ? h("span", { class: "w" }, warn) : null),
  );
}

function questionBody(card, s) {
  const q = card.questions[s.qi];
  const n = card.questions.length;
  const multi = q.multiSelect ? s.multi[q.id] ?? new Set() : null;
  const opts = q.options.map((o, i) => {
    const chosen = multi ? multi.has(o.value) : s.answers[q.id] === o.value;
    return optBtn(i + 1, o.label, o.description, null, () => pickOption(card, i), multi ? chosen : null, !multi && chosen);
  });
  return [
    n > 1
      ? h("div", { class: "step" }, h("span", {}, `Question ${s.qi + 1} of ${n}`), s.qi > 0 && !s.sending ? h("button", { type: "button", onclick: () => { s.qi--; render(); } }, "← Back") : null)
      : null,
    q.header ? h("div", { class: "qh" }, q.header) : null,
    h("p", { class: "qt" }, q.question),
    h("div", { class: "opts", role: "group", "aria-label": q.question }, opts),
    multi ? h("button", { class: "send", type: "button", disabled: !multi.size, onclick: () => submitMulti(card) }, "Send selected", kbd("Enter")) : null,
    q.allowCustom ? field(card, s, "Type an answer") : null,
  ];
}

function approvalBody(card, s) {
  const a = card.approval;
  const kind = String(a.requestKind ?? "request").replace(/[-_]/g, " ");
  return [
    h("div", { class: "rk" }, a.appName ? `${kind} · ${a.appName}` : kind),
    a.detail ? h("pre", { class: "detail" }, a.detail) : null,
    h("div", { class: "opts", role: "group", "aria-label": "Decision" }, a.options.map((o, i) => optBtn(i + 1, o.label, null, o.warning, () => pickApproval(card, i), null, s.picked === o.decision))),
  ];
}

function hints(card) {
  const s = st(card);
  const item = (k, t) => h("span", { class: "h" }, kbd(k), t);
  const out = [];
  if (card.kind === "question") {
    const n = Math.min(9, card.questions[s.qi].options.length);
    out.push(item(n > 1 ? `1-${n}` : "1", "pick"));
    if (card.questions[s.qi].allowCustom) out.push(item("Space", "type"));
  } else if (card.kind === "approval") {
    out.push(item(`1-${Math.min(9, card.approval.options.length)}`, "choose"));
  } else if (card.canReply) out.push(item("Space", "reply"));
  out.push(item("E", card.kind === "question" || card.kind === "approval" ? "hide" : "clear"), item("O", "open"), item("L", "all"), item("?", "keys"));
  return out;
}

function inboxView() {
  const list = cards();
  if (!list.length) return emptyView();
  const card = list[curIdx];
  const s = st(card);
  const sending = !!s.sending;

  const body = h("div", { class: "body" });
  if (card.message) body.append(h("div", { class: "msg" }, renderText(card.message)));
  if (card.kind === "question") body.append(...questionBody(card, s).filter(Boolean));
  else if (card.kind === "approval") body.append(...approvalBody(card, s).filter(Boolean));
  else {
    if (card.kind === "failed") body.append(h("div", { class: "err first" }, card.error || "The run failed."));
    if (card.canReply) body.append(field(card, s, "Reply to the agent"));
  }
  if (s.error) body.append(h("div", { class: "err", role: "alert" }, s.error));

  const foot = sending
    ? h(
        "footer",
        { class: "foot sending" },
        h("div", { class: "bar" }, h("i", { style: `animation-duration:${model.undoMs}ms;animation-delay:-${Math.round(performance.now() - s.sending.start)}ms` })),
        h("span", {}, "Sending"),
        s.sending.inflight ? null : h("span", { class: "undo" }, kbd("Esc"), "to undo"),
      )
    : h("footer", { class: "foot" }, hints(card));

  const el = h(
    "section",
    { class: `card${sending ? " sending" : ""}${lastRendered === card.key ? "" : " enter"}${help ? " help-open" : ""}`, "data-key": card.key },
    h(
      "header",
      { class: "head" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "sd", "data-status": card.status }),
        h("h1", { class: "title", title: card.title }, card.title),
        h("button", { class: "close", type: "button", "aria-label": "Close (Esc)", onclick: () => rpc("closePanel").catch(console.warn) }, kbd("Esc")),
      ),
      h(
        "div",
        { class: "meta" },
        h("span", { class: "proj", title: where(card) }, where(card)),
        h("span", { class: "sep" }, "·"),
        h("span", { "data-tone": card.status }, cardStatusLine(card)),
        card.kind === "done" ? null : h("span", { class: "ago" }, timeAgo(card.at)),
        h(
          "span",
          { class: "pager" },
          h("button", { class: "nav", type: "button", "aria-label": "Previous card (K)", disabled: curIdx === 0, onclick: () => move(-1) }, kbd("K")),
          h("span", {}, `${curIdx + 1} of ${list.length}`),
          h("button", { class: "nav", type: "button", "aria-label": "Next card (J)", disabled: curIdx === list.length - 1, onclick: () => move(1) }, kbd("J")),
        ),
      ),
    ),
    body,
    foot,
  );
  return el;
}

function emptyView() {
  return h(
    "section",
    { class: "card enter" },
    h(
      "div",
      { class: "empty" },
      h("div", { class: "ring", "aria-hidden": "true" }, "✓"),
      h("h2", {}, "Nothing is waiting on you"),
      h("p", {}, "Questions, approvals and finished work will land here."),
      h("div", { class: "hints" }, h("span", {}, kbd(model.shortcut), "opens the inbox from anywhere"), h("span", {}, kbd("L"), "for all agents")),
    ),
  );
}

function listRows() {
  const groups = new Map();
  for (const a of model.agents) {
    if (!groups.has(where(a))) groups.set(where(a), []);
    groups.get(where(a)).push(a);
  }
  return [...groups].flatMap(([, agents]) => agents);
}

function listView() {
  const rows = listRows();
  listSel = Math.min(listSel, Math.max(0, rows.length - 1));
  const groups = new Map();
  rows.forEach((a, i) => {
    if (!groups.has(where(a))) groups.set(where(a), []);
    groups.get(where(a)).push([a, i]);
  });
  const body = h("div", { class: "body" });
  if (!rows.length) body.append(h("p", { class: "empty" }, "No agents yet."));
  for (const [project, items] of groups) {
    body.append(
      h(
        "div",
        { class: "grp" },
        h("h2", {}, project),
        items.map(([a, i]) =>
          h(
            "button",
            { class: `arow${i === listSel ? " sel" : ""}`, type: "button", "aria-current": i === listSel ? "true" : null, onclick: () => openThread(a.ref), onpointermove: () => { if (listSel !== i) { listSel = i; markSel(); } } },
            h("span", { class: "sd", "data-status": a.status, title: statusLabel(a.status) }),
            h("span", { class: "tt" }, a.title),
            a.branch ? h("span", { class: "br" }, a.branch) : null,
            h("span", { class: "ag" }, timeAgo(a.updatedAt)),
          ),
        ),
      ),
    );
  }
  return h(
    "section",
    { class: "card list" },
    h("header", { class: "head" }, h("div", { class: "row" }, h("h1", { class: "title" }, "All agents"), h("button", { class: "close", type: "button", "aria-label": "Back to inbox (Esc)", onclick: () => show({ mode: "inbox", cardKey: curKey }) }, kbd("Esc")))),
    body,
    h("footer", { class: "foot" }, h("span", { class: "h" }, kbd("J"), kbd("K"), "move"), h("span", { class: "h" }, kbd("Enter"), "open"), h("span", { class: "h" }, kbd("Esc"), "back")),
  );
}

function markSel() {
  root.querySelectorAll(".arow").forEach((el, i) => {
    el.classList.toggle("sel", i === listSel);
    i === listSel ? el.setAttribute("aria-current", "true") : el.removeAttribute("aria-current");
  });
}

function peekView() {
  const key = view.threadKey;
  const card = cards().find((c) => c.threadKey === key);
  const agent = card ?? model.agents.find((a) => a.threadKey === key) ?? model.dots.find((d) => d.threadKey === key);
  if (!agent) return h("section", { class: "card peek" }, h("div", { class: "meta" }, "Nothing to show"));
  const lines = card?.message ? toPlain(card.message).slice(0, 2) : [];
  const status = card ? cardStatusLine(card) : statusLabel(agent.status);
  return h(
    "section",
    { class: "card peek", "aria-hidden": "true" },
    h("div", { class: "row" }, h("span", { class: "sd", "data-status": agent.status }), h("h1", { class: "title" }, agent.title)),
    h("div", { class: "meta" }, h("span", { class: "proj" }, where(agent)), h("span", { class: "sep" }, "·"), h("span", { "data-tone": agent.status }, status)),
    lines.length ? h("p", { class: "pk" }, lines.join("\n")) : null,
    card?.kind === "question" ? h("p", { class: "pq" }, card.questions[0].question) : null,
  );
}

function helpOverlay() {
  const rows = [
    [["1-9"], "Pick an option"],
    [["Space"], "Type an answer or reply"],
    [["J", "K"], "Next or previous card"],
    [["E"], "Clear or hide the card"],
    [["O", "Enter"], "Open the thread"],
    [["L"], "All agents"],
    [["Esc"], "Undo, then close"],
  ];
  return h(
    "div",
    { class: "help", role: "dialog", "aria-label": "Keys", onclick: () => { help = false; render(); } },
    h("div", {}, h("h2", {}, "Keys"), h("dl", {}, rows.flatMap(([k, t]) => [h("dt", {}, k.map(kbd)), h("dd", {}, t)]))),
  );
}

function render() {
  const active = document.activeElement;
  const hadField = active instanceof HTMLInputElement && root.contains(active);
  const sel = hadField ? [active.selectionStart, active.selectionEnd] : null;
  const prev = root.querySelector(".card");
  const scroll = { body: prev?.querySelector(".body")?.scrollTop ?? 0, msg: prev?.querySelector(".msg")?.scrollTop ?? 0, key: prev?.dataset.key };

  document.body.dataset.mode = view.mode;
  root.replaceChildren();
  if (!model || cleared) return;
  let next;
  if (view.mode === "peek") next = peekView();
  else if (view.mode === "list") next = listView();
  else next = inboxView();
  root.append(next);
  if (view.mode === "inbox" && help) next.append(helpOverlay());
  lastRendered = view.mode === "inbox" ? curKey : null;

  if (view.mode === "inbox" && scroll.key && scroll.key === next.dataset.key) {
    const b = next.querySelector(".body");
    const m = next.querySelector(".msg");
    if (b) b.scrollTop = scroll.body;
    if (m) m.scrollTop = scroll.msg;
  }
  if (hadField && view.mode === "inbox") {
    const f = root.querySelector("input.txt:not(:disabled)");
    if (f) {
      f.focus();
      if (sel) f.setSelectionRange(sel[0], sel[1]);
    }
  }
  if (view.mode === "list") root.querySelector(".arow.sel")?.scrollIntoView({ block: "nearest" });
  fit();
}

/* ---------- keys ---------- */

function inboxKey(e) {
  const list = cards();
  const card = list[curIdx];
  const s = card && st(card);
  const inField = e.target instanceof HTMLInputElement;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (k === "Escape") {
    e.preventDefault();
    if (help) { help = false; render(); }
    else if (s?.sending) { if (!s.sending.inflight) undo(card); }
    else if (inField) e.target.blur();
    else rpc("closePanel").catch(console.warn);
    return;
  }
  if (s?.sending) return;
  if (inField) {
    if (k === "Enter" && !e.isComposing) { e.preventDefault(); submitText(card); }
    return;
  }
  if (k === "?") { help = !help; render(); return; }
  if (k === "l") { show({ mode: "list" }); return; }
  if (!card) return;

  if (/^[1-9]$/.test(k)) {
    const i = Number(k) - 1;
    card.kind === "question" ? pickOption(card, i) : card.kind === "approval" ? pickApproval(card, i) : null;
  } else if (k === "j" || k === "ArrowDown") { e.preventDefault(); move(1); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (k === "e") clearCard(card);
  else if (k === "o") openThread(card.ref, card);
  else if (k === "Enter") {
    if (card.kind === "question" && card.questions[s.qi].multiSelect && selectedValues(card, s).length) submitMulti(card);
    else openThread(card.ref, card);
  } else if (k === " ") {
    const f = root.querySelector("input.txt:not(:disabled)");
    if (f) { e.preventDefault(); f.focus(); }
  } else if ((k === "ArrowLeft" || k === "Backspace") && card.kind === "question" && s.qi > 0) { s.qi--; render(); }
}

function listKey(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const rows = listRows();
  if (k === "Escape" || k === "l") { e.preventDefault(); show({ mode: "inbox", cardKey: curKey }); }
  else if (k === "j" || k === "ArrowDown") { e.preventDefault(); listSel = Math.min(rows.length - 1, listSel + 1); markSel(); root.querySelector(".arow.sel")?.scrollIntoView({ block: "nearest" }); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); listSel = Math.max(0, listSel - 1); markSel(); root.querySelector(".arow.sel")?.scrollIntoView({ block: "nearest" }); }
  else if (k === "Enter" && rows[listSel]) { e.preventDefault(); openThread(rows[listSel].ref); }
}

window.addEventListener("keydown", (e) => {
  if (!model || e.ctrlKey || e.metaKey || e.altKey || view.mode === "peek") return;
  if (view.mode === "list") listKey(e);
  else inboxKey(e);
});

// Keep "2 min ago" fresh. Never while a send runs, so the undo bar stays steady.
setInterval(() => {
  if (model && view.mode !== "peek" && ![...states.values()].some((s) => s.sending)) render();
}, 30_000);

rpc("state")
  .then((m) => m && update(m))
  .catch((e) => root.replaceChildren(h("section", { class: "card" }, h("div", { class: "err first", style: "margin:12px" }, `Could not load the inbox: ${e.message}`))));
