# Remote Ember over SSH: installing the clone and the channel to it

Branch read: `ember-improve/20261022-windows-macos` (node_modules installed). Every `file:line` is from that tree unless it
names `node_modules/...`. The companion spec `sshwsl/agent-ui-split.md` covers what crosses the wire (variant R remote
brain, variant L local brain plus remote hands, the bubble, Confirmer and kill-switch protocols). This spec covers how the
local Ember reaches the remote machine, what it installs there, how it starts and stops it, and how the bytes move. It lays
out options and does not decide them.

Measured on this machine (linux-x64): sizes come from `stat`, `gzip -6` and `xz -6`, glibc floors from `objdump -T`, and
shared-library needs from `readelf -d`.

---

## 0. Key findings

1. **Ember already has the pieces.** It builds plain-Node helpers with esbuild (build-app.mjs:27-47). It runs them with
   its own binary under `ELECTRON_RUN_AS_NODE=1` (launch.ts:37, desk/agent.ts:94), and the fuses keep RunAsNode on
   (fuses.mjs:38-42). It talks newline JSON-RPC over a child's stdio (sidecar.ts:264-272). Its helpers exit when their
   parent goes (agent-process.ts:229; ember_atspi.py:4646-4648 exits on stdin EOF). It fetches pinned downloads with a
   SHA-256 check (appimage.sh:16-22) and gates a glibc 2.28 floor (check-symvers.sh:8). The remote clone is one more
   such helper. The difference is that its stdio is an `ssh -T` session.
2. **The glibc floor is 2.28 everywhere.** The Copilot runtime needs at most `GLIBC_2.28` (copilot-runtime and
   runtime.node, measured). sharp-libvips declares `"glibc": ">=2.28"`. Official Node ≥ 18 Linux builds need 2.28, and
   the local Node 22 binary measures 2.28. So RHEL 8 / Debian 10 / Ubuntu 20.04 or newer work. CentOS 7 (2.17) and
   Ubuntu 18.04 (2.27) cannot run any variant. Electron's own binary needs only 2.25.
3. **The Copilot SDK does publish linux-arm64 and musl runtimes.** `package-lock.json` pins
   `@github/copilot-sdk-{linux,linuxmusl}-{x64,arm64}` and every other platform build with sha512 integrity. Only Ember's
   `runtimeFor` hard-codes linux-x64 (runtime.ts:11-23). Because the lockfile pins every platform package, the remote
   bundle can be assembled for another OS or CPU on one CI machine. The full app cannot (layout.mjs:5-6).
4. **Electron in node mode still needs the GUI libraries.** The `electron` binary's DT_NEEDED list includes libgtk-3,
   libX11, libnss3, libcups, libasound, libgbm, libatk-bridge, libatspi and libdbus. The loader resolves them even under
   `ELECTRON_RUN_AS_NODE`, so it won't start on a minimal server. Official `node` needs only libc, libstdc++, libm and
   libgcc_s. Sizes: Electron binary 228 MB (94 MB gz); node 123 MB (43 MB gz, 29 MB xz).
5. **The token reaches the runtime as an environment variable, never on argv.** The SDK sets
   `COPILOT_SDK_AUTH_TOKEN=<token>` in the runtime child's env (node_modules/@github/copilot-sdk/dist/cjs/client.js:2261-2262)
   and passes only `--auth-token-env COPILOT_SDK_AUTH_TOKEN` (client.js:2308-2309). On a remote brain the token would
   therefore sit in that child's `/proc/<pid>/environ`, readable by the same uid and root, and in its memory, but not on
   disk or argv. A per-session `gitHubTokenProvider` callback also exists (types.d.ts:2520; client.js:620-622) and might
   keep the token out of the runtime's env. That needs a spike.
6. **Win32-OpenSSH has no ControlMaster.** Third-party documentation agrees on this. So Ember must multiplex its own
   streams over one `ssh` process on every OS rather than rely on SSH-level multiplexing. SSH_ASKPASS support on Windows
   is unconfirmed (spike).
7. **An SSH session is not the user's desktop session on any OS.** Linux needs the graphical session's
   DISPLAY/XAUTHORITY/bus, discovered and allow-listed. Windows sshd children run in Session 0, which has no
   interactive desktop. macOS ssh children lack the Aqua session's TCC grants. "Acting on the remote desktop" therefore
   needs a per-OS way into the GUI session (§9.4). That is the hardest install problem. Headless servers have nothing to
   act on under today's rules.
8. **`ssh` stays refused for the agent.** It is on the agent's never-start list (terminals.ts:186, 189, 192). Ember's
   own deterministic connect code, started by a user click, spawns the system `ssh`. No model tool may start a
   connection, choose a host or answer an SSH prompt.
9. **Bundle size per remote target (linux-x64, compressed):** about 37 MB xz / 52 MB gz with the brain local. With the
   brain remote, about 76 MB xz / 108 MB gz, because the Copilot runtime adds 137 MB raw. Content-addressed blobs make an
   app-only update about 0.3 MB.

---

## 1. What Ember already does that this reuses

| Need | Today | Where |
|---|---|---|
| One-file Node helpers | esbuild bundles `desk-agent.cjs` and `ax-sidecar.cjs`: `platform:"node"`, `format:"cjs"`, `target:"node24"`, with `koffi` and `sharp` external (main.cjs also keeps `@github/copilot-sdk` and `electron` external) | build-app.mjs:17-47 (externals :25, :35, :46) |
| Running a helper as plain Node | `{...env, ELECTRON_RUN_AS_NODE:"1"}`, `execPath` = Ember's binary, `windowsHide` | launch.ts:36-43; desk/agent.ts:94 |
| Keeping that possible in a hardened build | Fuses: RunAsNode on, NODE_OPTIONS off, `--inspect` off | fuses.mjs:30-42; stage.mjs:138-140 |
| Dropping test switches from a packaged child's env | `TEST_SWITCHES` stripped when packaged | launch.ts:18, :39 |
| Stdio JSON-RPC client with timeouts, kill-and-respawn, id blocks | `AtspiSidecar` | sidecar.ts:1-12, :198-213, :256-272, :364-371 |
| Helper dies with its parent | `process.on("disconnect", exit)`; the Python sidecar's loop ends on EOF | agent-process.ts:229; ember_atspi.py:4646-4648 |
| Capability handshake and closed dispatch | `{ready, calls}`; `targets[t][m]`, `close` refused | agent-process.ts:215-231; desk/agent.ts facade |
| stderr tail with noise filtered for the exit reason | `NOISE`, last 4000 chars | desk/agent.ts:26-28 |
| Pinned download with SHA-256 | `fetch url sha dest` | appimage.sh:16-22 |
| glibc floor check | GLIBC_2.28 / GLIBCXX_3.4.25 / CXXABI_1.3.11 | check-symvers.sh:8-10; rebuild-el8.sh |
| Per-target file lists | `layoutFor` (platformPackages, prune, sidecarFiles, requiredDist) | layout.mjs:32-116 |
| Choosing platform builds, pruning the runtime's tool folders | `selectPackages`; `COPILOT_TOOLS` pruned | layout.mjs:15-21, :151-163; stage.mjs:177 |
| Finding the Copilot runtime per OS | `runtimeFor(os, arch)` (Linux fixed to x64), `locateRuntime`, chmod +x | runtime.ts:19-23, :40-64 |
| Token sources | stored (safeStorage), env (`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`), `gh auth token`; device flow with scope `read:user` | auth.ts:25-27, :29-66, :78-103, :120 |
| Admin policy, fail-closed, root-owned file | `loadAdminPolicy`, `parseAdminPolicy`, `LOCKDOWN`, `.strict()` schema | admin.ts:15, :19-59, :72-81, :88-122 |
| Spawning helpers per OS | `spawnDefaults` (`windowsHide` on Windows), `which()` | platform/types.ts:512-516; platform/which.ts:50 |
| Dev-only overrides ignored when packaged | `devEnv()`; debugging switches refused | main.ts:58, :60-67 |
| Copilot client start | `new CopilotClient({mode:"empty", baseDirectory: <userData>/copilot, gitHubToken, connection: RuntimeConnection.forStdio({path}), env})` | host.ts:686-694; env built at host.ts:954-979 |

