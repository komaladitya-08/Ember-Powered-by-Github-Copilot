# Ember's bootstrap on a computer reached over SSH (design §5.1.9). ssh runs `sh -s` and Ember writes this fixed text
# to its stdin; it is never built from user or remote input. Everything is inside functions and the last line calls
# ember_main, so sh has parsed all of it before ember_main reads Ember's decision line: dash reads a script from a pipe
# in blocks, so Ember writes nothing after this text until it has read EMBER-PROBE-END, and no archive before the
# EMBER-READY line that asks for it (macOS's head reads ahead through stdio). The probe prints key=value lines from
# fixed commands only (never an environment dump); nothing is written to disk before the decision. Every path is
# relative to $HOME. Nothing is left behind to run later: no autostart, cron job, service or scheduled task.

ember_t() {
  if command -v timeout >/dev/null 2>&1; then timeout 5 "$@"; else "$@"; fi
}

ember_hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  fi
}

ember_sha() {
  ember_hash < "$1"
}

ember_kv() {
  ember_k=$1
  shift
  ember_v=$("$@" 2>/dev/null)
  printf '%s=%s\n' "$ember_k" "$(printf '%s' "$ember_v" | tr '\r\n\t' '   ' | cut -c1-1000)"
}

ember_libc() {
  getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 | head -n 1
}

ember_distro() {
  (. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")
}

ember_free() {
  df -Pk "$HOME" | awk 'NR == 2 { print $4 }'
}

ember_noexec() {
  command -v findmnt >/dev/null 2>&1 || return 0
  case ,$(findmnt -no OPTIONS -T "$HOME" 2>/dev/null), in
    *,noexec,*) printf 1 ;;
    *) printf 0 ;;
  esac
}

ember_machine() {
  if [ -r /etc/machine-id ]; then ember_hash < /etc/machine-id
  elif [ -r /var/lib/dbus/machine-id ]; then ember_hash < /var/lib/dbus/machine-id
  elif command -v ioreg >/dev/null 2>&1; then ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4 }' | ember_hash
  fi
}

ember_boot() {
  if [ -r /proc/sys/kernel/random/boot_id ]; then ember_hash < /proc/sys/kernel/random/boot_id; fi
}

ember_wsl() {
  if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ] || grep -qi microsoft /proc/version 2>/dev/null; then
    printf 1
  else
    printf 0
  fi
}

ember_tools() {
  for ember_tool in tar gzip xz head sha256sum shasum script python3 loginctl busctl findmnt; do
    if command -v "$ember_tool" >/dev/null 2>&1; then printf '%s ' "$ember_tool"; fi
  done
}

