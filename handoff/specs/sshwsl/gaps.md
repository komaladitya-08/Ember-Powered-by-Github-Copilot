# SSH / WSL specs: gaps and contradictions (completeness critic)

Read: `sshwsl/decisions.md` (binding), `agent-ui-split.md` (AUS), `remote-desktop.md` (RD), `install-transport.md` (IT),
`wsl.md` (WSL), `safety-remote.md` (SR), `sshwsl/pkg-common.md`. Code checked on `ember-improve/20261022-windows-macos`
at HEAD `f03e97a`. The specs cite `38cdddb`; the lines I re-checked still match. `file:line` refers to the code unless it
is prefixed with a spec name and §.

Every item below has a label (G = gap, X = contradiction) and a proposed resolution. Items marked **BLOCKER** have to be
resolved in the binding `sshwsl/design.md` before packages start. That file doesn't exist yet, although
`sshwsl/pkg-common.md:13` tells packages to read it.

---

## 0. The blockers, in short

1. **X1. Stale baselines.** AUS (§0.4, §4.2 "R-A recommended first", §10 #1), IT (§0.9, §4.2, §11, §15 C1, all of which
   size and secure a *remote brain*), RD (§0.4, §6) and IT §9.4 (headless means "nothing, don't install") were all
   written before `decisions.md`. The decisions are: brain LOCAL, commands allowed in WSL and SSH shells, and headless
   servers usable with commands only. Only SR is written against the decisions. An implementer who follows AUS builds
   the wrong variant.
2. **X2. There is no agreed RPC for the binding variant (L).** AUS §5.3 sends raw sidecar methods (`ax.<method>`,
   `hand.op {bid, op, args}`) and lets `perceive.read` be "composed locally from `ax.*`". SR §3.10 sends a coarse,
   closed op set (`act(kind, element, value, expect, approval, epoch)`) checked by a remote gate 2. Raw passthrough
   can't carry what gate 2 needs (SR §3.3 needs the ActionRequest, `expect`, `approval` and `epoch`). Composing reads
   locally also breaks "privacy filters at the source" (SR §0.6). §3 below lists every message that is missing.
3. **X3. Listening endpoints.** SR §3.10 says the clone opens "no listening TCP port, no Unix socket, no named pipe". RD
   §2.3 option B and §8.1 (`$XDG_RUNTIME_DIR/ember-remote/agent.sock`), RD §4.3 W1 (`\\.\pipe\ember-remote-<SID>`) and
   IT §9.4 (a W1 named pipe, an M1 Unix socket) all need one. On Windows and macOS an SSH child cannot reach the
   desktop at all (RD §4.1, §5.1), so under SR's rule remote-desktop support on those OSes is impossible. Decisions
   line 32 forbids only a *network port*.
4. **X4. Persistence.** SR §3.8.6 says "No nohup, daemon or setsid for the clone, ever". IT §5 (lines 333-335) says no
   autostart on Linux. RD §2.3 makes option B (XDG autostart, long-running) the **preferred** Linux mode. RD W1 and
   macOS M2 are always-running logon agents. The GUI-session helper's lifecycle has no spec: what it may do when no
   SSH session is attached, and how its own dead-man works.
5. **G1. Target selection and routing are unspecified.** `start_task` takes only `{goal}` (conductor.ts:116-120).
   `describe_screen` and `show_me` take nothing (conductor.ts:111, 121). The conductor persona says Ember "doesn't act in
   terminals" (persona.ts:32). Quick context reads the *local* focused window (main.ts:681-689), which during SSH is
   the user's own terminal. Nothing says how a voice request is bound to `local`, `wsl:<distro>` or `ssh:<alias>`, how
   the conductor learns which targets exist, or how the handle shows the active target (SR C9 only states the rule).