---

## 2. Starting `ssh` from Ember

### 2.1 Which client

| Local OS | Client | Notes |
|---|---|---|
| Linux | `/usr/bin/ssh` (OpenSSH; RHEL 8 ships 8.0p1) | Ember started from the desktop inherits `SSH_AUTH_SOCK` (gnome-keyring/gcr agent) |
| Windows 10 1809+/11 | `%SystemRoot%\System32\OpenSSH\ssh.exe` (Win32-OpenSSH; an optional feature installed by default) | Electron is 64-bit, so there is no System32 redirection. The agent is the `ssh-agent` service (named pipe `\\.\pipe\openssh-ssh-agent`), which is disabled by default. No ControlMaster. Pageant users need Pageant's OpenSSH-compatible pipe. Spawn with `spawnDefaults` (`windowsHide:true`, types.ts:516) so no console window flashes |
| macOS 13+ | `/usr/bin/ssh` | launchd gives GUI apps `SSH_AUTH_SOCK`; Apple's `UseKeychain` works. A Homebrew ssh in `/opt/homebrew/bin` is ignored unless the user picks it (`which()` with extraDirs, which.ts:50) |

How the client is chosen: an absolute path to the system client (predictable, not PATH-hijackable), with a setting to
use another one. `ssh -V` prints the version on stderr. Ember needs it to pick features: `SSH_ASKPASS_REQUIRE` needs
8.4 or later, and `-G` needs 6.8 or later.

### 2.2 The command line

Built by a pure function (proposed `app/main/remote/ssh.ts`, unit-tested on every OS):

```
ssh -T
    -o BatchMode=yes                 # every non-interactive run: probe, upload, serve, reconnect (§2.4 for the interactive one)
    -o StrictHostKeyChecking=yes     # never trust a new key silently, whatever the user's config says (command line wins)
    -o ForwardAgent=no -o ForwardX11=no -o ForwardX11Trusted=no -o ClearAllForwardings=yes
    -o PermitLocalCommand=no -o RemoteCommand=none -o RequestTTY=no
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15
    -o LogLevel=ERROR
    [-o ControlMaster=auto -o ControlPath=<userData>/ssh/cm-%C -o ControlPersist=120]   # Linux/macOS only, §2.5
    [-p <port>] -- <destination> <remote command words>
```

Why each option is there:
- `-T`: no pty, so the stream is binary-clean, there is no echo, no escape char, and no SIGHUP semantics.
- `ForwardAgent=no`: a forwarded agent would let remote root use the user's keys. The user's config may enable it for
  that host, but the first value ssh obtains wins and command-line `-o` comes first.
- `RemoteCommand=none`: a `RemoteCommand` in the user's config would otherwise make ssh refuse ("Cannot execute
  command-line and remote command").
- `ClearAllForwardings`: no `LocalForward`/`DynamicForward` from the user's config rides on Ember's channel.
- What Ember keeps from the user's `~/.ssh/config`: HostName, User, Port, IdentityFile, ProxyJump/ProxyCommand,
  Ciphers/KEX, and their own ControlMaster/ControlPath. Ember never passes `-F`.
- Environment: the user's environment as Ember got it (for `SSH_AUTH_SOCK`, `HOME`, `USER`), less Ember's own variables
  (`ELECTRON_RUN_AS_NODE`, `EMBER_*`, `NODE_OPTIONS`), plus the askpass variables during an interactive connect.

**Validating the destination** (option injection: a destination starting with `-` is an option to ssh):
- Allowed shape: `^(?!-)[A-Za-z0-9._%+@\[\]:-]{1,255}$`, with no whitespace or control characters. The port is passed
  separately as an integer `-p`. `--` always comes before the destination.
- `ssh://user@host:port` is accepted only after Ember parses it into these parts.

**Resolving before connecting:** `ssh -G <destination>` prints the effective config without connecting (works on
Windows too). Ember uses it to:
- show "Connect to `user@hostname:port` via `<proxyjump>`" before the first connect;
- refuse or warn when the effective config weakens host checking: `stricthostkeychecking no|off`, or
  `userknownhostsfile /dev/null`;
- learn whether the user already has a `controlpath`.

Caveat: `-G` evaluates `Match exec` lines, which runs the user's own commands. Their own ssh would run them on any
connect anyway.

**Where hosts come from:** typed by the user, or picked from the `Host` lines of `~/.ssh/config` (non-wildcard names,
following `Include`, best effort). Never from screen text, a model answer or the remote.

### 2.3 Classifying failures (BatchMode)

OpenSSH has no translations, so its messages are stable strings. ssh exits with 255 for its own errors and with the
remote command's status otherwise. Classified from stderr:

| stderr contains | Meaning | What Ember does |
|---|---|---|
| `Host key verification failed.` with no `IDENTIFICATION HAS CHANGED` | Unknown host key | Interactive connect (§2.4) shows the fingerprint in Ember's own window |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` | Possible MITM, or a reinstalled host | Refuse. No one-click accept. Tell the user to check and fix `known_hosts` themselves |
| `Permission denied (` | Needs a password, passphrase, OTP, or a key the agent lacks | Interactive connect; or "add your key to ssh-agent" |
| `Could not resolve hostname`, `Connection refused`, `Connection timed out`, `No route to host`, `kex_exchange_identification`, `Connection closed by` | Network, or no sshd | Plain message; retry with backoff when it was a reconnect |
| `Too many authentication failures` | Agent offers too many keys | Point at `IdentitiesOnly`/`IdentityFile` in their config |
| exit ≠ 255 | Ember's remote side failed | Remote diagnostics (stderr tail, as desk/agent.ts:26-28) |

The text the remote sends (`Banner`, motd, shell noise) is **untrusted**. It may appear in a details view as plain
text. It never goes to the model, the bubble or the audit log.

### 2.4 Handing prompts to the user, never to the model

Two options, and they can be combined.

**P-A. BatchMode only.** Ember never prompts. On an unknown host key or a missing credential it explains and stops:
- what to run once in the user's own terminal, `ssh <host>` (Ember doesn't open the terminal; that is a hard rule);
- or what to do: add the key to ssh-agent, or enable ControlMaster in their config so Ember reuses their session.

Costs: smallest code, nothing secret ever passes through Ember. Password-only and OTP hosts are impossible, and a
Windows user without the ssh-agent service enabled must fix that first.

**P-B. Ember's own askpass.**
- Ember spawns ssh `detached:true` (no controlling tty), without BatchMode, with `SSH_ASKPASS=<helper>`, plus
  `SSH_ASKPASS_REQUIRE=force` (8.4+) or `DISPLAY` set (older OpenSSH such as RHEL 8's 8.0 uses askpass only when DISPLAY
  is set and there is no tty).
- ssh runs the helper with the prompt text as its only argument. The helper connects to the running Ember through a
  per-connect IPC endpoint and sends `{nonce, prompt}`:
  - Linux/macOS: a Unix socket in a 0700 folder under userData.
  - Windows: a named pipe with the user's SID only.
  - The nonce comes in the helper's env, set by Ember for this one ssh run.
- Ember shows **its own** window with the host name, kind by pattern, and the prompt as untrusted text. Kinds by
  pattern: `Are you sure you want to continue connecting` with a `SHA256:` fingerprint; `Enter passphrase for key`;
  `password:`; keyboard-interactive such as `Verification code:`; `Confirm user presence` (FIDO touch, a notice only).
