# Remote desktop: Ember's perception and hands on a machine reached over SSH

Scope: what it takes for a process that arrives over SSH (the "clone" the local Ember installs) to see and act on the
remote machine's **logged-in graphical desktop**, through Ember's existing Linux, Windows and macOS backends. The
subject is the remote's perception and hands. Where the brain runs, how voice, confirmations and the kill switch
travel, and how the clone is installed are other specs. They appear here only where this subject constrains them:
§3.2 says where the local/remote cut can and cannot go.

Branch read: `ember-improve/20261022-windows-macos`. Every `file:line` below is from that branch. Claims about OS
behaviour that the repository doesn't show are marked **(OS fact)**, or **(verify)** where they need checking on a real
machine before anyone relies on them.

---

## 0. Conclusions first

1. **Linux (RHEL 8, GNOME on Xorg): doable today with existing modules, same user only.** A process started from the
   user's SSH session can join that user's X11 desktop if it is given the desktop's `DISPLAY`, `XAUTHORITY`,
   `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`. The nightly eval already does exactly this for its runner
   (`.github/workflows/nightly-eval.yml:79-107`) and refuses to run when it can't (`eval/src/exit.ts:52-63`). Every
   module the remote needs runs in plain Node with no Electron: the eval runner drives the real worker, perception,
   policy, confirmer, audit, XTest borrow and desk this way (`eval/src/runner.ts:16-29`, `nightly-eval.yml:108-109`
   "The evaluation runs on Node and needs no Electron").
2. **Windows: an SSH session can't reach the desktop.** Win32-OpenSSH runs its sessions in session 0, a services
   session with no interactive window station **(OS fact)**. Ember's Windows backend already fails closed there:
   `OpenInputDesktop` fails, so `onUsersDesktop(null)` is false (`app/main/platform/win32/security.ts:39-41`), capture
   returns null (`win32/capture.ts:25`) and input reports the screen locked or grabbed (`win32/input.ts:208-212,
   230-232`). The recommended approach is an opt-in agent that starts at the user's logon inside their interactive
   session and is reached over a per-user named pipe. Starting on demand through an interactive-logon scheduled task is
   the fallback. Anything that needs SYSTEM or admin (PsExec, `CreateProcessAsUser`) is rejected.
3. **macOS: an SSH process lacks both the GUI session and its own TCC identity.** TCC charges the SSH server's wrapper
   (the responsible process) for whatever a login runs **(OS fact)**. The design already relies on Ember.app being its
   own responsible process only when LaunchServices starts it (`design.md:32-35, 1810-1815, 2843-2848`). The
   recommended approach is the signed Ember.app started through LaunchServices (`open -a`) or as a LaunchAgent in
   `gui/<uid>`. Accessibility and Screen Recording must be granted **at the Mac** (or Accessibility by MDM). Screenshots
   need Electron's `desktopCapturer` (`darwin/electron-capture.ts`, `darwin/capture.ts:1-8`). Without them the clone
   works from accessibility text alone.
4. **A headless remote (no logged-in desktop) leaves nothing to perceive or act on.** The clone says so and does
   nothing. Ember never logs a user in, never installs system packages, and doesn't fall back to the command line,
   which the "no terminals, no commands" rule forbids unless the owner lifts it. Ember's Xvfb desk could run there, but
   only if GUI apps and AT-SPI are already installed (§6).
5. **The local/remote cut can't sit at the WindowSystem/Input level.** Those interfaces are synchronous and are called
   in tight loops: the borrow polls every 8 ms (`hands/borrow.ts:102`) and the overlay reads the pointer 60 times a
   second (`platform/compose.ts:19`). The desk makes them synchronous across a process boundary only because a call
   there takes about 0.3 ms (`desk/agent.ts:112-113`). Over SSH, the remote needs at least the window system, input,
   CursorBorrow, the accessibility sidecar, Perception (with its masking) and the policy checks that need live facts.
   The brain can be split off at the **tool level** (a remote "place", like `DeskPlace`, `desk/place.ts:20-38`) or the
   **worker level** (the whole Worker remote, as the eval runs it, `runner.ts:341-377`). It can't be split any finer.
6. **The safety problems are new and specific to remote desktops**: the local user **can't see** the remote screen,
   someone else may be sitting at it, it may be locked, and `ssh -X` silently points `DISPLAY` back at the *local*
   machine. §7 lists them with mitigations. Of these, the forwarded-`DISPLAY` refusal, the same-uid rule and the
   locked/inactive checks must be in place before the first release.

---

## 1. Preconditions for "the remote's desktop" (all platforms)

The clone may act only when **all** of these hold. They are checked when it connects and again before each task, and
each check fails closed:

| # | Precondition | Why |
|---|---|---|
| P1 | The desktop session belongs to **the same OS user** the SSH login authenticated as | Reading or driving another user's screen is surveillance. Ember never uses root, `xhost`, another user's X cookie or session bus, or SYSTEM tokens |
| P2 | That session is **local and active** on the console seat (Linux `Active=yes`, `Remote=no`, seat0; Windows `WTSActive`; macOS console user) | An inactive or switched-away session shows nothing, and input to it goes nowhere or to the wrong session |
| P3 | It is **unlocked** (Linux `LockedHint=no`; Windows input desktop `Default`; macOS screen not locked) | A lock screen has a password field. Ember must never type into it (owner rule), and the existing secret-field and security-window checks are not the first line of defence here |
| P4 | Linux: **X11**, not Wayland (`Type=x11`) | Ember v1's Linux backend is X11 (`app/main/environment.ts:144-148` already fails Wayland) |
| P5 | Linux: `DISPLAY` is a **local socket display** (`:N` or `:N.S`, with `/tmp/.X11-unix/X<N>` present) | `ssh -X`/`-Y` sets `DISPLAY=localhost:10.0`, a tunnel back to the **local** machine's X server. The local Ember app accepts such a display on purpose (`environment.ts:149-152`: "the session type is often unset on Xvfb, xrdp or ssh -X"); the clone must reject it |
| P6 | Ember is not running as root / elevated SYSTEM | Same as today. Windows admins' SSH sessions carry a full (elevated) token **(OS fact, verify)**, so the SSH-side connector may only relay bytes and never act |

