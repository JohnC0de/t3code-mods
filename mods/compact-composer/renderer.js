// Compact composer: Esc stops the running turn, and the row keeps room for the
// permissions strip that style.css floats into it.

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
    const stop = form.querySelector('button[aria-label="Stop generation"]:not([disabled])');
    const working = stop ? null : workingThread(api);
    if (!stop && !working) return;
    e.preventDefault();
    if (stop) stop.click();
    else api.threads.stop(working).catch((err) => api.log("stop failed", err));
  });

  // Widths of the floated pieces, as CSS variables on the composer shell.
  api.observe('[data-slot="composer-shell"]', (shell) => {
    const measure = () => {
      const footer = shell.querySelector('[data-chat-composer-footer="true"]');
      const strip = shell.querySelector('[data-slot="composer-context-strip"]');
      const stripShown = strip && strip.querySelector(`[data-composer-context-control]:not(${FULL_ACCESS})`);
      set(shell, "--cc-footer", footer ? footer.offsetWidth : 0);
      set(shell, "--cc-trail", stripShown ? strip.offsetWidth : 0);
    };
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
    return () => {
      mutations.disconnect();
      resize.disconnect();
      for (const v of ["--cc-footer", "--cc-trail"]) shell.style.removeProperty(v);
    };
  });
};

function set(el, name, px) {
  const value = `${px}px`;
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

// The open thread from the route (#/<environmentId>/<threadId>), when it is working.
function workingThread(api) {
  if (!api.threads?.available?.()) return null;
  const [environmentId, threadId] = location.hash.replace(/^#\/?/, "").split(/[/?]/);
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