- The helper prints the answer to stdout and exits 0, or exits 1 when cancelled.
- The answer goes nowhere else: no log, no settings, no model, no audit text. The audit records only
  `{event:"remote", host, step:"prompt", kind}`.
- The helper program:
  - Linux/macOS: a two-line `sh` wrapper in userData (0700) running Ember's binary with `ELECTRON_RUN_AS_NODE=1` and
    `askpass.cjs`. `SSH_ASKPASS` takes one program and no arguments.
  - Windows: unknown whether Win32-OpenSSH honours `SSH_ASKPASS` for ssh.exe (one third-party report says no). Spike;
    the fallback there is P-A.
- A host-key answer is typed or clicked by the user. Ember never auto-answers `yes`.
- After a successful interactive connect, BatchMode runs reuse the authentication when a ControlMaster exists
  (Linux/macOS). Without one (Windows), each new ssh process authenticates again, so everything rides one process
  (§10).

**Who may start a connection:** only Ember's settings window or the handle menu (deterministic code, a click). There is
no conductor or worker tool for it. If the user says "connect to build-01", the conductor may offer a "Connect" button
in the bubble, and the user's click starts it. This keeps "goals only from the user" and "screen text is untrusted" in
force.

### 2.5 ControlMaster reuse (Linux and macOS local only)

- **If the user's own config has a `ControlPath` and a live master** (`ssh -O check`): Ember's ssh rides their
  already-authenticated session. No prompts, and fast.
- **Ember's own master** (optional): `ControlPath=<userData>/ssh/cm-%C`, in a 0700 folder. `%C` is a hash, which keeps
  the path under the 104/108-byte sun_path limit. Probe, upload and serve then cost one authentication.
  - The master is a background ssh process. Ember ends it at quit (`ssh -O exit -o ControlPath=…`), and
    `ControlPersist=120` bounds it after a crash.
- **Windows:** none. Ember multiplexes inside one ssh process. Install and serve become one connection (§7.2) or two
  authentications.

### 2.6 Detecting "I SSHed into a system" (the owner's phrasing)

| Option | How | Cost / risk |
|---|---|---|
| D1 explicit | "Bring Ember to a computer…" in the handle menu or settings; host from the list | Clear consent per host. One click more |
| D2 notice the user's ssh | List the user's own running `ssh` client processes. Linux `/proc/*/cmdline`; macOS `ps`/`sysctl KERN_PROCARGS2`; Windows process snapshot. Parse the destination the way ssh does and offer "Bring Ember to build-01?" | Reads command lines, not terminal content, but argv can carry other details. Must not run in a loop without consent. Their ControlMaster (if any) makes it seamless |
| D3 hook the user's ssh config | `LocalCommand`/`ProxyCommand` that tells Ember | Edits the user's config. Fragile. Not recommended |

---

## 3. Probing the remote

One BatchMode run, `ssh … -- <dest> sh -s`, sends a fixed probe script on stdin.
- `sh -s` is two plain words, valid as a command in every login shell (bash, zsh, fish, tcsh) and with no quoting
  issues.
- The script prints `key=value` lines between `EMBER-PROBE-BEGIN` and `EMBER-PROBE-END`. Anything outside the markers is
  shell or banner noise and is dropped.
- If the remote isn't POSIX (Windows' default shell is cmd.exe, or PowerShell if `HKLM\SOFTWARE\OpenSSH\DefaultShell`
  is set), `sh` is "not recognized". A second probe then runs `cmd /c "echo %PROCESSOR_ARCHITECTURE% & ver"`.

| What | How (POSIX) | Why |
|---|---|---|
| OS, CPU | `uname -s` (Linux/Darwin), `uname -m` (x86_64/aarch64/arm64); macOS Rosetta `sysctl -n sysctl.proc_translated` | Bundle target |
| libc and version | `getconf GNU_LIBC_VERSION` ("glibc 2.28"; fails on musl); `ldd --version 2>&1 \| head -n1` ("ldd (GNU libc) 2.28", or "musl libc") | 2.28 floor (§0.2); musl picks `linuxmusl-*` |
| Distribution | `. /etc/os-release; echo "$ID $VERSION_ID"` | Messages, RHEL 8 python path |
| Home, data dirs, free space | `echo "$HOME"`; `df -Pk "$HOME"` | Install location; ≥ 2× bundle size |
| Home mounted noexec | `findmnt -no OPTIONS -T "$HOME"` contains `noexec` | Binaries in `~/.local/share` won't run. Offer `$XDG_RUNTIME_DIR` (per session, re-sent each time) or stop |
| SELinux | `getenforce`; `id -Z` (`user_u`/`staff_u` may forbid running from home) | Diagnose "permission denied" when starting the bundle |
| Existing installs | `ls -1 ~/.local/share/ember-remote/versions ~/.local/share/ember-remote/blobs 2>/dev/null`; marker files | Skip the upload, or send only missing blobs (§7.3) |
| Running clone | lock file in `$XDG_RUNTIME_DIR/ember-remote/` | Single instance (§9.3) |
| Graphical session of this uid | `loginctl list-sessions --no-legend`, then `loginctl show-session <id> -p Type -p Display -p Active -p Remote -p Class -p State`; `systemctl --user show-environment` (DISPLAY, WAYLAND_DISPLAY, XAUTHORITY); `ls -l /run/user/$(id -u)/bus` | Whether there is a desktop to act on, X11 or Wayland (§9.4) |
| Accessibility stack | `/usr/libexec/platform-python` or `python3 -c 'import pyatspi'` (pickPython, sidecar.ts:188-192) | Tier 1 on the remote. Ember never installs system packages |
| X libraries for koffi | `ls /usr/lib64/libXtst.so.6 /usr/lib/x86_64-linux-gnu/libXtst.so.6 2>/dev/null` | Tier 3 / capture |
| Electron's GUI libraries (only if the Electron-as-Node runtime is chosen) | `ldconfig -p \| grep -c 'libgtk-3.so.0\|libnss3.so\|libgbm.so.1'` | §4.1 option E |
| Remote admin policy | `stat -c '%u %a' /etc/ember/policy.json` and `cat` it (≤ 64 KiB) | Show and compose locally (§12). The clone re-reads it itself |
| Network egress (remote brain only) | Done by the clone with Node `fetch` to api.github.com, not by the probe | Copilot reachable from the remote |

The probe is fixed text bundled in the local app (esbuild `loader: {".sh": "text"}`). It is reviewable and never built
from user or remote input.

---

## 4. The remote bundle

### 4.1 Which JavaScript runtime

| Option | What ships | Size (linux-x64) | Pros | Cons / risks |
|---|---|---|---|---|
| **E. Ember's Electron as Node** (`ELECTRON_RUN_AS_NODE=1`) | `electron` renamed, `icudtl.dat`, V8 snapshots, `libffmpeg.so` (DT_NEEDED) | binary 228 MB (94 MB gz); trimmed dist about 245 MB, about 100 MB gz | Same binary and fuses as local (no `--inspect`, no NODE_OPTIONS; the inspect fuse also stops SIGUSR1 from opening an inspector). Node ABI identical to what local tests. A Linux local Ember can build the bundle **from its own install** with no download | Needs GTK3, X11, NSS, cups, ALSA, gbm, atk-bridge, atspi, dbus on the remote (DT_NEEDED, measured). Fine on a desktop, fails on a minimal server. About 2.5× bigger |
| **N. Official Node** (pinned v24.x, SHA-256 from SHASUMS256.txt, fetched like appimage.sh:16-22) | `bin/node` only | about 123 MB raw, 43 MB gz, 29 MB xz (v22 measured; v24 similar) | Needs only libc, libstdc++, libm, libgcc_s. Builds for linux-x64/arm64 (glibc 2.28), darwin-x64/arm64, win-x64/arm64. N-API addons (koffi, sharp, runtime.node) are ABI-stable across Node versions | No fuses. Ember must start it with `--disable-sigusr1` (Node ≥ 22.14 / 23.7) and refuse to run if `NODE_OPTIONS` is set. Another runtime to track for CVEs. musl needs the unofficial-builds musl Node |
| **S. Remote system `node`** | nothing | 0 | No upload | Version unknown (Ember needs ≥ 22.12, package.json:10-11; build target node24, build-app.mjs:24). Often absent; RHEL 8 appstream modules vary. Only as an optional fast path after a version check |
| **SEA** (Node single executable) | node with the script embedded | ≈ N | One file | Native addons still extracted beside it. No real gain |

