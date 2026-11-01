#!/bin/bash
# Adds Ember to the GNOME application menu for this development checkout, and
# optionally starts it at login.  usage: scripts/install-desktop-entry.sh [--autostart] [--remove]
# (Packaged installs get their entries from the RPM, task M9.)
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
apps="$HOME/.local/share/applications"
autostart="$HOME/.config/autostart"
icon="$repo/assets/ember.svg"

# Quotes one Exec argument per the Desktop Entry spec: wrap in double quotes,
# backslash-escape " ` $ and \ inside, then double every backslash (the
# value is also a string, so its own escapes apply on top).
exec_arg() {
  local a=${1//\\/\\\\}
  a=${a//\"/\\\"}; a=${a//\`/\\\`}; a=${a//\$/\\\$}
  a=${a//\\/\\\\}
  printf '"%s"' "$a"
}

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
Exec=$(exec_arg "$repo/node_modules/.bin/electron") $(exec_arg "$repo") --show-settings
Icon=$icon
Terminal=false
Categories=Utility;Accessibility;
StartupNotify=false
Actions=Ask;

[Desktop Action Ask]
Name=Ask Ember
Exec=$(exec_arg "$repo/node_modules/.bin/electron") $(exec_arg "$repo") --ask
DESKTOP
echo "Added Ember (dev) to the application menu."

if [ "${1:-}" = "--autostart" ]; then
  mkdir -p "$autostart"
  # The entry alone (not its Ask Ember action), with the autostart switch in its group.
  { sed -e '/^Actions=/d' -e '/^$/,$d' -e 's/ --show-settings/ --autostart/' "$apps/ember-dev.desktop"
    echo "X-GNOME-Autostart-enabled=true"; } > "$autostart/ember-dev.desktop"
  echo "Ember (dev) will start when you log in."
fi
