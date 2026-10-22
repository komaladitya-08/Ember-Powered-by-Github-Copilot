/**
 * The PC's side of the bootstrap (§5.1.9, §5.2.5): one ssh process from probe to serve. Ember writes the fixed script,
 * then NOTHING until it has read EMBER-PROBE-END (dash reads a script from a pipe in blocks and would swallow anything
 * written early, critique remote-17), then one decision line, then each archive only after the script's EMBER-READY
 * line for it (macOS's head reads ahead through stdio, so two archives written back to back corrupt the second,
 * critique remote-1). After that the same stdout carries the agent's framed protocol, handed over from its preamble
 * on. The probe is remote text: bounded, read as key=value lines only, and never logged.
 *
 * The script is a byte-exact copy of scripts/uninstall-request.sh and scripts/bootstrap.sh (a unit test pins it):
 * the build has no text loader for .sh files, so the text lives here as well, where both esbuild and vitest load it.
 */

/** scripts/uninstall-request.sh, byte for byte. */
export const UNINSTALL_SH = `# "Remove Ember from <host>" (design §5.2.7): the fixed removal the bootstrap runs when Ember's decision is UNINSTALL.
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
  printf 'EMBER-DONE uninstall\\n'
}
`;

/** scripts/bootstrap.sh, byte for byte. */
export const BOOTSTRAP_SH = `# Ember's bootstrap on a computer reached over SSH (design §5.1.9). ssh runs \`sh -s\` and Ember writes this fixed text
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
  printf '%s=%s\\n' "$ember_k" "$(printf '%s' "$ember_v" | tr '\\r\\n\\t' '   ' | cut -c1-1000)"
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
    if [ -f "$ember_d.verified" ]; then basename "$ember_d" | tr '\\n' ' '; fi
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
    printf 'policy=none\\n'
    return 0
  fi
  printf 'policy=present\\n'
  case $ember_os in
    Darwin) ember_u=$(stat -f %u "$ember_f" 2>/dev/null); ember_m=$(stat -f %Lp "$ember_f" 2>/dev/null) ;;
    *) ember_u=$(stat -c %u "$ember_f" 2>/dev/null); ember_m=$(stat -c %a "$ember_f" 2>/dev/null) ;;
  esac
  ember_s=$(wc -c < "$ember_f" 2>/dev/null | tr -d ' ')
  printf 'policy_uid=%s\\npolicy_mode=%s\\npolicy_size=%s\\n' "$ember_u" "$ember_m" "$ember_s"
  if [ "$ember_u" = 0 ] && [ -n "$ember_s" ] && [ "$ember_s" -le 65536 ] 2>/dev/null; then
    base64 < "$ember_f" 2>/dev/null | tr -d '\\r\\n' | fold -w 1000 | awk '{ printf "policy_b64.%d=%s\\n", NR - 1, $0 }'
  fi
}

ember_session() {
  command -v loginctl >/dev/null 2>&1 || return 0
  ember_out=$(ember_t loginctl show-user "$(id -u)" -p Display -p Sessions 2>/dev/null) || return 0
  printf '%s\\n' "$ember_out" | while IFS= read -r ember_l; do
    case $ember_l in Display=*|Sessions=*) printf 'session.%s\\n' "$ember_l" | cut -c1-1000 ;; esac
  done
  ember_sid=$(printf '%s\\n' "$ember_out" | sed -n 's/^Display=//p')
  case $ember_sid in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  printf 'session.Id=%s\\n' "$ember_sid"
  ember_t loginctl show-session "$ember_sid" -p Type -p Active -p Remote -p Seat -p State -p LockedHint 2>/dev/null | while IFS= read -r ember_l; do
    case $ember_l in Type=*|Active=*|Remote=*|Seat=*|State=*|LockedHint=*) printf 'session.%s\\n' "$ember_l" | cut -c1-1000 ;; esac
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
  printf 'machine=%s\\nhost=%s\\n' "$ember_machine" "$ember_host"
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
  [ "\${#1}" -eq "$2" ]
}

ember_id() {
  case $1 in ''|.*|*[!A-Za-z0-9._+-]*) return 1 ;; esac
  [ "\${#1}" -le 100 ]
}

ember_num() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "\${#1}" -le 12 ]
}

ember_fail() {
  if [ -n "$ember_stage" ]; then rm -rf "$ember_stage"; fi
  if [ -n "$ember_locked" ]; then rm -rf "$ember_data/install.lock"; fi
  printf 'EMBER-ERROR %s %s\\n' "$1" "\${2:--}"
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
  printf '%s %s\\n' "$$" "$ember_host" > "$ember_data/install.lock/owner"
}

ember_sumcheck() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --status manifest.sha256
  else shasum -a 256 -c -s manifest.sha256
  fi
}

# Reads exactly $2 bytes of archive $1 (runtime or parts) into the staging folder, after asking for them, and checks
# their size and SHA-256 ($3) with this computer's own tools.
ember_receive() {
  printf 'EMBER-READY %s\\n' "$1"
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
  printf '\\000EMBER-PROBE-BEGIN\\n'
  ember_probe
  printf 'EMBER-PROBE-END\\n'
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
`;