The Copilot runtime is a native launcher plus a native library: `copilot-runtime` is a 508 KB ELF and `runtime.node`
136.5 MB. It does not need Node or Electron. It is only needed when the brain runs remotely.

### 4.2 Contents per target

Proposed new esbuild entry `app/remote/main.ts` → `dist/app/ember-remote.cjs`:
- `platform:"node"`, `format:"cjs"`, `target:"node24"`, `external:["electron","koffi","sharp","@github/copilot-sdk"]`;
- it never imports electron (rule D1, decisions.md);
- expected about 1-1.5 MB raw, about 0.3 MB gz (main.cjs is 1.41 MB today).

| Piece | linux-x64 (glibc) | linux-arm64 | Windows x64/arm64 | macOS arm64/x64 | Needed when |
|---|---|---|---|---|---|
| JS runtime | §4.1 | Node linux-arm64 | node.exe | node (Developer ID signed by the Node.js project) | always |
| `ember-remote.cjs` | ✓ | ✓ | ✓ | ✓ | always |
| `koffi` + `@koromix/koffi-<t>` (prune musl, .lib/.exp as stage does, layout.mjs:50, :71) | linux_x64 1.2 MB | ✓ | ✓ | ✓ | X11/XTest, Win32, macOS APIs |
| `sharp` + `@img/sharp-<t>` + `@img/sharp-libvips-<t>` | 0.44 + 18.7 MB raw (8 MB gz) | ✓ | sharp-win32 carries libvips | ✓ | **yes**: capture encodes JPEG/PNG and composites the set-of-marks SVG (capture.ts:99-106) on the machine that captures |
| Accessibility | `sidecar/atspi/ember_atspi.py` (207 KB); system python3 + pyatspi | same | `ax-sidecar.cjs` (138 KB) + `sidecar/uia/ember_uia.{ps1,cs}` (118 KB) | `ax-sidecar.cjs` (koffi AX) | tier 1 |
| `desk-agent.cjs` (Xvfb desk on the remote) | optional, 49 KB, needs Xvfb there | same | – | – | only if a remote desk is wanted |
| Copilot runtime `@github/copilot-sdk-<t>` with `COPILOT_TOOLS` pruned (layout.mjs:21) | 137 MB raw, 56 MB gz, 38 MB xz; max GLIBC_2.28 | `linux-arm64` | `win32-*` | `darwin-*` | **brain on the remote only** |
| `@github/copilot-sdk` JS + `vscode-jsonrpc` + `zod` | about 1 MB without docs; or bundle `vscode-jsonrpc`/`zod` into the .cjs | | | | brain on the remote only (otherwise only `zod`, bundled) |
| `manifest.json`, `LICENSE`, `THIRD_PARTY_NOTICES` (same generator as stage.mjs:211-227) | ✓ | ✓ | ✓ | ✓ | always |
| Voice (sherpa-onnx, models), renderer, preload, fonts | – | – | – | – | never: voice and UI stay local |

Totals for linux-x64 (rounded):

| Variant | Raw | gz | xz |
|---|---|---|---|
| L (local brain), runtime N | about 146 MB | about 52 MB | about 37 MB |
| R (remote brain), runtime N | about 283 MB | about 108 MB | about 76 MB |
| L, runtime E | about 270 MB | about 110 MB | – |

At 10 Mbit/s up, 37 MB takes about 30 s and 108 MB about 90 s. Later updates with blobs (§7.3) send only what changed.

Memory on the remote:
- Node with the app: about 60-120 MB RSS (estimate; measure).
- The Copilot runtime when the brain is remote: unmeasured (spike).

### 4.3 Where the bundles come from

| Option | How | Cost / risk |
|---|---|---|
| B1 built in CI, downloaded on demand by local Ember | New `scripts/package/remote-bundle.mjs <target>` writes `ember-remote-<ver>-<target>.tar.gz` plus manifest. The local app's build embeds `remote-bundles.json` with `{target → url, sha256, size}`. Local downloads, verifies the pinned SHA-256 (appimage.sh pattern), caches in userData, then streams over ssh | Release pipeline per version. Local needs GitHub egress (it has it for Copilot anyway) |
| B2 shipped inside every local installer | All remote targets in resources | +40-80 MB **per target** in every installer. Simple offline |
| B3 local derives it from its own install | Same OS and CPU as local: Electron (option E), koffi, sharp, runtime and sidecar are already installed | Only same-OS/CPU pairs. Windows → Linux (the most common SSH case) is not covered |
| B4 the remote downloads directly | Local sends url + SHA-256; the remote's `curl -fsSL`/`wget` fetches into staging; verified there | Fast datacenter links. Needs remote egress, curl/wget and proxy settings |
| B5 the remote admin pre-installs | An `ember-remote` RPM in `/opt/ember-remote` (root-owned) | Best for managed fleets and admin-policy integrity (§12). Needs a packaging target |

**Cross-assembly is possible for the remote bundle.** Every platform package's version and sha512 integrity is in
`package-lock.json`: copilot-sdk ×8, sharp ×N, koffi ×N (listed by reading it). So one Linux CI job can fetch them with
`npm pack <name>@<ver>` and check them against the lockfile integrity. The esbuild output is platform-independent.
Only the Node binary is per-target, pinned by SHA-256. The full app cannot be cross-staged (layout.mjs:5-6) because it
needs Electron, icons, signing and fuses per OS.

`runtime.ts:19-23` must learn remote targets: `runtimeFor(os, arch, libc)` → `linux-arm64`, `linuxmusl-x64`, ….

---

## 5. Where it installs

