// Mods manager: the Settings > Mods page, a sidebar indicator and palette commands.
// Built only on the public API plus `api.admin` (builtin mods only), so it also tests the API.

const STATUS = { ok: "Active", disabled: "Off", degraded: "Not started" };
const LEVEL = { hot: "Applies live", reload: "Reloads the window", restart: "Needs a restart" };

export default async (api) => {
  const R = await api.get("React");
  const { createRoot } = await api.get("ReactDOMClient");
  const h = R.createElement;
  const { admin } = api;
  const ModsIcon = api.unsafe.exports.core.ModsIcon;

  const useIndex = () => R.useSyncExternalStore(admin.subscribe, admin.index);
  const useSettings = () => (R.useSyncExternalStore(admin.subscribeSettings, admin.settingsVersion), admin.settings());

  // App components when core provides them; plain elements otherwise.
  const Btn = ({ variant = "outline", size = "sm", ...props }) =>
    api.ui.Button ? h(api.ui.Button, { variant, size, ...props }) : h("button", { type: "button", className: "t3m-btn", ...props });
  const Toggle = ({ checked, onChange, label, disabled }) =>
    api.ui.Switch
      ? h(api.ui.Switch, { checked, disabled, "aria-label": label, onCheckedChange: (v) => onChange(Boolean(v)) })
      : h("input", { type: "checkbox", checked, disabled, "aria-label": label, onChange: (e) => onChange(e.target.checked) });
  const CellToggle = ({ cell, label }) => h(Toggle, { checked: api.useCell(cell), onChange: (v) => cell.set(v), label });

  function useAction(setMsg) {
    const [busy, setBusy] = R.useState(false);
    const run = async (fn) => {
      setBusy(true);
      setMsg?.(null);
      try {
        const out = await fn();
        await admin.refresh();
        return out;
      } catch (e) {
        setMsg?.({ error: e.message });
      } finally {
        setBusy(false);
      }
    };
    return [busy, run];
  }

  function Banner({ index }) {
    const { restart, reload } = index.pending;
    if (restart.length) {
      return h("div", { className: "t3m-banner", role: "status" },
        h("span", null, `Restart T3 Code to apply changes to: ${restart.join(", ")}.`),
        h(Btn, { variant: "default", onClick: () => admin.call("restart") }, "Restart"));
    }
    if (reload.length) {
      return h("div", { className: "t3m-banner", role: "status" },
        h("span", null, `Reload the window to apply changes to: ${reload.join(", ")}.`),
        h(Btn, { variant: "default", onClick: () => admin.call("reload") }, "Reload"));
    }
    return null;
  }

  function Install() {
    const [msg, setMsg] = R.useState(null);
    const [url, setUrl] = R.useState("");
    const [over, setOver] = R.useState(false);
    const [busy, run] = useAction(setMsg);
    const done = (out) => out && setMsg({ ok: `Installed ${out.installed.name}${out.installed.version ? ` ${out.installed.version}` : ""} (sha256 ${out.installed.sha256.slice(0, 12)}…). ${LEVEL[out.level]}.` });
    const installFile = async (file) => done(await run(async () => admin.call("install", await file.arrayBuffer(), { "x-t3mods-filename": file.name })));
    return h("section", { className: "t3m-card" },
      h("h2", null, "Install a mod"),
      h("div", {
        className: "t3m-drop",
        "data-over": over || undefined,
        onDragOver: (e) => (e.preventDefault(), setOver(true)),
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files[0];
          if (file) installFile(file);
        },
      },
        h("span", null, "Drop a mod .zip here, or "),
        h("label", { className: "t3m-link" }, "choose a file",
          h("input", { type: "file", accept: ".zip,.t3mod", hidden: true, onChange: (e) => e.target.files[0] && installFile(e.target.files[0]) }))),
      h("form", {
        className: "t3m-row",
        onSubmit: async (e) => {
          e.preventDefault();
          done(await run(() => admin.call("install-url", { url })));
        },
      },
        h("input", { className: "t3m-input", type: "url", placeholder: "https://…/mod.zip", value: url, onChange: (e) => setUrl(e.target.value), "aria-label": "Mod archive URL" }),
        h(Btn, { type: "submit", disabled: busy || !url }, "Install from URL")),
      h("p", { className: "t3m-muted" }, "Mods run with full access to T3 Code and your computer. Install only mods that you trust."),
      msg && h("p", { className: msg.error ? "t3m-error" : "t3m-ok", role: "status" }, msg.error ?? msg.ok));
  }

  // What a tier means for the user; the ones that run outside the page get a plain warning.
  const TIER_LABEL = { css: "Styles", renderer: "UI code", patches: "Patches app code (runs in Electron main)", server: "Runs in the backend", serverPatches: "Patches the backend", main: "Runs in Electron main" };
  const TIER_WARNING = {
    patches: "Its patches.cjs runs in the Electron main process, with full access to your computer.",
    main: "Runs code in the Electron main process, with full access to your computer.",
    server: "Runs code in the T3 Code backend, with full access to your computer.",
    serverPatches: "Patches the T3 Code backend, so it runs its code with full access to your computer.",
  };
  const DANGEROUS = ["main", "server", "serverPatches", "patches"];

  function Browse({ index }) {
    const [q, setQ] = R.useState("");
    const [state, setState] = R.useState({ loading: true });
    const [updates, setUpdates] = R.useState([]);
    const [updatesError, setUpdatesError] = R.useState(null);
    const [msg, setMsg] = R.useState(null);
    const [busyId, setBusyId] = R.useState(null);
    const [, run] = useAction(setMsg);
    // Only the newest search may set the results: an older, slower answer is dropped.
    const seq = R.useRef(0);
    const find = async (query) => {
      const n = ++seq.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const out = await admin.call("registry-search", { q: query });
        if (n === seq.current) setState({ result: out.result, registry: out.registry });
      } catch (e) {
        if (n === seq.current) setState({ error: e.message });
      }
    };
    const checkUpdates = async () => {
      try {
        setUpdates((await admin.call("registry-updates")).updates);
        setUpdatesError(null);
      } catch (e) {
        setUpdatesError(e.message);
      }
    };
    R.useEffect(() => {
      find("");
      checkUpdates();
    }, []);
    const installed = new Map(index.mods.filter((m) => !m.builtin).map((m) => [m.id, m]));
    const act = (id, version, done) =>
      run(async () => {
        setBusyId(id);
        try {
          const out = await admin.call("registry-install", { id, version });
          setMsg({ ok: `${done} ${out.installed.name} ${out.installed.version ?? ""}. ${LEVEL[out.level]}.` });
          await checkUpdates();
        } finally {
          setBusyId(null);
        }
      });
    const Row = ({ mod }) => {
      const have = installed.get(mod.id);
      const upd = updates.find((u) => u.id === mod.id);
      const danger = mod.tiers.filter((t) => DANGEROUS.includes(t));
      return h("article", { className: "t3m-result-card", "data-t3m-result": mod.id },
        h("div", { className: "t3m-mod-head" },
          h("div", { className: "t3m-mod-title" },
            h("h3", null, mod.name),
            h("span", { className: "t3m-muted" }, mod.latestVersion),
            h("span", { className: "t3m-muted" }, `@${mod.author.login}`)),
          upd
            ? h(Btn, { variant: "default", disabled: busyId === mod.id, "data-t3m-update": mod.id, onClick: () => act(mod.id, upd.latest, "Updated") }, `Update to ${upd.latest}`)
            : have
              ? h("span", { className: "t3m-badge", "data-t3m-installed": mod.id }, "Installed")
              : h(Btn, { variant: "default", disabled: busyId === mod.id, "data-t3m-install": mod.id, onClick: () => act(mod.id, null, "Installed") }, busyId === mod.id ? "Installing…" : "Install")),
        mod.description && h("p", null, mod.description),
        h("div", { className: "t3m-meta t3m-muted" },
          h("span", null, `${mod.downloads} ${mod.downloads === 1 ? "download" : "downloads"}`),
          h("span", null, mod.rating?.average == null ? "no ratings" : `★ ${mod.rating.average.toFixed(1)} (${mod.rating.count})`)),
        h("div", { className: "t3m-row" }, mod.tiers.map((t) => h("span", { key: t, className: "t3m-badge", "data-tier": t, "data-danger": DANGEROUS.includes(t) || undefined }, TIER_LABEL[t] ?? t))),
        danger.map((t) => h("p", { key: t, className: "t3m-error", "data-t3m-warning": t }, TIER_WARNING[t])));
    };
    return h("section", { className: "t3m-card", "data-t3m": "browse" },
      h("h2", null, "Browse the registry"),
      h("form", {
        className: "t3m-row",
        onSubmit: (e) => {
          e.preventDefault();
          find(q);
        },
      },
        h("input", { className: "t3m-input", type: "search", placeholder: "Search mods", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search the registry", "data-t3m": "browse-q" }),
        h(Btn, { type: "submit", "data-t3m": "browse-go" }, "Search")),
      state.loading && h("p", { className: "t3m-muted" }, "Loading…"),
      state.error && h("p", { className: "t3m-error", role: "status", "data-t3m": "browse-error" }, state.error),
      state.result && !state.loading && (state.result.mods.length
        ? state.result.mods.map((mod) => h(Row, { key: mod.id, mod }))
        : h("p", { className: "t3m-muted" }, "No mods found.")),
      state.registry && h("p", { className: "t3m-muted" }, `Mods come from ${new URL(state.registry).host}. Anyone can publish there: install only mods that you trust.`),
      updatesError && h("p", { className: "t3m-error", role: "status", "data-t3m": "browse-updates-error" }, `Could not check for updates: ${updatesError}`),
      msg && h("p", { className: msg.error ? "t3m-error" : "t3m-ok", role: "status", "data-t3m": "browse-msg" }, msg.error ?? msg.ok));
  }

  function ModSettings({ items }) {
    return items.map((s) =>
      s.kind === "toggle"
        ? h("div", { key: s.key, className: "t3m-setting" },
            h("div", null, h("div", null, s.title), s.description && h("div", { className: "t3m-muted" }, s.description)),
            h(CellToggle, { cell: s.value, label: s.title }))
        : h("div", { key: s.key, className: "t3m-setting t3m-section" }, s.title && h("h4", null, s.title), h(s.component)),
    );
  }

  function Patches({ results }) {
    if (!results.length) return null;
    return h("details", { className: "t3m-details" },
      h("summary", null, `Patches (${results.filter((r) => r.status === "ok").length}/${results.length} ok)`),
      h("ul", { className: "t3m-patches" },
        results.map((r) => h("li", { key: r.key, "data-status": r.status },
          h("code", null, r.id), " ", h("span", { className: "t3m-badge", "data-status": r.status }, r.status),
          r.optional ? h("span", { className: "t3m-muted" }, " optional") : null,
          r.entries && r.entries.length > 1 ? h("span", { className: "t3m-muted" }, ` entries ${r.entries.map((e) => (e ? "✓" : "✗")).join("")}`) : null,
          r.chunks?.length ? h("span", { className: "t3m-muted" }, ` in ${r.chunks.join(", ")}`) : null,
          r.error ? h("div", { className: "t3m-error" }, r.error) : null))));
  }

  function ModCard({ mod, results, items }) {
    const [msg, setMsg] = R.useState(null);
    const [busy, run] = useAction(setMsg);
    const tiers = Object.entries(mod.files).filter(([, v]) => v).map(([k]) => k);
    return h("article", { className: "t3m-card t3m-mod", "data-status": mod.status },
      h("header", { className: "t3m-mod-head" },
        h("div", { className: "t3m-mod-title" },
          h("h3", null, mod.name),
          mod.version && h("span", { className: "t3m-muted" }, mod.version),
          mod.builtin && h("span", { className: "t3m-badge" }, "Built in"),
          h("span", { className: "t3m-badge", "data-status": mod.status }, STATUS[mod.status] ?? mod.status)),
        !mod.builtin && h(Toggle, {
          checked: mod.enabled,
          disabled: busy,
          label: `Enable ${mod.name}`,
          onChange: (enabled) => run(() => admin.call("toggle", { id: mod.id, enabled })),
        })),
      mod.description && h("p", null, mod.description),
      mod.problems.length > 0 && h("ul", { className: "t3m-error" }, mod.problems.map((p) => h("li", { key: p }, p))),
      items?.length ? h(ModSettings, { items }) : null,
      h("div", { className: "t3m-meta t3m-muted" },
        h("span", null, tiers.join(" · ") || "empty"),
        h("span", null, LEVEL[mod.level]),
        mod.author && h("span", null, `by ${mod.author}`),
        mod.source && h("span", { title: `${mod.source.source}\nsha256 ${mod.source.sha256}` }, `sha256 ${mod.source.sha256.slice(0, 12)}…`)),
      h(Patches, { results }),
      !mod.builtin && h("div", { className: "t3m-row" },
        h(Btn, { variant: "ghost", onClick: () => run(() => admin.call("open-folder", { id: mod.id })) }, "Open folder"),
        h(Btn, {
          variant: "ghost",
          disabled: busy,
          onClick: () => confirm(`Remove ${mod.name}? This deletes its folder.`) && run(() => admin.call("uninstall", { id: mod.id })),
        }, "Remove")),
      msg?.error && h("p", { className: "t3m-error", role: "status" }, msg.error));
  }

  function PatchHelper() {
    const [form, setForm] = R.useState({ find: "", match: "", flags: "", replace: "", group: false });
    const [out, setOut] = R.useState(null);
    const [msg, setMsg] = R.useState(null);
    const [busy, run] = useAction(setMsg);
    const field = (name, label, props = {}) =>
      h("label", { className: "t3m-field" }, h("span", null, label),
        h("input", { className: "t3m-input t3m-mono", value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }), spellCheck: false, ...props }));
    return h("details", { className: "t3m-card t3m-details" },
      h("summary", null, h("h2", null, "Patch Helper")),
      h("p", { className: "t3m-muted" }, "Try a patch against the chunks of this T3 Code build. Nothing is changed."),
      h("form", {
        className: "t3m-helper",
        onSubmit: async (e) => {
          e.preventDefault();
          const r = await run(() => admin.call("patch-test", form));
          if (r) setOut(r.results);
        },
      },
        field("find", "find (string)", { required: true, placeholder: "value:`action:settings`" }),
        field("match", "match (RegExp source, \\i = identifier)", { placeholder: "(\\i)\\.push\\(" }),
        field("flags", "flags", { placeholder: "g" }),
        field("replace", "replace", { placeholder: "$&/*mod*/" }),
        h("label", { className: "t3m-check" }, h("input", { type: "checkbox", checked: form.group, onChange: (e) => setForm({ ...form, group: e.target.checked }) }), "group"),
        h(Btn, { type: "submit", disabled: busy || !form.find }, "Run")),
      msg?.error && h("p", { className: "t3m-error" }, msg.error),
      out && (out.length === 0
        ? h("p", { className: "t3m-error" }, "find matches no chunk.")
        : out.map((r) => h("div", { key: r.chunk, className: "t3m-result" },
            h("div", null, h("code", null, r.chunk), r.entries.length ? ` entries ${r.entries.map((e) => (e ? "✓" : "✗")).join("")}` : "", r.error ? ` error: ${r.error}` : ""),
            r.before != null ? h("pre", { className: "t3m-diff" }, h("del", null, r.before), "\n", h("ins", null, r.after)) : h("p", { className: "t3m-muted" }, "No change.")))),
      out?.length > 1 && h("p", { className: "t3m-error" }, `find matches ${out.length}${out.length === 5 ? "+" : ""} chunks; make it unique.`));
  }

  function Page() {
    const index = useIndex();
    const settings = useSettings();
    if (!index) return h("p", { className: "t3m-page" }, "Loading…");
    const results = index.doctor?.results ?? [];
    const problems = index.mods.filter((m) => m.status === "degraded").length;
    const badPatches = results.filter((r) => !["ok", "skipped"].includes(r.status)).length;
    const sorted = [...index.mods].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
    return h("div", { className: "t3m-page" },
      h("header", { className: "t3m-page-head" },
        h("h1", null, "Mods"),
        h("p", { className: "t3m-muted" },
          `t3mods ${index.loader} · ${index.mods.length} mods`,
          problems ? ` · ${problems} not started` : "",
          index.doctor ? ` · ${results.length - badPatches}/${results.length} patches apply to this build (checked in ${index.doctor.ms} ms)` : ""),
        h("div", { className: "t3m-row" },
          h(Btn, { onClick: () => admin.call("open-folder", {}) }, "Open mods folder"),
          h(Btn, { variant: "ghost", onClick: () => admin.call("reload") }, "Reload window"))),
      h(Banner, { index }),
      h(Install),
      h(Browse, { index }),
      sorted.map((mod) => h(ModCard, { key: mod.id, mod, results: results.filter((r) => r.mod === mod.id), items: settings.get(mod.id) })),
      h(PatchHelper));
  }

  function SidebarButton() {
    const index = useIndex();
    if (!index || !api.ui.SidebarIconButton) return null;
    const problems = index.mods.filter((m) => m.status === "degraded").length;
    const waiting = index.pending.restart.length + index.pending.reload.length;
    const active = index.mods.filter((m) => !m.builtin && m.status === "ok").length;
    const tone = problems ? "bad" : waiting ? "warn" : "ok";
    const label = problems ? `Mods: ${problems} not started` : waiting ? "Mods: changes waiting" : `Mods: ${active} active`;
    const icon = h("span", { className: "t3m-icon", "data-tone": tone }, h(ModsIcon), h("span", { className: "t3m-dot" }));
    return h(api.ui.SidebarIconButton, { icon, label, onClick: open });
  }

  // Without the settings page (core patch broken), the manager opens as an overlay.
  let closeOverlay = null;
  function openOverlay() {
    if (closeOverlay) return;
    const host = document.createElement("div");
    host.className = "t3m-overlay";
    document.body.append(host);
    const root = createRoot(host);
    closeOverlay = () => {
      root.unmount();
      host.remove();
      closeOverlay = null;
    };
    root.render(h("div", { className: "t3m-overlay-panel", role: "dialog", "aria-label": "Mods" }, h(Btn, { className: "t3m-close", onClick: () => closeOverlay() }, "Close"), h(Page)));
  }
  api.lifecycle.own(() => closeOverlay?.());
  const pageAvailable = () => admin.index()?.doctor?.results.some((r) => r.key === "core/settings-page" && r.status === "ok");
  function open() {
    if (pageAvailable()) api.navigate("/settings/mods");
    else openOverlay();
  }

  api.slot("settings-mods", Page);
  api.slot("sidebar-footer", SidebarButton);
  api.command({ id: "open", title: "Mods: open manager", searchTerms: ["mods", "plugins", "extensions"], run: open });
  api.command({ id: "reload", title: "Mods: reload window", searchTerms: ["mods", "reload"], run: () => admin.call("reload") });
};
