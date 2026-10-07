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
- **Zoom.** The strip and the inbox follow the app's zoom (`Ctrl +` / `Ctrl -`).

## Several apps

If you run more than one T3 Code app from one install (for example a personal one and a
"Work" one), they share one strip, one shortcut and one inbox. The inbox shows the threads of
all running apps, with the app name next to the project ("Work · api"). With one app running,
no name shows.

The app that started first shows the strip and owns `Ctrl+Alt+Space`. If you quit it, another
running app takes over within a few seconds. An answer, approval or reply goes to the app that
owns the thread. The strip position is shared; the "Show the edge strip" option of the app that
shows the strip decides.

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

- Needs the `core/threads` patch, which came with loader commit `23863dd`. With an older loader
  the Mods page says `requires core/threads: no such patch`. To get it, pull this repo, quit
  T3 Code and run `node loader/t3mods.mjs install` again.
- Not on the registry yet. Install it from this repository:
  `node loader/t3mods.mjs pack mods/agent-inbox`, then `node loader/t3mods.mjs add` the zip.
- `hub.cjs` connects the apps through a named pipe (a unix socket outside Windows) that only
  your user account and mods folder map to. It has no network access.
- `main.cjs` runs in the Electron main process, so changes to it need a T3 Code restart. The
  strip and inbox pages reload on their own when you edit them.
- `preview.html` shows both pages with sample data (`mock-model.js`) in a normal browser, for
  design work. `CONTRACT.md` describes the data the pages get.
