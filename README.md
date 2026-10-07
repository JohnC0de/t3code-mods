# t3code-mods

Mods for [T3 Code](https://github.com/pingdotgg/t3code), with hot reload. A mod is a folder of
CSS, React components, patches on the app's code, or Node code in its backend. Save a file and
the change shows in about 0.1 s, with no restart.

**Browse, install, review and publish mods at [t3mods.jonn.cc](https://t3mods.jonn.cc).**

![The Mods page in T3 Code settings](docs/media/mods-page.png)

> Not affiliated with, endorsed by, or sponsored by T3 Code or its authors. Mods run with full
> trust, like Vencord or BetterDiscord plugins: install only mods you read or trust.

Windows and Linux (AppImage, .deb, AUR: [details](docs/linux.md)). Survives app updates. Tested
with T3 Code Nightly 0.0.46. macOS: [help wanted](https://github.com/JohnC0de/t3code-mods/issues).

## Install

```sh
git clone https://github.com/JohnC0de/t3code-mods && cd t3code-mods
./install.sh                          # Linux; no Node needed
node loader/t3mods.mjs install        # Windows; quit T3 Code first
```

No Node on Windows? Use the app's own Electron:

```powershell
$env:ELECTRON_RUN_AS_NODE=1; & "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Nightly).exe" loader\t3mods.mjs install
```

Start T3 Code (Linux AppImage: **T3 Code (mods)** in the app menu). Settings gets a **Mods**
page; mods live in `~/.t3/mods`. `node loader/t3mods.mjs uninstall` restores the app.
[How it works](docs/architecture.md).

Below, `t3mods` means `node loader/t3mods.mjs`. `t3mods --help` lists every command.

## Get mods

- **Site:** **Open in T3 Code** on a mod page. The app shows author, version, contents and sha256,
  and installs only after you agree.
- **App:** Settings > Mods > **Browse the registry**: search, install, update.
- **CLI:** `t3mods search <words>`, `t3mods add <id>[@version]`, `t3mods update`.

Every download is checked against its sha256. Before it installs or updates a mod that runs
Node code (`patches.cjs`, `server.cjs`, `server-patches.cjs`, `main.cjs`), the loader warns and
asks. Neither check makes a mod safe: read what you install.

## Write a mod

`t3mods new hello` creates `~/.t3/mods/hello` with editor types, active at once.

| File | Runs in | After you save |
|---|---|---|
| `style.css` | page | swaps in place (~80 ms) |
| `renderer.js` | page | re-imported (~80 ms) |
| `patches.cjs` | app code, as it loads | page reloads (~0.7 s) |
| `server.cjs` | backend (Node) | re-required (<1 s) |
| `server-patches.cjs` | backend code, as it loads | app restart |
| `main.cjs` | Electron main | app restart |

Read [Writing mods](docs/writing-mods.md), the [examples](examples/) and the typed API in
[`loader/types/t3mods.d.ts`](loader/types/t3mods.d.ts). Prefer the API to patches: an app update
can break a patch, and `t3mods doctor` shows which still apply.

**With an agent,** keep it away from your live app. Run it in the clone with a prompt like:

```text
Read loader/types/t3mods.d.ts and docs/writing-mods.md. Create a mod that <does X> with
`node loader/t3mods.mjs new <id> --mods ./my-mods`. Prefer the API to patches. Test it in a
separate app instance: start `node loader/t3mods.mjs dev --isolated --mods ./my-mods --cdp 9333`
in the background, then drive it over CDP on port 9333.
```

## Publish

```sh
t3mods login                          # paste a token from https://t3mods.jonn.cc/settings/tokens
t3mods publish ./my-mods/my-mod --changelog "What changed"
```

`mod.json` needs an `id` and a semver `version`; a `README.md` becomes the mod page. Versions are
immutable and the first publisher owns the id ([details](docs/writing-mods.md#publish-to-the-registry)).
Show your mod and propose ideas in [Discussions](https://github.com/JohnC0de/t3code-mods/discussions).

## Mods in this repo

All three are also on the registry: `t3mods add <id>`.

| Mod | What it does |
|---|---|
| [`agent-instructions`](mods/agent-instructions) | Adds your `instructions.md` to what every agent with the T3 tools gets (Claude, Codex, OpenCode, Pi, Cursor, ACP). |
| [`agent-images`](mods/agent-images) | Shows the images the agent viewed, also when their tool group or turn is collapsed. |
| [`clean-tools`](mods/clean-tools) | Quieter tool rows: monospace commands, dimmed thinking, failed calls in red. |

## Contribute

Patch fixes after T3 Code updates help most. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
checks and [AGENTS.md](AGENTS.md) for agent rules. License: [MIT](LICENSE).