/** What ssh's `sh -s` gets on stdin: the removal function, then the bootstrap (whose last line runs it). */
export const BOOTSTRAP_SCRIPT = `${UNINSTALL_SH}\n${BOOTSTRAP_SH}`;

/** The bounds on what the remote says before the agent's preamble. */
export const BOOTSTRAP_LIMITS = {
  /** Noise before EMBER-PROBE-BEGIN (a .bashrc that prints) and between the decision and the preamble. */
  noiseBytes: 64 * 1024,
  /** The whole probe. */
  probeBytes: 256 * 1024,
  probeLines: 600,
  /** One probe value (longer ones are cut). */
  valueBytes: 1024,
  /** One line. */
  lineBytes: 4096,
  /**
   * The most of ssh's output held unread at once. Output that comes while Ember decides or uploads an archive is read
   * by nobody (the script is waiting for its stdin then, so it says nothing); past this the run fails as noise.
   */
  bufferBytes: 512 * 1024,
} as const;

/** Ember's decision after the probe (planInstall's, turned into what is written). */
export type Decision =
  /** Refused, or a probe-only run: QUIT lets the script exit cleanly. */
  | { kind: "quit" }
  | { kind: "uninstall" }
  | { kind: "serve"; line: string }
  /** The INSTALL line and the archives in the order the script asks for them (runtime, then parts). */
  | { kind: "install"; line: string; archives: { name: "runtime" | "parts"; bytes: number; open: () => AsyncIterable<Uint8Array> }[] };

/** How the bootstrap ended. */
export type BootstrapOutcome =
  /** The agent started: `rest` is stdout from its preamble on (the mux reads it first, then the stream). */
  | { kind: "serving"; probe: Record<string, string>; rest: Buffer }
  /** QUIT or UNINSTALL finished as asked. */
  | { kind: "done"; probe: Record<string, string> | null; uninstalled: boolean }
  /** The script's EMBER-ERROR (code, detail), or a protocol fault of Ember's own naming ("noise", "probe", "ready"). */
  | { kind: "error"; code: string; detail?: string; probe: Record<string, string> | null; probeBegan: boolean }
  /** stdout ended first (ssh exited or was killed): the caller classifies ssh's stderr and exit code. */
  | { kind: "eof"; probe: Record<string, string> | null; probeBegan: boolean };

const PROBE_BEGIN = Buffer.from("\0EMBER-PROBE-BEGIN\n");
const PREAMBLE = Buffer.from("\0EMBER-REMOTE/");

/**
 * Reads a stream as bytes and lines, waiting only for what it needs; detaches cleanly for the mux. Chunks that arrive
 * are only listed (joined when read, so a flood of small chunks costs no copying while nobody reads), and at most
 * `cap` bytes are held: past it the reader stops reading, drops what it held and ends as `overflowed`.
 */
export class StreamReader {
  /** The bytes joined so far, and the chunks that came after them. */
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private ended = false;
  private over = false;
  private wake: (() => void) | null = null;
  private readonly endWaiters: (() => void)[] = [];
  private readonly onData = (c: Buffer | string) => {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    this.tail.push(b);
    this.tailBytes += b.length;
    if (this.head.length + this.tailBytes > this.cap) this.overflow();
    else this.notify();
  };
  private readonly onEnd = () => {
    this.ended = true;
    this.notify();
    for (const w of this.endWaiters.splice(0)) w();
  };

  constructor(private readonly s: NodeJS.ReadableStream, private readonly cap: number = BOOTSTRAP_LIMITS.bufferBytes) {
    s.on("data", this.onData);
    s.on("end", this.onEnd);
    s.on("close", this.onEnd);
    s.on("error", this.onEnd);
  }

  /** Did more than `cap` bytes wait unread (the reader then stopped and ended)? */
  get overflowed(): boolean {
    return this.over;
  }

  /** Everything held, joined. */
  private get buf(): Buffer {
    if (this.tail.length) {
      this.head = this.head.length ? Buffer.concat([this.head, ...this.tail], this.head.length + this.tailBytes) : this.tail.length === 1 ? this.tail[0] : Buffer.concat(this.tail, this.tailBytes);
      this.tail = [];
      this.tailBytes = 0;
    }
    return this.head;
  }

  private set buf(b: Buffer) {
    this.head = b;
    this.tail = [];
    this.tailBytes = 0;
  }

