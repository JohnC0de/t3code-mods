# Agent Inbox: page contract

The strip and the panel are plain pages in this mod folder. They run in their own windows, not
in the app page, so they have no mod API and no React. They talk to `main.cjs` only.

## Transport

- A page calls main with `rpc(method, ...args)`:
  `fetch("/__mods/rpc/main/agent-inbox/" + method, { method: "POST", body: JSON.stringify(args) })`.
  The reply is `{ ok: true, value }` or `{ ok: false, error }`.
- Main pushes to a page by running `window.inbox.update(model)` and, in the panel,
  `window.inbox.show(view)`. Each page defines `window.inbox` before it calls `rpc("state")`.

## Main methods a page may call

| Method | Args | Does |
|---|---|---|
| `state()` | | Returns the current `Model`, or `null` before the app page has published one |
| `act(action)` | `Action` | Runs the action in the app page; resolves when the app accepted it, rejects with the reason |
| `openInbox(opts)` | `{ cardKey?, threadKey? }` | Shows and focuses the panel in inbox view at that card (or at the first card of that thread) |
| `openList()` | | Shows and focuses the panel in list view |
| `peek(opts)` | `{ threadKey, y }` | Shows the panel without focus in peek view, next to the strip, at screen-relative strip `y` |
| `unpeek()` | | Hides a peek (not an inbox the user opened) |
| `closePanel()` | | Hides the panel |
| `fit(size)` | `{ width, height }` | Strip only: resizes its window to the pill (CSS px) |
| `dragEnd()` | | Strip only: snaps the strip back to the screen edge after a drag |

## Panel views (`window.inbox.show(view)`)

```js
{ mode: "inbox", cardKey: string | null }   // focused; keys work
{ mode: "list" }                            // focused; all agents grouped by project
{ mode: "peek", threadKey: string }         // not focused; small read-only card
```

## Model

```js
{
  version: 1,
  at: 1760000000000,                 // ms, when the app page built it
  strip: true,                       // false: hide the strip (the panel still opens by shortcut)
  shortcut: "Ctrl+Alt+Space",        // label for hints
  undoMs: 2500,                      // undo window before an answer is sent
  counts: { attention: 2, working: 3, done: 1 },
  dots: [Dot],                       // strip order, at most 12
  overflow: 0,                       // threads not shown as dots
  cards: [Card],                     // inbox order
  agents: [Agent],                   // list view, newest first
}

Dot   = { threadKey, ref, title, project, status, unread }
Agent = { threadKey, ref, title, project, status, unread, updatedAt, branch }
ref   = { environmentId, threadId }
status: "working" | "approval" | "input" | "failed" | "limited" | "done" | "idle"
  // done = finished and not yet seen; idle = finished and seen

Card = {
  key,                               // stable while the card is the same request/result
  kind: "question" | "approval" | "done" | "failed",
  threadKey, ref, title, project, status,
  at,                                // ms: when it started waiting, or finished
  message,                           // string | null: the agent's last message (Markdown text)
  canReply,                          // a free-text reply is allowed
  // kind "question":
  requestId, questions: [{ id, header, question, multiSelect, allowCustom,
                           options: [{ label, description, value }] }],
  // kind "approval":
  requestId, approval: { requestKind, detail, appName, options: [{ decision, label, warning }] },
  // kind "failed":
  error,                             // string | null
}
```

## Actions (`act(action)`)

```js
{ type: "answer",  ref, requestId, answers }   // answers: { [questionId]: string | string[] }
                                               // value = option.value, or typed text
{ type: "approve", ref, requestId, decision }  // decision from approval.options
{ type: "reply",   ref, text }                 // new message to the thread
{ type: "clear",   ref, cardKey }              // done/failed: mark seen; question/approval: hide
                                               // until the agent asks something else
{ type: "open",    ref }                       // focus the app on the thread, hide the panel
{ type: "stop",    ref }                       // interrupt the running turn
```

Answers, approvals and replies wait `undoMs` in the panel first; Esc cancels them there.
`act` re-checks in the app that the request is still pending and rejects otherwise
("The question changed"), so show the error on the card.
