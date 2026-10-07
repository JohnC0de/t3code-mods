# Test image for tools/linux-test.sh: Arch with the AUR package's dependencies, makepkg,
# a virtual display, and a non-root user with sudo.
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed base-devel sudo which procps-ng curl \
      alsa-lib at-spi2-core cairo dbus expat gdk-pixbuf2 glib2 gtk3 hicolor-icon-theme libcups libdrm \
      libx11 libxcb libxcomposite libxdamage libxext libxfixes libxkbcommon libxrandr mesa nspr nss pango \
      systemd-libs xdg-utils zlib xorg-server-xvfb xorg-xauth \
 && pacman -Scc --noconfirm
RUN useradd -m -s /bin/bash tester && echo 'tester ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/tester
USER tester
WORKDIR /home/tester
