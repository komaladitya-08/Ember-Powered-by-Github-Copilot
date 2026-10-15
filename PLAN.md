# Ember — implementation plan (v1)

**Status: frozen 2026-10-14.** This file is the source of truth for what we build in v1 and how.
`docs/RESEARCH.md` holds the background and evidence; where the two differ, this file wins.
To change a frozen decision, edit §2 in a PR that says what changed and why.

---

## 1. What v1 is

Ember is a small animated companion that lives next to your cursor on **RHEL 8.4 (GNOME on Xorg)**.
It is always listening for "Hey Ember", works in your real apps where you can watch, and never
takes your mouse or keyboard without asking. Its agent loop is the **GitHub Copilot SDK**.

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

**Not in v1:** Wayland sessions, RHEL 9/10, macOS, Windows, SSH, neural TTS, speaker verification,
screenshot OCR redaction, multi-pointer X. See §9.

---

## 2. Frozen decisions

| Area | Decision | Evidence / reason |
|---|---|---|
| Target | RHEL 8.4, "GNOME on Xorg" session, x86-64 | User's machine; X11 gives input, capture and overlays without prompts |
| Shell | **Electron 44.x** (pin exact), TypeScript, Node 24 inside Electron; Node 22 for tooling | Electron 44 needs GLIBC ≤ 2.25; launched under Xvfb/Xvnc on OL 8.4 |
| Native-code rule | Every `.node`/`.so` must need ≤ GLIBC_2.28 / GLIBCXX_3.4.25; `scripts/check-symvers.sh` gates CI | robotjs 0.9.1, uiohook-napi, node-screenshots, sherpa-onnx-node all fail as shipped |
| Agent loop | **`@github/copilot-sdk` 1.0.21** (pin), one `CopilotClient` over stdio to the bundled runtime | Runtime needs exactly GLIBC_2.28; sessions run fully in parallel in one process (~105–154 MB) |
| SDK hardening | `mode:"empty"`, `baseDirectory` in userData, `availableTools: []` (custom tools only), `excludedBuiltinAgents: [all]`, empty `workingDirectory`; at startup verify the tool list and **fail closed** if any built-in is present | Built-ins (shell, edit, fetch) are on by default |
| System prompt | `customize`: replace identity/tone/tool instructions, remove code rules, **keep the platform safety section** | `replace` drops guardrails |
| Sessions | **One conductor session + one worker session per task**, coordinated by a plain-TypeScript **TaskManager** | Parallel turns verified; conductor stays fast and image-free |
| Conductor | Fast model, conversational, resumed by ID on restart, never receives images; tools: `start_task`, `steer_task`, `cancel_task`, `list_tasks`, `describe_screen` (text), `point_at`, `ask_user`, `set_appearance` | Keeps context small and cheap |
| Workers | Vision model (`capabilities.supports.vision` required), computer-use tools, ≤ 1280 px JPEG screenshots on demand, AT-SPI text first; closed and **deleted** 10 min after finishing | Images are dropped silently for non-vision models; screenshots persist in `events.jsonl` |
| Results to conductor | `send({ prompt: "<task_update id=…>…</task_update>", source: "agent-worker-<id>", mode: "enqueue" })`; `immediate` only for needs-confirmation or failure | Verified send semantics |
| SDK sub-agents | Not used for tasks in v1; allowed later inside a worker (e.g. a cheap verifier) | Separate sessions give per-task model, resume, delete |
| Cost | Usage-based billing (AI credits): text before pixels, short worker sessions, usage meter from `assistant.usage` / `getQuota` | Billing changed 2026-06-01 |
| Auth | Ember's **own GitHub App**, device flow, token in libsecret via Electron `safeStorage`, passed as `gitHubToken`; dev fallback: `COPILOT_GITHUB_TOKEN` | SDK's built-in login asks for broad scopes |
| Packaging the runtime | Ship only `copilot-runtime` + `runtime.node` via `asarUnpack`; `RuntimeConnection.forStdio({ path })` | Verified side-by-side copy works |
| Overlay | One transparent, always-on-top (`screen-saver`), click-through window per display; hover by polling `getCursorScreenPoint()` (no `forward` on Linux); hidden during captures | `setContentProtection`/`forward` are no-ops on Linux |
| No compositor | Detect `_NET_WM_CM_S<n>` owner (koffi + libX11); fall back to a small opaque **handle window** | Transparent areas render black on xrdp/Xvnc |
| Tray | Not relied on. Floating handle + global shortcut + `.desktop` launcher; tray optional (RPM *Recommends* `gnome-shell-extension-top-icons`) | GNOME 3.32 has no tray by default |
| Characters | All four ship; one shared rig; picker in onboarding, settings, tray and by voice (`set_appearance`); mini-Embers mark running tasks | User decision |
| Screen capture | **Electron `desktopCapturer`** (kept warm) on the user display; koffi + `XGetImage` on desk displays | node-screenshots needs GLIBC 2.30 |
| Accessibility tree | **Python 3.6 sidecar with pyatspi** (system `platform-python`), JSON-RPC over stdio; focused window only, depth ≤ 12, `GetMatches`, event-driven cache; window ↔ AT-SPI match by PID + extents | 7-node tree in 3 ms, `GetMatches` in 0.4 ms on OL 8.4 |
| Small D-Bus calls | `dbus-native` (handles the abstract socket the a11y bus uses on 8.4) | dbus-next needs a native helper |
| Input injection | **`@jitsi/robotjs` 0.6.24** (XTest) + `ghost-cursor` `path()` for human-like motion | Prebuilt loads on glibc 2.28 |
| Global hotkeys | Electron `globalShortcut` (X11 key grab) | No native addon needed |
| Takeover detection | `uiohook-napi` **rebuilt on EL8** (only active while borrowing the cursor); idle time from `powerMonitor.getSystemIdleTime()` | Rebuilt binary verified |
| Action tiers | 0 app APIs (gsettings/D-Bus) → 1 background AT-SPI (`doAction`, `EditableText`, `Value`, `Selection`; never `grabFocus`) → 2 **Ember's desk** → 3 **borrow cursor** (ask, idle ≥ 3 s, abort on input < 100 ms) | Cua-style "no foreground" contract |
| Desk | `Xvnc` (tigervnc-server-minimal) `:N` on a Unix socket + `metacity` (AppStream) + `dbus-run-session` + `at-spi-bus-launcher`; a desk-agent child process with `DISPLAY=:N`; mini-view with `@novnc/novnc` over an IPC↔`net.Socket` bridge | All in AppStream, no EPEL needed |
| Voice | Mic in a hidden renderer (echo cancellation on) → 16 kHz `AudioWorklet` → `utilityProcess` running **sherpa-onnx WASM**: keyword spotting ("hey ember", "ember stop"), Silero VAD, streaming Zipformer ASR; second-stage transcript check; 8 s follow-up window | Native addon needs glibc 2.32; WASM verified |
| TTS | `speechSynthesis` with `--enable-speech-dispatcher` (espeak-ng), voice chosen by `lang`, played from the mic renderer so echo cancellation removes it; Ember mutes wake detection while speaking | 0 voices without the flag; 100 with it |
| Safety boundary | Deterministic **policy engine** in the main process behind one shared `onPreToolUse` + `onPermissionRequest` for all sessions | See §5 |
| Tests | Mock OpenAI-compatible server via BYOK `provider` for deterministic agent tests; per-PR rockylinux:8 container (Xvfb + D-Bus + AT-SPI + GTK fixture); nightly real RHEL 8.4 GNOME Xorg VM | Mock server approach verified with real SDK loops |
| Packaging | electron-builder **RPM** (+ AppImage); `rpmbuild` wrapper that unsets `LD_LIBRARY_PATH`; autostart entry with `--enable-speech-dispatcher` | fpm breaks EL8 rpmbuild otherwise |

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
| M8.7 | `/etc/ember/policy.json` admin lockdown: features, apps, domains, stricter tiers only, models, BYOK lock, retention | Admin values override user settings | M8.1 |
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

