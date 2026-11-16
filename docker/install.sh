#!/usr/bin/env bash
# Sets up Yumak Bot on a fresh Ubuntu or Debian server in one go: Docker, the server and its database,
# HTTPS through Caddy, the AppArmor profile and the egress firewall, kept across reboots. Running it
# again updates the installation and keeps its settings and data. See "Tek komutla kurulum" in
# docker/README.md.
#
#   curl -fsSL https://raw.githubusercontent.com/esmworks/yumakbot/main/docker/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/esmworks/yumakbot/main/docker/install.sh | sudo bash -s -- --domain bot.example.com
#
# Afterwards the `yumakbot` command runs the same script: yumakbot update | status | logs | restart | access-key.
#
# It works in two stages. The first, possibly piped from the internet, only fetches the chosen release
# into the installation folder; it then hands over to that release's own copy of this script, so the
# rest always matches the compose files and scripts next to it.
set -euo pipefail

DEFAULT_REPO=https://github.com/esmworks/yumakbot.git
DIR=/opt/yumakbot
REPO=
COMMAND=install
DOMAIN=
VERSION=
COMPUTER=
ACCESS_KEY=
STAGE2=
REF=
LANG_GIVEN=
REST=()

# Messages in Turkish or English: --lang, else the shell's language. A fresh server is usually C.UTF-8.
case "${LC_ALL:-${LANG:-}}" in
  tr*) UI="tr" ;;
  *) UI=en ;;
esac
t() { if [ "$UI" = tr ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say() { printf '%s\n' "$(t "$1" "$2")"; }
step() { printf '\n==> %s\n' "$(t "$1" "$2")"; }
warn() { printf '%s %s\n' "$(t 'Uyarı:' 'Warning:')" "$(t "$1" "$2")" >&2; }
die() {
  printf '%s %s\n' "$(t 'Hata:' 'Error:')" "$(t "$1" "$2")" >&2
  exit 1
}

usage() {
  if [ "$UI" = tr ]; then
    cat <<'EOF'
Kullanım: install.sh [komut] [seçenekler]

Komutlar:
  install       Kurar ya da kuruluysa günceller (varsayılan)
  update        En son sürüme günceller; ayarlar ve veriler kalır
  status        Kapsayıcıların durumu
  logs [servis] Kayıtları izler (varsayılan: yumakbot)
  restart       Kapsayıcıları yeniden başlatır
  access-key    Erişim anahtarını gösterir
  compose ...   docker compose'u bu kurulumun dosyalarıyla çalıştırır

Seçenekler:
  --domain AD        Sunucunun alan adı (DNS kaydı bu sunucuyu göstermeli). Verilmezse
                     sunucunun IP adresinden bir sslip.io adı kullanılır.
  --version vX.Y.Z   Kurulacak sürüm (varsayılan: en son sürüm)
  --computer         Botların bilgisayarını açar (8 GB bellek önerilir)
  --no-computer      Botların bilgisayarını kapatır
  --access-key ANAHTAR
                     Erişim anahtarını siz verin (en az 24 karakter; harf, rakam, - _ . ~).
                     Verilmezse rastgele üretilir.
  --dir KLASÖR       Kurulum klasörü (varsayılan: /opt/yumakbot)
  --repo ADRES       Git deposu (varsayılan: esmworks/yumakbot)
  --lang tr|en       İletilerin dili
EOF
  else
    cat <<'EOF'
Usage: install.sh [command] [options]

Commands:
  install       Install, or update when already installed (default)
  update        Update to the latest release; settings and data stay
  status        State of the containers
  logs [service] Follow the logs (default: yumakbot)
  restart       Restart the containers
  access-key    Show the access key
  compose ...   Run docker compose with this installation's files

Options:
  --domain NAME      The server's domain name (its DNS record must point at this server).
                     Without it, an sslip.io name made from the server's IP address is used.
  --version vX.Y.Z   Release to install (default: the latest release)
  --computer         Turn on the bots' desktops (8 GB of memory recommended)
  --no-computer      Turn off the bots' desktops
  --access-key KEY   Choose the access key yourself (at least 24 characters: letters, digits, - _ . ~).
                     Without it, a random one is made.
  --dir FOLDER       Installation folder (default: /opt/yumakbot)
  --repo URL         Git repository (default: esmworks/yumakbot)
  --lang tr|en       Language of the messages
EOF
  fi
}

need_value() { [ "$2" -ge 2 ] || die "$1 bir değer ister" "$1 needs a value"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      install | update | status | restart | access-key)
        COMMAND=$1
        shift
        ;;
      logs | compose)
        COMMAND=$1
        shift
        REST=("$@")
        return
        ;;
      help | -h | --help)
        usage
        exit 0
        ;;
      --domain)
        need_value "$1" $#
        DOMAIN=$2
        shift 2
        ;;
      --version)
        need_value "$1" $#
        VERSION=$2
        shift 2
        ;;
      --computer)
        COMPUTER=1
        shift
        ;;
      --no-computer)
        COMPUTER=0
        shift
        ;;
      --access-key)
        need_value "$1" $#
        ACCESS_KEY=$2
        shift 2
        ;;
      --dir)
        need_value "$1" $#
        DIR=$2
        shift 2
        ;;
      --repo)
        need_value "$1" $#
        REPO=$2
        shift 2
        ;;
      --lang)
        need_value "$1" $#
        case $2 in
          tr | en)
            UI=$2
            LANG_GIVEN=1
            ;;
          *) die "--lang tr ya da en olur" "--lang takes tr or en" ;;
        esac
        shift 2
        ;;
      --stage2)
        STAGE2=1
        shift
        ;;
      --ref)
        need_value "$1" $#
        REF=$2
        shift 2
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
  done
}

