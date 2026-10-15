#!/bin/sh
# Runs a command as the demo user with the demo desktop's session bus, keeping
# open file descriptors (Playwright talks to Electron over inherited pipes).
# usage: EMBER_DEMO_USER=demo scripts/demo/as-demo-user.sh <command> [args...]
user=${EMBER_DEMO_USER:-demo}
state=/tmp/ember-demo-${DISPLAY#:}
[ -f "$state/dbus.env" ] && . "$state/dbus.env"
home=$(getent passwd "$user" | cut -d: -f6)
exec setpriv --reuid="$user" --regid="$user" --init-groups \
  env HOME="$home" USER="$user" DISPLAY="$DISPLAY" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  XDG_RUNTIME_DIR="$state/runtime" "$@"