---

## 2. Linux remote: RHEL 8, GNOME on Xorg

### 2.1 What an SSH login has, and what the desktop's processes have

| Item | SSH session of the same user (RHEL 8) | Graphical (GDM, Xorg) session | How Ember gets the desktop's value |
|---|---|---|---|
| `DISPLAY` | unset (or `localhost:10.0` with `-X`: **reject**, P5) | `:0` or `:1` (GDM may use `:1`, `nightly-eval.yml:83`) | logind: `loginctl show-user <uid> -p Display` gives the display session's id, then `show-session <id> -p Display` (`nightly-eval.yml:84-87`); confirm with the socket `/tmp/.X11-unix/X<N>` (`:89`) |
| `XAUTHORITY` | unset | `/run/user/<uid>/gdm/Xauthority` (GDM runs Xorg as the user) | First the environment of a process in the graphical session (§2.4). Else `/run/user/<uid>/gdm/Xauthority`, else `~/.Xauthority` (`nightly-eval.yml:95-99`). Then actually open the display (`exit.ts:55`, `openX11` in `eval/src/main.ts:86`) |
| `DBUS_SESSION_BUS_ADDRESS` | Usually already `unix:path=/run/user/<uid>/bus` (pam_systemd exports it when the socket exists) **(OS fact, verify)** | The same per-user bus | `unix:path=/run/user/<uid>/bus` when that socket exists (`nightly-eval.yml:100-106`; `exit.ts:58-61`). The per-user bus is shared by every login of that uid, which is why the nightly runner can use it at all |
| `XDG_RUNTIME_DIR` | `/run/user/<uid>` (pam_systemd) | the same | `/run/user/<uid>` (`nightly-eval.yml:107`) |
| AT-SPI bus | Not in the environment. libatspi finds it through `AT_SPI_BUS_ADDRESS`, then the X root property `AT_SPI_BUS`, then `org.a11y.Bus.GetAddress` on the session bus **(OS fact)** | Started by the session (at-spi-bus-launcher) | Nothing extra: same uid + `DISPLAY`/`XAUTHORITY` + session bus. The sidecar's own link connection asks the session bus with `NO_AUTO_START` (`sidecar/atspi/ember_atspi.py:4272-4297`). The demo tooling makes the same point: "Runs as the desktop's user so the accessibility bus is reachable" (`docs/DEVELOPING.md:90`) |
| `XDG_SESSION_TYPE/ID/DESKTOP`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `GDMSESSION`, `XDG_MENU_PREFIX`, `GTK_MODULES` | The SSH session's own values (`tty`, the SSH session's id), or unset | `x11`, the graphical session's id, `GNOME`, `gnome-xorg`… | Copy them from the graphical session's process environment. **Never** the SSH session's: `appEnv` passes exactly these names on to every app Ember launches (`hands/system.ts:454` SESSION list, `:475-485`), so an app started with `XDG_SESSION_TYPE=tty` and the SSH session id would be misattributed |
| `SSH_AUTH_SOCK`, `SSH_CONNECTION`, `SSH_TTY` | set | unset | **Drop from the agent's own environment.** `appEnv` already strips `SSH_*` from apps (`hands/system.ts:456`), but `cleanEnv` (`platform/compose.ts:44,56-69`) doesn't, and `AtspiSidecar` hands its whole env to the Python sidecar (`perception/sidecar.ts:256, 269-271`). A process with the user's forwarded agent could log in elsewhere |
| `toolkit-accessibility` | per-user dconf, the same value from either login | the same | Read through the sidecar's `status` (`ember_atspi.py`, `status()`). Turning it on is the existing "enable-accessibility" fix (`environment.ts:173`; `DEVELOPING.md:51-60`), and open apps must be restarted afterwards |

### 2.2 Same user versus another user

* **Same user**: everything above works without special permissions. The X server accepts the client because it
  holds the cookie from the user's own `Xauthority` (mode 0600, the user's). The session bus and the AT-SPI bus
  authenticate with D-Bus EXTERNAL, which compares uids **(OS fact)**. RHEL 8's targeted SELinux policy runs both
  logins as `unconfined_t` **(OS fact, verify on a STIG-hardened image)**.
* **Another user**: blocked by design, and Ember must keep it blocked. It can't read the other user's `Xauthority` or
  connect to their `/run/user/<other>/` sockets (0700). The only ways in are root, `xhost +si:localuser:…`
  configured by the desktop's owner, or copying their cookie. Ember uses none of them (P1). The clone checks that the
  logind session's `User` is its own uid and refuses otherwise ("<user> isn't the person logged in on this
  machine's screen").

### 2.3 Where the remote agent process lives (this decides polkit, lifetime and environment)

