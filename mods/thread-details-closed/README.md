# Thread details closed

T3 Code opens the thread details panel in every thread: the card at the top right with the
project, branch, **Commit & push** and **Changes**. With this mod the panel starts closed.

- The toolbar button (or a key bound to `threadPanel.toggle`) opens it, as before.
- A thread where you open the panel keeps it open, also after a restart. Close it, and that
  thread is back to the default.
- Turn the mod off, and the panel opens by default in every thread again.

The change applies when the page reloads.

## After an app update

The mod has two patches on the app's code:

- `default-closed` flips the default in the store that keeps the panel's state. Its four
  edits apply together or not at all. If an app update breaks it, the mod does not start and
  the panel opens by default again.
- `popover-to-inline` is optional. It keeps an open panel on screen when it moves from the
  popover to its place in the layout, for example when the window gets wider. Without it the
  panel closes in that case.

`t3mods doctor` shows the state of both.
