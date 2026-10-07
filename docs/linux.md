# Linux

t3code-mods supports the three ways T3 Code ships on Linux. `./install.sh` finds the app and
picks the right mode. It needs no Node: without Node 20+, it runs the installer on T3 Code's
own Electron.

| Install type | How the loader gets in | After a T3 Code update |
|---|---|---|
| **AppImage** (`T3-Code-*.AppImage`) | Extracts the AppImage once per version into `~/.local/share/t3mods/appimage/` and adds the shim there. No root. | The loader catches the in-app update and starts the t3mods launcher, which extracts and patches the new version first. |
| **.deb** (Ubuntu, Debian) | One `sudo` step: `dpkg-divert` moves `app.asar` to `_app.asar`, and a root-owned shim goes into `resources/app/`. | Automatic: dpkg writes every new `app.asar` to the diverted path, so the shim stays. Works for in-app updates and `apt upgrade`. |
| **AUR** (`t3code-bin`, `t3code-nightly-bin`) and other `/opt` installs | One `sudo` step: the shim, plus pacman hooks in `/etc/pacman.d/hooks/`. | Automatic: the hooks restore the package files before each pacman transaction and put the shim back after it. |

All three load the loader from your kit (`~/.t3/t3mods`), so loader updates never need root.

## AppImage

```sh
./install.sh                                   # finds T3-Code-*.AppImage in ~/Applications, ~/Downloads, ...
./install.sh --appimage ~/Apps/T3-Code-0.0.46-nightly.20261005.2702-x86_64.AppImage
```

Then start **T3 Code (mods)** from your app menu, or run `~/.local/bin/t3code-mods`.

- The launcher sets `APPIMAGE` to your original file, so in-app updates keep working,
  including differential downloads.
- `t3code://` links (sign-in) open the modded app. The installer sets this with `xdg-mime`.
- Two versions stay on disk (current and previous), about 400 MB each.
- Starting the original AppImage directly still works, without mods.

## .deb and AUR

```sh
./install.sh            # asks for your sudo password once
```

What the root step does (see `loader/linux/system.sh`, which is short):

- copies itself and the shim to `/usr/local/lib/t3mods/` (root-owned);
- `.deb`: `dpkg-divert --local --rename --divert <resources>/_app.asar --add <resources>/app.asar`;
- pacman: writes `t3mods-<app>-pre.hook` and `t3mods-<app>-post.hook`;
- writes `<resources>/app/index.cjs` and links `_app.asar.unpacked` to the package's `app.asar.unpacked`.

Root never runs code from your home folder: the hooks run the root-owned copy, and the shim
runs as you, inside the app.

## Uninstall

```sh
node loader/t3mods.mjs uninstall        # or: ELECTRON_RUN_AS_NODE=1 "/opt/T3 Code (Nightly)/t3code" loader/t3mods.mjs uninstall
```

Without Node, replace `/opt/T3 Code (Nightly)` with your app folder (for example `/opt/t3code-bin`).
Keep the quotes: some folder names have spaces.

- AppImage: removes the launcher, the menu entry and the extracted copies. Your AppImage stays.
- .deb: removes the diversion; `dpkg --verify` then passes.
- pacman: removes the hooks; `pacman -Qkk` then passes.

## Troubleshooting

| Problem | Fix |
|---|---|
| `t3mods status` says `stale` | An update replaced the app without the hook (for example a manual copy). Run `./install.sh` again. |
| The app starts without mods | Run `node loader/t3mods.mjs doctor`. Start from a terminal and look for `[t3mods]` lines. |
| `install.sh` says T3 Code not found | Pass `--appimage <file>` or `--app <folder that holds resources/>`. |
| Other distributions (Flatpak, Snap) | Not supported: their app files are read-only. |

## Tests

`bun run test:linux` runs all three install types in Docker (Ubuntu 24.04 and Arch), each
with a real app start, the e2e checks, an update and an uninstall.
