#!/usr/bin/env bash
# One Linux test scenario, inside a container started by tools/linux-test.sh.
#   scenario.sh appimage | deb | pacman
# Mounts: /repo (this checkout, read-only), /artifacts (T3 Code AppImage and .deb), /out.
set -euo pipefail
scenario=${1:?scenario}
repo=/repo
appimage_src=$(ls /artifacts/T3-Code-*-x86_64.AppImage | head -n 1)
deb=$(ls /artifacts/T3-Code-*-amd64.deb | head -n 1)
NODE="" # a T3 Code executable, used in Node mode for the CLI and the checks
FAILS=0

step() { echo; echo "== $*"; }
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
check() { # check <description> <command...>
  local what=$1; shift
  if "$@" >/tmp/check.out 2>&1; then ok "$what"; else bad "$what"; sed 's/^/     /' /tmp/check.out | tail -n 20; fi
}
node_() { ELECTRON_RUN_AS_NODE=1 "$NODE" "$@"; }
cdp() { node_ "$repo/tools/cdp.mjs" eval "$1"; }
t3mods() { node_ "$HOME/.t3/t3mods/t3mods.mjs" "$@"; }

# One virtual display for the whole run: an app that restarts itself (update) needs it to stay.
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
export DISPLAY=:99
APP_ARGS=(--remote-debugging-port=9333 --disable-gpu)
start_app() { # start_app <command...>: the app, with CDP on port 9333
  "$@" "${APP_ARGS[@]}" >>/tmp/app.log 2>&1 &
}
wait_ready() { # until the mod runtime has booted (manager loaded) or 120 s
  local end=$((SECONDS + 120))
  while [ $SECONDS -lt $end ]; do
    [ "$(cdp "window.__t3mods?.loaded.has('manager') ?? false" 2>/dev/null)" = true ] && return 0
    sleep 1
  done
  echo "app log:"; tail -n 40 /tmp/app.log
  return 1
}
stop_app() {
  pkill -TERM -f 't3code' 2>/dev/null || true
  for _ in $(seq 20); do pgrep -f 't3code' >/dev/null || break; sleep 0.5; done
  pkill -KILL -f 't3code' 2>/dev/null || true
  sleep 1
}
all_mods_ok() {
  cdp "fetch('/__mods/index.json').then(r=>r.json()).then(i=>i.mods.filter(m=>m.enabled&&m.status!=='ok').map(m=>m.id+': '+m.problems.join('; ')))" | tee /tmp/mods.out
  grep -qx '\[\]' /tmp/mods.out
}
server_tier() { # the server-hello example sets a header on every backend response
  local port
  port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$HOME/.t3/userdata/server-runtime.json")
  curl -sSI "http://127.0.0.1:$port/" | grep -i '^x-t3mods: server-hello'
}
state_is() { t3mods status "${@:2}" | tee /dev/stderr | grep -q ": $1"; }

full_checks() {
  check "app starts and the mod runtime boots" wait_ready
  check "all mods start (patches apply to this Linux build)" all_mods_ok
  check "e2e: install, hot reload, toggle, fail closed, uninstall" node_ "$repo/tools/e2e.mjs" --mods "$HOME/.t3/mods"
  check "server tier runs in the backend" server_tier
  check "doctor passes through the CLI" t3mods doctor
}

# Mods under test: the examples and agent-images.
mkdir -p "$HOME/.t3/mods"
cp -r "$repo/examples/." "$HOME/.t3/mods/"
cp -r "$repo/mods/agent-images" "$HOME/.t3/mods/"

