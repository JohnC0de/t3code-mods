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
 * Returns the model and `stale`: dismissed keys whose card no longer exists, to forget.
 */
export function buildInbox({ threads, details, dismissed = {}, since, now, strip = true, shortcut, undoMs = 2500 }) {
  const live = threads.filter((t) => isLive(t, now));
  const base = (t) => ({ threadKey: t.key, ref: t.ref, title: t.title || "Untitled thread", project: t.project ?? "No project", status: displayStatus(t, since) });

  const shown = live
    .filter((t) => displayStatus(t, since) !== "idle")
    .sort((a, b) => RANK[displayStatus(a, since)] - RANK[displayStatus(b, since)] || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const dots = shown.slice(0, MAX_DOTS).map((t) => ({ ...base(t), unread: t.unread }));

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
  const stale = Object.keys(dismissed).filter((k) => !keys.has(k) && (loaded.has(k.split("|")[0]) || !live.some((t) => t.key === k.split("|")[0])));

  const agents = live.slice(0, MAX_AGENTS).map((t) => ({ ...base(t), unread: t.unread, updatedAt: ms(t.updatedAt) ?? 0, branch: t.branch }));

  const model = {
    version: 1,
    at: now,
    strip,
    shortcut,
    undoMs,
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
