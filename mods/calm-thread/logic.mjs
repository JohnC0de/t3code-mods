// Pure row logic for calm-thread: no DOM, no React, so tests run it under plain Node.
// `calmRows` takes the rows T3 derived for the chat timeline and returns the rows to draw:
// a title row per finished turn, finished turns folded to that title (Focus), T3's
// "Worked for" fold relabeled as a receipt, the answer that a fold hid put back (T3 #8879),
// and the "Since you left" card.

export const MODES = ["focus", "normal", "full"];

const MARKDOWN = [
  [/```[\s\S]*?(```|$)/g, " "], // code blocks
  [/!\[[^\]]*\]\([^)]*\)/g, ""], // images
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"], // links
  [/`([^`]*)`/g, "$1"],
  [/(\*\*|__)(.*?)\1/g, "$2"],
  [/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2"],
  [/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, ""],
  [/^\s*\|.*\|\s*$/gm, ""], // table rows
  [/<[^>\n]+>/g, ""],
];

/** Markdown to plain text, one line per paragraph. */
export function plainText(markdown) {
  let text = String(markdown ?? "");
  for (const [re, to] of MARKDOWN) text = text.replace(re, to);
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

/** The first sentence of the first paragraph, without its final period. */
export function firstSentence(markdown) {
  const para = plainText(markdown).split("\n").find((line) => line.trim()) ?? "";
  const match = /^(.+?[.!?])(?=\s+["'([]?[A-Z0-9]|\s*$)/.exec(para);
  return (match ? match[1] : para).trim().replace(/\.$/, "");
}

const FILLER = /^(done|ok|okay|sure|yes|no|great|alright|got it|here|now|next|so|i('ll| will| am|'m| have|'ve)|let me|let's|first|thanks)\b/i;

/** True when a first sentence reads badly as a turn title: too short, too long or filler. */
export function isWeakTitle(sentence) {
  const s = sentence.trim();
  return s.length < 12 || s.length > 90 || s.split(/\s+/).length < 3 || FILLER.test(s) || /[:?]$/.test(s);
}

/**
 * "Worked for 35m 12s" -> "35m"; "Worked for 1h 5m" -> "1h 5m"; "Worked for 42s" -> "42s";
 * null when there is no time. T3 leaves out zero units, so seconds go only next to h or m.
 */
export function shortDuration(foldLabel) {
  const m = /(?:Worked for|stopped after)\s+(.+)$/.exec(foldLabel ?? "");
  if (!m) return null;
  const big = m[1].trim().split(/\s+/).filter((part) => /\d[hm]$/.test(part));
  return big.length ? big.join(" ") : m[1].trim();
}

const COUNTED = [
  ["commands", "command", "commands"],
  ["edits", "edit", "edits"],
  ["searches", "search", "searches"],
  ["tools", "tool call", "tool calls"],
  ["agents", "agent", "agents"],
];

function itemKind(type) {
  if (type === "command_execution") return "commands";
  if (type === "file_change") return "edits";
  if (type === "file_search" || type === "web_search") return "searches";
  if (type === "dynamic_tool" || type === "dynamic_tool_call" || type === "mcp_tool_call") return "tools";
  return null;
}

/** Tool counts per run id, from T3's timeline entries (also the ones a fold hides). */
export function countRunWork(entries) {
  const byRun = new Map();
  const add = (runId, kind) => {
    if (!runId || !kind) return;
    const c = byRun.get(runId) ?? { commands: 0, edits: 0, searches: 0, tools: 0, agents: 0 };
    c[kind] += 1;
    byRun.set(runId, c);
  };
  for (const e of entries ?? []) {
    if (e.kind === "work") add(e.entry?.runId, itemKind(e.entry?.itemType));
    else if (e.kind === "event" && e.projectedItem?.item?.type === "subagent") add(e.projectedItem.item.runId, "agents");
  }
  return byRun;
}

/** "9 commands · 2 edits · 24m"; the T3 label when there is nothing to count. */
export function receiptLabel(counts, foldLabel) {
  if (foldLabel?.startsWith("You stopped")) return foldLabel;
  const parts = COUNTED.filter(([key]) => counts?.[key]).map(([key, one, many]) => `${counts[key]} ${counts[key] === 1 ? one : many}`);
  const time = shortDuration(foldLabel);
  if (!parts.length) return foldLabel;
  return [...parts, time].filter(Boolean).join(" · ");
}

const LIVE_KINDS = new Set(["working", "work-live", "thinking"]);
// Rows that stay in every view: they hold something to act on or a page the agent made.
const ALWAYS = new Set(["proposed-plan", "html-render", "mcp-app", "worktree-setup"]);

/**
 * The running turn in Focus: the prompt, one live row, the answer while it streams, and what
 * needs you (plans, pages, errors). T3's "Working for" header stays only when no live row shows.
 */
export function focusRunningRows(turn) {
  const live = turn.rows.findLast((r) => r.kind === "work-live" || r.kind === "thinking");
  const liveIndex = live ? turn.rows.indexOf(live) : -1;
  return turn.rows.filter((row, i) => {
    if (row === turn.user || ALWAYS.has(row.kind)) return true;
    if (row.kind === "message") return row.message?.streaming === true;
    if (row.kind === "working") return !live;
    if (row.kind === "work-live" || row.kind === "thinking") return row === live;
    if (row.kind === "work") return row.isExpandedToolGroup === true && i === liveIndex + 1 && live.expanded === true;
    if (row.kind === "event") return row.projectedItem?.item?.type === "error";
    if (row.kind === "context-compaction") return row.active === true;
    return false;
  });
}

/**
 * Splits rows into turns. A turn starts at a user message; rows before the first one stay
 * in `pre`. The last turn runs while the thread works, and so does a turn with live rows.
 */
export function segmentTurns(rows, { isWorking = false, latestRun = null } = {}) {
  const pre = [];
  const turns = [];
  let turn = null;
  for (const row of rows) {
    if (row.kind === "message" && row.message?.role === "user") {
      turn = { id: row.id, user: row, rows: [row], answer: null, fold: null, live: false, failed: false };
      turns.push(turn);
      continue;
    }
    if (!turn) {
      pre.push(row);
      continue;
    }
    turn.rows.push(row);
    if (row.kind === "message" && row.message?.role === "assistant") turn.answer = row;
    else if (row.kind === "turn-fold") turn.fold = row;
    else if (LIVE_KINDS.has(row.kind)) turn.live = true;
    if (
      (row.kind === "work-toggle" && row.hasFailure) ||
      (row.kind === "work" && row.groupedEntries?.some((e) => e.tone === "error")) ||
      (row.kind === "event" && row.projectedItem?.item?.type === "error")
    ) {
      turn.failed = true;
    }
  }
  const last = turns.at(-1);
  // A run that ended (failed, stopped) gets no fold, so "no answer and no fold" alone is not running.
  const ended = latestRun?.status === "failed" || latestRun?.status === "interrupted";
  if (last && latestRun?.status === "failed" && !last.live && !isWorking) last.failed = true;
  for (const t of turns) {
    t.running = t.live || (t === last && isWorking) || (t === last && !t.answer && !t.fold && !t.failed && !ended);
    // A turn that ended without an answer (failed, stopped) ends at its last dated row.
    t.finishedAt = t.answer
      ? (t.answer.message.updatedAt ?? t.answer.createdAt)
      : t.running
        ? null
        : (t.rows.findLast((r) => r.createdAt)?.createdAt ?? null);
  }
  return { pre, turns };
}

/** The turn's title: a model title for a weak first sentence when one is known. */
export function turnTitle(turn, titles) {
  if (!turn.answer) return { text: firstSentence(turn.user.message.text) || "Empty prompt", weak: false, fromPrompt: true };
  const first = firstSentence(turn.answer.message.text);
  const weak = isWeakTitle(first);
  const known = titles?.get(turn.answer.message.id);
  return { text: weak && known?.title ? known.title : first || "No text", weak, fromPrompt: false };
}

function assistantByRun(entries) {
  const byRun = new Map();
  for (const e of entries ?? []) {
    if (e.kind !== "message" || e.message?.role !== "assistant" || !e.message.runId) continue;
    const list = byRun.get(e.message.runId) ?? [];
    list.push(e);
    byRun.set(e.message.runId, list);
  }
  return byRun;
}

/**
 * A fold keeps a run's last message. When that message is a short note after the real answer
 * (T3 #8879), returns the hidden longer message as a T3 message row; else null.
 */
export function hiddenAnswerRow(turn, messagesByRun, rowIds) {
  if (!turn.fold || turn.fold.expanded || !turn.answer) return null;
  const shown = turn.answer.message.text.trim().length;
  if (shown >= 280) return null;
  let best = null;
  for (const e of messagesByRun.get(turn.fold.runId) ?? []) {
    if (rowIds.has(e.id) || e.message.id === turn.answer.message.id) continue;
    if (!best || e.message.text.length > best.message.text.length) best = e;
  }
  if (!best || best.message.text.trim().length < Math.max(400, shown * 2)) return null;
  return {
    kind: "message",
    id: best.id,
    createdAt: best.createdAt,
    message: best.message,
    ...(best.projectedItem === undefined ? {} : { projectedItem: best.projectedItem }),
    durationStart: best.message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    assistantTurnDiffSummary: undefined,
    revertTurnCount: undefined,
  };
}

/**
 * view: { mode, overrides: Map<turnId, boolean>, titles: Map<messageId, {title, needs, withNeeds}>,
 *   needsYou: string | null (open question or approval in T3), since: ISO | null, brief: boolean,
 *   dismissed: boolean, model: boolean }
 * Returns { rows, wants }: wants lists model titles to ask for ({ id, prompt, answer, needs }).
 */
export function calmRows(rows, ctx, view) {
  const wants = [];
  const { pre, turns } = segmentTurns(rows, ctx);
  const counts = countRunWork(ctx.entries);
  const messagesByRun = assistantByRun(ctx.entries);
  const rowIds = new Set(rows.map((r) => r.id));
  const finished = turns.filter((t) => !t.running);
  const latest = finished.at(-1);
  const out = [...pre];
  const brief = { done: [], failed: [], needs: null, running: null };

  for (const turn of turns) {
    if (turn.running) {
      out.push(...(view.mode === "focus" ? focusRunningRows(turn) : turn.rows));
      brief.running = firstSentence(turn.user.message.text);
      continue;
    }
    const title = turnTitle(turn, view.titles);
    const isLatest = turn === latest;
    const known = turn.answer ? view.titles?.get(turn.answer.message.id) : undefined;
    if (view.model && turn.answer && ((title.weak && !known) || (isLatest && !known?.withNeeds))) {
      wants.push({ id: turn.answer.message.id, prompt: plainText(turn.user.message.text), answer: turn.answer.message.text, needs: isLatest });
    }
    const needs = isLatest ? (view.needsYou ?? known?.needs ?? null) : null;
    const open = view.mode === "full" || (view.overrides?.get(turn.id) ?? (view.mode === "normal" || isLatest));
    out.push({
      kind: "calm-title",
      id: `calm-title:${turn.id}`,
      createdAt: turn.user.createdAt,
      threadKey: ctx.threadKey,
      turnId: turn.id,
      title: title.text,
      fromPrompt: title.fromPrompt,
      needs,
      failed: turn.failed,
      open,
      duration: turn.fold ? shortDuration(turn.fold.label) : null,
      at: turn.finishedAt,
    });
    if (view.since && turn.finishedAt && turn.finishedAt > view.since) {
      // A turn you stopped has no news; a failed one goes under Failed only.
      if (turn.failed) brief.failed.push(title.text);
      else if (turn.answer) brief.done.push(title.text);
      if (needs) brief.needs = needs;
    }
    if (!open) continue;
    for (const row of turn.rows) {
      if (row.kind === "turn-fold") {
        const label = receiptLabel(counts.get(row.runId), row.label);
        out.push(label === row.label ? row : { ...row, label });
        continue;
      }
      if (row === turn.answer) {
        const hidden = view.mode === "full" ? null : hiddenAnswerRow(turn, messagesByRun, rowIds);
        if (hidden) out.push(hidden);
      }
      out.push(row);
    }
  }

  if (view.brief && !view.dismissed && view.since && (brief.done.length || brief.failed.length)) {
    out.push({
      kind: "calm-brief",
      id: "calm-brief",
      createdAt: view.since,
      threadKey: ctx.threadKey,
      since: view.since,
      done: brief.done,
      failed: brief.failed,
      needs: brief.needs,
      running: brief.running,
    });
  }
  return { rows: out, wants };
}
