# Agent instructions

Adds your own text to the instructions that T3 Code gives every agent that has the T3 tools
(Claude, Codex, OpenCode, Pi, Cursor, ACP agents).

1. Edit `instructions.md` in the mod folder (`~/.t3/mods/agent-instructions/`).
2. Restart T3 Code. The backend reads the file once, when it starts.

An empty or missing file leaves the instructions unchanged. The mod patches the backend's code
at load time, so a T3 Code update can break it; `t3mods doctor` shows the state.
