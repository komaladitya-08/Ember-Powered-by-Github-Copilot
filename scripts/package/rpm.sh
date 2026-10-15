#!/bin/bash
# Builds dist/package/ember-<version>-1<dist>.x86_64.rpm (and ember-voice-models-<version>-1<dist>.noarch.rpm
# when the speech models were staged) with rpmbuild, from the folder stage.mjs made. <dist> is the build
# machine's %{?dist}: ".el8" on RHEL 8 and its rebuilds (ember-0.1.0-1.el8.x86_64.rpm), as in CI.
# Needs rpmbuild (dnf install rpm-build). usage: scripts/package/rpm.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
version=$(node -p "require('$root/package.json').version")
stage="$root/dist/package"
[ -x "$stage/ember/ember" ] || { echo "stage first: node scripts/package/stage.mjs" >&2; exit 1; }

top=$(mktemp -d)
trap 'rm -rf "$top"' EXIT
mkdir -p "$top"/{SOURCES,SPECS,BUILD,RPMS,SRPMS} "$top/src"
src="$top/src"
ln -s "$stage/ember" "$src/ember"
[ -d "$stage/voice-models" ] && ln -s "$stage/voice-models" "$src/voice-models"
cp "$root/packaging/ember" "$src/launcher"
cp "$root/packaging/ember.desktop" "$root/packaging/policy.example.json" "$root/assets/ember.svg" "$src/"
node "$root/scripts/package/icon.mjs" "$root/assets/ember.svg" "$src/ember.png" 256
tar -C "$src" -chf "$top/SOURCES/ember-$version-staged.tar" .
cp "$root/packaging/rpm/ember.spec" "$top/SPECS/"

models=0
[ -d "$stage/voice-models" ] && models=1
rpmbuild -bb "$top/SPECS/ember.spec" \
  --define "_topdir $top" --define "ember_version $version" --define "with_models $models" \
  --define "_binary_payload w2T.xzdio" --quiet
find "$top/RPMS" -name '*.rpm' -exec cp {} "$stage/" \;
ls -la "$stage"/*.rpm
