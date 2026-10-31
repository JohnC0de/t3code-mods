# Compact composer

The composer is one row: the prompt on the left, the model picker on the right. It grows
upward only while the prompt wraps (up to the app's own limit of about 9 lines, then it
scrolls), and drops back to one row after you send.

| Gone | Use instead |
|---|---|
| Send button | Enter (Ctrl+Enter, Ctrl+Alt+Enter and the other send keys work as before) |
| Stop button | Esc in the composer. The first Esc closes an open `@`, `$` or `/` menu; the next one stops the turn. With a draft in the composer, Esc stops the turn and keeps the draft. |
| Attach button | Drop files on the composer, or paste them |
| "Full access" line under the composer | Nothing: Full access is the usual mode. Any other mode (Supervised, Auto-accept edits, Auto) shows inside the row, left of the model picker. |

The model picker stays as the app draws it: provider icon, model, effort as text, and the bolt
when fast mode is on. Ctrl+Shift+M opens it and Ctrl+Shift+E changes the effort.

No patches: the mod is CSS on the app's data attributes, plus a small renderer for Esc and for
the room that the permissions label needs. Esc with a draft uses `api.threads`
(`core/threads`); without it, Esc still stops a turn while the prompt is empty.

Checked on T3 Code 0.1.7-nightly.20261031 (Linux).
