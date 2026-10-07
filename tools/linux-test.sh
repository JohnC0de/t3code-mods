#!/usr/bin/env bash
# Linux checks in Docker, each with a real app start, the e2e checks and a simulated update:
#   appimage  AppImage in ~/Applications, launcher, update through the loader's spawn hook
#   deb       .deb on Ubuntu 24.04, dpkg-divert, dpkg reinstall, dpkg --verify after uninstall
#   pacman    AUR-style package on Arch, pacman hooks, reinstall, removal
# Usage: bash tools/linux-test.sh [scenario ...]   (default: all three)
# Needs Docker. Downloads the latest Nightly AppImage and .deb into platforms/linux once
# (gh CLI), or put them there yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
root=$(pwd -W 2>/dev/null || pwd)
art=platforms/linux
mkdir -p "$art/out"

if ! ls "$art"/T3-Code-*-x86_64.AppImage "$art"/T3-Code-*-amd64.deb >/dev/null 2>&1; then
  tag=$(gh release list -R pingdotgg/t3code -L 1 --json tagName --jq '.[0].tagName')
  echo "downloading T3 Code $tag ..."
  gh release download "$tag" -R pingdotgg/t3code -D "$art" -p 'T3-Code-*-x86_64.AppImage' -p 'T3-Code-*-amd64.deb'
fi
echo "testing with: $(cd "$art" && ls T3-Code-*-x86_64.AppImage)"

scenarios=("$@")
[ ${#scenarios[@]} -gt 0 ] || scenarios=(appimage deb pacman)
image() { [ "$1" = pacman ] && echo arch || echo ubuntu; }
for s in "${scenarios[@]}"; do
  img=$(image "$s")
  docker build -q -t "t3mods-test-$img" -f "tools/linux/$img.Dockerfile" tools/linux >/dev/null
done

failed=()
for s in "${scenarios[@]}"; do
  echo
  echo "######## $s"
  docker run --rm --init --shm-size=1g \
    -v "$root:/repo:ro" -v "$root/$art:/artifacts:ro" -v "$root/$art/out:/out" \
    "t3mods-test-$(image "$s")" bash /repo/tools/linux/scenario.sh "$s" || failed+=("$s")
done

echo
if [ ${#failed[@]} -eq 0 ]; then echo "all Linux scenarios passed: ${scenarios[*]}"; else echo "failed: ${failed[*]}"; exit 1; fi