case $scenario in
  appimage)
    mkdir -p "$HOME/Applications"
    cp "$appimage_src" "$HOME/Applications/"
    old="$HOME/Applications/$(basename "$appimage_src")"
    cp -r "$repo/tools/linux/e2e-update" "$HOME/.t3/mods/"

    step "install.sh without Node, from an AppImage in ~/Applications"
    check "install.sh" sh "$repo/install.sh"
    NODE=$(sed -n "s/^T3MODS_APPDIR='\(.*\)'$/\1/p" "$HOME/.local/share/t3mods/appimage/current.env")/t3code
    check "unit tests pass on Linux" node_ --test "$repo"/tests/*.test.cjs
    check "launcher and menu entry exist" test -x "$HOME/.local/bin/t3code-mods" -a -f "$HOME/.local/share/applications/t3code-mods.desktop"
    check "status: installed" state_is installed

    step "start through the launcher"
    # Skip the first-run dialog, so the screenshot shows the Mods page.
    mkdir -p "$HOME/.t3/userdata"
    echo '{"onboardingCompletedAt":"2026-10-01T00:00:00.000Z"}' >"$HOME/.t3/userdata/client-settings.json"
    start_app "$HOME/.local/bin/t3code-mods"
    full_checks
    cdp "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Dismiss')?.click()" >/dev/null || true
    cdp "window.__TSR_ROUTER__.navigate({to:'/settings/mods'})" >/dev/null && sleep 3 &&
      node_ "$repo/tools/cdp.mjs" shot /out/mods-page.png >/dev/null && ok "screenshot /out/mods-page.png"

    step "app update: the updater replaces the AppImage and starts the new one"
    new="$HOME/Applications/T3-Code-0.0.99-nightly.test-x86_64.AppImage"
    mv "$old" "$new"
    cdp "fetch('/__mods/rpc/main/e2e-update/update',{method:'POST',body:JSON.stringify(['$new',['--remote-debugging-port=9333','--disable-gpu']])}).then(r=>r.json())" || true
    check "the loader hands the new AppImage to the launcher" grep -q "t3code-mods" /tmp/e2e-update.json
    for _ in $(seq 30); do pgrep -f "appimage/0.0.46" >/dev/null || break; sleep 1; done
    check "the new version starts with mods" wait_ready
    check "it runs from the new extracted copy" pgrep -f "appimage/0.0.99-nightly.test/squashfs-root/t3code"
    # /proc/<pid>/environ is the environment the process started with: the new version must
    # start without the old one's --require (its own loader adds it again).
    check "the loader's NODE_OPTIONS did not leak into the new version" sh -c '
      pid=$(pgrep -f -- "0.0.99-nightly.test/squashfs-root/t3code --no-sandbox --remote" | head -n 1)
      [ -n "$pid" ] && ! tr "\0" "\n" <"/proc/$pid/environ" | grep -q "t3mods-loader"'
    check "all mods start after the update" all_mods_ok
    check "status: installed on the new version" grep -q "0.0.99-nightly.test" "$HOME/.local/share/t3mods/appimage/current.env"
    stop_app

    step "uninstall"
    check "uninstall" t3mods uninstall
    check "launcher removed" test ! -e "$HOME/.local/bin/t3code-mods"
    check "AppImage kept" test -f "$new"
    ;;

  deb)
    step "install the .deb, then install.sh without Node"
    sudo dpkg -i "$deb" >/dev/null
    NODE="/opt/T3 Code (Nightly)/t3code"
    check "install.sh (one sudo step)" sh "$repo/install.sh"
    check "dpkg-divert sends app.asar to _app.asar" sh -c "dpkg-divert --list | grep -q '_app.asar'"
    check "status: installed" state_is installed

    start_app "$NODE" --no-sandbox
    full_checks
    stop_app

    step "app update: dpkg installs the package again"
    sudo dpkg -i "$deb" >/dev/null
    check "status: still installed" state_is installed
    start_app "$NODE" --no-sandbox
    check "app starts with mods after the update" wait_ready
    check "all mods start after the update" all_mods_ok
    stop_app

    step "uninstall"
    check "uninstall" t3mods uninstall
    check "no diversion left" sh -c "! dpkg-divert --list | grep -q '_app.asar'"
    pkg=$(dpkg-deb -f "$deb" Package)
    check "dpkg --verify: package files are original" dpkg --verify "$pkg"
    ;;

  pacman)
    step "build and install an AUR-style package"
    mkdir -p "$HOME/pkg"
    cp "$repo/tools/linux/PKGBUILD" "$HOME/pkg/"
    cp "$appimage_src" "$HOME/pkg/t3code.AppImage"
    (cd "$HOME/pkg" && PKGEXT=.pkg.tar makepkg -f --nodeps --noconfirm >/tmp/makepkg.log 2>&1) || { tail -n 30 /tmp/makepkg.log; exit 1; }
    pkgfile=$(ls "$HOME"/pkg/t3code-nightly-bin-*.pkg.tar)
    sudo pacman -U --noconfirm "$pkgfile" >/dev/null
    NODE=/opt/t3code-nightly-bin/t3code

    step "install.sh without Node"
    check "install.sh (one sudo step)" sh "$repo/install.sh"
    check "pacman hooks exist" sh -c "ls /etc/pacman.d/hooks/t3mods-t3code-nightly-bin-pre.hook /etc/pacman.d/hooks/t3mods-t3code-nightly-bin-post.hook"
    check "status: installed" state_is installed
    start_app /opt/t3code-nightly-bin/AppRun
    full_checks
    stop_app

    step "app update: pacman installs the package again"
    sudo pacman -U --noconfirm "$pkgfile" 2>&1 | tee /tmp/pacman.out
    check "the hooks ran" grep -q "putting the mod loader back" /tmp/pacman.out
    check "pacman warned about nothing" sh -c "! grep -i 'warning\|error' /tmp/pacman.out | grep -v 'is up to date -- reinstalling'"
    check "status: still installed" state_is installed
    start_app /opt/t3code-nightly-bin/AppRun
    check "app starts with mods after the update" wait_ready
    check "all mods start after the update" all_mods_ok
    stop_app

    step "uninstall, then remove the package with the loader installed"
    check "uninstall" t3mods uninstall
    check "hooks removed" sh -c "! ls /etc/pacman.d/hooks/t3mods-* 2>/dev/null"
    check "pacman -Qkk: package files are original" pacman -Qkk t3code-nightly-bin
    check "install again" t3mods install
    sudo pacman -R --noconfirm t3code-nightly-bin 2>&1 | tee /tmp/pacman.out
    check "pacman removes the app without warnings" sh -c "! grep -qi 'warning\|error' /tmp/pacman.out"
    check "nothing left in /opt" test ! -e /opt/t3code-nightly-bin
    ;;

  *) echo "unknown scenario $scenario"; exit 2 ;;
esac

echo
if [ "$FAILS" -eq 0 ]; then echo "PASS $scenario"; else echo "FAIL $scenario: $FAILS checks failed"; exit 1; fi