  /** Too much waited unread: stop reading (ssh then waits on its pipe), let go of it all, and end. */
  private overflow(): void {
    this.over = true;
    this.detach();
    this.s.on("error", () => { /* the run fails as noise and ssh is ended; its pipe's errors don't matter now */ });
    this.onEnd();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Waits for more bytes; false at the end. */
  private async more(): Promise<boolean> {
    if (this.ended) return false;
    const before = this.head.length + this.tailBytes;
    await new Promise<void>(resolve => { this.wake = resolve; });
    return this.head.length + this.tailBytes > before || !this.ended;
  }

  /** Skips to just after `marker`, allowing at most `max` bytes before it: "found", "too-much" or "eof". */
  async skipTo(marker: Buffer, max: number): Promise<"found" | "too-much" | "eof"> {
    for (;;) {
      const at = this.buf.indexOf(marker);
      if (at >= 0) {
        if (at > max) return "too-much";
        this.buf = this.buf.subarray(at + marker.length);
        return "found";
      }
      if (this.buf.length > max + marker.length) return "too-much";
      if (!(await this.more())) return "eof";
    }
  }

  /** One line without its "\n" (a "\r" before it dropped); "too-long" past `max` bytes; null at the end. */
  async line(max: number): Promise<string | "too-long" | null> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        if (nl > max) return "too-long";
        const line = this.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.buf.length > max) return "too-long";
      if (!(await this.more())) return null;
    }
  }

  /** Do the buffered bytes start with `prefix` (waiting for enough of them)? */
  async startsWith(prefix: Buffer): Promise<boolean> {
    while (this.buf.length < prefix.length) {
      if (!this.buf.equals(prefix.subarray(0, this.buf.length))) return false;
      if (!(await this.more())) return false;
    }
    return this.buf.subarray(0, prefix.length).equals(prefix);
  }

  /** Resolves when the stream has ended (ssh's stdout closed: ssh exited or was killed). */
  whenEnded(): Promise<void> {
    return this.ended ? Promise.resolve() : new Promise(resolve => { this.endWaiters.push(resolve); });
  }

  /** Stops reading and hands back what is buffered; the stream is paused for the next reader (pipe resumes it). */
  detach(): Buffer {
    this.s.removeListener("data", this.onData);
    this.s.removeListener("end", this.onEnd);
    this.s.removeListener("close", this.onEnd);
    this.s.removeListener("error", this.onEnd);
    this.s.pause();
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

/**
 * Writes `data` and waits while the stream asks it to (drain); rejects when it closes or fails first, and at once when
 * it is closed already: Node destroys a child's stdin when the child exits, and a write to a destroyed stream emits no
 * 'error', 'close' or 'drain', so waiting there would never end.
 */
export function writeAll(w: NodeJS.WritableStream, data: Uint8Array | string): Promise<void> {
  const state = w as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean; closed?: boolean };
  if (state.destroyed || state.writableEnded || state.closed) return Promise.reject(new Error("ssh's stdin closed"));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      w.removeListener("drain", onDrain);
      w.removeListener("error", onError);
      w.removeListener("close", onClose);
      if (err) reject(err); else resolve();
    };
    const onDrain = () => finish();
    const onError = (e: Error) => finish(e);
    const onClose = () => finish(new Error("ssh's stdin closed"));
    w.on("error", onError);
    w.on("close", onClose);
    let ok: boolean;
    try {
      ok = w.write(data);
    } catch (e) {
      finish(e as Error);
      return;
    }
    if (ok) finish();
    else w.on("drain", onDrain);
  });
}

/** A probe line's key: a short name, dotted for loginctl's session properties and policy chunks. */
const PROBE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}(?:\.[A-Za-z0-9_]{1,32})?$/;

/**
 * Runs the PC's side of the bootstrap on ssh's stdin and stdout (§5.1.9). `decide` gets the probe and returns what to
 * write; nothing is written meanwhile. `progress` hears bytes copied so far of the total.
 */