**Critical path:** M0 → M1.2 → M2.3 → M2.5 → M3.1 → M4.1 → M8.1 → M4.6 → M5.2 → M10.

---

## 5. Safety requirements (v1)

| Tier | Examples | Rule |
|---|---|---|
| Read | Look at screen, summarize, navigate within a granted app | Automatic |
| Reversible edit | Typing in an unsaved document, desk-only changes | Automatic, with a snapshot where possible |
| Confirm | Send, post, submit, share; delete or overwrite; system settings; installing; new domain; uploads/downloads; cross-app data moves; anything with the borrowed cursor; anything right after an injection warning | Click or key in Ember's confirmation UI |
| Never | Passwords, polkit/sudo, payment fields, CAPTCHAs, security settings | User takes over; capture paused |

Also: screen, file and web content is untrusted data; the conductor only takes goals from you;
per-app grants; never-look list before capture; audit log; admin policy; local kill switch;
wake-word protections (second-stage check, self-mute, speaker-output rejection).

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
| 1 | Who registers Ember's GitHub App (the "Sign in with GitHub" identity)? | **Open.** Development uses a token from `gh auth token` / `COPILOT_GITHUB_TOKEN`, so M0–M2 are not blocked. Default: register it under the repo owner's personal account before the first release (M2.2). |
| 2 | Copilot policy and data retention acceptable? | **Resolved 2026-10-15: yes.** |
| 3 | Bundling a natural-sounding offline voice (Piper is GPL-3.0; espeak-ng, used for pronunciation, is GPL-3.0; each voice model has its own license) | **Open, not blocking v1.** v1 uses the system speech-dispatcher (separate RHEL package, no bundling). Decide before adding neural TTS: is Ember going to stay open source? |
| 4 | Are target machines STIG-hardened (user namespaces off)? | **Unknown; handled both ways.** The RPM installs the setuid sandbox helper when namespaces are off (M9.2). Check with `sysctl user.max_user_namespaces` (0 = hardened). |

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
5. macOS, then Windows
6. SSH (design kept in `docs/RESEARCH.md` §9)

---

## 10. Progress

| Milestone | Status | Notes |
|---|---|---|
| M0 Foundations | **Done 2026-10-15** | Electron **44.5.0** and npm **11.6.2** pinned (npm 10 crashes on the test tools). App starts and hands over to a running instance on Oracle Linux 8.4 as a normal user with the Chromium sandbox on. The EL8 native-rebuild path (M0.4) is exercised in CI; it could not complete in the development sandbox because `www.electronjs.org` (Electron headers) is blocked there. |
| M1 Ember on screen | **Done 2026-10-15** (PR #2) | Per-display transparent overlays with click-through and hover-to-click; follow spring in the main process; picker in the home window; corner handle with menu; opaque handle card when there is no compositor. Cursor position comes from `XQueryPointer` (koffi) because Electron's `getCursorScreenPoint()` returns stale positions on X11 after the pointer jumps. Ember holds still while it waits for a decision, so its buttons can be clicked. Spellchecker dictionary downloads are blocked (`setSpellCheckerLanguages([])`). |

