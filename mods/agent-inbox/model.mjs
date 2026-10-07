// Builds the strip and inbox model (CONTRACT.md) from api.threads data. Pure, so tests can run it.

export const MAX_DOTS = 12;
export const MAX_DETAILS = 16;
export const MAX_AGENTS = 40;

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

// A thread shows in the strip and the list unless the user put it away.
const isLive = (t, now) => !t.archived && !t.subagent && !(ms(t.snoozedUntil) > now);

// Finished and not looked at since. A thread the user never opened counts when it finished
// after the inbox started (`since`), so years of old threads do not flood it on first run.
function isDone(t, since) {
  const done = ms(t.completedAt);
  if (t.runStatus !== "completed" || done === null) return false;
  const visited = ms(t.lastVisitedAt);
  return visited === null ? done >= since : done > visited;
}

function failedAt(t, since) {
  if (t.status !== "failed" && t.status !== "limited") return null;
  const at = ms(t.completedAt) ?? ms(t.updatedAt);
  const visited = ms(t.lastVisitedAt);
  if (at === null) return null;
  return (visited === null ? at >= since : at > visited) ? at : null;
}

/** Status for the strip: done = finished and unseen; a failure counts until it was seen too. */
export function displayStatus(t, since) {
  if (["approval", "input", "working"].includes(t.status)) return t.status;
  if (t.status === "failed" || t.status === "limited") return failedAt(t, since) === null ? "idle" : t.status;
  return isDone(t, since) ? "done" : "idle";
}

const RANK = { approval: 0, input: 0, failed: 1, limited: 1, working: 2, done: 3, idle: 4 };

/** Threads whose questions, approvals or last message the inbox needs (api.threads.watch). */
export function wantDetails(threads, { since, now }) {
  return threads
    .filter((t) => isLive(t, now))
    .filter((t) => t.status === "approval" || t.status === "input" || isDone(t, since) || failedAt(t, since) !== null)
    .sort((a, b) => RANK[displayStatus(a, since)] - RANK[displayStatus(b, since)] || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MAX_DETAILS);
}

export const cardKey = {
  question: (t, requestId) => `${t.key}|q|${requestId}`,
  approval: (t, requestId) => `${t.key}|a|${requestId}`,
  done: (t) => `${t.key}|done|${t.completedAt}`,
  failed: (t) => `${t.key}|fail|${t.runId ?? t.updatedAt}`,
};

/**
 * threads: api.threads.list(); details: Map thread key -> api.threads.watch value;
 * dismissed: { [cardKey]: ms } (cards the user cleared without answering).
 * Returns the model and `stale`: dismissed keys whose card no longer exists, to forget. The
 * dismissed map is shared by every running app, so only keys of this app's environments count.
 */
