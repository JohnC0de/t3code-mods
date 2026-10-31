#!/bin/sh
# Starts T3 Code from a folder you own (an AppImage extracted by a setup script, for example
# ~/.local/opt/t3code-nightly/<version>), and puts the shim in first when the folder lacks it.
# Such folders get no update hook: every new version is a fresh folder without the shim, so
# point your launcher or desktop entry at this script instead of the executable.
#
#   launch.sh <t3code executable> [app args...]
#
# The check is two file tests, so a start with the shim in place costs nothing. Root-owned
# folders are left alone: `t3mods install` sets those up once, with package-manager hooks.
set -eu

exe=${1:?usage: launch.sh <t3code executable> [app args...]}
shift
dir=$(dirname "$exe")
res=$dir/resources
kit=${T3MODS_HOME:-$HOME/.t3/t3mods}

needs_shim() { [ ! -f "$res/app/index.cjs" ] || [ -f "$res/app.asar" ]; }

if needs_shim && [ -w "$res" ] && [ -f "$kit/t3mods.mjs" ]; then
  # Two launchers can start the same new version at once (two profiles); install moves
  # app.asar, so only one may run it. The second waits, then finds the shim in place.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$res/.t3mods-install.lock"
    flock 9
  fi
  if needs_shim; then
    echo "t3mods: putting the mod loader into $dir" >&2
    ELECTRON_RUN_AS_NODE=1 "$exe" "$kit/t3mods.mjs" install --app "$dir" >&2 ||
      echo "t3mods: install failed; starting T3 Code without mods" >&2
  fi
  exec 9>&-
fi

exec "$exe" "$@"
