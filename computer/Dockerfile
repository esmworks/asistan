# Yumak Bot computer service: one sandboxed Linux desktop per bot. Build context is the repository root:
#   docker build -f computer/Dockerfile .      (docker/compose.yml does this)
# See "Botların bilgisayarı" in docker/README.md for the host setup.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@yumakbot/computer..." \
 && pnpm --filter @yumakbot/computer build

FROM node:22-bookworm-slim
# bubblewrap: one sandbox per bot. tigervnc: the virtual screen (Xvnc) the app watches. xfce parts:
# started one by one, without a session manager. chromium: the bots' browser, with chromium-l10n so it
# speaks the bot's language (without it every page is asked for in English). python3 with openpyxl and
# python-docx: bots edit spreadsheets and documents with them. git: bots work on repositories, with
# GitHub reached through the controller's relay (computer/src/git-relay.ts). fonts: Turkish letters,
# emoji and CJK.
# The slim base leaves out every translation; keep Turkish so the desktop's menus follow the locale.
RUN printf 'path-include /usr/share/locale/tr/*\n' > /etc/dpkg/dpkg.cfg.d/zz-yumakbot-locales \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    tini ca-certificates curl locales procps bubblewrap xdg-utils \
    tigervnc-standalone-server tigervnc-tools xauth x11-utils x11-xserver-utils dbus dbus-x11 \
    xfce4-panel xfwm4 xfdesktop4 xfce4-settings xfce4-terminal thunar mousepad \
    adwaita-icon-theme gnome-themes-extra-data \
    chromium chromium-l10n libreoffice-calc libreoffice-writer libreoffice-gtk3 libreoffice-l10n-tr \
    python3 python3-openpyxl python3-docx xdotool scrot git \
    fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && printf 'tr_TR.UTF-8 UTF-8\nen_US.UTF-8 UTF-8\n' >> /etc/locale.gen && locale-gen \
 && dbus-uuidgen --ensure=/etc/machine-id \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin yumakbot

# Desktop defaults (panel, wallpaper, default browser) and the browser launcher. Chromium's own
# menu entry is hidden: a Chromium started without the DevTools pipe could not be driven by the bot.
# The launcher's earlier name stays as a link: the panel copies its launchers into each bot's home on
# first start, and homes created before the rename still call the old path. Chromium's managed policy
# (etc/chromium/policies) hides the "unsupported command-line flag" bar the anti-automation flags in
# computer/src/session.ts would put over every page: only a policy can turn it off.
COPY --chown=root:root computer/rootfs/ /
# corepack: the root file system is read-only for the bots, so the pnpm and yarn launchers go in here.
RUN corepack enable \
 && ln -s yumakbot-browser /usr/local/bin/asistan-browser \
 && sed -i '0,/^\[Desktop Entry\]/s//[Desktop Entry]\nNoDisplay=true/' /usr/share/applications/chromium.desktop \
 && update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/yumakbot-browser 200 \
 && update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/local/bin/yumakbot-browser 200

# Application files belong to root and stay read-only for the service user.
COPY --from=build --chown=root:root /src/computer/dist /srv/computer/dist
COPY --chown=root:root computer/session.sh /srv/computer/session.sh
WORKDIR /srv/computer
ENV NODE_ENV=production \
    YUMAKBOT_COMPUTER_PORT=4320 \
    YUMAKBOT_COMPUTER_STATE=/run/computer \
    YUMAKBOT_WORKSPACES_ROOT=/data/workspaces \
    HOME=/home/yumakbot
USER yumakbot
EXPOSE 4320
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:4320/health',{headers:{authorization:'Bearer '+process.env.YUMAKBOT_COMPUTER_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.mjs"]
