# Agent notes

Rules for AI coding agents that work in this repo. Humans: see CONTRIBUTING.md.

- The loader has no dependencies and no build step. Keep it that way.
- `loader/types/t3mods.d.ts` is the public API. Update it, `docs/writing-mods.md` and the
  examples together.
- Never test against the user's live T3 Code. Use `bun run dev` (isolated profile) or the
  `sandbox/` copy. Never quit or restart the live app from an agent that runs inside it.
- Patches: anchor on strings and prop names, use `\i` for minified identifiers, and run
  `bun run doctor` (that is `doctor --mods mods`, so the repo's own mods are checked) before you finish.
- Checks before you finish: `bun run test`; `bun run e2e` for runtime, manager or loader
  changes, and `bun run e2e:registry` for registry, Browse or link changes (plain `e2e` skips those steps); `bun run test:linux` for Linux install or update changes.
- `notes/` is private and not part of the public repo.