ember_list() {
  for ember_d in "$ember_data/$1"/*/; do
    if [ -f "$ember_d.verified" ]; then basename "$ember_d" | tr '\n' ' '; fi
  done
}

ember_tcc() {
  ls "$HOME/Documents" >/dev/null 2>&1
  printf %s "$?"
}

ember_tmp() {
  case $ember_os in
    Darwin) getconf DARWIN_USER_TEMP_DIR ;;
    *)
      if [ -n "$XDG_RUNTIME_DIR" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ -O "$XDG_RUNTIME_DIR" ] && [ "$(stat -c %a "$XDG_RUNTIME_DIR" 2>/dev/null)" = 700 ]; then
        printf %s "$XDG_RUNTIME_DIR"
      fi
      ;;
  esac
}

ember_policy() {
  case $ember_os in
    Darwin) ember_f="/Library/Application Support/Ember/policy.json" ;;
    *) ember_f=/etc/ember/policy.json ;;
  esac
  if [ ! -e "$ember_f" ]; then
    printf 'policy=none\n'
    return 0
  fi
  printf 'policy=present\n'
  case $ember_os in
    Darwin) ember_u=$(stat -f %u "$ember_f" 2>/dev/null); ember_m=$(stat -f %Lp "$ember_f" 2>/dev/null) ;;
    *) ember_u=$(stat -c %u "$ember_f" 2>/dev/null); ember_m=$(stat -c %a "$ember_f" 2>/dev/null) ;;
  esac
  ember_s=$(wc -c < "$ember_f" 2>/dev/null | tr -d ' ')
  printf 'policy_uid=%s\npolicy_mode=%s\npolicy_size=%s\n' "$ember_u" "$ember_m" "$ember_s"
  if [ "$ember_u" = 0 ] && [ -n "$ember_s" ] && [ "$ember_s" -le 65536 ] 2>/dev/null; then
    base64 < "$ember_f" 2>/dev/null | tr -d '\r\n' | fold -w 1000 | awk '{ printf "policy_b64.%d=%s\n", NR - 1, $0 }'
  fi
}

ember_session() {
  command -v loginctl >/dev/null 2>&1 || return 0
  ember_out=$(ember_t loginctl show-user "$(id -u)" -p Display -p Sessions 2>/dev/null) || return 0
  printf '%s\n' "$ember_out" | while IFS= read -r ember_l; do
    case $ember_l in Display=*|Sessions=*) printf 'session.%s\n' "$ember_l" | cut -c1-1000 ;; esac
  done
  ember_sid=$(printf '%s\n' "$ember_out" | sed -n 's/^Display=//p')
  case $ember_sid in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  printf 'session.Id=%s\n' "$ember_sid"
  ember_t loginctl show-session "$ember_sid" -p Type -p Active -p Remote -p Seat -p State -p LockedHint 2>/dev/null | while IFS= read -r ember_l; do
    case $ember_l in Type=*|Active=*|Remote=*|Seat=*|State=*|LockedHint=*) printf 'session.%s\n' "$ember_l" | cut -c1-1000 ;; esac
  done
}

ember_probe() {
  ember_kv os uname -s
  ember_kv arch uname -m
  ember_kv kernel uname -r
  if [ "$ember_os" = Darwin ]; then ember_kv macos sw_vers -productVersion; fi
  ember_kv libc ember_libc
  ember_kv distro ember_distro
  ember_kv home printf %s "$HOME"
  ember_kv free_kb ember_free
  ember_kv noexec ember_noexec
  ember_kv fapolicyd ember_t systemctl is-active fapolicyd
  ember_kv selinux id -Z
  ember_kv uid id -u
  ember_kv user id -un
  printf 'machine=%s\nhost=%s\n' "$ember_machine" "$ember_host"
  ember_kv wsl ember_wsl
  ember_kv boot ember_boot
  ember_kv tools ember_tools
  ember_kv rt ember_list runtime
  ember_kv parts ember_list versions
  if [ "$ember_os" = Linux ]; then ember_kv fs stat -f -c %T "$HOME"; fi
  if [ "$ember_os" = Darwin ]; then ember_kv tcc ember_tcc; fi
  ember_kv tmp ember_tmp
  ember_policy
  if [ "$ember_os" = Linux ]; then ember_session; fi
}

# Validators for the decision line's words: Ember's own values, checked again here.
ember_hex() {
  case $1 in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq "$2" ]
}

ember_id() {
  case $1 in ''|.*|*[!A-Za-z0-9._+-]*) return 1 ;; esac
  [ "${#1}" -le 100 ]
}

ember_num() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 12 ]
}

ember_fail() {
  if [ -n "$ember_stage" ]; then rm -rf "$ember_stage"; fi
  if [ -n "$ember_locked" ]; then rm -rf "$ember_data/install.lock"; fi
  printf 'EMBER-ERROR %s %s\n' "$1" "${2:--}"
  exit 4
}

# Two PCs never unpack into the same folder at once (critique remote-5): a mkdir lock, waited for up to 60 s. A lock
# left by a bootstrap of this host whose process is gone is stale and taken over.
ember_lock() {
  ember_i=0
  while ! mkdir "$ember_data/install.lock" 2>/dev/null; do
    if [ -f "$ember_data/install.lock/owner" ]; then
      read -r ember_opid ember_ohost < "$ember_data/install.lock/owner" 2>/dev/null
      if [ "$ember_ohost" = "$ember_host" ] && [ -n "$ember_opid" ] && ! kill -0 "$ember_opid" 2>/dev/null; then
        rm -rf "$ember_data/install.lock"
        continue
      fi
    fi
    ember_i=$((ember_i + 1))
    if [ "$ember_i" -gt 60 ]; then ember_fail busy-install; fi
    sleep 1
  done
  ember_locked=1
  printf '%s %s\n' "$$" "$ember_host" > "$ember_data/install.lock/owner"
}

ember_sumcheck() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --status manifest.sha256
  else shasum -a 256 -c -s manifest.sha256
  fi
}

# Reads exactly $2 bytes of archive $1 (runtime or parts) into the staging folder, after asking for them, and checks
# their size and SHA-256 ($3) with this computer's own tools.
ember_receive() {
  printf 'EMBER-READY %s\n' "$1"
  head -c "$2" > "$ember_stage/$1.archive" || ember_fail space "$1"
  [ "$(wc -c < "$ember_stage/$1.archive" | tr -d ' ')" = "$2" ] || ember_fail integrity "$1"
  [ "$(ember_sha "$ember_stage/$1.archive")" = "$3" ] || ember_fail integrity "$1"
}

ember_install() {
  ember_hex "$1" 32 && ember_id "$2" && ember_num "$3" && ember_id "$6" && ember_num "$7" || ember_fail bad-decision
  if [ "$3" != 0 ]; then
    ember_hex "$4" 64 || ember_fail bad-decision
    case $5 in xz|gz) ;; *) ember_fail bad-decision ;; esac
  fi
  if [ "$7" != 0 ]; then ember_hex "$8" 64 || ember_fail bad-decision; fi
  mkdir -p "$ember_data/runtime" "$ember_data/versions" || ember_fail space
  ember_lock
  ember_stage=$(mktemp -d "$ember_data/staging-XXXXXX") || ember_fail space
  if [ "$3" != 0 ]; then
    ember_receive runtime "$3" "$4"
    mkdir "$ember_stage/rt" || ember_fail space
    if [ "$5" = xz ]; then
      tar -xJf "$ember_stage/runtime.archive" -C "$ember_stage/rt" --strip-components=1 || ember_fail unpack runtime
    else
      tar -xzf "$ember_stage/runtime.archive" -C "$ember_stage/rt" --strip-components=1 || ember_fail unpack runtime
    fi
    rm -f "$ember_stage/runtime.archive"
  fi
  if [ "$7" != 0 ]; then
    ember_receive parts "$7" "$8"
    mkdir "$ember_stage/parts" || ember_fail space
    tar -xzf "$ember_stage/parts.archive" -C "$ember_stage/parts" || ember_fail unpack parts
    rm -f "$ember_stage/parts.archive"
    [ -f "$ember_stage/parts/manifest.sha256" ] || ember_fail manifest parts
    (cd "$ember_stage/parts" && ember_sumcheck) || ember_fail manifest parts
  fi
  # The exec check (critique remote-10): fapolicyd, a confined SELinux user or a noexec mount the probe missed.
  if [ "$3" != 0 ]; then
    case $("$ember_stage/rt/bin/node" --version 2>/dev/null) in
      v[0-9]*) ;;
      *) ember_fail exec-denied ;;
    esac
    : > "$ember_stage/rt/.verified" || ember_fail space
    rm -rf "$ember_data/runtime/$2"
    mv "$ember_stage/rt" "$ember_data/runtime/$2" || ember_fail space
  fi
  if [ "$7" != 0 ]; then
    ember_sha "$ember_stage/parts/manifest.sha256" > "$ember_stage/parts/.verified" || ember_fail space
    rm -rf "$ember_data/versions/$6"
    mv "$ember_stage/parts" "$ember_data/versions/$6" || ember_fail space
  fi
  rm -rf "$ember_stage"
  ember_stage=
  rm -rf "$ember_data/install.lock"
  ember_locked=
}

# Starts the agent on the same stdin and stdout, which carry the framed protocol from here on (§5.1.10). The parts
# are checked fast (.verified and manifest.sha256's own hash); nothing secret or user-supplied is on its argv.
ember_serve() {
  ember_hex "$1" 32 && ember_id "$2" && ember_id "$3" || ember_fail bad-decision
  ember_rt="$ember_data/runtime/$2"
  ember_parts="$ember_data/versions/$3"
  if [ ! -f "$ember_rt/.verified" ] || [ ! -x "$ember_rt/bin/node" ] || [ ! -f "$ember_parts/.verified" ] || [ ! -f "$ember_parts/ember-remote.cjs" ]; then
    ember_fail missing
  fi
  [ "$(ember_sha "$ember_parts/manifest.sha256")" = "$(cat "$ember_parts/.verified")" ] || ember_fail integrity parts
  exec "$ember_rt/bin/node" --disable-sigusr1 "$ember_parts/ember-remote.cjs" serve --proto 1 --pc "$1"
}

ember_main() {
  umask 077
  unset NODE_OPTIONS NODE_PATH NODE_DEBUG NODE_REPL_EXTERNAL_MODULE BASH_ENV ENV
  unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
  cd "$HOME" || exit 5
  ember_os=$(uname -s 2>/dev/null)
  case $ember_os in
    Darwin) ember_data="Library/Application Support/Ember Remote"; ember_state="$ember_data/state" ;;
    *) ember_data=.local/share/ember-remote; ember_state=.local/state/ember-remote ;;
  esac
  ember_stage=
  ember_locked=
  ember_machine=$(ember_machine 2>/dev/null)
  ember_host=$(uname -n 2>/dev/null | ember_hash)
  printf '\000EMBER-PROBE-BEGIN\n'
  ember_probe
  printf 'EMBER-PROBE-END\n'
  IFS= read -r ember_decision || exit 3
  set -f
  IFS=' '
  # shellcheck disable=SC2086 # split on purpose: the words are validated one by one
  set -- $ember_decision
  unset IFS
  case $1 in
    QUIT) exit 0 ;;
    UNINSTALL) ember_uninstall; exit 0 ;;
    INSTALL)
      [ "$#" -eq 9 ] || ember_fail bad-decision
      ember_install "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"
      ember_serve "$2" "$3" "$7"
      ;;
    SERVE)
      [ "$#" -eq 4 ] || ember_fail bad-decision
      ember_serve "$2" "$3" "$4"
      ;;
    *) ember_fail bad-decision ;;
  esac
  exit 4
}

ember_main "$@"; exit
