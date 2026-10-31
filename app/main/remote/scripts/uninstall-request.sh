# "Remove Ember from <host>" (design §5.2.7): the fixed removal the bootstrap runs when Ember's decision is UNINSTALL.
# Ember sends this text before bootstrap.sh's, as one script. Every path is computed here on the remote, never sent.
# It removes the runtimes, Ember's helper versions, unfinished installs, this computer's consent record and logs, and
# keeps this computer's audit folder (the remote's own record; README.txt said how to delete it by hand).

ember_uninstall() {
  rm -rf "$ember_data/runtime" "$ember_data/versions" "$ember_data/install.lock"
  for ember_d in "$ember_data"/staging-*; do
    if [ -d "$ember_d" ]; then rm -rf "$ember_d"; fi
  done
  ember_mdir="$(printf %s "$ember_machine" | cut -c1-12)$(printf %s "$ember_host" | cut -c1-4)"
  case $ember_mdir in
    ''|*[!0-9a-f]*) ;;
    *)
      rm -f "$ember_state/$ember_mdir/consent.json"
      rm -rf "$ember_state/$ember_mdir/logs"
      ;;
  esac
  rmdir "$ember_data" 2>/dev/null
  printf 'EMBER-DONE uninstall\n'
}