6. **G2. The type seam isn't costed.** `Hands.sidecar`, `WorkerDeps.sidecar`, `DeskPlace.sidecar` and
   `PerceptionOptions.sidecar` are typed as the concrete class `AtspiSidecar` (host.ts:37, worker.ts:80, place.ts:23,
   perception/index.ts:25). That class has private members (sidecar.ts:234-250), and `Perception` uses
   `constructor(private o)` (index.ts:105). In TypeScript a class with private members can't be satisfied
   structurally, so neither WSL's `RoutedSidecar` (WSL §6.2 R1) nor a remote proxy compiles until `SidecarPort` and
   `PerceptionPort` interfaces are extracted. `DeskPlace` also exposes synchronous `input: XInput` and `x11: X11`
   (place.ts:24-25), so a "RemotePlace like DeskPlace" (AUS §7.9) can't implement it.
7. **G3. No spec covers the command runner's PTY under the "no new native dependency" rule** (`sshwsl/pkg-common.md:35`):
   - SR §5.4 needs termios ECHO detection, and SR §5.5 recommends X1 (an xterm.js view with a PTY).
   - The SSH clone is Node, and Node can't fork. node-pty is native.
   - The WSL runner is Python (WSL §12.3), which some distros lack.
   - On macOS, calling `python3` without the Command Line Tools pops an install dialog on the remote screen.
   - BSD and util-linux `script` take different flags.
   - Needs a per-OS decision, or X3 (no PTY, sudo refused) for v1.
8. **G4. Approving long commands.**
   - `BubbleState` has no monospace or code field (shared/overlay.ts:42-54).
   - The question prompt is spoken in full (main.ts:641).
   - When the user is away it is put into an OS notification (main.ts:643). On Windows, notification history persists
     on disk (wpndatabase.db).
   - Ctrl+Alt+Y can approve a command whose full text was never visible on screen.

---

## 1. Contradictions between specs

