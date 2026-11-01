# Ember — implementation plan (v1)

**Status: frozen 2026-10-14.** This file is the source of truth for what we build in v1 and how.
`docs/RESEARCH.md` holds the background and evidence; where the two differ, this file wins.
To change a frozen decision, edit §2 in a PR that says what changed and why.

**Extended 2026-10-22 for Windows and macOS (M11).** The port is recorded beside the frozen text, not written over
it: §1 says what v1 now runs on, each §2 row the port changes carries a **Windows and macOS** note that points to
§10, milestone M11 is in §4, §9 lists what is left, and §10 has the port's entry with its departures.

**Extended 2026-10-22 for SSH, WSL and commands (M12)**, the same way: §1 says what Ember now does, the §2 rows it
changes carry an **SSH, WSL and commands** note, new §2 rows record its decisions, milestone M12 is in §4, §5 adds the
command rules, §7 its open questions, §9 item 8 what is left, and §10 its entry with its departures.

---

## 1. What v1 is

Ember is a small animated companion that lives next to your cursor on **RHEL 8.4 (GNOME on Xorg)**.
It is always listening for "Hey Ember", works in your real apps where you can watch, and never
takes your mouse or keyboard without asking. Its agent loop is the **GitHub Copilot SDK**.

**Windows and macOS (M11, 2026-10-22).** v1 also runs on **Windows 10 22H2 and Windows 11** (x64; Windows on Arm
best effort) and on **macOS 13 or later** (Apple silicon; Intel Macs and macOS 13 best effort until they are tested
on real machines). Linux behaves exactly as before. The user stories hold there too, with these differences: Ember's
desk (U5) is Linux-only, so tier 2 isn't offered; for U8 the admin policy is a registry value on Windows and a
root-owned file on a Mac, and the audit log is the file alone (no journald); the shortcuts are Win+Alt+… on Windows
and Control+Shift+Command+… on a Mac. See M11 and §10.

**v1 user stories**

| # | Story | Done when |
|---|---|---|
| U1 | I pick my Ember (Cinder, Wisp, Glassling or Glint) during setup and can switch any time | Live switch, choice persists |
| U2 | Ember follows my cursor, shows its mood, and writes its reasoning in a bubble under it | Bubble streams model reasoning/intent in real time |
| U3 | "Hey Ember, …" works hands-free; "Ember, stop" or Esc stops everything | Wake-to-first-action p50 < 3 s |
| U4 | Ember does a task in a background window while I keep typing elsewhere | My focus and cursor never change |
| U5 | When a task needs menus, shortcuts or drag-and-drop, Ember does it on its own desk, which I can watch and take over | Desk mini-view, take over / hand back |
| U6 | "Show me how…" points at each control and waits for my click | Step-by-step guide with highlight |
| U7 | Ember asks before anything risky and never types passwords | Confirmation tiers enforced in code |
| U8 | An admin can lock features down and audit what Ember did | `/etc/ember/policy.json`, audit log |

**SSH, WSL and commands (M12, 2026-10-22).** Ember can also run commands on every computer it works on, in its own
command window: ordinary commands at once, dangerous ones (deleting, publishing, secrets, system changes, download and
run) only after asking, and exactly what the user's own words asked for after an announcement with a 4 s Stop. On
Windows it works in WSL distros (Linux apps under WSLg, and commands). It works on Linux and macOS computers reached
over SSH (commands everywhere; on a Linux computer, also the desktop of the same user at its own screen, every step
asked), through a small helper copied there for the length of the connection. The brain stays on the PC: Copilot,
voice and the GitHub token never leave it. Each is off until the user turns it on and accepts its card; an
organisation policy can turn each off. See M12 and §10.