| Remote OS | Root (not configurable from the wire) | Layout |
|---|---|---|
| Linux | `~/.local/share/ember-remote/` | `versions/<id>/` (node, `app/ember-remote.cjs`, `node_modules/…`, `sidecar/…`, `manifest.json`, `.verified`); `blobs/<sha256>` (optional content-addressed store); `staging-<id>-<rand>/`; `README` (what this is, how to remove it) |
| | `~/.local/state/ember-remote/` | `logs/` (rotated), `audit/` (the remote's own record of what was done on this machine, 30 days like local), `settings.json` (remote-scoped grants in variant R) |
| | `$XDG_RUNTIME_DIR/ember-remote/` (tmpfs, 0700, cleared at logout) | `lock`, the **Copilot conversation store** in variant R (`COPILOT_HOME`/`baseDirectory`, host.ts:688), IPC sockets. Fallback when unset: `mkdtemp` in `/tmp` (0700), removed at exit |
| Windows | `%LOCALAPPDATA%\Ember\remote\` | same shape; state in `%LOCALAPPDATA%\Ember\remote-state\` |
| macOS | `~/Library/Application Support/Ember Remote/` | same; the conversation store in `$TMPDIR` (per-user, `confstr`) |

- `<id>` = `<package version>+<first 12 hex of the manifest's SHA-256>`. An exact build id, so two local Embers of
  different versions can each keep theirs.
- Folders are 0700 and files 0500/0400. Ember never writes outside these roots. No autostart, cron or systemd unit is
  installed on Linux. The exception is the GUI-session helper on Windows and macOS (§9.4), which is removed with the
  rest.
- `XDG_DATA_HOME` is deliberately not followed for the entry point. The serve command uses a fixed path relative to
  home, so it needs no shell expansion (§9.1).

---

## 6. Integrity

1. **Manifest:** `{format:1, id, target, libc, minGlibc:"2.28", entry:{runtime, script, args}, files:[{path, size,
   mode, sha256}]}`. The manifest's own SHA-256 is pinned in the local app's build (`remote-bundles.json`) and checked
   locally before anything is sent.
2. **Verified on the remote before anything from the bundle runs**, by the remote's own tools, not by bundle code:
   `sha256sum -c` (coreutils); `shasum -a 256 -c` (macOS); `Get-FileHash -Algorithm SHA256` or
   `certutil -hashfile … SHA256` (Windows). Files land in `staging-*`. On success: `mv -T staging-* versions/<id>`
   (atomic rename on one filesystem), then `.verified` with the manifest hash. On failure the staging folder is
   deleted and the install reports which file failed.
3. **Every serve** checks `.verified` and the manifest hash. A full re-hash at every connect takes about 0.3 s for
   about 150 MB, 0.6 s with the runtime; it can be on by default or only after an update.
4. **What it does not protect against:** anything running as the same remote user, or root, can change the files after
   the check (TOCTOU) or the process itself. The remote account is the trust boundary. Integrity catches corrupt or
   partial uploads, version mix-ups and a tampered download. A user-space install is not tamper-proof against its own
   user (see §12).

---

## 7. Moving the bundle

### 7.1 Options

| Option | Command | Pros | Cons |
|---|---|---|---|
| T1 tar over ssh stdin | `ssh … -- <dest> sh -s` with stdin = the install script, then the payload | Works wherever `sh`, `tar`, `gzip` and `sha256sum` exist. No sftp subsystem needed. One process (fits Windows-local without ControlMaster). Progress = bytes written | Not resumable. The script must hand stdin to `tar` (or `dd`/`head -c`) at a known point |
| T2 scp/sftp | `scp`/`sftp -b` (OpenSSH ≥ 9.0 scp uses the sftp protocol) | Resumable (`reput`); progress | Needs the sftp subsystem, which some hardened sshd configs remove. A second tool. Still needs a remote step to verify and install |
| T3 Ember's own framed upload | After a tiny bootstrap, chunks ride the same multiplexed channel (§10) | Resumable per blob. Shares the authentication | Chicken-and-egg: needs something running remotely first (the bootstrap is T1 anyway) |
| T4 remote download (B4) | the remote fetches from GitHub | Saves the local uplink | Remote egress |

**About T1:** POSIX `sh` reading a script from a non-seekable stdin does not read ahead past the current command
(dash and bash comply). So a script line such as `head -c "$SIZE" > "$staging/bundle.tar.gz"` consumes exactly the
payload that follows it, and the script continues after it. Alternatives:
- the payload size on the command line, which is not secret;
- two invocations: script, then `tar -xzf - -C <staging>` alone, which is cheap with a ControlMaster.

**Compression:** gzip is everywhere (tar `-z`). xz saves about 30% (`-J`, present on most Linux and on macOS bsdtar)
and is chosen from the probe's `command -v xz`.

**Windows remote:** `tar.exe` (bsdtar, Windows 10 1803+) reads `-f -`. Binary stdin through Win32-OpenSSH and cmd.exe
must be verified (spike). Hashing uses `Get-FileHash`.

### 7.2 One connection for install and serve (Windows-local, password hosts)

`sh -s` with the script and payload. The script's last line is `exec <fixed relative path>/node … serve`, so the same
ssh process continues as the clone's channel. One authentication covers the whole thing. The serve preamble (§10.2)
marks where JSON frames start.

### 7.3 Updates as deltas: content-addressed blobs

- `blobs/<sha256>` holds each file once. `versions/<id>/` holds hard links into it, or copies where links are refused
  (Windows without permission).
- The probe lists the blob names. Local sends only the missing ones, as one tar.
- A version bump that changes only the app sends `ember-remote.cjs` (about 0.3 MB gz). A Node or SDK bump sends those
  blobs.
- GC: blobs not referenced by any kept version.

---

## 8. Versions, updating, uninstalling

- **Handshake:** the remote's `welcome` carries `{proto, id}`. Policy option U1 is an exact `id` match: local starts
  exactly `versions/<id>/`, so a mismatch can only mean a broken install. Option U2 is a proto range (a newer local
  drives an older clone through capability lists, like the desk's `calls`, agent-process.ts:231). U1 is simpler and
  keeps the policy code on both ends identical. U2 avoids re-uploads after every local update when blobs aren't used.
- **Update:** on connect, if `versions/<id>` is missing, install it first (§7), then serve. It is atomic, and the old
  version stays usable until the new one is verified.
- **Keep and GC:** keep the newest two versions. Remove older ones, and orphaned blobs and staging folders, after a
  successful serve start, under the single-instance lock so a running version is never deleted.
- **Uninstall:**
  - Local "Remove Ember from <host>" sends a fixed command,
    `sh -c 'rm -rf "$HOME/.local/share/ember-remote" "$HOME/.local/state/ember-remote"'`, with paths computed remotely
    and never sent. On Windows and macOS it also removes the GUI helper registration (scheduled task / LaunchAgent).
  - Ember also forgets that host locally.
  - The remote user can do it without Ember: `README` in the folder, or
    `~/.local/share/ember-remote/versions/<id>/node …/ember-remote.cjs uninstall`.
- **Downgrade:** the same path, since versions are exact ids.

---

## 9. Running the clone

### 9.1 The serve command

POSIX remote:

```
ssh … -- <dest> .local/share/ember-remote/versions/<id>/node --disable-sigusr1 .local/share/ember-remote/versions/<id>/app/ember-remote.cjs serve --proto 1
```

- sshd runs the command through the user's login shell (`$SHELL -c "<command>"`) **in their home folder**. A relative
  path made only of `[A-Za-z0-9._+/-]` needs no quoting or expansion in sh, bash, zsh, fish or tcsh.
- `<id>` is restricted to `[0-9a-z.+]`.
- Where the shell allows it, sshd's child is the shell running the command. Most shells exec a single simple command
  directly, and bash does. Otherwise the clone's parent is the shell. Either way the clone sees EOF when the channel
  closes (§9.2).
- Option E (Electron as Node): `ELECTRON_RUN_AS_NODE=1` must be in the env. Prefix the command with
  `env ELECTRON_RUN_AS_NODE=1 …`, which is valid in every shell because `env` is a program.
- **Nothing secret and no user content on the command line.** `/proc/<pid>/cmdline` is world-readable, and auditd
  rules on STIG-hardened RHEL log every `execve` argv. The token, the user's request and host names of other machines
  travel only inside the channel.
- **Shell noise:** bash sources `.bashrc` even for sshd commands, and `.bashrc` may print. The clone writes a preamble
  (§10.2) and local drops everything before it, up to 64 KiB.
- **Environment hygiene in `ember-remote.cjs`:**
  - refuse to start (exit with a message) if `NODE_OPTIONS`, `NODE_PATH` or `NODE_DEBUG` is set (option N has no fuse);
    `--disable-sigusr1` covers the SIGUSR1 inspector;
  - children get an allow-listed env only: `HOME`, `PATH`, `LANG`/`LC_*`, the proxy variables, and the GUI session keys
    from §9.4. Never the token, except the runtime's own variable set by the SDK.
- **Windows remote:** the default shell is cmd.exe, or PowerShell. A relative path with backslashes and no spaces
  (`AppData\Local\Ember\remote\versions\<id>\node.exe …`) is valid in cmd. PowerShell behaviour with a relative path
  containing `\` must be verified (spike).

### 9.2 Tied to the channel, never `nohup`

- **No `nohup`, daemon or `setsid` by default.** A clone that keeps running after the link drops would be an agent
  acting with nobody able to see, confirm or stop it. That contradicts the kill switch and the dead-man in
  agent-ui-split.md §4.5.
- Without a pty, sshd sends no SIGHUP on disconnect. The clone sees **stdin EOF**, and EPIPE on writes; Node ignores
  SIGPIPE.
  - `process.stdin.on("end"|"close")` triggers stop: the remote KillSwitch with the `agent` and `borrow` parts. Then the
    children are killed, and the process exits. This mirrors agent-process.ts:229.
- **Children:**
  - The clone spawns them in their own process group (`detached:true`) and kills `-pgid` at exit.
  - The Python sidecar also exits on EOF (ember_atspi.py:4646-4648). Whether `copilot-runtime --stdio` exits on EOF must
    be checked (spike).
  - A hard-killed clone (OOM) leaves only children that see EOF on their stdin.
- **Watchdog:** a `worker_threads` thread pings the main loop. If the main thread stalls more than 2 s, the worker
  `process.kill(process.pid, "SIGKILL")`s. The dead-man (no frame from local for 3-5 s) runs in the main loop and so
  depends on it not being blocked.
- **Freshness gate:** before every primitive action (click, key, type, set_value, launch), the remote hands check that
  the last frame from local arrived less than 1.5 s ago. This bounds what can happen between link loss and the dead-man
  to at most one action.
- **Optional grace (owner's choice):**
  - G0: none. Exit on EOF. Recommended for v1.
  - G1: keep the conversation, but no tasks and no actions, for 60 s waiting for a reconnect that authenticates again.
    This requires the clone to survive EOF, so it needs a short-lived re-attach socket (0700, peer uid).
    More state and more attack surface.

### 9.3 Single instance

- `$XDG_RUNTIME_DIR/ember-remote/lock`, held through an `flock` syscall via koffi, or with `O_EXCL` plus pid and
  start-time liveness.
- A second local Ember (another PC) connecting to the same account is refused: "Ember from another computer is already
  connected to build-01". Two agents on one desktop could fight.
- Option: allow the second one to observe only.

### 9.4 Getting into the desktop session (per remote OS)

- **Linux, same uid as the graphical login:**
  1. The clone picks a session: `loginctl` sessions with `Class=user`, `Active=yes`, `Type=x11` (or `wayland`).
  2. It takes `DISPLAY`, `XAUTHORITY` and `WAYLAND_DISPLAY` from `systemctl --user show-environment`. GNOME exports
     them there; RHEL 8's GNOME 3.32 must be verified.
  3. It takes `DBUS_SESSION_BUS_ADDRESS` from `/run/user/<uid>/bus`.
  4. Fallback: read `/proc/<pid>/environ` of the user's `gnome-shell`/`gnome-session`. Take **only** `DISPLAY`,
     `XAUTHORITY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE` and
     `XDG_CURRENT_DESKTOP`; that environ also holds things like `SSH_AUTH_SOCK`.
  5. pyatspi then finds the AT-SPI bus through the session bus.
  - **Wayland:** Ember's Linux input and capture are X11 (XTest/XGetImage through koffi, x11.ts). XTest reaches only
    Xwayland apps, and screenshots need a portal with a click on the remote screen. So under Wayland the remote is
    limited to tier 1 AT-SPI.
  - **A different user, or root, than the one at the console** cannot reach that desktop (cookie and bus belong to the
    other user). That is correct: never act across users.
- **Windows:** sshd's children run in Session 0, which has no interactive desktop, so UIA, SendInput and capture don't
  reach the user's desktop. Options:
  - **W1.** A per-user scheduled task the clone registers for the logged-in user (`/it`, "run only when the user is
    logged on"), started on demand with `schtasks /run`. It runs the GUI-side helper in the user's session. The
    ssh-side clone relays to it over a named pipe whose ACL holds only the user's SID, and a per-run secret. Note that
    `schtasks` is on the agent's never-start list (terminals.ts:189-190). This is installer code started by the user,
    and the agent's rule stays.
  - **W2.** A `HKCU\…\Run` logon helper that is always running. Bigger footprint.
  - **W3.** Not supported in v1.
  - All of them require the user to be logged in at the remote (console or RDP).
- **macOS:** ssh children are outside the Aqua session's TCC grants. Granting Accessibility to `sshd-keygen-wrapper`
  would give it to every ssh session, so not that. Options:
  - **M1.** A small helper app bundle started with `open -a` from the ssh session. LaunchServices starts it in the
    console user's session when the same user is logged in at the screen. It relays over a Unix socket in a 0700
    folder with a per-run secret.
    - TCC (Accessibility, Screen Recording) must be granted **by a person at the remote Mac**, once.
    - An ad hoc signature changes with every build and voids the grants. Developer ID signing is needed for grants
      that survive updates.
    - The official Node binary is signed by the Node.js project, so a grant to it would cover every script run with it.
      Not acceptable.
    - `open` is on the agent's never-start list (terminals.ts:192); used here by installer code only.
  - **M2.** Not supported in v1.
- **Headless server (no graphical session):** under today's rules (no terminals, no commands) there is nothing to act
  on. Ember says so ("build-01 has no desktop session: Ember can't act there") and doesn't install. This is the main
  product gap for SSH targets, most of which are headless. Working on the command line is the owner's decision (§13).

---

## 10. The channel

### 10.1 Why one ssh process with Ember's own multiplexing

- One `ssh -T` gives one session channel, a byte stream each way (plus stderr, kept for ssh's own diagnostics).
- More SSH channels on one connection need a ControlMaster, which Windows lacks (§0.6). Port forwarding needs a
  listener; `-L`/`-R` open local or remote sockets, and Ember wants none (agent-ui-split.md §9.1).
- So Ember frames several logical streams inside the one channel.

### 10.2 Framing

- **Preamble:** the remote writes `"\0EMBER-REMOTE/1 <id>\n"`. Local drops everything before it, up to 64 KiB, then
  times out. Local then sends `"\0EMBER-LOCAL/1 <id>\n"`.
- **Frame:** `u32 BE length` (of what follows) | `u8 stream` | `u8 type` | payload.
- **Types:** `DATA`, `CREDIT{u32}`, `PING{u64 t}`, `PONG{u64 t}`, `CLOSE`, `RESET{code}`.
- **Size caps** (an oversized frame is a protocol error: reset and close):
  - any frame ≤ 1 MiB;
  - stream 0 payload ≤ 64 KiB;
  - bulk chunks ≤ 32 KiB.
- **Streams:**
  - **0 ctl:** JSON messages from agent-ui-split.md (`hello/welcome`, `ask`, `stop/stopped`, `confirm.*`, `state`,
    `heartbeat`…). Never credit-limited. Strictly first.
  - **1 bulk:** images (screen frames, captures for a local brain in variant L). Credit-limited.
  - **2 runtime relay** (only hybrid H2, agent-ui-split.md §6): the remote SDK's `RuntimeConnection.forStdio({path:
    <relay>})` (types.d.ts:181-187) bytes, passed through to a runtime the local side starts with the token.
    Credit-limited.
  - **3 diagnostics:** remote log lines. Droppable.
- **JSON** on stream 0 is validated against zod schemas on both ends (zod is already a dependency). Unknown `kind` is
  dropped and logged. Text fields are length-capped and treated as untrusted (agent-ui-split.md §9.3).

### 10.3 Priority, backpressure and how long a Stop can wait

- Bytes Ember has written into ssh's stdin can sit in:
  - the pipe (64 KiB on Linux);
  - ssh's channel buffer, up to the remote window (about 2 MiB);
  - the TCP send buffer (autotuned to MBs).
  A Stop written after a burst of bulk waits for all of it.
- **Sender:**
  - one queue per stream, a strict priority scheduler (ctl > relay > bulk > diagnostics);
  - it writes to the pipe only while `stdin.write()` returns true or after `drain`;
  - it keeps at most a **high-water mark** of unacknowledged bulk in flight. That cap is enforced by **credits from the
    receiver**: bulk may only send what the other side granted, granted as it consumes, sized to about the
    bandwidth-delay product (measured from PING/PONG).
- With the window at about 50 ms of link time, a ctl frame waits at most that long behind bulk. The big bulk direction
  is remote → local (pictures), and the Stop travels local → remote. The ack (`stopped`) travels remote → local, so
  remote bulk credits must also be small.
- **Kill-switch path:**
  - Local KillSwitch parts finish within its 300 ms race (killswitch.ts:37) whatever the link does.
  - The `remote` part sends `stop` on stream 0 and resolves on `stopped`, or at the race's end.
  - **Escalation:** no `stopped` within max(1 s, 3 × RTT) → kill the local ssh process. TCP closes, sshd closes the
    channel, the remote sees EOF and stops (§9.2).
  - With the network dead: the remote's dead-man after 3-5 s, plus the freshness gate (§9.2).

### 10.4 Keepalive

| Layer | Setting | Detects | Then |
|---|---|---|---|
| TCP | `TCPKeepAlive yes` (default) | Dead peer, slowly | ssh exits |
| SSH | `ServerAliveInterval=15`, `ServerAliveCountMax=3` | A silent path in about 45 s | ssh exits 255 → local "Lost build-01" |
| Ember | `PING` every 1 s each way | A stalled clone or local within 3-5 s | Remote dead-man stops everything. Local treats open questions as "no" and shows the loss |

### 10.5 Reconnect

- On ssh exit: tasks on that target are marked stopped (the remote stopped them on EOF), open questions are answered
  "no", and the handle shows "Lost build-01".
- Reconnect only while the user still wants the connection: BatchMode, backoff 1, 2, 4… up to 30 s, and stop after
  about 10 minutes or a classified non-network error.
  - If authentication now needs a prompt, show a "Reconnect" button that runs §2.4.
- After reconnect there is a new clone process and a fresh handshake. State is re-pushed. No task resumes.
- Conversation: in variant R a new remote runtime starts fresh, because the old store was in `$XDG_RUNTIME_DIR` and was
  deleted at exit. In variant L the conversation is local and continues.
- **mosh** can't be used: it is UDP with no stdio channel for Ember.

### 10.6 Latency budget (per message, no bulk)

One RTT plus about 1 ms of framing. A tier 1 step in variant L costs 1-3 RTTs plus the tree or picture payload
(agent-ui-split.md §5.6). Pictures should be encoded on the remote at most 1280 px (capture.ts) and sent once per step.

---

## 11. Secrets

| Secret | Rule | How |
|---|---|---|
| GitHub token (only when the brain is remote) | Never on the remote's disk, argv or ssh env. Memory only. Per-host opt-in. Never a `gh`-CLI token or an env token: their scopes are unknown and usually broad. At most Ember's own device-flow token (scope `read:user`, auth.ts:120) | `auth{token}` frame on stream 0 after `welcome`. The clone passes it to `CopilotClient({gitHubToken})`, and the SDK puts it in the runtime child's env as `COPILOT_SDK_AUTH_TOKEN` with only the variable's name on argv (client.js:2261-2262, :2308-2309). Not via `SendEnv` (needs `AcceptEnv`, leaks into the shell's env) or the command line (§9.1) |
| … exposure that remains | Same uid and root can read `/proc/<pid>/environ` and memory. Ptrace is allowed by default on RHEL (`ptrace_scope` 0). Swap may hold pages | State this in the opt-in. A spike on `gitHubTokenProvider` (types.d.ts:2520) might keep the token out of the runtime's env (it would still be in memory). The variant H2 relay keeps it entirely local |
| Copilot conversation store (variant R) | Not on persistent remote disk | `baseDirectory` (host.ts:688) → `$XDG_RUNTIME_DIR/ember-remote/copilot-<rand>` (tmpfs), deleted at exit. Leftovers are swept at the next start, like the task-session sweep (host.ts:760, :1052) |
| BYOK provider key (admin.ts:152-155) | Never forwarded by default | A remote brain under a local BYOK provider is unavailable unless the remote admin configures its own provider (agent-ui-split.md §4.6) |
| SSH credentials | Ember never reads private keys. A typed password, passphrase or OTP goes only from Ember's prompt window to ssh's askpass stdout | §2.4 P-B. Never logged, stored, sent to the model or audited as text |
| Host keys | Ember never weakens host checking | `StrictHostKeyChecking=yes` in BatchMode; a changed key is refused (§2.3) |
| User requests, screen text | Never on any argv, remote or local | Only inside frames |
| Logs | The remote clone logs no frame payloads. Local logs only kinds and sizes | Same logger levels as today |
| Debug entry points | No inspector on the remote | Option N: `--disable-sigusr1`, refuse `NODE_OPTIONS`. Option E: fuses (fuses.mjs:38-42) |

---

## 12. Admin policy, remote and local

- **The remote's policy binds actions on the remote.** The clone loads it with the same code:
  - Linux `/etc/ember/policy.json` with the root-owner and mode check (admin.ts:105-121);
  - macOS `/Library/Application Support/Ember/policy.json` (darwin/system/admin-policy.ts:15-17);
  - Windows `HKLM\SOFTWARE\Policies\Ember` (win32/system/admin-policy.ts:17-19).
  - A broken file means LOCKDOWN (admin.ts:72-81), so the remote refuses actions.
  - The clone sends its constraints in `welcome`, and local composes them (agent-ui-split.md §4.6): AND of features, OR
    of confirm-every-action, union of never-look, minimum of rate limits.
  - In variant L the local brain must enforce the remote's policy for remote actions. In variant R the remote enforces
    it, and local shows it.
- **How strong that is:**
  - A clone installed in the user's own home can be edited by that user, so the policy binds an honest user, not a
    hostile one. The same is true of any user-space Ember (AppImage).
  - A remote admin who needs enforcement uses B5 (`/opt/ember-remote`, root-owned) plus OS controls: noexec home,
    SELinux user types, sshd `ForceCommand`/`Match`.
  - A new optional key such as `remote.allowUserInstall: false` would make the clone refuse to run from a home install.
    It is advisory against a hostile user and says so.
- **The local policy decides whether Ember may go remote at all.** Proposed keys:
  - `features.remote` (false: no remote connections);
  - `remote.allowedHosts` (globs);
  - `remote.forwardToken` (default false).
  - `AdminPolicySchema` is `.strict()` (admin.ts:59), so an older Ember reading a newer file locks down. That fails
    closed, but release notes and a schema version bump are needed.
- **Audit:** local writes `{event:"remote", host, step: connect|install|serve|stop|disconnect, id}`. The remote keeps
  its own `audit/` of every action executed there.

---

## 13. How this meets the hard safety rules

| Rule | Effect here |
|---|---|
| Never opens or acts in terminals; never runs programs or shell commands | The **agent** still can't. `ssh` stays in REFUSED (terminals.ts:186/189/192). Ember's **own** connect code runs a fixed `ssh` argv, a fixed probe and a fixed install script after a user click. That is the same class as Ember running `gh auth token` (auth.ts:78-85), the Python sidecar or PowerShell for UIA. The clone exposes a closed set of typed operations, never exec/eval/spawn-by-name (agent-process.ts:215-219 template). Command-line work on the remote (most SSH targets) would be a **rule change** with its own tool and policy, not a passthrough |
| Goals only from the user; screen text untrusted | No model tool connects, picks hosts, installs or answers prompts. Remote banners and motd are untrusted text |
| Never types into password fields; never acts in authentication windows | SSH prompts are Ember's own window, answered by the user. The model never sees them. On the remote, the remote's auth-window rules apply as today |
| Risky actions confirmed by a click every time | Confirmations come back only from the local Confirmer (agent-ui-split.md §4.4). Installing on a host is itself a click ("Install Ember on build-01: about 40 MB into ~/.local/share/ember-remote") |
| Admin policy can only tighten | §12; a new `features.remote` and `remote.*` |
| Consent gate before anything is read, heard or sent | Per-host consent on first connect ("Ember will read and act on build-01's desktop; your voice stays on this PC; only text is sent"). Audio never leaves the PC (local wake and ASR, text over the channel) |

---

## 14. Proposed code layout (if built)

| File | What | Imports electron? |
|---|---|---|
| `app/main/remote/ssh.ts` | Pure: client path per OS, argv builder (§2.2), destination validator, `ssh -G` parser, stderr classifier (§2.3), version parse | no |
| `app/main/remote/askpass.ts` + build entry `dist/app/askpass.cjs` | P-B helper client and Ember-side server (socket/pipe, nonce) | no (the window is shown by main) |
| `app/main/remote/mux.ts` | Framing, streams, priority, credits, PING/PONG, preamble (§10). Shared by both ends | no |
| `app/main/remote/probe.sh`, `install.sh` | Fixed POSIX scripts (esbuild text loader) | – |
| `app/main/remote/installer.ts` | Probe → plan (target, missing blobs) → upload → verify → serve | no |
| `app/main/remote/connection.ts` | Owns the ssh child, reconnect, kill-switch escalation, "Lost host" | no |
| `app/remote/main.ts` → `dist/app/ember-remote.cjs` | The clone: env hygiene, lock, watchdog, session discovery (§9.4), mux server, then variant R (AgentHost with RemoteConfirmer) or L (reach process) per agent-ui-split.md | **never** |
| `scripts/build-app.mjs` | +2 entries (`ember-remote.cjs`, `askpass.cjs`) | – |
| `scripts/package/remote-bundle.mjs` (+ `.d.mts`) | Per-target assembly from the lockfile (npm pack + integrity), pinned Node (SHA-256), prune, notices, manifest, tar.gz/xz | – |
| `scripts/package/layout.mjs` | `REMOTE_TARGETS` (`linux-x64-gnu`, `linux-arm64-gnu`, later `linux-x64-musl`, `win32-*`, `darwin-*`) and `remoteLayoutFor()` | – |
| `app/main/agent/runtime.ts` | `runtimeFor(os, arch, libc)` for remote targets | – |
| `app/main/admin.ts` | `features.remote`, `remote.{allowedHosts, forwardToken, allowUserInstall}` | – |
| Tests | unit: argv, validator, classifier, `-G` parse, mux (credits, priority, caps, preamble noise), manifest/verify plan. Integration on CI Linux: a throwaway `sshd -D -f <cfg>` on 127.0.0.1 with a test key; probe, install, serve, EOF → stop, dead-man, kill-switch escalation, delta update. Windows/macOS runners: client side against a Linux sshd in a service container where the runner supports it | – |

---

## 15. Owner choices (not decided here)

| # | Choice | Options | Costs / risks |
|---|---|---|---|
| C1 | Where the brain runs | R remote (token forwarded in memory, runtime +38-56 MB compressed, remote egress); L local (big refactor of sync paths, agent-ui-split.md §5); H2 runtime local through a relay on stream 2 | R: token exposure to remote root and same uid. L: latency per step. H2: unknowns in how the SDK passes paths and the token |
| C2 | Remote JS runtime | N official Node; E Electron as Node; S system node as an optional fast path | N: smallest, needs `--disable-sigusr1` hygiene. E: fuses and same binary, needs GUI libraries, 2.5× size |
| C3 | Where bundles come from | B1 CI download; B2 inside installers; B3 derive from local install (same OS/CPU); B4 remote downloads; B5 admin RPM | B1 needs a release pipeline. B2 bloats installers. B4 needs remote egress |
| C4 | Prompts | P-A BatchMode only; P-B Ember askpass | P-A excludes password/OTP hosts. P-B is more code, and Windows support is unknown |
| C5 | Connect trigger | D1 explicit; D2 notice the user's ssh; D3 config hook | D2 reads process argv |
| C6 | Remote targets in order | linux-x64 glibc X11 → linux-arm64 → Windows (W1) → macOS (M1, needs Developer ID) | Windows and macOS need GUI-session helpers |
| C7 | After disconnect | G0 exit; G1 60 s conversation grace | G1 adds a re-attach socket |
| C8 | Version policy | U1 exact id; U2 proto range | U1 means more uploads, mitigated by blobs |
| C9 | Command-line work on remotes and in WSL | Keep refused; or a new, separately policed tool | A rule change; out of scope for transport |

---

## 16. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Most SSH targets are headless, so there is nothing to act on under the no-commands rule | Probe says so before install. The owner decides on CLI work (C9) |
| 2 | Token on shared servers | Brain local by default. Per-host opt-in. Never `gh`/env tokens. H2 spike |
| 3 | A Stop queued behind bulk on a slow link | Credits plus a priority scheduler (§10.3); escalation kills ssh; dead-man and freshness gate |
| 4 | Clone outliving the link | No nohup; EOF means stop; watchdog; process-group kill |
| 5 | Option injection through the host string | Validator; `--`; port as an integer |
| 6 | Weak host checking in the user's config | `ssh -G` check; `StrictHostKeyChecking=yes`; changed keys refused |
| 7 | Win32-OpenSSH gaps (no ControlMaster, askpass unknown, binary stdin) | One process per connection; P-A fallback; spikes |
| 8 | GUI-session access per OS (Wayland, Session 0, TCC) | §9.4 options; v1 may be Linux X11 only |
| 9 | glibc < 2.28 remotes (CentOS 7, Ubuntu 18.04) | Refused by the probe with a clear message |
| 10 | arm64 remotes | SDK, Node, sharp and koffi all publish linux-arm64; `runtimeFor` must learn it |
| 11 | User-space install not tamper-proof against its user, so the remote admin policy is advisory against a hostile user | B5 system install plus OS controls; say so |
| 12 | `.strict()` admin schema plus new keys | Older Embers lock down on newer policies (fail closed). Document it |
| 13 | Shell noise or odd login shells corrupting the stream | Preamble sync; relative fixed paths; `sh -s` |
| 14 | Leftover files on remotes | Fixed layout, README, uninstall command, GC under lock |
| 15 | Upload size over slow links | xz; blobs/deltas; B4 option |

## 17. Spikes before building

1. `copilot-runtime --stdio`: does it exit on stdin EOF? Its RSS on a remote?
2. `gitHubTokenProvider` without a client-level `gitHubToken`: do `getAuthStatus`/`listModels` (host.ts:700, :734) still
   work?
3. H2: a remote SDK client to a relay `path` to the local runtime; how `baseDirectory`/`workingDirectory` resolve.
4. Win32-OpenSSH: `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`; binary-clean stdin/stdout with `-T` to Linux and to Windows
   sshd; PowerShell DefaultShell and relative paths.
5. RHEL 8 GNOME 3.32: does `systemctl --user show-environment` carry `DISPLAY`/`XAUTHORITY`? AT-SPI from an ssh-started
   clone on the user's bus.
6. Measure: bundle sizes for linux-arm64 and win/mac; full re-hash time on a slow remote disk; framing overhead and Stop
   latency at 50/200/600 ms RTT with bulk streaming.
7. Windows W1: a per-user scheduled task started from an ssh session, and the named-pipe ACL.
8. macOS M1: `open -a` from ssh into the console session; TCC prompts; signing needs.
