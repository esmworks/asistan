#!/bin/sh
# First process inside a bot's sandbox: the X server, then the desktop parts and the helper.
# Everything it needs (display, home, locale, paths) comes from the environment the controller set.
# xfce4-session is not used on purpose: it opens an abstract socket named after its PID, and every
# sandbox has the same PIDs, so two bots would collide. Xvnc gets `-nolisten local` for a similar
# reason: an abstract X socket would be visible from every desktop (they share one network
# namespace); X clients here use the socket file in this sandbox's own /tmp instead.
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

Xvnc "$YUMAKBOT_DISPLAY" -geometry "$YUMAKBOT_GEOMETRY" -depth 24 \
  -rfbunixpath /run/ctl/vnc.sock -rfbport -1 -SecurityTypes None -nolisten tcp -nolisten local \
  -auth "$XAUTHORITY" >>/run/ctl/xvnc.log 2>&1 &

i=0
while [ ! -S /run/ctl/vnc.sock ]; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && { echo "Xvnc did not start" >&2; exit 1; }
  sleep 0.1
done

exec dbus-run-session --config-file=/etc/yumakbot/dbus-session.conf -- sh -c '
  exec >>/run/ctl/desktop.log 2>&1
  xset s off -dpms s noblank
  xfsettingsd &
  xfwm4 --compositor=off &
  xfce4-panel &
  xfdesktop &
  exec "$YUMAKBOT_NODE" "$YUMAKBOT_HELPER"
'
