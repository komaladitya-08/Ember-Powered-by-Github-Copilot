#!/bin/bash
# Builds dist/package/Ember-<version>-x86_64.AppImage from the folder stage.mjs made, with
# pinned (SHA-256 checked) appimagetool and runtime. The speech models go inside it when they were staged (in
# ember/resources/voice-models, where Ember looks before downloading anything). usage: scripts/package/appimage.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
version=$(node -p "require('$root/package.json').version")
stage="$root/dist/package"
cache="$root/.cache/appimage"
[ -x "$stage/ember/ember" ] || { echo "stage first: node scripts/package/stage.mjs" >&2; exit 1; }

TOOL_URL=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
TOOL_SHA=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_URL=https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64
RUNTIME_SHA=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
fetch() { # url sha dest
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL --retry 3 -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; rm -f "$3.part"; exit 1; }
    mv "$3.part" "$3"
  fi
}
mkdir -p "$cache"
fetch "$TOOL_URL" "$TOOL_SHA" "$cache/appimagetool"
fetch "$RUNTIME_URL" "$RUNTIME_SHA" "$cache/runtime-x86_64"
chmod +x "$cache/appimagetool"

app=$(mktemp -d)
trap 'rm -rf "$app"' EXIT
cp -a "$stage/ember" "$app/ember"
[ -d "$stage/voice-models" ] && cp -a "$stage/voice-models" "$app/ember/resources/voice-models"
# As the RPM installs it, its Ask Ember action included (an edit of every Exec line would undo that): AppRun runs ember/ember.
cp "$root/packaging/ember.desktop" "$app/ember.desktop"
node "$root/scripts/package/icon.mjs" "$root/assets/ember.svg" "$app/ember.png" 256
ln -s ember.png "$app/.DirIcon"
cat > "$app/AppRun" <<'RUN'
#!/bin/sh
# Ember as an AppImage. "Ember.AppImage doctor" checks this computer.
here=$(dirname "$(readlink -f "$0")")
platform=--ozone-platform=x11
sandbox=
# An AppImage can't carry a setuid sandbox helper. Where user namespaces are off
# (STIG-hardened hosts; Debian's unprivileged_userns_clone switch) Chromium can't
# sandbox, so Ember runs without it; it only ever shows its own local pages. The
# RPM installs the helper instead. The same two files as the doctor's probe.
if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0)" = "0" ]; then sandbox=--no-sandbox; fi
if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then sandbox=--no-sandbox; fi
if [ "$1" = "doctor" ]; then
  shift
  [ -z "$DISPLAY" ] && platform=--ozone-platform=headless
  # Chromium won't start as root with its sandbox; the check-up shows no web content (and draws
  # nothing, so no GPU: without a display Chromium's GL set-up only prints errors).
  [ "$(id -u)" = 0 ] && sandbox=--no-sandbox
  exec "$here/ember/ember" --doctor $platform --disable-gpu $sandbox "$@"
fi
# Without a display (an ssh session without -X, a text console) Chromium prints only its own error.
if [ -z "$DISPLAY" ]; then
  echo "Ember needs your desktop session (no display here). Run it from a terminal inside GNOME, or run '$(basename "${APPIMAGE:-Ember.AppImage}") doctor'." >&2
  exit 1
fi
exec "$here/ember/ember" $platform $sandbox "$@"
RUN
chmod +x "$app/AppRun"

out="$stage/Ember-$version-x86_64.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$cache/appimagetool" --no-appstream --runtime-file "$cache/runtime-x86_64" "$app" "$out" >/dev/null
ls -la "$out"
