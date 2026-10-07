# Contributing

Thanks for helping. Bug reports, broken-patch reports, new mods, docs and loader changes
are all welcome.

## Quick start

```sh
git clone https://github.com/JohnC0de/t3code-mods
cd t3code-mods
git config core.hooksPath .githooks   # runs the unit tests before each commit
bun run test
```

You need [Bun](https://bun.sh) and Node 22+ for the scripts: `bun run` starts them, and they
run the tests and the CLI with `node`. The loader itself has no dependencies.

## Where things live

| Path | What |
|---|---|
| `loader/` | The loader, CLI, runtime, patch engine and builtin mods ([architecture](docs/architecture.md)) |
| `loader/types/t3mods.d.ts` | The public mod API. Changes here are API changes. |
| `examples/` | Small example mods. Each one shows one feature. |
| `mods/` | Full mods that we maintain (for example `agent-images`) |
| `tests/` | Unit tests (`node --test`) |
| `tools/` | E2E checks, CDP helper, Linux test harness |
| `docs/` | User and contributor docs |

## Checks

Run what matches your change. There is no CI: these checks run on your machine.

| Change | Run |
|---|---|
| Any | `bun run test` |
| Patches (`loader/builtin/core`, `mods/*/patches.cjs`) | `bun run doctor` against the current Nightly |
| Runtime, manager, loader | `bun run dev` in one terminal, then `bun run e2e` |
| Registry, Browse, `t3mods://` links | `bun run e2e:registry` (starts the fake registry and its own isolated instance; `--app <dir>` picks the app, `--cdp <port>` the debug port) |
| Linux install or update code | `bun run test:linux` (needs Docker) |

Put the output of the checks that you ran in the pull request.

## When a T3 Code update breaks a patch

This is the most common and most useful contribution.

1. Run `bun run doctor` and note the failing patch keys.
2. Copy the new build's chunks:
   `ELECTRON_RUN_AS_NODE=1 "<app exe>" tools/extract-assets.cjs extracted/new`
3. Find the new code shape in `extracted/new/*.js`. Anchor on strings and prop names, not on
   minified identifiers. Use `\i` for identifiers.
4. Fix the `match`, then run `node loader/t3mods.mjs doctor --mods mods --assets extracted/new` until all
   patches are `ok`. The folder `extracted/new/server` holds the backend chunks for server patches.
5. Open a PR. Put the T3 Code version and the doctor output in the description.

## Mods

- Prefer the API (`api.slot`, `api.command`, `api.state`) to patches. Only core patches
  should need fixes after an app update.
- When you need a new surface, add a core patch in `loader/builtin/core/patches.cjs`, a slot
  or API in `loader/runtime.js`, and its type in `loader/types/t3mods.d.ts`.
- A required patch that fails must stop the mod (fail closed). Mark a patch `optional` only
  when the mod still works without it.
- Everything a mod registers must go through `api`, so that hot reload can remove it.

## Style

- Plain JavaScript (CommonJS for main and backend code, ES modules for the renderer), with
  JSDoc types where they help. No build step for the loader.
- Small, focused changes. Match the code around you.
- Each test must fail on a plausible real bug.
- Comments explain why, not what.
- Write docs in short sentences with common words.

## Pull requests

- One topic per PR. Explain the problem, the change and how you tested it.
- Do not include build output, app copies (`extracted/`, `sandbox/app/`) or personal data.
- By contributing, you agree that your work is licensed under the [MIT License](LICENSE).

## Conduct

Be kind and direct. See the [Code of Conduct](CODE_OF_CONDUCT.md).