| Option | How it starts | Environment | Behaviour | Verdict |
|---|---|---|---|---|
| **A. Child of the SSH login** | The connector starts it with the discovered environment (§2.4) | Assembled, not inherited | Reading, AT-SPI actions, XTest, XGetImage and `gsettings` (dconf over the session bus) all work. But its cgroup is the SSH session's scope, so logind and polkit treat the agent and every app it launches as part of a **remote, inactive** session. Polkit actions allowed only for active sessions (`allow_active`: NetworkManager changes, udisks mounts…) fall back to admin auth, with no polkit agent registered for that session, so they fail **(OS fact)**. When the SSH connection drops, the agent gets SIGHUP and ends, which is the safe default. Detached apps it launched survive under RHEL 8's default `KillUserProcesses=no` | **On-demand fallback** for a first connection |
| **B. Inside the graphical session**, via an XDG autostart entry | `~/.config/autostart/ember-remote.desktop`: the same mechanism as `app/main/autostart.ts:11-13` and the nightly runner (`nightly-eval.yml:10-13`; `DEVELOPING.md:354-364`, "as the logged-in desktop user, inside the session, not as a system service") | The session's own, exactly | Behaves exactly like the local Ember: apps it launches belong to the active session, and it survives SSH reconnects. The catch is that it starts only at the **next login**, and it is a long-running process waiting for connections (a local socket, §2.6) | **Preferred** once the user opts in ("let this machine be controlled from my PC") |
| C. A `systemd --user` service | `systemctl --user start` (the user manager is shared by SSH and GUI logins) | `systemctl --user show-environment`, which has `DISPLAY`/`XAUTHORITY` only if the session imported them (`nightly-eval.yml:13`: "after `systemctl --user import-environment DISPLAY XAUTHORITY` in the session") | The process belongs to no logind session (polkit applies its `allow_any` rules). Ember already refuses `systemd-run` as a way to launch apps (`hands/terminals.ts:123`). A unit file Ember writes itself is code-owned, not a model action, but the owner should still decide | Not recommended |

Recommendation: implement **A and B on the same discovery code**. B is the persistent mode the user opts into
per machine. A covers the first connection, before any re-login. In both, the SSH-side connector only relays bytes
between the SSH channel and the agent.

### 2.4 The discovery algorithm (proposal, plain Node, fixed argv, no shell)

This generalises `nightly-eval.yml:79-107` and `liveDesktopProblem` (`eval/src/exit.ts:52-63`, unit-tested in
`test/unit/eval.test.ts:204-211`) into a `remoteDesktop()` probe that returns either an environment or a plain-words
reason:

