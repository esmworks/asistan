#!/bin/sh
# Blocks traffic from the YumakBot container network to private and link-local addresses
# (home/office network, cloud metadata), IPv4 and IPv6. Run on the Linux host as root
# after `docker compose up` created the yumakbot0 bridge; rerun after reboots.
set -eu
BRIDGE=${BRIDGE:-yumakbot0}

ip link show "$BRIDGE" >/dev/null 2>&1 || { echo "Köprü $BRIDGE yok; önce docker compose up" >&2; exit 1; }

for cmd in iptables ip6tables; do
  $cmd -N YUMAKBOT-EGRESS 2>/dev/null || $cmd -F YUMAKBOT-EGRESS
  $cmd -C DOCKER-USER -i "$BRIDGE" -j YUMAKBOT-EGRESS 2>/dev/null || $cmd -I DOCKER-USER -i "$BRIDGE" -j YUMAKBOT-EGRESS
  $cmd -A YUMAKBOT-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done

for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 100.64.0.0/10 169.254.0.0/16 0.0.0.0/8 224.0.0.0/4; do
  iptables -A YUMAKBOT-EGRESS -d "$net" -j REJECT
done
for net in fc00::/7 fe80::/10 ::1/128 ff00::/8; do
  ip6tables -A YUMAKBOT-EGRESS -d "$net" -j REJECT
done
echo "YumakBot çıkış kuralları kuruldu ($BRIDGE)."