| # | Topic | Says A | Says B | Resolution |
|---|---|---|---|---|
| X1 | Brain placement | AUS §0.4, §4.2, §10 #1: R-A first; IT sizes R (§4.2 table, §11 token row) | decisions.md 3: brain local, nothing Copilot on the remote | Mark AUS §4/§6 and IT §4 (R rows), §11 (token rows), §15 C1 and §17.1-3 as superseded. Drop `remote.forwardToken` (IT §12). A key that implies token forwarding shouldn't exist |
| X2 | Wire shape for L | AUS §5.3: `ax.*` raw, `hand.op`, `perceive.read` "or composed locally" | SR §3.10: closed coarse ops plus gate 2; SR §0.6: filters at source; RD §3.2: "no finer than the tool level" | Coarse ops (SR) as the contract: `read_window`/`perceive` return a filtered `Seen` (the structured part, perception/index.ts:66-82), and local renders the `<screen untrusted>` text (elements.ts:362-426). Mutations are `act{ActionRequest-lite, expect, approval, epoch, opId}`. Raw `ax.*` is never on the wire |
| X3 | Endpoints | SR §3.10: no socket or pipe | RD §2.3B/§8.1, RD §4.3 W1, IT §9.4 W1/M1 | Allow **one** local IPC endpoint per GUI helper: a Unix socket in a 0700 dir with an `SO_PEERCRED`/`getpeereid` uid check, or a named pipe with a user-SID-only DACL plus `PIPE_REJECT_REMOTE_CLIENTS` plus a client token/session check. Add a per-attach secret handed over through the SSH channel. Never TCP. Amend SR §3.10 and decisions' wording |
| X4 | Persistence and autostart | SR §3.8.6 and IT §9.2: never outlive the link; IT §5: no Linux autostart | RD §2.3 B preferred; RD W1 HKCU Run; RD M2 LaunchAgent | Define the "idle relay" state: with no attached SSH session the helper holds no task, no element ids and no conversation, and acts on nothing. On detach it runs its KillSwitch. Opt-in per machine, from a click on the local PC, recorded on the remote |
| X5 | Windows GUI helper | IT §9.4: W1 = on-demand scheduled task (`schtasks /run`) | RD §4.3: W1 = HKCU Run logon agent; scheduled task = W2, EDR-risky, owner decision | Use one naming. RD's ranking stands (no scheduled tasks by default). Note that `schtasks` is in `REFUSED.win32` (terminals.ts:189-190) |
| X6 | macOS clone identity | IT §4.2: official Node, "Developer ID signed by the Node.js project"; IT §9.4 M1: "small helper app" | RD §3.1/§5.4: it must be the signed **Ember.app** (capture needs `desktopCapturer`; TCC identity) | The macOS remote needs an Ember-signed `.app`: about 250 MB, notarised, with grants made at the Mac. IT's sizes (§4.2) leave this out. Decide whether the macOS remote is desktop-capable in v1 at all |
| X7 | Wayland remotes | RD P4 (§1): refuse Wayland | IT §9.4: Wayland gets tier-1 AT-SPI only | Pick one. RHEL 8's *default* GDM session is Wayland. The nightly VM uses "GNOME on Xorg" explicitly (environment.ts:144-148 already fails Wayland locally). Under P4, most current desktops are commands-only |
| X8 | Headless | RD §0.4, §6, §8.4 and IT §9.4: "does nothing / doesn't install" | decisions 2: headless works, commands only | A commands-only install profile (§5 G12) and a probe that offers it |
| X9 | Dead-man timing | RD S10: "about 1 s" | AUS §4.5: 3-5 s; IT §9.2: 3-5 s; SR §3.8.6: 3 s; freshness 1.5 s with PING 1 s | One number (3 s) plus freshness 1.5 s. Note the 0.5 s jitter margin, and that a local main-thread stall over 3 s (the desk's `Atomics.wait` can block up to 5 s, AUS §5.2) stops remote tasks spuriously. Send pings from a worker thread, or accept that |
| X10 | Remote paste | AUS §5.3: `clipboard.paste{bid,text}` | RD §3.1: the paste clipboard needs Electron (agent/clipboard.ts:39-45, main.ts:1362), so the remote types key by key; SR §3.4: "remote pastes use the remote's clipboard through the clone" | Either no paste on remotes (types key by key; set `WorkerDeps.clipboard` undefined) or a koffi X-selection/Win32 clipboard owner. Decide |
| X11 | `WSLENV` | WSL §4.1: set to exactly `EMBER_ATSPI_ID_BASE/u:PYTHONUNBUFFERED/u:PYTHONIOENCODING/u` | SR §3.10: "`WSLENV` is cleared for `wsl.exe`" | Clearing it breaks WSL R1's id-block routing (`EMBER_ATSPI_ID_BASE` must cross). Rule: *replace* the user's `WSLENV` with exactly Ember's list, never inherit it |
| X12 | Audit of command text | WSL §12.3: program names and class only, not full arguments | SR §5.4: full `command` in the 0600 file on both machines | Decide. Full text helps an admin but puts any secret the model wrote into argv on two disks (the never list catches only known shapes). Suggestion: full text in the 0600 file with secret-shape redaction, `commandChars` in the journal (SR) |
| X13 | Cross-machine tasks | SR §3.2 C9: refused in v1 | WSL §6.2 R1: one perception spanning Windows and WSLg windows, `switch_window` across them | WSLg windows are on the local screen. Bind tasks to a *screen* (local, which includes WSLg), not to a `machine`. Keep `machine: wsl:<distro>` for grants, audit and carry checks, so a carry from Notepad to gedit is asked about through `elsewhere()` |
| X14 | Admin keys | AUS §4.6: `features.remote`; IT §12: `features.remote`, `remote.{allowedHosts, forwardToken, allowUserInstall}`; WSL §11.10/§12.3: `features.wsl`, `features.wslCommands` | SR §3.6: `features.{remote,wsl,commands}`, `remote.{allowedHosts,desktop,allowClone,requireConsoleConsent,allowFrom}`, `commands.{targets,deny,allowOnly,maxPerTask,wslInterop}` | One schema. Defaults are undecided (decisions line 31 punts). Recommendation: an absent key means the feature is available but the user's setting is off. `.strict()` (admin.ts:59) locks older builds down: ship the schema first |
| X15 | Noticing the user's ssh | IT §2.6 D2: read local ssh process argv | WSL §3.1: "Ember doesn't read other processes' command lines" | The owner said "when I SSH into a system, Ember installs its clone", which implies D2. SR and IT say only a click starts a connection. Resolution: D2 *offers* ("Bring Ember to build-01?"), consent-gated, and a click starts it. Say so to the owner |
| X16 | Remote tier 0 and app list | AUS §5.3: `app.list/launch`, `setting.change`, `window.find/active` | SR §3.10 op set: `launch(appId)` only; no settings, no app list | Add `apps.list` and `setting.change` (gate 2: refuse on headless, RD §6) or declare tier 0 settings local-only |
| X17 | "Visible terminal" | decisions line 28: "runs in a visible terminal the user can watch and stop" | WSL §12.2 C3/C4 and SR X3: output in a card, no terminal | Decide whether a card counts. If not, X1 is mandatory and G3 is a blocker |
| X18 | Runner uses refused programs | SR §5.3: transient `systemd-run --user --scope`; SR §5.6 W2: bwrap/`unshare -m` | `REFUSED.linux` has `systemd-run`, `unshare`, `nsenter` (terminals.ts:186), and SR's classifier reuses REFUSED | Allowed only as fixed argv in the runner (the class of `gh auth token`). State the exception, and keep them refused inside user commands |
| X19 | Uninstall leftovers | IT §8: `rm -rf ~/.local/share/ember-remote ~/.local/state/ember-remote` | SR §3.9 R3: consent record in `~/.config/ember-remote/consent.json`; SR §3.7: the remote audit is kept at uninstall | Align the layout. The consent file must sit in the state dir, or uninstall must name it. The audit-keeping rule must be reflected in the uninstall command |

---

## 2. What the decisions change in the specs that predate them (needs rewriting, not just noting)

- **Voice wording for the owner's report.** With the brain local, the request text doesn't go to the remote either.
  Only approved *steps* (element ids, values to type, commands) cross. Decisions lines 25-26 say "honoured as the
  *request* going there". The report should say "your request is understood on this PC; only approved steps go to
  build-01".
- **IT §0.9, §4.2.** The L bundle needs sharp (masking and set-of-marks on the remote, capture.ts) and koffi. Commands-only
  needs neither (§5 G12).
- **IT §16 #1, §15 C9 and RD Q6** are answered by the decisions: commands are in scope, and headless servers are usable.
- **AUS §8 and WSL §0.8/§12.1** treat commands as a rule change still to be decided. The decision has been made: WSL
  shells only, under the new command capability.

---

## 3. Messages missing from the RPC boundary (L: local brain ⇄ remote clone/runner) that a safety rule needs

AUS §5.3 is the only L message table, and it lacks all of these. SR names most of them as behaviour but never as
messages. (Direction: L→R = local to remote.)

| Message | Dir | Needed by | Notes |
|---|---|---|---|
| `hello.consent {version, perHost:{at, resolvedDest}}` | L→R | consent gate (decisions line 34; SR §3.9) | AUS R's hello had it; the L hello doesn't. The clone must refuse reads without it |
| `hello.policy {neverLook (combined), userNeverLook, localAdmin}` and **`settings.sync {neverLook}`** mid-session | L→R | SR §3.5 (filters at source) | The L table has neither. A never-look entry added during a session must reach gate 2 and the source filters at once |
| `welcome {os, machineId, isWsl, interopReachable, uid, isRoot, desktop: {state, type, locked}, remoteAdmin, proto, caps}` | R→L | SR §3.10 (never the same machine), SR §5.6 (interop), RD P1-P6 | `machineId` and `isWsl` appear only in SR prose. **Same-machine and WSL detection must also run in the probe, before install** (G9) |
| `act {opId, epoch, request (kind, element, window, app, value-hash), expect, approval}` → `ok/deny/needs_confirm/changed/stale/stopped` | L→R / R→L | SR C2, C4, C5 (gate 2, epoch fencing) | Replaces AUS `hand.op` and `ax.*` mutations |
| `desktop.state {locked, active, sessionGone}` (event) | R→L | RD P2/P3/S3 ("a screen that locks during a task stops it") | The L table has only `dead{why}` |
| `notice.state {shown \| failed, reason}` | R→L | SR §3.9 R2 ("if the notice can't be shown, no reading and no acting") | Local must know, so it can refuse and explain |
| `console.consent.request` / `console.consent.result` | L→R / R→L | SR §3.9 R3(b) | Not in any table |
| `stop {source: "remote-console"}` | R→L | SR §3.8.8 | The L table lists `stopped` only. `StopSource` needs `"remote-console" \| "remote-lost"` (killswitch.ts:17) |
| `command.run {runId, epoch, approval, target, cwd, argvOrScript, cols, rows, timeoutMs}` | L→R | decisions lines 27-31; SR §5.3-5.4 | Not in AUS, and not in IT §10.2's stream list |
| `command.input {runId, bytes}` | L→R | SR §5.5 X1 (the user types sudo passwords and y/n) | **Origin rule:** accepted locally only from the command-view window's `webContents` (like `askWindow.owns`, main.ts:962-969). Never from a worker or the model. Never logged, regardless of echo state |
| `command.output {runId, bytes}` | R→L | SR §5.4 (output untrusted; local redaction and wrapping) | Must ride a **credit-limited** stream (IT §10.2 stream 1 or a new stream). On ctl, `yes`/`find /` would starve Stop (IT §10.3) |
| `command.echo {runId, off}` | R→L | SR §5.4 (echo-off spans withheld) | — |
| `command.exit {runId, code, signal, ms, outBytes, secretSpans}` and `command.stop {runId}` (per-card) | both | SR §5.4 (kill ladder, audit) | The per-card Stop (main.ts:994-995) needs a run-level stop, separate from the global `stop` |
| `command.resize {runId, cols, rows}` | L→R | X1 view | — |
| `view.start/stop {fps, maxWidth}` + frames on bulk | L→R / R→L | RD S1/S9, SR §3.8 (tier 3 only while the masked view is open) | The L table has only `perceive.capture` (for the model). Also undecided: does a remote `features.screenImages: false` also forbid the user-facing view? |
| `audit.query {limit}` → `audit.result` | L→R | RD S12, SR §3.7 (timeline per machine) | It exists in AUS R (`query`), not in L |
| `policy.changed` (event) | R→L | SR §3.6 (the remote policy binds) | The clone re-reads its policy. Local must re-compose |
| WSL: the in-distro runner's protocol | — | WSL §12.3 says `{run, stop, status}` over stdio; SR §5.3 says "same framing" (IT mux) | Pick one. The Python runner shouldn't need IT's binary mux. Reuse the `command.*` message bodies |

Also: **ctl's 64 KiB cap** (IT §10.2) is smaller than an ordinary read. `MAX_NODES = 400` (ember_atspi.py:46) with
names, text and bounds comes to roughly 60-120 KB. Reads must be chunked, or go on a data stream that has credits and
is never ahead of Stop.

---

## 4. Install and transport steps that put a secret on disk or let one leak

1. **The probe prints `systemctl --user show-environment` wholesale** (IT §3 table, line 241). Users often run
   `import-environment` with everything, which brings tokens, `AWS_*` and `SSH_AUTH_SOCK` into that output. It reaches
   the local process, and the local log on a failure or details view. Filter **on the remote**, inside the fixed probe:
   print only `DISPLAY|WAYLAND_DISPLAY|XAUTHORITY`. IT §9.4 step 4 and RD §2.4 step 4 already allow-list for
   `/proc/<pid>/environ`. The probe needs the same rule.
2. **Command text in two audit files** (SR §5.4), on the local and the remote disk (X12). A refused command is audited
   too, so a secret the model put in argv lands on disk exactly when it is refused. Redact before writing, and audit
   refused commands with the class and reason only.
3. **The question goes into an OS notification** (main.ts:643). For commands, Windows keeps notification history on
   disk. Use a fixed body ("Ember wants to run a command on build-01").
4. **ControlMaster socket** (IT §2.5): `<userData>/ssh/cm-%C` lets any same-uid local process open sessions on the
   remote with no prompt for up to 120 s after a crash. That bypasses "every command confirmed". Same-uid is already
   trusted locally (it could use ssh-agent too), so state it rather than fix it, and prefer `ControlPersist=no` once
   serve has exited.
5. **Askpass nonce** (IT §2.4 P-B) sits in the environment of the `ssh` child, which a same-uid process can read
   through `/proc/<pid>/environ`. A racer could then receive the typed password. Same-uid trust again. Bind the
   helper's socket to the `ssh` child's pid (peer pid → parent pid check) as well.
6. **NFS home directories** (common on enterprise and HPC servers). The install (`~/.local/share/ember-remote`), the
   audit (`~/.local/state/...`) and the consent record are shared across every host that mounts the home. The lock in
   `$XDG_RUNTIME_DIR` is per host, so host A's garbage collection (IT §8, "under the single-instance lock") deletes a
   version host B is running, and audits interleave. The probe must detect a network filesystem (`stat -f -c %T`) and
   key `versions/` GC and the audit by `machine-id`.
7. **The remote's own environment leaks into commands.** SR §5.3's fresh `bash --noprofile --norc` doesn't say which
   env it gets. The clone's env holds `SSH_CONNECTION` and similar; `cleanEnv` (compose.ts:44, 56-69) doesn't strip
   `SSH_*`, though `appEnv`'s NEVER does (system.ts:456). Specify `appEnv`-style rules for the runner (WSL §12.3 does;
   SR doesn't). Also say that this strips the remote user's own `GITHUB_TOKEN`, so `git push` behaves differently than
   in their shell.
8. Not secret-bearing, checked and fine: the install (IT §5-7) writes no token in L, and the fixed serve argv (IT §9.1)
   carries no user content.

---

## 5. False or unverified platform assumptions, and things no spec covers

### SSH sessions on Windows and macOS (and their consequences for SR)
- **G5.** SR §3.8 ("borrow takeover watch runs in the clone against the remote's input devices"), SR §3.9 R2 (the
  notice with a Stop button) and RD S2 (the remote Stop key grab) all assume the clone is in the GUI session.
  - Windows: only the W1 helper is (session 0 has no input or hooks, RD §4.1).
  - macOS: also needs Input Monitoring granted at the Mac.
  - Linux option A: a plain Node clone has **no window toolkit**, so no notice with a Stop button. A desktop
    notification expires, and `gdbus`/`notify-send` are refused programs (terminals.ts:186).
  - Nobody designs the notice. Options: Python GTK through gi in the sidecar's interpreter; full Ember on the remote;
    or treat R2 as unmeetable, which leaves commands only.
  - The gate-2 `isEmberWindow` rule for the notice (SR §3.5) also fails, because a notification belongs to
    gnome-shell, not to the clone's pid.
- **G6. Windows remote, v1 reality.** Commands on Windows remotes are out of scope (SR §5.7: non-POSIX refused). The
  desktop needs a W1 helper set up beforehand plus a re-logon. So on day one a Windows remote does **nothing**. The
  owner should hear that. An admin's SSH token is elevated (RD P6), so when PowerShell commands come later, every one
  is "privileged".
- **G7. macOS remote.** RD M1 (`open -a` from SSH) is unverified. When it fails, the error usually shows only in
  LaunchServices logs. TCC grants have to be made at the Mac. Commands lack Full Disk Access unless the "remote users"
  toggle is on. G3 covers the missing Python.
- **G8. Root logins** (`ssh root@server`, very common on servers). RD §2.4 step 1 refuses uid 0 for the desktop. No
  spec decides commands as root. Options: refuse; or allow with every command in the "runs as root" risky class.
- **G9. Same machine.**
  - SR §3.10 checks `machineId` in `welcome`, which comes *after* the install. On `ssh localhost`, Ember would already
    have installed into the local home. Check in the probe (read `/etc/machine-id` or the equivalent; resolve the
    destination before connecting).
  - **SSH into the user's own WSL** (the WSL2 VM address, or mirrored networking): not loopback, different machine-id.
    It becomes an "SSH target" judged without WSL's interop rules, with a distro `/etc/ember/policy.json` that SR §4
    says is no admin boundary. The clone must detect WSL (`/proc/sys/fs/binfmt_misc/WSLInterop`, `WSL_INTEROP`,
    `microsoft` in `/proc/version`). Local must refuse its own WSL by ssh, or route it as `wsl:`. Any WSL remote (on
    another PC) needs the interop classes too.
  - Containers or VMs with the local home bind-mounted: residual, state it.
- **G10. Kill-switch reach is overstated** (SR §1.3 T8 "closed by design"):
  - Programs that daemonise themselves (`docker run -d`, `podman run -d`, `pg_ctl start`, `redis-server --daemonize`,
    `pm2 start`) escape the process group. A systemd scope catches double-forks but not container daemons. macOS and
    non-systemd hosts have no scope.
  - WSL interop processes (`notepad.exe`) are Windows processes, outside the Linux pgid. Consider a Job Object
    (`KILL_ON_JOB_CLOSE`) around Ember's `wsl.exe` (verify that it contains interop children).
  - Reword T8 and add those programs to the risky or never classes.
- **G11. WSL distros that aren't the user's.**
  - The Lxss `DefaultUid` can be 0 (imported or Docker distros), so commands and the sidecar run as root even though WSL
    §4.1 never passes `-u`.
  - `docker-desktop` and `docker-desktop-data` appear in Lxss and must never be targets.
  - WSL1 distros can run commands but not WSLg.
  - WSL §2.3 `WslDistro` needs `defaultUid`, and a refusal rule.

### Engineering seams nobody costed
- **G12. Commands-only install profile.** Node plus `ember-remote.cjs` plus the runner, without sharp, koffi or the
  sidecar (an estimated 30 MB xz). Glibc floor 2.28 (IT §0.2) still refuses CentOS 7. The probe needs a "no desktop →
  offer commands-only" branch (today it refuses: IT §9.4, RD §6).
- **G13. Per-target AgentHost shape.** `Hands` is per AgentHost (host.ts:768-812). `WorkerSystem` (worker.ts:46-54),
  the personas (persona.ts:15, 32; worker-persona.ts:14, "without moving the user's mouse"), `TERMINAL_REQUEST[this.sys.os]`
  (host.ts:880) and the PolicyEngine (main.ts:1336-1344) are built for the local OS. AUS §5.4 leaves "one AgentHost
  per target, or target-aware worker" open. One conductor (one conversation) with a target-aware TaskManager is the
  only shape that keeps one conversation. Decide it, and give personas per target (OS words, machine name, whether
  commands are available).
- **G14. Machine-blind keys beyond SR §3.4.**
  - Worker window keys are `${pid}:${name}` (worker.ts:1032, 1058, 1510).
  - Host `lease(windowKey)` (worker.ts:87) is shared across tasks, so equal pids on two machines (or WSL vs Windows
    pids) collide.
  - Remote `currentWindow()` as a task's default target (tasks.ts:104) would pick whatever the *remote person* is
    using. For remotes the default should be none.
  - Rate limits are per engine (main.ts:1338). N targets allow N × `maxActionsPerMinute`.
- **G15. Carry checks for commands.** Text read on the local screen (or on another machine) that the model puts into a
  `run_command` argv should go through `withCarried`/`elsewhere()` like typing does. SR §5.4 applies only taint for
  unasked risky commands.
- **G16. The X1 command view as a security surface.**
  - Output from a hostile remote is rendered by xterm.js. Disable OSC 52 (clipboard write), OSC 0/2 (title changes,
    which feed `isEmberWindow`/never-look title heuristics), and auto-opening OSC 8 links (main.ts:309-312 blocks
    navigation, keep it).
  - Add its title to `EMBER_WINDOW` (policy.ts:516). It is caught by pid today (policy.ts:523), but keep the belt.
  - Expose the a11y role "terminal", so policy.ts:1960 refuses local GUI tasks there as well.
  - The same applies to IT's askpass window and a remote view window.
- **G17. Quick context and the ask-box chip** (main.ts:681-689, 717-726). With a remote or WSL target, the context must
  come from that target (`perceive.quick`, within the 3 s cap) or be skipped. Never send the local ssh terminal's text
  as "context" for a remote task.
- **G18. Files owned by I-win.** WSL §11 edits `win32/names.ts`, `hwnd.ts`, `rules.ts`, `system/ffi.ts` (registry
  enumeration), `system/apps.ts` and `system/registry.ts`. All are I-win's (pkg-i.md "Files you own"; `sshwsl/pkg-common.md:22-24`
  says to put SSH/WSL code in new files). Hand the edits to I-win, or add extension points (`remoteSurface()` hook,
  registry enumeration in a new file).
