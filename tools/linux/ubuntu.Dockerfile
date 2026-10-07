# Test image for tools/linux-test.sh: the .deb's dependencies, a virtual display, and a
# non-root user with sudo. No Node: the tests use T3 Code's own Electron in Node mode.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libasound2t64 libatspi2.0-0t64 libgbm1 libgtk-3-0t64 libnotify4 libnss3 libsecret-1-0 libuuid1 \
      libxss1 libxtst6 xdg-utils desktop-file-utils xvfb xauth dbus-x11 sudo curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash tester && echo 'tester ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/tester
USER tester
WORKDIR /home/tester
