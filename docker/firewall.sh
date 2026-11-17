#!/bin/sh
# Blocks traffic from the Yumak Bot container network to private and link-local addresses
# (home/office network, cloud metadata), IPv4 and IPv6, and to the host itself. Run on the Linux host
# as root after `docker compose up` created the yumakbot0 bridge; rerun after reboots. Running it again
# replaces the rules instead of adding them twice.
#   --wait  waits up to three minutes for the bridge first; the yumakbot-firewall service that
#           docker/install.sh sets up uses it at boot, when Docker brings the containers up after itself.
#
# Two chains, because the kernel sends a container's packet down one of two paths:
#   YUMAKBOT-EGRESS (from DOCKER-USER, in FORWARD): packets routed on to another machine.
#   YUMAKBOT-INPUT (from INPUT): packets for one of the host's own addresses (the bridge's gateway, the
#     host's LAN or public address). Without it a bot could reach services the host runs on 0.0.0.0, such
#     as a local model server, a database or an admin panel. The containers need nothing from the host:
#     names are resolved by Docker's resolver inside each container (127.0.0.11), which asks the
#     upstream servers itself, so only answers to connections the host opened are let through.
set -eu
BRIDGE=${BRIDGE:-yumakbot0}

if [ "${1:-}" = --wait ]; then
  i=0
  while ! ip link show "$BRIDGE" >/dev/null 2>&1 && [ "$i" -lt 90 ]; do
    i=$((i + 1))
    sleep 2
  done
fi
ip link show "$BRIDGE" >/dev/null 2>&1 || { echo "Köprü $BRIDGE yok; önce docker compose up" >&2; exit 1; }

# Creates the chain, or empties it when it is there from an earlier run, and hooks it into the parent
# chain once.
chain() {
  $1 -N "$2" 2>/dev/null || $1 -F "$2"
  $1 -C "$3" -i "$BRIDGE" -j "$2" 2>/dev/null || $1 -I "$3" -i "$BRIDGE" -j "$2"
  # Answers to connections opened from the other side (the host or the internet) pass.
  $1 -A "$2" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
}

for cmd in iptables ip6tables; do
  chain "$cmd" YUMAKBOT-EGRESS DOCKER-USER
  chain "$cmd" YUMAKBOT-INPUT INPUT
done

# Private, shared (carrier-grade NAT, Tailscale), loopback, link-local (cloud metadata), "this network",
# multicast, the IETF protocol block (192.0.0.0/24), benchmarking (198.18.0.0/15) and the reserved block
# with the broadcast address (240.0.0.0/4).
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 100.64.0.0/10 169.254.0.0/16 0.0.0.0/8 \
  224.0.0.0/4 192.0.0.0/24 198.18.0.0/15 240.0.0.0/4; do
  iptables -A YUMAKBOT-EGRESS -d "$net" -j REJECT
done
# Unique local, link-local, loopback, multicast and IPv4-mapped addresses, the local-use NAT64 prefix,
# and the well-known NAT64 prefix (64:ff9b::/96) where it carries one of the private IPv4 ranges above:
# on an IPv6-only host the NAT64 gateway would otherwise carry a packet on to the local IPv4 network.
for net in fc00::/7 fe80::/10 ::1/128 ::/128 ff00::/8 ::ffff:0:0/96 64:ff9b:1::/48 \
  64:ff9b::a00:0/104 64:ff9b::ac10:0/108 64:ff9b::c0a8:0/112 64:ff9b::7f00:0/104 64:ff9b::6440:0/106 \
  64:ff9b::a9fe:0/112 64:ff9b::/104 64:ff9b::e000:0/100 64:ff9b::c000:0/120 64:ff9b::c612:0/111 \
  64:ff9b::f000:0/100; do
  ip6tables -A YUMAKBOT-EGRESS -d "$net" -j REJECT
done

# IPv6 needs neighbour discovery with the gateway to reach anything at all, and multicast listener
# reports (131, 143) keep the bridge delivering it; none of these leave the link.
for type in neighbour-solicitation neighbour-advertisement router-solicitation 131 143; do
  ip6tables -A YUMAKBOT-INPUT -p ipv6-icmp --icmpv6-type "$type" -j RETURN
done
iptables -A YUMAKBOT-INPUT -j REJECT
ip6tables -A YUMAKBOT-INPUT -j REJECT

echo "Yumak Bot çıkış kuralları kuruldu ($BRIDGE)."
