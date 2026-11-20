# Cloudflare WARP as a SOCKS5 proxy for the bots' browsers. Some sites refuse a data centre's address
# before their page loads; WARP's addresses are shared with many people's devices and pass. See
# "Tarayıcının çıkış adresi" in docker/README.md. Started only with `--profile warp`.
FROM debian:bookworm-slim
# socat: WARP's proxy answers on its own loopback only, so this forwards the network's port to it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg socat \
 && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
 && echo 'deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main' \
    > /etc/apt/sources.list.d/cloudflare-client.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends cloudflare-warp \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/leafbot-warp
RUN chmod 755 /usr/local/bin/leafbot-warp
EXPOSE 1080
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD warp-cli --accept-tos status | grep -q Connected
ENTRYPOINT ["/usr/local/bin/leafbot-warp"]
