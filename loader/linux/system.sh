#!/bin/sh
# Root part of `t3mods install` for T3 Code in a root-owned folder (.deb, AUR, other /opt
# installs). `t3mods install` runs it once through sudo; package-manager hooks run the
# root-owned copy in /usr/local/lib/t3mods afterwards.
#
#   system.sh install   <resources dir> <shim file>  set up, then apply the shim
#   system.sh uninstall <resources dir>              undo everything
#   system.sh reapply   <resources dir>              pacman hook, after a transaction
#   system.sh restore   <resources dir>              pacman hook, before a transaction
#
# How the shim survives app updates:
#   .deb    dpkg-divert sends every future app.asar to _app.asar, so no hook is needed.
#   pacman  hooks restore the package files before a transaction and reapply the shim after.
#   other   nothing; run `t3mods install` again after an update.
#
# Root never runs files from a user's home folder: the hooks run this copy, and the shim is
# a copy in /usr/local/lib/t3mods. The shim itself runs as the user who starts the app.
set -eu

LIB=/usr/local/lib/t3mods
HOOKS=/etc/pacman.d/hooks
action=${1:?action}
res=${2:?resources dir}
res=${res%/}

[ -f "$res/app.asar" ] || [ -f "$res/_app.asar" ] || { echo "t3mods: no app.asar in $res" >&2; exit 1; }

is_deb() { [ "$(cat "$res/package-type" 2>/dev/null)" = deb ] && command -v dpkg-divert >/dev/null 2>&1; }
pacman_owned() { command -v pacman >/dev/null 2>&1 && pacman -Qqo "$res/app.asar" >/dev/null 2>&1; }
diverted() { [ -n "$(dpkg-divert --listpackage "$res/app.asar" 2>/dev/null)" ]; }
# Hook files are named after the app folder, e.g. t3mods-t3code-nightly-bin.hook.
hook_name() { basename "$(dirname "$res")" | tr -c 'A-Za-z0-9._\n-' '-'; }

# Shim in place: original asar as _app.asar, a link for its unpacked files, and the shim.
apply() {
  if [ -f "$res/app.asar" ]; then
    rm -f "$res/_app.asar"
    mv "$res/app.asar" "$res/_app.asar"
  fi
  # A real folder here is a leftover of a Windows-style install; the package owns the original.
  [ -L "$res/_app.asar.unpacked" ] || rm -rf "$res/_app.asar.unpacked"
  [ -d "$res/app.asar.unpacked" ] && ln -sfn app.asar.unpacked "$res/_app.asar.unpacked"
  mkdir -p "$res/app"
  install -m 0644 "$LIB/shim/index.cjs" "$res/app/index.cjs"
  install -m 0644 "$LIB/shim/package.json" "$res/app/package.json"
}

# Back to the files the package installed.
restore() {
  rm -rf "$res/app"
  [ -L "$res/_app.asar.unpacked" ] && rm -f "$res/_app.asar.unpacked"
  if [ -f "$res/_app.asar" ] && [ ! -f "$res/app.asar" ]; then mv "$res/_app.asar" "$res/app.asar"; fi
  return 0
}

write_pacman_hooks() {
  target=${res#/}/app.asar
  mkdir -p "$HOOKS"
  cat >"$HOOKS/t3mods-$(hook_name)-pre.hook" <<EOF
[Trigger]
Type = Path
Operation = Upgrade
Operation = Remove
Target = $target

[Action]
Description = t3mods: restoring the original T3 Code files
When = PreTransaction
Exec = $LIB/system.sh restore "$res"
EOF
  cat >"$HOOKS/t3mods-$(hook_name)-post.hook" <<EOF
[Trigger]
Type = Path
Operation = Install
Operation = Upgrade
Target = $target

[Action]
Description = t3mods: putting the mod loader back into T3 Code
When = PostTransaction
Exec = $LIB/system.sh reapply "$res"
EOF
}

case $action in
  install)
    shim=${3:?shim file}
    install -d -m 0755 "$LIB/shim"
    install -m 0755 "$0" "$LIB/system.sh"
    install -m 0644 "$shim" "$LIB/shim/index.cjs"
    printf '%s\n' '{ "name": "t3code", "main": "index.cjs" }' >"$LIB/shim/package.json"
    chmod 0644 "$LIB/shim/package.json"
    if is_deb; then
      if ! diverted; then
        [ -f "$res/app.asar" ] && rm -f "$res/_app.asar"
        dpkg-divert --local --rename --divert "$res/_app.asar" --add "$res/app.asar"
      fi
      echo "t3mods: dpkg-divert keeps the shim through updates"
    elif pacman_owned; then
      write_pacman_hooks
      echo "t3mods: pacman hooks keep the shim through updates ($HOOKS/t3mods-$(hook_name)-*.hook)"
    else
      echo "t3mods: no package manager found for $res; run 't3mods install' again after each update"
    fi
    apply
    ;;
  uninstall)
    if command -v dpkg-divert >/dev/null 2>&1 && diverted; then
      rm -rf "$res/app"
      [ -L "$res/_app.asar.unpacked" ] && rm -f "$res/_app.asar.unpacked"
      dpkg-divert --local --rename --remove "$res/app.asar"
    else
      restore
    fi
    rm -f "$HOOKS/t3mods-$(hook_name)-pre.hook" "$HOOKS/t3mods-$(hook_name)-post.hook"
    ls "$HOOKS"/t3mods-*.hook >/dev/null 2>&1 || rm -rf "$LIB"
    ;;
  reapply) apply ;;
  restore) restore ;;
  *) echo "t3mods: unknown action $action" >&2; exit 2 ;;
esac
