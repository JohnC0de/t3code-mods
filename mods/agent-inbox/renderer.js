// Agent Inbox, app-page half: reads threads through api.threads, builds the inbox model and
// hands it to main.cjs, which shows it in the edge strip and the inbox panel. main.cjs runs
// the user's choices back here through `act`.
import { buildInbox, wantDetails } from "./model.mjs";

const SHORTCUT = "Ctrl+Alt+Space";
let current = null; // { api, dismissed } of the running instance, for act()

/** @param {import("../../loader/types/t3mods").RendererApi} api */
export default (api) => {
  const strip = api.state.boolean("strip", true);
  const since = api.state.number("since", 0);
  if (!since.get()) since.set(Date.now());
  const dismissed = api.state.value("dismissed", {
    default: {},
    decode: (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined),
  });
  api.settings.toggle({ title: "Show the edge strip", description: `The inbox still opens with ${SHORTCUT}.`, value: strip });

  const main = api.main();
  let threads = [];
  const details = new Map(); // thread key -> { value, stop }
  let last = "";
  let timer = 0;

  const publish = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const values = new Map([...details].filter(([, d]) => d.value).map(([k, d]) => [k, d.value]));
      const { model, stale } = buildInbox({ threads, details: values, dismissed: dismissed.get(), since: since.get(), now: Date.now(), strip: strip.get(), shortcut: SHORTCUT });
      if (stale.length) dismissed.set((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !stale.includes(k))));
      const json = JSON.stringify({ ...model, at: 0 });
      if (json === last) return;
      last = json;
      main.publish(model).catch((e) => api.log("could not reach the strip:", e.message));
    }, 80);
  };

  // Load questions, approvals and last messages only for threads that have a card.
  const syncDetails = () => {
    const want = new Map(wantDetails(threads, { since: since.get(), now: Date.now() }).map((t) => [t.key, t]));
    for (const [key, d] of details) {
      if (want.has(key)) continue;
      d.stop();
      details.delete(key);
    }
    for (const [key, t] of want) {
      if (details.has(key)) continue;
      const entry = { value: null, stop: () => {} };
      details.set(key, entry);
      entry.stop = api.threads.watch(t.ref, (value) => {
        entry.value = value;
        publish();
      });
    }
  };

  api.threads.subscribe((list) => {
    threads = list;
    syncDetails();
    publish();
  });
  strip.subscribe(publish);
  dismissed.subscribe(publish);
  // Times in the model ("finished 3 min ago") come from `at`; re-send now and then so a model
  // that did not change still reaches a strip that opened later.
  const tick = setInterval(() => {
    last = "";
    publish();
  }, 60_000);

  api.command({ id: "open", title: "Agent Inbox: open the inbox", searchTerms: ["inbox", "agents", "questions"], run: () => main.openInbox({}) });
  api.command({ id: "list", title: "Agent Inbox: show all agents", searchTerms: ["inbox", "agents"], run: () => main.openList() });

  current = { api, dismissed };
  api.lifecycle.own(() => {
    clearTimeout(timer);
    clearInterval(tick);
    for (const d of details.values()) d.stop();
    if (current?.api === api) current = null;
    // The mod's fetches abort on unload, so tell main directly that the strip has no data.
    fetch("/__mods/rpc/main/agent-inbox/publish", { method: "POST", body: "[null]" }).catch(() => {});
  });
};

/** Called by main.cjs (ctx.renderer().act) when the user answers or clears a card. */
export async function act(action) {
  if (!current) throw new Error("Agent Inbox is not running in the app");
  const { api, dismissed } = current;
  const t = api.threads;
  switch (action.type) {
    case "answer":
      return void (await t.answer(action.ref, action.requestId, action.answers));
    case "approve":
      return void (await t.approve(action.ref, action.requestId, action.decision));
    case "reply":
      return void (await t.send(action.ref, action.text));
    case "stop":
      return void (await t.stop(action.ref));
    case "open":
      return void t.open(action.ref);
    case "clear": {
      const kind = action.cardKey.split("|")[1];
      if (kind === "done" || kind === "fail") return void (await t.markSeen(action.ref));
      dismissed.set((d) => ({ ...d, [action.cardKey]: Date.now() }));
      return;
    }
    default:
      throw new Error(`unknown action ${action.type}`);
  }
}
