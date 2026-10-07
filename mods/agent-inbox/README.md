# Agent Inbox

See your active agent threads at a glance, and answer the ones that wait for you without
leaving what you are doing. The inbox leaves out subagent threads, archived threads and threads
that you snoozed.

- **Strip.** A small pill at the right edge of the screen, on top of other windows. One dot per
  thread that is working (blue), waits for you (amber), finished and is not seen yet (green) or
  failed (red). Idle threads get no dot, and the strip shows at most 12. Hover
  a dot to peek; click it to answer. Drag the grip to move the pill up or down.
- **Inbox.** `Ctrl+Alt+Space` from any app, or a click on the strip. One card at a time:
  questions, approvals, finished work and failures, most urgent first.

## Keys

| Key | Does |
|---|---|
| `1`-`9` | Pick an option (questions and approvals) |
| `Space` | Type an answer or a reply; `Enter` sends it |
| `Esc` | Take back a choice before it is sent, or close the inbox |
| `J` / `K` | Next / previous card |
| `E` | Clear the card: finished work counts as seen; a question waits until the agent asks something else |
| `O` | Open the thread in T3 Code |
| `L` | All threads in the inbox, by project |
| `?` | Key help |

Every answer waits 2.5 seconds before it is sent; a thin line shows the time left. Before it
sends, the inbox checks that the question is still open.

## Options

Settings > Mods > Agent Inbox: **Show the edge strip**. The inbox still opens with the
shortcut when the strip is off.

## Notes

- Needs the `core/threads` patch. The 0.3.0 loader does not have it; it came with commit
  `23863dd`. With an older loader the Mods page says `requires core/threads: no such patch`.
  To update, pull the repository and run the install again.
- Not on the registry yet. Install it from this repository: `t3mods pack mods/agent-inbox`,
  then `t3mods add` the zip.
- `main.cjs` runs in the Electron main process, so changes to it need a T3 Code restart. The
  strip and inbox pages reload on their own when you edit them.
- `preview.html` shows both pages with sample data (`mock-model.js`) in a normal browser, for
  design work. `CONTRACT.md` describes the data the pages get.
