# Working keeps background commands

With T3's Working section on, a thread leaves Working as soon as its turn ends if the only
work left is a background command. The composer still shows "Running: ..." with a Stop
button, but the thread drops into the inbox as if it were done. Agents often start a
background command to wait on it: Claude Code wakes the agent when the command exits.

With this mod, a thread with any live background task stays in Working.

- A failed run, an approval, a question or a ready plan still puts the thread in the inbox.
- When the command ends, the thread returns to the top of the inbox as before.
- A dev server left running keeps its thread in Working until you press Stop.
- The completion alert and auto-settle do not change: T3 still treats a thread with only a
  command left as done there.

This is a port of [t3code PR #15413](https://github.com/pingdotgg/t3code/pull/15413).
Remove the mod when T3 ships a fix. The change applies when the page reloads.

## After an app update

One patch, `working-keeps-background-commands`, edits the Working check in the app's code.
If an app update breaks it, the mod does not start and threads behave as in plain T3.
`t3mods doctor` shows its state.
