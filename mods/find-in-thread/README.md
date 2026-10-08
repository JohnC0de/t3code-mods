# Find in thread

Press **Ctrl+F** (**Cmd+F** on macOS) in a thread to find text in it. The **Find in thread** command in the
command palette opens the same bar.

- All matches are highlighted. The current match is orange.
- **Enter** and **Shift+Enter** (or the arrow buttons) go to the next and previous match.
- **Esc** closes the bar.
- Text that you select before you press Ctrl+F becomes the search.
- The search covers the whole thread, also messages that are scrolled out of view, and
  scrolls to each match.
- In a terminal or a code editor, Ctrl+F stays theirs.

## After an app update

The mod has one optional patch: it gives the mod the timeline's list of messages. If an
app update breaks that patch, the mod still works, but it finds text only in the part of the
thread that is on screen. `t3mods doctor` shows the state of the patch.