- **G19. New npm dependencies need explicit permission** (`sshwsl/pkg-common.md:35`): tree-sitter-bash/web-tree-sitter
  (SR §5.4), xterm.js (SR §5.5 X1). Name them in the briefs or choose alternatives.
- **G20. Tests contradict the loopback refusal.** IT §14 plans an integration test against `sshd` on 127.0.0.1, which
  SR §3.10 refuses. Add a test switch, honoured only unpackaged (the `TEST_SWITCHES` and `devEnv` patterns,
  launch.ts:18, 39; main.ts:58). The clone has no `app.isPackaged`: define "packaged" for it as "running from a
  `.verified` `versions/<id>`". It must ignore `EMBER_ADMIN_POLICY` (main.ts:190) when packaged, otherwise a remote
  `.bashrc` export overrides the remote admin.
- **G21. Probe before install enforces nothing.**
  - `remote.allowClone` and a broken remote policy (SR §3.6: refuse to serve) are only checked by the clone, after
    about 40 MB has been uploaded. The probe already `cat`s the policy (IT §3). Parse it locally with the same strict
    schema and refuse before uploading.
  - The probe reads only the Linux path, with GNU `stat -c`. macOS needs `stat -f`.
  - The probe runs before the per-host consent click. Order them: consent → probe → install.
