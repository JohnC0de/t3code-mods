# Calm thread

A long thread becomes a list of one-line titles. Each finished turn shows a title, its time and
its duration. Click a title to open the turn: your prompt, a one-line receipt of the work
("9 commands · 2 edits · 24m") and the answer. The latest finished turn is open.

- **Density.** Press **Alt+D** to cycle Focus, Normal and Full. The command palette has the same
  three commands ("Calm thread: Focus" and so on).
  - **Focus** folds every finished turn but the latest. A running turn shows only your prompt
    and one live line; no work log, no "Working for" clock.
  - **Normal** keeps every turn open, as T3 shows it, with titles above them.
  - **Full** also opens every "Worked for" fold and every tool group.
- **Receipts.** T3's "Worked for 24m 12s" row counts the work instead. Click it to see the work,
  as before.
- **The real answer.** When an agent ends a turn with a short note after its real answer, T3
  folds the real answer away. Calm thread shows it again above the note.
- **Since you left.** When you open a thread after 10 minutes or more away, a card at the end
  lists what finished, what waits on you, what still runs and what failed. **Dismiss** hides it.
- **Readable width** (off by default, so T3's Chat width setting or the wide-chat mod decides).
  When on, the whole answer, code and tables included, wraps at about 75 characters.
- **Find in thread.** While the find-in-thread bar (Ctrl+F) is open, Focus opens every turn, so
  text in folded turns can be found.
- **Quiet live rows.** No shimmer on the live tool row, and no clock that ticks every second.
  Full density keeps T3's clock.

All of it can change on the Mods page: density, model titles, the card and the width.

## Model titles (off by default)

A title is the first sentence of the agent's answer. When that sentence makes a poor title (too
short, too long, or "Done."), a small model can write one. The model also names what the latest
answer waits on, such as "Pick a path", and the title shows it.

To turn it on, open the mod's card on the Mods page, set the endpoint and turn on **Model
titles**. **Check** shows whether the endpoint answers.

- **URL**: an Anthropic Messages API endpoint. Empty means `ANTHROPIC_BASE_URL`, or
  `https://api.anthropic.com`.
- **Key file**: a file that holds the API key (`~` works). Empty means `ANTHROPIC_API_KEY`.
- **Model**: empty means `claude-haiku-5-5`.

The mod sends the turn's prompt (up to 600 characters) and answer (up to 2,000) to that endpoint,
once per answer. It saves the titles in `<T3 home>/mod-data/calm-thread/titles.json`, so a turn
never costs twice. After the first failed request, the mod sends no more until you change a
setting or reload.

## After an app update

One patch, `timeline-rows`, hands T3's timeline rows to the mod. If an app update breaks it, the
mod does not start and threads look as in plain T3. `t3mods doctor` shows the state of the patch.
The change applies when the window reloads.