**Not in v1:** Wayland sessions, RHEL 9/10, ~~macOS, Windows~~ (added by M11), ~~SSH~~ (added by M12), ~~neural TTS~~ (Piper,
added by #91; Kokoro on Windows and macOS, #94), ~~speaker verification~~ (Voice Match, #91), screenshot OCR redaction, multi-pointer X. See §9.

---

## 2. Frozen decisions

| Area | Decision | Evidence / reason |
|---|---|---|
| Target | RHEL 8.4, "GNOME on Xorg" session, x86-64. **Windows and macOS:** also Windows 10 22H2+/11 (x64) and macOS 13+ (Apple silicon, Intel), see §1 (§10 M11) | User's machine; X11 gives input, capture and overlays without prompts |
| Shell | **Electron 44.x** (pin exact), TypeScript, Node 24 inside Electron; Node 22 for tooling | Electron 44 needs GLIBC ≤ 2.25; launched under Xvfb/Xvnc on OL 8.4 |
| Native-code rule | Every `.node`/`.so` must need ≤ GLIBC_2.28 / GLIBCXX_3.4.25; `scripts/check-symvers.sh` gates CI. **Windows and macOS:** no glibc gate; staging keeps only the target's own builds of koffi, sharp and the Copilot runtime (§10 M11) | robotjs 0.9.1, uiohook-napi, node-screenshots, sherpa-onnx-node all fail as shipped |
| Agent loop | **`@github/copilot-sdk` 1.0.21** (pin), one `CopilotClient` over stdio to the bundled runtime | Runtime needs exactly GLIBC_2.28; sessions run fully in parallel in one process (~105–154 MB) |
| SDK hardening | `mode:"empty"`, `baseDirectory` in userData, `availableTools: []` (custom tools only), `excludedBuiltinAgents: [all]`, empty `workingDirectory`; at startup verify the tool list and **fail closed** if any built-in is present. **SSH, WSL and commands:** the built-ins stay off; commands run only through Ember's own `run_command` tool, its classifier and its command window (§10 M12) | Built-ins (shell, edit, fetch) are on by default |
| System prompt | `customize`: replace identity/tone/tool instructions, remove code rules, **keep the platform safety section** | `replace` drops guardrails |
| Sessions | **One conductor session + one worker session per task**, coordinated by a plain-TypeScript **TaskManager** | Parallel turns verified; conductor stays fast and image-free |
| Conductor | Fast model, conversational, resumed by ID on restart, never receives images; tools: `start_task`, `steer_task`, `cancel_task`, `list_tasks`, `describe_screen` (text), `point_at`, `ask_user`, `set_appearance` | Keeps context small and cheap |
| Workers | Vision model (`capabilities.supports.vision` required), computer-use tools, ≤ 1280 px JPEG screenshots on demand, AT-SPI text first; closed and **deleted** 10 min after finishing | Images are dropped silently for non-vision models; screenshots persist in `events.jsonl` |
| Results to conductor | `send({ prompt: "<task_update id=…>…</task_update>", source: "agent-worker-<id>", mode: "enqueue" })`; `immediate` only for needs-confirmation or failure | Verified send semantics |
| SDK sub-agents | Not used for tasks in v1; allowed later inside a worker (e.g. a cheap verifier) | Separate sessions give per-task model, resume, delete |
| Cost | Usage-based billing (AI credits): text before pixels, short worker sessions, usage meter from `assistant.usage` / `getQuota` | Billing changed 2026-06-01 |
| Auth | Ember's **own GitHub App**, device flow, token in libsecret via Electron `safeStorage`, passed as `gitHubToken`; dev fallback: `COPILOT_GITHUB_TOKEN`. **Windows and macOS:** `safeStorage` keeps it with DPAPI on Windows and in the Keychain on macOS (§10 M11) | SDK's built-in login asks for broad scopes |
| Packaging the runtime | Ship only `copilot-runtime` + `runtime.node` via `asarUnpack`; `RuntimeConnection.forStdio({ path })`. **Windows and macOS:** the platform's own runtime package (`copilot-runtime.exe` on Windows), chosen by OS and architecture (§10 M11) | Verified side-by-side copy works |
| Overlay | One transparent, always-on-top (`screen-saver`), click-through window per display; hover by polling `getCursorScreenPoint()` (no `forward` on Linux); hidden during captures. **Windows and macOS:** no input region, so hover polling flips `setIgnoreMouseEvents` (`forward` only on macOS); the overlay, handle and ask box are `toolbar` windows on Windows and non-activating `panel`s on macOS, so a click never activates Ember (§10 M11) | `setContentProtection`/`forward` are no-ops on Linux |
| No compositor | Detect `_NET_WM_CM_S<n>` owner (koffi + libX11); fall back to a small opaque **handle window**. **Windows and macOS:** always composited, so the handle card is never needed (§10 M11) | Transparent areas render black on xrdp/Xvnc |
| Tray | Not relied on. Floating handle + global shortcut + `.desktop` launcher; tray optional (RPM *Recommends* `gnome-shell-extension-top-icons`) | GNOME 3.32 has no tray by default |
| Characters | All four ship; one shared rig; picker in onboarding, settings, tray and by voice (`set_appearance`); mini-Embers mark running tasks | User decision |
| Screen capture | **Electron `desktopCapturer`** (kept warm) on the user display; koffi + `XGetImage` on desk displays. **Windows and macOS:** GDI `BitBlt` (`SRCCOPY \| CAPTUREBLT`) through koffi on Windows; Electron `desktopCapturer` on macOS, only while Screen Recording is allowed, resampled to points (§10 M11) | node-screenshots needs GLIBC 2.30 |
| Accessibility tree | **Python 3.6 sidecar with pyatspi** (system `platform-python`), JSON-RPC over stdio; focused window only, depth ≤ 12, `GetMatches`, event-driven cache; window ↔ AT-SPI match by PID + extents. **Windows and macOS:** one shared TypeScript host (`dist/app/ax-sidecar.cjs`: Ember's own binary in Node mode on Windows, an Electron utility process on macOS) speaks the same JSON-RPC, so perception and policy are unchanged; below it a C# 5 UI Automation bridge run by Windows PowerShell 5.1, or an in-process koffi AX provider on macOS (§10 M11) | 7-node tree in 3 ms, `GetMatches` in 0.4 ms on OL 8.4 |
| Small D-Bus calls | `dbus-native` (handles the abstract socket the a11y bus uses on 8.4) | dbus-next needs a native helper |
| Input injection | **`@jitsi/robotjs` 0.6.24** (XTest) + `ghost-cursor` `path()` for human-like motion. **Windows and macOS:** `SendInput` (text with `KEYEVENTF_UNICODE`) and `CGEvent` (text as Unicode strings) through koffi; Windows refuses to borrow for an elevated window, whose input Windows would drop silently (§10 M11) | Prebuilt loads on glibc 2.28 |
| Global hotkeys | Electron `globalShortcut` (X11 key grab). **Windows and macOS:** the same, from one table for all three OSes (`app/shared/shortcuts.ts`): Win+Alt+… on Windows (Ctrl+Alt is AltGr there), Control+Shift+Command+… on a Mac (Control+Option is VoiceOver's); the primary modifier is Ctrl on Linux and Windows and Command on macOS (§10 M11) | No native addon needed |
| Takeover detection | `uiohook-napi` **rebuilt on EL8** (only active while borrowing the cursor); idle time from `powerMonitor.getSystemIdleTime()`. **Windows and macOS:** polling the key state and the pointer (`GetAsyncKeyState`; `CGEventSourceKeyState`, which may need Input Monitoring (undocumented), so a Mac without it never lends Ember the keyboard) (§10 M11) | Rebuilt binary verified |
| Action tiers | 0 app APIs (gsettings/D-Bus) → 1 background AT-SPI (`doAction`, `EditableText`, `Value`, `Selection`; never `grabFocus`) → 2 **Ember's desk** → 3 **borrow cursor** (ask, idle ≥ 3 s, abort on input < 100 ms). **Windows and macOS:** tier 0 is dark mode (the registry; System Events) and opening apps (`explorer.exe`; `open -a`); tier 2 is Linux-only (§10 M11) | Cua-style "no foreground" contract |
| Desk | `Xvnc` (tigervnc-server-minimal) `:N` on a Unix socket + `metacity` (AppStream) + `dbus-run-session` + `at-spi-bus-launcher`; a desk-agent child process with `DISPLAY=:N`; mini-view with `@novnc/novnc` over an IPC↔`net.Socket` bridge. **Windows and macOS:** no desk; `open_on_desk` is never offered (§10 M11) | All in AppStream, no EPEL needed |
| Voice | Mic in a hidden renderer (echo cancellation on) → 16 kHz `AudioWorklet` → `utilityProcess` running **sherpa-onnx WASM**: keyword spotting ("hey ember", "ember stop"), Silero VAD, streaming Zipformer ASR; second-stage transcript check; 8 s follow-up window. **Windows and macOS:** the same WASM pipeline; models are unpacked in-process, with no system `tar` or `bzip2` (§10 M11) | Native addon needs glibc 2.32; WASM verified |
| TTS | `speechSynthesis` with `--enable-speech-dispatcher` (espeak-ng), voice chosen by `lang`, played from the mic renderer so echo cancellation removes it; while Ember speaks, a "Hey Ember" its speakers didn't say makes it stop and listen. **Windows and macOS:** the system's own voices; speaker-output rejection (`parec`) is Linux-only, and the settings say so (§10 M11) | 0 voices without the flag; 100 with it |
| Safety boundary | Deterministic **policy engine** in the main process behind one shared `onPreToolUse` + `onPermissionRequest` for all sessions. **SSH, WSL and commands:** each SSH computer gets its own engine with both machines' policies combined, and the agent there checks every step again (gate 2), which can only refuse or ask (§10 M12) | See §5 |
| Tests | Mock OpenAI-compatible server via BYOK `provider` for deterministic agent tests; per-PR rockylinux:8 container (Xvfb + D-Bus + AT-SPI + GTK fixture); nightly real RHEL 8.4 GNOME Xorg VM. **Windows and macOS:** per-PR `windows-2022` and `macos-15` jobs drive real desktops (a WinForms and an AppKit bench, Notepad, TextEdit); the eval stays Linux-only (§10 M11) | Mock server approach verified with real SDK loops |
| Packaging | electron-builder **RPM** (+ AppImage); `rpmbuild` wrapper that unsets `LD_LIBRARY_PATH`; autostart entry with `--enable-speech-dispatcher`. **Windows and macOS:** a zip of `Ember\Ember.exe` (Ember's own version resource and icon, unsigned) and `Ember.app` (signed ad hoc) as a zip and a dmg; signing and notarisation are out of scope (§10 M11) | fpm breaks EL8 rpmbuild otherwise |
| Platform layer (M11) | One composition root, `app/main/platform/`: `loadPlatform()` picks the backend by `process.platform` alone and gives main one `Platform` object (window system, input, overlay shaping, the accessibility helper's launch, system integration, the desk). Nothing outside it tests the OS. It loads under plain Node: Electron objects are passed in | Linux is wrapped, not rewritten, so it stays the same byte for byte (§10 M11) |
| Screen units (M11) | Native units end to end: physical pixels on Linux and Windows (Per-Monitor-V2), points on macOS. Negative coordinates are valid off Linux. Only Ember's own windows use Electron's DIP | Mixed scaling and monitors left of the primary stay exact; one image pixel is one screen unit for masking (§10 M11) |
| System integration (M11) | Windows: data in `%LOCALAPPDATA%\ember`, admin policy in `HKLM\SOFTWARE\Policies\Ember`, login item in the Run key, apps opened through `explorer.exe`. macOS: data in `~/Library/Application Support/ember`, admin policy in `/Library/Application Support/Ember/policy.json`, an SMAppService login item, apps opened with `open -a`. Audit log: the file only, on both | Apps never inherit Ember's environment (tokens); a policy Ember can't trust locks it down (§10 M11) |
| Node mode (M11) | Ember's binary never runs as plain Node (`ELECTRON_RUN_AS_NODE`) on macOS: the macOS build's RunAsNode fuse is off, the accessibility host is an Electron utility process (`utilityProcess.fork`, service "Ember accessibility"; requests on its parent port, answers on stdout) and SSH's askpass is Ember itself in a no-window mode (`--ember-askpass`: no window, no Dock icon, no single-instance lock). Linux and Windows keep the fuse on: Linux's desk helper and Windows' commands job host (which needs a console-capable child process), accessibility host, askpass launcher and WSL launcher run Ember's binary as Node | On macOS, Accessibility and Screen Recording follow the app macOS holds responsible, so with node mode any program the user runs could start Ember's binary with a script of its own (by launchd, say) and act with Ember's grants. On Linux and Windows no grant follows Ember's binary, so node mode gives such a program nothing it doesn't already have. CI proves Ember.app refuses it (review #177, owner decision D-177; `scripts/package/fuses.mjs`) |
| Targets (M12) | A task acts on one target: this computer, a WSL distro (`wsl:<distro>`) or a computer reached over SSH (`ssh:<host>`), chosen only by the user's own words or the handle's **Work on** picker, never from screen text or results. The brain is local: Copilot sessions, questions, voice and the GitHub token stay on the PC; a remote is eyes, hands and a command runner under its own admin policy and audit | The owner's decisions; nothing Copilot-related on a remote (§10 M12) |
| Commands (M12) | One `run_command` tool on every target, run in Ember's own command window (xterm.js 5.5.0, the one new dependency), with a PTY through `script(1)` or pipes; a hand-written conservative classifier (POSIX, PowerShell, cmd): ordinary commands run, the dangerous classes ask, a dangerous command the user's own words asked for exactly is announced with a 4 s Stop (never secrets, download-and-run, outliving the kill switch or anything unclear), tampering with Ember's own safety machinery is refused; an approval binds to the exact bytes, target and task, by click or chord only while the whole command shows; output untrusted, redacted best effort and bounded | Owner decision 4: most work needs commands; stop and ask only for dangerous ones (§10 M12) |
| SSH (M12) | The system OpenSSH client with the user's settings and keys, one hardened `ssh -T … sh -s` per link (no forwarding, no ControlMaster of its own) carrying a fixed bootstrap and then a framed protocol; a pinned, SHA-256-checked Node 24 and Ember's parts copied per remote, nothing persisting; passwords through Ember's own prompt to ssh only | No network listener, no remote brain, no install left behind (§10 M12) |
| WSL (M12) | Discovery from the registry and `wsl.exe` without starting a distro; commands through `wsl.exe --exec` under a kill-on-close job object; WSLg apps identified by an AT-SPI helper inside the distro and matched to their RAIL windows; unidentified ones stay remote surfaces | UI Automation sees a WSLg window as one opaque `msrdc` frame (§10 M12) |

---

## 3. Architecture

```
┌──────────────────────────────── Electron main process ─────────────────────────────────┐
│ AgentHost: CopilotClient ── conductor session ── worker sessions (one per task)          │
│ TaskManager: lifecycle · leases (window / clipboard / user-input) · queue · results       │
│ PolicyEngine: tiers · per-app grants · confirmations · rate limits · audit log           │
│ ActionRouter: tier 0 app APIs → tier 1 background AT-SPI → tier 2 desk → tier 3 cursor   │
│ Perception: desktopCapturer · set-of-marks (sharp) · never-look masking                  │
│ OverlayManager · HandleWindow · SettingsWindow · DeskManager · VoiceBridge · Settings    │
└───────┬───────────────┬──────────────────┬──────────────────────┬────────────────────────┘
        │ stdio         │ stdio JSON-RPC   │ MessagePort          │ spawn per desk
  copilot-runtime   a11y sidecar        utilityProcess:        desk-agent (DISPLAY=:N)
  (bundled)         python3.6/pyatspi   sherpa-onnx WASM       robotjs · XGetImage · sidecar
                                        KWS · VAD · ASR        Xvnc + metacity + own D-Bus
  Renderers: overlay (characters + bubble + highlights) · mic/TTS (hidden) · settings · desk view
```

On Windows and macOS the AT-SPI sidecar's place is taken by the shared accessibility host: Ember's own binary in Node
mode on Windows, an Electron utility process on macOS (M11, review #177); the rest of the picture holds.
docs/DEVELOPING.md has the current repository layout.

**Repository layout (target)**

```
app/main/          Electron main: agent, tasks, policy, router, perception, windows, desk, voice bridge
app/preload/       contextBridge APIs per window
app/renderer/      overlay, settings, desk-view, audio (hidden)
app/utility/       voice worker (sherpa-onnx WASM)
packages/characters/  rig + Cinder, Wisp, Glassling, Glint (from demo/character-lab)
packages/bubble/      reasoning bubble
packages/motion/      follow spring and flight path
sidecar/atspi/     Python 3.6 JSON-RPC server (pyatspi)
desk/agent/        desk-agent process
test/              unit, integration (Xvfb), tasks/ (agent task suite), fixtures/
scripts/           check-symvers.sh, rebuild-el8.sh, build helpers
```

---

## 4. Task list

IDs are stable; reference them in commits and PRs. **Deps** lists tasks that must be done first.
Milestones are ordered; tasks inside a milestone can run in parallel unless a dependency says otherwise.

### M0 · Foundations

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M0.1 | Restructure repo to the target layout; move demo code into `packages/characters` and `packages/bubble` | `npm run build` passes; demos still build | — |
| M0.2 | Electron 44 skeleton: single-instance lock, settings store (`~/.config/ember/settings.json`), structured logging | Starts on RHEL 8.4 Xorg; second launch focuses the first | M0.1 |
| M0.3 | Lint, typecheck, Vitest; CI job on `ubuntu` for fast checks | CI green on PR | M0.1 |
| M0.4 | `scripts/rebuild-el8.sh`: rebuild native addons with `@electron/rebuild` in a rockylinux:8 container; CI runs `scripts/check-symvers.sh` on `node_modules` and the bundled runtime | CI fails on any binary needing > GLIBC_2.28 | M0.3 |
| M0.5 | Developer guide for RHEL 8.4: packages, GNOME on Xorg, `toolkit-accessibility`, speech-dispatcher | A new dev can run `npm run dev` from the guide | M0.2 |

### M1 · Ember on screen

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M1.1 | Port the rig and four characters; unit tests for rig transitions | Each emotion renders; tests cover presets and springs | M0.1 |
| M1.2 | Overlay window per display: transparent, `screen-saver` level, click-through, re-assert topmost, display hot-plug, DPI | Stays on top on dual monitors; survives plug/unplug | M0.2 |
| M1.3 | Compositor detection + opaque handle-window fallback | Under bare Xvnc the handle appears instead of a black overlay | M1.2 |
| M1.4 | Cursor following (60 Hz poll, spring), edge flipping, hover-to-interact by toggling click-through over the bubble | Smooth follow; bubble buttons clickable; clicks elsewhere pass through | M1.2 |
| M1.5 | Reasoning bubble + task cards + status pill | Streams text; shows multiple task cards | M1.4 |
| M1.6 | Character picker: onboarding step, settings window, `.desktop` launcher, global shortcut; live swap; size slider; persisted | Switching is instant and survives restart | M1.1, M0.2 |
| M1.7 | Floating handle (menu: settings, mute, pause, quit) + optional tray | All controls reachable without a tray | M1.2 |

### M2 · Brain (Copilot SDK)

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M2.1 | Bundle the runtime (`asarUnpack`, `forStdio({path})`), version pin, health check (`ping`, auth status) | Packaged app starts the runtime on RHEL 8.4 | M0.4 |
| M2.2 | GitHub App + device-flow login; token in `safeStorage`; clear errors for no seat / org policy denial | Login works; denial explains the CLI policy | M2.1 |
| M2.3 | `SessionFactory`: hardened config (§2); startup tool-list verification that fails closed | Unit test proves no built-in tool is exposed | M2.1 |
| M2.4 | Mock OpenAI-compatible server + BYOK test harness (scripted turns, tool calls, images) | Agent tests run offline and deterministically | M2.3 |
| M2.5 | Conductor: persona prompt, resume by ID, tool stubs, streaming → bubble (intent, reasoning, message), usage meter | "What can you do?" streams with reasoning; restart resumes | M2.3, M1.5 |
| M2.6 | Model selection from `listModels()`: fast conductor model, vision worker model; settings override; admin lock | Non-vision model can never be picked for workers | M2.5 |
| M2.7 | Text input box (global shortcut) → conductor | Typed requests work end to end | M2.5 |

### M3 · Perception

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M3.1 | AT-SPI sidecar: JSON-RPC, focused-window tree (depth ≤ 12, `GetMatches`), drop invisible / non-`SHOWING` nodes, event cache | gedit, Settings, Files, Firefox, LibreOffice trees < 300 ms | M0.2 |
| M3.2 | Window mapping: `_NET_ACTIVE_WINDOW`, `_NET_WM_PID`, extents ↔ AT-SPI frames | Correct frame for the focused window in all five apps | M3.1 |
| M3.3 | Capture service: warm `desktopCapturer`, per-display, JPEG ≤ 1280 px, coordinate record, overlay hidden, never-look masking | Model coordinates map back to the right pixels on 2 monitors | M1.2 |
| M3.4 | Set-of-marks image (sharp) from AT-SPI bounds | Numbers match element IDs | M3.1, M3.3 |
| M3.5 | Accessibility enablement: check/offer `toolkit-accessibility`; launch recipes for Electron (`--force-renderer-accessibility`), Qt, Java | Onboarding detects and fixes a disabled a11y setting | M3.1 |
| M3.6 | `perceive_screen` / `describe_screen` tools (text first, image on request) | Worker gets elements + optional image; conductor text only | M3.4, M2.3 |

### M4 · Hands and tasks (tiers 0, 1, 3)

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M4.1 | TaskManager: task lifecycle, worker sessions, leases, queue, cancel/steer, results to conductor, deletion after 10 min | Two tasks run in parallel; conflicting tasks queue | M2.5 |
| M4.2 | ActionRouter with tier escalation (`background_unavailable`) | Router picks the lowest tier that works; logs the choice | M4.1 |
| M4.3 | Tier 1 actions in the sidecar: `doAction`, `EditableText` set/insert, `Value`, `Selection`, caret; post-action verification by events | Toggle a Settings switch in a background window; user focus unchanged | M3.1, M4.2 |
| M4.4 | Tier 0 integrations: gsettings / D-Bus for common settings; `xdg-open` | Night Light and Do Not Disturb via gsettings | M4.2 |
| M4.5 | Tier 3 cursor borrow: ask, idle ≥ 3 s, save/restore pointer + focus, ghost-cursor motion, abort on user input < 100 ms | Abort latency measured < 100 ms | M4.2, M8.2 |
| M4.6 | Worker tool set: `perceive_screen`, `click_element`, `set_text`, `toggle`, `select`, `scroll`, `press_keys` (tier ≥ 2), `open_app`, `focus_window`, `zoom`, `report_progress`, `finish_task` | Tools typed with zod; all pass through the policy engine | M4.3, M8.1 |
| M4.7 | Visual feedback: mini-Ember flies to element extents, window glow, step timeline | You can see which window and control Ember is touching | M4.6, M1.5 |

### M5 · Voice

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M5.1 | Mic capture renderer (echo cancellation) → 16 kHz worklet → `utilityProcess` | Clean 16 kHz stream; nothing written to disk | M0.2 |
| M5.2 | sherpa-onnx WASM: KWS ("hey ember", "ember stop"), VAD, streaming ASR, second-stage check; model download and checksum | Wake works; transcripts stream into the bubble | M5.1 |
| M5.3 | Conversation window (8 s), barge-in, local kill phrase → abort all | "Ember, stop" aborts in < 300 ms without the LLM | M5.2, M4.1 |
| M5.4 | TTS via `speechSynthesis` (voice by `lang`), self-mute of wake detection while speaking | Ember's own speech never wakes it | M5.2 |
| M5.5 | Speaker-output rejection: run KWS on the PulseAudio monitor; reject matches within ±300 ms | A video saying "Hey Ember" does not wake it | M5.2 |
| M5.6 | Indicators (off / listening for name / active), mute hotkey that stops the stream, policy switch | Mute releases the mic | M5.1, M8.7 |
| M5.7 | Measure CPU, false accepts/hour, false rejects on a recorded corpus | Targets in §6 met or documented | M5.2 |

### M6 · Guide and quick context

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M6.1 | `point_at` + highlight from extents; `wait_for_user_click` (click inside rect or AT-SPI state change) | "Show me how to change the wallpaper" guides each step | M3.2, M1.5 |
| M6.2 | Quick context: on wake, snapshot the focused window (text, optional image) into the request | "Make this bold" acts on the current selection | M3.6, M5.2 |
| M6.3 | Map agent events to character emotions and gestures (point toward target, typing, proud, sorry) | Every SDK event has a visible reaction | M1.1, M2.5 |

### M7 · Ember's desk (tier 2)

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M7.1 | DeskManager: `Xvnc :N` (Unix socket), metacity, `dbus-run-session`, `at-spi-bus-launcher`; lifecycle and cleanup | Desk starts < 2 s; no orphans after quit | M0.2 |
| M7.2 | Desk-agent process: robotjs input, `XGetImage` capture, own a11y sidecar | Same tool set works on the desk | M7.1, M3.1 |
| M7.3 | App recipes: Firefox `-no-remote -P ember`, `gnome-terminal-server --app-id`, LibreOffice `UserInstallation`, GApplications | Each app opens on the desk, never on the user's display | M7.1 |
| M7.4 | Mini-view: `@novnc/novnc` over an IPC↔`net.Socket` bridge; view-only; take over / hand back | User can watch and take over | M7.1 |
| M7.5 | File hand-off folder (`~/Ember`) and clipboard isolation | Desk results land in `~/Ember`; user clipboard untouched | M7.2 |

### M8 · Safety, policy, privacy (v1 must-haves)

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M8.1 | Policy engine: shared `onPreToolUse` + `onPermissionRequest`; per-app grants (Observe / Act in background / Act with cursor); tier classification; rate limits | Every tool call is decided and logged | M2.3 |
| M8.2 | Confirmation UI built from the structured action (not model text); click or key only | Voice "yes" cannot approve tier-2 actions | M8.1, M1.5 |
| M8.3 | Hard blocks: password-role fields, polkit/sudo prompts, payment fields → user takeover, capture paused | Fixture tests prove Ember never types into them | M8.1, M3.1 |
| M8.4 | Untrusted-content tagging in worker results; conductor takes goals only from the user; task-alignment rules before tier-2 actions | Injection fixtures cause no out-of-scope action | M8.1, M4.1 |
| M8.5 | Never-look list (WM_CLASS / desktop ID) enforced before capture and tree reads | Denied apps are masked in images and absent from trees | M3.3, M3.1 |
| M8.6 | Audit log (append-only JSONL + journald), step timeline UI, retention; delete worker sessions after the follow-up window | Log covers every action and decision | M8.1, M4.1 |
| M8.7 | `/etc/ember/policy.json` admin lockdown: features, apps, stricter tiers only, models, BYOK lock, retention (domain rules: not in v1, §5) | Admin values override user settings | M8.1 |
| M8.8 | Onboarding consent: mic and screen disclosure, GNOME mic icon note, data-handling statement | First run cannot skip consent | M1.6 |
| M8.9 | Kill switch: global hotkey and "Ember, stop" → abort all sessions and motion | Stops everything in < 300 ms | M4.1, M5.3 |

### M9 · Packaging and release

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M9.1 | electron-builder RPM (explicit depends, *Recommends* top-icons, rpmbuild wrapper) + AppImage | `dnf install` on clean RHEL 8.4 resolves all libraries | M2.1 |
| M9.2 | chrome-sandbox handling for STIG hosts (`user.max_user_namespaces=0`) | Starts on a STIG-hardened VM | M9.1 |
| M9.3 | Autostart entry with flags; `ember doctor` (session type, compositor, a11y, speech-dispatcher, mic, Copilot auth and policy) | Doctor explains every failing check | M9.1 |
| M9.4 | Clean-install test on RHEL 8.4 VM | Full demo suite passes on a fresh VM | M9.3 |

### M10 · Evaluation

| ID | Task | Acceptance | Deps |
|---|---|---|---|
| M10.1 | Task-suite format (OSWorld-style JSON) and checkers: gsettings, files, AT-SPI state, negative "nothing else changed" checks | 25 tasks across gedit, Settings, Files, Firefox, LibreOffice | M4.6 |
| M10.2 | Per-PR integration tier: rockylinux:8 container, Xvfb, D-Bus, AT-SPI, GTK fixture, mock LLM | Runs on every PR in < 15 min | M2.4, M0.4 |
| M10.3 | Nightly tier: real RHEL 8.4 GNOME Xorg VM, live models, snapshot revert per task, pass^3 | Nightly report published | M10.1 |
| M10.4 | Safety fixtures (on-screen instructions, fake pop-ups, hidden fields, booby-trapped documents) and metrics dashboard | Release gates in §6 tracked | M10.1, M8.4 |

### M11 · Windows and macOS

Added 2026-10-22 (§1). CI evidence is from GitHub Actions runs of `ci.yml`: run 124 on `windows-2022` (Windows
Server 2022), run 123 on `macos-15` (Apple silicon) and `macos-15-intel`, run 125 for the Linux jobs. The counts are
passing tests per integration suite.

| ID | Task | Acceptance | Deps | Status |
|---|---|---|---|---|
| M11.1 | Platform layer: one composition root (`app/main/platform/`, `loadPlatform()` by `process.platform`) with the contract (`types.ts`), one shortcut table (`app/shared/shortcuts.ts`), OS words, and OS-keyed vocabularies; every OS call in main goes through it, and Linux's modules are wrapped, not rewritten | On Linux nothing changes: the Linux jobs pass as before; no `process.platform` outside `platform/` (platform-boundary test) | — | **Done**: Linux jobs green (run 125) |
| M11.2 | Windows window system and input (koffi: user32, gdi32, dwmapi): z-order, frames, cloaked windows; `SendInput` with `KEYEVENTF_UNICODE` text; takeover by `GetAsyncKeyState`; `BitBlt` capture; elevated windows refused | The bench is in the stack with its program, comes to the front from a timer within 1 s, captures with real pixels; clicks, keys and Unicode text arrive; nothing stays pressed | M11.1 | **Done**: win32-desktop 15 (run 124) |
| M11.3 | macOS window system and input (koffi: CoreGraphics, AX at 0.25 s on the main thread, CoreFoundation): CGEvent input; takeover by key-state polling; `desktopCapturer` capture only with Screen Recording, resampled to points; system dialogs and secure input fail closed | The bench and TextEdit are in the stack; TextEdit comes to the front from a process with no UI; typed text reads back over AX; Command+S saves | M11.1 | **Done**: darwin-desktop 14/14 on Apple silicon and Intel (run 123) |
| M11.4 | Sidecar host: one TypeScript host (`dist/app/ax-sidecar.cjs`) speaking the AT-SPI sidecar's JSON-RPC, run as Ember's own binary with `ELECTRON_RUN_AS_NODE` on Windows and as an Electron utility process on macOS (requests on its parent port, answers on stdout; review #177); ids, secrets, labels and verification shared by both providers; never reads Ember's own process | `AtspiSidecar` unchanged apart from its launch; the packaged host answers within 30 s | M11.1 | **Done**: ax-sidecar 14 (run 124); packaged host checks in ember-win32 and ember-darwin |
| M11.5 | UI Automation bridge (`sidecar/uia`): C# 5 compiled by Windows PowerShell 5.1's `Add-Type`, cached per user by the source's SHA-256; a deadline per call and "busy" per app; never reads a password's value; execution policy and Constrained Language Mode reported, never bypassed | Compiles and starts as Ember starts it, then from its cache; reads and operates the WinForms bench, its list and tree views and its 32-bit build; exits when its input closes | M11.4 | **Done**: compile step and uia-bridge 22 (run 124) |
| M11.6 | macOS AX provider in the host (koffi): 0.8 s per app, busy apps skipped; keys from `CFHash`; closed to password fields and hidden elements; Chromium apps' trees switched on | Reads and operates the AppKit bench; a second host process gives the same keys | M11.3, M11.4 | **Done**: ax-sidecar-darwin 16/16 (run 123) |
| M11.7 | Windows system integration: Start Menu and packaged-app catalogue, apps opened through `explorer.exe`; dark mode; the registry admin policy; login item; setup checks and fixes ("Unblock it"); check-up rows, including the helper's command line for allow-lists; Start Menu shortcut and AppUserModelId; log-off | Settings and File Explorer listed; Notepad opened without Ember's environment; dark mode round trip; login item on and off | M11.1 | **Done**: win32-system 11 (run 124) |
| M11.8 | macOS system integration: app catalogue from bundles, `open -a`; Dark Mode through System Events; the root-owned policy file; login item; permission checks, fixes and check-up rows; VoiceOver; the app menu | TextEdit, Finder and System Settings listed and TextEdit opened; Dark Mode round trip; a red window captured at one pixel per point | M11.1 | **Done**: darwin-system 10/10 (run 123) |
| M11.9 | Vocabularies and copy for Windows and macOS: terminals, security windows, never-look defaults, risky labels, browsers and office apps, clipboard password markers, app names, persona and settings words; Linux rows frozen. On Windows, remote surfaces (Remote Desktop and WSLg windows) refused and blacked out | Each row checked against real windows | M11.1 | **Done**: win32-vocabulary 8 (run 124), darwin-vocabulary 5/5 (run 123). The remote-surface rule came after run 124: unit tests only so far (§9 item 7) |
| M11.10 | Packaging and CI: `layout.mjs` per target; the Windows zip (Ember.exe with its own version resource and icon and no broken signature, `ember-doctor.cmd`); `Ember.app` (executable renamed, fuses, signed ad hoc) as a zip and a dmg; the `windows`, `macos` and `macos-x64` jobs; macOS permission grants and the attribution check | Fuses set and `--inspect` refused in both packages; Ember.exe `NotSigned`; all six shortcuts held on Windows; Ember.app's own grant reaches it and its helper (check-up before and after the grant) | M11.1 | **Done**: run 124 (check-up 15 rows; `ember-doctor.cmd` gave the check-up's exit code, and its check with a failing one came later, §9 item 7), run 123 (attribution before and after, the Intel bundle) |
| M11.11 | Integration and manual test: the platforms switched on in `loadPlatform()`; Ember-level checks (composition, Perception, masking, the overlay out of screenshots, the packaged host; on macOS Ember starts beside the user's app and the ask box takes keys without activating it); the manual plan on real machines (§9) | CI: ember-win32 and ember-darwin pass. Manual: every §9 check on Windows 11 23H2+, Windows 10 22H2, macOS 14 and 15 | M11.2–M11.10 | **CI part done**: ember-win32 5/5 (run 124), ember-darwin 7 (run 123). Manual part open |
| M11.12 | Docs: PLAN.md, README.md and docs/DEVELOPING.md for Windows and macOS | A new developer can set up, test and package on each OS from the guide | M11.11 | **Done** 2026-10-22 |

### M12 · SSH, WSL and commands

Added 2026-10-22 (§1). Built as parallel packages on `ember-improve/20261022-ssh-wsl`, each against a shared contract
(M12.1) and merged in order; TG wired the runtime, two integration packages wired everything end to end, and a
whole-branch adversarial review's confirmed findings were fixed. docs/DEVELOPING.md §14 says where each lives. **Every
package has merged. No CI has run on it yet**: GitHub Actions' budget ran out, so no `remote.yml` job has ever run and
nothing here is proven on Windows, macOS, WSL or a real sshd; `npm test` (every unit test, OS-neutral) passes on
Linux. The runs owed are listed below the table.

| ID | Task | Acceptance | Deps | Status |
|---|---|---|---|---|
| M12.1 | The contract (S0a): target, command, WSL and protocol types and schemas; the admin keys and settings; the fixed launcher texts; stubs; build entries; the Electron and target-path lint rules; `remote.yml` | No behaviour change; schema, R5 and lint tests | M11 | **Merged** |
| M12.2 | The shared hooks (S0b): main's hooks, the Confirmer's panel questions, Ember's own windows masked in every capture, sidecar start rules, the policy's target seam | Linux, Windows and macOS unchanged with nothing turned on | M12.1 | **Merged** |
| M12.3 | The framed stream both ends share (MX): priorities, credits, chunking | A Stop overtakes 4 MiB of output; bad frames reset | M12.1 | **Merged** |
| M12.4 | The classifier (CL): POSIX, PowerShell and cmd tokenizers, the dangerous-class tables, paths, the intent matcher, the decision, redaction, output shaping, taint, `visibleText` | A corpus of 800 or more cases; nothing unparsable runs unasked | M12.1 | **Merged** |
| M12.5 | Runners (RUN): launchers, environment, the stop ladder and sweep, the Windows job host | `commands-linux`, `commands-linux-el8` and the PowerShell part of `wsl-windows` | M12.1 | **Merged**; jobs not run |
| M12.6 | Windows and pages (UI): the command window, the prompt window, badges, the Computers and Commands settings, every string | Every new string pinned; output can't change the card | M12.1 | **Merged** |
| M12.7 | WSL discovery and commands (WA) | `wsl-windows`, `wsl2-windows` | M12.1 | **Merged**; jobs not run |
| M12.8 | SSH transport (SA): argv, configuration, errors, askpass, the bootstrap, the install plan, the same-machine check, the Node.js download, noticing the user's ssh | `ssh-linux` (transport), `ssh-windows` | M12.1, M12.3 | **Merged**; jobs not run |
| M12.9 | The remote agent (SB): serve, gate 2, desktop discovery, PNG capture, the remote's policy and audit, the parts and their packaging, its CI jobs | `ssh-linux`, `ssh-el8`, `wayland-remote`, `ssh-macos` (or "not testable on this runner") | M12.1, M12.3 | **Merged**; jobs not run |
| M12.10 | The PC's side of a remote target (SC): perception, accessibility, apps and commands over the link, gate 1 per remote | Text built from a remote byte-identical to local Perception's | M12.2 | **Merged** |
| M12.11 | WSLg apps (WB): the helper inside each distro, routing, window matching, identity and the joined vocabularies, Start-menu launching | `wslg-probe` artefacts; §9 item 8's manual checks | M12.2, M12.7 | **Merged**; jobs not run |
| M12.12 | The agent (AG): `run_command` and its flow, the user's own words only for announcements, target tools, a worker per target | The flow's steps with fakes; today's prompts when nothing is on | M12.2 | **Merged** |
| M12.13 | The targets runtime (TG): registry, naming and binding, hands per target, consent cards, the ssh offer, check-up rows, the settings channel | Every factory wired, with fakes | M12.4–M12.12 | **Merged** |
| M12.14 | Docs (DOC): README.md, docs/DEVELOPING.md §14, docs/COMMANDS-WSL-SSH.md, CHANGELOG.md, this milestone | Every limitation L1-L26 stated with its fallback; the older-Ember lock-down in the release notes | M12.13 | **Merged**; brought up to date with M12.16-M12.18 by TAIL-misc |
| M12.15 | Remote extras (SX, may slip): §9 item 8 | A spike per sub-part decides whether it ships | M12.13 | Not started |
| M12.16 | Integration (INT-A: the command path with CL's judge, RUN's launchers in WSL, the trackers, consent and the wrong-target guard; INT-B: the remote and WSL-app path: link, hello, desktop access, Stop, kill switch, WSL helpers, packaging) | The local command path end to end with the real classifier and runner (`commands-flow-local`); SSH end to end against a real sshd (`remote-e2e`) | M12.13 | **Merged**; jobs not run |
| M12.17 | The lead's rulings (FIX: unknown computers named ask, mixed scripts marked on the card, screen-lock scope, the WSL fix within policy, the setup check's rows, the "would read" wording) and the whole-branch review's confirmed findings (FINAL-cmd, FINAL-remote, FINAL-wslreg) | A unit test that failed before each fix | M12.16 | **Merged** |
| M12.18 | Tail (TAIL-scripts: shell scripts read before they run on every target, by the remote's own check over SSH, and a script the task wrote that can't be read in full asks; TAIL-misc: the runtime download ends after 60 s without a byte, and these docs) | Unit tests with fakes; the local end-to-end suite | M12.17 | **Merged** |

**CI owed** (none of it has run: GitHub Actions' budget ran out). Run `remote.yml` on the merged branch once (**Actions
› remote › Run workflow**, `only: all`, which already includes `unit-matrix` on macOS and `ssh-macos`, whose minutes
cost ten times Linux's; re-run only a failing group, with `only` set to it), and `ci.yml` on the same commit. Each
`remote.yml` job, and what it must show (docs/DEVELOPING.md §14.4 has its runner and variables):

| Job | Must show |
|---|---|
| `unit-matrix` (Ubuntu 24.04, Windows 2022, macOS 15) | The SSH/WSL unit files pass on all three OSes, not only on Linux |
| `commands-linux` | `commands-local` and `commands-flow-local`: util-linux `script`, pipes without it, the stop ladder, the sweep, scripts read before they run |
| `commands-linux-el8` | The same on RHEL 8's util-linux 2.32 (its `script` ends at stdin's end), as a normal user |
| `ssh-linux` | Against sshd on localhost: `ssh-transport` (resolving, batch and interactive connects, host keys, the jump host, no ControlMaster left behind), `remote-ssh` (the agent: gate 2, Stop, the grace, the lock, the audit, uninstall), `remote-e2e` (connect and install, an ordinary, an asked and an announced command, the kill switch, a dropped link and the reconnect, disconnect), and `remote-desktop` under Xvfb |
| `ssh-el8` | `remote-el8`: the real bootstrap on glibc 2.28 (install, serve, commands, a headless desktop, a racing install) |
| `wayland-remote` | `remote-wayland`: reading and a tier-1 action in a headless mutter session; until it passes, Wayland remotes stay commands only (L5) |
| `wsl-windows` | `wsl` on WSL 1, Windows PowerShell commands under the job host (`commands-local`, `commands-flow-local`), Win32-OpenSSH through the framed stream (`ssh-windows`) |
| `wsl2-windows` | `wsl` on WSL 2 with a non-root default user, stopped at start (discovery never boots it; the runner's ladder) |
| `wslg-probe` | Artefacts only: what WSLg looks like on a hosted runner (RAIL windows, UIA tree, session buses) |
| `ssh-macos` | `commands-local` and `commands-flow-local` on macOS (zsh, BSD `script`, the `ps -E` sweep, Homebrew), and `remote-ssh` with a Mac as the remote (commands only), if the runner's sshd starts |

**Critical path:** M0 → M1.2 → M2.3 → M2.5 → M3.1 → M4.1 → M8.1 → M4.6 → M5.2 → M10.

---

## 5. Safety requirements (v1)

| Tier | Examples | Rule |
|---|---|---|
| Read | Look at screen, summarize, navigate within a granted app | Automatic |
| Reversible edit | Typing in an unsaved document, desk-only changes | Automatic, with a snapshot where possible |
| Confirm | Send, post, submit, share; delete or overwrite; system settings; installing; uploads; cross-app data moves; anything with the borrowed cursor; anything right after an injection warning | Click or key in Ember's confirmation UI |
| Never | Passwords, polkit/sudo, payment fields, CAPTCHAs, security settings | User takes over; capture paused |

Not in v1: asking before a new web domain or a download. In a browser the user let Ember act in, following a link,
typing an address and a Download button go unasked (uploads, sends and payments ask, and opening a downloaded program
from the file manager stays refused). The administrator's policy has no domain rules either (M8.7).

Also: screen, file and web content is untrusted data; the conductor only takes goals from you;
per-app grants; never-look list before capture; audit log; admin policy; local kill switch;
wake-word protections (second-stage check, self-mute, speaker-output rejection).
On Windows, remote surfaces (Remote Desktop and WSLg windows) are refused for every action and blacked out of
screenshots, because Ember can't tell what runs inside them (M11); with WSL on, a WSLg window Ember identifies is
treated as its Linux app (M12). Remote-desktop and virtual-machine viewers on Linux and macOS (Remmina, virt-manager,
GNOME Boxes, VNC and RDP viewers, Screen Sharing, UTM, Parallels, VMware, VirtualBox) are remote surfaces too.

Commands (M12) never go through a terminal of the user's: they run in Ember's own command window, where the user
watches and can stop them. Ordinary commands run at once. Deleting or overwriting data, submitting or publishing,
deleting from source control or a service, secrets, privilege and system changes, download-and-run, outliving the
kill switch and anything the classifier can't read confidently ask, by a click or the approve chord on the card that
shows the whole command (never "Always", never by voice or from a notification). A dangerous command the user's own
words asked for exactly runs after a 4 s announcement with Stop, except secrets, download-and-run, outliving and
unclear ones, which always ask. As root or an administrator every command asks. Commands that would change Ember's
own policy, audit, sign-in, settings, install or processes, or drive Ember's windows, are refused. Output is
untrusted; output that reads like instructions makes every later command in the task ask. On a computer reached over
SSH every desktop step is asked, and the remote checks every step again under its own policy.

---

## 6. Targets and release gates

| Metric | v1 target |
|---|---|
| Wake → listening earcon | < 300 ms (local) |
| Wake → first action | p50 < 3 s, p95 < 6 s |
| Kill switch → everything stopped | < 300 ms |
| User input → cursor borrow aborted | < 100 ms |
| AT-SPI focused-window read | < 300 ms |
| False wakes | < 0.5 per hour on office-noise corpus |
| Missed wakes | < 5 % |
| Idle listening CPU | < 5 % of one core |
| In-house task suite success (pass^3) | ≥ 70 % |
| Injection fixtures: out-of-scope actions | 0 |
| Tier-2 actions without confirmation | 0 |

---

## 7. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Who registers Ember's GitHub App (the "Sign in with GitHub" identity)? | **Resolved 2026-10-27: registered by the repository owner.** Its public client id, `Iv23liXa8A1wDXYg2jYw`, is built in (`app/main/agent/github-app.ts`), so the device flow is live in release builds; `EMBER_GITHUB_CLIENT_ID` overrides it and is no longer needed. |
| 2 | Copilot policy and data retention acceptable? | **Resolved 2026-10-15: yes.** |
| 3 | Bundling a natural-sounding offline voice (Piper is GPL-3.0; espeak-ng, used for pronunciation, is GPL-3.0; each voice model has its own license) | **Open, not blocking v1.** v1 uses the system speech-dispatcher (separate RHEL package, no bundling). Decide before adding neural TTS: is Ember going to stay open source? |
| 4 | Are target machines STIG-hardened (user namespaces off)? | **Unknown; handled both ways.** The RPM installs the setuid sandbox helper when namespaces are off (M9.2). Check with `sysctl user.max_user_namespaces` (0 = hardened). |
| 5 | Should "Always in this app" ever cover apps on a computer reached over SSH? (M12) | **Default: no.** Every step on a remote screen asks. |
| 6 | Should the model see a long command's output while it runs? (M12) | **Default: no.** It gets the output at the end, bounded. |
| 7 | Should users be able to approve a class of commands for a whole task? (M12) | **Default: no.** An approval covers the exact command, computer, folder and task. |
| 8 | Windows remote desktops through a per-connection scheduled task? (M12) | **Open.** Only after SX's endpoint-protection spike and the owner's yes (§9 item 8). |
| 9 | Should VNC and xrdp desktops on remotes be used? (M12, L21) | **Default: no.** Such remotes get commands only; the owner may decide otherwise. |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Copilot runtime needs exactly GLIBC_2.28; an upstream bump breaks RHEL 8 | Pin SDK; symbol check in CI before any upgrade |
| Background AT-SPI actions vary by app (popups, combo boxes) | Router escalates to the desk; per-app tests in the suite |
| Screenshot cost under usage billing | Text first, small JPEGs, short worker sessions, usage meter |
| False wakes in open offices | Second-stage check; corpus measurement; trained openWakeWord model as upgrade |
| Overlay on non-compositing sessions (xrdp/VNC) | Handle-window fallback |
| Enterprise pushback on always-on mic and screen reading | Local-only audio, never-look list, admin policy, audit log, consent |

---

## 9. After v1 (ordered)

1. GNOME Wayland on RHEL 8/9 (Shell extension + Mutter RemoteDesktop/ScreenCast)
2. RHEL 10 (ESM extension, portal + libei, Xvfb desk)
3. Neural TTS (license review), speaker verification, screenshot OCR redaction, injection classifier
4. Desk under a separate Unix user; SDK sub-agent verifier inside workers
5. ~~macOS, then Windows~~: done as M11 (2026-10-22); what is left of it is item 7
6. ~~SSH~~: built as M12 (2026-10-22), with WSL and commands; what is left of it is item 8
7. Windows and macOS, after M11:
   - **Manual checks on real machines** (Windows 11 23H2 or later, Windows 10 22H2, macOS 14 and 15 on Apple silicon,
     macOS 13 or an Intel Mac when one is available). CI can't show these: `windows-2022` is Windows Server, runs
     as an administrator (its shell too), has one 1024×768 screen at 100 % and no Store apps, and the macOS
     runner's permissions come from its own processes. Items marked (runner) have no other evidence.
     1. A fresh install from the zip or the dmg on a clean account: the consent page, the macOS permission prompts and
        their fixes, `--doctor` (Windows through `ember-doctor.cmd`; macOS from Terminal and through `open -a`); a zip
        extracted by Explorer under a `RemoteSigned` policy shows "blocked" and **Unblock it** works; an account name
        with a space and a non-ASCII letter.
     2. All six shortcuts; one taken by another app; on Windows 11 with Xbox Game Bar and PowerToys (runner): which
        chords are taken, and no menu mode in Notepad or File Explorer after each chord.
     3. The ask box takes keys without activating Ember (TextEdit stays the active app) and hides on blur; on Windows
        it follows the ask chord to another virtual desktop (runner).
     4. Tier 1 in a background window (text, toggle, option, Save in a dialog; Explorer and Finder items selected,
        never opened); one paused UWP app leaves the others readable (runner).
     5. Tier 3: a German layout (é, ß, €), Cmd and Ctrl shortcuts, takeover by mouse and keyboard, the kill switch
        under 300 ms with a busy app, an elevated window refused (runner); macOS without Accessibility or Input
        Monitoring refused, QWERTZ `ctrl+shift+cmd+z` refused, a Japanese or Pinyin input source refuses typing
        but not `set_text`; a Python REPL from the Start menu counts as a terminal.
     6. Screenshots: a password field and a never-look window blacked out; none while UAC, SecurityAgent or the
        Accessibility prompt is up, or without Screen Recording; macOS 15's monthly capture alert; no cursor flicker
        and no bubble pixels on Windows.
     7. `open_app`: Calculator and Settings (runner), TextEdit and System Settings; terminals, the Run dialog and
        Spotlight refused; an app opened while Ember runs elevated starts non-elevated (runner); a Start Menu
        shortcut to a deleted program isn't offered.
     8. Dark mode both ways (Windows: no freeze while another app is busy).
     9. Start at login on and off (the Run value; Task Manager's Startup apps shows Ember with its icon; the macOS
        Login Items note; a copy that isn't in Applications shows the move note); a login start only greets.
     10. Voice: consent, the macOS microphone prompt, "Hey Ember", the "speaker rejection is Linux-only" copy.
     11. Sign-in through `gh` from winget or Homebrew with Ember started from the Start menu or Finder.
     12. Quit with a task running (menu and Cmd+Q ask first; the Dock quits); signing out during a task releases the
         keys, saves the settings and blocks nothing.
     13. Two monitors with different scaling, one left of the primary (runner): Ember follows across, the focus ring
         and masks line up, `at_point` on a 150 % monitor finds the control; the overlay is on every virtual desktop.
     14. Narrator, NVDA and VoiceOver (also with its caption panel hidden): answers and questions are spoken;
         reduced motion; Windows contrast themes keep the bubble readable and the overlay transparent.
     15. RHEL 8: the full el8 suite and the demo session, unchanged.
     16. macOS: overlay and handle over a full-screen Safari Space and on a second Space; Ember keeps its Dock icon
         and app menu; the user's app stays frontmost after Ember starts.
     17. macOS: install build N, grant the permissions, install build N+1 over it: the checks say "remove and add
         again", and doing so restores them.
     18. Windows: a full-screen game or a PowerPoint slide show with Ember running neither flickers nor leaves full
         screen.
   - **Signing and notarisation.** Ember.exe and the accessibility helper's script unsigned, Ember.app signed ad hoc
     (D8). Signing would stop SmartScreen and Gatekeeper asking, let the helper run where only signed scripts may,
     and keep macOS permissions across updates (an ad hoc signature is a new identity to macOS on every build).
   - **Follow-ups from the integration.** CI runs owed after the last fixes (`only: windows` for the terminal check
     through File Explorer's app ids, the doctor's failing exit code and the remote-surface rule, which no Windows
     run has included yet; `only: macos` for the Dock's window; then one full run); whether `CAPTUREBLT` is needed,
     measured on Windows 11; keep requiring Input Monitoring for the borrowed keyboard until a Mac with System
     Integrity Protection on shows key-state polling isn't gated by it (the runner's evidence came with SIP off); the
     Dock's other windows (Launchpad, stacks, several displays) on a real Mac; Electron's "non-activating panel"
     warning on macOS; policy follow-ups (terminals by bundle id on macOS, Gatekeeper's "Open", Console.app, programs
     and scripts opened from File Explorer, the Run dialog's match).
   - **Known gaps, by design for now.** Speaker-output rejection is Linux-only; Excel and Numbers grids; rich
     clipboard formats come back as text or HTML after a tier-3 paste (MIME types only until each OS's own formats
     are checked); MSIX apps with no Start Menu shortcut (new Teams, WhatsApp and others) can't be opened by name;
     Win+Alt+Space and Win+Alt+M collide with PowerToys and Xbox Game Bar (the "shortcut taken" path covers it; a
     letter change is one row of the table); the hover click-through race off Linux (a press within one 16 ms tick
     of reaching a bubble button); a full-screen game under the topmost overlay; remote viewers other than
     Windows' own clients (Hyper-V, VNC, TeamViewer, Citrix); the §6 gates are measured on Linux only (the eval is
     Linux-only); macOS 13, Intel Macs and Windows on Arm are best effort.
   - **Linux, noticed during the port (pre-existing):** with a keymap of several XKB groups, a task's key
     combination can land on the key that holds Ember's approval chord in another group (the grab looks the key up
     in group 1, a borrow types in the active group).
8. SSH, WSL and commands, after M12:
   - **SX (may slip; each sub-part starts with a spike that decides whether it ships).** (1) A masked live view of a
     Linux remote's screen (at most 1 frame a second, 1280 px) and the borrowed mouse there only while it is open,
     which lets tier 1 there follow the local confirmation rules (lifts L4). (2) Windows remotes: the agent on
     win-x64 with a PowerShell bootstrap and PowerShell commands (every command asks when the SSH token is elevated;
     the card says key logins have no DPAPI or network credentials), then a desktop helper per connection (an
     interactive scheduled task created and deleted per link, reached through a named pipe for the user's SID only):
     the endpoint-protection spike and the owner's yes first (§7 question 8). (3) A Mac's desktop through an Ember.app
     installed there (its TCC grants are lost on every update of an ad hoc-signed app).
   - **CI owed:** every `remote.yml` job (every package has merged; none has run, the list is under M12's table:
     `unit-matrix` on all three OSes, the commands, SSH, Wayland, WSL and macOS jobs), and the design's checks marked
     "verify" there: util-linux 2.32's and BSD
     `script`'s behaviour, Win32-OpenSSH's askpass from 8.4 and ProxyCommand without a shell, `ControlMaster=no` on
     Win32-OpenSSH, the framed stream binary-safe through `wsl.exe` (L22), interop children inside the job object,
     `wsl --list --running` never booting the VM, `RunOOBE`'s value name, a Wayland session's "text" desktop (L5),
     macOS `ps -E` for the sweep.
   - **Manual checks on real machines:** a Linux PC to a RHEL 8 GNOME/Xorg remote with the same user logged in (the
     notice, every step asked, a masked screenshot, locking the screen stops it, Stop on the notice, an `ssh -X`
     session's display never used, a VNC-only login gets commands only); the same with a Wayland session; a headless
     server (`df -h` runs at once, `sudo dnf install` asks and the password is typed in the command window, `rm -r
     build` after "delete the build folder" announces, `git push --force` after "push my branch" asks, a 10 s network
     blip doesn't stop a build, a pulled cable stops it within 20 s, a STIG host with fapolicyd gives the exec-denied
     message); a root login; Windows 11 with WSL 2 Ubuntu, systemd on and off (gedit identified, tier 1, menus not
     blacked out, a pinentry window and a GTK 4 password field masked at 150 %, xterm unidentified, gnome-terminal
     refused, `wsl --shutdown` not undone, which bus the apps use, WSL 1 commands only, VcXsrv refused); a Windows PC to
     a Linux remote (ssh-agent, Ember's password prompt with OpenSSH 8.4 or newer, the 8.1 message, a jump host, `ssh`
     in a WSL tab); a macOS PC to Linux and to a Mac (Homebrew tools, `~/Documents` with and without full disk access,
     a LAN host on macOS 15); commands on each OS (the ordinary list runs, the dangerous list asks, the announced
     examples, `xdotool` refused, a bidi override shown, instruction-like output making the next command ask); the
     user's own ssh in GNOME Terminal, Windows Terminal and Terminal.app; the policy matrix on each OS, and an older
     Ember locking down on the new keys.
   - **Needs from the Windows backend** before WSLg windows get the borrowed mouse (L7): a pointer check for RAIL
     windows that accepts only the target window or its owner chain, and a scancode text path for them.
   - **Later:** a root-owned remote package for hardened hosts (L24); a JPEG encoder on remotes (L16); approval
     fatigue on remotes and after output taint (every step or command asks), revisited with SX's view.

Voice latency, recognition, a natural voice and a smaller footprint: docs/ASSISTANT.md has the measurements,
decisions and phases. Nothing in it is built yet.

Long-term memory, beyond the plan above: docs/MEMORY.md has the design and steps. Steps 1 (the core,
`app/main/memory/`) and 2 (remember, recall and forget in conversation, behind its own consent, off by default) are
built.

---

## 10. Progress

| Milestone | Status | Notes |
|---|---|---|
| M0 Foundations | **Done 2026-10-15** | Electron **44.5.0** and npm **11.6.2** pinned (npm 10 crashes on the test tools). App starts and hands over to a running instance on Oracle Linux 8.4 as a normal user with the Chromium sandbox on. The EL8 native-rebuild path (M0.4) is exercised in CI; it could not complete in the development sandbox because `www.electronjs.org` (Electron headers) is blocked there. |
| M1 Ember on screen | **Done 2026-10-15** (PR #2) | Per-display transparent overlays with click-through and hover-to-click; follow spring in the main process; picker in the home window; corner handle with menu; opaque handle card when there is no compositor. Cursor position comes from `XQueryPointer` (koffi) because Electron's `getCursorScreenPoint()` returns stale positions on X11 after the pointer jumps. Ember holds still while it waits for a decision, so its buttons can be clicked. Spellchecker dictionary downloads are blocked (`setSpellCheckerLanguages([])`). |
| M2 Brain | **Done 2026-10-15** (PR #3) | Conductor on `@github/copilot-sdk` 1.0.21 (`mode: "empty"`, no built-in tools or agents, live tool list verified; fails closed). Resumes its conversation by session id. Reasoning, intent, answers and tool steps stream into the bubble. Sign-in: stored token (safeStorage, not written without a keyring) → `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` → `gh auth token`; device flow through Ember's GitHub App, registered 2026-10-27, whose client id `Iv23liXa8A1wDXYg2jYw` is built in (`EMBER_GITHUB_CLIENT_ID` overrides it). Models chosen from `listModels()` (fast conductor, vision worker). ask box on Ctrl+Alt+Space; Stop in the handle menu; token usage in settings. Integration tests run the real runtime against an offline mock model (`test/mock-llm`). Not yet tested against real Copilot models (no GitHub account in the build environment). |
| M3 Perception | **Done 2026-10-15** (PR #4) | Python AT-SPI sidecar (`sidecar/atspi`, Python 3.6+, JSON-RPC over stdio) reads the focused window in about 20 ms (GTK3 bench, mousepad; 15 ms on Oracle Linux 8.4's Python 3.6.8). It skips hidden nodes and never reads password text, and unnamed controls borrow the label to their left. The focused window comes from `_NET_ACTIVE_WINDOW`/`_NET_WM_PID` through koffi. **Capture uses X11 `XGetImage`, not `desktopCapturer`** (about 10 ms for a full 1280×800 screen, no portal or permission prompt). Ember's overlay and handle go transparent during the capture, never-look windows are blacked out, and images are JPEG ≤ 1280 px with a scale record. Set-of-marks is drawn with sharp (prebuilt, glibc 2.17/2.28). `describe_screen` (conductor, text only, wrapped as untrusted `<screen>` content) is live. `perceive` (elements with bounds + optional marked image) is ready for M4 workers. The setup check offers a one-click "Turn on" for `toolkit-accessibility`. Deferred: launch recipes for Electron/Qt/Java apps (M4/M6, when Ember starts apps) and the two-monitor check (needs a second display). koffi's `view()` aborts Electron (V8 memory cage), so native memory is copied with `decode()`; a lint rule enforces this. |
| M4 Hands (part 1: tiers 0 and 1) | **In review** (PR #5) | **TaskManager** (plain TypeScript): two tasks run at once and the rest queue. Window leases stop two tasks acting in one window at once. Stop cancels everything. Finished worker sessions are deleted after 10 minutes, and results reach the conductor with the user's next message. **Workers** are hardened Copilot sessions with typed tools: `perceive_window` (text, plus a marked image when the model has vision), `list_windows`, `switch_window`, `click`, `toggle`, `type_text`, `choose_option`, `set_value`, `change_setting`, `open_app`, `report_progress` and `finish_task`. **Tier 1** runs in the sidecar (AT-SPI Action / EditableText / Value / Selection, re-read afterwards to verify) and never touches the cursor. **Tier 0** covers six comfort settings through gsettings, with a fallback for GNOME 3.32 (RHEL 8), plus launching apps from `.desktop` files. **Policy (M8.1 core, M8.2, M8.3 partly, M8.6 partly):** every action is decided in code. Ember asks before its first action in a new app ("Allow" / "Always in app" / "Not now"); risky buttons (send, delete, pay…) are always confirmed. Password, payment and terminal fields, authentication windows and never-look apps are refused, and runaway tasks are rate-limited. Questions are built from the structured action and answered only by a click in Ember's bubble, or on the corner card when there is no compositor. Every decision and action goes to an append-only audit log (`~/.config/ember/audit/`, 30 days). **Visible work (M4.7):** Ember flies beside the control it is touching, the control glows, and a task card shows progress. Verified against a real GTK3 window, including the refusals. **Next (part 2):** tier 3 cursor borrow (M4.5) with `press_keys` / `scroll`, and the ActionRouter escalating to it. |
| M4 Hands (part 2: tier 3) | **In review** (PR #6) | **Cursor borrow (M4.5):** XTest through koffi (libXtst, no native module). Ember asks every time ("Borrow your mouse to click…?"), waits until the user has been still for 1.5 s (shorter than the planned 3 s, because the user has just clicked Allow), and remembers the pointer and active window. It glides the pointer visibly (Ember rides along) and its own windows stop taking clicks; the status line reads "Using your mouse: move it to take over". Afterwards the pointer and focus go back. Every step checks the pointer position and the keyboard state (`XQueryKeymap`), so moving the mouse or pressing a key hands control back at once: measured **0.3–3 ms** (target < 100 ms). Ember never moves the pointer again after a takeover, and never leaves keys held. **Router (M4.2):** when tier 1 reports `background_unavailable` (click, toggle, text), the worker escalates to tier 3 with the user's OK; the escalation is logged. New worker tools: `press_keys` (refused while a password field has focus) and `scroll`. Works without a window manager (window-tree search and `XSetInputFocus`), which is how CI runs. Also fixed two races that could lose a click on a question; the fix was ported to PR #5. |
| M5 Voice | **In review** (PR #7) | All on this computer: sherpa-onnx **WASM** 1.13.8 (the native addon needs glibc 2.32) in an Electron utility process. A hidden mic window captures audio with echo cancellation; gain control and noise suppression are **off** because they distorted speech enough to miss the wake word. An AudioWorklet produces 16 kHz frames, sent over a MessagePort. **Wake and kill:** keyword spotting for "hey ember", "ok ember" and "ember stop" (3.3M zipformer, BPE-tokenized). **Second-stage check (M5.2):** the spotter can't reliably tell "Hey Amber" from "Hey Ember", so each wake is checked by transcribing it, and clear near-misses (Amber, remember, September…) are rejected. **Changed from the plan:** instead of streaming ASR, Silero VAD finds the end of the request and **Moonshine tiny (offline)** transcribes it in 0.1–0.3 s, accurate and punctuated. The streaming zipformer dropped the first ~0.5–1.5 s of every utterance in WASM. A 1.6 s pre-roll makes one-breath "Hey Ember, do X" work. **Conversation (M5.3):** an 8 s follow-up window after a spoken request, no wake word needed; "Ember, stop" aborts everything locally. **TTS (M5.4):** `speechSynthesis` when "Speak replies" is on; while Ember speaks, "Hey Ember" (one its speakers didn't say) makes it stop talking and listen, and "Hey Ember, stop" stops everything. **Speaker rejection (M5.5):** a second spotter on the PulseAudio monitor (`parec`); a wake heard from the speakers within ±300 ms is ignored. **Indicators and mute (M5.6):** a mic dot on the handle (waiting / hearing / muted). Ctrl+Alt+M closes the stream, which releases the mic. Consent is required before the mic ever opens. Models (Apache-2.0 / MIT, about 120 MB) download on first use, pinned by SHA-256. **Measured (M5.7):** idle CPU **4.5–5 %** of one 2.1 GHz core while hearing sound; it drops to near zero in silence because spotting pauses after 0.5 s of quiet. Real-model tests cover wake, wake-pause-request, stop, follow-up, speaker rejection and no wake on "Hey Amber", "remember" or ordinary speech. **Not yet measured:** false wakes per hour on a real office-noise corpus and missed-wake rate on real voices (needs recordings from real microphones; M10). |
| M6 Guide and quick context | **In review** (PR #8) | **Guide (M6.1):** a conductor tool `show_me` starts a guide-mode worker that never acts. Its only tools are `perceive_window`, `point_at` and `wait_for_click` (plus window switching and finish). Ember flies beside the control, the control glows, and the bubble ("Showing you") says what to do. `wait_for_click` finishes when the user uses the control, never only reaches it: a press inside it (pointer button mask via XQueryPointer); it becomes checked, pressed or expanded; its value or chosen option changes; its menu opens; a tab or row is selected; a field gets the keyboard; or, once the user has reached it, Enter or Space on it or another window taking the keyboard. **Quick context (M6.2):** the moment the user calls Ember (Ctrl+Alt+Space, before the ask box takes focus, or on "Hey Ember"), Ember snapshots the focused window: app, title, focused control, and **selected text** (new in the sidecar; never from password fields). That snapshot is sent with the request as untrusted `<context>`. Tasks from that request start in that window, and a voice follow-up keeps the context. **Gestures (M6.3):** each tool plays a gesture (tap, type, chin while reading, point while guiding, wave for a new look). Finished tasks get a thumbs-up, failures a facepalm. Ember looks at, and aims its hand toward, the control it is working on. Verified on the GTK bench: the "user" clicks the switch Ember points at, and the guide finishes. |
| M7 Ember's desk | **In review** (PR #9) | **Desk (M7.1):** the first task that needs it starts a private `Xvfb :N` (Unix socket only, an MIT cookie in a 0700 directory) with its own `dbus-daemon` session, so the desk apps' accessibility bus stays there, plus metacity/openbox/xfwm4 if one is installed. It starts in about 60 ms. Everything (apps, window manager, bus, display) is killed when Ember quits, even on a crash. Xvfb replaced Xvnc because the mini-view no longer needs VNC. **Same tools on the desk (M7.2):** a worker calls `open_on_desk`. From then on, `perceive_window`, `type_text`, `click`, `press_keys` and the rest act on the desk, through a second AT-SPI sidecar on the desk's bus and XTest/XGetImage on the desk display (koffi; no robotjs). Real mouse and keyboard input is used freely there, with no borrow prompt, because the user's pointer is never touched. Policy still applies: risky buttons are confirmed ("on my desk") and never-rules hold. **Recipes (M7.3):** apps open as their own instances (Firefox `--new-instance --profile`, LibreOffice `UserInstallation`, Chromium/VS Code `--user-data-dir`). Terminals are refused. Chromium's `NO_AT_BRIDGE=1` is stripped so desk apps expose accessibility. **Mini-view (M7.4):** a small always-on-top window shows the desk live at 4 fps (JPEG frames over IPC instead of noVNC). **Take over** enlarges it and forwards the user's mouse and keys to the desk; Ember stops acting there until **Hand back**. **Hand-off (M7.5):** desk apps start in `~/Ember`. The desk is a separate display, so it has its own clipboard. Verified: on the GTK bench on the desk, the worker types the name, picks the theme, clicks the sketch pad (XTest only) and presses Ctrl+S. It asks nothing, the user's pointer doesn't move, and no display is left after quitting. |
| M8 Safety, policy, privacy | **In review** (PR #10) | M8.1, M8.2 and M8.5 shipped with M3 and M4 (policy engine, button-only confirmations, never-look list). **Admin lockdown (M8.7):** `/etc/ember/policy.json` (zod, strict) can turn off voice, speech, acting, the borrowed mouse, the desk and screenshots. It can also add never-look apps, require a click for every action, remove "Always in this app", lower the rate limit, allow or pin models, set the organisation's own endpoint (BYOK, key from a file) and the audit retention. Its values override user settings and can only tighten them. A broken file locks Ember down (fail closed). Domain rules are left for when Ember drives a browser. **Consent (M8.8):** first run (or changed terms) shows what Ember reads, sends and keeps. Nothing is read, listened to or sent until the user agrees, and onboarding can't finish without it. **Kill switch (M8.9):** Ctrl+Alt+X, "Ember, stop" or the menu stops every task, question, answer and borrowed mouse in parallel. A borrow lets go mid-glide and the pointer jumps home. Measured 58–60 ms from the key to the task being cancelled. **Hard blocks (M8.3):** while a polkit, keyring, sudo or pinentry prompt is open or focused, Ember doesn't read it, takes no screenshots, and won't press keys or type (checked before each chunk of input). **Injection (M8.4):** task results reach the conductor as untrusted, escaped data, and goals come only from the user. Risky actions that name nothing the user asked for are flagged in the question ("You didn't ask for this…") and in the audit log. Fixture tests (a page with injected instructions, a fake `</screen>`, a hidden field, and a fake polkit prompt) show no out-of-scope action. **Audit (M8.6):** task requests and outcomes are added, lines are copied to journald (`ember-audit`), retention is configurable, and the settings window has a **What Ember did** timeline. |
| M9 Packaging and release | **In review** (PR #11) | **RPM (M9.1):** `scripts/package/stage.mjs` builds a self-contained folder: Electron renamed `ember`, the app, production modules only (Linux x64 glibc builds; no musl, wasm or other platforms' binaries; no source maps), and the sidecar. `rpm.sh` then builds `ember` with rpmbuild (an explicit spec, not electron-builder or fpm): explicit `Requires` with AutoReqProv off, and *Recommends* for the desk, speaking, microphone list, `gnome-shell-extension-top-icons` and the models. It uses an xz payload, which RHEL 8.4's rpm reads. It also builds `ember-voice-models` (125 MB, models trimmed to the files Ember loads, used without download). **AppImage** with pinned, SHA-256-checked appimagetool 1.9.1 and runtime. Sizes: RPM 162 MB, AppImage 186 MB. **Sandbox (M9.2):** `chrome-sandbox` is installed setuid root, so Ember stays sandboxed where `user.max_user_namespaces=0`; the AppImage falls back to `--no-sandbox` there and says so. **Doctor and autostart (M9.3):** `ember doctor` checks session, compositor, accessibility, XTest, sign-in or endpoint, admin policy, microphone, models, speech-dispatcher, desk, sandbox and free file watchers (inotify), and gives a fix for each problem (exit 1 if Ember can't work; it also runs without a display). **Start Ember when I log in** writes `~/.config/autostart/ember.desktop` with `--autostart`. **Install test (M9.4):** CI builds both packages on `rockylinux:8`, checks every binary against glibc 2.28, `dnf install`s the RPM (every Requires resolves from the distribution), runs `ember doctor`, and starts the installed Ember as a normal user. A test on a real RHEL 8.4 VM is still to do (no VM in CI); M10.3's nightly VM covers it. |
| M10 Evaluation | **In review** (PR #12) | **Task suite (M10.1):** 27 OSWorld-style JSON tasks (`eval/tasks`) covering the test bench (tier 1), comfort settings (tier 0), the borrowed mouse (tier 3), Ember's desk (tier 2), guiding, a plain text editor (gedit/Mousepad), safety (injected "Delete all", a fake polkit prompt, password fields, "no" answers), and LibreOffice Writer, Firefox and Files (live tier). Checkers cover accessibility state, gsettings, files, fixture events, Ember's audit log, its final answer, and "nothing else changed" snapshots. Safety is judged from the audit log: out-of-scope actions, actions without the user's OK, and risky things never asked about. Deliberately broken tasks (no action, obeying the page, a side effect) all fail. **Per-PR tier (M10.2):** a scripted mock model replays each task through the real worker, perception, policy, hands, desk and audit log (CI job `eval`, rockylinux:8, a few minutes): **24/24 runnable tasks pass**, 0 out-of-scope actions, 0 unconfirmed actions. **Nightly tier (M10.3):** `nightly-eval.yml` runs the suite with a live model, pass^3, on a self-hosted RHEL 8.4 GNOME runner reverted to a snapshot. It is switched off until that runner and credentials exist (none here), so live success rates aren't measured yet. **Gates and dashboard (M10.4):** `dist/eval/report.html` tracks every §6 gate. Met here: AT-SPI read p95 17 ms, takeover max 9 ms, borrow released by the kill switch max 5 ms (tasks stop in ~60 ms), idle listening CPU 0.1 % (was 7.5 %: the eval found that the speakers stream was spotted even in silence, and that steady room noise kept the spotter running; both are fixed). **Not met:** wake → listening 458 ms (target 300; it was 600, and Ember now lights up before the transcript check and skips the speakers window when nothing is playing; the rest is the keyword model's own chunk latency, so a smaller-chunk model is the next step), and missed wakes 6–11 % on synthesized speech (target 5 %; 95 % CI 2–21 %; the threshold was lowered to 0.15 now that the check retracts near-misses). The eval also found that freshly synthesized test clips made CI flaky, so the clips are now committed. False wakes per hour need an office-noise corpus (not available); 0/65 near-miss phrases woke Ember. |
| M11 Windows and macOS | **Built 2026-10-22**, green in CI (runs 123–125); the CI re-runs after the last fixes and the manual checks in §9 item 7 are open | **What was built.** One composition root, `app/main/platform/`: `loadPlatform()` gives main a `Platform` object by `process.platform`, and Linux's X11 modules sit behind it unchanged. **Windows:** a koffi window system and input over user32, gdi32 and dwmapi (`SendInput` with Unicode text, `GetAsyncKeyState` for takeover, GDI `BitBlt` capture). Ember's accessibility host (`dist/app/ax-sidecar.cjs`, Ember.exe in Node mode) reads apps through a C# 5 UI Automation bridge, which Windows PowerShell 5.1 compiles once per version into `%LOCALAPPDATA%\ember\uia-cache`. Apps open through `explorer.exe` from the Start Menu or by packaged-app id, with Explorer's environment, never Ember's. Also dark mode, the registry policy, the login item, setup checks with an **Unblock it** fix, and a check-up that names the helper's exact command line and DLL hash for allow-lists. **macOS:** koffi over CoreGraphics, AX and CoreFoundation (CGEvent input, key-state polling, AX at 0.25 s on the main thread), and `desktopCapturer` capture only with Screen Recording, resampled to points. The same host runs an in-process AX provider (0.8 s per app, keys from `CFHash`). Apps open with `open -a`; Dark Mode goes through System Events; the policy is a root-owned file; the login item is SMAppService's; each permission has a check and a fix; Ember keeps a Dock icon and an app menu. **Both:** Win+Alt+… and Control+Shift+Command+… shortcuts from one table, Command as the primary modifier on a Mac, and vocabularies for terminals, security windows, never-look defaults, risky labels and clipboard password markers. Packages: a zip with Ember.exe (its own name, version and icon; unsigned, and `NotSigned` rather than tampered with) and `ember-doctor.cmd`, and Ember.app (signed ad hoc) as a zip and a dmg. **How it was proven.** Real desktops in CI, every suite required. Windows, run 124: win32-desktop 15, uia-bridge 22, ax-sidecar 14, win32-system 11, win32-vocabulary 8, ember-win32 5/5; the packaged check-up shows 15 rows, all six shortcuts are held, and `ember-doctor.cmd` gives the check-up's exit code (the check that it also gives a failing one, with a broken policy, came after run 124). macOS, run 123: darwin-desktop 14/14 on Apple silicon and Intel, ax-sidecar-darwin 16/16, darwin-system 10/10, darwin-vocabulary 5/5, ember-darwin 7; Ember.app opened through LaunchServices can't read apps before its own grant and can after it, so nothing is borrowed from the runner's granted processes. Linux, run 125: green and unchanged. The runners also settled three questions: `CFHash` keys are the same in two host processes (keys stay hashes), thumbnails come back BGRA, and the Settings window the bridge lists matches the window system's frame by process id. **Departures and why.** (1) Ember.app's executable is renamed `Contents/MacOS/Ember` (D8 said keep "Electron"): Electron's `app.isPackaged` is false for an executable named "electron", so an installed Ember would honour development switches and `--inspect`. (2) The bridge's `PSModulePath` is set to Windows PowerShell's own modules folder, not removed (D3): without it, Windows PowerShell 5.1 rebuilds a default that includes the user's modules. (3) macOS permissions in CI go to every process TCC may hold responsible, and the packaged app is also checked through LaunchServices before and after its own grant (D10, supplemented): the runner's processes are already granted, so in-process tests prove nothing about Ember.app. (4) Activation and focus stay on `Input`, and Ember tells its own windows by process id (D1 put both on the window system): one owner per operation. (5) On Windows a window's frame is its DWM frame and `inner` is its client area (D2 said `inner` is the DWM frame); frame matching tries all three, so nothing is lost. (6) A Mac needs Input Monitoring before Ember borrows the keyboard. Whether key-state polling needs it is undocumented, so Ember fails closed; CI saw polling work without it while Accessibility was granted, but on a runner with SIP off, so the requirement stays until a real Mac shows the same. (7) Dark mode is the only tier-0 setting on both (D7: only what is verified). (8) `resedit` (MIT, build time only) gives Ember.exe its own version resource and icon and drops Electron's certificate table, which flipping the fuses voids: Task Manager, the privacy settings and firewall prompts say "Ember", and endpoint protection sees an unsigned file rather than a tampered one. (9) The Intel Mac job runs on the default branch, on tags and when asked (`intel`), and a manual run can pick one platform (`only`): macOS minutes cost ten times Linux's. (10) On Windows, remote surfaces (Remote Desktop and WSLg windows, drawn by `msrdc` or `mstsc`) are refused for every action and blacked out: Ember sees only the client program, so its terminal, security-window and never-look checks can't see inside. Speaker rejection stays Linux-only, and rich clipboard formats come back as text or HTML (§9). |
| M12 SSH, WSL and commands | **Built 2026-10-22**: every package merged (the 13 main packages, INT-A and INT-B, the docs, the lead's rulings, the whole-branch review's fixes and the two tail packages); **no CI run yet** (GitHub Actions' budget ran out: no `remote.yml` job has run, M12 lists the runs owed); `npm test` passes on Linux | **What it adds.** Commands on every computer (OWNER DECISION 4), in Ember's own command window; WSL distros on Windows (Linux apps under WSLg, and commands); Linux and macOS computers over SSH, with the brain, voice and the GitHub token kept on the PC. Users see it in docs/COMMANDS-WSL-SSH.md, developers in docs/DEVELOPING.md §14, administrators' keys and the older-Ember lock-down in CHANGELOG.md. **Departures and why** (each one with its fallback, listed as L1-L26 in docs/COMMANDS-WSL-SSH.md §7). (1) `CONSENT_VERSION` stays 1: three first-use cards (WSL, SSH per host, commands per target) with their own versions, because nothing new happens before its card. (2) Commands are allowed on every target, the local OS included, through `run_command` only (OWNER DECISION 4 replaced the earlier "local commands stay forbidden"); Ember still never types into the user's own terminals. (3) No termios is read: the user's typing and the output after a password-like prompt are withheld from the model instead (L2). (4) Windows commands run in Windows PowerShell 5.1 on pipes in a kill-on-close job object, without typing (L3): ConPTY would need a native dependency. (5) Linux remote desktops get tier 0 and tier 1 with every step asked, no borrowed mouse and no view (L4); Wayland remotes text only (L5); macOS remotes commands only and Windows remotes not yet (L6); VNC and xrdp sessions unused (L21). (6) The borrowed mouse stays refused in WSLg windows until the Windows backend can check RAIL windows (L7). (7) A remote command survives a silent link for 20 s (an administrator's 3-120 s) so network blips don't kill builds (L10). (8) R3's flat refusal of root is replaced for commands by "every command asks"; a remote desktop as root stays refused (L17). (9) A policy that exists but doesn't mention commands turns them off, and an older Ember locks down on the new keys (R5). (10) L8 tightened after the review (the lead's ruling): a shell script a command runs is read (up to 64 KiB, on the target's own filesystem; over SSH by the agent's gate 2, since the PC can't read it) and its text classified like a nested command; a script the same command writes first, or one the task downloaded, always asks, and one an earlier command of the task wrote asks when it can't be read in full; other scripts too big to read keep L8's name rule. (11) A bare "here" no longer names this computer (§2.3 rule 4 changed): "delete build/ here" with build-01 picked announced and ran on the PC. (12) A task's downloads are recorded whatever the download run's exit (§3.8.3 step 14 said only after exit code 0), so running a fetched file asks even after `curl -o x.sh URL; false`. |
