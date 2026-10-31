// Compact composer: Esc stops the running turn; background work ("Waiting on 3 subagents")
// moves from the timeline's last line into the row as a short label; the row keeps room for
// that label and for the permissions strip that style.css floats into it.

const FULL_ACCESS = '[aria-label="Permissions: Full access"]';

/** @param {import("../../t3mods/types/t3mods").RendererApi} api */
export default (api) => {
  // Esc in the composer stops the turn. The editor calls preventDefault on every Escape, so
  // the open @, $ or / menu is read before the app sees the key: that Esc only closes the menu.
  let menuWasOpen = false;
  api.lifecycle.listen(window, "keydown", (e) => {
    if (e.key === "Escape") menuWasOpen = suggestionsOpen(e.target);
  }, { capture: true });
  api.lifecycle.listen(window, "keydown", (e) => {
    if (e.key !== "Escape" || menuWasOpen || e.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const form = e.target instanceof Element ? e.target.closest('[data-chat-composer-form="true"]') : null;
    if (!form) return;
    // The app shows its Stop button only while the prompt is empty; with a draft, stop the
    // open thread through the threads API instead.
    // Without a turn, Esc stops the background work (the Stop of its status line).
    const stop = form.querySelector('button[aria-label="Stop generation"]:not([disabled])');
    const working = stop ? null : workingThread(api);
    const background = stop || working ? null : stopButton(backgroundLine(canvasOf(form)));
    if (!stop && !working && !background) return;
    e.preventDefault();
    if (working) api.threads.stop(working).catch((err) => api.log("stop failed", err));
    else (stop ?? background).click();
  });

  // Widths of the floated pieces, as CSS variables on the composer shell.
  api.observe('[data-slot="composer-shell"]', (shell) => {
    const measure = () => {
      const footer = shell.querySelector('[data-chat-composer-footer="true"]');
      const strip = shell.querySelector('[data-slot="composer-context-strip"]');
      const stripShown = strip && strip.querySelector(`[data-composer-context-control]:not(${FULL_ACCESS})`);
      set(shell, "--cc-footer", footer ? footer.offsetWidth : 0);
      set(shell, "--cc-trail", stripShown ? strip.offsetWidth : 0);
      set(shell, "--cc-lead", badge.hidden ? 0 : badge.offsetWidth + 8);
    };

    // The background-work label at the row's start.
    const badge = document.createElement("div");
    badge.className = "cc-status";
    badge.hidden = true;
    badge.append(Object.assign(document.createElement("span"), { className: "cc-spin" }), document.createElement("span"));
    shell.append(badge);
    const status = () => {
      const canvas = canvasOf(shell);
      const line = backgroundLine(canvas);
      for (const old of canvas.querySelectorAll("[data-cc-inline]")) if (old !== line) old.removeAttribute("data-cc-inline");
      let label = null;
      let full = null;
      if (line) {
        line.setAttribute("data-cc-inline", "");
        const title = line.querySelector(".truncate");
        const detail = title?.querySelector(".ms-0\\.5");
        const head = (title?.textContent ?? "").slice(0, title && detail ? title.textContent.length - detail.textContent.length : undefined).trim();
        label = shortLabel(head);
        full = [head, detail?.textContent.trim()].filter(Boolean).join(": ");
      }
      badge.hidden = !label;
      badge.lastChild.textContent = label ?? "";
      badge.title = full ?? label ?? "";
      measure();
    };
    let frame = 0;
    const later = () => (frame ||= requestAnimationFrame(() => ((frame = 0), status())));
    const timeline = new MutationObserver(later);
    timeline.observe(canvasOf(shell), { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(measure);
    const watch = () => {
      resize.disconnect();
      for (const sel of ['[data-chat-composer-footer="true"]', '[data-slot="composer-context-strip"]']) {
        for (const el of shell.querySelectorAll(sel)) resize.observe(el);
      }
      measure();
    };
    // Typing changes the editor's DOM on every key; only changes outside it matter here.
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => !(r.target instanceof Element && r.target.closest(".ProseMirror")))) watch();
    });
    mutations.observe(shell, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
    watch();
    status();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      timeline.disconnect();
      cancelAnimationFrame(frame);
      badge.remove();
      for (const el of document.querySelectorAll("[data-cc-inline]")) el.removeAttribute("data-cc-inline");
      for (const v of ["--cc-footer", "--cc-trail", "--cc-lead"]) shell.style.removeProperty(v);
    };
  });
};

function set(el, name, px) {
  const value = `${px}px`;
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

// The chat pane that holds a composer; its timeline ends with the "now" line.
const canvasOf = (el) => el.closest('[data-chat-canvas="true"]') ?? document;

// The timeline's "now" line for background work: the one with a Stop button. Other now lines
// (a child thread that waits for an answer) keep their place and their Open button.
function backgroundLine(root) {
  return [...root.querySelectorAll('[data-thread-now-line="true"]')].find((l) => stopButton(l)) ?? null;
}

function stopButton(line) {
  return line ? [...line.querySelectorAll("button:not([disabled])")].find((b) => /^Stop\b/.test(b.textContent.trim())) ?? null : null;
}

// "Waiting on 3 subagents" reads "3 agents"; any other title ("Running npm test") stays.
function shortLabel(title) {
  const n = /(\d+) subagents?\b/.exec(title)?.[1] ?? (/\ba subagent\b/.test(title) ? "1" : null);
  return n ? `${n} agent${n === "1" ? "" : "s"}` : title;
}

const route = () => {
  const [environmentId, threadId] = location.hash.replace(/^#\/?/, "").split(/[/?]/);
  return { environmentId, threadId };
};

// The open thread from the route (#/<environmentId>/<threadId>), when it is working.
function workingThread(api) {
  if (!api.threads?.available?.()) return null;
  const { environmentId, threadId } = route();
  if (!environmentId || !threadId) return null;
  const t = api.threads.list().find((x) => x.ref.environmentId === environmentId && x.ref.threadId === threadId);
  return t?.status === "working" ? t.ref : null;
}

// The editor points aria-controls at its suggestions list while that list is open.
function suggestionsOpen(target) {
  const editor = target instanceof Element ? target.closest('[role="textbox"][aria-controls]') : null;
  const id = editor?.getAttribute("aria-controls");
  return !!id && !!document.getElementById(id);
}