ENV_FILE() { printf '%s/docker/.env' "$DIR"; }

# The last value of KEY in the env file, or nothing.
get_env() {
  local file
  file=$(ENV_FILE)
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$file" | tail -n 1
}

# Replaces KEY's line in the env file, or appends it. The file holds secrets, so it stays 0600.
set_env() {
  local file tmp
  file=$(ENV_FILE)
  tmp=$(mktemp "$file.XXXXXX")
  grep -v "^[[:space:]]*$1=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

compose() {
  local args=(-f "$DIR/docker/compose.yml" -f "$DIR/docker/compose.vps.yml" --env-file "$(ENV_FILE)")
  [ "$(get_env YUMAKBOT_COMPUTER)" != 1 ] || args+=(--profile computer)
  docker compose "${args[@]}" "$@"
}

require_root() {
  [ "$(uname -s)" = Linux ] || die "Bu betik Linux sunucuda çalışır." "This script runs on a Linux server."
  [ "$(id -u)" = 0 ] || die "Root olarak çalıştırın (sudo ile)." "Run it as root (with sudo)."
}

require_installed() {
  [ -f "$(ENV_FILE)" ] && [ -f "$DIR/docker/compose.vps.yml" ] ||
    die "$DIR altında kurulum yok. Önce kurun: install.sh" "No installation in $DIR. Install first: install.sh"
}

manage() {
  require_installed
  case $COMMAND in
    status)
      compose ps
      local port
      port=$(get_env YUMAKBOT_PORT)
      if curl -fsS --max-time 5 "http://127.0.0.1:${port:-4319}/api/health" >/dev/null 2>&1; then
        say "Sunucu yanıt veriyor: https://$(get_env YUMAKBOT_DOMAIN)" "The server answers: https://$(get_env YUMAKBOT_DOMAIN)"
      else
        warn "Sunucu yanıt vermiyor; kayıtlara bakın: yumakbot logs" "The server does not answer; see the logs: yumakbot logs"
      fi
      ;;
    logs) compose logs -f --tail 200 "${REST[@]:-yumakbot}" ;;
    restart)
      compose restart
      ! systemctl is-enabled --quiet yumakbot-firewall.service 2>/dev/null || systemctl restart yumakbot-firewall.service
      ;;
    access-key) get_env YUMAKBOT_ACCESS_KEY ;;
    compose) compose "${REST[@]}" ;;
  esac
}

