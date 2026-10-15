#!/bin/bash
# Adds Ember to the GNOME application menu for this development checkout, and
# optionally starts it at login.  usage: scripts/install-desktop-entry.sh [--autostart] [--remove]
# (Packaged installs get their entries from the RPM, task M9.)
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
apps="$HOME/.local/share/applications"
autostart="$HOME/.config/autostart"
icon="$repo/assets/ember.svg"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$apps/ember-dev.desktop" "$autostart/ember-dev.desktop"
  echo "Removed Ember (dev) launchers."
  exit 0
fi

mkdir -p "$apps"
cat > "$apps/ember-dev.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Ember (dev)
Comment=Your cursor companion, powered by GitHub Copilot
Exec=$repo/node_modules/.bin/electron $repo --show-settings
Icon=$icon
Terminal=false
Categories=Utility;Accessibility;
StartupNotify=false
DESKTOP
echo "Added Ember (dev) to the application menu."

if [ "${1:-}" = "--autostart" ]; then
  mkdir -p "$autostart"
  sed -e 's/ --show-settings//' -e '$a X-GNOME-Autostart-enabled=true' "$apps/ember-dev.desktop" > "$autostart/ember-dev.desktop"
  echo "Ember (dev) will start when you log in."
fi
