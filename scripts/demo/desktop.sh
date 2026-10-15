#!/bin/bash
# Starts a throw-away X11 desktop for demos and recordings:
#   Xvfb + openbox (window manager) + xcompmgr (compositor) + wallpaper + a text editor.
# usage: scripts/demo/desktop.sh start|stop  [display, default :55]
# Needs: Xvfb openbox xcompmgr feh mousepad imagemagick (dev machines / CI only).
set -euo pipefail
cmd=${1:-start}
export DISPLAY=${2:-:55}
state=/tmp/ember-demo-${DISPLAY#:}
case "$cmd" in
  start)
    mkdir -p "$state"
    Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >"$state/xvfb.log" 2>&1 & echo $! > "$state/xvfb.pid"
    for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
    # A session bus (and so an accessibility bus) like a real GNOME session, owned by the demo user.
    user=${EMBER_DEMO_USER:-}
    mkdir -p "$state/runtime"; chmod 700 "$state/runtime"
    if [ -n "$user" ]; then
      chown "$user" "$state/runtime"
      su "$user" -c "DISPLAY=$DISPLAY dbus-launch --sh-syntax" > "$state/dbus.env"
    else
      DISPLAY=$DISPLAY dbus-launch --sh-syntax > "$state/dbus.env"
    fi
    chmod 644 "$state/dbus.env"
    convert -size 1280x800 radial-gradient:'#2b5683'-'#06101d' \
      \( -size 1280x800 xc:none -fill 'rgba(238,0,0,0.20)' -draw 'polygon 700,800 900,0 1080,0 880,800' \) \
      -composite "$state/wallpaper.png"
    openbox >"$state/openbox.log" 2>&1 & echo $! > "$state/openbox.pid"
    xcompmgr -n >"$state/xcompmgr.log" 2>&1 & echo $! > "$state/xcompmgr.pid"
    sleep 0.5
    feh --bg-fill "$state/wallpaper.png"
    printf 'Standup notes, Wednesday\n\n- Ember overlay follows the cursor\n- Next: Copilot conductor (M2)\n- Try all four characters\n' > "$state/notes.txt"
    chmod 755 "$state"; chmod 644 "$state/notes.txt"
    if [ -n "${EMBER_DEMO_USER:-}" ]; then
      "$(dirname "$0")/as-demo-user.sh" mousepad "$state/notes.txt" >"$state/mousepad.log" 2>&1 &
    else
      mousepad "$state/notes.txt" >"$state/mousepad.log" 2>&1 &
    fi
    echo $! > "$state/mousepad.pid"
    sleep 1.5
    xdotool search --sync --name "notes.txt" windowsize 760 460 windowmove 120 110 >/dev/null 2>&1 || true
    echo "desktop ready on $DISPLAY"
    ;;
  stop)
    pkill -f "mousepad $state/notes.txt" 2>/dev/null || true
    [ -f "$state/dbus.env" ] && . "$state/dbus.env" && kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true
    for p in mousepad xcompmgr openbox xvfb; do
      [ -f "$state/$p.pid" ] && kill "$(cat "$state/$p.pid")" 2>/dev/null || true
    done
    rm -rf "$state"
    ;;
  *) echo "usage: $0 start|stop [display]" >&2; exit 2 ;;
esac