check_os() {
  [ -r /etc/os-release ] || die "/etc/os-release yok; Ubuntu ya da Debian gerekir." "No /etc/os-release; Ubuntu or Debian is needed."
  # shellcheck disable=SC1091
  . /etc/os-release
  local major=${VERSION_ID%%.*}
  case "${ID:-}" in
    ubuntu) [ "${major:-0}" -ge 22 ] || die "Ubuntu 22.04 ya da sonrası gerekir." "Ubuntu 22.04 or later is needed." ;;
    debian) [ "${major:-0}" -ge 12 ] || die "Debian 12 ya da sonrası gerekir." "Debian 12 or later is needed." ;;
    *) die "Yalnızca Ubuntu (22.04+) ve Debian (12+) destekleniyor; bu sistem: ${PRETTY_NAME:-$ID}" \
      "Only Ubuntu (22.04+) and Debian (12+) are supported; this system: ${PRETTY_NAME:-$ID}" ;;
  esac
}

ensure_packages() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  [ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  command -v ip >/dev/null 2>&1 || missing+=(iproute2)
  [ ${#missing[@]} -eq 0 ] && return 0
  step "Gerekli paketler kuruluyor: ${missing[*]}" "Installing required packages: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
}

latest_release() {
  git ls-remote --tags --refs "$1" 'v*' |
    sed -n 's|.*refs/tags/||p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1
}

# Stage 1: puts the chosen release into DIR.
fetch_source() {
  if [ -z "$REPO" ]; then
    if [ -d "$DIR/.git" ]; then REPO=$(git -C "$DIR" remote get-url origin); else REPO=$DEFAULT_REPO; fi
  fi
  REF=${VERSION:-$(latest_release "$REPO")}
  REF=${REF:-main}
  checkout "$REF"
  if [ ! -f "$DIR/docker/install.sh" ]; then
    [ -z "$VERSION" ] ||
      die "$REF bu kurulum betiğinden eski; daha yeni bir sürüm seçin ya da --version main." \
        "$REF is older than this installer; choose a newer release, or --version main."
    # Releases made before this installer existed cannot be installed with it.
    warn "En son sürüm ($REF) bu kurulum betiğinden eski; ana dal (main) kuruluyor." \
      "The latest release ($REF) is older than this installer; installing the main branch instead."
    REF=main
    checkout "$REF"
    [ -f "$DIR/docker/install.sh" ] || die "$REPO deposunda kurulum betiği yok." "$REPO has no installer."
  fi
}

checkout() {
  step "Yumak Bot $1 indiriliyor ($DIR)" "Fetching Yumak Bot $1 ($DIR)"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" remote set-url origin "$REPO"
    git -C "$DIR" fetch --quiet --depth 1 origin "$1" ||
      die "$1 indirilemedi." "Could not fetch $1."
    git -C "$DIR" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD ||
      die "$DIR içindeki dosyalarda yerel değişiklik var; görmek için: git -C $DIR status" \
        "Files in $DIR have local changes; see them with: git -C $DIR status"
  else
    if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
      die "$DIR boş değil ve bir Yumak Bot kurulumu değil." "$DIR is not empty and is not a Yumak Bot installation."
    fi
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$1" "$REPO" "$DIR" ||
      die "$1 indirilemedi." "Could not fetch $1."
  fi
}

check_resources() {
  local mem_mb disk_gb
  mem_mb=$(($(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo) / 1024))
  [ "$mem_mb" -ge 1800 ] ||
    die "Bu sunucuda ${mem_mb} MB bellek var; en az 2 GB gerekir (4 GB önerilir)." \
      "This server has ${mem_mb} MB of memory; at least 2 GB is needed (4 GB recommended)."
  [ "$mem_mb" -ge 3600 ] ||
    warn "${mem_mb} MB bellek: çalışır, ama botların tarayıcıları için 4 GB önerilir." \
      "${mem_mb} MB of memory: it works, but 4 GB is recommended for the bots' browsers."
  if [ "$(effective_computer)" = 1 ] && [ "$mem_mb" -lt 7400 ]; then
    warn "Botların bilgisayarı tek başına 6 GB'a kadar bellek kullanır; 8 GB önerilir." \
      "The bots' desktops alone use up to 6 GB of memory; 8 GB is recommended."
  fi
  disk_gb=$(($(df -Pk / | awk 'NR==2 {print $4}') / 1024 / 1024))
  [ "$disk_gb" -ge 10 ] ||
    warn "Diskte ${disk_gb} GB boş yer var; imajlar ve veriler için en az 10 GB önerilir." \
      "The disk has ${disk_gb} GB free; at least 10 GB is recommended for the images and data."
}

effective_computer() {
  if [ -n "$COMPUTER" ]; then printf '%s' "$COMPUTER"; else printf '%s' "$(get_env YUMAKBOT_COMPUTER)"; fi
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    step "Docker kuruluyor" "Installing Docker"
    # Docker's own installer: adds Docker's apt repository and installs Engine and the compose plugin.
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh >/dev/null
    rm -f /tmp/get-docker.sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  local version
  version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
    die "Docker çalışmıyor: systemctl status docker" "Docker is not running: systemctl status docker"
  [ "${version%%.*}" -ge 26 ] ||
    die "Docker $version kurulu; 26 ya da sonrası gerekir. Güncelleyip yeniden deneyin." \
      "Docker $version is installed; 26 or later is needed. Update it and try again."
  docker compose version >/dev/null 2>&1 ||
    die "docker compose eklentisi yok: apt-get install docker-compose-plugin" \
      "The docker compose plugin is missing: apt-get install docker-compose-plugin"
}

is_private_ipv4() {
  case $1 in
    10.* | 127.* | 192.168.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

# The address this server reaches the internet from, if it is a public one. Read from the routing
# table rather than asked of an outside service.
public_ipv4() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  [ -n "$ip" ] && ! is_private_ipv4 "$ip" && printf '%s' "$ip"
}

choose_domain() {
  DOMAIN=${DOMAIN:-$(get_env YUMAKBOT_DOMAIN)}
  local ip
  ip=$(public_ipv4 || true)
  if [ -z "$DOMAIN" ]; then
    [ -n "$ip" ] ||
      die "Bu sunucunun genel IPv4 adresi bulunamadı (NAT arkasında olabilir). --domain ile bu sunucuyu gösteren bir ad verin; alan adınız yoksa genel adresinizden: 1-2-3-4.sslip.io gibi." \
        "Could not find this server's public IPv4 address (it may be behind NAT). Give a name that points at it with --domain; without a domain, one made from the public address works: like 1-2-3-4.sslip.io."
    DOMAIN="${ip//./-}.sslip.io"
  fi
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  DOMAIN=${DOMAIN#https://}
  DOMAIN=${DOMAIN#http://}
  DOMAIN=${DOMAIN%%/*}
  local name='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  [[ $DOMAIN =~ $name ]] ||
    die "Geçersiz alan adı: $DOMAIN" "Not a valid domain name: $DOMAIN"
  if [ -n "$ip" ] && command -v getent >/dev/null 2>&1; then
    local resolved
    resolved=$( (getent ahostsv4 "$DOMAIN" 2>/dev/null || true) | awk '{print $1}' | sort -u | tr '\n' ' ')
    case " $resolved " in
      *" $ip "*) ;;
      *) warn "$DOMAIN şu an bu sunucuyu ($ip) göstermiyor (${resolved:-kayıt yok}). DNS kaydı düzelince HTTPS sertifikası kendiliğinden alınır." \
        "$DOMAIN does not point at this server ($ip) yet (${resolved:-no record}). Once the DNS record is right, the HTTPS certificate is fetched by itself." ;;
    esac
  fi
}

write_env() {
  local file
  file=$(ENV_FILE)
  if [ ! -f "$file" ]; then
    (
      umask 077
      printf '# Written by docker/install.sh, which keeps the values below on updates. See docker/.env.example.\n' >"$file"
    )
  fi
  chmod 600 "$file"
  # Hex values: they go into DATABASE_URL and compose files as they are.
  local key
  for key in POSTGRES_PASSWORD YUMAKBOT_COMPUTER_TOKEN YUMAKBOT_PROXY_SECRET; do
    [ -n "$(get_env "$key")" ] || set_env "$key" "$(random_hex)"
  done
  local allowed='^[A-Za-z0-9._~-]{24,}$'
  if [ -n "$ACCESS_KEY" ]; then
    [[ $ACCESS_KEY =~ $allowed ]] ||
      die "Erişim anahtarı en az 24 karakter olmalı ve yalnızca harf, rakam ve - _ . ~ içermeli." \
        "The access key must be at least 24 characters of letters, digits and - _ . ~ only."
    set_env YUMAKBOT_ACCESS_KEY "$ACCESS_KEY"
  elif [ -z "$(get_env YUMAKBOT_ACCESS_KEY)" ]; then
    set_env YUMAKBOT_ACCESS_KEY "$(random_hex)"
  fi
  set_env YUMAKBOT_DOMAIN "$DOMAIN"
  set_env YUMAKBOT_PUBLIC_URL "https://$DOMAIN"
  set_env YUMAKBOT_ALLOWED_HOSTS "$DOMAIN"
  set_env YUMAKBOT_SECURE_COOKIES 1
  [ -n "$(get_env YUMAKBOT_PORT)" ] || set_env YUMAKBOT_PORT 4319
  set_env YUMAKBOT_VERSION "$IMAGE_TAG"
  local computer
  computer=$(effective_computer)
  set_env YUMAKBOT_COMPUTER "${computer:-0}"
  if [ "$computer" = 1 ]; then
    set_env YUMAKBOT_COMPUTER_URL http://computer-api:4320
  else
    set_env YUMAKBOT_COMPUTER_URL ''
  fi
  set_env YUMAKBOT_INSTALL_LANG "$UI"
}

# Ports 80 and 443 must be free for Caddy, unless it is this installation's Caddy holding them.
check_ports() {
  [ -z "$(compose ps -q caddy 2>/dev/null)" ] || return 0
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '[:.](80|443)$'; then
    die "80 ya da 443 numaralı bağlantı noktasını başka bir program kullanıyor (ör. nginx, Apache). Onu kapatın ya da Yumak Bot'u docker/README.md'deki elle kurulumla kendi ters vekilinizin arkasına koyun." \
      "Another program uses port 80 or 443 (e.g. nginx, Apache). Stop it, or put Yumak Bot behind your own reverse proxy with the manual setup in docker/README.md."
  fi
}

start_containers() {
  local server=ghcr.io/esmworks/yumakbot-server:$IMAGE_TAG
  local computer=ghcr.io/esmworks/yumakbot-computer:$IMAGE_TAG
  local build=()
  step "İmajlar indiriliyor" "Pulling the images"
  compose pull --quiet db caddy
  if [[ $REF =~ ^v[0-9] ]] && docker pull --quiet "$server" >/dev/null 2>&1 &&
    { [ "$(get_env YUMAKBOT_COMPUTER)" != 1 ] || docker pull --quiet "$computer" >/dev/null 2>&1; }; then
    :
  else
    build=(--build)
    warn "$REF için hazır imaj yok; imajlar bu sunucuda derleniyor. Bu 10-20 dakika sürer ve 4 GB'tan az bellekte yarıda kalabilir." \
      "There is no ready-made image for $REF; the images are built on this server. This takes 10-20 minutes and can fail with less than 4 GB of memory."
  fi
  if [ "$(get_env YUMAKBOT_COMPUTER)" != 1 ]; then
    # A desktop service left from an earlier installation with --computer.
    docker compose -f "$DIR/docker/compose.yml" -f "$DIR/docker/compose.vps.yml" --env-file "$(ENV_FILE)" \
      --profile computer rm --stop --force computer >/dev/null 2>&1 || true
  fi
  step "Kapsayıcılar başlatılıyor" "Starting the containers"
  compose up -d "${build[@]}"
}

wait_healthy() {
  local port
  port=$(get_env YUMAKBOT_PORT)
  step "Sunucunun açılması bekleniyor" "Waiting for the server to start"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port:-4319}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  die "Sunucu 3 dakikada açılmadı. Kayıtlar: yumakbot logs" "The server did not start within 3 minutes. Logs: yumakbot logs"
}

wait_https() {
  step "HTTPS sertifikası bekleniyor ($DOMAIN)" "Waiting for the HTTPS certificate ($DOMAIN)"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 4
  done
  warn "https://$DOMAIN henüz yanıt vermiyor. DNS kaydının bu sunucuyu gösterdiğine ve sağlayıcınızın güvenlik duvarında 80 ve 443 numaralı bağlantı noktalarının açık olduğuna bakın; sertifika sonra kendiliğinden alınır. Kayıtlar: yumakbot logs caddy" \
    "https://$DOMAIN does not answer yet. Check that the DNS record points at this server and that your provider's firewall allows ports 80 and 443; the certificate is then fetched by itself. Logs: yumakbot logs caddy"
}

# Before the containers start: compose.yml reads YUMAKBOT_APPARMOR when it creates them.
setup_apparmor() {
  step "AppArmor ayarlanıyor" "Setting up AppArmor"
  sh "$DIR/docker/apparmor.sh" --env "$(ENV_FILE)" >/dev/null
}

setup_host() {
  step "Güvenlik duvarı ayarlanıyor" "Setting up the firewall"
  # Docker starts the containers again after a reboot; this service puts the egress rules back each
  # time, and again whenever Docker restarts (Docker keeps the chain but the rules go with a reboot).
  cat >/etc/systemd/system/yumakbot-firewall.service <<EOF
[Unit]
Description=Yumak Bot egress firewall (keeps the bots' containers away from private addresses)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$DIR/docker/firewall.sh --wait

[Install]
WantedBy=multi-user.target docker.service
EOF
  systemctl daemon-reload
  systemctl enable --quiet yumakbot-firewall.service
  # The bridge exists only once the containers are up, so start_containers runs first.
  systemctl restart yumakbot-firewall.service
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
  fi
  cat >/usr/local/bin/yumakbot <<EOF
#!/bin/sh
# Manages the Yumak Bot installation in $DIR; see $DIR/docker/install.sh --help.
exec bash "$DIR/docker/install.sh" --dir "$DIR" "\$@"
EOF
  chmod 755 /usr/local/bin/yumakbot
}

summary() {
  printf '\n'
  say "Yumak Bot hazır." "Yumak Bot is ready."
  say "  Adres:          https://$DOMAIN" "  Address:     https://$DOMAIN"
  # Shown only on a terminal: when run from cloud-init the output lands in a log file.
  if [ -t 1 ]; then
    say "  Erişim anahtarı: $(get_env YUMAKBOT_ACCESS_KEY)" "  Access key:  $(get_env YUMAKBOT_ACCESS_KEY)"
  else
    say "  Erişim anahtarı: sudo yumakbot access-key ile görün" "  Access key:  see it with sudo yumakbot access-key"
  fi
  printf '\n'
  say "Adresi açıp erişim anahtarıyla girin; ardından bir kullanıcı adı ve şifre seçersiniz. Masaüstü ya da telefon uygulamasından bağlanmak için bağlantı ayarlarına bu adresi ve anahtarı yazın." \
    "Open the address and sign in with the access key; you then choose a user name and password. To connect the desktop or phone app, enter this address and key in its connection settings."
  say "Komutlar: yumakbot status | logs | update | restart | access-key" \
    "Commands: yumakbot status | logs | update | restart | access-key"
  say "Yedek: uygulamadaki şifreli tam yedek ya da $DIR/docker/.env dosyası ile Docker birimleri." \
    "Backups: the password-sealed full backup in the app, or $DIR/docker/.env together with the Docker volumes."
}

main() {
  local args=("$@")
  parse_args "$@"
  DIR=$(realpath -m "$DIR")
  require_root
  # An installed server keeps the language it was installed in, unless --lang says otherwise.
  if [ -z "$LANG_GIVEN" ]; then
    local saved
    saved=$(get_env YUMAKBOT_INSTALL_LANG)
    [ -z "$saved" ] || UI=$saved
  fi
  case $COMMAND in
    status | logs | restart | access-key | compose)
      manage
      return
      ;;
  esac
  if [ -z "$STAGE2" ]; then
    check_os
    ensure_packages
    fetch_source
    exec bash "$DIR/docker/install.sh" --stage2 --ref "$REF" --dir "$DIR" "${args[@]}"
  fi
  [ -n "$REF" ] || die "--stage2 --ref ister" "--stage2 needs --ref"
  # A release's images carry its version without the v; a branch has none and is built here.
  IMAGE_TAG=${REF#v}
  IMAGE_TAG=${IMAGE_TAG//\//-}
  check_resources
  ensure_docker
  choose_domain
  write_env
  setup_apparmor
  check_ports
  start_containers
  wait_healthy
  setup_host
  wait_https
  summary
}

main "$@"
