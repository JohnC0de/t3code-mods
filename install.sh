#!/bin/sh
# Installs t3code-mods on Linux: ./install.sh [--appimage <file>] [--app <dir>]
# Needs no Node: without Node 20+ it runs the CLI on T3 Code's own Electron in Node mode.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cli="$here/loader/t3mods.mjs"

if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  exec node "$cli" install "$@"
fi

# An installed package (.deb, AUR) has an Electron we can use.
for exe in "/opt/T3 Code (Nightly)/t3code" "/opt/T3 Code/t3code" /opt/t3code-nightly-bin/t3code /opt/t3code-bin/t3code; do
  if [ -x "$exe" ]; then ELECTRON_RUN_AS_NODE=1 exec "$exe" "$cli" install "$@"; fi
done

# AppImage only: extract a temporary copy and use its Electron. (Running the AppImage itself
# in Node mode fails where its launcher adds --no-sandbox.)
appimage=""
prev=""
for a in "$@"; do
  [ "$prev" = --appimage ] && appimage=$a
  prev=$a
done
if [ -z "$appimage" ]; then
  appimage=$(ls -t "$HOME"/Applications/T3-Code-*.AppImage "$HOME"/AppImages/T3-Code-*.AppImage \
    "$HOME"/Downloads/T3-Code-*.AppImage "$HOME"/Desktop/T3-Code-*.AppImage 2>/dev/null | head -n 1)
  [ -n "$appimage" ] && set -- "$@" --appimage "$appimage"
fi
if [ -z "$appimage" ]; then
  echo "T3 Code not found. Install it, or pass --appimage <file> or --app <dir>." >&2
  exit 1
fi
appimage=$(cd "$(dirname "$appimage")" && pwd)/$(basename "$appimage")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod +x "$appimage"
echo "preparing a temporary copy of $(basename "$appimage") to run the installer ..."
(cd "$tmp" && "$appimage" --appimage-extract >/dev/null)
ELECTRON_RUN_AS_NODE=1 "$tmp/squashfs-root/t3code" "$cli" install "$@"
