# Yumak Bot server image. Bots run inside this container; see docker/README.md for the host setup.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@yumakbot/server..." --filter "@yumakbot/app..." \
 && pnpm --filter @yumakbot/app build \
 && pnpm --filter @yumakbot/server build \
 && pnpm --filter @yumakbot/server deploy --prod --legacy /out \
 && cp -r server/dist /out/dist \
 && cp -r app/dist /out/app \
 && cp LICENSE NOTICE /out/

FROM node:22-bookworm-slim
# bubblewrap and socat: the Claude sandbox for Bash on Linux. tini: reaps orphaned processes.
# chromium and fonts: the bots' own browsers (Turkish letters, emoji and Chinese, Japanese and Korean
# pages must render; without a CJK font those pages show empty boxes).
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap socat tini ca-certificates git ripgrep \
    chromium fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin yumakbot \
 && mkdir -p /data && chown yumakbot:yumakbot /data
# Application files belong to root and stay read-only for the server user.
COPY --from=build --chown=root:root /out /srv/yumakbot
WORKDIR /srv/yumakbot
ENV NODE_ENV=production \
    YUMAKBOT_HOST=0.0.0.0 \
    YUMAKBOT_PORT=4319 \
    YUMAKBOT_DATA_DIR=/data \
    YUMAKBOT_APP_DIR=/srv/yumakbot/app \
    YUMAKBOT_BROWSER=/usr/bin/chromium \
    CLAUDE_CONFIG_DIR=/data/claude \
    HOME=/home/yumakbot
USER yumakbot
VOLUME ["/data"]
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:4319/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.mjs"]