- **G22. Quit and busy.** The quit dialog asks only about `tasks.list()` (main.ts:425). Running remote commands and
  connected targets must count. Quit → `stop` → EOF.
- **G23. The owner's mental model of "the visible terminal".** X1 is a new Ember window, not the user's own SSH
  terminal or tmux session. RESEARCH §9's tmux design (X2) is the one that shows in "their" terminal, and SR rejects it
  for good reasons. Say this explicitly in the report.

### WSL-specific (checked: no spec assumes UIA can see inside WSLg)
AUS §8, WSL §0.2/§3.1 and SR §4 all correctly say that UIA sees only the RAIL frame. Remaining gaps:
- An unidentified RAIL window with a visible password dialog is captured **unmasked** whenever the never-look list is
  empty (WSL §6.4: mask only when the list is non-empty). Masking unidentified RAIL windows always costs little.
- The WSL §9.1 B2 bus option needs an Ember-spawned `wslg.exe`. `wslg` is `REFUSED.win32` (terminals.ts:190), so that
  is a code-owned exception, the same class as X18.
- The WSL sidecar's `firstRequestMs: 15_000` (WSL §4.1) and the revive gate (`mayStart`) are new fields on the
  `SidecarLaunch` contract (platform/types.ts). That is a Step-0 contract change, owned by whoever owns types.ts.