export function buildInbox({ threads, details, dismissed = {}, since, now, strip = true, shortcut, undoMs = 2500, stripY = 0.5 }) {
  const live = threads.filter((t) => isLive(t, now));
  const base = (t) => ({ threadKey: t.key, ref: t.ref, title: t.title || "Untitled thread", project: t.project ?? "No project", status: displayStatus(t, since) });

  const shown = live
    .filter((t) => displayStatus(t, since) !== "idle")
    .sort((a, b) => RANK[displayStatus(a, since)] - RANK[displayStatus(b, since)] || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const dots = shown.slice(0, MAX_DOTS).map((t) => ({ ...base(t), unread: t.unread, updatedAt: ms(t.updatedAt) ?? 0 }));

  const attention = [];
  const failed = [];
  const done = [];
  for (const t of live) {
    const d = details.get(t.key);
    const message = d?.lastMessage ?? null;
    if (d && (t.status === "approval" || t.status === "input")) {
      for (const q of d.questions) {
        attention.push({ ...base(t), key: cardKey.question(t, q.requestId), kind: "question", at: ms(q.createdAt) ?? now, message, canReply: false, requestId: q.requestId, questions: q.questions });
      }
      for (const a of d.approvals) {
        attention.push({
          ...base(t),
          key: cardKey.approval(t, a.requestId),
          kind: "approval",
          at: ms(a.createdAt) ?? now,
          message,
          canReply: false,
          requestId: a.requestId,
          approval: { requestKind: a.kind, detail: a.detail, appName: a.appName, options: a.options },
        });
      }
    }
    const failAt = failedAt(t, since);
    if (failAt !== null) failed.push({ ...base(t), key: cardKey.failed(t), kind: "failed", at: failAt, message, canReply: true, error: t.error });
    if (isDone(t, since)) done.push({ ...base(t), key: cardKey.done(t), kind: "done", at: ms(t.completedAt), message, canReply: true });
  }
  const byAt = (a, b) => b.at - a.at;
  const all = [...attention.sort(byAt), ...failed.sort(byAt), ...done.sort(byAt)];
  const cards = all.filter((c) => !(c.key in dismissed));
  // Forget a dismissal only once the thread's details are loaded, so a slow load does not
  // bring back a card the user cleared.
  const loaded = new Set(live.filter((t) => details.has(t.key)).map((t) => t.key));
  const keys = new Set(all.map((c) => c.key));
  const envs = new Set(threads.map((t) => t.ref.environmentId));
  const mine = (k) => [...envs].some((env) => k.startsWith(`${env}/`));
  const stale = Object.keys(dismissed).filter((k) => mine(k) && !keys.has(k) && (loaded.has(k.split("|")[0]) || !live.some((t) => t.key === k.split("|")[0])));

  const agents = live.slice(0, MAX_AGENTS).map((t) => ({ ...base(t), unread: t.unread, updatedAt: ms(t.updatedAt) ?? 0, branch: t.branch }));

  const model = {
    version: 1,
    at: now,
    strip,
    shortcut,
    undoMs,
    stripY,
    counts: {
      attention: live.filter((t) => t.status === "approval" || t.status === "input").length,
      working: live.filter((t) => t.status === "working").length,
      done: done.length,
    },
    dots,
    overflow: Math.max(0, shown.length - MAX_DOTS),
    cards,
    agents,
  };
  return { model, stale };
}

const KIND_RANK = { question: 0, approval: 0, failed: 1, done: 2 };

/**
 * entries: [{ app: { id, name }, model }], the leader's own first (a null model is skipped).
 * Returns one model of the same shape plus `apps`; every dot, card and agent gets `app`, the
 * app's display name (null when only one app runs). Strip settings come from the first model.
 */
export function mergeModels(entries) {
  const list = entries.filter((e) => e.model);
  if (!list.length) return null;
  const multi = list.length > 1;
  const label = (a) => (multi ? (a.name ?? (a.id === "default" ? "Personal" : a.id)) : null);
  // One list of all apps; a thread two apps both show stays with the first app.
  const gather = (field) => {
    const seen = new Set();
    return list.flatMap(({ app, model }) => {
      const items = (model[field] ?? []).filter((i) => !seen.has(i.threadKey)).map((i) => ({ ...i, app: label(app) }));
      for (const i of model[field] ?? []) seen.add(i.threadKey);
      return items;
    });
  };
  const lead = list[0].model;
  const dots = gather("dots").sort((a, b) => RANK[a.status] - RANK[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const agents = gather("agents");
  if (multi) agents.sort((a, b) => b.updatedAt - a.updatedAt);
  const sum = (f) => list.reduce((n, e) => n + (f(e.model) ?? 0), 0);
  return {
    version: 1,
    at: Math.max(...list.map((e) => e.model.at ?? 0)),
    strip: lead.strip,
    shortcut: lead.shortcut,
    undoMs: lead.undoMs,
    stripY: lead.stripY ?? 0.5,
    apps: list.map(({ app }) => ({ id: app.id, name: multi ? label(app) : (app.name ?? null) })),
    counts: { attention: sum((m) => m.counts.attention), working: sum((m) => m.counts.working), done: sum((m) => m.counts.done) },
    dots: dots.slice(0, MAX_DOTS),
    overflow: sum((m) => m.overflow) + Math.max(0, dots.length - MAX_DOTS),
    cards: gather("cards").sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at - a.at),
    agents: agents.slice(0, MAX_AGENTS),
  };
}