1. `uid = process.getuid()`. Refuse if it is 0.
2. Find the session: `loginctl show-user <uid> -p Display --value` gives the session id `S`. Then
   `loginctl show-session S -p Type -p Class -p Active -p State -p Remote -p Seat -p Display -p LockedHint -p User --value`,
   or the same through `org.freedesktop.login1` on the system bus. Require `User=<uid>`, `Type=x11` (else "Wayland" or
   "not a desktop"), `Class=user`, `Active=yes`, `State=active`, `Remote=no`, `Seat=seat0`, `LockedHint=no` (P2-P4).
   GNOME sets the locked hint **(verify on RHEL 8.4's GNOME 3.32)**. If it can't be read, treat the screen as locked.
   If several of the user's sessions qualify (console plus xrdp), ask the user which one. Never guess.
3. Check that `Display` matches `^:\d+(\.\d+)?$` and that `/tmp/.X11-unix/X<N>` is a socket (P5). A
   `DISPLAY` inherited from the SSH login is never used.
4. Read the environment of one of the user's processes in session `S`: find a pid whose `/proc/<pid>/cgroup` names
   `session-S.scope`, preferably `gnome-session-binary` or `gnome-shell`, and read `/proc/<pid>/environ` (readable
   for the user's own processes). Keep only `appEnv`'s `KEEP` and `SESSION` names (`hands/system.ts:452-454`) minus
   `NEVER` (`:456`). If no such process exists, use the fallbacks in the §2.1 table.
5. Verify before use. In a short-lived child started with that environment: `openX11()` opens
   (`app/main/x11.ts:101-132`); the session bus socket exists (`exit.ts:58-61`); the sidecar's `status` answers with
   `apps > 0` (an AT-SPI bus with no applications on it means a bus started for nobody, not the desktop) and
   `toolkitAccessibility !== false`.
6. Start the agent with exactly that environment, plus `ELECTRON_RUN_AS_NODE=1` when it runs as Ember's binary.
   Don't patch `process.env` after start-up. Xlib reads `XAUTHORITY` from the process environment at
   `XOpenDisplay` (`x11.ts:132`, `hands/input.ts:144`), `launchApp` builds apps' environments from `process.env`
   (`hands/system.ts:536-548`, `appEnv()` default at `:475`), and `changeSetting` runs `gsettings` with the
   inherited environment (`hands/system.ts:19-21, 110`).
7. Run steps 2-3 again before each task, and before each borrow, as part of the existing pre-input checks. A screen
   that locks during a task stops it, and the stop is logged.

### 2.5 Linux code changes this needs (small; nothing in the backends is rewritten)

* **A window system without Electron**: `openLinuxWindows` takes Electron's `screen` only for `toDip` and
  `screenBounds` (`platform/linux/window-system.ts:31, 45-47`). Pass it a `ScreenLike` built from the X root
  (`XInput.screenSize()`, `hands/input.ts:36, 353`) with `scaleFactor: 1`. `primaryScaledUnion` then returns the root's
  size (`compose.ts:131-137`), which is correct for one X screen. This mirrors the CoreGraphics `ScreenLike` the macOS
  integration test builds in plain Node (`test/integration/darwin-desktop.test.ts:68-81`). The eval instead hard-codes
  1280×1024 (`runner.ts:347`); the remote can't.
* **No overlay to hide**: `PerceptionOptions.hideOverlay` is optional (`perception/index.ts:33`). `ownPid` defaults to
  the agent's own pid (`:120-121`).
* **The agent's environment**: built by §2.4, with `SSH_*` removed (§2.1 last rows). `AtspiSidecar` takes an explicit
  `env` (`perception/sidecar.ts:256`), as the desk already does.
* **Admin policy of the remote**: `loadAdminPolicy` is plain Node (`app/main/admin.ts`). The remote's
  `/etc/ember/policy.json` must apply on the remote, combined with the local one. Both may only tighten, so the
  stricter value of each wins.
* **A separate data folder**: if the remote user also runs their own Ember there, `~/.config/ember` (settings,
  audit, desk profiles) and the single-instance lock (`main.ts:117`) would collide. The clone uses its own folder
  (e.g. `~/.local/share/ember-remote/`). If an Ember is already running on that desktop, the clone refuses: two
  Embers acting on one screen is unsafe.
* **Prerequisites the clone can't install**: `python3-pyatspi`, `python3-gobject`, `at-spi2-core`, `libXtst`
  (`DEVELOPING.md:20-33, 51-60`) need `sudo dnf`. Ember never runs commands as root, so it reports what is missing
  in the same words as the setup check (`environment.ts:169-173`) and asks the remote's administrator to install it.

---

## 3. What runs without Electron, and where the local/remote cut can go

### 3.1 Module by module

The rule from the design: `electron` may be imported only in `main.ts`, `windows.ts`, `overlay.ts`, `handle.ts`,
`ask.ts`, `voice.ts`, `revive.ts`, `desk/view.ts` and preloads. Everything else loads in plain Node and receives
Electron objects as structural types (`design.md:50-53`; checked: `grep 'from "electron"' app/main` finds only those
files).

| Module | Plain Node? | Evidence | Remote notes |
|---|---|---|---|
| `app/main/x11.ts` (libX11 via koffi; window list, focus, pointer, `XGetImage` capture) | Yes | `x11.ts:1-5, 101-132, 346-357`; used by the eval (`eval/src/main.ts:21`, `runner.ts:27, 198`) | Needs the §2.4 environment |
| `hands/input.ts` (XTest; XInput2 watcher of the user's own devices) | Yes | `input.ts:99-144, 529-585`; eval `runner.ts:26, 199`, gates `gates.ts:15` | The watcher sees a person at the remote. VNC/remote-support input arrives over XTest too, and its pointer motion can't be told from Ember's (`input.ts:570-571`) |
| `hands/borrow.ts` (tier 3) | Yes | `runner.ts:25, 366`, `gates.ts:14` | Must sit next to the input (8 ms steps, `borrow.ts:102`) |
| `hands/system.ts` (tier 0: gsettings, launching `.desktop` apps, `appEnv`) | Yes | `runner.ts:24`; `system.ts:9-21` (child_process only) | Uses `process.env` (§2.4 step 6) |
| `hands/keybuffer.ts`, `hands/clipboard-handoff.ts` | Yes (koffi) | not in the Electron list | Ask-box helpers that a windowless clone doesn't need |
| Paste-typing clipboard (`agent/clipboard.ts`) | **Needs Electron's clipboard** | `agent/clipboard.ts:39-45` (`ElectronClipboardLike`) | Optional (`worker.ts:123`). The remote types key by key instead |
| `perception/*` (Perception, AtspiSidecar, capture with sharp, elements, marks, windows) | Yes | `perception/index.ts:1-10` ("Plain Node"); `runner.ts:16-17, 345-348`; sharp in plain Node (`desk/agent-process.ts:192-209`) | Masking of never-look windows and secret fields happens here: it must run **on the remote, before pixels leave** |
| Python AT-SPI sidecar | Yes (platform-python) | `sidecar.ts:188-190, 269-271` | Same uid plus the session bus (§2.1) |
| `policy/*` (PolicyEngine, AuditLog, vocabulary) | Yes | `runner.ts:18-19, 350` | The remote keeps its own audit, where the actions happen |
| `agent/confirm.ts`, `presenter.ts`, `worker.ts`, `conductor.ts`, `host.ts`, `runtime.ts` | Yes | Not in the Electron list; the eval runs `Worker` + `Confirmer` + `Presenter` with a `CopilotClient` (`runner.ts:15, 20-22, 215-221, 338-377`) | If the brain runs on the remote: the Copilot runtime binary must be there, and the token can't be stored with `safeStorage` (`main.ts:195, 1236`; `auth.ts:17-23`). It has to stay in memory |
| `settings.ts`, `admin.ts`, `logger.ts` | Yes | `runner.ts:23` | Separate data folder (§2.5) |
| `desk/desk.ts`, `desk/agent.ts`, `desk/agent-process.ts`, `desk/place.ts` | Yes | `runner.ts:28-29, 340, 369`; `DEVELOPING.md:155-159` (the helper runs as Ember's binary in node mode) | Only for a headless remote that has GUI apps (§6) |
| `desk/view.ts` (the desk mini-view) | **Electron** | `desk/view.ts:8` | Local side. It could show the remote view (§7 S1) |
| Overlay, handle, ask box, hotkeys | **Electron** | `overlay.ts:13`; `globalShortcut` at `main.ts:618, 1222` | Local side; the kill switch and Y/N chords are local hotkeys |
| Voice (sherpa engine) | Engine yes (`gates.ts:17-19`); the app runs it in an Electron utility process (`voice.ts:13`) | | Local side (the user's microphone) |
| TTS (`speechSynthesis`) | **Electron renderer** | | Local side (the owner wants speech on the local PC) |
| Windows window system, input, GDI capture (`platform/win32/*`) | Yes | `test/integration/win32-desktop.test.ts:20-22` runs them in plain Node. The bindings set per-monitor-v2 DPI awareness for plain Node (`win32/ffi.ts:343-352`). `screen` is used only for `toDip` (`win32/windows.ts:153-154`) | Needs the interactive session (§4) |
| Windows/macOS sidecar host (`app/sidecar-host`) + UIA bridge | Yes (Ember's binary with `ELECTRON_RUN_AS_NODE=1`) | `sidecar-host/launch.ts:37-43` | |
| macOS window system, input, AX (`platform/darwin/*`) | Yes | `test/integration/darwin-desktop.test.ts` (plain Node, CG `ScreenLike` at `:68-81`) | TCC identity (§5) |
| macOS **capture** | **Electron** (`desktopCapturer`) | `darwin/electron-capture.ts:1-10`; `darwin/capture.ts:1-8`; the test checks there is no capture without the injected function (`darwin-desktop.test.ts:260-261`) | A plain-Node macOS clone has no screenshots |
| `app.isAccessibilitySupportEnabled` (screen-reader detection) | Electron, injected | `platform/linux/system.ts:47` | Pass `false`, or read gsettings only |
| Chromium sandbox | Needed by **full** Electron only | `DEVELOPING.md` troubleshooting row; `platform/linux/doctor-probes.ts:44-47` | Node mode (`ELECTRON_RUN_AS_NODE`) starts no Chromium, so STIG machines without user namespaces still work |

So on Linux and Windows, the clone can be **Ember's own binary in node mode**, as the desk helper and the sidecar host
already are, with no window, no Chromium and no sandbox. On macOS it has to be the full Electron app if it is to take
screenshots.

### 3.2 Where the local/remote cut can go (a constraint on the brain-placement spec)

* **Not at the WindowSystem/Input level.** `WindowSystem`/`Input` are synchronous (`platform/types.ts:65-114`;
  `x11.ts` `X11`). The borrow polls `pointer()`, `pointerState()` and `keysDown()` every `STEP_MS = 8` ms
  (`borrow.ts:102, 265-279, 337-346`) and must release the mouse within 100 ms of the user moving it (PLAN.md:257
  gate). The overlay reads the pointer 60 times a second (`compose.ts:19`). `DeskAgent` keeps these interfaces
  synchronous across a process by blocking with `Atomics.wait`, which is affordable only because a call takes about
  0.3 ms (it gives up on a call after 1 s, `desk/agent.ts:94, 112-113`). An SSH round trip of 1-300 ms would freeze
  Ember's main thread on every call and break the takeover gate.
* **Possible: the tool level.** The remote holds Perception, the sidecar, the window system, input, CursorBorrow and
  the pre-input safety checks: security windows and "checked before each chunk of input" (PLAN.md:316, M8.3). It
  exposes a coarse API shaped like `DeskPlace` (`desk/place.ts:20-38`: `perception`, `sidecar`, `input`, `x11`,
  `snapshot`, `open`). One model tool call is one round trip, which is small next to a model turn. PolicyEngine
  verdicts depend on facts that live on the remote (the element, the window, the focus), so either the facts travel
  with each request or the policy check runs on the remote. The audit records each action where it happened.
* **Possible: the worker level.** The whole `Worker` runs on the remote, exactly as the eval runs it in plain Node,
  with stand-ins for `presenter`, `lease`, `flyTo`, `onProgress` and `cursor` (`runner.ts:341-371`). The local side
  relays the bubble, the questions and the answers. This needs the model and its credentials on the remote.

---

## 4. Windows remote (Win32-OpenSSH Server)

### 4.1 What an SSH login is on Windows **(OS fact)**

* `sshd` is a service running as LocalSystem. Each login gets a token from `LsaLogonUser`: S4U for key
  authentication, which carries no network credentials, so DPAPI-protected user secrets and network shares may not
  be available **(verify)**. The user's processes run in **session 0** on a non-interactive window station (one per
  logon session).
* Session 0 isolation means a process there can't see or drive the interactive session's desktop (session ≥ 1,
  `WinSta0\Default`). `EnumWindows` lists nothing of the user's windows, the screen DC isn't the user's screen,
  `SendInput` doesn't reach the user's apps, and UI Automation's root is the calling thread's desktop.
* For members of Administrators, the SSH session's token is the full elevated token (no UAC split) **(verify)**. Input
  and UIA from an elevated process would also cross UIPI boundaries that Ember deliberately respects
  (`win32/security.ts:1-30`).

### 4.2 What Ember's code already does there (verified)

* `OpenInputDesktop` fails, so `inputDesktopName()` returns null (`win32/ffi.ts:491-500`) and `onUsersDesktop(null)` is
  false (`win32/security.ts:39-41`). As a result, capture returns null (`win32/capture.ts:25`), `keyboardGrabbed()` and
  `screenLocked()` return true (`win32/input.ts:208-212, 230-232`), and the borrow won't start. `blockedReason`
  returns UNCHECKED for windows it can't inspect (`win32/input.ts:199-207`).
* So the backends fail closed: a clone started directly from the SSH login does nothing harmful, and it can do
  nothing useful either.

### 4.3 Ways to run inside the interactive session

| Option | Admin? | How | Risks | Verdict |
|---|---|---|---|---|
| **W1. Per-user agent started at logon**, reached over a **named pipe** | No | Startup entry (HKCU `Run`, or a logon-trigger task) runs Ember's binary in node mode, with the sidecar host and UIA bridge exactly as locally (`win32/platform.ts` `sidecarLaunch`, `sidecar-host/launch.ts:37-43`). It creates `\\.\pipe\ember-remote-<user SID>` (the pipe namespace is machine-wide, so a session-0 process of the same user can open it **(OS fact)**). The pipe is created through koffi `CreateNamedPipeW` with an explicit DACL (the user's SID only) and `PIPE_REJECT_REMOTE_CLIENTS`. Node's `net` pipes take the default DACL, which grants Everyone read access **(OS fact, verify)**, so they aren't enough. Each client is checked with `GetNamedPipeClientProcessId`, its token's user SID and its session | A long-running, listening process in the user's session; it starts only at the next logon | **Recommended** (the counterpart of Linux B) |
| W2. Interactive-logon scheduled task, created and run on demand | No (the user's own task) | `Register-ScheduledTask` with `-LogonType Interactive -RunLevel Limited` for the current user, then `Start-ScheduledTask`. It runs only if the user is already logged on, in their session **(OS fact)** | Group Policy may block it. Creating and starting tasks from an SSH session looks like lateral movement to EDR products (MITRE T1053.005), so alerts are likely. The commands go through PowerShell from the SSH side, which is a code-owned fixed command but still "running a program" in the owner's terms | Fallback for the first connection, **owner decision** |
| W3. `PsExec -i`, `WTSQueryUserToken` + `CreateProcessAsUser`, a service | Yes (SYSTEM / `SeTcbPrivilege`) | | Privilege escalation, lateral-movement signatures, a service that outlives the user | **Rejected** |
| W4. Nothing, when nobody is logged on, the session is disconnected (RDP closed) or locked | | | The input desktop isn't `Default`, so §4.2 makes it fail closed | Say so |

Session checks for P1/P2: `ProcessIdToSessionId(self)` is 0 under sshd. `WTSEnumerateSessionsW` +
`WTSQuerySessionInformationW(WTSUserName, WTSConnectState)` find the user's session, which must be `WTSActive`, and
`WTSGetActiveConsoleSessionId` says which session has the console. These are new wtsapi32 bindings in the
`win32/ffi.ts` style. The agent runs at medium integrity, so UIPI keeps it out of elevated windows exactly as it does
locally (`win32/input.ts:199-207`). The SSH-side process, which may be elevated, does nothing but relay.

---

## 5. macOS remote (Remote Login)

### 5.1 What an SSH login is on macOS **(OS fact)**

* SSH logins don't run in the user's Aqua (GUI) launchd session. They run in a background context of their own.
  Pasteboard, LaunchServices and WindowServer behave differently there, and which of them work from SSH varies by
  macOS release **(verify per version)**.
* TCC charges every program a login runs to the SSH server's wrapper (`/usr/libexec/sshd-keygen-wrapper` on recent
  macOS; the Remote Login "Allow full disk access for remote users" switch grants Full Disk Access to it). Without a
  grant, `AXIsProcessTrusted()` is false, CGEvent posting is refused, and screen capture returns wallpaper and
  untitled windows. The design records the same attribution rule for Ember: the responsible process is an ancestor,
  and Ember.app is its own only when LaunchServices starts it (`design.md:32-35, 1810-1815, 2843-2848`).
  Granting Accessibility or Screen Recording to `sshd-keygen-wrapper` would grant them to **every program run over
  SSH**, so it is **rejected**.

### 5.2 Ways into the GUI session

| Option | How | Notes | Verdict |
|---|---|---|---|
| **M1. LaunchServices start** | `open -g -a /Applications/Ember.app --args --remote-agent` from the SSH login | When the same user is logged in at the console, LaunchServices starts the app in that GUI session and Ember.app is its own responsible process, so its TCC grants apply (`design.md:1810-1815`; the doctor run through `open -a` is how CI shows it, `design.md:32-35`) **(verify that `open` from SSH succeeds when nobody, or another user, is at the console)** | **Recommended for "now"** |
| **M2. A LaunchAgent in `gui/<uid>`** | `~/Library/LaunchAgents/<id>.remote.plist` with `LimitLoadToSessionType=Aqua` and `RunAtLoad` | Loaded at the next GUI login. `launchctl bootstrap gui/<uid> <plist>` from an SSH login of the same user may load it straight away **(verify; some versions refuse from a non-GUI context)** | **Recommended for the persistent mode** (the counterpart of Linux B) |
| M3. `launchctl asuser <uid> …` | Needs root | | **Rejected** |
| M4. Granting `sshd-keygen-wrapper` | See §5.1 | Far too broad | **Rejected** |

### 5.3 Permissions are granted at the Mac, not from the user's PC

* Accessibility (AX reads and actions, CGEvent posting), Screen Recording (`desktopCapturer`) and possibly Input
  Monitoring (`keysDown`, design §8.5 Q10) are TCC grants. They are made in System Settings **on the remote Mac's
  screen**, or by MDM: a PPPC profile can allow Accessibility, but for Screen Recording it can only let a standard user
  approve it, never grant it silently **(OS fact, verify against Apple's PPPC payload documentation)**.
* Prompts appear on the remote's screen, where the local user isn't. macOS also asks again from time to time about
  screen recording on recent releases **(verify which capture paths trigger it)**. Ember never answers these: they are
  system security dialogs, and the macOS backend's `systemDialogOpen()` fails closed while one is up (`platform/types.ts`,
  `WindowSystem.systemDialogOpen` doc; design §8.4).
* Without Screen Recording the clone still reads and acts through accessibility text alone, just as the admin
  setting `features.screenImages` already allows (`DEVELOPING.md:260`).

### 5.4 Shape of the macOS clone

It has to be the signed Ember.app, because capture needs Electron (`darwin/electron-capture.ts`). Its AX provider runs
in the sidecar host as Ember's binary (`design.md:1810-1815`). The window system, input and AX work in plain Node, but
a plain `node` started from SSH has the wrong TCC identity (§5.1), so in practice the clone is always Ember.app.

---

## 6. A remote with no desktop (headless server)

* **Linux server**: no logind graphical session for the uid, no `/tmp/.X11-unix/X*`, no AT-SPI bus. Perception has
  nothing to read and the hands have nothing to act on. The clone says: "<host> has no desktop session for <user>, so
  Ember can't see or do anything there."
  * Tier-0 settings must be refused too. With only the systemd user bus, `gsettings` would change dconf for a desktop
    nobody is looking at, and without any bus `gsettings` silently writes to a memory backend **(OS fact)**.
  * **Ember's desk** (Xvfb + its own dbus + an optional WM) runs headless and in plain Node (`desk/desk.ts:1-13`,
    `:369-372` requirements; `DEVELOPING.md:155-159`). The user could watch it through streamed snapshots
    (`DeskPlace.snapshot`, `desk/place.ts:28`; JPEG via sharp, `desk/agent-process.ts:192-209`). It needs Xvfb,
    xauth, dbus-daemon, GUI apps, at-spi2-core and python3-pyatspi to be **already installed** (Ember installs
    nothing as root), and servers rarely have them. Possible, but of low value: an **owner decision**.
  * **The command line** (the earlier deferred design in `docs/RESEARCH.md:461-470`: tmux plus `ssh`) conflicts
    with "never opens terminals, never runs commands". It is out of scope unless the owner lifts the rule for SSH.
* **Desktop installed but nobody logged in** (GDM greeter only): same answer. Ember never logs anyone in (owner rule:
  no authentication windows, no passwords).
* **Windows with no interactive logon / Server Core**, or **macOS with no GUI login**: same answer (§4.3 W4, §5.2).

---

## 7. Safety issues specific to remote desktops

| # | Issue | Mitigation (proposal) |
|---|---|---|
| S1 | **The local user can't see the remote screen.** Over SSH they see a terminal, not the desktop. Ember's principle of visible actions (RESEARCH §4.3) and confirmations given by a person watching don't hold | A local "remote view": a low-rate stream of **masked** screenshots through `Perception.perceive({ image: true, scope: "screen" })` (`perception/index.ts:423-485`, masks never-look windows and secret fields). It must **not** use the desk's raw snapshot path, which is unmasked because the desk is Ember's own. Shown in a window like the desk mini-view (`desk/view.ts`). Each confirmation carries a masked crop of its target. The stream is on demand: about 100-200 KB per 1280 px JPEG (estimate), and it must never delay the stop message (S10) |
| S2 | **Someone may be at the remote screen**: a shared lab machine, a colleague, family at a home PC. They didn't consent and can be disrupted | While connected, a visible notice on the remote screen (a desktop notification over the session bus; or, if the clone is full Ember, its overlay labelled "controlled from <local host>"). The remote person's own mouse or keys stop a borrow (`hands/input.ts:529-585` watcher, `borrow.ts` takeover). A remote-side stop key needs a grab (Electron `globalShortcut` or an X grab through koffi, as `hands/keybuffer.ts` does) |
| S3 | Locked screen, greeter, or another user at the console | P2/P3 checks before every task and borrow (§2.4 step 7; §4.2; macOS console user and lock state) |
| S4 | **`ssh -X` turns `DISPLAY` into the local machine's X server** | P5: refuse any `DISPLAY` with a host part. Never take `DISPLAY` from the SSH login. Add a unit test next to `test/unit/eval.test.ts:204-211` |
| S5 | Another user's desktop | P1. No root, no `xhost`, no SYSTEM, no other user's cookie |
| S6 | The remote's administrator has their own rules | Load the remote's `/etc/ember/policy.json` (`admin.ts`) and combine it with the local one (the stricter value wins). Open question: should a remote with no policy file allow remote control by default? |
| S7 | Credentials leak into the clone or its apps | Strip `SSH_*`, tokens and keys from the agent and sidecar environments (`compose.ts:44` doesn't cover `SSH_*`; `appEnv` does for apps, `hands/system.ts:456`). A brain token sent to the remote stays in memory (no `safeStorage` in node mode, `auth.ts:17-23`) |
| S8 | Terminals on the remote | The same terminal vocabularies apply (`hands/terminals.ts`, `launchApp` refuses terminals, `hands/system.ts:537`). The SSH connector command is code-owned, a fixed argv that never contains model text. `ssh` stays refused as an app launch (`terminals.ts:123`) |
| S9 | **Tier 3 on a remote** loses its premise: the user watching the pointer and taking over with their own mouse | Off on remotes by default. Allowed only while the remote view is open, still with a confirmation for every borrow (as today, `runner.ts:171-177` audit rule). For the local user, "take over" means Stop |
| S10 | **The kill switch must reach the remote fast** (PLAN.md:256: < 300 ms) | The local hotkey sends a stop message on a control channel kept free of screenshot bulk. All channels share one TCP connection, so a large frame can delay a small message behind it: keep frames small and rate-limited. As a dead man's switch, the remote pulls its own `KillSwitch` (`agent/killswitch.ts:22-43`) when the SSH channel reaches EOF or heartbeats stop for about 1 s. Measure it the way `gates.ts:143-194` does |
| S11 | Polkit and elevation | Linux option A: polkit actions limited to active sessions fail (§2.3), which is safe but a limitation. Windows: an admin's SSH token is elevated, so the connector only relays and the agent runs at medium integrity |
| S12 | Audit and evidence | The remote keeps its own `AuditLog` (plus journald on Linux). Entries stream to the local "What Ember did" timeline, tagged with the host |

---

## 8. Recommended approach (summary) and open questions for the owner

**Recommended**

1. **Linux X11, same user**: the clone is Ember's binary in node mode (or Node plus the bundle, as the eval runs it).
   It starts on demand as a child of the SSH login with the environment discovered in §2.4 (option A). With the
   user's opt-in it also autostarts in the graphical session (option B) and listens on
   `$XDG_RUNTIME_DIR/ember-remote/agent.sock` (directory 0700, `SO_PEERCRED` uid check). The SSH connector only
   relays. It refuses Wayland, a locked or inactive screen, another user, a forwarded `DISPLAY`, and root.
2. **Windows**: an opt-in agent that starts at logon (W1) behind a per-user named pipe. W2 (an interactive scheduled
   task) is used only if the owner accepts the EDR and "runs a program" implications.
3. **macOS**: the signed Ember.app via `open -a` (M1) or a LaunchAgent (M2), with grants made at the Mac once. It
   works from accessibility text alone when Screen Recording is missing.
4. **Headless**: says so and does nothing. The desk and the CLI are owner decisions.
5. **Cut**: no finer than the tool level (§3.2). Masking happens on the remote, and so do the policy checks before
   input.

**Open questions**

* Q1: Is option A (on-demand, child of the SSH login, polkit-limited) acceptable for the first connection, or must
  the user re-log into the remote desktop once (option B) before Ember works there?
* Q2: Windows W2 (scheduled task from SSH): allowed? It is the only on-demand path that needs no admin.
* Q3: Should a remote with no `/etc/ember/policy.json` allow remote control, or must its administrator opt in?
* Q4: Tier 3 on remotes: off, or allowed with the remote view open?
* Q5: The remote view stream (bandwidth, privacy): on by default during tasks, or only on request?
* Q6: Headless servers: is "nothing" the answer, or is a remote desk (if packages exist) worth building?
* Q7: When an Ember is already running on the remote desktop for the same user: refuse, or hand the task to it?

---

## 9. How to verify (evidence plan)

* **Linux**: reuse the nightly eval VM (RHEL 8.4, GNOME on Xorg, autologin, `nightly-eval.yml:1-27`). Add a job
  that logs in over SSH (from the controller host, or `ssh localhost` as the desktop user), runs the discovery and
  the remote agent with no inherited desktop variables, and runs a subset of `eval/tasks` through it. Negative cases:
  `ssh -X` `DISPLAY` refused; `loginctl lock-session` gives "locked" and a running task stops; a second user is
  refused; a Wayland session is refused; with no graphical login, the answer is "no desktop". Unit-test the probe
  with injected `loginctl`/`/proc` readers, as `liveDesktopProblem` is (`test/unit/eval.test.ts:204-211`).
* **Windows**: a VM with OpenSSH Server. From the SSH login, show that capture is null and input is blocked
  (`win32/capture.ts:25`, `win32/input.ts:208-232`). Show that the W1 agent in session ≥ 1 reads and acts through the
  pipe, and that a different user's pipe client and a remote (SMB) client are refused.
* **macOS**: a Mac with Remote Login. Show that a plain process started over SSH is untrusted (it prints its ancestry,
  as `darwin-desktop.test.ts:53, 275` does), and that `open -a Ember.app --args --remote-agent` is trusted after the
  grants (the design's LaunchServices doctor run, `design.md:32-35`).

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `DISPLAY` from `ssh -X` points at the local machine | High (many users alias `ssh -X`) | Ember acts on the wrong machine | P5 refusal and its test |
| Acting on a screen nobody local can see | Certain | Unnoticed mistakes | S1 remote view; confirmations with masked crops; tier 3 off |
| Someone at the remote screen | Medium | Their work disrupted; privacy | S2 notice; their input stops borrows |
| Polkit-limited apps under option A | Medium | Some settings apps fail | Option B; say why |
| GNOME's lock hint missing on some versions | Low-Medium | Typing toward a lock screen | Fail closed when unknown; existing secret-field and security-window rules as backstop |
| EDR alerts on Windows W2 | High in enterprises | Blocked or reported | W1 by default; W2 only on the owner's decision |
| TCC grants can't be made remotely on macOS | Certain | Clone useless until someone is at the Mac | Say so clearly; AX-only mode; MDM for Accessibility |
| Missing AT-SPI packages on the remote (needs root) | Medium | No reading | Report like the setup check; never sudo |
| The kill switch delayed behind screenshot frames | Medium | Stop over 300 ms | Small frames, a separate control channel, a dead man's switch on the remote |
| Two Embers on one desktop (remote user's own Ember) | Low-Medium | Conflicting actions | Detect and refuse; separate data folder |
