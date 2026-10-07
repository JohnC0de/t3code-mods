// Pure helpers behind api.threads: turn the app's thread shells and thread projections into
// the plain objects that mods get. No app imports, so tests can feed them fixtures.

const WORKING = ["preparing", "queued", "starting", "running", "waiting"];

/** The app's own sidebar status for a thread shell (approval wins over input over working). */
export function threadStatus(shell) {
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "input";
  const runtime = shell.runtime;
  if (runtime && WORKING.includes(runtime.status)) return "working";
  if (runtime?.status === "idle") return "waiting";
  if (runtime?.status === "failed") return runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  if (shell.latestRun?.status === "failed") return "failed";
  return "ready";
}

const time = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** Finished after the user last opened it. Like the app, a thread never opened is not unread. */
export function isUnread(shell) {
  const done = time(shell.latestRun?.completedAt);
  const visited = time(shell.lastVisitedAt);
  return done !== null && visited !== null && done > visited;
}

/** The key that api.threads uses for a thread: stable, printable, unique across environments. */
export const threadKey = (ref) => `${ref.environmentId}/${ref.threadId}`;

/** A thread shell as a ThreadInfo (see types/t3mods.d.ts). */
export function toThreadInfo(shell, projectsById) {
  const ref = { environmentId: shell.environmentId, threadId: shell.id };
  const project = projectsById.get(shell.projectId);
  const settledAt = time(shell.settledAt);
  const unsettledAt = time(shell.unsettledAt);
  return {
    key: threadKey(ref),
    ref,
    title: shell.title,
    projectId: shell.projectId,
    project: project?.title ?? null,
    status: threadStatus(shell),
    unread: isUnread(shell),
    subagent: shell.lineage?.relationshipToParent === "subagent",
    parentThreadId: shell.lineage?.parentThreadId ?? null,
    archived: shell.archivedAt != null,
    settled: settledAt !== null && !(unsettledAt !== null && unsettledAt > settledAt),
    snoozedUntil: shell.snoozedUntil ?? null,
    pinned: shell.pinnedAt != null,
    branch: shell.branch ?? null,
    runStatus: shell.latestRun?.status ?? null,
    runId: shell.latestRun?.runId ?? null,
    completedAt: shell.latestRun?.completedAt ?? null,
    lastVisitedAt: shell.lastVisitedAt ?? null,
    updatedAt: shell.updatedAt,
    error: shell.runtime?.lastError ?? null,
    errorClass: shell.runtime?.lastErrorClass ?? null,
    provider: shell.providerInstanceId ?? null,
    model: shell.modelSelection?.model ?? null,
    runtimeMode: shell.runtimeMode ?? null,
    interactionMode: shell.interactionMode ?? null,
  };
}

/** Every thread that is not deleted, newest first. */
export function toThreadList(shells, projects) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return shells
    .filter((s) => s.deletedAt == null)
    .map((s) => toThreadInfo(s, byId))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/**
 * The open questions and approvals of a thread, from the app's pending-requests value
 * ({ approvals, userInputs }). Requests that cannot be answered from here any more
 * ("not_resumable") are left out.
 */
export function toPending(pending) {
  const approvals = (pending?.approvals ?? [])
    .filter((a) => a.responseCapability === "live")
    .map((a) => ({
      requestId: a.requestId,
      kind: a.requestKind,
      detail: a.detail ?? null,
      appName: a.appName ?? null,
      createdAt: a.createdAt,
      options: (a.options?.length ? a.options : DEFAULT_APPROVAL_OPTIONS).map((o) => ({ decision: o.decision, label: o.label, warning: o.warning ?? null })),
    }));
  const questions = (pending?.userInputs ?? [])
    .filter((q) => q.responseCapability !== "not_resumable")
    .map((q) => ({
      requestId: q.requestId,
      createdAt: q.createdAt,
      questions: q.questions.map((x) => ({
        id: x.id,
        header: x.header,
        question: x.question,
        multiSelect: Boolean(x.multiSelect),
        allowCustom: x.allowCustomAnswer !== false,
        options: x.options.map((o) => ({ label: o.label, description: o.description ?? "", value: o.value ?? o.label })),
      })),
    }));
  return { approvals, questions };
}

// What the app offers when a provider sends no choices (its approval panel, most-used first).
export const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Decline" },
];

/** The agent's last message in a thread projection, or null. */
export function lastAssistantMessage(projection) {
  const messages = projection?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].text?.trim()) return messages[i].text;
  }
  return null;
}

/**
 * Checks answers against the questions of a request and returns them in the shape the app
 * sends: { [questionId]: string | string[] }. Throws on a missing or unknown answer, so a
 * mod cannot send a half-answered request.
 */
export function checkAnswers(questions, answers) {
  const out = {};
  for (const q of questions) {
    const a = answers?.[q.id];
    if (a === undefined || a === null || a === "" || (Array.isArray(a) && a.length === 0)) throw new Error(`no answer for "${q.question}"`);
    const values = Array.isArray(a) ? a : [a];
    if (values.some((v) => typeof v !== "string")) throw new Error(`answers must be strings ("${q.question}")`);
    if (Array.isArray(a) && !q.multiSelect) throw new Error(`"${q.question}" takes one answer`);
    const known = new Set(q.options.map((o) => o.value));
    if (!q.allowCustom && values.some((v) => !known.has(v))) throw new Error(`"${q.question}" only takes one of its options`);
    out[q.id] = q.multiSelect ? values : values[0];
  }
  return out;
}

/** A readable message from a failed app command result ({ _tag: "Failure", cause }). */
export function failureText(result) {
  const seen = new Set();
  const find = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 6 || seen.has(v)) return null;
    seen.add(v);
    if (typeof v.message === "string" && v.message) return v.message;
    for (const k of Object.keys(v)) {
      const found = find(v[k], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return find(result?.cause, 0) ?? "the app refused the command";
}