---

## 6. Owner questions this review adds (beyond SR §8, RD §8, IT §15)

1. Is the "visible terminal" an Ember-owned terminal view (X1), or does a task card (X3) suffice (X17)? If X1, which
   PTY provider is acceptable with no native dependencies (G3)?
2. Persistent GUI helpers on remotes, which need a local IPC endpoint (X3/X4): allowed (needed for Windows and macOS
   desktops, and for Linux B), or Linux option A only in v1?
3. Commands when the SSH login is root, and in WSL distros whose default user is root (G8, G11).
4. Should Ember notice the user's own `ssh` and offer to connect (D2, X15), given the owner's phrasing?
5. Defaults when an admin policy exists but has no new keys (X14).
6. v1 remote OS matrix: Linux X11 desktop plus POSIX commands; Wayland (X7); Windows (G6); macOS (X6/G7).
7. Approval UX for long commands: no Ctrl+Alt+Y unless the whole command was visible; spoken and notification text
   reduced to "a command on <host>" (G4).

## 7. Suggested order to unblock packages

1. Write `sshwsl/design.md` with the L contract (§3 table, coarse ops, streams, caps) and the X1-X19 resolutions.
2. Step 0 contract: `SidecarPort`/`PerceptionPort` interfaces (G2), `Target`/`machine` types, `Question.machine/armMs`,
   `StopSource` additions, `AuditEntry.event` additions, `SidecarLaunch.mayStart/firstRequestMs`, the admin schema
   (X14).
3. Then the parallel packages: the WSL GUI fail-closed rule (needed today), the transport and probe (with G9, G21 and
   §4.1), the runner (G3), the command policy, and target routing (G1, G13, G17).
