#!/bin/sh
# Prepares a Linux host for the bubblewrap sandboxes in the yumakbot and computer containers and prints the
# YUMAKBOT_APPARMOR value this host needs. Run once on the host as root; running it again is safe.
#
#   sudo ./docker/apparmor.sh                    # check the host, load the profile if needed, print the value
#   sudo ./docker/apparmor.sh --env docker/.env  # also write the value into that file
#   sudo ./docker/apparmor.sh --remove           # unload and delete the profile
#
# Which value, and why (see "AppArmor" in docker/README.md):
#   - AppArmor off: none. Docker applies no AppArmor profile, so nothing blocks bubblewrap.
#   - AppArmor on, user namespaces not restricted (e.g. Debian 12): unconfined. Docker's default profile
#     refuses the mounts bubblewrap makes.
#   - AppArmor on and restricting user namespaces (Ubuntu 23.10+): yumakbot-userns. The restriction also
#     covers unconfined processes, so only a profile that allows user namespaces works.
set -eu

PROFILE=yumakbot-userns
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$HERE/apparmor/$PROFILE
TARGET=/etc/apparmor.d/$PROFILE
LOADED=/sys/kernel/security/apparmor/profiles

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Kullanım: sudo %s [--env DOSYA] [--remove]\n' "$0"
}

ENV_FILE=
REMOVE=
while [ $# -gt 0 ]; do
  case $1 in
    --env)
      [ $# -ge 2 ] || die "--env bir dosya yolu ister"
      ENV_FILE=$2
      shift 2
      ;;
    --remove)
      REMOVE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

[ "$(uname -s)" = Linux ] || die "Bu betik Linux ana makinede çalışır."
[ "$(id -u)" = 0 ] || die "Root olarak çalıştırın: sudo $0"

profile_loaded() {
  [ -r "$LOADED" ] && grep -q "^$PROFILE " "$LOADED"
}

# Replaces the YUMAKBOT_APPARMOR line in the env file, or removes it when the host needs no value.
write_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE bulunamadı"
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  grep -v '^[[:space:]]*YUMAKBOT_APPARMOR=' "$ENV_FILE" >"$tmp" || true
  if [ -n "$1" ]; then
    # Keep the file ending in a newline before appending.
    [ ! -s "$tmp" ] || [ -z "$(tail -c 1 "$tmp")" ] || printf '\n' >>"$tmp"
    printf 'YUMAKBOT_APPARMOR=%s\n' "$1" >>"$tmp"
  fi
  # Keep the original file's owner and mode; it holds secrets.
  chmod --reference="$ENV_FILE" "$tmp"
  chown --reference="$ENV_FILE" "$tmp"
  mv "$tmp" "$ENV_FILE"
}

if [ -n "$REMOVE" ]; then
  if profile_loaded; then
    if [ -f "$TARGET" ]; then apparmor_parser -R "$TARGET"; else printf '%s' "$PROFILE" >/sys/kernel/security/apparmor/.remove; fi
  fi
  rm -f "$TARGET"
  printf '%s profili kaldırıldı.\n' "$PROFILE"
  if [ -n "$ENV_FILE" ]; then
    write_env ''
    printf 'YUMAKBOT_APPARMOR satırı %s dosyasından silindi.\n' "$ENV_FILE"
  else
    printf 'YUMAKBOT_APPARMOR=%s kalırsa kapsayıcılar başlamaz; o satırı silin.\n' "$PROFILE"
  fi
  exit 0
fi

# bubblewrap runs as the containers' unprivileged user, so the kernel has to let such users open user namespaces.
max_userns=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)
userns_clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)
if [ "$max_userns" = 0 ] || [ "$userns_clone" = 0 ]; then
  die "Bu sunucuda kullanıcı ad alanları kapalı; bubblewrap çalışamaz. Açmak için:
  printf 'user.max_user_namespaces=63000\nkernel.unprivileged_userns_clone=1\n' | sudo tee /etc/sysctl.d/90-yumakbot.conf
  sudo sysctl --system
Sonra bu betiği yeniden çalıştırın."
fi

apparmor=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo N)
restricted=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)

if [ "$apparmor" != Y ]; then
  value=
  printf 'AppArmor kapalı; YUMAKBOT_APPARMOR gerekmez.\n'
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
    printf 'Uyarı: SELinux açık. Kapsayıcı politikası bubblewrap'"'"'i engelleyebilir; SELinux'"'"'lu sunucuda denenmedi.\n'
  fi
elif [ "$restricted" != 1 ]; then
  value=unconfined
  printf 'AppArmor açık, kullanıcı ad alanları kısıtlı değil; profil gerekmez.\n'
else
  command -v apparmor_parser >/dev/null 2>&1 ||
    die "AppArmor kullanıcı ad alanlarını kısıtlıyor ama apparmor_parser yok. Kurun: sudo apt-get install -y apparmor"
  [ -f "$SOURCE" ] || die "$SOURCE bulunamadı; betiği YumakBot deposunun içinden çalıştırın."
  # Dry run first, so a host whose AppArmor is too old for the profile gets a clear message and keeps its state.
  apparmor_parser -QK "$SOURCE" >/dev/null ||
    die "AppArmor $PROFILE profilini kabul etmedi (iletisi yukarıda). Profil AppArmor 4 ister (Ubuntu 24.04 ve sonrası)."
  install -m 0644 "$SOURCE" "$TARGET"
  apparmor_parser -r "$TARGET"
  profile_loaded || die "$PROFILE profili yüklenemedi; sunucuyu yeniden başlatıp betiği yeniden çalıştırın."
  value=$PROFILE
  printf 'AppArmor kullanıcı ad alanlarını kısıtlıyor; %s profili kuruldu ve yüklendi.\n' "$PROFILE"
fi

if [ -n "$ENV_FILE" ]; then
  write_env "$value"
  printf '%s güncellendi. Kapsayıcıları yeniden oluşturun:\n' "$ENV_FILE"
  printf '  docker compose -f docker/compose.yml --env-file docker/.env up -d\n'
elif [ -n "$value" ]; then
  printf '\nOrtam değişkenlerine şu satırı ekleyip kapsayıcıları yeniden oluşturun:\n\n'
  printf '  YUMAKBOT_APPARMOR=%s\n\n' "$value"
  printf 'docker/.env dosyasına ya da Dokploy gibi bir panelde uygulamanın Environment ayarına.\n'
fi
