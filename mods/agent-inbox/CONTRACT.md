# Agent Inbox: page contract

The strip and the panel are plain pages in this mod folder. They run in their own windows, not
in the app page, so they have no mod API and no React. They talk to `main.cjs` only.

## Transport

- A page calls main with `rpc(method, ...args)`:
  `fetch("/__mods/rpc/main/agent-inbox/" + method, { method: "POST", body: JSON.stringify(args) })`.
  The reply is `{ ok: true, value }` or `{ ok: false, error }`.
- Main pushes to a page by running `window.inbox.update(model)` and, in the panel,
  `window.inbox.show(view, limits)`. Each page defines `window.inbox` before it calls `rpc("state")`.
- Sizes from a page are CSS px. The pages load from the app's origin, so they follow the app's
  zoom (`Ctrl +`); main multiplies by the zoom factor to get the window size.

## Main methods a page may call

| Method | Args | Does |
|---|---|---|
| `state()` | | Returns the current `Model`, or `null` before an app page has published one |
| `act(action)` | `Action` | Runs the action in the app that owns the thread; resolves when that app accepted it, rejects with the reason |
| `openInbox(opts)` | `{ cardKey?, threadKey? }` | Shows and focuses the panel in inbox view at that card (or at the first card of that thread) |
| `openList()` | | Shows and focuses the panel in list view |
| `peek(opts)` | `{ threadKey, offset, y }` | Shows the panel without focus in peek view, next to the strip, centered on the dot. `offset`: the dot's center in the strip page; `y`: the same on the screen, for a main older than 0.2.1 |
| `unpeek()` | | Hides a peek (not an inbox the user opened) |
| `closePanel()` | | Hides the panel |
| `fit(size)` | `{ width, height }` | Strip only: resizes its window to the pill. The strip sends it again when the zoom changes |
| `fitPanel(size)` | `{ id, width, height }` | Panel only: resizes its window to the card after a change in the page (another card, the list, the key help). `id` is the `limits.id` of the newest `show`; main ignores an older one |
| `dragEnd()` | | Strip only: snaps the strip back to the screen edge after a drag |

## Panel views (`window.inbox.show(view, limits)`)

```js
{ mode: "inbox", cardKey: string | null }   // focused; keys work
{ mode: "list" }                            // focused; all agents grouped by project
{ mode: "peek", threadKey: string }         // not focused; small read-only card; clicks go through
```

`limits` is `{ id, maxHeight }`: the render id and the largest window height in CSS px. `show`
renders the view and returns `{ id, width, height }`, the size the window needs; main sizes the
window to it before it shows the window. A main older than 0.2.1 sends no `limits` and keeps a
fixed window size; the card then fits the window.

## Model

```js
{
  version: 1,
  at: 1760000000000,                 // ms, when the app page built it (merged: the newest)
  strip: true,                       // false: hide the strip (the panel still opens by shortcut)
  shortcut: "Ctrl+Alt+Space",        // label for hints
  undoMs: 2500,                      // undo window before an answer is sent
  stripY: 0.5,                       // strip position on the screen edge, 0 top .. 1 bottom
  apps: [{ id, name }],              // the apps merged in this model (merged models only)
  counts: { attention: 2, working: 3, done: 1 },
  dots: [Dot],                       // strip order, at most 12
  overflow: 0,                       // threads not shown as dots
  cards: [Card],                     // inbox order
  agents: [Agent],                   // list view, newest first
}

Dot   = { threadKey, ref, title, project, app, status, unread, updatedAt }
Agent = { threadKey, ref, title, project, app, status, unread, updatedAt, branch }
app   = string | null   // display name of the owning app when more than one app runs, else null
                        // (a nameless default app is "Personal" next to others)
ref   = { environmentId, threadId }
status: "working" | "approval" | "input" | "failed" | "limited" | "done" | "idle"
  // done = finished and not yet seen; idle = finished and seen

Card = {
  key,                               // stable while the card is the same request/result
  kind: "question" | "approval" | "done" | "failed",
  threadKey, ref, title, project, app, status,
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

## Several apps (hub.cjs)

Apps that run from one mods folder each run `main.cjs`. `hub.cjs` connects them over one
endpoint per user and mods folder: the pipe `\\.\pipe\t3mods-agent-inbox-<12 hex of
sha1(lower-cased mods dir + user name)>` on Windows, a socket file in the temp folder elsewhere.
Messages are JSON lines.

- The first app to listen is the **leader**; the others are **followers**. Only the leader opens
  the strip and panel windows and registers the shortcut. The pages talk to the leader's `main.cjs`.
- A follower sends `hello` (`{ v: 1, app: { id, name, home } }`), then its newest model, and again
  on every change. `app` is `ctx.app`; an older loader gives `{ id: "default", name: null }`.
- The leader keeps each app's latest model and shows `mergeModels(...)` of them (`model.mjs`),
  its own first: cards by kind (question and approval, failed, done) then newest; dots by
  status then newest, at most 12; agents newest first, at most 40; counts summed. A thread that
  two apps show stays with the first. `strip`, `shortcut`, `undoMs` and `stripY` come from the
  leader's model.
- `act` goes to the app that owns the thread (matched by `ref.environmentId` and `threadId`),
  which runs it in its app page. An unknown thread is refused; an app that does not answer
  within 15 s gives an error. `open` also focuses that app's window.
- The palette commands "open the inbox" and "show all agents" work in every app: a follower
  sends them to the leader as `ui` calls.
- When the leader quits, the followers pick a new leader (random delay, retry); the new leader
  takes over the windows and the shortcut, and the others send their models again. When a
  follower quits, its model leaves the merge.
- `stripY` is a state cell of the mod, shared by the running apps. After a drag the leader's
  `main.cjs` calls the `setStripY` export of `renderer.js`.
