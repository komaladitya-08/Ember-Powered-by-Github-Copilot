#!/bin/bash
# Rebuilds Ember's native Node addons against RHEL 8 (glibc 2.28, GCC 8), then runs
# the glibc/libstdc++ symbol check over node_modules.
#
# The modules to rebuild are listed in package.json under "ember.nativeModules".
# On an EL8 machine (or with --here) it works in place. Anywhere else it re-runs
# itself inside an EL8 container (docker or podman); set EMBER_EL8_IMAGE to change
# the image (default rockylinux:8).
set -euo pipefail
cd "$(dirname "$0")/.."

is_el8() {
  [ -r /etc/os-release ] || return 1
  . /etc/os-release
  [[ "${VERSION_ID:-}" == 8* ]] && [[ " ${ID:-} ${ID_LIKE:-} " =~ (rhel|centos|fedora) ]]
}

if [ "${1:-}" != "--here" ] && ! is_el8; then
  runtime=$(command -v podman || command -v docker || true)
  if [ -z "$runtime" ]; then
    echo "This is not an EL8 machine and neither podman nor docker is installed." >&2
    exit 2
  fi
  image=${EMBER_EL8_IMAGE:-rockylinux:8}
  echo "Re-running inside $image with $runtime"
  exec "$runtime" run --rm -v "$PWD":/src:Z -w /src "$image" bash -c '
    set -e
    dnf -y -q install gcc-c++ make python3 file binutils findutils libX11-devel libXtst-devel libXt-devel >/dev/null
    command -v node >/dev/null || dnf -y -q module install nodejs:22/common >/dev/null
    scripts/rebuild-el8.sh --here'
fi

modules=$(node -p 'const m = require("./package.json").ember?.nativeModules ?? []; m.join(",")')
if [ -n "$modules" ]; then
  echo "Rebuilding for Electron on $(ldd --version | head -1): $modules"
  npx electron-rebuild --force --only "$modules"
else
  echo "No native modules listed in package.json \"ember.nativeModules\"; nothing to rebuild."
fi

echo "Checking every binary under node_modules against RHEL 8.4 (GLIBC_2.28 / GLIBCXX_3.4.25):"
if scripts/check-symvers.sh node_modules > /tmp/ember-symvers.txt; then
  echo "All $(wc -l < /tmp/ember-symvers.txt) binaries are compatible."
else
  grep '^FAIL' /tmp/ember-symvers.txt >&2
  exit 1
fi