export async function runBootstrap(
  io: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream },
  hooks: {
    script?: string;
    onProbeBegin?: () => void;
    decide: (probe: Record<string, string>) => Promise<Decision>;
    progress?: (done: number, total: number) => void;
  },
): Promise<BootstrapOutcome> {
  const reader = new StreamReader(io.stdout);
  const fail = (code: string, probe: Record<string, string> | null, probeBegan: boolean, detail?: string): BootstrapOutcome => {
    reader.detach();
    return { kind: "error", code, ...(detail ? { detail } : {}), probe, probeBegan };
  };
  /** ssh's output ended (ssh is gone: its exit code and stderr say why), or more of it waited unread than allowed. */
  const ended = (probe: Record<string, string> | null, probeBegan: boolean): BootstrapOutcome => {
    if (reader.overflowed) return fail("noise", probe, probeBegan);
    reader.detach();
    return { kind: "eof", probe, probeBegan };
  };
  try {
    await writeAll(io.stdin, hooks.script ?? BOOTSTRAP_SCRIPT);
  } catch {
    return ended(null, false);
  }
  const begin = await reader.skipTo(PROBE_BEGIN, BOOTSTRAP_LIMITS.noiseBytes);
  if (begin === "eof") return ended(null, false);
  if (begin === "too-much") return fail("noise", null, false);
  hooks.onProbeBegin?.();
  // The probe, up to EMBER-PROBE-END: key=value lines, bounded; anything else is shell noise and ignored.
  const probe: Record<string, string> = Object.create(null) as Record<string, string>;
  let bytes = 0;
  let lines = 0;
  for (;;) {
    const l = await reader.line(BOOTSTRAP_LIMITS.lineBytes);
    if (l === null) return ended(null, true);
    if (l === "too-long") return fail("probe", null, true);
    if (l === "EMBER-PROBE-END") break;
    bytes += l.length + 1;
    if (++lines > BOOTSTRAP_LIMITS.probeLines || bytes > BOOTSTRAP_LIMITS.probeBytes) return fail("probe", null, true);
    const eq = l.indexOf("=");
    if (eq <= 0) continue;
    const key = l.slice(0, eq);
    if (!PROBE_KEY.test(key) || key === "__proto__" || Object.prototype.hasOwnProperty.call(probe, key)) continue;
    probe[key] = l.slice(eq + 1, eq + 1 + BOOTSTRAP_LIMITS.valueBytes);
  }
  const plain = { ...probe };
  // ssh may end while Ember decides (a dropped network, the user's Cancel during the runtime's download), or flood
  // what nobody reads now: the reader's end answers for it, so a decision nobody can read is never waited for.
  const decision = await Promise.race([hooks.decide(plain), reader.whenEnded().then(() => null)]);
  if (decision === null) return ended(plain, true);
  const line = decision.kind === "quit" ? "QUIT" : decision.kind === "uninstall" ? "UNINSTALL" : decision.line;
  if (!/^[A-Z]+( [A-Za-z0-9._+-]{1,100}){0,8}$/.test(line)) return fail("decision", plain, true);
  try {
    await writeAll(io.stdin, `${line}\n`);
  } catch {
    return ended(plain, true);
  }
  if (decision.kind === "quit") {
    reader.detach();
    return { kind: "done", probe: plain, uninstalled: false };
  }
  // Until the agent's preamble: READY requests (in order, each once), the script's errors, its end, or noise.
  const archives = decision.kind === "install" ? [...decision.archives] : [];
  const total = archives.reduce((n, a) => n + a.bytes, 0);
  let copied = 0;
  let noise = 0;
  for (;;) {
    if (decision.kind !== "uninstall" && (await reader.startsWith(PREAMBLE))) {
      if (archives.length) return fail("ready", plain, true);
      return { kind: "serving", probe: plain, rest: reader.detach() };
    }
    const l = await reader.line(BOOTSTRAP_LIMITS.lineBytes);
    if (l === null) return ended(plain, true);
    if (l === "too-long") return fail("noise", plain, true);
    const err = /^EMBER-ERROR ([a-z0-9-]{1,32})(?: (\S{1,100}))?$/.exec(l);
    if (err) return fail(err[1], plain, true, err[2] && err[2] !== "-" ? err[2] : undefined);
    if (decision.kind === "uninstall" && l === "EMBER-DONE uninstall") {
      reader.detach();
      return { kind: "done", probe: plain, uninstalled: true };
    }
    const ready = /^EMBER-READY (runtime|parts)$/.exec(l);
    if (ready) {
      // Each archive only after its own READY, in order, exactly its bytes (critique remote-1).
      const next = archives.shift();
      if (!next || next.name !== ready[1]) return fail("ready", plain, true);
      let sent = 0;
      let cut = false;
      try {
        for await (const chunk of next.open()) {
          if (sent + chunk.length > next.bytes) return fail("integrity", plain, true, next.name);
          // A remote that stops reading and floods its output instead ends the reader (overflowed); one whose output
          // ends (its script failed and said why) is read on below, its EMBER-ERROR first.
          if (!(await Promise.race([writeAll(io.stdin, chunk).then(() => true), reader.whenEnded().then(() => false)]))) { cut = true; break; }
          sent += chunk.length;
          copied += chunk.length;
          hooks.progress?.(copied, total);
        }
      } catch {
        return ended(plain, true);
      }
      if (reader.overflowed) return fail("noise", plain, true);
      if (cut) continue;
      if (sent !== next.bytes) return fail("integrity", plain, true, next.name);
      continue;
    }
    noise += l.length + 1;
    if (noise > BOOTSTRAP_LIMITS.noiseBytes) return fail("noise", plain, true);
  }
}
