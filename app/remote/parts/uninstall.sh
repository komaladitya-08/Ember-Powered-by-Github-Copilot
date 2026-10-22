#!/bin/sh
# Removes Ember's helper from this computer (design §5.2.7): its Node runtime, every version of its parts, unfinished
# installs, and each machine's consent record, lock, logs and run stamps. The audit log (state/<machine>/audit/) stays:
# it is this computer's record of what Ember did here; README.txt says how to delete it too. Run it while Ember isn't
# connected (Ember on the other computer can also do this: "Remove Ember from <this computer>").
# usage: sh ~/.local/share/ember-remote/versions/<id>/uninstall.sh   (macOS: ~/Library/Application Support/Ember Remote/…)
set -eu
case "$(uname -s)" in
  Darwin)
    data="$HOME/Library/Application Support/Ember Remote"
    state="$data/state"
    ;;
  *)
    data="$HOME/.local/share/ember-remote"
    state="$HOME/.local/state/ember-remote"
    ;;
esac
rm -rf "$data/runtime" "$data/versions" "$data/install.lock"
for d in "$data"/staging-*; do
  [ -e "$d" ] && rm -rf "$d"
done
for m in "$state"/*; do
  [ -d "$m" ] || continue
  rm -f "$m/consent.json" "$m/lock"
  rm -rf "$m/logs" "$m/runs"
done
echo "Ember's helper is removed from this computer. Its audit log stays in $state/<machine>/audit/."
