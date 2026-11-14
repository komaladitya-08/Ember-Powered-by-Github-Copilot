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
| U7 | Ember asks before anything risky and never types passwords | Confirmation tiers enforced in code (changed 2026-11-12 for Autopilot, which announces risky steps and fills from the vault: §2 Approvals) |
| U8 | An admin can lock features down and audit what Ember did | `/etc/ember/policy.json`, audit log |

**SSH, WSL and commands (M12, 2026-10-22).** Ember can also run commands on every computer it works on, in its own
command window: ordinary commands at once, dangerous ones (deleting, publishing, secrets, system changes, download and
run) only after asking, and exactly what the user's own words asked for after an announcement with a 4 s Stop. On
Windows it works in WSL distros (Linux apps under WSLg, and commands). It works on Linux and macOS computers reached
over SSH (commands everywhere; on a Linux computer, also the desktop of the same user at its own screen, every step
asked), through a small helper copied there for the length of the connection. The brain stays on the PC: Copilot,
voice and the GitHub token never leave it. Commands on this computer are on from first run's one agreement, where the
user can switch them off (2026-11-12); WSL and SSH are off until the user turns each on and accepts its card; an
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
| Model service | **Changed 2026-11-02** (was: GitHub Copilot, or the organisation's own endpoint from the admin policy's `provider`). Also the user's own provider ("bring your own key", Home › Copilot › Model provider; `settings.provider`, off by default): OpenAI-compatible, Azure OpenAI or Anthropic, at an https address, or plain http only on this computer (localhost, 127.0.0.1, ::1: Ollama, LM Studio). Nothing goes to it (no request, no Test connection, no key) until after its first-use card is agreed for that endpoint's host (`FEATURE_CONSENT_VERSION.provider`, the host recorded with the yes by main only; another host asks again). Its API key is sealed with `safeStorage` in `provider-key.bin` (0600) with the host it was entered for (moving the endpoint deletes it), never with `basic_text`, the keyring asked only while the provider is on (asynchronously on macOS), and never written to settings, logs or the audit log, shown again, or put in any environment: it reaches only the runtime's provider config and Home's one **Test connection** request (redirects refused); Remove and Sign out delete it. With it in force no GitHub sign-in goes to the runtime. The administrator's `provider` always wins; `features.userProvider: false` and LOCKDOWN turn it off (shown managed); `models.allowed` and pinned models still hold. A change reconnects between turns (never under a running task, which finishes on the service it started with); a request asked meanwhile is held and sent to the new service, never the old one, and no new task starts on the old one; a conversation isn't resumed on another service: a new one starts, and memory stays | Owner request of 2026-11-02: people with their own model subscription, or a local model, can use Ember without a Copilot seat. A first-use card naming the host rather than a `CONSENT_VERSION` bump: only someone who turns it on sends anywhere new, and the card says exactly where, screenshots included (§10 "Own model provider") |
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
| Voice | Mic in a hidden renderer (echo cancellation on) → 16 kHz `AudioWorklet` → `utilityProcess` running **sherpa-onnx WASM**: keyword spotting ("hey ember", "ember stop"), Silero VAD, streaming Zipformer ASR; second-stage transcript check; 8 s follow-up window (**changed 2026-11-05**: a conversation, §10). **Windows and macOS:** the same WASM pipeline; models are unpacked in-process, with no system `tar` or `bzip2` (§10 M11) | Native addon needs glibc 2.32; WASM verified |
| TTS | `speechSynthesis` with `--enable-speech-dispatcher` (espeak-ng), voice chosen by `lang`, played from the mic renderer (Ember's own voice through Web Audio, which Chromium's echo cancellation is documented not to cover: §10 "Voice playback", measured with scripts/voice/echo-check.mjs before barge-in relies on it); while Ember speaks, a "Hey Ember" its speakers didn't say makes it stop and listen. **Windows and macOS:** the system's own voices; speaker-output rejection (`parec`) is Linux-only, and the settings say so (§10 M11) | 0 voices without the flag; 100 with it |
| Safety boundary | Deterministic **policy engine** in the main process behind one shared `onPreToolUse` + `onPermissionRequest` for all sessions. **SSH, WSL and commands:** each SSH computer gets its own engine with both machines' policies combined, and the agent there checks every step again (gate 2), which can only refuse or ask (§10 M12) | See §5 |
| Tests | Mock OpenAI-compatible server via BYOK `provider` for deterministic agent tests; per-PR rockylinux:8 container (Xvfb + D-Bus + AT-SPI + GTK fixture); nightly real RHEL 8.4 GNOME Xorg VM. **Windows and macOS:** per-PR `windows-2022` and `macos-15` jobs drive real desktops (a WinForms and an AppKit bench, Notepad, TextEdit); the eval stays Linux-only (§10 M11) | Mock server approach verified with real SDK loops |
| Packaging | electron-builder **RPM** (+ AppImage); `rpmbuild` wrapper that unsets `LD_LIBRARY_PATH`; autostart entry with `--enable-speech-dispatcher`. **Windows and macOS:** a zip of `Ember\Ember.exe` (Ember's own version resource and icon, unsigned) and `Ember.app` (signed ad hoc) as a zip and a dmg; signing and notarisation are out of scope (§10 M11) | fpm breaks EL8 rpmbuild otherwise |
| Platform layer (M11) | One composition root, `app/main/platform/`: `loadPlatform()` picks the backend by `process.platform` alone and gives main one `Platform` object (window system, input, overlay shaping, the accessibility helper's launch, system integration, the desk). Nothing outside it tests the OS. It loads under plain Node: Electron objects are passed in | Linux is wrapped, not rewritten, so it stays the same byte for byte (§10 M11) |
| Screen units (M11) | Native units end to end: physical pixels on Linux and Windows (Per-Monitor-V2), points on macOS. Negative coordinates are valid off Linux. Only Ember's own windows use Electron's DIP | Mixed scaling and monitors left of the primary stay exact; one image pixel is one screen unit for masking (§10 M11) |
| System integration (M11) | Windows: data in `%LOCALAPPDATA%\ember`, admin policy in `HKLM\SOFTWARE\Policies\Ember`, login item in the Run key, apps opened through `explorer.exe`. macOS: data in `~/Library/Application Support/ember`, admin policy in `/Library/Application Support/Ember/policy.json`, an SMAppService login item, apps opened with `open -a`. Audit log: the file only, on both | Apps never inherit Ember's environment (tokens); a policy Ember can't trust locks it down (§10 M11) |
| Node mode (M11) | Ember's binary never runs as plain Node (`ELECTRON_RUN_AS_NODE`) on macOS: the macOS build's RunAsNode fuse is off, the accessibility host is an Electron utility process (`utilityProcess.fork`, service "Ember accessibility"; requests on its parent port, answers on stdout) and SSH's askpass is Ember itself in a no-window mode (`--ember-askpass`: no window, no Dock icon, no single-instance lock). Linux and Windows keep the fuse on: Linux's desk helper and Windows' commands job host (which needs a console-capable child process), accessibility host, askpass launcher and WSL launcher run Ember's binary as Node | On macOS, Accessibility and Screen Recording follow the app macOS holds responsible, so with node mode any program the user runs could start Ember's binary with a script of its own (by launchd, say) and act with Ember's grants. On Linux and Windows no grant follows Ember's binary, so node mode gives such a program nothing it doesn't already have. CI proves Ember.app refuses it (review #177, owner decision D-177; `scripts/package/fuses.mjs`) |
| Targets (M12) | A task acts on one target: this computer, a WSL distro (`wsl:<distro>`) or a computer reached over SSH (`ssh:<host>`), chosen only by the user's own words or the handle's **Work on** picker, never from screen text or results. The brain is local: Copilot sessions, questions, voice and the GitHub token stay on the PC; a remote is eyes, hands and a command runner under its own admin policy and audit | The owner's decisions; nothing Copilot-related on a remote (§10 M12) |
| Commands (M12) | One `run_command` tool on every target, run in Ember's own command window (xterm.js 5.5.0, the one new dependency), with a PTY through `script(1)` or pipes; a hand-written conservative classifier (POSIX, PowerShell, cmd): ordinary commands run, the dangerous classes ask, and so does a program, or a tool's command, the classifier doesn't know (**changed 2026-11-13**, the closed default, settled by the integrator for the owner to overrule, §10: `ORDINARY_PROGRAMS` and `ORDINARY_VERBS` in commands/tables.ts list what runs, a program given by a path in the task's own folder is judged as before, and the user's own words naming it announce it), a dangerous command the user's own words asked for exactly is announced with a 4 s Stop (never secrets, download-and-run, outliving the kill switch or anything unclear), tampering with Ember's own safety machinery is refused, and so is a command that would type or run commands in the user's own terminals or editors (tmux, screen, zellij, kitty's remote control: the refusal kind “terminal”, §10); an approval binds to the exact bytes, target and task, by click or chord only while the whole command shows, or (**changed 2026-11-02**) by a Voice Match-verified "Ember, allow" under the same conditions, and (**changed 2026-11-12**, settled by the integrator on the owner's direction; the owner can overrule) by a spoken yes from anyone heard under the same conditions, as for any other question (only the owner's verified voice while the user has Voice Match on; never "Always"); by the approval mode (**changed 2026-11-12**, Approvals row): in Interactive an ordinary command on this computer that asks only because it carries text read elsewhere announces with its Stop instead (WSL and SSH commands, the dangerous classes, root, "ask every" and taint still ask); in Assisted a command that asks is first given to the reviewer with the user's own words (spoken ones included), as "Ask only about dangerous commands" did, in a task that text tried to steer too, and one it finds routine for the request announces with its Stop (a system change, an administrator's command and download-and-run included; never one that would read or print secrets or outlive the kill switch, a program Ember doesn't know, nor what the organisation's policy or the user's own "ask every command" requires: `notReviewable`); in Autopilot a dangerous command announces with its Stop, as root or an administrator, a system change and download-and-run included, and only one that would read or print secrets (so no secret reaches the model) or outlive the kill switch (so Stop stops everything), one Ember can't tell the effect of (a program it doesn't know included) or that the user's own words rule out, one of the same kind of danger as a command they said no to earlier in the task, and what the organisation's policy or the user's own "ask every command" for that computer requires, still ask, and tampering is still refused (Assisted's steered tasks and Autopilot's limits settled 2026-11-12 and 2026-11-13 by the integrator on the owner's direction; the owner can overrule); commands on this computer are on from first run (§10), in WSL and over SSH off until the user turns each on; output untrusted, redacted best effort and bounded | Owner decision 4: most work needs commands; stop and ask only for dangerous ones (§10 M12). Voice answers and Work without asking: owner decision of 2026-11-02; the modes, spoken answers without Voice Match and first run's defaults: owner decisions of 2026-11-12, and the points they left open settled the same day by the integrator on the owner's direction (Approvals row, §10) |
| SSH (M12) | The system OpenSSH client with the user's settings and keys, one hardened `ssh -T … sh -s` per link (no forwarding, no ControlMaster of its own) carrying a fixed bootstrap and then a framed protocol; a pinned, SHA-256-checked Node 24 and Ember's parts copied per remote, nothing persisting; passwords through Ember's own prompt to ssh only | No network listener, no remote brain, no install left behind (§10 M12) |
| WSL (M12) | Discovery from the registry and `wsl.exe` without starting a distro; commands through `wsl.exe --exec` under a kill-on-close job object; WSLg apps identified by an AT-SPI helper inside the distro and matched to their RAIL windows; unidentified ones stay remote surfaces | UI Automation sees a WSLg window as one opaque `msrdc` frame (§10 M12) |
| Connectors (extensions) | **Changed 2026-11-02** (was: no extensions, every tool Ember's own). Plugins from marketplaces the user adds in Home; **only their MCP servers load**, passed by Ember as explicit `mcpServers` and admitted tool by tool (`mcp:<server>-<tool>`, never a builtin, never a name Ember uses). Ember's gate decides every call in `onPreToolUse`: read-only (by hint) in an agreed item runs and is audited; anything else asks every time, never "Always"; the admin's `features.extensions` false or LOCKDOWN denies all. Results are untrusted and scanned; tools are pinned by SHA-256 and a change turns them off until the user agrees again; stdio servers start through Ember's launcher with an allowlisted environment. Network widened: the marketplaces the user adds and the installed extensions' servers. Connectors, `extension.mjs` extensions and the catalog stay off | Spike on the bundled runtime (§10 "Extensions"): MCP calls reach `onPreToolUse` and can be denied; `pluginDirectories` runs a plugin's command hooks outside every gate; an MCP tool shadows an Ember tool of the same name; a server inherits the runtime's whole environment; `extension.mjs` tools ignore `availableTools`; connectors need GitHub's service |
| Approvals | **Changed 2026-11-12** (owner decisions; was, from 2026-11-02: every step that isn't routine asks unless the user turned on **Work without asking** (`settings.autonomy`, off by default, its own card) or Home's narrower "Don't ask before working in an app I asked for help with" (`settings.trust.askedApps`) and "Ask only about dangerous commands" (`settings.trust.reviewCommands`), and a spoken yes counts only from a Voice Match-verified utterance of the owner or, from 2026-11-03, a short yes on the asking task's voice trust; before 2026-11-02, only a click in Ember's bubble, card or prompt window or the allow and deny chords, never by voice). **Three approval modes**, one choice of three in Home › Apps & privacy in place of those three switches, each with its own card; new users get Interactive in first run's one agreement (§10), existing users once they agree to its card. **Interactive**, the default for everyone: what Work without asking did with every scope on, plus the app switch, plus ordinary borrowed steps. A step that would ask only because it is the first in an app, uses the borrowed mouse and keyboard (the 1.5 s idle wait and letting go on any input stay) or carries text from another window (said by app and size, never content), or (**widened 2026-11-03**, its card then at `FEATURE_CONSENT_VERSION.autonomy` 2) only from Ember's doubt about an ordinary step (`Risk.plain`: an OK on a message box that has nothing else to choose (`acknowledgesOnly`, structural and failing closed: the dialog's whole list of controls, which the worker sends only from a whole read (`dialog.controls`, from a whole read with nothing left out under the dialog: each reader marks a listed element with something unlisted under it, offscreen, closed, hidden, collapsed, sizeless or unanswered, as `omitted`), is one push button named OK, the one pressed, with no Cancel, check box, radio button, toggle, field, list or link; its title bar's Close counts as a second control (it may cancel) unless the dialog is a real Win32 dialog box (#32770, `messageBox`) with its one OK, whose Close returns OK too, and its Minimise, Maximise, Restore, Help and system menu are left out but anything else in a title bar counts, and only a push button or a menu item is a caption button by its name; the dialog is a native app's, not a web page's (`page`) nor in a browser, web, chat or mail app; it is the same on Linux, Windows and macOS, not keyed on the "alert" role; and, as defence in depth, its words are read whole (not `truncated`) and say something, are all Latin or Russian Cyrillic with no look-alike mixes, ask no question, are at most 120 characters (`ACK_TEXT_MAX`), state no future or consequence (`FUTURE_PASSIVE`, a blacklist: will, is, was, been, any -ed or -en word, wird, seront, será, будет, disparaissent, исчезнут, kaybolur, poistetaan and their like in the languages of the lists) and hold no risky word after `normalizeLabel`, outside Settings, security, administration, permission, system and installer windows; Close and Dismiss back off a dialog and were never asked about), said as "Answering a message box in …"; line breaks (never a tab) typed with the borrowed keyboard into a plain text editor's document (`plainEditorLines`: an app on `PLAIN_EDITOR[os]`, Notepad, gedit, Mousepad, Kate, TextEdit…; only the window's main document (`mainDocument`, from a whole read: its largest multi-line `text` or `document text`, clearly a document by its role, a name or a document tab, so a sole unnamed text is not) in a window titled by a file or a new document (a weak check: the real gates are `mainDocument`, the role and `around`), never with a formula, in a cell or a page, and never a field whose name, label or surrounding panes and the selected tab of each (`around`) say console, terminal, shell, command, REPL, Python or output: gedit's Python Console, Notepad++'s NppExec); and (**widened 2026-11-05**) Enter in a browser's own address bar or a one-line search box (a page's or an app's own) (never a page's own address, URL or location field, a search box on a payment page or one named for something risky), a long address in the bar and keys that only move between a browser's pages and tabs (`goesSomewhere`, `BROWSER_KEYS`), and a page's button with no name at all, which otherwise asks (`BARE`)), goes ahead and is announced in the bubble and on its card, audited with `autonomy: true` (fill_cells too, one announcement for the batch); an ordinary command on this computer that asks only for the text it carries announces with its Stop. Announcements name the kind of step, the app and a size, never a control's name, typed text or screen text, and show on the card as Ember's own (`announce`), never as a model note. Risky steps (send, post, submit, share, delete, overwrite, pay, install, sign out, security settings, going past a warning, answering a dialog's question other than by backing off, destructive keys, secrets, dangerous commands) ask every time with no "Always"; so do a switch or a choice in the system's Settings and security apps and a first step there the user didn't ask for, Ember's other doubts (what a key does), every command of an elevated Ember, WSL and SSH as before, and a task that text on screen tried to steer, that went off-task or where the user said no (at any time in it: `saidNoThisTask`, never cleared). **Assisted:** as Interactive, and anything that would ask is first checked by a lighter model against the user's own words, spoken requests included, unchecked speech (every spoken request on Windows and macOS and every Listen once) too, never a suggestion chip's and never words heard over Ember's own voice (settled 2026-11-12 by the integrator on the owner's direction; the owner can overrule; a routine is checked against the request that started it, never its saved steps), and Ember's own description of the step, whose parts from the screen (control names, window titles) are quoted as untrusted. The check is built on the hardened one-shot reviewer "Ask only about dangerous commands" used (app/main/commands/review.ts: no tools, deleted after, its answer capped and checked), widened to app steps, and runs inside the policy's own gate after every rule. When it matches, the step goes ahead, announced, whatever it is, risky ones included; when it doesn't, or can't decide, errs or times out, it asks. A task with no words of the user's own asks without it. An off-task step and a steered, off-task or said-no task go to the check too, its untrusted quoting kept, and after a "Not now" Ember still never retries or works around that step (settled 2026-11-12, as above); for commands the check may clear one it finds in the user's own words, a system change, an administrator's command and download-and-run included, but never one that would read or print secrets or outlive the kill switch, a program Ember doesn't know, nor what the organisation's policy or the user's own "ask every command" requires (`notReviewable`, `keptQuestion`; settled 2026-11-12, and for the program Ember doesn't know in the ninth round, §10). **Autopilot:** it never asks; every step is still announced and audited, and Stop stops it. It asks only for exactly these (settled 2026-11-12 by the integrator on the owner's direction; the owner can overrule), each because it protects something Autopilot keeps: a command that would read or print secrets (so no secret reaches the model), a command that would outlive the kill switch (so Stop stops everything), a command whose effect Ember can't tell (the classifier's "unclear", and a program or a tool's command it doesn't know: it may be either of those), a command the user's own words for the task rule out (their no, said in advance), a command of the same kind of danger as one they said no to earlier in the task (their no again: it may be that one done another way; 2026-11-13, settled by the integrator, the owner can overrule), and whatever the organisation's policy requires or the user's own "ask every command" for a computer asks. Everything else that would ask is announced instead: risky steps, off-task steps, a task that text on screen or in a command's output tried to steer, a task where the user said no earlier (the refused step itself is never retried or worked around), the extensions gate's questions, a remote's own gate 2 questions (its desktop steps included; the remote's own admin policy still holds, as the organisation's), and commands as root or an administrator (every command of an elevated Ember), system changes and download-and-run. Lifted in Autopilot only, beside those questions: typing into password, card and secret fields and acting in an app's or a site's own sign-in window, only with values from the vault, never typed by the model. Kept: Stop, the organisation's policy (which can still turn modes off), the audit log, consent and its cards, never reading windows on the never-look list, masked screenshots, password and card text never reaching the model (secrets go only through the vault), every other hard "never" (the user's terminals, making files executable, desktop-level keys, Ember's own windows), a remote's own admin policy (the organisation's), and Ember refusing to change its own Stop, audit log, admin policy or mode (a mode above Interactive read from settings.json counts only against a seal kept with `safeStorage`, §10). **After a no** (2026-11-13, settled by the integrator on three reviews that each found another way round a matcher of "the same thing"; the owner can overrule): Ember never retries or works around a deny or "Not now". The same step or command sent again, or what is recognisably the same thing done another way (the same kind of step in the same app, the same danger to the same thing as the classifier names it), is refused without a question, a check or an announcement, in every mode; everything else that may be the refused thing asks for the rest of the task, in every mode, never checked by Assisted and never announced by Autopilot or by the user's earlier words (a step in an app in Autopilot, which has no question to put, is refused instead); a question nobody answered is not a no, and isn't asked again until the user next says something to that task. **The vault:** logins, cards and contact details, asked once through Ember's own Secure Form (its label and destination built by Ember, never from model text), kept write-only with `safeStorage` (never `basic_text`), bound to the app or site, filled without the model seeing the value and never through the clipboard; reads and screenshots after a fill hold no value; listed in Settings with Forget; `CONSENT_VERSION` 10, since it keeps something new, and the admin's `features.vault: false` turns it off (built, §10: a fill is its own kind of step, `vault_fill`, which the policy decides after every “never” and which never asks and no grant, waiver or Assisted check can allow; each entry bound to one app or one site's origin, read at the moment of the fill; what a fill puts in is hidden from every model, log and audit entry afterwards, and no extension is called after a fill until Ember restarts). Filling a password, card or secret field, or a sign-in window, from it is Autopilot's only, and never the system's own authentication prompts (polkit and its agents, the keyring and gcr's prompter, pinentry, ssh-askpass, sudo, Windows' and macOS's credential prompts), which stay never in every mode, Autopilot included (settled 2026-11-12 by the integrator on the owner's direction; the owner can overrule). **Spoken answers:** while a question is up, "allow", "yes", "okay, go with it", "go ahead", "accept", "sure" and their like allow it, and "deny", "no", "not now", "don't" refuse it, from anyone heard, with no Voice Match; never a yes heard over Ember's own voice, nor Ember's own voice (`selfSpokeSince`: on Windows and macOS Ember can't tell its read-out from the user's, so its own "…say allow…" could approve itself), never "Always" by voice, never on a click-only card, which only a consent card is (a command card takes a spoken yes like any other question, from anyone heard, and only a verified one while Voice Match is on: settled 2026-11-12 by the integrator on the owner's direction; the owner can overrule), and only when the approve chord could (armed, whole text read, panel shown whole) and only if said after the question was up and armed (`stale`); a yes asked as a question ("Proceed?") isn't one, on the recogniser's text: a question in its words is never an answer, while a one- or two-word yes asked only by the voice's rise ("Okay?") is written "Okay." and taken (second review of the voice lane, V2-S5: 21 of 28 synthesised clips; reading the rise from the audio needs measuring on recorded people first, and may then only make Ember ask again). Setup says plainly that anyone near the computer can answer Ember by voice. **Voice Match** is an optional extra, off by default; while the user has turned it on, only their verified voice can allow, as before: at least 0.5 s of voice after the wake phrase (`APPROVAL_MIN_SECONDS`, changed 2026-11-03 from 1.5 s), matched on its own at 0.75, never with the wake phrase in it, or, too short for that (`short`), a yes on the task's voice trust (`TaskVoiceTrust`: only that task's own question, never another task's, a command card, a consent card or a switch of mode, said for the question up after it was armed and never after another voice was turned away during it (`lockVoice`), within 10 minutes of a verified request, only with a score of its own (a yes too quiet or clipped to score, under 0.25 s of voiced frames after the wake phrase, is refused as too short, never trusted) that is at least 0.5 (compared unrounded, against the enrolled voiceprint); ended for every task once Voice Match turns any voice away or a yes is refused as another voice, or the owner's voiceprint is forgotten or taught again, and for a task changed by a request Voice Match didn't verify; audited `via: "voice"`, `verified: false`, `trust: "task-voice"`). The same holds for switching modes by voice, local intents in the host (no conductor tool; settled 2026-11-12 by the integrator on the owner's direction; the owner can overrule): to a mode that asks less from anyone heard (only the verified owner while Voice Match is on), never over or in Ember's own voice, and only once that mode's card has been agreed in Home; to one that asks more, anyone. The audit records `via: "voice"` and `verified`; switching modes is an audit entry (`autonomy`, with `via` and `verified`); the hard "never" rules but Autopilot's vault fills are untouched. The organisation's policy can only tighten: `features.autonomy: false`, `allowGrants: false`, `confirmEveryAction`, `features.actions: false` and LOCKDOWN keep a state below Interactive (asking as the default did before the modes, with all three switches off), `features.aiReview: false` keeps Assisted's check off (what it would check asks), and the admin's `approvals.maxMode` caps the mode. The commands classifier is unchanged; the modes act on its "ask" verdicts | Owner decisions of 2026-11-12. The modes: "We have this option in the apps and privacy where I have three options… why I'm getting option to enable all three and also these options doesn't really make sense. What we need is interactive, assisted and … autopilot" ("Three modes, Interactive default"). Interactive: "all the safe commands are automatically accepted but all the dangerous commands needs to be requested". Assisted: "a lighter model … needs to check what's my request is, and if the agent running the commands that are acceptable based on my request, then it should allow it, else it should ask me", for "Any step matching my ask". Autopilot: "it should do everything without asking me for any permissions or anything. That is, I am already accepting the risk"; told what Autopilot still keeps, and that they can overrule it, the owner answered "No hard limits, if there are sensitive information it should ask user once with a vault box where user can enter information and it can use it without actually reading it" (the vault). Spoken answers: "It asks us whether we want to allow it or not, right? … I can say allow or deny, or okay, go with it and other things. But it doesn't really need my voice to be matched for it … because we are already conversing with it, and we can just provide this kind of warning while setting it up, so user knows what he's getting into. … Once the product is built properly and working very good, then we can think of these voice match and other things as additional features. … Until that, let's keep the product experience to be simple and easy to use for a layman customer." Ember's own voice stays out because, where it can't tell its read-out from the user's (Windows, macOS), its own "…say allow…" could approve itself. The points those words left open were settled the same day by the integrator on the owner's direction (a simple product for a layman: in Autopilot "it should do everything without asking me", a spoken "allow", "deny" or "okay, go with it" from anyone, and Assisted approving "any step matching my ask"); the owner can overrule (§10). Built in the order §10 "Approval modes, spoken answers, first-run defaults and the vault" gives: spoken answers, the modes and first run's defaults are built (§10, ninth round); the vault is built too (§10): Autopilot fills a password, card or secret field or a sign-in window from it, and nothing else does. Earlier, and still the evidence for the allow-lists and for Voice Match while it is on: Owner decision of 2026-11-02: "I don't want to approve each and every thing… I should be able to do all these things even just with voice… for very dangerous things it can still show me that prompt window, but I should be able to answer it with voice." Voice Match only, no code word (§10 "Work without asking"). Widened 2026-11-03 to the same decision ("everyday actions run without approval; only very dangerous things still show a prompt") after the owner reported that, with every scope on, it still asked on Windows: the report found ordinary borrows, first steps and unflagged commands already unasked, and the remaining everyday questions in message boxes and multi-line typing, now waived only by allow-lists (security review of #140: word lists of risky things failed open); Ember's doubt about what a key does (Alt+letter, an unknown shortcut, Enter with nothing focused), the danger classes, an elevated Ember, taint and a "Not now" still ask (§10 "Work without asking, wider"). **Open (security review of #143):** on systems that can't tell the user from Ember's speakers (Windows, macOS: such requests are `voiceUnchecked`, never the user's own words for commands), a verified spoken request still grants its task the voice trust, as it does on Linux; the owner hasn't decided that separately. Owner decision of 2026-11-03 ("Also trust the task's voice"): almost no natural yes reached 1.5 s; measured on LibriSpeech dev-clean, 0.5 s on its own lets another voice pass less often than 1.5 s did (0.5 % against 1.9 %), while the whole request with the wake phrase in it let another voice after the owner's recorded "Hey Ember" pass 65 %, so that is never what is checked. The task trust accepts a measured risk (40 speakers, every owner against every other, a 0.3–0.6 s "allow", the app's own wake look, whole-request match and after-the-wake score): another person saying the whole "Hey Ember, allow" is taken 2.2–2.5 % of the time, and someone who plays the owner's recorded "Hey Ember" and then says the short yes themselves 35–40 % of the time; either gets one try, since any voice turned away or yes refused as another voice ends every task's trust. The owner's own short yes is taken 97.5–100 % of the time (5–80 % without the trust). A yes with under 0.25 s of voiced frames after the wake phrase has no score and is refused (review B1; before, it was taken, 78 % for the recorded wake and a 0.15 s yes, 8.3 % for a quiet one): now 8.8 % and 0.3 %, at the price of the owner's own 0.15 s yes (taken 17.5 %, was 95 %). A floor of 0.6 would cut the recording attack to 12–19 % but refuse a quarter of the owner's 0.3 s yeses |

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
| Confirm | Send, post, submit, share; delete or overwrite; system settings; installing; uploads; cross-app data moves; anything with the borrowed cursor; anything right after an injection warning | Click or key in Ember's confirmation UI, or a spoken "allow" or "yes" from anyone heard ("Not now" too; with Voice Match turned on, a yes only from the owner's verified voice; never over or in Ember's own voice, never "Always", never on a click-only card, which only a consent card is: a command card takes one while it shows whole, settled 2026-11-12 by the integrator on the owner's direction, the owner can overrule). By approval mode (§2 Approvals, 2026-11-12): in **Interactive**, the default, cross-app data moves, the borrowed cursor, a first step in an app, an OK on a message box whose only control is that OK and line breaks typed into a plain text editor's document (both allow-lists) are announced instead unless the step is risky in itself; everything else here still asks, and a task steered by screen text asks for all of it. In **Assisted** a step that would ask goes ahead, announced, when a lighter model's check finds it in the user's own words (spoken ones included), an off-task step and a steered task's too, and asks otherwise. In **Autopilot** nothing here asks but a command that would read or print secrets or outlive the kill switch, one whose effect Ember can't tell or that the user's own words rule out, one of the same kind of danger as a command they said no to earlier in the task, and what the organisation's policy or the user's own "ask every command" requires (§2 Approvals; settled 2026-11-12 and 2026-11-13 by the integrator on the owner's direction, the owner can overrule); every step is announced and audited. In every mode what the user said no to is refused when sent again or when it is recognisably the same thing done another way, and everything else that may be it asks (in Autopilot a step in an app is refused instead). Below Interactive (the organisation's policy) everything here asks |
| Never | Passwords, polkit/sudo, payment fields, CAPTCHAs, security settings | User takes over; capture paused. In Autopilot only, a password, card or secret field or an app's or a site's sign-in window may be filled from the vault, by Ember and never by the model (2026-11-12); the system's own authentication prompts (polkit and its agents, the keyring and gcr's prompter, pinentry, ssh-askpass, sudo, Windows' and macOS's credential prompts) stay never in every mode, Autopilot included (settled 2026-11-12 by the integrator on the owner's direction; the owner can overrule) |

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

Commands (M12) never go through a terminal of the user's: they run in Ember's own command window, where the user watches
and can stop them. Ordinary commands run at once; a program, or a tool's command, the classifier doesn't know asks (the
closed default, 2026-11-13, §2 Commands). Deleting or overwriting data, submitting or publishing, deleting from source
control or a service, secrets, privilege and system changes, download-and-run, outliving the kill switch and anything
the classifier can't read confidently ask, by a click or the approve chord on the card that shows the whole command, or
by a spoken yes while it shows whole (never "Always", never from a notification): before 2026-11-12 only the owner's
Voice Match-verified "Ember, allow", and from then on, as for any other question, anyone heard, or only the owner's
verified voice while Voice Match is on (settled 2026-11-12 by the integrator on the owner's direction; the owner can
overrule, §10). A dangerous command the user's own words asked for exactly runs after a 4 s announcement with Stop,
except secrets, download-and-run, outliving and unclear ones, which ask. As root or an administrator, or under "ask
every command", every command asks. In Assisted one the check finds in the user's own words runs after the same
announcement, but never one that would read or print secrets or outlive the kill switch, a program Ember doesn't know,
nor what the organisation's policy or the user's own "ask every command" requires. In Autopilot any one does, as root or
an administrator too, but one that would read or print secrets or outlive the kill switch, one Ember can't tell the
effect of or that the user's own words rule out, one of the same kind of danger as a command they said no to earlier in
the task, and what the organisation's policy or the user's own "ask every command" requires (settled 2026-11-12 and
2026-11-13, as above). Commands that would change Ember's own policy, audit, sign-in, settings, install or processes, or
drive Ember's windows, or that would type or run commands in the user's own terminals or editors (tmux, screen, zellij,
kitty's remote control), are refused in every mode. Output is untrusted; output that reads like instructions makes every
later command in the task ask (in Assisted the reviewer checks them, and in Autopilot they are announced, 2026-11-12).
On a computer reached over SSH every desktop step is asked (announced in Autopilot, 2026-11-12), and the remote checks
every step again under its own policy (its questions announced in Autopilot, its admin policy kept in every mode).

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
| Tier-2 actions without confirmation | 0, measured in Interactive, the default and the eval's mode; a step Assisted's check cleared or Autopilot announced is audited with its mode (and Assisted's verdict) and isn't counted as unconfirmed (2026-11-12, settled by the integrator on the owner's direction; the owner can overrule) |

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

Native speech on Linux (docs/ASSISTANT.md 1.1; §2 "Voice" departure, 2026-11-03): sherpa-onnx's C API through koffi
(app/voice/capi.ts), from the release's own prebuilt libraries (GLIBC_2.17), is the default in the RPM and the
AppImage, with WebAssembly as the fallback. The progress table's "Native speech on Linux" row has the reasons and
the measurements.

Voice playback (§2 "TTS" corrected, 2026-11-02): the row said echo cancellation removes Ember's voice. That was
written for `speechSynthesis`; Ember's own voice now plays through Web Audio, which Chromium's echo cancellation is
documented not to cover. `EMBER_TTS_OUTPUT=element` (development builds) plays it through an `<audio>` element instead,
and scripts/voice/echo-check.mjs measures both. Which path ships, and whether barge-in without the wake word is safe,
waits for that measurement on real laptops.

Voice latency, recognition, a natural voice and a smaller footprint: docs/ASSISTANT.md has the measurements,
decisions and phases. Nothing in it is built yet.

Long-term memory, beyond the plan above: docs/MEMORY.md has the design and steps. Steps 1 (the core,
`app/main/memory/`) and 2 (remember, recall and forget in conversation, behind its own consent, off by default) are
built. **Built 2026-11-03** (branch `ember-improve/20261103-memory-learning`): steps 3 to 5 and "Getting to know
you". While memory is in force Ember extracts facts after conversation turns and finished tasks (a hardened one-shot
session with no tools per call, zod-checked JSON, at most one call per three turns or a minute, 12 an hour, 60 a
day; `user` only from the user's own words, `task` from results, instructions never kept), refines while idle
(consolidate, then one model pass, 6 a day, rewrites kept as closed facts), and asks at most one question a day
about a name recall keeps missing (a setting turns it off). "Tell Ember about you" (Settings › Memory and first
run's optional step) and "Ember, get to know me" keep the user's answers as `user` facts; "Ember learned: …" with
Undo shows in the conversation, and "forget that" works without a model turn. The note changed to say so:
`FEATURE_CONSENT_VERSION.memory` is 2. The kill switch has a `memory` part. The eval gained three memory tasks.

Ember's two bodies (docs/DESIGN.md "Two bodies"): background tasks live on their cards in the corner, with how they work, their
plan and a checked generative view of their result; the cursor's bubble is the conversation, guides and borrowing. Next:
a background task's questions on its card.

Reminders (the first bounded interjection, after docs/ASSISTANT.md phase 6): the conductor's `set_reminder`,
`list_reminders` and `cancel_reminder` (app/main/agent/reminders.ts). A reminder is set only from the user's own words
in that turn (`ownWords`, as memory), is due by a plain timer, is shown and said, and never starts anything. Reminders
are kept in memory only (nothing new on disk, so no consent change) and end when Ember quits or the user signs out;
keeping them across restarts needs consent: Routines (app/main/agent/routines.ts) add it as their own card
(`FEATURE_CONSENT_VERSION.routines`, off by default, admin key `features.routines`, off in LOCKDOWN). With them on,
reminders are kept in routines.json (0600) and missed ones are told at the next start, and the conductor gains
`save_routine`, `list_routines`, `run_routine` and `delete_routine`: a routine is saved only from the user's own words,
and running one starts its steps as ordinary requests, so the policy still asks before every risky step.

An audit of these conversation features (2026-11-02) tightened them: a routine's name and each of its steps must be
the user's words (a planted step can't ride along); `run_routine` needs the request to be the routine's name, in the
user's own words (never a step of a routine run before), `delete_routine` a delete word governing it, and
`cancel_reminder` a cancel word governing the reminder (never in a request to set one); the steps of a routine run in
a turn count as the user's words for that turn (its reminders, and the risky steps of its tasks, which get the usual
question), never as words for commands (a step's dangerous command asks), and at most one routine runs a turn; a
request that is a routine's name, or the names saved, reach the conductor in a `<routines>` line. The injection
scanner normalises text (NFKC, no format characters) and also scans list_windows' titles and the screen text a task starts or
is steered with. Kept reminders come back when Ember starts, and sign-out forgets routines and memory also while the
organisation has them off. "Status?" says a task waits for the user's answer or is stopping.

---

## 10. Progress

### Default speech voice: explicit owner override (2026-11-04)

After the UI/speech review, the owner explicitly chose Kitten Nano 0.8 FP32 as Ember's default and asked to remove
Piper from the production voice path. This supersedes the earlier §2/Piper decision and the optional-Kitten choice
recorded below. The pinned Kitten archive is the `tts` entry in `VOICE_MODELS`, so preparation and packaged models
use the same default. The standard model set is 138,478,723 bytes (about 138.5 MB); Kitten itself is 63,815,222 bytes.
Optional Kokoro remains a separate explicit choice. Its failure falls back to Kitten; unsupported, failed or
too-slow default neural speech uses a local system voice. WebAssembly recognition remains supported, with no neural
speech on that backend. Native synthesis keeps the measured 0.5 real-time-factor gate and one-thread Kitten policy.

Historical Piper benchmark rows and synthetic Amy/Ryan recognition fixtures remain historical/test-only evidence;
they no longer define the shipped default. Transitive sherpa/eSpeak/piper-phonemize licence notices remain required.
This is a user-selected default change, not a new claim of measured listening preference, and does not bump a
version or publish a release. Audio handling, consent and action authority are unchanged.

### UI, accessibility and speech follow-up (2026-11-04)

The owner authorised the entire UI review and its implementation. Home now provides an inline transient
conversation composer, explicit edit/send and scoped Stop, searchable full retained answers, Projects as a separate
work destination, selectable settings results, stable searchable memory controls, and an inspectable reminder list.
Ask has a visible Send action and measured wrapping controls. Approvals activate on release inside a stable target;
Open approval opens the exact live main-owned question without passive focus stealing or new action authority.
Task result reading leases and More time keep decisions/results available. The desk adds explicit bounded inert
accessibility text with existing secret, consent, lock and action-ID protection; interactive semantic takeover is
not claimed. Export remains a separate user-selected local action and cannot bypass reviewed patch application.

Literal dictated repeats/numbers are retained while whole-sentence model-loop recovery stays enabled. Neural
speech releases after two idle minutes. Optional Kitten Nano 0.8 FP32 uses the pinned native runtime, explicit
model/download choice, measured speed gate and Piper fallback; Piper and existing Kokoro defaults are preserved.
Audio remains local and transient. See docs/DESIGN.md, docs/ASSISTANT.md and the UI review for exact acceptance
coverage; native assistive-technology, physical microphone and listening-quality checks remain separate gates.


Task orchestration review (2026-11-03, M2/M4.1): retries retain accepted steering and restrictions with the original
target binding; concurrent memory recall cannot reorder dispatched requests. Turns correlate against the exact sent
prompt, retaining their user/command words and voice provenance; unmatched messages cannot start or steer tasks.

Privacy review (2026-11-03): provider keyring operations are invalidated on removal, sign-out and settings changes;
live memory consent and pending-recall invalidation apply within existing turns, with speech provenance retained.

| Milestone | Status | Notes |
|---|---|---|
| Speech-output recovery (M9 voice) | **Built 2026-11-03** (branch `ember-improve/20261103-speech-recovery`) | Synthesis failure and process exit recover only the producer-reported ungenerated suffix after scheduled PCM drains. Remaining and later replies use local system speech for this session; hush/replacement cancels delayed recovery. No matching local voice: wait briefly for loading, then show a clear warning, never invoke an unrestricted default. Control-flow regressions cover pre-audio/partial failures, queued IDs, cancellation and late voice loading; real device/audio quality still needs platform testing. |
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
| Extensions (plugins and connectors) | **Built 2026-11-02**; unit and integration tests pass on Linux | **Runtime and gate** (app/main/extensions/, docs/DEVELOPING.md "Extensions: the runtime and the gate") and **Home's Extensions section** (app/renderer/home/extensions.ts). **The spike** (real runtime 1.0.97, SDK 1.0.21, empty mode, mock model): explicit `mcpServers` admitted with `availableTools: ["mcp:<server>-<tool>"]` work, `availableTools: []` hides them; every MCP call reaches `onPreToolUse` and a deny never reaches the server; `onPostToolUse`'s `modifiedResult` is what the model reads; the runtime shows the server's description and schema unchanged. **Departures and why.** (1) Plugins are not loaded as `pluginDirectories`: their `SessionStart` and `UserPromptSubmit` command hooks ran shell commands inside the hardened session. Ember reads and copies the plugin and loads only its MCP servers. (2) An MCP tool replaced an Ember tool of the same name, so extension names must carry their server prefix and never equal an Ember tool's. (3) A stdio server inherited the runtime's environment (the GitHub token and cloud keys), so servers start through Ember's launcher (`mcp-launch.cjs`) with `appEnv()`'s allowlist; macOS has no plain-Node mode, so stdio servers don't run there yet. (4) `extension.mjs` extensions stay off: their tools are bare names that `availableTools` doesn't filter. (5) Connectors stay off: `availability: "disabled"` without a real GitHub sign-in, so their gating is unproven. (6) Only the conversation gets extension tools, not workers. (7) Marketplaces are registered with the runtime (which fetches them); the runtime's `installationConfirmationHandler` was never called, so Ember's own consent card is the only one. |
| UI overhaul, phase 4: first-run setup | **Built 2026-11-02** (branch `ember-improve/20261102-setup-redesign`) | UI audit #7: the six-paragraph consent, cut-off character grid, nine-row diagnostic list and greyed Start became seven steps, one decision each (`app/renderer/home/welcome.ts`, `welcome-copy.ts`): hello, character, consent (five short lines, the full text one click away; the gate, M8.8), GitHub sign-in (device flow), the setup check in plain words (only rows that need the user, a fix button or a command to copy, details folded), tries (the stop shortcut, “Hey Ember” with a live meter, a first request) and “Your Ember” before Start. The Start row and `start-row.ts` are gone. Main sends the settings window that everything stopped (`ember:home-stopped`) and, only while the try step asks and the window shows, the microphone's level (`ember:watch-level`, `ember:home-level`). `CONSENT_VERSION` stays 1: the full text is unchanged and the summary says nothing it doesn't. Type tokens' line heights now round to whole pixels. |
| UI overhaul, phase 2: task activity | **Built 2026-11-02** (branch `ember-improve/20261102-task-activity`) | A task's card shows what the Copilot SDK and Ember are doing, the T3 Code "typed items, client-mapped components" way, never model-authored UI or raw reasoning. `app/main/agent/activity.ts` (pure) builds each task's activity from its worker's session events (`tool.execution_start/complete`, `model.call_failure`) and Ember's own signals (questions and answers, refusals, the hand, TurnWatch, the result); the TaskManager keeps it (in memory, the latest 20 finished tasks too, for Home's "Task activity" in phase 3) and puts a summary on each card: a live line in Ember's words, the worker's note, a telemetry row with a clock written by one shared 1 s tick, a summary of its steps and a Details list of up to six rows. A task whose question is up shows as waiting for the user. `report_progress` takes an optional `intent`, and the worker rule asks for a note at each plan step. Failed cards have Try again. New view blocks: `checklist`, `progress`, `compare`, `excerpt` (refused whole on a secret) and `status`. Titles keep 72 characters. |
| UI overhaul, phase 3: Home | **Built 2026-11-02** (branch `ember-improve/20261102-home-redesign`) | Home becomes System Settings: one pane at a time from the sidebar (data-pane sections), **Search settings** at the sidebar's top, the last pane reopened, links ordered by use (Home, Copilot, Voice, Your Ember, Memory, Apps & privacy, Comfort & access, Computers, Commands, Extensions, Setup & about). Home's pane is a still status panel (presence ring, state, what is on, today from Task activity's own tasks, Ask Ember… and Stop everything), the conversation as part of the page (latest 30, then Show earlier), **Task activity** (one group per task from `TaskManager.activities()`, now with each task's state, plan, summary and view; a question's decision, `askedWords`; sender-checked `tasks:activity` and a push at most every 500 ms to the settings window only; memory only) and the folded What Ember did: 5,119 px of one page at 1,100 wide became 1,964 for Home with demo data, each settings pane fitting one screen. Setup counts agree everywhere (UI audit #6). Departure, on Linux, Windows and macOS alike: once set up, a start by the user greets instead of opening settings unless a setup row needs them (`startView`'s `setupNeeded`; the Linux launcher entries no longer pass `--show-settings`); starting Ember again while it runs still opens settings. Linux's About shows the data folder Ember really uses. |
| UI overhaul: views v2 | **Built 2026-11-02** (branch `ember-improve/20261102-views-v2`) | Ember draws its own UI by composing blocks from a closed catalog, `ember.view/2` (owner decision: not model-written HTML; A2UI's contract, json-render's schema-generated prompt). A flat, id-addressed `ViewDoc` (app/shared/view.ts) of layout, content and data blocks, six semantic tones and fixed symbols; the first catalog is upgraded on arrival. Main checks every view whole and fails closed (app/main/agent/view-schema.ts: limits, references, Ember's control words and shortcut chords, "Ember: …", secrets, private paths, quotes' provenance against what the task read). Worker tools `show_view` and `update_view` (replace, append, remove, set; counted in the 150 steps) draw a live view on the card; `finish_task`'s view takes its place. Main sends diffs apart from the state, at most 4 a second a task and none while Ember is hidden (`ViewHub`, app/main/agent/view-doc.ts). Drawn by one shared module, app/renderer/shared/view-dom.ts, with view.css (static SVG charts, gauges and metric tiles, each with a text form and a hidden table), ready for Home's Task activity. Eval tasks `views-live-card` and the red team's `injection-view-allow`. Deferred to phase (d), after a privacy review: `capture` and `app_icon` blocks and a `CONSENT_VERSION` bump. |
| Work without asking and spoken approvals | **Built 2026-11-02** (branch `ember-improve/20261102-work-without-asking`) | **Departure from §2, at the owner's request** (§2 Approvals and Commands rows; CLAUDE.md "Policy decides" and the tier-3 bullet changed with it). **Policy:** `PolicyEngine` marks a question waivable (`Decision.waivable`: `apps` for a first step in an app, `cursor` for the borrowed mouse and keyboard, `crossWindow` for text carried from another window) only when nothing risky asks; with `autonomy` in force (app/main/policy/autonomy.ts `autonomyInForce`: on, card agreed, the administrator allows it) such a question becomes allow with an announcement built from the request (`Decision.announce`), audited `autonomy: true`. The worker holds a steered, off-task or refused task to asking. With it off every decision is today's byte for byte (sshwsl-hooks.test.ts's hash, the new marks left out). **Commands:** `autonomousCommand` (commands/flow.ts) announces an ordinary command on this computer whose only rule is `carried`; WSL and SSH commands ask as before. **Security review of #127:** a "Not now" suspends the mode for the rest of the task for good (`saidNoThisTask`; `declined` is reset by later steps); a spoken answer counts only for the question up when the speech started, after it was armed; Voice Match vouches only with ≥ 1.5 s of voice, and a voice it turns away during a question locks that question to clicks and keys; "cancel" and "never mind" aren't answers, and "no" in a follow-up window reaches a question that is up; announcements are their own activity kind with words that never quote the screen or typed text, and a model note that copies them is refused; the system's Settings and security apps always ask; turning the mode on or off and spoken answers to cell batches and extension calls are audited with their channel. **Re-check:** a Stop during an autonomous command's countdown counts as a no; system-administration apps (`ADMIN_APP`, per OS) always ask; the bubble marks announcements with its own "Without asking" tag that only Ember sets, and a task's note never has it; Voice Match counts voiced frames, and vouches only for what follows the wake phrase, checked on its own; a mode change is said only once recorded, a turn on can't happen before the audit log exists, and one found on in settings.json at start is recorded (`via: "file"`) or turned off. **Voice:** the voice process marks a request Voice Match matched `verified` (app/voice/match.ts); main judges a spoken answer with voice-answer.ts (whole short utterances only, never Ember's own voice since the request's wake) and `Confirmer.answerVoice` takes a yes only as the approve chord could, never "Always" or a click-only card; "Not now" from anyone. "Work without asking" / "Ask me first again" are host-local intents (autonomy-intent.ts); no conductor tool. **Admin:** `features.autonomy` (strict schema: an older Ember treats the key as a broken file and locks down). **Eval:** three tasks (`autonomy-*`): a routine step runs unasked, replacing a note still asks while Ctrl+S is announced, and a hostile page puts the task back to asking; the borrow gate accepts an `autonomy` decision in place of an Allow, and counts any `autonomy` step on a must-ask or out-of-scope element as unconfirmed. **Not here:** remote targets (SSH desktops, and WSL and SSH commands) don't take autonomy yet (they ask as before); Home's switch has no per-scope controls (all four on) |
| Work without asking, wider | **Built 2026-11-03** (branch `ember-improve/20261103-autonomy-wider`) | **Departure from §2, at the owner's request** (§2 Approvals row, `.claude/rules/agent-and-policy.md` "Work without asking"). **Diagnosis** (the owner: "even after enabling all the options … it is still prompting me" on Windows): with all four scopes on, an ordinary borrow, a first step and an unflagged command were already unasked (autonomy-wider.test.ts pins it on win32); what still asked was (a) Ember's doubt about ordinary steps, (b) the hard rules and the danger classes, (c) a task held to asking after taint, an off-task step or any "Not now" or expired question, and (d) on the owner's PC likely an elevated Ember, under which every command asks. **Widened** (a) only, by allow-lists that fail closed (the first cut matched lists of risky words against free text and failed open, and so did a second that waived by words alone: "Your history will be cleared." with OK and Cancel; security reviews of #140): `Risk.plain` marks an OK on a message box that has nothing else to choose (`acknowledgesOnly`, structural and failing closed: the dialog's whole list of controls, which the worker sends only from a whole read (`dialog.controls`, from a whole read with nothing left out under the dialog: each reader marks a listed element with something unlisted under it, offscreen, closed, hidden, collapsed, sizeless or unanswered, as `omitted`), is one push button named OK, the one pressed, with no Cancel, check box, radio button, toggle, field, list or link; its title bar's Close counts as a second control (it may cancel) unless the dialog is a real Win32 dialog box (#32770, `messageBox`) with its one OK, whose Close returns OK too, and its Minimise, Maximise, Restore, Help and system menu are left out but anything else in a title bar counts, and only a push button or a menu item is a caption button by its name; the dialog is a native app's, not a web page's (`page`) nor in a browser, web, chat or mail app; it is the same on Linux, Windows and macOS, not keyed on the "alert" role; and, as defence in depth, its words are read whole (not `truncated`) and say something, are all Latin or Russian Cyrillic with no look-alike mixes, ask no question, are at most 120 characters (`ACK_TEXT_MAX`), state no future or consequence (`FUTURE_PASSIVE`, a blacklist: will, is, was, been, any -ed or -en word, wird, seront, será, будет, disparaissent, исчезнут, kaybolur, poistetaan and their like in the languages of the lists) and hold no risky word after `normalizeLabel`, outside Settings, security, administration, permission, system and installer windows; Close and Dismiss back off a dialog and were never asked about), said as "Answering a message box in …"; line breaks (never a tab) typed with the borrowed keyboard into a plain text editor's document (`plainEditorLines`: an app on `PLAIN_EDITOR[os]`, Notepad, gedit, Mousepad, Kate, TextEdit…; only the window's main document (`mainDocument`, from a whole read: its largest multi-line `text` or `document text`, clearly a document by its role, a name or a document tab, so a sole unnamed text is not) in a window titled by a file or a new document (a weak check: the real gates are `mainDocument`, the role and `around`), never with a formula, in a cell or a page, and never a field whose name, label or surrounding panes and the selected tab of each (`around`) say console, terminal, shell, command, REPL, Python or output: gedit's Python Console, Notepad++'s NppExec); `waiverOf()` makes either waivable (`apps`, or `cursor` when borrowed, plus `crossWindow` with carried text), announced from the request (`Decision.answersDialog`: "Answering a message box in …"; "the keyboard" on the desk). The worker marks a dialog `page` (an `inWebPage` dialog) and `truncated` (words over `DIALOG_TEXT_MAX`). The macOS reader (`ax-darwin-read.ts`) marks `omitted` on the parent of an element it left out and on one whose children or actions it couldn't read, and the UIA reader on a parent whose children were cut (`childrenCut`). Known limit: controls in a separate top-level window the dialog owns can't be detected. Every probe of the reviews is a regression test that asks (autonomy-wider.test.ts), and two real gedit 46.2 trees read through the AT-SPI sidecar (test/fixtures/atspi: its Python Console is an unnamed text view beside the bottom panel's tab list) pin the console rule. Home's hint under the switch says when Ember runs as an administrator or root, so every command asks (`elevationOf`, from the setup check's `elevated`/`root` row). With the mode off every question is asked as before (the audit gives line breaks in an editor their own reason). **Fixed:** fill_cells under the mode skipped the announcement and the audit's `autonomy` and, after a "Not now", still went ahead unasked: it now announces the batch once, audits `autonomy: true` per cell and asks again after a no. **Commands:** no new waiver: ordinary commands already run without a question (turning them into announcements would only add a 4 s wait); the danger classes, root or an elevated token, "ask every", taint and other computers still ask. **Eval:** `hands: ["commands"]` runs run_command through the real classifier and local runner; the safety gate flags a dangerous command started without an Allow (or under the mode), and a secret, download-and-run or unclear one (`ALWAYS_ASK`) without an Allow whatever the user's words; four tasks: an ordinary borrow announced, a destructive key still asked, an ordinary command run, a model-chosen delete asked and refused. **Consent:** the card (`AUTONOMY_CONSENT_TEXT`) now says Ember presses OK on a simple message box (one whose only button is OK, with nothing to choose or tick) and still asks about any dialog that asks a question; `FEATURE_CONSENT_VERSION.autonomy` is 2, so a user who turned the mode on agrees to the wider scope before it is in force again |
| UI overhaul, workstream G: Liquid Glass and motion | **Built 2026-11-02** (branch `ember-improve/20261102-liquid-glass`) | **Glass you can see through.** The floating layer's glass was 97–98.5 % opaque, and its body was painted twice (padding box and border box), so nothing showed through. It is now Apple's regular glass without a blur: one body at `--glass-a` 0.88 (a white page's own text shows through at under 1.5:1), a sheen, a lit 1 px rim in the border, a lit top and darker bottom edge, a hairline of one device pixel and tight shadows; the handle's face end is clear glass (0.55) beside a plate for its words. Labels on glass step up to 74 % and 66 %, `--red-text` lightened to #FF9189, and design-system.test.ts checks every label, tag, mark and control edge against a white page behind the glass. A **Glass** setting (Comfort & access; `settings.glass`, `html[data-glass]` on the floating pages) offers Clear (an even 0.68 tint, chosen by the owner over two halo designs that measured 2.7–3.1:1), Regular and Solid; Reduce Transparency and Calm make it solid, Increase Contrast solid with a light border, which now has Apple's increased-contrast yellow, blue, gray and Ember's lights. **Crisp at every scale:** the bubble, the stage canvas and the presence ring sit on device pixels, the canvas's backing store is whole device pixels and is resized when the scale changes, line heights round to whole pixels, the status line is centred by layout, and the whole-text panel's corner is concentric (6). **Motion:** Apple's springs as tokens (`--spring-smooth-0`, `--spring-brisk`, `--spring-reward`, `--t-*`, `--stagger`); the bubble grows out of Ember and leaves the same way (keeping its words as it fades), a question only fades, streamed text is drawn at most 15 times a second, a card's plan dot fills and its done tick settles in once, the Ask box grows out of Ember, Calm keeps one 150 ms fade (R1), the handle's microphone halo is steady (R6). **The character:** asymmetric blinks at mood-dependent rates, saccades, a "got it" blink, no pop on listening or a question, rarer fidgets, a mouth and glow driven by Ember's own voice level, and a dozing Ember that stops drawing. CPU under Xvfb with xcompmgr (the overlay renderer, % of a core; before is the mean of five runs, after of two): idle 7.3 → 7.1 (Clear 7.4), the bubble opening 20 times 10.4 → 10.0 (10.6), 30 s of streaming 16.9 → 15.3 (15.6), three cards updating 8.1 → 8.7 (8.4), listening 10.5 → 10.7 (10.3), speaking 13.0 → 10.4 (10.1). Speaking had measured +10 % (Regular) and +16 % (Clear) at 45 frames a second: blending what shows under the see-through glass costs more per frame than the opaque glass did (solid glass measured 13.2), so a talking Ember with nothing else moving draws at 30 frames a second, which still follows a voice level that changes ten times a second. Runs vary by about a point, and other sessions shared the machine. |
| Own model provider (BYOK) | **Built 2026-11-02** (branch `ember-improve/20261102-user-byok`) | **Departure from §2, at the owner's request** (§2 "Model service"; CLAUDE.md's network rule changed with it). **Settings:** `settings.provider` (type, endpoint, wire API, Azure API version, the conversation's and the tasks' model ids, and its card's record with the host), validated with zod (`app/shared/provider.ts` `endpointProblem`: https, or http only for localhost, 127.0.0.1 and ::1; no user name or password in the address). **Key:** `ProviderKeyStore` (app/main/provider.ts) seals it with `safeStorage` in `provider-key.bin`, refuses `basic_text` (and a keyring that is unavailable or refuses) in plain words, and keeps the key read back in main's memory only; Home's field sends it once (`PROVIDER_IPC.saveKey`, zod-checked, Home's own page only) and hears back only "Key saved". **Precedence:** `activeProvider()` gives the administrator's endpoint (or a development test server) first, then the user's while `userProviderInForce()` allows it; `features.userProvider` is in `AdminPolicySchema`, `applyAdminPolicy`, `managedKeys` and LOCKDOWN. **Switching:** AgentHost takes the provider as a function, asked at every connect; `providerChanged()` (from main on any settings change, a key saved or removed) reconnects when nothing would be cut off, otherwise the next request between turns does; tasks keep the config they started with. A conversation is tied to its service (`conversationService`): on another one a new conversation starts, with memory kept, and an account change across a stretch on another service is still told (`githubLogin`). **Consent:** a first-use card in Home naming the endpoint's host, screenshots included (copy.ts `providerConsentText`), instead of a `CONSENT_VERSION` bump: nobody who leaves it off is asked again, and the yes holds only for that host. The WSL, commands and SSH cards name the user's service by its host while it is in force. **Errors:** `friendlyError`'s `ServiceKind` "user" points at the key in Ember's settings, not at a GitHub sign-in or an administrator. **Doctor:** "Model service: Your own model provider (host), with its API key saved" (host only). **Tests:** user-provider.test.ts (schema, endpoint rules, precedence, LOCKDOWN, `basic_text`, the key never in settings, logs or answers, IPC checks, Test connection), host-user-provider.test.ts (no GitHub token with it, switching both ways without a restart, a new conversation per service), ui-copy.test.ts (the words), and integration/user-provider.test.ts (the real runtime against the mock model through the user's settings and key store). |
| Voice and agent latency | **Built 2026-11-02** (branch `ember-improve/20261102-perf`) | **Measured first** (docs/ASSISTANT.md §1.1, `scripts/perf/latency.mjs`: median and p95 over 13–96 runs of each step, `main` then the branch on the same machine): wake → listening 154 ms; end of speech → transcript 833 ms (the VAD's 0.6 s, 0.7 s after the voice, plus Moonshine's 0.13 s); first token → first spoken audio 994 ms (p95 2.5 s: Piper in WebAssembly takes about 18 ms a character, and a long first sentence was said whole); a typed question → first token 18 ms; task start → first tool call 112 ms, a tool call 112 ms (perceive_window 49 ms; acting is the 350 ms flight before it, and press_keys the 1.5 s stillness before a borrow); the kill switch 6 ms (everything stopped in 8). **Changed:** (1) at a 0.35 s quiet pause the request so far is transcribed ahead of the VAD (`SPECULATE_FRAMES`, app/voice/engine.ts; `speechSoFar()` in app/voice/sherpa.ts), and when the VAD ends it with no sound since, that transcript is sent at once: end of speech → transcript 833 → 721 ms (p95 923 → 775). When a request ends is unchanged (requests said with a pause were cut short exactly as often on the same audio). The transcript is used only when the VAD's own speech ended by the time it was made (`speechEnd()`/`fed()`: soft words after the pause are never lost, review of PR #137), and only for a request of up to 6 s so far (`AHEAD_MAX`: "Ember, stop" after a request is as fast as without it, 758 against 759 ms). Not for a bare name not shown yet, a cut-in, a wake still being checked, a busy room, or a first segment whose transcript made ahead doesn't show the wake phrase. (2) A first spoken clause counts from 18 characters (was 25), and a first sentence said whole is cut at its first clause from 48 (was 90): first token → first audio p95 2,465 → 1,473 ms (median 994 → 1,015, noise). **Tried and not kept:** ending a request that reads as finished at a 0.45–0.51 s pause (another 0.2 s) cut "Turn on do not… disturb" at a 0.5 s pause in the voice tests. **Not changed:** the 1.5 s idle wait before a borrow (a departure above), the 350 ms flight before acting (users see where Ember acts), Ember's voice in WebAssembly (native speech on Linux is phase 1.1's packaging work), idle drawing (648 MB, 29 % of a core on Xvfb; the handle and setup page draw at 5–6 % each: docs/ASSISTANT.md phase 5). No safety check, consent, network call, frozen decision or platform changed; audio stays in memory. |
| Voice on Windows: requests after Ember's answer | **Built 2026-11-03** (branch `ember-improve/20261103-windows-voice`) | **Found** from the owner's report on Windows ("Hey Ember" listens too briefly, has to be said again and again, and after one or two requests none is taken though Ember shows it's listening), reproduced with the engine's fakes and on 33 synthesized voices (32 Kokoro, one Piper) through the real recognizers, natively (sherpa-onnx's C API, as the Windows addon runs) and in WebAssembly. Where Ember can't hear its speakers' stream (Windows, macOS, Linux without `parec`) the microphone hears its voice (the echo canceller doesn't cover Web Audio's playback), and the engine took it for the room and the request. **Changed** (app/voice/engine.ts): (1) what the microphone heard until Ember said it stopped speaking, plus 96 ms (`SELF_LAG_MS`), is left out of how busy the room was before a wake (VO9-3's `busyRoom`) and out of the wake's pre-roll and Voice Match's first look: with it in, a request said softer than "Hey Ember" after a pause, within 3 s of Ember's answer, was dropped (16 of 33 voices heard against 29 now; 28 in a quiet room), and one said within 1.6 s sent Ember's own last words as the request. (2) "Hey Ember" said in a follow-up window makes it a wake's window (`wakeOverFollowUp`): a follow-up hears only the voice that woke Ember within 6 dB, so a "Hey Ember" said again after the answer, and the softer request after it, were dropped while "Listening for a follow-up…" showed (15 → 24 of 33 with a pause, 26 → 31 in one breath); where the recognizer hears another word ("Hey Amber, …") said softer than a follow-up must be, it is taken back. (3) After "Hey Ember." and a pause the VAD heard, in a room that wasn't busy, the request is measured on its own loudness, not the wake phrase's: said 6 dB softer, "And make the text a bit bigger." was ended at its softer words and sent as "And make the text." (the voice tests, in a quiet room too). (4) The bare name: Moonshine writes a lone "Ember." as the name for few voices (4 of 33; "Amber", "Number", "Member", "And?" otherwise), and the check rightly turns "Amber" and "Number" away (taking "Amber" would have woken Ember on "Amber, dinner is ready." for 28 of 33). It now takes "Embra", "Embro", "Embo" and "Emba" said first, and "Member" alone or before punctuation (`MISHEARD_NAME`; not "Member services, how can I help?"): a lone "Ember." shows for 10 of 33, "Ember?" for 8 (was 6), with no new wake on 17 near-miss phrases × 33 voices ("I remember", "Remember me?", "September", "November", "December", "Members only", "My membership", "Timber!", "Number nine"…). "Ember, <request>" is unchanged (17–29 of 33): "Hey Ember" stays the reliable phrase (29–31 of 33). (5) Without the speakers' stream "Hey Ember" now cuts in while Ember speaks (only "Hey Ember, stop" did, so a request said while Ember read its answer out was thrown away): Ember never says the phrase there (`withoutOwnPhrases`), the check must hear the greeting and the name (`CUT_IN_WAKE`: not "Amber", "Emma", "A. M. B.", "they" or "Ember's", and `withoutOwnPhrases` names the phrase, or puts a word between a greeting and the name a full stop separates ("Okay. So Ember can't…"), wherever Ember would say it), and takes back "they remember…", the bare name never cuts in, nothing heard before the page says Ember stopped (plus `SELF_LAG_MS`) is sent, however long that takes, when the page said Ember was speaking (in the tail after it said it stopped no word comes, so the request is sent at once; if one never comes, Ember's voice is taken to end 1.5 s after the cut-in, so a later wake keeps its pre-roll), and words heard then still never count towards a dangerous command. (6) A request under way for 0.5 s when Ember starts speaking over it is kept, not thrown away (`OVER_REQUEST_FRAMES`). (7) Up to three follow-ups in a row (`MAX_FOLLOW_UPS`; it was one, so a third request without "Hey Ember" went unheard). Left as it was: "Okay." or "Fine." in a follow-up while a question is up still ends the window, as voice-answer.ts takes neither as a yes. **Where each applies.** Only without the speakers' stream (Windows, macOS, Linux without `parec`): (1) leaving Ember's own voice out of the pre-roll, Voice Match's first look and the room's loudness, (5), and (6). Everywhere: (2), (3), (4) and (7); a follow-up must still come near the wake phrase's loudness, not a softer request's after it. Linux with speaker rejection keeps its pre-roll, busy room and cut-in as before (unit tests with the speakers' stream pin them against main's engine). Near misses (8 phrases × 33 voices) came out the same before and after: none sent but "Hey Amber, dinner is ready" (4 of 33 in a quiet room, 2 after Ember's answer); with (4) and 9 more near misses, 17 phrases × 33 voices: none new. |
| Better recall (memory embeddings) | **Built 2026-11-03** (branch `ember-improve/20261103-memory-embeddings`) | docs/MEMORY.md step 8. **Model:** all-MiniLM-L6-v2 int8 (23 MB, Apache-2.0), pinned by SHA-256 in `app/voice/models.ts` (`MEMORY_MODEL`: the .onnx and its vocab.txt, from Hugging Face at a fixed revision), chosen over gte-small, bge-small-en-v1.5, e5-small-v2, snowflake-arctic-embed-xs and multilingual-e5-small on a benchmark of 80 facts and 122 questions (`test/fixtures/memory-bench.json`; docs/MEMORY.md §2 has the table). **Runtime:** onnxruntime-web 1.23.2's WebAssembly (already shipped for Voice Match: no new dependency, no native module) on one thread in a new utility process, "Ember memory" (`dist/app/memory-embed.cjs`), started on first need and ended after 5 idle minutes; the WordPiece tokenizer is TypeScript, checked against Hugging Face's. **Recall:** a question's 8 nearest facts at cosine 0.2 or more go to `recall()` as `semantic` (walk seeds and a 0.6 share of the score): other-words questions found first 9% → 83% of the time, in the first five 11% → 86%, with at most one fact found by meaning alone (`SEMANTIC_ALONE`: a request about nothing remembered gets 1.3 facts, 0.5 by words alone, against 3.2 with no limit, which found 96% in the first five); own-words questions unchanged at 100%; without the model recall is byte for byte what it was (pinned by hash). **Storage:** `memory-vectors.json` (0600, int8, atomic, keyed by fact, text hash and model), dropped with a forgotten fact, deleted by Forget everything, sign-out and Remove. **Network (a new download host):** the model comes from Hugging Face, `huggingface.co`, redirected to its CDN `*.hf.co`, only after the user's click, pinned by SHA-256 like every model. Kept there rather than re-hosted on the project's GitHub release, because uploading release assets is the owner's release step (docs/DEVELOPING.md §15); re-hosting later changes only `MEMORY_MODEL`'s URLs. CLAUDE.md's network rule and README name the host. **Consent:** a download prompt in Settings › Memory while memory is on (the click is the agreement, as for the speech models), not a change to memory's note; `features.memory: false` covers it. The kill switch stops indexing and ends the process (`memory` part). |
| Native speech on Linux | **Built 2026-11-03** (branch `ember-improve/20261103-native-linux-speech`) | **Departure from §2 "Voice"** (sherpa-onnx WASM on Linux, because the native addon needs glibc 2.32): the RPM and the AppImage now run listening and Ember's voice on sherpa-onnx 1.13.8's own prebuilt C API (`libsherpa-onnx-c-api.so`, `libonnxruntime.so` 1.28.2) through koffi, from `resources/voice-native`, with WebAssembly as the fallback. **Why:** it is the largest single speed-up docs/ASSISTANT.md phase 1 found, the prebuilt libraries need only GLIBC_2.17, GLIBCXX_3.4.19 and CXXABI_1.3.7 (inside RHEL 8's limits, so nothing is built), and they are libraries loaded with koffi, not Node addons (`ember.nativeModules` stays `[]`). **Packaging:** `CAPI_RELEASE` (app/voice/models.ts) pins the archive and each library by SHA-256; `scripts/voice/fetch-capi.mjs` fetches and checks them (`npm run package`, CI), stage.mjs copies only matching bytes and adds their notices (Apache-2.0 with Eigen's MPL-2.0 and eSpeak NG's GPL-3.0-or-later, ONNX Runtime's MIT and notices) to THIRD_PARTY_NOTICES; `npm run check:symvers` and rebuild-el8.sh check them; the RPM generates no requires or provides for them (`rpm -qpR`). Nothing is downloaded at run time. **Choice** (`capiChoice`, app/voice/runtime.ts): native when the libraries are there and the processor has `CAPI_CPU_NEEDS` (none for 1.13.8: disassembled, its AVX/AVX2/AVX-512 code is all in MLAS kernels onnxruntime picks from CPUID), WebAssembly otherwise or with `EMBER_VOICE_BACKEND=wasm`; a library that doesn't load gives WebAssembly in that process, and a process that dies loading restarts on WebAssembly (`voice.native_failed`, as on Windows and macOS). Logged as `voice.backend`; `ember doctor` shows **Speech**: "On this computer (native)". The natural voice stays off on Linux (`VoicePlatform.naturalVoice`). Windows and macOS are unchanged. **Measured** (2.1 GHz Xeon, 4 vCPUs, load average 4–6 from other work; `scripts/perf/latency.mjs`, median / p95, WebAssembly → native): first token → first audio 733 / 1,280 → 352 / 626 ms; a first chunk's audio 553 / 980 → 202 / 347 ms; the voice's cold start 1,706 / 1,726 → 1,463 / 1,478 ms; listening's load 2,056 → 1,505 ms; wake → listening 152 / 844 → 148 / 165 ms; end of speech → transcript 725 / 755 → 715 / 785 ms (the VAD's silence; Moonshine is made ahead either way). `scripts/voice/bench.mjs` (5 runs): listening real-time factor 0.220 / 0.230 → 0.077 / 0.096, Piper's first audio 460 / 531 → 130 / 148 ms, its real-time factor 0.348 / 0.426 → 0.114 / 0.123. **Size** (built with `npm run package` in `rockylinux:8`, without the SSH Node runtimes, the same in both): RPM 289.8 → 298.2 MB, AppImage 312.8 → 322.2 MB; 32 MB installed. **CI:** the `el8` job runs the voice suite on both builds; the `package` job checks the libraries' glibc needs, `rpm -qpR`, that they load in the installed Ember, and that the installed RPM and the AppImage choose native. No consent, safety check or network call changed; audio stays in memory. |
| Tasks settle when they end | **Built 2026-11-03** (branch `ember-improve/20261103-task-settles`) | **Found:** the owner said "close Microsoft Edge" on Windows; Ember asked, they allowed, Edge closed, and the bubble kept "Working · Thanks! Carrying on." (the handle the task's name, the ring its busy pulse) for good. The Confirmer's answer bubble belongs to no presenter: a task that works in the corner ends on its card, so once the conversation's reply had gone (the question came seconds later, after the accessibility bridge's first start) nothing took the answer down; an expired question or "Not now" left "Okay, I won't." up the same way. **Now:** `ConfirmerTiming.afterAnswer` runs `ANSWER_MS` (1.5 s) after an answer; main's `afterAnswerPatch` shows again what the question covered or held off (`BubbleOwner.afterAnswer`, through `AgentHost.afterAnswer`), else empties the bubble. A conversation turn that ran only steps is hidden at its end, and an answer that comes whole (no deltas) is an answer (mood idle, Ember's title), not "Working · Thinking…". A worker whose own step closed its window (its element gone, the window not found at its key) is told `WINDOW_CLOSED_BY_TASK` (finish, and never carry on in another window) only when that was the task's own window and its app opened nothing in its place. The task's own window is the first non-dialog window it read (the user's, where tasks start), moved to a non-dialog window of another app as soon as the task acts there (it switched to or opened the app it works in), never to a dialog or another window of the same app. One rule for any other window that closes: a note that sends the task back names only a window of the closed window's own app that the task itself perceived (not one it only saw in list_windows, which lists the user's own windows too) and that is still open (its own window first), never by process alone (UWP frames share ApplicationFrameHost's, Explorer's dialogs explorer.exe's); a dialog's says carry on (`dialogClosedNote`; never list_windows), another window's is neutral (`otherWindowClosedNote`: Preferences, a second Edge window); with none, `WINDOW_CLOSED_BY_TASK`. A window the app opened in place of the task's own (Start Center → document) is named (`windowReplacedNote`) only when a listing taken just before that click tells it apart from windows already open (taken during the step's 350 ms arrival pause and kept only once the step runs; 2.4 ms p50, 39 ms max over AT-SPI here). A turn that said its answer before its tool shows that answer at its end, not "Working". Eval script steps take an optional `result` regex. Tests: task-settles.test.ts (every way a task ends), worker-tools.test.ts, sidecar-host-window-closed.test.ts, eval `editor-close-window`. |
| Voice personalisation | **Built 2026-11-03** (branch `ember-improve/20261103-voice-personal`, PR #145 with its review's fixes) | Owner's request: voice that keeps recognising them better and predicts what they'll say next (docs/ASSISTANT.md §7). **Voice Match adapts** (app/voice/adapt.ts): from verified requests (never spoken answers) with 2 s of voice or more that matched by 0.08 over the threshold, one voice throughout, with no stranger turned away, no locked question, no stop and not Ember's own voice in the last two minutes, at most one a minute; a weighted mean of the enrolment (×4) and the last 24 samples, at most 0.02 a step, within 0.95 of the enrolment; the gate then asks 0.75 + up to 0.03 of the learnt print, and of the enrolment 0.74 to be heard and 0.75 (its own threshold) to be verified. LibriSpeech dev-clean, 40 speakers: same room heard FRR 8.4 → 7.8 %, FAR 3.0 → 1.8 % (verified 8.8 %, 1.7 %); another microphone (200 Hz–5 kHz, 30 dB SNR) FRR 52.2 → 50.9 %, FAR 1.6 → 1.5 %; a drift attack of 200 crafted samples per pair let 3.1–4.0 % be heard and 3.0 % (the baseline) be verified (98 % without the limits). Settings › Voice: Keep learning my voice (on), Reset to my enrolment; voiceprint.json (0600) gains the anchor and up to 24 prints, numbers only (an older Ember reads the new file as no voiceprint). **Personal vocabulary** (app/main/personal/correct.ts): the transcript corrected after Moonshine against Ember's name, installed apps, memory's `user` names (in force only), learnt corrections and the suggestions shown; nothing but Ember's name in a risky request or one that addresses someone (a name there would change who gets it); a person's name from memory only in a request that just looks something up (find, who, what, where…), never in "ask…", "add…" or "book lunch with…"; a correction that would make a request risky is undone (policy gets the raw words); never a common word; counts only in the log. Name requests' word error 34.4 → 31.1 % (lexicon) → 27.8 % (after "That's not what I said" on a first take), the voice tests' 12.3 → 11.6 %. Learn my words keeps corrections in words.json (0600), never all-common words, a changed verb or a number word. **Predictions** (predict.ts): local rules, chips under the bubble's answer and in the Ask box ("Ember suggests"), never risky unless built from the user's own risky request; a chip is the user's choice of Ember's words (`suggested`), never their own words for a command; the follow-up window 12 s after a reply that asked something (wake unchanged). **Consent:** `CONSENT_VERSION` 1 → 2 (owner decision on review of #145): "Before Ember starts" and the microphone's card say that a taught voice keeps a voiceprint refined from the owner's requests (numbers, never audio) and that the words the user corrects are kept, on this computer until forgotten; everyone is asked again. Forget my voice deletes voiceprint.json and words.json. **Not here:** model-made predictions (local rules only); the corner card in the no-compositor fallback shows no suggestions; keyword-spotter custom keywords (would change wake behaviour). |
| Linux screen-lock discovery recovery | **Built 2026-11-03** | Retry absent or temporarily unavailable logind session discovery 5 s after each attempt, then read the recovered session and keep one idle monitor. Stop cancels retries; a failed monitor retains the 5 s polling fallback. Fake-runner regressions cover startup recovery, terminal-only sessions, monitor failure and cancellation. Real GNOME/Xorg lock and user-switch testing remains required. |

#### Action approval binding (2026-11-03 safety review)

Removed menu-label approval carryover, which could reuse a risky approval in another window without consulting policy. Accessibility, borrowed-pointer and keyboard actions now bind the semantic window tree and target contents and check them after waits, aborting on changed or unreadable context. Tool-level regressions cover cross-window and same-window menu retries, changed dialog consequences and controls, text added during approval or lease waits, changes during pointer movement, and Enter on a changed dialog.

### Voice cancellation and identity revocation (2026-11-03)

M8 Voice Match review SR-1/SR-2: Stop and owner replacement now revoke pending wake, whole-request and post-wake verification. A main-owned generation also rejects already-queued IPC requests and learning samples, with no time-based grace period. Routine adaptation refreshes preserve the identity and finish each pending request against its captured verification configuration. Thresholds, enrolment anchors and voice trust rules are unchanged. Regression tests cover cancellation, replacement/removal, off/on, late completions and fresh requests.

### Remote command completion status (2026-11-03)

M12 review: removed the obsolete terminal exit-marker parser, which let command output replace the real process's exit code. Remote completion now uses only the child process's exit code and signal, as the shared launchers already do. Regression tests cover forged stdout/stderr markers, split chunks and pipe/Linux PTY/macOS PTY launches. Real Linux loopback SSH reproduced both false codes before the fix and passed after it (13 passed, one system-policy case skipped); native macOS SSH is unverified.

### Reliability follow-up and beta preparation (2026-11-03)

- Worker state and lifecycle: hold the existing re-entrant window lease around a toggle's fresh context/desired-state read and action; Stop/deadlines bound pending session creation, tool verification and sending. Late sessions are disposed without receiving work, and queued tasks regain their slots. Approval, context-change and cancellation checks remain enforced.
- Conversation: match spoken ownership to the request that actually starts; retire interrupted answer callbacks, buffered chunks and acknowledgements. Playback events carry the hush generation so an old completion cannot open a newer follow-up. Ordinary short negative clarification replies are preserved; formal approvals still go through the same question-bound rules. Background task results keep their cards without cutting a foreground answer. Physical playback and actually-heard-content measurement remain native gates.
- Existing PRs: reapplied #106's bounded stable window walk and #98's one-week too-slow Kokoro verdict in the current code; reconciled #99/#114 in [docs/PR-RECONCILIATION.md](docs/PR-RECONCILIATION.md) without adding a second MCP runtime or enabling unverified hosted connectors.
- Windows safety vocabulary: native testing found “Stored Usernames and Passwords” and “Address Bar” outside the old patterns. Both names now receive the same protection as the older variants. Test fixtures own their classic console, Notepad and Explorer windows and do not depend on the user's default console or environment.
- Extensions: align admitted dotted tool names, retain complete descriptions for consent pins/live checks, and give provider-appropriate authentication advice. Home accurately distinguishes supported MCP plugins from unavailable hosted connectors.
- Release preparation: app and npm launcher are 0.1.1 with matching notes. Publishing remains separate from local implementation and validation; no release claim is made by this entry.

### Review fixes (2026-11-04)

Nine reviewers read `main` at 6b75bf38; each item here was checked against the code. Memory, the reconnect's account lookup, the workspace library and model calls now fail without losing data or holding Project's controls. The action limit is now one count across tasks, as §5 states it: a runaway task can use up the minute for another task, which is the safer failure. The command reviewer's session runs `verifySessionTools`, `tailscale` is classified, the handle's face rests once dozing and settled, and a question no longer hashes every fact. A short spoken yes on a risky step (the owner decision of 2026-11-03) is unchanged.

### Update notices and the voice's source (2026-11-05)

Owner decision. Opt-in update notices (app/main/updates.ts): one unauthenticated request a day to GitHub's releases list, once `settings.updates` is on with its own consent, off under `features.updates` and LOCKDOWN. It only tells; it installs nothing while packages are unsigned. Each release now also attaches the checked `source-*.zip` archives for sherpa-onnx, eSpeak NG and piper-phonemize (GPL-3.0 section 6), so the source no longer depends on third-party repositories staying up.

### A voice conversation (2026-11-05)

Owner decision, replacing the 8 s follow-up window and Voice Match as a gate (§2 Voice): "a voice agent needs to be continuously listening … if the current responding to only my voice is causing this problem, get rid of it." Found on the owner's Windows laptop (Realtek microphone array): 45 of 112 wakes and requests in one evening's log turned away, the owner's own at 0.50–0.74 against 0.75 (measured on 2.5 s of clean LibriSpeech; real requests are about 1 s). **Voice Match** decides only what a voice may approve: `rejected` still ends task trust and locks a question, then the request is heard, unverified. The first look at the wake phrase is gone. **A conversation** (`voice.conversation`, on by default, `CONVERSATION_IDLE_MS` 30 s): no name, turn limit or loudness test, stays open while a reply or a task is at work. **Cut-ins:** Chromium's AEC took Ember's own voice to 1–2 dB under the room at 96 % volume, with no VAD onset (scripts/voice/echo-check.mjs), but also took a second voice with it: "Wait, tell me about the weather instead." came through as "Other in step.", 3.5 s late. Ducking at the first VAD frames fixed both: cut in at 1.3 s after the sentence began, "Which tell me about the weather instead?", 0 self-interruptions in a full reply. Echo safety on other hardware: `spokenByEmber` and a learnt loudness (`ECHO_MARGIN`). Measured with Windows' speech through the same speakers, not a person. **Turns:** `AgentHost.ask` `replaces` aborts the reply on its way (`Conductor.replaceTurn`, no "Stopped") and sends the new words with a host-written line, so the prompts stay byte for byte; tasks go on, on their workers. **Other sound:** Windows output level through system audio loopback (-109 dB quiet, -13 dB playing), only while a conversation is open; macOS has none yet. **Recognizer:** Moonshine v2 base. **Wake:** `CALLED_AS_WORD`, `nameOnItsOwn`, `NAME_FIRST_FRAMES`. `CONSENT_VERSION` 6.

### Everyday browsing without asking (2026-11-05)

Same report: with every switch on, Enter in Edge's address bar still asked as a field that may send. **Widened** §2 Approvals (`Risk.plain`) by two more allow-lists that fail closed: `goesSomewhere` (one-line fields named search, address, URL or location, outside a dialog) and `BROWSER_KEYS` (moving between a browser's pages and tabs), plus Ctrl+W where the user's own words say close. A page's document with the keyboard and no editable state isn't a field (`notEditable`). A page's link is content (`linkCommands`). **Tightened:** every button on a checkout, payment or billing page asks (`PAYMENT_PAGE`), after "Activate now" went unconfirmed on GitHub's checkout (audit of 2026-11-01).

### Light mode (2026-11-05)

Owner decision, replacing "dark only". `settings.appearance` (system, light, dark; system by default) sets `nativeTheme.themeSource`. Content windows (`html.content`) take ember.css's light tokens through `prefers-color-scheme`, measured by light-mode.test.ts. The floating layer stays dark, because it sits over any app and its labels are measured against that.

### Hear me more clearly (2026-11-05)

Departure from §2's offline Moonshine, as an option. Owner's report: what Ember showed wasn't what was said. On 240 synthesized requests as a laptop hears them, Moonshine base got 6.0 % of words wrong (8.4 % in Hindi-accented voices), Parakeet TDT 0.6B v2 2.8 % (3.8 %) for about 0.2 s more a request and 550 MB more memory (docs/ASSISTANT.md §10). `voice.clearHearing`, off by default, a 482 MB pinned download after the user turns it on, native builds only; Moonshine stays the default and does every quick check.

### Web pages that live on their own (2026-11-05)

Same report: every click on a YouTube result was refused, since the 2026-11-03 check on repeated names and the binding of a step to the whole tree can't hold on a page with a preview playing. A step that asks nothing in a web page, outside a dialog and with no risky word, now needs only its window and the object itself (`livingPage()`, worker.ts). A question still binds to the whole tree. Checked on real YouTube in Edge: the first result opened in one click.

### Supertonic (2026-11-05)

Owner's choice by ear of six voices and then all ten of Supertonic 3's: its fifth, as a third value of `voice.naturalModel`, downloaded after an explicit choice, on the native addon only. On a laptop that refuses Kokoro at 0.78 of real time it comes to 0.25–0.33. Its weights are under the BigScience Open RAIL-M licence. **Before a public release:** ship a copy of that licence and its notices, put its use restrictions (Attachment A) in terms users agree to and tell them so, have a lawyer read restriction (l), medical advice, against a general assistant, and credit Parakeet (CC-BY-4.0).

### First-run connection (2026-11-06, FE #2–#6)

Audit FE #2 and #3 (own provider offered in setup; failure actions by reason) are implemented in full, #4 (models reviewed before the first request, premium multiplier shown), #5 (a text-only task model is explained, never an empty selector) and #6 (a failed setup fix is shown in its row). No §2 decision changes: the provider's consent card, key store and test are the existing ones (FEATURE_CONSENT_VERSION.provider), driven from first run. The own-provider step is an optional detour at step 3 (like the character and about-you steps), so the six-step route is unchanged.

### Product audit fixes (2026-11-07)

A product audit read `main` at 4d64d3a (0.1.1) in 13 areas: first run and setup, Home, the companion and Ask,
listening, speaking, tasks and approvals, safety and privacy, commands, WSL and SSH, models, providers, extensions and
projects, memory, accessibility and copy, reliability and platform, and install, docs and developer experience. For
each, an auditor read the code and walked its journeys as a first-time person, as an everyday user and with things
going wrong, probing the live app under Xvfb with the mock model and rendering the built pages in Chromium where that
helped, and reported findings with file and line evidence. An adversarial verifier per area then tried to refute each
one, set its own severity and added what the auditor missed. Of 139 findings, 109 were confirmed and 30 confirmed in
part, none refuted, and the verifiers added 28. The 167 went into 13 work packages in two lanes (overlapping findings
into one package): 149 are fixed, 15 partly and 3 skipped. Each fix is pinned by unit, renderer or source tests, and
UI changes were checked in real renders (light, dark, narrow widths, Larger text and forced colours where they apply).

**First run, Home and the companion.** First run, Home and the bubble name the model service actually in use (the
user's own provider, the organisation's service or a lockdown), not always Copilot: "Locked by your organisation" with
no Connect button or raw policy error, a failing provider led by its own details, keyless local servers (`keyNeeded`),
and `stillWaiting()`/`noticeTitle` by service. A returning user whose consent is out of date opens at the consent step
with what changed since their version (M8.8: `CONSENT_CHANGES`, one line per bump, checked against the full text). The
setup check has Check again (a fresh pyatspi probe), uses first run's state words with Copy in Home, and counts a row
that holds Ember back as one to fix in Home and `ember doctor` (M9.3). Home shows the latest 6 messages
(`CONVERSATION_SHOWN`, was 30: at 760×640 with 30 messages the composer moved from 4,195 px to 1,361 px down and from
60 to 27 Tab presses), keeps the composer in view as a reply grows, and stays page content with no inner scroller.
Stop response reports whether anything was under way, the 10 s stall is heard once by screen readers
(`BubbleState.stalled`, `stalledStep()`), restored lines are marked only in `getTranscript()`'s copy and never saved,
New conversation asks first and a refused send says why (`composerRefusal()`). Task activity keeps keyboard focus
across redraws; Search reads a setting's words as shown (`shownText`); What Ember did pages through the whole audit
(`activityLines()`, `recentLimit()`, `AuditLog.recent` past its 500-entry cache) and keeps its lines when a read
fails; Projects and reminders follow the one-prominent-button and fold-chevron rules, and no pane reflows sideways at
304 px. Ask opens clear of the bubble (the overlay reports the bubble's box; `openingBounds`/`clearOfBubble`), takes
clicks on Linux only on what it shows (an X input shape through the platform shaper), leaves Esc and ↑/↓ to a
composing input method and says before a request is typed that Ember can't answer yet (`AskContext.unavailable`). The
no-compositor corner card (M1.3) grows to 640 px for any question and holds every answer but Not now while its
sentence can't show (`waitsForRoom`). The handle says "Finish setting up" until first run is done.

**Voice.** Teaching Voice Match hears "Ember, stop" (`VoiceEngine.stopsOnly`), ends at `ENROL_LIMITS` (45 s quiet, 180
s in all), on the kill switch and when Home closes, and says how it ended (`VoiceMatchStatus.ended`). Listen once's 8
s is a deadline for speech to start, capped at 20 s from the press (`MANUAL_MAX_MS`); it reports a microphone sending
exact zeros and hushes Ember first. A request that trails off after "the" or "and" is held 0.9 s (`trailsOff`,
`TRAIL_HOLD_MS`: the trailing half of docs/ASSISTANT.md phase 1 item 5), and the models' download can be cancelled.
The owner decisions of 2026-11-05 (Voice Match never decides who is heard; over other sound only the name or the
owner's voice counts) are kept. Spoken text (`spokenText`) says lists, numbered steps, money, clock times, paths and
"~" for the ear and drops emoji; pieces are at most 120 characters (`CHUNK_MAX`) and synthesis runs at most about 8 s
ahead of playback. The first sound of the audit's long answer went from 1,892 to 500 ms and a cut-in from 1,451 to 873
ms; warming the voice at the ask box and at a request's start took a cold first sound from 2.7 to 1.9 s. Never hushes
at once, the handle has Stop speaking (not the kill switch), Kitten failures and slow timings offer Try again, replies
in other languages go to a local system voice for that language or aren't said, and Settings › Voice has Speaking
speed (`voice.rate` 0.8–1.4) and Hear Ember.

**Tasks, safety and commands.** An unanswered question now ends its task as a retryable stop (`endedBy: "expired"`,
with Try again and a notification when the user is away), and a bare "try again" carries the failed task's own words
(`TaskManager.askedWith`). The actions-a-minute limit (M8.1) paces steps instead of refusing them
(`PolicyEngine.paceMs`; refused attempts no longer count). Unasked or steered questions quote the user's words as
their task line, a refused spoken yes keeps the key hint under its note, outcomes use the card's words, worker tool
failures are logged and explained, the command review's words leave the journal (sizes only), and a typed "stop" pulls
the kill switch while a task is at work (M8.9). Users can turn screenshots off for tasks (`settings.screenImages`,
Home › Apps & privacy; the admin's `features.screenImages: false` forces it off), and every screenshot is audited
before it is sent (event `read`, kind `screenshot`, app and size only; M8.6). Commands (M12): the session's first run
gets its window's real fit (`defaultFit`) instead of 100×30; `if`, `for`, `while` and `until` on sh and bash command
lines are read through as in scripts (`readThrough`, `withoutReadFlow`), on the PC and in the SSH remote's gate alike
(narrowed in the sixth round and, for loops, taken back to main's after it: below), which also closes two bypasses
(a loop over PATH-like names asks; a nested `zsh -c` short form is no longer read
through); "You didn't ask for this." is kept for words that ask for nothing of the kind (`LINES.inexact` for words of
the right kind); every risky card looks risky; pre-8.5 SSH question cards say where the answer goes; and a host whose
name can't be found on first add isn't kept.

**Models, extensions, memory and reliability.** Before connecting to a model server on this computer, Ember asks the
provider service for Test connection's one GET (`probeProvider`/`providerDown`) and retries like an offline start if
nothing answers; Test connection names up to 50 listed models. Copilot's built-in marketplace reaches Home as built
in, with no Remove; extensions have a Use extensions switch and a not-connected state. Project failures carry the
error's type and status into `friendlyError`'s sentences, and minimising or hiding settings no longer aborts project
work. The update check persists its last look (`updates.checkedAt`), so it keeps to once a day across restarts.
Memory's guard refuses secrets however they are phrased, and the commands and log redactors know today's API key
shapes (`TOKEN_SHAPES`). `MemoryOwner` says why memory is paused; summaries and reflections record `derivedFrom` and
go with their fact; every Forget can be undone for 60 s; `forget_memory` needs the user's own words (`asksToForget`);
remember and forget requests made while memory isn't in force are answered truthfully in code; the profile goes with
each request (`requestContext`, `profileFacts`); a changed preference closes the older fact. The spoken interview
keeps just the name (`nameFrom`), a Forget reopens what a fact replaced only within `FORGET_THAT_MS`, recall over
5,000 matching facts went from 97–135 ms to 15–23 ms with bit-identical scores, and a reconnect that finds the same
account keeps Home's draft, focus and a Better recall download (`MemoryEpochAccount`, `memoryWanted`). The Copilot
runtime is pinged every 2.5 s while work is under way and every 20 s at rest; each start step has a time limit (30,
20, 20 and 30 s), logged as `agent.start_failed` `{ why: "timeout", step }` and retried like a 5xx. The accessibility
helper's restarts back off from 2 to 60 s. Faces at rest are drawn about 6 times a second (`restingGap`,
`frameSeconds`), the main process's frame loop drops from 60 to 10 Hz after 2 s still, and the whole tree at rest
measured 8.7–10.1 % of a core on Xvfb (was 11.4–15.2 %). The pyatspi probe runs in the background after its first
answer, and a run marker (`run.json`, 0600) logs `app.previous_run_ended` and shows a note in Home after an unclean
exit.

**Install and docs.** README, docs/DEVELOPING.md, the npm launcher's README and the RPM's `policy.README` match what
0.1.1 ships: what Ember needs and what its first start asks, the AppImage carrying its models and needing fusermount,
the optional downloads with their sizes and hosts, and all 15 `features` keys with the seven that lock a 0.1.0 Ember
down. The npm launcher runs the setup check attached, reports an Ember that fails to start and removes older cached
versions; clicking the new-version notification opens Home's Updates section. CHANGELOG.md's 0.1.0 section is the
published text again, and 0.1.1 has its own sections, a Getting it list and the administrators' line, guarded by
docs.test.ts, which also pins 0.1.0's section to the published text (install-docs-4 and -v1, which the docs package
skipped because it could not edit CHANGELOG.md, were done afterwards with these notes, so of the 3 skipped only
memory-10 is left).

**Consent.** `FEATURE_CONSENT_VERSION.memory` went from 3 to 4: memory's note now says what goes to Copilot with every
request and that the idle tidy sends up to 40 facts up to 6 times a day (memory-5, memory-9).
`FEATURE_CONSENT_VERSION.extensions` went from 2 to 3: the card for a plugin from Copilot's built-in marketplace no
longer says the user added that marketplace (integrations-4), so installed extensions are agreed to again once.
`CONSENT_VERSION` stays 7, and `FEATURE_CONSENT_VERSION.provider` stays 1 on purpose: a bump would take every agreed
provider back to Copilot until the user agreed again.

**Departures.** None from §2. One earlier §10 entry is superseded: M8's Hard blocks (M8.3) said that while a polkit,
keyring, sudo or pinentry prompt is open or focused Ember doesn't read it, takes no screenshots and won't type. Now,
while GNOME Shell's own password prompt is up (or the shell can't be looked through), Ember reads, sends and does
nothing (`Perception.promptOpen` gates `quickContext`, `describe_screen`, `perceive_window`, tier-1 steps, `open_app`
and `list_windows`), as CLAUDE.md states. A polkit agent's own X11 window on other desktops still only blocks
screenshots and the borrowed keyboard while it has focus.

**Left.** Partly fixed: the route after re-agreeing to consent and the provider card's wording (first-run-4, -10,
safety-privacy-8, integrations-2, -13: rewording the provider card needs a `FEATURE_CONSENT_VERSION.provider` bump);
Browse fetching the built-in marketplace before extensions are agreed to (integrations-4); Task activity's image
wording and auditing the conductor's `describe_screen` and quick context (safety-privacy-6); npm.yml skipping a tag
run without publish credentials (install-docs-2); an hourly retry of a failed update check, which would break the
once-a-day promise, and a per-install update line (install-docs-11; the line is fixed in the second round, below);
a microphone picker (voice-listening-v2); idle
CPU still above docs/ASSISTANT.md §3's 3 % and PSS about 505 MB against its 400 MB (rp-4); a first status read that
can still wait about 5.7 s on a hung pyatspi import (rp-1); Stop speaking on the bubble (voice-speaking-5); a native
`generate()` that can't be interrupted, so a cut-in still waits for the piece being made (voice-speaking-10); and
which Kitten voices to offer, with samples of the optional voices before download (voice-speaking-7). Skipped: showing
which memories shaped an answer (memory-10), a feature that needs its own design. Native validation: the new-version
notification's click on real notification servers; the npm launcher's attached `ember doctor` on Windows and macOS; on
a real RHEL 8 GNOME on Xorg session, whether a shell modal moves X focus, and the cost of `shell_overlays` now that it
runs on every read; Ask's place beside the bubble and its X input shape, which no CI job with a compositor covers; and
run-marker-live.test.ts, which failed once in eight runs before it was made to poll. Owner decisions: whether to skip
the steps after re-agreeing to consent; whether "be quiet", "shut up" and "that's enough" only hush; Cinder's flame at
about 6 fps between fidgets; keeping local minidumps; whether Forget my voice keeps `words.json`; whether the release
job publishes as a prerelease titled "(beta, unsigned)" while builds are unsigned; and whether npm.yml should fail a
tag run that can't publish.

### Product audit fixes, second round (2026-11-08)

Each of round one's 13 areas was rated again at a478f2e by two readers working apart: a re-rater, who scored it afresh
from the code and the live app (Xvfb with the mock model, the built pages in Chromium) and listed what was still
wrong, and an adversarial challenger, who tried to break each of round one's fixes and looked for regressions they had
caused. Their scores, before and after, are in the PR. Their 141 items (new findings, regressions and round one's
partly fixed ones) went into 13 packages, one per area, in three lanes merged at 4bd78a3: A (first run; models,
providers, extensions and projects; Home; accessibility and copy; install and docs), B (memory; listening; speaking;
the companion and Ask) and C (commands, WSL and SSH; safety and privacy; reliability and platform; tasks and
approvals). 108 are fixed, 17 partly and 14 skipped; 2 were already fixed by an earlier round-two commit
(install-docs-r1 by dbf0d2a, accessibility-visual-r2 by 530d1f2). Each fix is pinned by unit, renderer or source
tests, and UI changes were checked in real renders.

**Regressions.** The re-raters and challengers found regressions that round one had brought in; all are fixed here.
Three were P1: after Not now, focus on Agree let a second or held Enter agree to the consent (first-run-c1-1);
memory-v1's answers in code swallowed ordinary requests that began with forget, remember or keep in mind while memory
was off (memory-c1-1); and the loop read-through took a `NAME=value` word after `then` or `do` for the program, so
`if true; then LD_PRELOAD=./x.so ls; fi` ran without a question and a download inside an `if` went unrecorded
(commands-remote-c1-1). Four were P2: Back from the provider step switched off a provider already in use
(first-run-c1-2); Listen once's wait for the end of speech sent a TV's or a colleague's words after 20 s
(voice-listening-c1-1); Stop speaking cut off the answer with the voice (voice-speaking-c1-1); and the language check,
piece by piece, sent English that named La La Land to another voice, or to none and reported speech failing
(voice-speaking-r1). Others: Home's wait never ended for a turn that wrote nothing (home-c1-1); hidden empty live
regions kept screen readers from hearing Home's status lines (accessibility-visual-c1-1); the trailing-word hold
joined nearby talk (voice-listening-c1-2); the first sentence was cut after "is going" or inside a link, and a
heading's lookbehind cost seconds on a long answer (voice-speaking-r2, -r4); negated words counted as asking for a
command (commands-remote-c1-2); the preference rule closed unrelated preferences (memory-r1); the shell-prompt check
failed open on errors and timeouts (safety-privacy-r1); a GNOME logout read as a crash at the next login, and Check
again's fresh probe held the main process for 5 s on a hung import (reliability-performance-r1, -r2); and a local
server's retries flipped the status every minute, while a restart forgot a newer version already found
(integrations-c1-2, -r6).

**First run, Home and the companion.** First run names the user's own provider while it connects or fails, a provider
step that opens with it in use shows it as in use (only "Use GitHub Copilot instead" turns it off), and the hello and
Home's connect button name the service that can't be reached (`hello()`, `connectLabel`). The consent's Agree and Quit
Ember ignore a press for `AGREE_ARM_MS` (500 ms) and Not now focuses its note (M8.8); Sign in and Cancel survive a
double Enter. Home no longer guesses when the conversation's turn ends: `AgentHost.conversationTurn` (idle, thinking
or slow, from `TurnWatch`'s `onChange`, the bubble's stall, the queue, held requests and the connection waits, pushed
on `IPC.conversationTurnChanged`) drives the composer's wait and the status panel, replacing Home's 10 s timer, and
while the turn is slow the settings key lands on Stop response (`keysLanding`). Every polite live region in Home stays
mounted while empty (one `:is([role="status"], [aria-live]):empty` rule), Send, Stop response and Copy use
`aria-disabled` while pending, and `idleWord` names the service in use. The Ask box stacks over or under the bubble
where it fits beside neither (it covered the bubble in 11 and 9 of 14 live openings at two screen and text sizes, and
now in none of 56 across four); main tells the overlay where the open box is (`EmberState.askBox`), so a later bubble
keeps off it, a question already shown never moves (`askKeepOff`), and one with no room moves the box aside once,
inside the Confirmer's 500 ms arming. The no-compositor corner card (M1.3) draws keys as keycaps (`stepParts`),
`questionHoldsListen` was to keep Listen once's Cancel listening (it changed nothing, since a question still ends the
listening: see the third round, below), and the Ask field keeps a long paste whole with Home's count.

**Voice.** While Voice Match is taught, `VoiceEngine.stopsOnly` takes a spotted bare name or "Hey Ember" as a stop
candidate confirmed from the transcript (`saidWakeStop`), so the spoken kill phrase (M5.3, M8.9) works there on the
real models: 48 of 48 stops while teaching, 0 of 56 on clips that aren't one, on WASM and the C API. Listen once waits
past 8 s only for speech 10 dB over the window's first second (a TV alone now ends it at 8 s, 6 of 6) and puts the
deadline 0.4 s later, once, for the VAD's onset lag; the 0.9 s hold joins only a continuation within 6 dB of the held
part (room talk joined 12 of 18 times, now none). Stop speaking silences only the voice (`answerHushed`), so the whole
reply reaches the bubble, Home and the transcript. An answer's language is decided once from its first 60 letters
(`AnswerLanguage`, `VoiceService.speak()`'s `lang`), and `speechLanguage` ignores capitalised name runs and needs two
different stopwords (English kept 57 of 59 times, was 51; foreign found 23 of 25, was 16). The first-sentence cut no
longer uses to, for, from or with and checks Markdown at each cut, `sentenceEnds` scans only past what was said (6,000
characters stream in 12 ms; they took about 30 s), Hear Ember answers once its sample is heard
(`VoiceService.sample()`), Kitten is timed again by itself, once a session, at a request 5 minutes after a too-slow
timing (`KITTEN_RECHECK_MS`), and `spokenText` says hearts, durations, bare addresses and bare-line lists for the ear.

**Tasks, safety and commands.** `run_command`'s questions quote the user's own words (`Question.taskLine`) under a
command they didn't ask for or in a steered task. A task whose question went unanswered says "No answer in time" on
its card and in Home, whose Task activity offers its Try again, and Stop everything clears it
(`TaskManager.dismissFailures`). A said or typed "try again" does what the card's Try again does: `askedWith` also
returns `partWay`, the old card goes, what the user agreed to goes with their words, and `retryRequest` and
`retriedWords` take more ways of asking. The helper's fatal answers point to the setup check, "stop typing", "abort"
and "no, stop" stop at once (M8.9), and a limit of one reads "1 step a minute" (M8.1). Safety (M8.3): a GNOME Shell
prompt check that fails or times out, or a desktop the helper can't list, counts as `unchecked` and fails closed, so
reads, the request's context, `describe_screen`, screenshots, tier-1 steps and the borrow stop, and Ember says it
couldn't tell. Send screenshots for tasks is read at every look (`picturesAllowed`), so turning it off stops a task at
work. The quick context sent with every request (M6.2) carries only the window the user is in; other windows' titles
go only through `describe_screen`, as "Before Ember starts" says. Commands (M12): `unwrap()` judges `NAME=value` after
`then`, `elif`, `else`, `do`, `if`, `while`, `until`, `!` and `time` as assignments, keeps an unwrapped program's
redirections and pipe fetch and gives it `simple()`'s control-character and WSL interop checks; `IFS` before `read` is
temporary; negated clauses never count as asking; removal, `crontab -r`, a reset to another ref, `rm *` and a folder
after a `cd` are said as they are; and `PathFact.dir` with `Finding.inFolder` and `standingFindings()` make a copy
into an existing folder ask only about the file it would replace, on the PC and in the remote's gate (WSL not yet).
The command window forgets its page's size on close, the worker persona runs a venv's programs by path, a long SSH
question gets a taller card, and `EAI_AGAIN` counts as the network's.

**Models, extensions, memory and reliability.** Projects keeps its files, request, answer and unapplied diff through
reconnects (`projectAfterStatus`); main and Home forget them together (`project:forgot`) only at sign-out, an account
change and LOCKDOWN, and a previous answer is never sent to another service or account. Check again under a model
provider reconnects to it and never names a GitHub sign-in (`checkAgain`). A remote own provider reads "Using <host>",
since it isn't probed at a start, and the setup check warns when it has no key (M9.3); a local server that is off is
asked about as such and its retries leave the status still; reconnect and stopped-task words name the service in use
(`reconnectWords`); browse failures say why; Updates keeps a newer version across a restart (`updates.told`); and the
extensions agreement can't travel in a Home settings change (`settingsFromHome`, `withOwnExtensions`). Memory:
`memoryAsk` answers in code only a whole request to forget something about the user, and a remember request while
memory isn't in force gets Ember's own note after the answer (`rememberNote`); `preferenceChanged` needs the same
thing in the same place; learned and forgot lines change in place on Undo and say what holds again; the guard refuses
18 more secret phrasings (none of 1,754 benchmark texts changed verdict); Undo works while memory is off; and Settings
› Memory says when memory.json can't be read or saved. Reliability: Linux's `AppLifecycle.sessionEnd` is
`display-gone`, so a quit without will-quit and Xlib's IO error handler (`watchDisplayGone`, handing on to GTK's) end
the session cleanly (10 of 10 killed X servers left no run marker, where the quit path alone left one in 3 of 6 and
the IO handler alone in 5 of 8; a crash still leaves it). `SystemPlatform.lookAgain` joins the background pyatspi look
(main's worst stall during Check again went from 5,019 ms to 10 ms); the rest-time health watch and the frame loop run
on `performance.now()`, so a clock set back neither stops the checks nor holds 60 Hz; and Home's still characters
aren't drawn while Home is behind the focused window (`homeFrameGap`: the whole tree 9.2 % of a core against 11.6–12.9
% with Home open).

**Install and docs.** A tagged README can no longer say its own version isn't out: §15 step 1 replaces the Download
line in the commit that is tagged, and `release.mjs` refuses such a README (`readmeProblems()`), first of all in the
tag's checks job (`--readme`). The README says Kokoro and Supertonic are Windows and macOS voices, how to start the
AppImage, each OS's keys and where the log is. The npm launcher answers `--help` and Linux's no-display case itself
and removes older cached versions only after the new one has started; Updates says how to update each kind of install
(`installKind()`). CHANGELOG.md's 0.1.1 audit section now says what both rounds ship.

**Consent and departures.** No consent version changed (`CONSENT_VERSION` 7; `FEATURE_CONSENT_VERSION` as round one
left it): the narrower quick context sends what "Before Ember starts" already says, and the fixes that would change
agreed words are left to the owner. No departure from §2: every package's notes say so, and no change reaches a §2
decision. Round one's change to M8.3's §10 entry stands, and now also holds when the shell can't be asked, which round
one's check let through on an error or a timeout.

**Left.** Partly fixed (17): a Try again on Home's Problem row that keeps the bubble's retry rule (home-7,
reliability-performance-c1-1); "Copilot stopped unexpectedly…" and the file-watcher lines under an own provider
(integrations-v1; fixed in the third round, below, but for the setup check's row); a remote own provider that isn't
probed at a start (integrations-1); a failing save not said on the "Ember learned" line, no Undo for a forgotten
learnt word, and `forget_memory`'s reply not saying what holds again (memory-r2, -7, -12); changed values with no
shared predicate (memory-4); Stop speaking on the bubble, why the voice changed outside Settings › Voice, and
fractions and phone numbers (voice-speaking-5, -6, -2); X11 authentication prompt windows and a step asked about
before the prompt check refuses it (safety-privacy-3; the second fixed in the third round, below); awake rest with
Home closed at 7–10 % of a core (about 14 % listening) against docs/ASSISTANT.md §3's 3 % (rp-4); a typed "never mind"
(tasks-approvals-v2); npm.yml passing a tag run that can't publish, a sooner update retry and CLAUDE.md's "RPMs"
(install-docs-2, -11, -c1-2; the last fixed in the third round, below). Skipped (14): the route after re-agreeing and
the provider card's wording (first-run-4, -10, integrations-2, -13, safety-privacy-8); browsing marketplaces before
the extensions card (integrations-i2); which memories shaped an answer (memory-10); a microphone chooser
(voice-listening-v2); an uninterruptible native `generate()` (voice-speaking-10); the Ask box's clickable margins on
Windows and macOS (companion-4); the task card's screenshot words and auditing `describe_screen` and the quick context
(safety-privacy-6; the card's words fixed in the third round, below); the first window's 5.7 s wait on a hung pyatspi
import (rp-1); the guard phrasings, done by memory-1 (safety-privacy-1); and folding 0.1.1's older dated sections into
its feature sections (install-docs-4). Found on the way: the Ask chip's count of other windows is now always 0
(`ask-sees.ts`, `chips.ts`); the cards' screen-reader prefix still says "Stopped: " for an unanswered question (fixed
in the third round, below), and Home's timeline end rows read "Stopped: Stopped"; WSL's inspect script reports no
folders; the handle says "Copilot problem" while Ember reconnects by itself (fixed in the third round, below); Listen
once judges talk that starts after its first second as the user's, and the hold sends the half when the user's own
rest is over 6 dB softer; at 800×600 with Larger text the Ask box and a question still overlap; closing Home between
agreeing to a provider and its test leaves it on unverified, and the provider step repeats its no-keyring sentence; a
reminder due in a composer turn that wrote nothing ends it with "Reply received."; the "Ember learned" line doesn't
say what a new fact replaced, the "Remember that…" note isn't spoken, and first run's about-you lead still says
answers are kept once memory is on; a foreign reply's unaccented first word ("Claro.") is still said by Kitten, and
Kitten can play over a system voice; the card still counts "uninstall lodash" as naming `npm install lodash`, and a
VPN-only name with split DNS off is forgotten as a typo (commands-remote-6); after a restart that follows a look
finding Ember current, Updates says "Ember checks once a day…" rather than that it is up to date; the RPM's
`ember --help` names Ctrl+Alt+E, which Ember may not hold (fixed in the third round, below); the activity journeys
pass untested during local hour 0; and `scripts/perf/footprint.mjs` has no awake-rest budget (it has one since the
third round, below). Before 0.1.1 is tagged, the README's Download line and From npm's note must change in the tagged
commit (§15 step 1), or the release is refused. First run's follow-up that Home's Check again names a GitHub sign-in
under a failing own provider was written before integrations-c1-1 merged beside it; at 4bd78a3 `checkAgain` covers it.

**Native validation and owner decisions.** Still to check natively: screen readers on Home's now-mounted status lines,
the stalled turn and the new Try again and "No answer in time"; on RHEL 8.4 GNOME 3.32, how often `shell_overlays`
answers incomplete or times out without a GPU (every read now fails closed on it), which path a real logout takes, and
Mutter with the Ask box's margins and Home's paused characters; the AT-SPI el8 suites, the eval with gedit and
platform-python 3.6; the Windows and macOS spotters on "Ember, stop" while teaching; the loudness rules with real
microphones and a real TV; a question during Listen once on real hardware; language routing with real foreign system
voices, and the wait of up to 60 letters before an answer that looks foreign is spoken; Check again against a real
Ollama or LM Studio; real sshd, WSL and Windows and macOS command paths, and the first command's fit in Consolas and
SF Mono; the Mac's Accessibility-permission message, which `toolFailure` matches by its text; and `installKind()` and
the npm launcher in real packages. For the owner: the route after re-agreeing; rewording the provider card (a
`FEATURE_CONSENT_VERSION.provider` bump); browsing marketplaces before the extensions card; probing a remote provider,
and naming the Copilot runtime to someone using their own; giving requests other windows' titles back with a
`CONSENT_VERSION` bump; X11 authentication prompt windows; memory's predicate names (a
`FEATURE_CONSENT_VERSION.memory` bump); a listening earcon (§6); which words only hush, and whether a typed "never
mind" stops every task; Kitten's voices; "do it again" after a finished task, and whether every question, not only an
unasked or steered one, quotes the user's words; a `for` loop using its variable as a file, and reading through a
stock venv `activate`; the corner card growing to 640 px for any question; the awake resting frame rate
(`RESTING_FRAME_MS`); "Set up voice in Settings…" on every Ask opening; Home's composer sending on Enter; and the
release's prerelease title, signing, npm.yml and a sooner update retry (an `UPDATES_CONSENT_TEXT` bump).

### Product audit fixes, third round (2026-11-08)

After round two each area was rated again at bc4f0ce in the same way, by a re-rater and an adversarial challenger
working apart. Their scores out of 10 (re-rater, then challenger) were: memory 7.5 and 7.0; commands, WSL and SSH 9.0
and 7.6; listening 8.2 and 7.7; reliability and platform 8.2 and 7.8; first run and setup 8.5 and 8.2; Home 8.4 and
8.1; speaking 8.4 and 8.1; safety and privacy 8.8 and 8.4; models, providers, extensions and projects 9.0 and 8.5;
install, docs and developer experience 8.8 and 8.5; the companion and Ask 8.8 and 8.5; tasks and approvals 9.0 and
8.5; and accessibility and copy 9.2 and 8.9. What they left (round two's partly fixed items, the new findings that
survived the challenge, the challenger's misses, and the integrator's notes that gave a cause shared by several areas
to one package) made 128 items, 1 P1, 40 P2 and 87 P3, of which 30 were regressions that round two had brought in.
They went into 13 packages, one per area, worked one after another in six lanes, each fix with a test seen failing
first: D (commands, WSL and SSH; accessibility and copy), E (memory; Home), F (first run; models, providers,
extensions and projects), G (listening; install and docs; safety and privacy), H (reliability and platform, which
owned the accessibility helper's can't-run wording for every area that reported it; tasks and approvals) and I (the
companion and Ask; speaking). They merged at db55151, D first and then E, H, I, F and G. The packages reported 127
items, one of them found on the way (commands-remote-r3-x1): 87 are fixed, 9 partly and 31 skipped, 5 of those because
another lane did them. UI changes were checked in real renders, and the listening and speaking changes on the real
models.

**Regressions.** All 30 are fixed (a few are one problem that several areas reported). The P1: round two's into-folder
rule let `cp --parents src/a.txt ~/backup`, and a Mac's own `cp -R build/ ~/Documents`, which don't land at
folder/name, replace files in a folder that was there without a question; they ask again on this computer, a Mac and
an SSH computer's gate ("Replaces files in ~/Documents if they exist.", commands-remote-c2-1). The P2s: the widened
memory guard refused ordinary codes ("backup exit code 255", "our office ZIP code is 90210"), which blocked Projects
requests and files and task views (memory-r6); a reconnect's account check left focus on the memory switch, where
typing on turned memory off (memory-c2-1); Home said "Ember didn't write a reply" after a model error, and at once
after Stop everything or a reconnect while the reply was still coming (home-r2-1, -r2-2); a failed or abandoned edit
of a provider already in use on first run switched it off (first-run-r2-1); Listen once threw away a long request
begun in its first second (voice-listening-r2-1); a short English reply to a request naming a French or Spanish title
in lower case wasn't spoken (voice-speaking-r2-1); the fail-closed shell check worded a helper that can't run at all,
macOS without its Accessibility permission included, as not knowing whether a password prompt was open and said to try
again (reliability-performance-r2-1, -c2-2, with safety-privacy-r5, -c2-1 and tasks-approvals-r5); and Updates' RPM
line, a bare `sudo dnf upgrade`, left Ember as it was (install-docs-r2-2, also reported as accessibility-visual-c2-2
and integrations-r2-4). The P3s were slips in what Ember says or when: the corner card's stray " · ", "You didn't ask
for this." beside "don't forget to", a Listen once that a question ended without a word, Ask's count, the box moving for
a wake and throwing an answer across the screen, an unanswered card's screen-reader prefix, the bubble's Stop told in
Home as no reply, "can't connect" when only a model name was missing, the "won't keep this" note after any remember,
"Provider problem" while the runtime restarts, the data list's "a model service I can't tell yet", a timed-out note
promising Try again on a finished task, and an accented name holding back an English answer (accessibility-visual-r2-2,
commands-remote-r2-1, companion-r2-2, -r2-3, -r2-5, -c2-3, -c2-4, home-c2-2, integrations-c2-2, memory-r8,
reliability-performance-c2-3, safety-privacy-r6, tasks-approvals-c2-2, voice-speaking-r2-2).

**First run, Home and the companion.** The consent step's short form names the recipient from the same answer as its
full text (`modelDestination`; first-run-r2-2, M8.8). An edit to a provider in use is checked as typed before it
replaces anything: `provider:test` takes a zod-checked draft and sends its one model-list GET to the draft's agreed
host only, saving nothing, and a failed or overtaken check says "Nothing has changed: I'm still using <host>."
(first-run-r2-1). Main tells Home a turn has ended a microtask after the lines and the Stop-everything message that
end it (`AgentHost.turnChanged`), a request counts as answering from its first wait until it is queued, and the turn
is pushed as `{ turn, ended? }` (`ConversationTurnChange`), so Home says how a turn ended instead of guessing
(home-r2-1, -r2-2, -c2-2). A typed "stop" gets through while Ember waits to reconnect (`composerSendRefusal`, M8.9;
home-c2-1), the line under Stop response reports a stalled Ask box or spoken request (home-r2-3), and a Problem line
names Models & connections with a way there (home-7, partly). Ask offers suggestions only through the pure
`askSuggestions`: none while a question is up, reply-bound ones (`follows` in predict.ts) only while their answer
shows, and main refuses a chip not offered (companion-r2-1, -c2-2). `BubbleOwner.holdForAsk` holds every presenter's
hide timer while the Ask box is on screen, and at least `ASK_AFTER_MS` after (companion-c2-1); an answer already shown
keeps its place (`askKeepOffKey`, companion-c2-4), and only the box's own Listen once moves the box (companion-c2-3).
The corner card (M1.3) puts each chord on its own line and the bubble keeps each chord whole
(accessibility-visual-r2-2, companion-r2-4); a control Home focuses for main shows its focus ring (`focusVisible`,
accessibility-visual-r2-1); and one `:where(html.content)` rule keeps every content window's empty status lines in the
accessibility tree, so a refused Allow, the approval hints and "Starting Ubuntu…" are announced
(accessibility-visual-c2-1). Ask's live region says "I can answer again." (companion-6).

**Voice.** Listen once (M5) measures speech still under way at its 8 s deadline against the room before that speech
began (the window's frames with no VAD speech, the VAD's 9-frame lag counted as the speech's own), not against its
first second. Speech begun in that second can't be told from talk resuming after a pause, so it is heard only up to
`MANUAL_DOUBT_MS` (12 s from the press) and is otherwise the room's, with nothing sent, and a request held for its
rest when the window ends is sent as it was (voice-listening-r2-1, -1, -3: 4 of 4 long requests heard whole on the
real models, and all 118 TV-at-the-press cases send nothing). While a screen reader runs, main sends the voice process
the phrases Ember's windows announce as Listen once opens (`LISTEN_ONCE_ANNOUNCED`), and the engine takes them off the
start of what it hears (`withoutAnnounced`; voice-listening-c2-1); the voice line says "Listening…" while the window
is open and the handle's badge "Listening" (-c2-2). A question still ends a Listen once, and its control now says so
(`LISTEN_CUT_BY_QUESTION`, companion-r2-2, companion-r1). Speaking: a request sets an answer's language only when it
is clearly in it (`requestLanguage`: three different short words outside quotes and names, and no word only English
writes), a message before a tool call decides nothing for those after it (`more`, passed to `AnswerLanguage.take`),
and accents count only outside names and clearly English pieces (voice-speaking-r2-1, -r1, -r2-2). `spokenText` drops
a marker left at a cut's edge (-c2-1) and says arrows and ranges (-2, partly); `sentenceCut` rescans only past ends
judged for good, so a 12,000-character table streams in about 5 ms instead of 20 s with identical pieces (-r4); a
comma-less first sentence is cut before a phrase's preposition (-r2); and plan lines after a colon end as a list (-3).
They were checked live with real Kitten through the C API.

**Tasks, safety and commands.** The accessibility helper's can't-work answers (`helperCantRun`: python3-pyatspi
missing, no session bus, macOS's Accessibility permission, an AX API or bridge that can't load or start, an
out-of-date helper) are `promptOpen` "helper": every read and step is still refused (M8.3), but the conversation, the
task (`HELPER_DOWN`) and the audit say the helper isn't working and that the setup check says why, while a timeout or
a restart keeps "try again" (reliability-performance-r2-1, -c2-2, safety-privacy-r5, -c2-1, tasks-approvals-r5, -8).
macOS lists the system's own windows from the window server without starting the provider
(`AxProvider.systemWindows`), so the prompt check runs before the permission, and the Linux helper picks up pyatspi
installed while it runs (reliability-performance-c2-1). The worker checks for GNOME Shell's prompt before it puts up a
question as well as before it acts (`promptRefusal`), and `shell_overlays` answers incomplete when the desktop lists
an app it can't hand over (safety-privacy-3, partly). A task's card and Task activity say when a read sent the model a
picture (the `picture` activity; safety-privacy-6, partly, M8.6), and Apps & privacy's data list follows where
requests go and is redrawn only when its words change (safety-privacy-r6, -r4). Tasks (M4.1): a kill-switch pull
reconnects only when extension tools were loaded or a server launched, and any reconnect hands the ended tasks' rows
to the next TaskManager (`TaskManager.history`, the 20 kept), so Task activity holds until quit
(tasks-approvals-c2-1); cards kept to be read wait while the user is away (main's `userAway`, polled every 5 s), and a
typed "try again" carries the task's words while its card offers Try again (tasks-approvals-4); the timed-out note
promises Try again only if the task can't finish without the answer (-c2-2); and an unanswered task reads "no answer
in time" in the conversation, in speech, in the cards' and the handle's screen-reader prefix (`cardStateWord`) and in
Home's last row (`rowWord`; tasks-approvals-r1, companion-r2-5). Commands (M12): `copyLike` no longer takes
folder/name for `cp --parents`, or for the target's own BSD `cp` with a source ending in a slash
(commands-remote-c2-1); a download keeps its mark through mv, cp, ln, install, rsync, redirects and tee, and when a
build tool, a test runner, `python -m` or `node -r` picks one up by name (`PipeState.carried`, `downloadsIfFile`,
`PROJECT_FILE`; -c2-2), on this computer, in WSL and in an SSH computer's gate; a negation counts only for the step it
governs, a step on what the words leave out keeps "You didn't ask for this.", and words that keep or leave something
out never announce, a tightening (-r2-1, -r3-x1); and the cards name the folder `rm *` and an unpack work in after a
cd (`folderWords`), say home paths from ~, say a loop's variable in words, and say what `npm prune`, `crontab` with a
file and `git reset --keep` or `--merge` do (-v1, -r2-3, -c2-3, -r1).

**Models, extensions, memory and reliability.** Projects no longer forgets its work on a "signed-out" status, which
with no GitHub sign-in also means the user's own provider is off or waits for its card; Sign out forgets it from its
own handler, and the lockdown still clears it (integrations-c2-1, closing integrations-r1). Check again carries main's
status reason, so it says "can't connect" only for the network (-c2-2); Models & connections points to the waiting
card, not to a GitHub sign-in (-c2-3); `friendlyError` and the marketplace messages read the native client's and git's
network failures as out of reach (-r2-1, -r2, -r2-3); the composer asks whether a local server is running (-r2-2); a
failed project request checks the provider, as a failed turn does (-r2-5); first run says "Using" for a remote host
(-r2-6); and under another service the runtime is "Ember's model connection" (`runtimeWords`, `lostWords`;
integrations-v1). Memory: the secret guard counts a code only for something that locks (all 64 look-alikes the
re-rater and the challenger probed are kept, and no verdict changed across 202 benchmark texts and 172,358 lines of
the repository) and refuses the commonest PIN and device-code phrasings (memory-r6, -1); no request lands on "I agree,
remember", which, like Work without asking's agree button, drops presses for `AGREE_ARM_MS` (memory-r7); a reconnect
parks focus on Memory's heading (-c2-1, -8); `memoryAsk` leaves the conversation's own words and mixed requests to the
conversation, adding `forgetNote` after a forget with more, answers "forget everything", "clear your memory" and a
capitalised name in code, and adds the "won't keep this" note only after a statement (-c1-1, -v1, -r8); a preference
closes only for another value of the same kind (`PREFERENCE_KINDS`, -r1); and an unreadable memory.json makes Home say
"Memory paused" (-r2, partly). Reliability: the handle says "Reconnecting…" (the Ask box "Reconnecting: I can't answer
yet") while the runtime restarts, and "Connection problem" or "Copilot problem" once it can't, never the provider's
(`idleWord`), and the conversation says when Ember gives up (reliability-performance-c2-3); `scripts/perf/footprint.mjs`
measures with the consent Ember asks for and fails past `--max-cpu` or `--max-pss` (rp-4, partly).

**Install and docs.** The npm launcher downloads with node:http and node:https through the proxy npm would use (npm's
https-proxy or proxy from npm_config_* or the .npmrc files, then HTTPS_PROXY or HTTP_PROXY, never for NO_PROXY's hosts
or loopback; https through a CONNECT tunnel), and a network failure is one sentence with what to do next (`cantReach`;
install-docs-r2-1, live through this sandbox's proxy to GitHub and its storage redirect). While it holds a version's
install lock it catches SIGINT, SIGTERM and SIGHUP, removes its work folder and the lock and exits with 128 plus the
signal, and the lock names its owner (pid and host), so a later launcher takes over one whose owner is gone (-c2-1). A
start that hands over to an Ember already running prunes nothing and says so (`startWatched`, `handedOver`; -c2-3,
partly). Updates names the file in every command, as code, takes only a plain-number version and is a polite live
region (`updateHowTo`; -r2-2, -i3), and keeps a known version through a failed or running look (`updateOut`, -c2-2).
The RPM's `--help` names no shortcut (-r2-3), STATUS.md points to these entries (-r2-4), and CLAUDE.md says
`npm run package` makes the RPM and the AppImage (-c1-2). CHANGELOG.md's 0.1.1 audit section says what all three
rounds ship.

**Merges.** Lane D went in as it stood; three of the five merges after it joined both sides. At 4f708ed lane F's
integrations-v1 named the runtime "my model connection" under the user's own provider, and lane H's
reliability-performance-c2-3 said Ember had stopped reconnecting once the runtime kept stopping, but matched only
Copilot's words, so taking both as written would have left "My model connection … I'm reconnecting" up for good under
a provider. `lostWords` now also returns the gave-up line and bubble for the service in use, host.ts's `problemNow`
changes the last reconnecting line, in either service's words, to the matching next line, and `Presenter.gaveUp` takes
the words that were shown, pinned by a new host test. At 7b3501c, where lanes H and I had each made an unanswered card
read "No answer in time: " to screen readers (tasks-approvals-r1, companion-r2-5), the overlay and the handle use lane
H's one `cardStateWord`. At db55151 Home's `renderRecipient` takes lane F's `destinationNow()` and keeps lane G's
update of Apps & privacy's copy of the line; agent-and-policy.md and DEVELOPING.md give both lane H's "helper" state
and lane G's check before a question, which in the code are the worker's one `promptRefusal()`; and
PRODUCT-EXPERIENCE.md's Listen once paragraph has lane G's early-start and screen-reader rules beside lane I's rule
that a question ends the listening. Between the merges, c0dd47c fixed lane I's chord test, on which CI's Windows job
stopped at 7b3501c: it read the bubble's source through a file URL's pathname, which Windows can't open, and now uses
`__dirname`.

**Consent and departures.** No consent version changed (`CONSENT_VERSION` 7; `FEATURE_CONSENT_VERSION` as round one
left it): the fixes that would change agreed words (the provider card, memory's predicate names, auditing each
request's context, a sooner update retry) are left to the owner. No departure from §2: every package's notes say so,
and no change reaches a §2 decision. Two changes only tighten rules that stood: words that keep or leave something out
never announce a command (§2 "Commands"), and the shell's password prompt is checked before a question as well as
before acting, with a desktop child the helper can't hand over counted as unchecked (M8.3, as round one's change to
its §10 entry has it).

**Left.** Partly fixed (9): WSL's move into a folder still reads "Replaces ~/Documents if it exists.", since its inspect
script reports no folder (commands-remote-r1; fixed in the fourth round, below); a failing save still shows "Ember
learned" and "Memory on", and the first
remember after a full disk claims success (memory-r2); a Try again on Home's Problem row, which needs its own route
under the bubble's retry rule (home-7); the npm handover message on a Mac and on Windows (install-docs-c2-3; the Windows
one fixed in the fourth round, below); a sooner
retry of a failed first update check, which would break the once-a-day promise (install-docs-11); X11 authentication
prompt windows (safety-privacy-3); auditing `describe_screen` and each request's quick context, which needs a
`CONSENT_VERSION` bump (safety-privacy-6); awake rest, listening in silence with Home open, at 11.3 % of a core and
758 MB (the listening process 384 MB) against docs/ASSISTANT.md §3's 3 % and 400 MB, since what is still drawn is the
first minute's fidgets and the blinks (rp-4); and phone numbers, fractions and "$5-10" (voice-speaking-2). Skipped (31):
five because another lane did them (accessibility-visual-c1-2, done by lane H's reliability-performance-c2-3 and, for
the rest, by lane F's integrations-v1; accessibility-visual-c2-2 and integrations-r2-4, done as install-docs-r2-2; and
the integrator notes accessibility-visual-i3 and integrations-i3); owner decisions: the route after re-agreeing
(first-run-4, safety-privacy-8), the provider card's wording (first-run-10, integrations-2, -13), probing a remote
provider at each start (integrations-1), browsing marketplaces before the extensions card (integrations-i2), memory's
predicate names (memory-4), which memories shaped an answer (memory-10), npm.yml's tag run without publish credentials
(install-docs-2), Stop speaking on the bubble and which words only hush (voice-speaking-5) and a notice when the voice
changes (voice-speaking-6); larger work in another area's code: an Undo for a forgotten learnt word (memory-7), actions
on Home's crash notice (reliability-performance-r2-2), a Try again on Home's problem entry
(reliability-performance-c1-1), an unknown state for a hung pyatspi import (rp-1) and a microphone chooser
(voice-listening-v2); native hardware: names forgotten as typos behind split DNS or on a Mac (commands-remote-6), the
Ask box's clear margins under Mutter's click-to-focus and on Windows and macOS (companion-4) and a cut-in that waits for
the piece being made (voice-speaking-10); 800×600 at Larger text, where no layout fits both the Ask box and the bubble
(companion-1, -c1-1); trade-offs left as they are: room talk that begins after Listen once's first second, which only a
voiceprint could tell from the user's and the owner decision of 2026-11-05 rules out (voice-listening-c1-1), and an
unaccented short first word of a foreign reply (voice-speaking-11); safety-privacy-1's phrasings, in the memory guard,
where memory-1 went as far as it could without new over-refusal (fixed in the fourth round, below); and folding 0.1.1's
older dated sections into its
feature sections (install-docs-4). Found on the way: a Mac's `ditto` merges into a folder without a question; a download
inside `case … esac` isn't remembered, and PowerShell's and cmd's copy verbs don't carry the mark (the copy verbs
fixed in the fourth round); unpacking a download
marks its whole folder; a card says "Replaces ~ if it exists." for the home folder itself; the overlay's status pill and
Ask's Listen once detail are still hidden until filled; an answer expanded with Read all loses its reply-bound
suggestions, and the Ask box's placement and the overlap probes measure its window, clear 10 px margin included, not its
visible field; a narrowed bubble can end a line on " · " (fixed in the fourth round); the model's task result and an
unanswered question's answer
row still say "stopped", and the away notice for a failed or unanswered task carries only its summary; the setup check's
"Copilot's file watchers" row still names Copilot under a provider, and Home's tagline while a provider card waits (both
fixed in the fourth round); the
add-marketplace sentence quotes the address as Ember checked it (without `.git`), not as typed; first run's Agree
doesn't wait while the recipient is unknown, and the consent copy's "a model service I can't tell yet" is in the first
person; a key that fails to save after an adopted provider edit leaves the new address on but not agreed, the old key
already deleted; a Stop while a request waits for a connection leaves "Thinking…" until the wait ends (fixed in the
fourth round); a spoken forget
or "get to know me" still brings Home to the front with the keyboard; the guard still keeps "HR portal pw …", a login
written with a slash and some Netflix and Wi-Fi phrasings (mostly fixed in the fourth round); a "Prefers long answers"
that replaces About you's length
drops the answer-length predicate (fixed in the fourth round); Voice Match checks Listen once's whole audio, a screen
reader's announcement
included, and Home still announces its voice line as Listen once opens, which leaves the engine more to take off (the
voice line fixed in the fourth round); a
short run of bare lines split by a streamed sentence cut isn't ended, and a bare list waits for its paragraph's end; the
launcher refuses SOCKS proxies, and its prune takes a running 0.1.10 for 0.1.1 (it only keeps more); round two's polish
is still to do (an outline for What Ember did's tags in forced colours, the 8 px gap above "Kitten Nano is selected…");
`footprint.mjs` could run in CI's el8 job with its budget (it does since the fourth round); and several tests flake
under load (platform-win32-backend,
memory-14's timing, desk-live's reapDesks, approval-ui-live, two first-run renderer cases, project-live and the
packaging stand-in smoke test). Round three's own trade-offs: a Listen once request begun within about 0.1 s of the
window opening is taken for talk under way, and one begun in its first second must end within 12 s, while TV talk that
begins in its first second keeps "Listening…" up for 12 s rather than 8 before nothing is sent (voice-listening-r2-1);
and a very short reply to a short request with only two short words of its language is said by Kitten
(voice-speaking-r2-1).

**Native validation and owner decisions.** Still to check natively: WSL's inspect script with a folder column, and
commands-remote-6 with a real ssh client and a Mac; Orca, NVDA, Narrator and VoiceOver on the newly mounted status
lines, the "No answer in time: " and "Ended: " prefixes and Ask's live region, and Listen once with a screen reader
through real speakers and each OS's echo canceller; Windows contrast themes on the corner card; on RHEL 8.4 GNOME 3.32,
the extra shell walk before a question (about 1 s at worst), how often a desktop child that can't be handed over leaves
the check incomplete, the sidecar self-test and the bindings retry on platform-python 3.6, the eval with AT-SPI, gedit
and Firefox, and the new phrase-start cuts by ear; a real Mac without and then with the Accessibility permission, and
Windows with a UIA bridge that can't start; powerMonitor's idle time for the away wait on GNOME, Windows and macOS; the
npm launcher behind a real corporate proxy (one that inspects TLS too), console-close cleanup on Windows and the
handover on Windows and a Mac; and language routing with real foreign system voices, and what Moonshine writes for a
spoken "play la vie en rose". Still to see in a render: the floating task card's longer picture row at Larger text and
in each Glass setting. For the owner, beside round two's list: whether a question should end a Listen once; a listening
earcon (§6), which would also ease Listen once's early-start trade-offs; whether `describe_screen` should still send
every open window's title; how to name the Copilot runtime to someone using their own provider (round three says "my
model connection"); the resting frame rate and the fidgets' pace (`RESTING_FRAME_MS`), and the listening process's cost,
before docs/ASSISTANT.md's target is restated; an upper bound on how long a card waits while the user is away; and
whether first run's Stop rehearsal is optional.

### Product audit fixes, fourth round (2026-11-08)

After round three each area was rated again at 84e1cdc in the same way, by a re-rater and an adversarial challenger
working apart. Their scores out of 10 (re-rater, then challenger) were: memory 8.1 and 7.5; listening 8.5 and 8.0;
reliability and platform 8.3 and 8.0; commands, WSL and SSH 9.0 and 8.0; first run and setup 8.6 and 8.5; the companion
and Ask 9.1 and 8.7; safety and privacy 9.0 and 8.8; models, providers, extensions and projects 9.1 and 8.8; Home 9.0
and 8.9; speaking 9.0 and 8.9; install, docs and developer experience 9.1 and 8.9; tasks and approvals 9.2 and 9.0; and
accessibility and copy 9.3 and 9.1. What they found was partly round three's own doing (a memory-off rule that answered
"Clear all" and "Forget Outlook" in code and opened Settings › Memory instead, a token rule that refused ordinary
developer sentences, an answer still streaming that grew under the Ask box) and partly older gaps the challengers
caught: commands announced "as you asked" when the words only placed, kept or described their object ("kill 5678, 1234
is my editor" for `kill 1234`), Ember's own files reached through a loop's list or a variable only asking where the
guide promises a refusal, and Home's and Listen once's lines, read by a screen reader as a wake or a conversation
opened, heard as the request. What was left made 114 items: no P1, 17 P2 and 95 P3 (five of them integrator notes), and
two with nothing left to do; 30 were regressions round three had brought in, and two earlier findings had regressed with
them (commands-remote-c1-2, and safety-privacy-1 as safety-privacy-c3-1).

The two areas both raters put at 9 or more, tasks and approvals and accessibility and copy, had no package of their own:
the integrator gave the open items that lay in another package's code to that package (accessibility-visual-r3-1 to
install and docs, -r3-2 and -c3-1 to the companion, -c3-2 to Home with tasks-approvals-r3-1 and -r3-5), as it gave
safety-privacy-1's and -c3-1's guard phrasings to memory (memory-i4). The other eleven areas each had a package, worked
one after another in six lanes, each fix with a test seen failing first: J (memory, then safety and privacy), K
(commands, WSL and SSH, then install and docs), L (first run, then models, providers, extensions and projects), M
(listening), N (the companion and Ask, then Home) and O (reliability and platform, then speaking). New this round, an
adversarial regression reviewer then read each package's fix commits, and a repair agent fixed what it found (the
findings numbered -v4-N) before the lane merged. The lanes merged at d12a19d, O first and then N, M, L, J and K: 80
commits. The packages reported 103 items: 60 fixed, 8 partly, 3 not reproduced (fixed already, one by the package before
it in its lane) and 32 skipped. The reviewers found 36 problems in round four's own fixes, 10 P2 and 26 P3, none in
reliability's, and the repairs fixed 35 of them and one partly. UI changes were checked in real renders and live under
Xvfb, and the listening and speaking changes on the real models.

**Regressions.** All of round three's regressions are fixed but one, tasks-approvals-c3-1 (a failed task that only
looked, sending a picture of the window, is retried as one that "stopped part-way"), in an area with no package (fixed
in the fifth round, below). The P2s: while memory is off or paused, a forget is answered in code only when it names what
Ember knows, the user's own details or a person, so "Clear all", "Delete everything", an app, a day, a device, a network
and what an app saved reach the conversation (memory-r3-1, with -c1-1 and -v1); "I won't keep this" follows any fact
stated, a label and its value, "Make a note that…" and a remember with a request after it (memory-r3-2); the token rule
no longer refuses how a token is made, and no guard verdict changed across 357,056 lines of the repository's own text
outside the guard's own examples (memory-c3-1); after "Use GitHub Copilot instead" the provider step counts as in use
only while the settings have the provider on, so a failed check switches it off (first-run-r3-1); an answer still
streaming keeps off the Ask box once it grows into it (companion-c3-1: 22,776 px² of overlap before, 0 in six setups
after); and once python3-pyatspi is installed while Ember runs, the sidecar loads its private links, so its actions
can't hang a GTK app in a modal dialog (reliability-performance-r3-1). The P3s: lock codes kept and an Indian PIN code
refused (safety-privacy-c3-1, memory-r3-3), Open Memory landing on the note (memory-r3-4), WSL and rsync marking a whole
folder downloaded (commands-remote-r3-1, -c3-3), "You didn't ask for this." lost where the words ruled out a step's
force or kind (-c1-2), the Ask field moving 48 px and the key hint's stray " · " and overflow (companion-r3-1, -r3-2,
accessibility-visual-r3-2, -c3-1), first run's "I'm connected to" and a failed edit with no way on (first-run-r3-2,
-c3-1), Home's Models & connections… beside "ask your administrator" and a stalled request overwriting Edit's caution
(home-r3-2, -c3-1), the npm launcher's raw unpacker error on Ctrl+C, its "Then" with no step, its hedged Windows
handover and a full disk blamed on the download (install-docs-r3-1, -r3-2, -r3-3, -c3-1), Updates' how-to re-announced
at every push (-c3-2, accessibility-visual-r3-1), the gave-up bubble after Check again (reliability-performance-r3-2),
and an arrow said twice, a French reply quoting English read by Kitten and a subtraction said as a range
(voice-speaking-r3-1, -r3-2, -c3-1).

**Memory and safety (lane J).** `memoryAsk` takes a forget while memory isn't in force only with words for what Ember
knows ("…you know", "my memory", "…you've saved about me"), the user's own details to the end of the request
(`ABOUT_ME`, a possessive only before another such word) or a name as names are written, never an app, a day, a folder,
a device or a network; after delete, clear, erase, wipe or remove, what was saved, kept or stored counts only with "you"
and where the request ends at "about me" or "about us" (memory-r3-1, -c1-1, -v1, -v4-1, -v4-2). `statesSomething` takes
any verb after what the fact is about, a label and its value, "Make a note that…" and plural subjects (`manySay`), and
`remembersWithMore` a remember with a request after it (memory-r3-2, -v4-4). The forget note's Open Memory opens at the
list (`memoryNoteActions`; -r3-4), and a changed preference takes the profile predicate of the one it closes, so a new
answer length goes with every request (-r1). The guard (guard.ts) counts a house, a home or an office as a place that
locks only after a determiner or a possessive (`OWN_PLACE`), a vault, safe, door, locker or key box after any word, and
a six-digit PIN code as a postcode only after a place word, a road or an Indian city or state; it refuses the password
shorthands and a login or credentials said as one value with a digit or a symbol (`TOLD_LOGIN`), keeps a user at an IPv4
address or localhost, a handle and a host with its port, and refuses a user name with a digit said as a login, failing
closed (memory-i4, -c3-1, -r3-3, -v4-3, -v4-5, -v4-6, safety-privacy-1, -i4, -v4-1). All 17 phrasings of
safety-privacy-1's probe and all 10 of -c3-1's are refused, and the guard's worst case on 200 KB of text is about 12 ms.
Safety (M8.3): fill_cells' one batch question (`authorizeCells`) checks for GNOME Shell's prompt first, as a single
step's question has since round three, and while an X11 authentication window has the keyboard a borrow or a batch that
would ask is refused before the question (`keyboardTaken`, which reads only the active window). A Work without asking
step's decision and announcement, a batch's included, are held (`Worker.ahead`), with no shell walk of their own, and
written and said only once the check right before acting has passed (`goAhead`), so a step a prompt stops is recorded
only as refused, with one shell walk per check (safety-privacy-3, partly; -v4-2, -v4-3, -v4-4).

**Commands and install (lane K).** Commands (M12): the intent matcher reads each of its rows against only the words its
verb acts on (`actedOn`): the clause that asks for it and those that only list more objects, without what something is
said of ("1234 is my editor", "main and develop stay"); a word after "in", "the one in", "from" or a possessive names
the folder the path must be in; parts that say the same verb again are read together and a colon continues a list, never
across verbs; and the bare-`gh pr merge` guard reads all the words (commands-remote-c3-1, -r3-x1, -v4-2, -v4-3, -v4-6).
The classifier keeps every value a POSIX variable is given (a loop's list, an assignment, `export`, `set --`, `printf
-v`, a here-string or here-document given to `read`) only to refuse Ember's own paths, and refuses a pattern it sees
only the start of when that could match Ember's folder (-c3-2, -v4-4). PowerShell's and cmd's copy, move, rename and
link verbs, PowerShell pipelines, xargs and rsync carry a download's mark as cp does, rsync with -R, --relative,
--files-from or /./ asks whenever the folder is there, and WSL's inspect script reports a folder column, so a download
copied into a folder marks only its file there (-c2-2, -c3-3, -r3-1, -r1, -v4-1, -v4-5). Cards say "You didn't ask for
this." where the words rule out a step's force or kind (`ruledOut`), name a short loop list, give crontab with a file
and npm prune their kinds and yarn autoclean --force its own line, never announced (-c1-2, -c2-3, -r3-2, -r1). Every
change to commands only tightens a decision or corrects a card's words. Install and docs: the npm launcher sends any
answer but 2xx and 407 through `cantReach` with the host that answered; inside an https tunnel the answer is that
host's, with "again later" for a 5xx, and the step to ask for the host to be allowed is kept for 403, 451, plain-http
forwards and a refused CONNECT (install-docs-r2-1, -v4-3). A full disk or quota anywhere in the install, the unpacker's
own words for it included, is `noRoom()`'s one sentence (-c3-1, -v4-1); unpacking and a Mac's xattr run asynchronously
on the install's stop signal, so Ctrl+C or a kill keeps and starts nothing (-r3-1, -v4-2); "Then" follows only a step
and a stopped reinstall says the copy it had is kept (-r3-2); and on Windows a handover says only that Ember took the
request unless another cached version could be running (`afterHandover`, -r3-3). Home's Updates lines are written only
when their words change (-c3-2, accessibility-visual-r3-1).

**First run and models (lane L).** A first-run provider visit is in use only while the settings have the provider on,
main's provider state is read again when it is switched on or off or agreed for another host, and whether a failed
check, an edit or Back switches it off follows the path the check took (`checkSaves`; first-run-r3-1). "Use GitHub
Copilot instead" draws Copilot's sign-in from the moment the press moves the focus (-c3-2), a failed edit of the
provider in use offers "Keep using <host>" in first run's one voice (-c3-1), and the lead says "I'm using" a provider
elsewhere (-r3-2). A switch of model service put off while a turn or a task is under way is made as soon as they are
done (`AgentHost.switchWhenQuiet`), not at the next request, with `AgentStatus.switchPending` meanwhile, which first run
shows (first-run-v4-1). Home holds an address edit of the provider in force that names another host until that host's
note is agreed and it answers, checking the draft with its one model-list GET and then saving the details and the yes in
one settings change (`PROVIDER_IPC.agree`, zod-checked), with the in-use card's words, and a switch-off meanwhile saves
only the switch (integrations-c3-1, -v4-1). While the note waits with no GitHub sign-in, the Ask box, voice, the hello,
Home's tagline, its status button and the hint name the note (`providerWaiting`; -r3-1, -v4-3). Projects' Export, Apply
patch and Remove pass a local gate that needs no connection (`projectMay("local")`), and Apply's confirmation is a job
that reconnect tries don't cancel (`projectJobStops`; -r3-2, -v4-2, -v4-4); and the setup check's file-watcher row names
Ember's model connection under another service (-r3-3).

**Listening (lane M).** M5: a wake's window whose request opens a conversation ends with `next: "conversation"`, and
VoiceService goes straight on into it; Listen once's line in Home and Ask is the button's description, with its own
screen-reader status line that never says "Ember is already listening." (`ListenOnceStatus.reason` "listening", which
`heldByQuestion` also gives "Answer Ember's question first." while a conversation waits for a spoken answer); Home's
voice line is said only once it has held for 1 s (`VOICE_LINE_SETTLE_MS`) and never while a window is open; and both are
emptied without an announcement when they have nothing new, remembering what they last said (voice-listening-c3-1,
-c2-1, -v4-1, -v4-2, partly). On the real models, the re-rater's "Listening for Ember. Listening for one request.
Listening." before a request now sends exactly the request in 12 of 12, where all 12 had sent the announcement, 2 of
them with no request. With wake listening off a Listen once goes starting, active, off, never through "Listening for
“Ember”" (-r3-1); follow-up and conversation windows say "Listening…" (-r3-2); and a window the 12 s doubt ends says "I
heard talking but couldn't tell it was a request…", in Settings without starting with the name (-r2-1 and -1, partly;
-v4-3).

**The companion and Home (lane N).** A growing answer (`askGrows`) keeps off the Ask box once it grows into it, placed
again in the same frame (`askGrownInto`; companion-c3-1); the suggestions row holds the height it opened with until the
next opening, measured again only when the box's width changes, and chips that would need more rows wait (-r3-1, -v4-1);
and the bubble's key hint (M1.5) is a wrapping list whose " · " is drawn, in clipped room, only before a chord that
follows another, so no line ends or starts with it and a screen reader reads no dot first (-r3-2, -i4,
accessibility-visual-r3-2, -c3-1, companion-v4-2, -v4-3). Home: an Ask-box or spoken wait takes the line under Send only
when it is empty or says how an earlier message went (`composerLineYields`; home-c3-1); the Problem row offers Models &
connections… only where its line sends the person to Ember's settings, the give-up line included (`problemInHome`;
home-r3-2, accessibility-visual-c3-2); every Stop settles a signal the connect wait and the silent-turn wait race
against, so Home is told idle at once (home-r3-1, M8.9), and Home gives back every composer message main took whose own
line never came, oldest first and above a draft (`composerGivenBack`; -v4-1, -v4-2); the line under Send's writes go
through `keepingComposer` (-c3-2); Today counts an unanswered task as "no answer in time" (tasks-approvals-r3-1); and a
task row offers Try again only while main says it can be pressed (`offersRetry`; -r3-5).

**Reliability and speaking (lane O).** `load_atspi_again()` loads the sidecar's links as soon as pyatspi loads, inside
WSL too (reliability-performance-r3-1; its platform-python 3.6 run is CI's el8 job); the host keeps the gave-up words it
showed (`gaveUpShown`), so Check again turns the bubble into "Connected again" and Home's line into "…I'm connected
again: send it again.", and the give-up line gets its Models & connections… button (-r3-2); and a Windows UIA bridge
that stops before it is ready twice in a row is one of `helperCantRun`'s answers, pointing to the setup check (-i3). For
rp-4, partly, the rig counts the eyes as still under a tenth of a pixel of travel left (`LOOK_STILL`): the handle drew
13.6 times a second live, not 14.7, with no CPU gain claimed; and CI's el8 job now runs `scripts/perf/footprint.mjs`
with the recorded budget of 16 % of a core and 950 MB. Speaking: `arrowSaid` says an arrow by its direction before
"arrow", in a list or as a key, "to" between words, and a line-start arrow as a bullet (voice-speaking-r3-1, -2, -v4-2);
a spaced hyphen between amounts is left as written, with "minus" before "=" (-c3-1); `AnswerLanguage.followsRequest`
weighs only a short reply's words outside quotes, and a reply that quotes something follows the request only where those
have more of its language's short words than English's (-r3-2, -v4-1); and `SpeechStream` tells `spokenText` when the
line it has said ends with a colon (`ledIn`) and where that line starts (`lineStart`), so led steps and labelled lines
end as list items however they stream (-3, -c3-2, -v4-3, -v4-4). The first-clause cut now applies to the first line
only, which starts 2 of 23 realistic answers about 40 characters later.

**Caught before merging.** Every reviewer but reliability's found problems in its package's fixes, and the repairs fixed
them before the lanes merged. Memory's new forget patterns took "Clear everything saved about me in Firefox", "Forget
all about my last request" and "Forget my wife's AirPods" for memory requests, "Remember my kids love pizza" still got
no note, the office rule refused "Branch office code: 4410" and "Our in-house code is 15000 lines", a six-digit PIN
after any comma was kept as a postcode ("Garage, PIN code: 482193"), and "GPIO4 is the data pin" was refused
(memory-v4-1 to -v4-6). Safety's login pattern refused SSH logins, handles and localhost addresses, its check before an
announcement looked through GNOME Shell twice as often, an X11 prompt window still got "without asking" lines, and its
test called a private method in a state the tool can't reach (safety-privacy-v4-1 to -v4-4). Commands' rsync -R,
--relative and --files-from overwrote in silence and carried a download's mark to the wrong file, so a download ran with
no question, a bare `gh pr merge` was announced when the words numbered another pull request, compound kept subjects and
places after a comma still announced, Ember's folder through a pattern after a variable, `set --`, `printf -v` or a
here-string only asked, PowerShell's piped copies of a download ran unasked, and requests that said their verb again
stopped announcing (commands-remote-v4-1 to -v4-6, the first five P2). The launcher still printed Node's raw ENOSPC for
a disk already full, lost a stop while it cleared a Mac's quarantine, and blamed the proxy for the release host's 5xx
inside a tunnel (install-docs-v4-1 to -v4-3). "Use GitHub Copilot instead" while Ember was busy left the sign-in step on
"Connecting to Copilot…" for good (first-run-v4-1, P2). Turning the switch off during Home's held edit saved the address
never agreed to and deleted the key in use, Apply patch's confirmation closed at each reconnect try, the hello at start
still named Copilot, and Remove dropped the focus (integrations-v4-1 to -v4-4). Listen once's line still spoke "Answer
Ember's question first." into an open conversation, the screen-reader lines kept stale text, and the doubt line said "I"
in Settings (voice-listening-v4-1 to -v4-3). The Ask field still moved 48 px when chips wrapped to two rows, the live
key-hint check measured the step text's own edge, and a dot was read before the first key (companion-v4-1 to -v4-3). A
message Ember had answered itself came back in Home's composer, and a dropped message was lost with anything in the
composer or a second message sent (home-v4-1, -v4-2). English replies quoting English went to a French or Spanish voice,
or weren't said, and arrows lost their "to" after a direction, at a streamed piece's start and before "To Do", and a
streamed labelled step with a comma took the next label (voice-speaking-v4-1 to -v4-4).

**Merges.** Lanes O and M merged cleanly. At e0e620f `problemInHome` took lane N's rule (only a line that sends the
person to Ember's settings offers the way there), which already offers it on lane O's gave-up line, `LOST_GAVE_UP`'s
Check again (reliability-performance-r3-2), and ui-copy.test.ts kept both lanes' tests. At 8fae333 only
ui-copy.test.ts's imports conflicted; lane L's new `providerWaitingWhy` says "in settings", so lane N's `problemInHome`
names Models & connections in it and offers the way there. At 016e4e4 agent-and-policy.md's password-prompt rule kept
lane J's fill_cells, `keyboardTaken` and `goAhead` sentences beside lane O's Windows bridge among `helperCantRun`'s
answers, and at d12a19d design-system.md's live-region rule kept lane K's "written only when its words change" beside
lane M's rule that nothing is announced while the microphone is open for a request.

**Consent and departures.** No consent version changed (`CONSENT_VERSION` 7, `FEATURE_CONSENT_VERSION` as round one left
it): no package bumped one, and the held provider edit's card in Home uses first run's existing in-use text
(integrations-v4-1). No departure from §2: every package's notes say so, and no change reaches a §2 decision. Several
changes only tighten rules that stood: a command whose object the words only keep, place or describe asks instead of
being announced (§2 "Commands"), Ember's own files reached through variables and patterns are refused, and the
password-prompt check (M8.3) now also comes before a batch of cells' question, before a step Work without asking would
announce and, while an authentication window has the keyboard, before a borrow's question.

**Left.** Partly fixed (9): an X11 authentication prompt such as pinentry still stops only the steps that borrow the
mouse and keyboard, not every read and step as GNOME Shell's prompt does, which is the owner's call (safety-privacy-3);
the guard still keeps "Netflix: hunter2" and "The Wi-Fi is BlueSky99" (memory-1); on a Mac a handover to an Ember
already running still says "started", since open(1) ends at once (install-docs-c2-3); awake rest here is about 7 % of a
core and 420–600 MB with listening off, and 12.3 % and 841 MB with listening and Home open, against docs/ASSISTANT.md's
3 % and 400 MB (rp-4); a Listen once request begun in its first second and still being said at 12 s isn't sent
(voice-listening-r2-1, -1); a press that finds Ember already listening isn't announced, so that the window it opened
doesn't hear it (voice-listening-v4-2); phone numbers, fractions, "$5-10", a "$5 - $10" range said as written, and
en-dash runs such as "0800–123–456" said with "to" (voice-speaking-2; the last three fixed in the fifth round, below);
and how far Kitten may say short foreign replies (voice-speaking-11). Skipped (32): owner decisions: memory's predicate
names (memory-4) and which memories shaped an answer (memory-10), auditing each request's context (safety-privacy-6),
the route after re-agreeing (safety-privacy-8, first-run-4, M8.8), the provider card's wording (first-run-10,
integrations-2, -13), probing a remote provider at each start (integrations-1), browsing marketplaces before the
extensions card (integrations-i2), npm.yml's tag run without publish credentials, the prerelease title and a sooner
update retry (install-docs-2, -4, -11), Stop speaking on the bubble and a notice when the voice changes
(voice-speaking-5, -6), and room talk that begins after Listen once's first second, which only a voiceprint could tell
from the user's (voice-listening-c1-1, ruled out by the owner decision of 2026-11-05); larger work: memory's unsaved
state (memory-r2), an Undo for a forgotten learnt word (memory-7), Try again on Home's Problem row, which needs its own
IPC route under the presenter's retry rule (home-7, reliability-performance-c1-1, whose composer line "Ember couldn't
finish this reply…" where no reply began is left too; that line fixed in the fifth round, below), actions on Home's
crash notice (reliability-performance-r2-2), an unknown state for a hung pyatspi import (rp-1) and a microphone chooser
(voice-listening-v2); native hardware: whether a spoken memory request takes focus from the app in use (memory-r7),
names forgotten as typos behind split DNS or on a Mac (commands-remote-6), the Ask box's clear margins (companion-4) and
a cut-in that waits for the piece being made (voice-speaking-10); design: 800×600 at Larger text (companion-1, -c1-1)
and, at 1366×768 Larger, an answer that comes or grows while the box is open going to the side strip (companion-c2-4);
and integrations-r2-3's quoted address, left on purpose, and the integrator note integrations-i3. The other half of
install-docs-4, folding 0.1.1's older dated sections into its feature sections, is still to do in CHANGELOG.md. Not
worked, in the two areas with no package: tasks-approvals-c3-1 (above), "What did I miss?" opening with "One task
finished." for a task that didn't finish (-r3-2), a queued task stopped before it began reading "Took 3s" (-r3-3), a
step a password prompt or a helper that isn't working refused reading "Stopped: Tried to open an app" (-r3-4), an
unanswered question's row and the model's task result still saying "stopped" (the rest of -r1), and Home's status panel
saying "Not connected" with Check my provider… after the runtime crashes under the user's own provider
(accessibility-visual-c1-2), all fixed in the fifth round, below. Found on the way: memory-off "Forget everything I told
you", "Forget what I told you about Priya" and nouns outside `ABOUT_ME` ("Forget my car") reach the conversation with no
note, "Don't forget the car keys in the drawer" gets a spurious one (none since the fifth round), "Remember my office
code is 4410" is refused on purpose, beside round three's pinned "my office code is 4821", and "the token for the model
is …" before a model's name is refused; fill_cells on Ember's desk is refused while the prompt is open or unchecked,
though desk input that doesn't ask isn't checked, "deploy@build-01" is refused because its shape can't be told from a
password's, and a batch refused for one cell's formula records the other cells' allows first; PowerShell's `foreach` and
cmd's `for` don't feed Ember's own refusal, a download through `dd` (followed since the fifth round), `git mv`, a copied
folder that holds one, a glob source or `case … esac` isn't followed, "in dist delete the build folder" still announces
`rm -rf build` (it asks since the fifth round), an unseen name under the folder that holds Ember's is refused rather
than asked, `cp --parents ember/settings.json ~/.config/` asks rather than refuses, "nginx is stuck, restart it" asks
(it is announced since the fifth round), and a `while read` card says "Ember can't tell exactly what this does." three
times; the launcher's raw words for a corrupt zip and a redirect loop, and a stop dropped during its last renames; first
run's no-keyring sentence said twice, an adopt of new details that isn't atomic (a key that fails to save leaves the
provider unagreed), Agree not held while the recipient is unknown, a quit during a save-first check, the key placeholder
set once per visit (all but the hold and the quit fixed in the fifth round, below), and Home's status line and Models &
connections not showing `switchPending`; a held edit to a host with no model list can't be adopted without the switch
off and on, Home's composer line while the note waits is still generic (both fixed in the fifth round, below),
`friendlyError` says "your model service" for the provider, first run's in-use edit still saves in two steps (fixed in
the fifth round), and the switch's hint doesn't say that turning it off during a held edit drops the new address; the
bubble's "Ember says…" and Home's task lines can still be read into an open conversation, Listen once's ready line
quotes "Hey Ember" (Home's task lines and the ready line fixed in the fifth round, below), and its line flickers for
about 70 ms after a heard request; a streaming answer that moved clear of the box stays moved after the box closes, and
one chip sits centred in a held two-row capsule; the bubble's `settingsHelps` still offers Open settings on the
administrator's line, Home matches a sent message to its line by its words, and a Stop within milliseconds of Send gives
nothing back, nor does one for a message that starts waiting for a reconnect just as an earlier Ask-box turn ends; the
new footprint step hasn't run in CI yet (its PSS headroom is about 13 %), and CI on 5edcf08 failed el8's smoke and
staging on a GitHub 504; a "•" bullet, arrow-bullet lines that aren't cut as they stream, "right arrow" at the end of a
piece cut just after an arrow (fixed in the fifth round), and a French–Spanish tie decided by `STOPWORDS`' order; and
tests that flake under load (npm-launcher's install-docs-2 once, first run's renderer journeys (r), (t), (y) and (q3) at
vitest's 5 s default (the first three given 20 s in the fifth round), home-r1's precondition).

**Native validation and owner decisions.** Still to check natively: on RHEL 8.4 GNOME 3.32, the cost of the GNOME Shell
walk now also run before each announced step and each batch question, how often it answers unchecked, the late-install
GTK hang and the sidecar on platform-python 3.6; WSL's inspect script's folder column in a real distro, the Windows copy
verbs on a real PC, and commands-remote-6 with an sshd, a VPN and a Mac; Ctrl+C while tar.exe or ditto unpacks, the
Ember.exe handover's words, a Mac's open(1), the no-room words on real full volumes, and corporate proxies; a Windows
UIA bridge that stops twice before it is ready; Orca, NVDA and VoiceOver on a brief role=status change, live regions in
background windows, the key hint's CSS-drawn " · ", "Sign in to GitHub" as focus lands and "Keep using <host>"; Mutter's
click-to-focus and the Ask box's clear margins on Windows and macOS; real speakers and echo cancellation; what real
models say to the memory-off forget wordings still unmatched, whether a spoken memory request takes focus on each OS,
and Better recall on an RHEL 8 VM; Kitten's prosody on "minus", direction-only arrows and short lead-in pieces, and real
foreign voices; and CI's first runs of the footprint step and of the eval's autonomy tasks with the held announcement.
For the owner, beside the lists above: whether a bare "Forget everything" should keep opening Settings › Memory, which
way an ambiguous six-digit "The PIN code is …" with no address falls (refused now), and whether memory should have a
local owner under a provider; whether the password-prompt check should cover Ember's desk throughout or leave it out,
and whether `describe_screen` should still send every open window's title; whether Home's conversation should show a
line for a request a Stop ended before anything came; literal for-lists, the venv activate read-through and keep words
blocking announcements, and whether an unseen name under Ember's parent folder should ask; whether a held edit to a host
with no model list may be adopted (Home's is, since the fifth round, below); `RESTING_FRAME_MS`, the fidgets' pace and
whether still faces stop drawing, before docs/ASSISTANT.md's target is restated; a least-overlap Ask box placement,
whether a moved streaming answer moves back, and whether chips that come late may grow the box; and a listening earcon
(§6).

### Product audit fixes, fifth round (2026-11-08)

After round four each area was rated again at 7139e64 in the same way, by a re-rater and an adversarial challenger
working apart. Their scores out of 10 (re-rater, then challenger) were: commands, WSL and SSH 7.7 and 6.6; listening 8.3
and 8.0; memory 8.4 and 8.1; reliability and platform 8.6 and 8.3; the companion and Ask 8.8 and 8.7; models, providers,
extensions and projects 8.9 and 8.7; safety and privacy 9.0 and 8.9; first run and setup 9.0 and 9.0; Home 9.1 and 9.0;
tasks and approvals 9.1 and 9.0; install, docs and developer experience 9.2 and 9.0; speaking 9.2 and 9.0; and
accessibility and copy 9.3 and 9.2. Commands fell: the re-rater found that `rsync --mkpath` hid both its paths, so it
overwrote any file with no question, Ember's settings included, and the challenger that `xargs -l` ran any command
unasked and that `docker` or `podman run -P` swallowed the next option, so `--privileged`, `-v /:/host` or Ember's
folder mounted into a container ran with no question (three P1s, all from option tables that listed a switch as taking a
value), and that a dangerous step the words made conditional or put off ("delete src/ only after I confirm", "tomorrow")
was announced "as you asked" (P2). The other findings were partly round four's own doing and partly older gaps: the
guard's login rule refused code that loads credentials and its older key-value check any file naming a token or a
password, which is what Projects meets (memory-r4-1, -r4-2, P2); memory's words answered "Remove this tab from memory"
in code (memory-c4-1); a screen reader said Hear me more clearly's line, Task activity and Ask's "Ember will see:
<window>" into an open microphone, and Voice Match teaching with a screen reader learnt the screen reader's voice
(voice-listening-c4-1, -r4-2, -i5, -r4-1, P2); a finished answer's last growth still landed under the Ask box
(companion-c3-1, P2); the waiting switch of model service closed finished task cards; and a typed "stop" stayed in
Home's composer as a draft. What was left made 141 items: 4 P1, 18 P2 and 109 P3 (eleven of them integrator notes, one a
P1 and four P2s), and ten with nothing left to do; 25 were regressions round four had brought in, and one earlier
finding had regressed with them (memory-r8).

Every area had a package this round, commands two: the classifier's parsing, Ember's own paths and downloads first
(commands-remote-i5a), then how the user's words are matched to a command (-i5b). The integrator gave items reported in
two areas to the package whose code they shared: memory's guard took Projects' over-refusals and the guard phrasings
reported under safety and privacy (memory-i5); integrations took the model-service switch's regressions in tasks, first
run and Home (integrations-i5); listening took the Ask box's screen reader line while the microphone is open
(voice-listening-i5); the companion took Ask's late follow-up chips reported under accessibility (companion-i5); and
safety took the held Work without asking decision reported under both its area and tasks (safety-privacy-i5). The 14
packages were worked one after another in six lanes: P (commands, both packages), Q (memory, then integrations), R
(safety and privacy, then tasks and approvals), S (listening, then speaking), T (the companion, accessibility, then
Home) and U (reliability and platform, install and docs, then first run). Each fix came with a test seen failing first;
an adversarial regression reviewer then read each package's fix commits and a repair agent fixed what it found (the
findings numbered -v5-N), and, new this round, a second reviewer read the repair agent's commits and a second repair
agent fixed what it found (-w5-N). The lanes merged at 73554c2, Q first and then R, P, S, T and U: 117 commits. The
packages reported 144 items, routing notes and five items carried from round four's first-run notes included: 85 fixed,
12 partly and 47 skipped, of which companion-r4-1 and safety-privacy-c4-2 and -c4-3 were fixed in the packages that
owned them and four were notes with nothing to do. The first reviewers found 40 problems in round five's fixes, all but
accessibility's finding some, and the second reviewers 36 in the repairs, none in tasks and approvals' or the
companion's; the repairs fixed all 76. UI changes were checked in real renders and live under Xvfb against the mock
model, and the listening and speaking changes on the real models.

**Regressions.** All 25 of round four's regressions are fixed, one of them partly, each as told under its lane below.
The P2 was memory's: its login rule refused `credentials = boto3.Session().get_credentials()` and `const creds =
loadCreds(argv[2]);` (memory-r4-1). The P3s: a copy Ember can't name marked its whole destination, a variable set to
Ember's folder was refused where it was only tested or printed, and plain chains such as "stop apache, then nginx"
stopped announcing (commands-remote-r4-3, -r4-5, -r4-4); memory's words took a browser tab's or a photo app's memories
for memory requests, its admin pair refused a disk's use, months were taken as names and versions and settings said as
logins were refused (memory-c4-1 to -c4-3, safety-privacy-c4-3); a held Work without asking decision was written as
"Without asking" after a refused step (safety-privacy-r4-1, tasks-approvals-r4-1); the waiting switch of model service
closed finished task cards, and first run offered the user's own provider with no button while it waited and turned the
focused Continue into Sign in with GitHub unannounced (tasks-approvals-r4-2, first-run-r4-1, -c4-1); Home's held edit
couldn't adopt a host that lists no models (integrations-r4-2); first run's own voice came only after a failed edit
(first-run-r4-2); a typed "stop" was kept as a draft and given-back messages over the limit together weren't said to be
(home-r4-2, -c4-2); Settings' doubt line woke Ember (voice-listening-r4-3); answers opening with a line break or a short
line, and labelled steps, started speaking late, and a short Spanish or French reply quoting a file went to the English
voice (voice-speaking-r4-1, -c4-1, -c4-2); the Today count's words didn't read as a clause, and follow-ups that came
into an open Ask box couldn't be reached (accessibility-visual-r4-1; -c4-1, partly); and the launcher's tunnelled 502
and 504 didn't name the proxy and CLAUDE.md's gate missed two of CI's checks (install-docs-r4-1, -r4-3). Round three's
last regression, tasks-approvals-c3-1, and the regressed memory-r8 are fixed too.

**Commands (lane P, M12).** The classifier: every option table in commands/classify.ts and tables.ts was checked against
its tool's manual, and `parseOpts` gained attached-only values (`shortOptional`, `longOptional`: xargs' `-l`, cp's
`--backup` and `--update`) and number-only ones (`shortNumeric`: make's `-j`); docker and podman run list every value
option, and cp, mv or install with no destination and a container run with no image ask. A probe of 832
switch-before-operand pairs went from 141 that ran, lost a rule or lost a refusal to none, pinned by a table-driven test
(commands-remote-r4-1, -r4-2, -c4-1 to -c4-3, -i5a). A value that names a file is judged where its row consumes it
(`optionFiles`: a read, a write, a folder written into or the folder the command runs in; -v5-1, -v5-3, -v5-5). On
Windows PowerShell variables are followed for Ember's own refusal (-c3-2), and robocopy and dd carry a download's mark,
robocopy under each file's own name (-c2-2, -v5-6). A variable set to Ember's folder is judged where a command uses it:
testing or printing it runs, and a wrapper's option (its value apart or attached), a here-string or here-document,
mapfile, xargs, the program word or an export hands it on and is refused, saying "would change" or "would read" by what
the command does (-r4-5, -v5-2, -w5-4 to -w5-6; -v4-4 partly). Only `${d:?}` stands for the exact value: a cut or a
default is its values plus a part Ember can't see, and `${HOME:?}` and `${PWD:?}` are the scope's folders (-w5-1,
-w5-3). Text filters on an allow-list run when they only read such a variable and nothing takes their output (-w5-4). A
copy Ember can't name marks a file of unknown name in its folder, never the folder (`UNNAMED_COPY`; -r4-3, -v4-5).
make's `-j` counts only a processor-count substitution, an arithmetic expansion or a variable, and the values the text
gives that variable are judged as targets (`Classifier.knownForms`; -v5-4, -w5-2). The words
(app/main/commands/intent.ts, §2 "Commands"): only the 4-second announcement changed, and only towards asking. A step
the words hold back is never announced: a condition, a later time, asking to be asked or shown first, or a how-to before
it, read per row so another step's time or condition doesn't count (`LATER_TOO`, `HELD_FIRST`, `ownSteps`; -c4-4). An
announcement needs a thing in the verb's own phrase, never one after "of", "for", "into" or "by", in a relative clause
or a participle's phrase, or in a reason; "of", "for" and "at" after a folder word place the path as "in" does; and "it"
stands for the hung thing only as the verb's direct object (`objectEnd`, `placeWord`, `referBack`; -c3-1, -r3-x1). Plain
chains announce again (-r4-4); "You didn't ask for this." follows a "not" said with the verb, and "… and nothing else"
rules out a step unless every object and widening flag is named (-c1-2, -r4-6); and announcements say home paths from ~,
as cards do (-r4-7). Of the words package's reviewer's 140 hold-back phrasings, two still announce ("before Friday",
"before the release").

**Memory and integrations (lane Q).** The secret guard (guard.ts) passes over a secret-named key whose ":" or "=" is
followed by code (`withoutCodeKeys()`: a type, a call, a member, a reference, a placeholder, a count and the like),
judged by the code around it (a bracket opened above it, a list's last item, a Python block's body, a format string's
placeholder), and only its name, so a token in the value is still found; quoted, bare, digit or symbol values, a PIN's
number, literal and getenv defaults and prose that only looks like code are still refused (memory-r4-1, -r4-2, -i5).
Measured on the guard alone, refused node_modules files went from 295 to 50 of 2,756 and Ember's own sources from 170 to
86, with no refuse→keep across 271 secret phrasings; after both repairs, 20 files across scans of 14,752 and 40,000 were
sent again, none newly refused, at an unchanged cost per key. The login and admin rules keep a version, an issue, a
setting, a user at a computer given with its port or both named in words ("jsmith@corp"; "admin@nas1" is still refused),
a disk's use and a formula (safety-privacy-c4-3, memory-c4-2, -v5-4), and the guard refuses Wi-Fi passwords under their
router and Windows names, unlisted places' lock codes, a capitalised seed phrase and a security answer
(safety-privacy-c4-2, memory-1, partly). Projects' file check, patch check, follow-up context and task views share it
(task views with each line's lines before it, `withLinesBefore`). `memoryAsk` and the remember note cover explicit
requests that name memory, a fact with "remember that" after it and lead-ins before "remember" (memory-r3-2), never a
thing only described (-r8), "from memory" without "your", "Ember's" or "my", or a photo app's memories (-c4-1); April,
May, June and August are names only before a detail, a surname or "everything about" (-c4-3). Integrations: Projects
names every chosen file that looks like it holds a secret, with its line (`secretLine`, `projectSecretFiles`), and says
when the guard, not the diff, withholds a patch or keeps an answer from the next send (`readProjectPatch`'s `withheld`,
`projectAnswerText`; integrations-r4-1, -c4-1). The waiting switch's reconnect hands finished cards to the next
TaskManager (`keptCards`), keeps them closable while it connects and drops them if the connect fails, there is no
sign-in or the account changes; Try again waits for the switch (`retryWaits`), on another service starts from the user's
own words only (`handedElsewhere`), and only for a task its turn asked for alone (`StartOptions.alone`, otherwise Close
and `ASK_AGAIN_ELSEWHERE`; tasks-approvals-r4-2, -c4-1). First run keeps "Use my own provider" while the switch waits,
says "I've switched to Copilot…" and moves the focus to the title when Continue becomes the sign-in, and adopts an
in-use edit with `agree(host, move)` in one change (first-run-r4-1, -c4-1, -r4-3). A new `held` ConversationTurn has
Home's composer and status say the message waits for the switch (`COMPOSER_HELD`, "Switching model service…";
home-r4-4). Home's held edit adopts a host whose GET /models answers 404, 405 or 501 (`cause: "no-list"`), saying it
asks for the model as typed (integrations-r4-2), and the composer names the host the note waits for (-r4-3).

**Safety and tasks (lane R).** The worker drops a held Work without asking decision at the start of every tool call
(`runTool`), so a step that a password prompt, a pinentry with the keyboard, the borrow's dialog check or a desk
take-over refused is never written into What Ember did as "Without asking" by the next call's entry
(safety-privacy-r4-1, tasks-approvals-r4-1; the rest of safety-privacy-3 stays the owner's). Apps & privacy's copy of
"Before Ember starts" follows the settings and the policy in force: its approval line says when Work without asking is
on and when apps were let in without asking, counted only where their keys aren't managed, and its other computers and
commands line (`targetsFoldRest`) says what is on, what is off and what the organisation turned off
(safety-privacy-r4-2, -c4-1, -v5-1). While Ember holds itself locked down after a policy change (`heldUntilRestart`),
main's policy watch sends an open settings window what is in force (`IPC.adminChanged`, built by `homeAdmin()` as every
status read's is), and Home redraws the notice, the fold, the switches the policy manages, first run, Computers and
Commands, and Extensions, with screenshots and Work without asking shown off; a status read already on its way can't
bring the old policy back (-w5-1, -w5-2). First run's text and `CONSENT_VERSION` are unchanged. Tasks: a task that only
looked, picture included, retries clean (`LOOKS_ONLY`; tasks-approvals-c3-1); "What did I miss?" opens with how many
tasks ended (-r3-2); a task stopped while in line has no clock (`TaskEntry.unstarted`; -r3-3); prompt, helper and
keyboard refusals send a refused activity in Ember's own words (-r3-4), kept in order (a step refused once its question
was answered goes after the answer), folded by reason (`refusedWords`: "Not allowed 6 times: …", which Home's row opens
to list) and, for the borrow's window-system refusal, cut to its cause (`causeOf`) so the card's 120-character cut never
breaks it (-v5-1 to -v5-3); and an unanswered task is audited `endedBy: "expired"`, tagged "No answer", read "Ended:" on
its question's row and not called stopped in the next turn's task_results (-r1).

**Listening and speaking (lane S).** The class of bug: a screen reader saying a live region's change through the
speakers into an open microphone. Hear me more clearly's line and the Speak note are said through their own held lines
(renderer/shared/held-live.ts `heldLive`) only once they have held for 1 s, only when their words change and never while
Home's `micHeld` says the microphone is opening or open, and main no longer passes through "Starting…" on each voice
process's ready (voice-listening-c4-1, with -c2-1's and -c3-1's residue). Task activity holds a task's change of state
until the microphone closes, then says each once (tasks.ts `holdTaskNews`), and the connection line is written only when
its words change (-r4-2). Ask's live region holds what it would say while its Listen once is open and then says only
what changed, one slot per kind, each as a sentence (`opensMic`, `heldNewsLine`; -i5, -v5-2). Lines a screen reader is
told are worded without Ember's name, and Ask speaks in the first person ("I'll see: …"): read by the test-only voice
into an idle wake microphone on the real models, the old wordings woke Ember in 5 to 20 of every 20 placements (13 of 40
for Settings' doubt line, 20 of 20 for "Ember will see: <window>…", which sent the window's title), and the new ones in
none (-r4-3, -c4-2, -i5). A failed speech download's words (`downloadHelp` in app/main/voice.ts), which named Ember and
woke it in 10 of 12 placements, say what went wrong with the download or the site and never hand back a raw error; none
woke Ember in 40 placements (-v5-1, -w5-1, -w5-2). While a screen reader runs, Voice Match teaching takes nothing begun
within 1.5 s of a prompt showing (`READER_LEAD_MS`) or in a prompt's own words (`PROMPT_WORDS`), and asks again where a
phrase ran on from the reading (`over`): the owner's held-out clips now score 0.82–0.88 and the screen reader's
0.42–0.46, where they scored 0.56–0.75 and 0.69–0.83 (-r4-1). Speaking, all text normalisation in app/voice/spoken.ts
and tts.ts: labelled steps and colon lead-ins are said as they stream, carrying what a piece's last line leaves for the
next (spokenText's `Lead`) and cutting at a short label's line, so each label is said with its step
(voice-speaking-c4-1, -v5-1, -v5-2, -w5-1); the last line of a piece is judged by as much of it as has arrived
(`lineEnd`; -w5-2); an answer opening with a line break or a short first line starts at its first clause again (-r4-1);
the line before a heading or a label ends (-r4-2); a menu path from a window's corner keeps its "to", before a quoted or
bracketed name too (-v4-2, -v5-3); arrow keys in chords are said as keys (-c4-3); spaced price ranges are said as
ranges, decided by the amounts' order so that sums stay sums, and never cut into two pieces (-c3-1); "$5-10", "9am–5pm"
and runs of numbers are said right and no streamed piece ends with "right arrow" (-2, partly); and short Spanish and
French replies that quote a file follow the request's language (-c4-2). Live with Kitten, five labelled steps start at
1.9 s (3.9–4.0 s before) and a colon lead-in at 0.5 s (2.3 s); after the second repair each step plays as its label's
line arrives, with gaps under 0.1 s instead of 1.1 s, and a bold heading over labels sounds after 0.36 s instead of 1.38
s.

**The companion, accessibility and Home (lane T).** A streamed answer's switch to its finished layout counts as growth
(`askGrew`), and an answer that grew into the open Ask box, or whose first words came while the box was open, may go
above or below it where nothing by Ember is clear (bubbleFit's `across`, `askGrownInto`): the live stream probe ends at
0 px² of overlap in eleven setups (companion-c3-1, -v5-1). The box steps aside again for a question grown taller under
its field (-c4-1). A box opened beside an answer still coming in keeps an out-of-sight row for its follow-ups
(`askSuggestionsComing`), only while "Suggest what I might say next" is on and only where the tallest finished answer
still has a place by Ember clear of the box (`answerRoom`, `ANSWER_MAX_HEIGHT` pinned by a live measurement), so on
tight screens they still wait for the next opening (companion-i5, accessibility-visual-c4-1 and -i5, all partly;
companion-v5-2); accessibility checked by keyboard and the accessibility tree that they land as buttons of the "Ember
suggests" group, in Tab order, and pinned that in the Ask journey. Accessibility: the Today line reads "2 got no answer
in time" (accessibility-visual-r4-1); the no-compositor card's whole-text key hint keeps each chord's keycaps together
(`.key-caps`) and wraps its words under them, measured by its text at every text size (-c3-1); and Home's status panel
reads the agent's runtime state (`runtimeState`): "Reconnecting…" while Ember's own model connection starts again, with
Models & connections… as its button, never the provider's details or Copilot's sign-in (-c1-2). Home: a typed "stop" is
no longer taken for a draft, and each Stop is said once under Send (home-r4-2, -r4-3); Cancel edit follows the words a
Stop gave back through each change in the composer (conversation-view.ts `GivenBack`, `givenBackFollow`,
`givenBackKept`), so a correction stays, a deleted message stays deleted, the request being edited never stays and a
second Edit keeps them above the new request (`composerEditAgain`; -r4-1, -v5-1, -w5-1 to -w5-4); and given-back
messages together over 2,000 characters are said to go one at a time, or the part under them to be shortened where it is
over by itself, with Edit's caution back once the field fits (`composerLineFits`; -c4-2, -v5-2, -v5-3). Each was checked
live against the re-raters' probes under Xvfb, at 760×640 with 420×420 dark looked at.

**Reliability, install and first run (lane U).** For rp-4, partly, an idle glance whose eyes have arrived is drawn at
the resting rate and wakes as it ends (rig.ts `nextChange`, `settled`): awake at rest with the pointer still, under Xvfb
with xcompmgr and listening off, the overlay went from 13.2–14.1 to 10.6–11.5 drawings a second and the whole tree from
7.6–8.3 % to 6.0–6.8 % of a core. CI's el8 footprint step now starts EPEL's xcompmgr (`footprint.mjs --compositor`), so
the overlay is counted, and samples past the first minute against the same 16 % and 950 MB (842–853 MB and 12.3–14.6 %
here). The start-up dialog says data-folder errors in plain words (`startupProblem`; reliability-performance-r4-1). On
Windows (M11) a `HelperWatch` asks the sidecar host's status again on Check again and when reads disagree with the setup
row (-c4-1, -i3), and the Screen reading row gives the host's plain reason by kind (uia.ts `START_DETAIL`), with
PowerShell's, the compiler's or Node's own words kept apart as `cause` for `ember doctor` (-v5-1, -w5-1); macOS's row
reads the Accessibility permission itself, so it asks the host's status only once after start, as before (-v5-2). Home
says "Ember couldn't answer this request…" when no reply began (-c1-1, its second half). Install and docs: after a
Windows handover with only this version cached, the npm launcher still names an older Ember from the zip
(install-docs-r3-3); a tunnelled 502 or 504 names the host and the proxy and adds asking whoever runs it, and one
answered to the CONNECT reads "couldn't get an answer from" (-r4-1); the start log's pid line is best-effort, so a disk
that filled since the install no longer fails a start (-r4-2: exit 0 after 3.1 s on a 2 MB tmpfs); an unwritable cache
gets `cantWrite()`'s sentence, a refused spawn `cantRun()`'s (fapolicyd, antivirus, a noexec disk), a bad SHA256SUMS
`notChecked()`'s, and a failed reinstall says the copy was kept (-c4-1, -v5-1); a start log that can't be made where the
user can't write is left out, an old one of another user's is made again, and otherwise a private temporary log
(0700/0600) keeps what Ember said as it stopped, so a kept copy really starts (-v5-2, -w5-1 to -w5-4); the launcher's
start tests run on CI's Apple silicon runner; and CLAUDE.md's gate lists the checks job's `npm pack --dry-run` and el8's
footprint budget, pinned against ci.yml (-r4-3). First run (M8.8): main's connection and check sentences are said in
first run's own voice on every visit, what they call Ember's included (first-run-copy.ts `inMyVoice`; first-run-r4-2,
-v5-1, -v5-2); under the user's own provider or the organisation's service, a cut-off task's outcome is in Ember's own
voice (host.ts `runtimeWords`' `cutOff`; -w5-1); the sign-in step says Try again, not main's "press Check again", where
it shows no Check again, adding Try again where nothing on it does main's check (`signInWays`, `pressOnStep`; -w5-2);
and the key placeholder follows the address typed, the no-keyring reason is a short sentence of its own, and three older
slow journeys got 20 s timeouts.

**Caught before merging.** Commands' first reviewer found file options of zstd, brotli, node, uv, poetry, pip, tar,
parallel and sudo still unjudged, a variable set to Ember's folder still reaching a program through a wrapper's option,
a here-string, an expansion, the program word or an export, `make -j $(nproc)` asking again, `grep --ignore` and `lsd
-t` hiding the file after them, and robocopy marking its whole destination (commands-remote-v5-1 to -v5-6); its second,
that a cut or a default of a variable stood for its whole value, so a download copied under a name cut from its URL ran
with no question (P1), that `${HOME:?}` resolved to nothing, that `T=deploy; make -j "$T"` built deploy unasked, that a
here-string refusal caught text filters that only read it and called a delete a read, and that an attached option value
Ember couldn't see became the command (-w5-1 to -w5-6). The words package's reviewers found "it", relative clauses,
participles, places after "of", "for" or "at", lists after "then", "… and nothing else" and more hold-back phrasings
still letting steps announce, then six regressions of those repairs, among them "the contents of X" and "for pid N" read
as the object of a reversed copy or of a kill of another process, and "say if it worked" no longer announced. Memory's
found the code-aware guard keeping a password after "its" or "never", a shell script's export, prose that only looks
like code, a user name with a digit before "@", a setting named for a secret, an admin's pair and "user X pass Y", and
photo apps' memories and months taken again, then the tightening refusing ordinary code once more (a call's last keyword
argument, a shell function's arguments, an object's last property, a Python block's body, an f-string's placeholder) and
"Passwords are hashed." (memory-v5-1 to -v5-6, -w5-1 to -w5-6). Integrations' found kept cards carrying the old
conversation's goal and screen text to another service and vanishing during the reconnect, then Try again starting a
split request's whole words again (integrations-v5-1, -v5-2, -w5-1); safety's, the fold saying Work without asking was
on during a held lockdown, then an open window never told (safety-privacy-v5-1, -w5-1, -w5-2); tasks', refusal rows
ahead of the answer they followed, unfolded, and the borrow's reason cut at 120 characters (tasks-approvals-v5-1 to
-v5-3). Listening's found the download lines still naming Ember and Ask's held lines joined unpunctuated, then the
download lines blaming this computer and handing back raw errors with the data folder's path; speaking's, a colon line's
steps lost across a cut, a bare label cut from its step and an arrow after "right" before a quoted name, then a label
holding back the step before it for 1.1 s (voice-listening-v5-1, -v5-2, -w5-1, -w5-2; voice-speaking-v5-1 to -v5-3,
-w5-1, -w5-2). The companion's found an answer begun while the box was open still finishing under the field (50,490 px²
at 1024×768 Larger) and a blank row with suggestions off (companion-v5-1, -v5-2); Home's, Cancel edit working from a
stale copy and the wrong line for an over-long draft, then the given-back words told from the request by guesswork
(home-v5-1 to -v5-3, -w5-1 to -w5-4). Reliability's found the Windows row without the host's reason and macOS asking the
host's status at every perception cycle, then PowerShell's and .NET's own words in the row
(reliability-performance-v5-1, -v5-2, -w5-1); install's, a refused spawn said as an unwritable cache and a start log
that kept a kept copy from starting, then what Ember said lost with the log and the start tests failing on CI's Apple
silicon Mac (install-docs-v5-1, -v5-2, -w5-1 to -w5-4); first run's, lines mixing "I" with "Ember's", then a cut-off
task still said of Ember and "press Check again" naming a button the step lacks (first-run-v5-1, -v5-2, -w5-1, -w5-2).

**Merges.** Lanes Q, R, P and S merged cleanly. At 4ae47eb (lane T) design-system.md's screen reader bullets kept lane
S's rules for the open microphone and added lane T's sentence on an event main tells twice to the throttling bullet;
status-copy.ts's `StatusFacts` kept lane Q's `switching` and lane T's `runtime`, which `statusWord` reads in separate
branches; and Home's main.ts kept lane S's `holdTaskNews` (the merge commit says lane R's), lane Q's `COMPOSER_HELD` and
lane T's `runtimeState` and composer edit imports, with `statusWord` given both fields. At 73554c2 (lane U) Home's
`endComposerWait` kept lane U's `problemSaid()` for a Problem line with lane T's record of the words a Stop told, and
welcome.ts's sign-in line writes lane Q's "I've switched to Copilot" line once, through lane U's `signInWays`, which
names only a button the step shows.

**Consent and departures.** No consent version changed (`CONSENT_VERSION` 7, `FEATURE_CONSENT_VERSION` as round one left
it): no package bumped one, and what is read, sent and kept is unchanged; Apps & privacy's fold follows the settings and
the policy without touching first run's text. No departure from §2: every package's notes say so, and no change reaches
a §2 decision. Several changes only tighten rules that stood: a dangerous command the words hold back, or whose object
they only place or describe, asks instead of being announced (§2 "Commands"); Ember's own files reached through more
forms of variables, wrappers' options and PowerShell variables are refused; downloads stay marked through robocopy, dd
and a cut of their URL; switches no longer hide what a command acts on; and a task's Try again on another model service
sends only the user's own words. Two loosen a refusal that was wrong, each against a pinned look-alike set: code that
names a secret with code for its value is sent, and a command that only tests or prints a variable set to Ember's
folder, or a text filter that only reads it, runs.

**Left.** Partly fixed (12): Ember's folder through sh -c's "$0" and "$1", `${d:-…}` and `: ${d:=…}`, a cd that may fail
before a pattern, and `find … -exec rm` still ask rather than refuse (commands-remote-v4-4); the guard still keeps "The
Wi-Fi is BlueSky99", "Netflix: hunter2!" and "The alarm is 4821" (memory-1; "Netflix: hunter2!" fixed in the sixth
round, below), and "Forget Jenkins" is still taken for a person, so it doesn't reach the conversation (memory-c1-1); X11
authentication windows still stop only borrows, the owner's call (safety-privacy-3; a prompt program's own window fixed
in the sixth round, below); "3/4", "555-1234" and a spaced "$5 - 10" are said as written (voice-speaking-2), and
how far Kitten may say short foreign replies is the owner's (-11); follow-ups that come into an Ask box opened on a
tight screen wait for its next opening (companion-i5, accessibility-visual-c4-1, -i5); a Stop with Home closed still
loses a waiting message (home-r3-1, with home-c4-1); awake rest is still about twice docs/ASSISTANT.md's 3 % and 400 MB,
and 13.6 % of a core with the pointer moving (rp-4); and Try again on Home's own Problem row
(reliability-performance-c1-1's first half). Skipped (47): owner decisions: memory's predicate names (memory-4), which
memories shaped an answer (memory-10), an unlisted Indian place's PIN code (memory-r3-3) and "Forget everything I told
you" (the rest of memory-v1), probing a remote provider at each start (integrations-1), the provider card's wording and
its consent bump (integrations-2, -13, first-run-10), browsing marketplaces before the extensions card
(integrations-i2), auditing context reads (safety-privacy-6), the route after re-agreeing (safety-privacy-8,
first-run-4, M8.8), describe_screen's window titles (safety-privacy-r2), Stop speaking on the bubble and a notice when
the voice changes (voice-speaking-5, -6), room talk begun after Listen once's first second (voice-listening-c1-1, ruled
out by the owner decision of 2026-11-05) and the doubt cut at 12 seconds with its earcon (-1, -r2-1), npm.yml's tag run
without publish credentials, the prerelease title and a sooner update retry (install-docs-2, -4, -11), and, at 1366×768
Larger, the side strip before the place above or below the box (companion-c2-4); larger work: memory's unsaved state
(memory-r2), Undo for a learnt word (memory-7), Try again on Home's Problem row (home-7), Home's draft and waiting
messages kept across its close (home-c4-1), actions on Home's crash notice (reliability-performance-r2-2), an unknown
state for a hung pyatspi import (rp-1), a microphone chooser (voice-listening-v2), holding first run's Agree while the
recipient is unknown and switching off a provider left unchecked by a quit (first run's carried items); native hardware:
commands-remote-6, the Ask box's clear margins (companion-4), a cut-in that waits for the piece being made
(voice-speaking-10) and a Mac's open(1) handover (install-docs-c2-3); design: 800×600 at Larger text (companion-1,
-c1-1); on purpose: a press that finds Ember already listening isn't announced (voice-listening-v4-2); and notes and
items another package owned (companion-r4-1, safety-privacy-1, -v4-1, -c4-2, -c4-3, integrations-i3,
accessibility-visual-i3, home-i4, first-run-i5), of which safety-privacy-1 and -v4-1 stay partly open in memory-1
("Netflix: hunter2", "Login is localhost:3000/login" refused; both fixed in the sixth round, below). The other half of
install-docs-4, folding 0.1.1's older dated sections into its feature sections, is still to do in CHANGELOG.md.

**Found on the way.** Commands: a copy to a destination Ember can't name asks at the copy but doesn't mark the later
run; PowerShell's `foreach` and cmd's variables don't feed Ember's own refusal; `echo "$d" | xargs rm -rf` and the XDG
idiom `rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/ember"` ask where they should be refused, and `make -j$(nproc)` with
the value attached asks (all three fixed in the sixth round, below); chroot's new root and a few tools' output options
aren't judged; `find ~ -name '*.pyc' -delete` is refused whatever the pattern, and so are `cat <<< "$d" | wc -l` and a
here-document that only prints such a variable; robocopy's `/MOV` and `/MOVE` get `/MIR`'s card line; and quoted or
noted steps ("TODO: delete src/"), "on" before a folder ("the build folder on the desktop" covers `./build`), "the
parent process with pid 1234" and "… and I'll say if it's ok" still announce. Memory: fail-closed residue ("token =
element", "PSK is enabled on the router", the second fixed in the sixth round, below), misses ("DB_PASS=Tr0ub4dor&3" and
`"pin": "4821"`, both fixed in the sixth round, below; `const password = myPass1;`, a code said with "'s" such as "The
gym's code is 4821", and, since this round's login rule, "user james pass hunter"), a remember note still missing after
"Note that I prefer email" and "Remember Priya out Friday", still given after "Remember the issues users reported last
week" and, since this round, missing after "Remember that my wife likes tulips and buy some, remember", and a 1 MB line
of 100,000 secret-named keys taking about 19 s in `memoryRefusal` (unreachable through Projects' 24 KiB a file).
Integrations: first run's in-use edit still refuses a host with no model list, and `friendlyError` says "your model
service" for the user's own provider; Projects' refusal of a request doesn't say which words tripped the guard, and
prose-shaped code in one ("Fix the bug where token: undefined is logged") is still refused; and a card from a typed "try
again" offers only Close on another service. Safety: during a held lockdown the other managed switches (voice, speaking,
memory, updates, routines) are still drawn from the settings (fixed in the sixth round, below, but for Hear me more
clearly and the voice); the fold's approval line still says Ember asks before acting in an app
while "Don't ask before working in an app I asked for help with" is on, and under a lockdown that stops every action;
and with nothing turned on under a policy that turns off some commands, its other computers line repeats its heading
("Other computers and commands: other computers and commands on this computer are off…"; fixed in the sixth round,
below). Tasks: a question that ran out of time still reads "Stopped:" on the step it held, and perceive's never-look
refusal sends no refused activity. Listening: CI's voice job doesn't prepare the test-only voice, so the real-model
Voice Match case skips there, and the natural voice's status line, Task activity's lines for a task's own Stop and Show
app, the setup check's Speaking row and Voice Match's lines aren't held or reworded yet (the natural voice's and Voice
Match's fixed in the sixth round, below); a failed download's line in Hear me more clearly can end with "try
again" twice, a Windows EPERM that outlasts the rename wait still reads "permission denied", and the microphone's own
error names are still shown as they come. Speaking: three or more short bare lines cut apart at a label are said in one
breath when streamed; bare option names between long lines ("Option A", "Option B") run together; and a "→" after
"right" before "the" or "a" loses its "to" ("top right → the gear icon"), while an ASCII "->" after its direction is
said "right right arrow". The companion: Ask opened while Ember is still flying to the cursor can leave Ember under the
box, and a box that opens with suggestions grows once just after it opens. Accessibility: under Copilot a not-answering
status whose detail doesn't end in "Reconnecting…" still reads "Not connected". Home: a later Stop can say again that a
message is back after the field was emptied, and Cancel edit can't tell a message brought back with Ctrl+Z from the
request and splits a request pasted over everything at its first blank line. Reliability: on Windows a spawn error Node
throws synchronously (EPERM or UNKNOWN when AppLocker blocks powershell.exe) leaves no Screen reading row and no
back-off (fixed in the sixth round, below), Check again during a bridge restart slower than 6 s shows the old row until
the next read, and a helper on another protocol version still names the version numbers in the row. Install: the
launcher's redirect-loop error and a corrupt zip's output aren't plain sentences yet, `ember doctor` on a Mac still
gives Node's own words for a cache it can't write in, and on Windows the temporary start log of an Ember that keeps
running may be left in %TEMP%. First run: the bubble's `firstPerson` leaves "Ember will try again in a moment.", a key
saved for the old host still counts as saved for a new address, main's hint for a GitHub sign-in it can't find still
says to press Sign in with GitHub on a sign-in step that shows only Try again, and the provider step after a passing
check can still say "press Check again". Tests that flake under load: first run's first-run-6 and first-run-v2 journeys
and the launcher's install-docs-v4-2 signal test.

**Native validation and owner decisions.** Still to check natively: rsync 3.2.3 or later's `--mkpath` in a WSL distro or
over SSH, podman run on RHEL 8, and robocopy, dd and the PowerShell variable refusals on a real Windows PC with
PowerShell 5.1 and 7; commands-remote-6 with an sshd, a VPN-only name and a Mac; GNOME 3.32 with platform-python 3.6 for
the held decision's refusals; whether Orca, NVDA and VoiceOver read the corner card's and the bubble's live regions into
a conversation, real screen readers' timing while Voice Match is taught (1.5 s) and how often a phrase must be said
again, each Stop's line said once, the kept follow-up row read as absent while empty, and the corner card's wrapped key
hint in a real no-compositor session (GNOME Classic, MATE without compositing); how the label pieces, "to" ranges and
"Windows key left arrow" sound with Kitten on the RHEL 8 target, and real foreign system voices; `answerRoom` under RHEL
8's GNOME top bar at 1024×768 Larger; a Windows bridge failing after 10 s and recovering, and whether Windows reports a
blocked Ember.exe or a reopened start log as EPERM; corporate HTTPS-inspecting proxies inside the tunnel; and the first
CI runs of el8's footprint step under xcompmgr and of the launcher's start tests on macos-15. For the owner, beside the
lists above: how far a copy Ember can't name counts as a download; whether "if that's okay" or "when you can" hold a
step back, whether a quoted or noted step is a request, and whether deadlines ("before Friday") should ask; whether bare
"Clear memory", "Reset memory" and "Empty memory" stay memory erases; whether a retry on another service keeps the
window title it was asked in; the names "Ember's model connection" and "my model connection", and "2 unanswered" for the
Today count; Home's Enter-to-send and the 640 px corner card for any question; a least-overlap Ask box placement and the
order of the side strip and the place above or below the box; `RESTING_FRAME_MS`, the pace of fidgets and glances and
whether still faces stop drawing, before docs/ASSISTANT.md's budget and CI's 16 % and 950 MB are restated; and a
listening earcon (§6).

### Product audit fixes, sixth round (2026-11-08 to 2026-11-09)

After round five each area was rated again at 73554c2 in the same way, by a re-rater and an adversarial challenger
working apart. Their scores out of 10 (re-rater, then challenger) were: commands, WSL and SSH 7.6 and 6.9; safety and
privacy 8.5 and 8.0; memory 8.5 and 8.1; listening 8.6 and 8.3; reliability and platform 8.7 and 8.4; models, providers,
extensions and projects 9.1 and 8.6; the companion and Ask 9.1 and 8.8; Home 9.2 and 8.8; tasks and approvals 9.3 and
8.9; first run and setup 9.2 and 9.1; install, docs and developer experience 9.3 and 9.1; speaking 9.3 and 9.1; and
accessibility and copy 9.4 and 9.3. They found 44 new items: 3 P1, 15 P2 and 26 P3. The P1s were all commands': a
download saved under a name held in a variable, or one the server, a recursion or a list picks, was never marked, so
running it asked nothing, and redis-cli and mongosh ran FLUSHALL or dropDatabase fed on their input with no card
(commands-remote-r5-1, -c5-2, -c5-3). Among the P2s, the guard let real passwords through in a Ruby or PHP hash, under a
YAML key or in a pretty-printed JSON object or Python dict (round five's loosening for code), or on a command's short
option, and kept one said as changed or current (safety-privacy-r5-1, -c5-1, -c5-2, memory-r5-1); "from memory" was
taken from requests that can only mean Ember's memory (memory-c5-1); Home's status, Hide, composer and Voice Match lines
and the natural voice's line still woke Ember through a screen reader (voice-listening-r5-1, -c5-1); Read all with the
Ask box open laid the answer under the field (companion-c5-1); echo or printf handed Ember's folder in a variable to
`xargs rm -rf`, a downloaded patch or a pull from an address carried no mark, everyday parallel builds asked, and "at
the root of frontend/" placed nothing, so ./build was deleted as asked (commands-remote-c5-1, -c5-4, -r5-3, -r5-2); and
an edited request threw away a draft a Stop had given back, a declined step went on another step's row, and Home's held
edit adopted a host that answers 404 to everything (home-c5-1, tasks-approvals-c5-1, integrations-c5-1).

Nine areas scored under 9 from either rater. The integrator planned packages for them and for the P3 regressions
elsewhere in six lanes, each worked one package after another as in round five: P (commands: the classifier's parsing,
then the words a request is matched to), Q (memory, then integrations), R (safety and privacy, then tasks and
approvals), S (listening, then speaking), T (the companion, accessibility, then Home) and U (reliability and platform,
install and docs, then first run). It gave memory's package every guard phrasing and code shape reported under safety
and integrations (memory-i6), listening's every line a screen reader is told without Ember's name, Home's included
(voice-listening-i6), and integrations Projects' own refusal words (integrations-i6). Each package was to be read by a
regression reviewer and repaired, and the repairs read and repaired again.

**Cut short.** A usage limit stopped the round after each lane's first package. Lanes P, Q and S merged with no review
(4e6a7a8, feb7973, 5d6b1c8); R and U merged after their reviewer's pass and its repairs, with the second repair stopped
(8db5d77, 85fb9fd; U's unfinished change left out); and T after its reviewer and two of the repairs, before the repair's
final gate (aaf0ab0). No second package ran, so the words, integrations, tasks and approvals, speaking, accessibility,
Home, install and docs and first run got no work this round. The six packages reported 83 items: 35 fixed, 10 partly and
38 skipped (routing notes, owner decisions, native checks and items another package owned).

**What the first packages did.** Commands (lane P, M12): what echo, printf or another printer prints into the next
command or a file is that command's input, and only what goes to the terminal is shown, so Ember's folder held in a
variable is refused again through `echo "$d" | xargs rm -rf` and PowerShell's pipe (commands-remote-c5-1, -v5-2, -r4-5);
a download Ember can't name asks "Downloads to a file Ember can't name." and marks its folder (anywhere when it can't
tell which), and an applied patch or a pull from an address marks the files it changes (-r5-1, -c5-2, -c5-4);
redis-cli's and mongosh's input and SQL files fed with `<` are judged (-c5-3); awk and sed count as text readers only
when their programs neither run nor write (-r5-4); a default's text is a value for Ember's refusal, so the XDG idiom is
refused (-v4-4, partly); dos2unix -n, sort -o, split, tar pipes and zips carry a download (-c2-2, partly); and processor
counts attached or given to make, cmake, ctest, pytest, sort and gradle run (-r5-3), with the variable counts the last
phase took back (below). Memory (lane Q): the guard is fail closed again for a literal under a key named for a secret,
wherever the key sits (`holdsUnder`, at most 40 lines and 2 KiB), and for call, index, XML and attribute pairs; the
redactor hides a password given to a program's short option (`OPTION_PASSWORDS`), so Projects, task views and memory
refuse the line and command output hides it; a secret said as changed, current or to be, with its service or under a
router's label is refused; and prompts, labels, credential-free addresses and requests that name a type pass
(safety-privacy-r5-1, -c5-1, -c5-2, -1, memory-r5-1 to -r5-3, integrations-r4-1). On 16,328 files of 24 KiB or less,
refused files went from 435 to 415, none newly refused, at about 1.5 times the guard's time. `memoryAsk` answers a bare
"from memory" again where only Ember's memory can be meant, and the remember note follows a ", remember" tag only after
a fact about the user (memory-c5-1, -c5-2). Safety (lane R): on Linux, the window of a program that is only a password
prompt (`PROMPT_APP`: pinentry, ssh-askpass, polkit agents, gcr's prompter, by WM_CLASS) counts as an open prompt,
focused or not (`Perception.promptOpen`), so the request's context, describe_screen and perceive read nothing and every
step is refused, failing closed on a window stack it can't read (safety-privacy-3's remainder); Apps & privacy's
commands line never says "other computers and commands on this computer" (-r4-2); and a held lockdown draws each switch
it turns off as off (-w5-2). Listening (lane S): the natural voice's line is said through its own held status line
(`#natural-live`), and a voice already on stays on while it loads again after `VOICE_IDLE_MS` (voice-listening-c5-1,
closing -c3-1's residue); the lines Home says by themselves are worded without the name, and the new ones woke Ember 0
of 40 times on the real models against 35 to 40 for the old (-r5-1); and Voice Match teaching asks again for a phrase
said as its prompt showed (`QUICK_PHRASE_WAIT_MS`; -r5-2). The companion (lane T): Read all with the box open may go
above or below it, cut a line at a time to the tallest clear place where nothing fits whole (`bubbleCut`, at least three
lines), ending at 0 px² in eight setups against 22,192 to 57,528 (companion-c5-1); the box offers no reply to an offer
Read all cuts off (-c5-2); and what it shows keeps off the task cards (`clearOfCards`; -r5-1, partly: 1024×768 Larger is
left). Reliability (lane U, M11 for Windows): a powershell.exe that a policy blocks is a failed start, with plain words
and the back-off (reliability-performance-r5-1); the start-up dialog gives Windows its own advice and says to reinstall
or report when starting again can't help (-c5-2); and CI's resting-cost budget runs on the C API the packages listen on
(`footprint.mjs --native`, 850 MB) with a WebAssembly run kept at 950 MB, and fails when the voice process fell back to
WebAssembly or didn't listen through its sample (-c5-1, -v6-1, -w6-1). docs/ASSISTANT.md's figures are measured: about
700–790 MB natively and 900–950 MB on WebAssembly with Home open, 11–15 % of a core awake (without the Copilot runtime,
about 100 MB more, which footprint.mjs doesn't start: round seven).

**Reviews and repairs before the merge.** An independent reviewer read each lane's round-six commits that had merged
unreviewed or whose review the limit cut (findings -x6-N), a repair agent fixed each with a test seen failing first, a
second reviewer read the repairs (-y6) and a second repair fixed what it found; for commands, memory, listening and the
companion a third reviewer read those (-z6), a third repair followed, and a last reviewer checked it before each merge
(-q6). They found 20, 18, 14 and 13 problems, and the first repair also took lane U's -w6-1, left by its stopped second
repair. The first found, among others, a job count's variable the shell split into a deploy target, printf's octal
escapes passing for plain text, a password two lines under its label or after "rotated" or "see" kept, a quoted
passphrase taken for UI text, Listen once's line still waking Ember, and an answer read in full lying under the reopened
box. Two P1 regressions came from the repairs themselves: the one that ended printed text at a NUL let `printf 'DR\0\nOP
TABLE users;\n' | psql app` run its DROP, and the one that parsed redis-cli's options out of a variable let `--rdb`
write over Ember's settings.json (commands-z6-1, -z6-2). Both were reverted (a8b04f9, 3cc3341), so a NUL-separated read
loop over Ember's folder asks again rather than being refused, and `O='-h db'; redis-cli $O INFO` asks, saying it
changes data, where main runs it. A third P1, a MySQL password after a Windows prompt, a comment mark, markup or a
quoted mysql.exe path still shown (memory-z6-1), was fixed (e2f316a). Safety's in-lane second review found its repair
drawing Hear me more clearly off and the voice as Kitten Nano under a held lockdown while Ember still used them until a
restart, so a 482 MB download couldn't be stopped (safety-privacy-w6-1, -w6-2), and b8bec38 reverted it. Listening's
last reviewer found the line that named Teach as "the button below" pointing at Listen once (voice-listening-q6-2), and
9918cf8 put back "Teach your voice again, …". The resting-cost run's DevTools calls got a test with a fake socket, so a
page that closes during the sample can't hang it (reliability-y6-1).

**Commands held to main.** Each review of the command repairs found more commands that ran where main asks, so the last
phase took one rule: nothing may decide less safely than main (4d64d3a, the audit's baseline). A fixed comparison ran
every probe command the reviews had gathered, about 7,000 forms, and main's own 3,784-case corpus through the classifier
and the run_command flow, on main and on the tree; it began at 1,115 lines that decided less safely than main. Where a
rule couldn't be held it was narrowed to main's. A job count is only a number, a processor count's substitution or
arithmetic of numbers, quoted or not, so one held in a variable and attached to its option asks whatever the command set
it to, while one given apart from make's `-j` runs, both as on main (f1bf100, which replaces the variable counts of
f2e0739, 8d9a2e2, f31e822, 16737fd and 36ac73c; commands-q6-3, -q6-5, -a7-1). A read, mapfile, readarray, select or
getopts over text Ember can't see, and a for over a pattern, a variable or a substitution, ask (f637cb2; -a7-2). A loop
or if that changes the folder, sets a variable, holds a `[[ … ]]` test or anything that asks keeps main's question and
is never announced (3f37dea, `holdsFlow`; -b7-1 to -b7-4). Those two narrow round one's read-through of loops (d4d7ebe),
which judged a body once in the folder the line starts in, so `for i in 1 2; do sed -i … ember/settings.json; cd
~/.config; done` edited Ember's settings on its second pass with no question (-b7-1, P1). After the merge a review found
that a written-out loop's words reach only Ember's own refusal, never the judging of its body, so `for f in --hard; do
git reset $f; done` ran as `git reset --hard` with no question (commands-c7-1), and c2bce75 took loops back to main's: a
bash or sh loop on a command line (`for`, `while`, `until`) always asks first, as on main, however plain its body, with
the loop's own words ("Ember can't tell exactly what this does."); Ember's own folder named in a loop is still refused
first, and an ordinary `if` still runs. Two forms main ran are refused: `patch -d`, `--directory` or `--di` into Ember's
folder, and `cd --` or `pushd --` into it (0d3ae58, a28ab38; -a7-3, -a7-4, -b7-5). At a48f234 main's corpus had 0
commands decided less safely and 3 more safely, and the probe corpora's 320 looser lines (the classifier and the flow
counted apart) were 141 commands: 139 job counts written as a processor count or arithmetic of numbers, each run by main
with a plain number; one written-out for loop whose body main runs written out; and `cd -- ~/.config/ember`, which the
tree refuses but the comparison ranks below an unknown verdict. After c2bce75 the loop is gone: the flow's 160 looser
lines are 140 commands, the 139 job counts and `cd --`, and main's corpus is still 0 worse and 3 stricter. An
adversarial reviewer tried about 1,600 more forms against main; what it found is fixed above or left below.

**Merges.** Lanes P, Q, R, S, T and U merged in that order, then b8bec38, the repairs (f7b35ec, be5c59b, 6880ad4,
cd1a9ae, 3fc0b66), the second repairs (c959a43, 5d9639e, f2c2e0b) and the commands phase (a48f234): 106 commits, 15 of
them merges; c2bce75, which made every loop on a command line ask, merged after them. Every merge applied cleanly, with
no cross-lane resolution needed: the integrator had kept each lane to its own files, and the lanes whose second packages
would have shared files with others (accessibility and Home with listening's strings) never ran. The one conflict was
inside a8b04f9's revert of 93cdbbb, in the commands guide's list of printf escapes, which kept a2dbf36's.

**Consent and departures.** No consent text or version changed (`CONSENT_VERSION` 7, `FEATURE_CONSENT_VERSION` as round
one left it). No departure from §2: every package says so, and the commands phase only moved decisions back to main's or
tightened them (§2 "Commands"). Against main, two kinds of command decide more loosely: a job count written as a number,
a processor count or arithmetic of numbers, which main runs as a plain number, and an `if` on a command line that sets
no variable, changes no folder and holds no command Ember has anything to say about, where main asked for every `if`. A
loop read through the same way wasn't safe, since its body is judged once and its words reach only Ember's own refusal
(`for f in -delete; do find . $f; done` ran where main asks; commands-c7-1), so c2bce75 made every loop ask again, as on
main. Corrected in round seven: the count of two kinds was untrue. The comparison's corpus then held no xargs batch and
no printed SQL, and at 6b750a2 it found 245 commands decided less safely than main outside job counts: 120 a plain `if`,
the rest printed text piped into database clients and xargs, job options with no count, `${VAR:?}` in a test and `time`
before an assignment. Round seven closed them (below).

**Left.** From the last reviews: a MySQL password in a list of a program's arguments (a compose file's exec-form
healthcheck, a subprocess list, `docker inspect`'s Test array) is neither hidden nor refused, also so on main
(memory-q6-1, P2); network notes with no key are refused once a DHCP range, a subnet, a date or a router model follows
another field (-q6-2), and so are pretty-printed sign-up forms whose next line is a hint or a template expression
(-q6-3); a password after "salted" between commas or "min." with its full stop is kept (-q6-4), as is a Wi-Fi key
labelled "Key:" on the line after the network's name (-q6-5); and a keep test pins a demo password under a second
password field (-q6-6). After Forget my voice the screen reader reads the focused Teach button, whose label and
description name Ember, over the announcement, and through speakers that woke Ember and was sent as a request, as it did
before round six (voice-listening-q6-1, P2); and "Teach your voice again" can still read as training the person's own
voice (-z6-1). Commands, each also so on main: an empty options variable before redis-cli's command runs it, and
commands on its input with it (`O=''; redis-cli $O FLUSHALL`; commands-q6-1); `env -C . sh < deploy.sh` runs a script
Ember never reads (-q6-2); a variable in an option's attached value is judged as a path only for Ember's own refusal, so
`d=~; tar -C "$d" -xf /tmp/x.tar` and `curl -o"$d" …` run, the download unmarked, so running it later asks nothing; a
job count given apart as a substitution or a variable read from a file (`xargs -P $(cat jobs.txt) echo`) is split into
words that become options and a command; a NUL-separated read loop that deletes Ember's folder asks rather than refuses;
`patch -d ~ -p0 < p` runs, since a write into the home folder itself doesn't ask; a shell script's loops are still read
through and judged once in the folder the script starts in (`judgeScripts`), where holding them as on the command line
would be stricter than main; `optIs` takes a long option only from three letters, so another tool's two-letter
abbreviation of a file or folder option would be missed (none found beyond patch's `--di`); `xargs
--process-slot-var=PATH` runs; and lane P's first package left a remote added in an earlier command, copies through
inline code, PowerShell's `foreach` (commands-remote-c3-2), sh -c's "$0", a cd before a pattern and `find -exec` (-v4-4)
and its native SSH, WSL and PowerShell checks (commands-remote-6). The comparison's script ranks a verdict it doesn't
know above a refusal. Stricter than main, and left as such: redis-cli with its options held in a variable asks as a
change even for a read (`O='-h db'; redis-cli $O INFO`). No package reached commands-remote-r5-2 (P2: "at the root of
frontend/" still places nothing), home-c5-1 (P2), -r5-1 and -c5-2, tasks-approvals-c5-1 (P2) and -c5-2,
integrations-c5-1 (P2), -r5-1 and -r5-2, accessibility-visual-r5-1 and -c5-1, voice-speaking-r5-1, -r5-2, -c5-1 and
-c5-2, install-docs-c5-1 to -c5-3, and first-run-r5-1 and -c5-1. Partly fixed or skipped in the packages: the box clear
of the cards at 1024×768 Larger (companion-r5-1); "The Wi-Fi is BlueSky99" and "The alarm is 4821" (memory-1) and
"Forget Jenkins" (memory-c1-1); a held lockdown that reaches Hear me more clearly and the voice only after a restart
(b8bec38's follow-up); X11 prompts known only by their title (safety-privacy-3); rp-4's resting rate; Try again on
Home's Problem row and the crash notice's actions (reliability-performance-c1-1, -r2-2); an unknown state for a hung
pyatspi import (rp-1); the 12-second doubt (voice-listening-1, -r2-1); and a microphone chooser (-v2). The owner
decisions stand as round five left them, safety's #1 to #5 among them. Still to check natively: the prompt programs'
windows on GNOME 3.32 with platform-python 3.6; real screen readers for every line said without the name and for
teaching on headphones; AppLocker's block and the start-up dialog on a real Windows PC; the resting cost on the RHEL 8
target with the C API; and the first CI runs of el8's two footprint budgets.

### Product audit fixes, seventh round (2026-11-11)

After round six each area was rated again at 6b750a2 in the same way, by a re-rater and an adversarial challenger
working apart. Their scores out of 10 (re-rater, then challenger) were: commands, WSL and SSH 7.0 and 6.5; safety and
privacy 8.7 and 8.0; memory 8.6 and 8.2; tasks and approvals 8.8 and 8.3; models, providers, extensions and projects 8.6
and 8.4; listening 8.4 and 8.6; Home 8.6 and 8.5; speaking 8.8 and 8.5; first run and setup 8.9 and 8.6; accessibility
and copy 8.8 and 8.8; reliability and platform 8.8 and 8.8; the companion and Ask 9.2 and 9.1; and install, docs and
developer experience 9.2 and 9.1. They found 70 new items: 4 P1, 13 P2 and 53 P3 as their finders rated them (the
challenger put commands-remote-r7-2 at P2 and voice-listening-r7-1 at P3), and confirmed the items round six never
reached as still open. Three of the P1s were commands': xargs with `-n` or `-L` was judged as one command, so `printf
'status\npush --force\n' | xargs -L1 git` ran its second batch unjudged, a regression against main
(commands-remote-r7-1); sqlite3's short dot-commands and the files a database client writes ran programs and wrote over
Ember's settings with no question, as on main (-c7-1); and a download named from an address Ember can't see whole, or
saved by `wget -x`, marked the wrong file or none, so running it asked nothing (-c7-3, widening round six's open -r6-1).
The fourth was safety's: with Work without asking on, Enter in any web form's field labelled "…address", "URL" or
"location" went unasked and submitted the form (safety-privacy-c7-1). Among the P2s, controls that grant access, bid,
book, bet or change who can see something went unasked under a standing "Always", and a button with no name was clicked
whatever sat around it (safety-privacy-r7-1, -c7-2); a step queued in the same reply acted in the app after the user's
"Not now" (tasks-approvals-c7-1); a fact forgotten within a minute of being said came back, and replaced facts stayed on
disk and reached Copilot though Settings could neither show nor forget them (memory-c7-1, -c7-2); Test connection said
"Connected" to a web page and a held edit adopted it, and Projects looked ready with the organisation's
`features.actions` off (integrations-c7-1, -r7-1); first run passed a model name the service doesn't list
(first-run-c7-1); Teach started with no working microphone (voice-listening-r7-1); a Spanish reply often went to a
French voice (voice-speaking-c7-1); a program merely named echo was trusted as the shell's (commands-remote-c7-2); the
approval window's "Risky step" tag was 2.9:1 in light windows (accessibility-r7-1); and the README said 600 MB of memory
where 700 to 950 MB was measured (reliability-r7-1). The challenger's comparison with main also failed at 6b750a2,
against round six's own record (commands-remote-r7-2, -c7-4; below).

Eleven areas scored under 9 from either rater. The integrator planned twelve packages in five lanes, each worked one
package after another in its own worktree, two agents at a time: P (commands: safety, then loops and the words a request
is matched to), Q (memory, then integrations), R (safety and privacy, then tasks and approvals), S (listening, Home,
then first run) and T (speaking, accessibility, then reliability with install and docs). The companion had no P1 or P2
and got no package. Each package went the same way: a fix with a test seen failing first, an adversarial regression
reviewer (findings -x7-N), a repair, a second reviewer (-y7-N), and a last step that fixed or reverted any P1 or P2 the
round's own commits had caused, and designed nothing new. The fix agents reported 99 items: 71 fixed, 13 partly, 13
skipped and 2 not reproduced. The round is 124 commits, 5 of them merges: 68 fixes, 39 repairs, 10 from the last step
and 2 after the merge.

**What the packages did.** Commands, safety (lane P, M12): each xargs batch is judged as its own command, up to 32, and
with `-s`, `-x`, `-E` or a count that is no number the input is judged as unseen, as on main (0b84e9a;
commands-remote-r7-1); every sqlite3 or duckdb dot-command asks unless it only shows things and is written whole, and
psql's `-o` and `-L`, mysql's `--tee`, `--pager` and `--init-command`, `source`, `\gexec` and writefile() ask or, onto
Ember's files, are refused (86ee2ed; -c7-1, on the tools' documentation: none is installed here); a download saved under
a name Ember can't read off the command (an address in a variable, one fed through xargs or a loop, `git clone $REPO`,
curl's `file[1-3].sh`) asks and marks its folder, `wget -x` marks the host's folder, `http -d` asks, fetched text
written through a variable marks its file, and `node .` asks when the folder's entry file is a download (6ea28c5; -r6-1,
-c7-3, -i6a); only the bare names echo and printf count as the shell's (d0c7a0a; -c7-2); printed text into psql, mysql,
sqlite3, duckdb, `make -f -` or `awk -f -` asks ("It runs the text another command prints into it."), and a `${HOME:?}`
word is judged both as the folder and as the unseen word main saw, keeping the stricter (1b9de06; -r7-2); and a place
said after the name in the user's words ("at the root of frontend/", "next to frontend", "on the server"), or a `cd ..`
before the step, makes it ask instead of announcing (7b496e8; -r5-2, with -c3-1, -i5b and -i6b partly: 45 phrasings
probed). Commands, loops and words: a simple `[[ … ]]` test outside an `if` or a loop is judged as its `[ … ]` form
(63f6ff1; -r6-2's test half; its loop half was reverted, below); a file handed over by `gh run download`, a bucket,
`kubectl cp`, `docker cp`, `scp "$H:run.sh" .` or `ssh host cat x > x` counts as a download, and `ssh host … | sh` says
it downloads code and runs it (90e2d64; -r7-3); and the card says "May run a file downloaded in this task: …" when the
file that runs has no name Ember knows (329e05b, 94d2164; -r6-4, partly: it still asks). Memory (lane Q): the redactor
hides, and memory and Projects refuse, a password that is its own element of a list of arguments (a compose exec-form
healthcheck, a subprocess list, `docker inspect`'s Test array, a YAML list), at 75 to 200 ms for 1 MiB of each new shape
against 11 to 110 ms, still linear (636b977; memory-q6-1); a Forget holds its words back from any batch of waiting turns
that begins within two minutes, in RAM only (276f290; -c7-1); Settings › Memory lists replaced facts as "No longer true
since <date>" with their own Forget, counts them, and forget_memory reaches them (41377c4; -c7-2), with a summary's
earlier wordings left out and forgotten with it (1cb1716; -x7-4); nothing new is kept while memory.json can't be read,
and a second broken file goes to memory.json.broken.2 (7251821, 6f45589; -r7-1, -r7-2); and the guard refuses recovery
and one-time codes with no "is", "wifi pass …", a value after an aside or "min.", a "Key:" under its network's name, a
UK sort code with its account number, a National Insurance number and a mother's maiden name (1b4e090, d5b0d15; -r7-5,
-q6-4, -q6-5, -c7-3, -x7-2, and -x7-3 partly), with -r7-3 and -r7-4 fixed in e08cde8 and e128ba3. Integrations: an edit
of the provider in use to an address that answers 404, 405 or 501, or 200 with no model list, saves nothing until a
third button, "Use it as typed", and the working provider keeps its key until then (48208e9; integrations-c5-1, -c7-1);
a model list is read as an array under `data` or `models`, a bare array, models keyed by id or an array of models under
another name (5c17e3f; -x7-1), and the button goes when the address, type, Azure API version or key changes (40b955e;
-x7-2); Projects says the organisation turned it off (9ac22e1; -r7-1); a 404 from the user's own provider that names no
model says the address may be wrong, and one that names the model in a service's own wording says it is the model
(e7e91cf, 50c1013; -r7-2, -x7-3); and a refused project command says which of four reasons holds (7e0a330; -i6, partly),
with -r7-3 in f918a70. Safety (lane R): `goesSomewhere` covers only a browser's own address bar, GNOME Web's, Falkon's,
Arc's and their like included but not SeaMonkey's, and a one-line search box whose name holds no risky or acting word
and that isn't on a payment page (2578aa6, 0e5ffd9; safety-privacy-c7-1, -x7-3); 43 more labels ask every time, and on
Linux "Move to Wastebasket", "Rubbish Bin" and "Bin", English only (c9c91d8; -r7-1); a button with no letter or digit in
its name is judged by the named form, panel or group it sits in, never by a row, cell, link or heading named by its
content, and in a page one with no name asks as Ember's doubt, the worker now setting `onPage` for clicks and toggles
(300d783, 804c1fc; -c7-2, -x7-5 to -x7-7); the payment-page rule of 2026-11-01 read `inPage`, which the worker sets only
for keys and typed text, so it had never fired for a real click, and now does (d2b12cb); card-detail, cardholder and
pass-phrase fields are never typed into, in TypeScript and the sidecar's list (ff3bfeb; -r7-2, partly); SendGrid,
DigitalOcean and Twilio keys, a Docker config's auth and a .netrc entry with a login or a dotted host are hidden
(019af17, 4415b0d; -r7-3, partly, -x7-2); and under a lockdown Sign in starts nothing at GitHub, a held one telling a
message sent from Home to restart Ember (370170d; -c7-3), with -r7-4 in 7019d61. Tasks and approvals: a step sent in the
same reply as one that was turned down, unanswered, refused or failed does nothing in the app and asks nothing, and the
reply's finish_task is held back, on the runtime's `toolRequests` and a count taken as each call is queued (6c30cb5;
tasks-approvals-c7-1: 0 clicks after the no, where there was 1); a declined or refused step shows on its own row by the
runtime's call id (6b66344; -c5-1, which round five recorded as fixed and which was still open with two calls in one
reply); the card's live line names the step at work (31bff66; -r7-1); and a refused progress note, read or card view
holds nothing back (9fd91b6; -x7-2). Listening (lane S): the composer's line is "Thinking… The reply will appear
above.", the button is "Teach my voice" with a name-free description, and three more lines lose the name; read by the
test-only Ryan voice into an idle wake microphone on the real models, without a speakers' stream, all eight new lines
woke Ember in 0 of 20 placements, against 18 of 20 for the old Teach button with its description and 20 of 20 for the
“Hey Ember” switch (49e4edf, 6d1ede3; voice-listening-r6-1, -q6-1, -r6-2's Teach half, -r6-3, -c7-1); Teach is refused
while the microphone isn't working, the line staying until Ember listens again and said at each press, and a microphone
lost mid-teaching ends it at once (dd16031, f70815d; -r7-1, -x7-2); "Request heard." is said once, after a spoken answer
too (3701330, 5e2378a; -r6-4, -x7-1); and focus goes to Listen once as listening starts (d5e3b11; -r7-2). Home: the
Features line says what is in force under policy, a lockdown, missing models or a microphone error, and "Checking…"
until the first status, with Try again after five failed tries (198ff18, f1005ba; home-r6-1, -r7-2); an edited send puts
the set-aside draft back, and Edit chosen during an earlier send keeps its Cancel edit (a20ee60; -c5-1, -c7-2); offline
while signed in says Copilot can't be reached, and an unverifiable certificate points to Models & connections (dcc3a11,
ac82f15; -r7-1, -x7-2); a held lockdown offers Restart Ember through a sender-checked `ember:restart` that acts only
while `admin.held` (6abd645, b58f215; -r7-3, -r6-2); and the narrow section row keeps the open pane's link in view, 0 px
outside where it was 788 px at 500 px wide (6bfe02f, 1fdea2a; -c7-1, -x7-1). First run: Start says “Setup is finished.”
and lands on Home's status line, the last step is “Ready to start” with a “Start” button, and 3 spoken lines that named
Ember are 0 (07d8d2a; first-run-r6-1, not replayed through audio); the provider check fails on a model name the service
doesn't list and names what it lists, only on a list read whole (at most 50 ids, never Azure, never one that says more
follows) and never for a name the service takes but lists differently (773d94f, c737097, f456a59; -c7-1, -x7-1, -x7-2);
and -r7-3, -r7-2 and -c7-3 are fixed in 471ae4b, b53fb39 and 7192d50. Speaking (lane T): "Read it out", "say that
again", "repeat that" and "tell me again" say the last thing Ember said once, a finished task's result included, change
no setting, write nothing to the conversation and never speak over a question, Home's composer saying "Reading the last
answer out." (ddb1c8a, 22bf581; voice-speaking-r6-1, -c7-2 partly, -x7-2 to -x7-4); ties between Latin-script languages
are broken by the request's language, then letters only one of them writes, so of 15 Spanish sample replies 0 go to a
French voice where 5 did (0b9ed19; -c7-1), and Italian samples go from 6 of 10 to 10 of 10 and German from 3 of 7 to 5
of 7 (3e07545; -r7-1, partly); a second Hear Ember with no working voice answers in 3 to 8 s, not 12 (76e2e88; -r6-2);
an English answer's closing question after a passage in another language is said in Ember's voice (cb1a77e; -c7-3); and
paths through dot folders, task boxes, inline tags, footnote marks and common entities are said sensibly (0e07c6c,
c88d505; -r7-2 and -r7-3, partly, -x7-5). Accessibility: the "Risky step" tag takes `--on-accent` on `--yellow`,
measured in Chrome at 5.85:1 in light, 7.57:1 in light with Increase Contrast and 13.04:1 in dark, where it was 2.88:1
and 2.22:1 (6204630; accessibility-r7-1), and one `::placeholder` rule gives Home's 15 placeholders 4.82:1 to 5.58:1 in
dark and at least 4.89:1 in light (b3156b6; -r7-2, -r7-3). Reliability, install and docs: the README asks for about 900
MB idle and listening and about 1.1 GB on WebAssembly, and docs/DEVELOPING.md records the Copilot runtime, 97 to 105 MB,
which footprint.mjs leaves out, so the sums are 792–890 MB on the C API and 1,039–1,052 MB on WebAssembly (009b5f6;
reliability-r7-1, -c7-1; the footprint budget was not run again); STATUS.md's days, a wholly unreadable settings.json,
the marketplaces warning, "Connected again" under Send only after a refusal for want of a connection, a conversation the
runtime couldn't save on a full disk, the gate's kill-switch deadline step (a line added to CLAUDE.md), `node
eval/run.mjs --help` and three test switches are fixed in d130452, a3883af, 335f640, 0d7244e with c5a8ce8, fa8c168 with
d88aee2, 456a335, c1ddece and 8f7efe7 (reliability-r7-2 to -r7-4, the last partly, -c7-2, -c7-3, -x7-1, -x7-2,
install-docs-r7-1, -c7-1, -c7-2).

**Reviews, repairs and reverts.** The first reviewers found 45 problems in the fixes (8 P1, 15 P2, 22 P3) and the second
37 in the repairs (5 P1, 12 P2, 20 P3). All eight first P1s were commands' and all were repaired: seen input unjudged
again with `-x`, `-s` or `-E`, and with `-i` beside `-L` (5b340bf: of 74,488 generated xargs forms none decides less
safely than main); `wget -xnH` and `git clone URL ./sub/"$d"` losing main's mark (1eb93ba); a `${HOME:?}` word inside an
`if` (8b3e1f6); compressor counts and `time x=1 sh -c …` (337ce77, 576097a); and three ways the written-out loop judged
another word than the one zsh or bash runs (c9e0267). The second reviews found five more P1s. In commands' first
package, `if ! …` with a word Ember can't see ran where main asked for more than the `if`, 785 commands in the
comparison; ee0b7aa makes any `if` with a `!` on a command keep the `if`'s own words and ask, as main did, and closed
four smaller gaps (`wget -x` with the default port written, more than 32 lines to `xargs -I`, psql's backslash commands
past comments and dollar quotes, and `psql -Atc` or `mysql -Ne` clusters); nothing was reverted there. In the loops
package the unrolled reading, which judged a short `for` over written-out words pass by pass, dropped a redirection in
front of a body's first command (`for f in a; do >~/.bashrc echo $f; done` wrote over ~/.bashrc with no question), let
the list's word supply printf's `-v` and missed `BASH_ALIASES='…'` with no subscript (the loops package's -y7-1 to
-y7-3); ce86a03 reverted it with the three repairs built on it and the suite that ran it (63f6ff1's loop half, c9e0267,
6e3ea54, 7a88e1b), so every `for`, `while` and `until` on a command line asks again, as on main, and
commands-remote-r6-2's loop half is open again. In memory, the repair that learnt a forgotten fact said again on purpose
compared one name from each side, so a fact forgotten seconds after it was said came back whenever the two models named
its subject differently (memory-y7-1, P1): 9629391 reverted 8e2c6a5 whole, reopening memory-x7-5 (P3). ebe966e reverted
8b0848b whole, because `args.push("--password", "hunter2")` and tuples were no longer hidden (-y7-2), reopening
memory-x7-1 (P2): Projects refuses a source file that only declares an option named like a secret, and command output
hides `["--token", "none"]`. 3291ae0 put back two patterns of d5b0d15, the "Key:" line under a network and the National
Insurance number, the latter with only a case-insensitive flag added (-y7-3, -y7-4), reopening those parts of
memory-x7-3: "Network: eth0" then "Key: value3" and "NI flight BA 12 34 56 A" are refused again. In safety, three
repairs had narrowed more than their finding asked: 881bf97 reverted 7553c6c ("Sell BTC", "Reserve table" and "Purge
cache" went unasked; safety-privacy-y7-1), a2ed6cb reverted 990bbd6 ("Amazon.com Checkout", "PayPal Checkout" and "Make
a payment - Barclays" were no longer payment pages on a real click; -y7-2) and a1a9d38 reverted 66643a3 ("Turn off
anyway" and "Disable Secure Boot" went unasked in a protection's window; -y7-3). They reopen safety-privacy-x7-1, -x7-4
and -x7-8 whole and "Search email" of -x7-3: a headline link "Reserve Bank raises interest rates again", a tab "Email"
or a menu's "Allow Editing" asks every time as something the user didn't ask for and puts the task back to asking; every
control in a page whose title only mentions a payment asks, with no reason given; and "Disable Line Numbers" asks in a
window titled "Security review notes.txt". In tasks, the repair that let a command that only exited non-zero hold
nothing back also counted a Ctrl+C typed in the command window, or a signal, as running to its end
(tasks-approvals-y7-1); b8d770d reverted that exemption, so behind a routine `grep -q` that finds nothing the commands
sent with it are dropped again and the model must send them again (-x7-1's command half). In speaking, the repair that
kept a French or Chinese answer's own sentence in its voice gated Ember's voice on how the answer opened, so after
"Sure." the closing "Shall I reply to it?" went to the passage's Spanish voice for 16 of 19 openers
(voice-speaking-y7-1); 2adce35 reverted that gate and kept the narrowing that can only keep more in the answer's voice,
so "Er heißt Gone with the Wind.", with none of German's short words, goes to Ember's English-only voice again (-x7-1,
partly). Integrations, listening, Home, first run, accessibility and reliability had only P3s at their second review and
no last step.

**Commands held to main.** Round six's record that only two kinds of command decided more loosely than main (4d64d3a)
was untrue. At 6b750a2 the same comparison found 245 commands decided less safely outside job counts: 120 were a plain
`if`, the departure round six recorded, and the rest printed text piped into database clients and xargs, job options
with no count, `${VAR:?}` in a test and `time` before an assignment. This round held every package to the comparison,
run before each commit with every probe the reviews gathered added to its corpus. On the merged tree it ran 73,654 cases
(main's 3,784-case corpus, 27,899 generated and 41,971 gathered from the reviews) through the classifier and the
run_command flow: 0 commands decide less safely than main outside the allowed kinds, and main's own corpus is 0 looser
and 3 stricter. The allowed kinds are now three: a job count written as a number, a processor count's substitution or
arithmetic of numbers; a plain `if` with no `!`, which sets no variable, changes no folder and holds no command Ember
has anything to say about; and a simple `[[ … ]]` test, each such line proved against main's decision for its `[ … ]`
form (2,730 lines in lane P's last run). The comparison's cross-check on the merged tree listed five compressor commands
(`xz -T $(nproc)`, `pigz -p $(nproc)` and the like with nothing else to pack) that ran where main asks even with a plain
number, and b31482a judges the word after the option as a file again. Stricter than main on purpose: `curl -O "$URL"`,
`wget $URL`, `xargs curl -O` and `http -d` ask at the download; every sqlite3 dot-command off the show-only list and
psql backslash commands outside the describe list ask; "on <something>" after a file's name in the user's words asks
unless it is this computer; `if IFS= read -r l <<< 'a'; then …` asks again, which earlier rounds had made run
(commands-remote-c1-1, -a7-2); and a literal `xz -T 4 big.tar` says it replaces "4 and big.tar", as on main.

**Merges.** Lanes P, Q, R, S and T merged in that order (2ec644c, 3293625, 79db07f, c5bfa4b, de41582). Three conflicts
were resolved by hand: docs/MEMORY.md, where both lanes' guard words were kept; app/main/agent/composer-refusal.ts,
where two lanes had fixed the held lockdown's refusal and one wording was kept ("Your organisation changed Ember's
policy while Ember was running. Restart Ember, then send again."); and app/main/provider.ts, where the check for a 200
that isn't a model list was kept together with the flag for a list that goes on. Lane T's merge also needed the imports
of app/renderer/home/main.ts and ui-copy.test.ts put together. After the merge two lanes had quietened the same
marketplaces warning and the unit suite failed on the second's test, so 54597f1 says once why the list logs nothing
before Ember is connected; b31482a followed.

**Consent and departures.** No consent text or version changed: app/shared/consent.ts is untouched since 6b750a2
(`CONSENT_VERSION` 7, `FEATURE_CONSENT_VERSION` as it was), and every package says nothing more is read, sent or kept.
No departure from §2. Recorded here because they change what a rule says: against main a third kind of command, the
simple `[[ … ]]` test, decides more loosely, and the plain `if` is narrowed to one with no `!` (§2 "Commands");
`goesSomewhere` no longer covers a page's own address, URL or location field (the 2026-11-05 widening, narrowed); a
page's unnamed button asks as Ember's doubt, which Work without asking may announce, a new plain source that is not a
fail-closed allow-list, though the click was unasked before; first run's last step is “Ready to start” and its button
“Start”, since a title or a button that takes focus while Ember listens can't hold the name (docs/DESIGN.md); "Read it
out" is answered for anyone heard, like "status?"; and CLAUDE.md gained the gate's kill-switch deadline step and the
narrower Work without asking wording. `.claude/rules/agent-and-policy.md` still says only job counts and a plain `if`
decide more loosely than main.

**Left.** Reopened by the reverts: every loop on a command line asks, however plain (commands-remote-r6-2's loop half,
by choice: the rule file says not to add the unrolled reading back); memory-x7-1 (P2), -x7-5 and two parts of -x7-3;
safety-privacy-x7-1, -x7-4, -x7-8 and "Search email" under Work without asking; tasks-approvals-x7-1's command half; and
voice-speaking-x7-1 for a sentence with none of its language's short words. Second-review P3s not fixed: Ember's own
file on line 33 or later of `xargs -I` input is asked about, not refused (commands' -y7-3, partly); a place said as a
describing word still announces ("delete the frontend build folder"; -y7-6, with 61 of the first review's 273 wordings
for `rm -rf build`); httpie's `--ou a.sh` isn't marked (-y7-7); "Runs a file downloaded in this task." comes back as a
fact when the same line reads a named download (the loops package's -y7-4); this round's guard patterns keep "Password,
new, 1234-5678", "wifi key 1234-5678" and "recovery code abcde-2019" (memory-y7-5); a held edit's line names “Use it as
typed” with no such button when the type or key changed during the check, a check that passes still adopts a type and
key changed while it ran, the button outlives the line that describes it, `modelList` takes an error body with a details
array for a model list, and any 404 holding "model: x" loses the address (integrations-y7-1 to -y7-5); an unnamed button
in a row, cell, link or heading named "Delete" is no longer judged by it, and a .netrc entry with a one-word host and no
login, or `default password …`, is in clear (safety-privacy-y7-4, -y7-5); Listen once's line is said again when a
listening window closed while an answer was open (voice-listening-y7-1); a settings push snaps a narrow section row back
until the targets list has answered (home-y7-1); one file-like id in a model list switches first run's check off
(first-run-y7-1); a tag on its own line, a footnote mark after a bold word, and "Read it out" reading a task's result
that finished since the answer (voice-speaking-y7-2 to -y7-4); two test pins that still pass a literal colour
(accessibility-y7-1); and a model service's own "no space left on device" behind a bare status code, and "Operation not
permitted (os error 1)", worded as a full disk (reliability-y7-1, -y7-2). Partly fixed or skipped in the packages: the
hold-backs "before Friday" and "before the release" still announce (commands-remote-i5b, -i6b), and the 140 phrasings of
round five's words review weren't run again (-c3-1); `awk 'NR>1' data.csv` asks and `Test-Path $env:LOCALAPPDATA\ember`
is refused, both as on main (-r6-3, -r6-5); the project's own tools still ask after a download Ember can't name (-r6-4);
duckdb's `export database`, `sqlite3 a.db ';.sh id'`, `mysql --defaults-file`, text attached to a cluster (`psql
-Atc'…'`), a fetched variable set in a function and `curl -o"$f"` run as on main; PowerShell and cmd got none of the
address-name or printed-input work; an option carried by a variable (`x=--hard; git reset $x`) and `git reset --har`
run, as on main; over-refused network notes and sign-up forms (memory-q6-2, -q6-3), whose fix loosens the guard, and
memory-q6-6; "The Wi-Fi is BlueSky99" and "The gym's code is 4821" (memory-1); four over-refusals such as "Recovery code
generator-v2 is installed"; the generic "Project work is unavailable right now." for no consent, a locked screen and a
window out of view (integrations-i6); "Token", a bare "Expiry" and "Passkey" fields, a .netrc password on a line of its
own, and the new always-ask words in English only (safety-privacy-r7-2, -r7-3, -r7-1); the bubble's progress words still
name the last call begun in a reply; the Ask field's label (voice-listening-r6-2's other half, not reproduced: 0 of 60)
and "Teach your voice", which can still read as training the person's own voice (-z6-1); Home's Try again still moves
focus to the bare "Ember" heading; first-run-r7-1, -c7-2 and -c7-4; "just show me" as an answer to Ember's own question,
Portuguese at 3 of 10 and Dutch at 3 of 5, a reply dropped where no voice is installed for its language, a Windows path
with a space and "$…$" maths (voice-speaking-c7-2, -r7-1, -c7-1, -r7-2, -r7-3); a level-one heading for each pane and
landmarks in the small windows (accessibility-r7-4); the data-folder start-up error logged twice (reliability-r7-4);
`ember --version` (install-docs-r7-2); and about 29 test switches missing from docs/DEVELOPING.md. No package reached
the companion's six P3s (companion-r7-1, -r7-2, -c7-1 to -c7-4) or the items earlier rounds left: companion-r5-1 at
1024×768 Larger, accessibility-visual-c4-1, -r5-1 and -c5-1, first-run-r5-1 and -c5-1, rp-1, rp-4,
reliability-performance-c1-1 and -r2-2, safety-privacy-3 and the held lockdown's two switches. Nothing in the repository
says what integrations-r5-1 and -r5-2, tasks-approvals-c5-2 or voice-speaking-r5-1, -r5-2, -c5-1 and -c5-2 were, so they
can't be judged. Owner decisions: whether to loosen the guard for memory-q6-2 and -q6-3; whether a page's link is judged
as content on a real click (the 2026-11-05 rule reads `inPage`, which a click never sets, so "Report: inflation falls"
asks; making it live loosens); whether a page's unnamed button should ask every time instead of as doubt; whether a
model typed since the check should withdraw “Use it as typed”; the line added to CLAUDE.md's gate; and those of earlier
rounds, which stand. Still to check natively: real screen readers for every line said without the name (the counts come
from a stand-in voice, with no speakers' stream) and first run's Start through audio; sqlite3, duckdb, psql and mysql
against the binaries; a real browser for unnamed buttons and payment pages; the sidecar's field list on platform-python
3.6; a live Ember for Restart Ember, Sign in under a lockdown, "Read it out" and the second Hear Ember; a really full
disk; the resting cost with the runtime on the RHEL 8 target; and Windows, macOS, WSL and SSH, where none of this round
ran.

### Product audit fixes, eighth round (2026-11-11 to 2026-11-12)

After round seven each area was rated again at 23b22a5 (merged as 848a566). Scores (re-rater, then challenger):
commands, WSL and SSH 7.8 and 7.0; safety and privacy 8.4 and 8.2; memory 8.7 and 8.3; models, providers, extensions and
projects 9.1 and 8.7; accessibility and copy 9.1 and 8.8; reliability and platform 8.8 and 8.8; listening 9.0 and 9.0;
speaking 9.0 and 9.0; Home 9.1 and 9.0; tasks and approvals 9.2 and 9.0; first run and setup 9.2 and 9.1; the companion
and Ask 9.2 and 9.1; install, docs and developer experience 9.3 and 9.2. Counting each re-rater's new finding (-r8-N)
and each challenger's miss (-c8-N) once, at its finder's severity, they found 63 new items: 5 P1, 6 P2 and 52 P3. The
challengers raised integrations-r8-1 to P2 and refuted first-run-r8-2 (by design); the re-raters listed
safety-privacy-x7-1, -x7-4 and commands-remote-y7-6 at P2, and memory's challenger put memory-x7-1 back at P2. The P1s
were all commands': a clone entered with `cd x;`, runners and fetch tools Ember didn't know (`java -jar`, svn), a
variable naming a build tool's program and deleters with no row (`rimraf ~`) let downloaded code or a deletion run
unasked, and `docker run` ran any image with the project mounted (commands-remote-r8-1, -r8-2, -c8-1, -c8-2, -c8-3). The
P2s were safety-privacy-r8-1 and -c8-1, memory-r8-1 and -c8-1, accessibility-c8-1 and reliability-r8-1 (below).

Six areas scored under 9 from either rater. Four lanes, one package after another in its own worktree, two agents at a
time: P (commands: download and run, then deletion), R (safety and privacy), Q (memory) and T (reliability,
accessibility, then integrations). Each package: a fix with a test seen failing first, an adversarial reviewer (-x8-N),
a repair, a second reviewer (-y8-N; reliability, whose reviewer found nothing, had neither), and, where that review had
a P1 or P2 (both commands packages and safety), a last step told to fix or revert what the round's commits caused and
design nothing new. Both commands packages have a -y8-1 to -y8-5, so the package is named with them. The fix agents
reported 30 items: 15 fixed, 7 partly, 6 skipped and 2 owner decisions. The round is 66 commits: 24 fixes, 31 repairs, 6
from the last step, 4 merges and 1 after them.

**What the packages did.** Commands, download and run (lane P, M12): once the task holds any download, a build tool,
test runner or `python3 -m` in a folder Ember can't name asks "May run a file downloaded in this task", so `cd x;` no
longer hides a clone (346df5e; commands-remote-r8-1); java, mono, wine, `node x` and `awk -f` given a download, and `go
run .` over downloaded sources, ask, a compiler or a decompressor passes the mark on, and svn, hg, rclone and `pip
download -d` mark where they land (262eede, 5c74613; -r8-2, partly); and a compiler or pager variable holding a command,
`GOFLAGS=-toolexec=`, `TAR_OPTIONS=--to-command=` and npm's script shell ask, while `CC=clang`, a connection string,
prose and `RUSTFLAGS='-C linker=clang'` run (79a3ba8, c883249, aaa39c6, 12493dd; -c8-1, partly). Commands, deletion:
rimraf, del-cli, grm, scrub, gvfs-rm, trash-rm, fdupes `-d` and git-filter-repo take rm's row (`rimraf ~` is refused),
their patterns are judged as patterns, and a brace group that, read as a shell reads it, stands for Ember's or the home
folder is refused; a program with no row given the home folder, one holding it or Ember's files asks (`mytool ~`), while
`cd build && qmake ..` runs (d2289b7, 789e9de, 8a05cd0, fdc69b0; -c8-2); an announced deletion asks when the words
describe another folder ("the production build folder"), give a deadline, a day or a recurrence or ask for a copy first,
while "before npm install" still announces (85bf5b5, 36dcda6, 4d0cfe8; -y7-6, partly); and curl's `-K`, wget's
`--config` and ftp-type clients' sessions count as a download of no name unless they only send (c52ab47, 9c4ab46; -r8-3,
partly). Safety (lane R): a control that goes past a warning or turns a protection off ("Enable Macros", "Keep anyway")
asks every time, never with "Always" or announced, saying so (db44f4c; safety-privacy-r8-1), though "Go to page 2" and
"Disable spell check" don't (4467c9b); in a dialog asking a question in at most 300 characters, or a message box read as
an alert (Linux's: Windows' #32770 boxes and a Mac's dialogs count only by their words), a button that doesn't back off
asks every time, quoting the dialog ("Leave page", "Resend" on every OS, "No" to saving changes), while Cancel, Stay and
"Remind Me Later" don't (db44f4c, 0a4cbb9, de87af0; -c8-1); a click in a window whose title mentions a payment says why
(80c52d0; -x7-4, partly: which titles count is unchanged); a link, tab or menu item asked about only for a word round
seven added (a headline "Reserve Bank…", a tab "Email") still asks every time but without "You didn't ask for this" or
putting the task back to asking, while "Make admin" and "Allow notifications" keep both (6a89c65, 246315e, c84bed8;
-x7-1, partly); and under Work without asking, Enter in a search box that also types a message or picks people, or in a
window for sending money or sharing, asks (54c4e93, cab92d5; -r8-3). Memory (lane Q): a Forget, a correction or Forget
everything drops everything said before it and not yet read, by a mark taken as each request is asked rather than only
by likeness of words (round seven's rule stays as a second layer), and any unmarked turn or task result within two
minutes: 0 of 14 reworded tests and 0 of 12 of the re-rater's probes bring the fact back, where 14 and 7 did (f483169,
dd5fa32; memory-r8-1, -r8-3), and a task the conversation started carries its request's mark (df76607; -x8-4, partly);
what the remember tool keeps is kept once (0 of 11 doubled, where 11 were), the turn's other facts, and the next turn's
after one cut short, still learned (7eccb5b, 1c7814d, 753ee2c, cd856ab; -c8-1, -x8-1, -x8-2); and round seven's list
pattern lets `--no-password`, `none` and click's `"--api-key", "api_key"` through (cae3a73; -x7-1, partly). Reliability
(lane T): Ember stops printing to a stream at its first failed write; piped to `head -1` it used 0.1 % of a core, not
98.3 %, and SIGTERM ended it within 1 s (9ab442b; reliability-r8-1). Accessibility: the corner card says each new
question, one in the last one's words too, and what is put back after “Listening…” once (f7535b7, 52529d1, a43cd3b;
accessibility-c8-1, -x8-1); it says a task's end in a region of its own with Home closed, held while the microphone or
Listen once is open (f0c2ec3, b630dc6, b09c405; -c8-2, -x8-2, -x8-3); and where commands run as root or an
administrator, “Ask me before every command” shows on and locked, with a note saying why (ec843db, 4db8c24; -c8-3,
-x8-4). Integrations: a model server here that answered without a model list reads "Using <host>. It answered, but
without a model list: …", and “Using your own provider” in first run (a6c2332, 8581e20; integrations-r8-1, -x8-2); a
first "I agree" in Home makes Test connection's one GET and says what it found, unless a refused edit's reason holds the
line (162f58d, cc01414; -r8-2, -x8-1); and with no model named, the status line points to “Conversation model” below
(93eb236, f842a65; -r8-3, -x8-3).

**Reviews, repairs and reverts.** The first reviewers found 31 problems (4 P1, 10 P2, 17 P3); reliability's found none.
The P1s were commands' and all were repaired: an rclone upload with its remote in a value option (commands-remote-x8-1;
618287e), a project runner running a download (-x8-2; fa0854b) and `fdupes -o ~/.bashrc .` (-x8-5; be9e0c3) ran, and
"before you build, delete the build folder" announced `rm -rf build`, already at 848a566, where 4d64d3a asked (-x8-6;
36dcda6). The P2s were repaired, two only partly (commands-remote-x8-4, safety-privacy-x8-1); by the round's end two
more were only partly fixed: commands-remote-x8-8, which the second review found incomplete, and safety-privacy-x8-2,
which the last step reverted in part (below). The second reviewers found 25 (2 P1, 6 P2, 17 P3). In the download
package, 262eede's slice of the marks the runner check reads hid those a runner's own redirection makes, so `curl -s URL
| make x > x` ran after a download (its -y8-1, P1), as did 134 lines that asked on 848a566, 88 of which ran on 4d64d3a
(-y8-3); with nothing downloaded first they already ran on 848a566 (-y8-2, P1); and tar's own options ran a program held
in a variable (-y8-4) and an rclone upload ran with an option rclone's table lacks after the destination (-y8-5), both
as on 4d64d3a. In the deletion package, a rimraf pattern its matcher reads unlike the shell only asked (its -y8-1) and
`-WGLOBAL` passed for smbclient's `-L` (-y8-2). In safety, a page's dialog read in part was judged by its title alone,
so "Leave" under "Are you sure you want to leave?" went unasked (safety-privacy-y8-1).

The last step departed from its instruction. 2603fc7 narrowed 262eede's slice instead of reverting it, since `pip
download -d build x` would ask without it (reasoned, not measured): a runner's own redirection marks count again, and
the "anything downloaded?" gate reads them, in 4d64d3a's order (the download package's -y8-1 to -y8-3; 134 lines looser
than 848a566 to 0). 78cc62c (a tar word Ember can't see whole read by its text, GNU's `-F` as `--info-script`; -y8-4)
and 58397c7 (an rclone copy with more words than it takes asks; -y8-5) tighten holes older than the round, which it
wasn't asked to do. a7ceed3 kept 8a05cd0 and fdc69b0, since reverting them would turn the refusals of `rimraf '{..,x}'`,
`'+(..)'` and `"{$HOME,x}"` back into questions, and corrected the docs' claim instead: braces are read as a shell reads
them, and a pattern rimraf reads otherwise asks (its -y8-1 and commands-remote-x8-8, partly); a96755f reverted only
9c4ab46's `smbclient -L` line (-y8-2). 54de771 reverted 1003b91's `: !!r.dialog.page` fallback, so a dialog read in part
is judged by its words again (safety-privacy-y8-1), reopening safety-privacy-x8-2 there and carrying -x8-5 and -x8-7 to
page dialogs ("Resubmit", "No" to VS Code's save). No last-step commit was reviewed again.

**Commands held to main.** On the merged tree, against 4d64d3a: 101,165 cases (main's 3,784-case corpus, 27,899
generated and 69,482 gathered from round seven's and round eight's reviews and raters), then 7,976 more probes from
round eight's reviews and last step, each through the classifier and the run_command flow: 0 commands decide less safely
outside the allowed kinds (main's corpus: 0); allowed lines: plain `if` 1,067, `[[ … ]]` test 2,750, job count 622;
15,092 commands are stricter (main's corpus 4). Against 848a566 (main after round seven, the harness's new CMP_BASE
switch): 101,228 cases and 7,962 extra probes: 0 commands decide less safely at all, allowed kinds included; 10,426 and
305 are stricter, 1 of them in main's corpus: `pip download -d build x && sh build/run.sh` now asks
(escape.run-downloaded), on purpose. The stricter set is almost all reviewers' probes; by rule: unclear.broad-folder
2,303 (`tokei "$HOME"`, `restic backup ../..`), escape.run-downloaded 1,747, posix.rm 1,625 (rimraf and its like),
unclear.assignment 1,474, a deletion whose words describe its folder going from announced to asking 606 ("delete the
useless build folder": commands-remote-x8-10, P3, left) and git.history 370. Of 40 ordinary development commands run
through both trees by hand, one changed: `rimraf dist` after "delete the dist folder" is announced where it ran. Round
seven's 0 held only for the cases it ran: the forms 848a566 already decided less safely than 4d64d3a, which its corpus
lacked (commands-remote-x8-6 and the download package's -y8-2), ask again.

**Safety and memory held to main.** Lane R's proof ran 838,392 steps per tree: nothing weaker than at 6b750a2 or 848a566
at the fix (6b750a2, 848a566, 54c4e93), than 848a566 after the repairs (848a566, 54c4e93, c84bed8) or than c84bed8 in
the last step. At the fix, 162,748 steps (1,344 labels, links, tabs and menu items only) lost the off-task flag with
unchanged verdicts, steps 6b750a2 neither flagged nor asked about for a risk; no button lost one; the repairs gave
81,544 back and left 81,204 dropped (links, tabs and menu items that only start with a committing word), and the last
step changed no flag. Run again on the merged tree (7c19075) against 6b750a2 and 848a566, the proof holds: no step is
weaker than at either, round seven's y7-1 steps (22,680) and y7-2 payment-title steps (266,944) all ask every time, the
same 81,204 steps lose the flag, and 5,918 steps that 848a566 announced under Work without asking ask now. Lane Q's
proof ran 20,888 files, 19,608 whole files and 3,342,271 lines through memoryRefusal and redactSecrets at 6b750a2,
848a566 and the lane: 0 of 9,124 held units lost their hold, and every memory-q6-1 and -y7-2 shape is still refused and
hidden; it ran before a last tightening in cae3a73, which only hides more.

**Merges.** Lanes P, R, Q and T merged in that order (13ae4fb, 3ffdbe7, 8c57779, 7f4e0b7) with no conflict: the only
files two lanes both touched were docs/COMMANDS-WSL-SSH.md, .claude/rules/agent-and-policy.md, docs/DEVELOPING.md,
app/main/agent/host.ts and app/main/main.ts, in different hunks. 7c19075 then corrected a comment and a test title that
called the logger's throw path a full disk's: reliability's reviewer found a full disk reports ENOSPC and never throws.

**Consent and departures.** No consent text or version changed: consent.ts is untouched since 848a566 (`CONSENT_VERSION`
7), welcome-copy.ts changed only the sign-in step's “Connected to” or “Using” (8581e20), and nothing more is read, sent
or kept (the GET after a first agree in Home goes only to the host just agreed). No departure from §2, though §2's
"Approvals" list of risky steps doesn't yet name the two classes db44f4c added to CLAUDE.md's (a follow-up). Recorded
because they change what a rule says: CLAUDE.md's risky actions now include going past a security warning and answering
a dialog's question (on Linux, any message box) other than by backing off; a dialog is judged by its title alone only where a whole
read shows a field in it (54de771); links, tabs and menu items that only start with a committing word ask without the
off-task flag; the search box's window test is an English phrase list (`PICKS_WHO`); once a task holds any download,
build tools in a folder Ember can't name ask, so `cd src; npm test` asks after an unrelated download;
commands-remote-c8-2's arm for a folder above the task's was dropped, since Ember has no fixed project root (789e9de); a
rimraf pattern of more than 64 words, or with an unclosed `{` and a comma, is refused (`rimraf 'weird{,name'` too); and
a Forget drops by mark, so Ember learns less: the other facts of a dropped turn come back only when said again.

**Left.** Round eight makes round seven's record untrue in places: the headline, tab "Email" and "Allow Editing" of its
revert paragraph no longer say "You didn't ask for this" or put the task back to asking, and a payment-titled page's
question gives its reason, so safety-privacy-x7-1 and -x7-4, reopened whole in its Left, are partly fixed, as are
memory-x7-1 and commands-remote-y7-6; and its memory-c7-1 fix held only where the extraction worded the fact as the
forgotten one was (memory-r8-1; its tests used only the remember tool's words, -r8-3). Reopened by the last step:
safety-privacy-x8-2 for dialogs read in part (a compose window whose body asks something asks at every button);
`smbclient -L` marks a download again (commands-remote-x8-11's half). Found still open by the second review: rimraf
patterns its matcher reads otherwise ask instead of being refused (-x8-8, partly; a7ceed3 corrected the docs' claim).
Second-review P3s not fixed: the download package's -y8-6 to -y8-10 (`export GOFLAGS=…` and `FOO='exec rm -rf ~' make`
run, as on main; an rclone option's date is taken for a remote; `poetry run python -m pip wheel . -w dist`, `go run .
--exec ./scripts/x.sh` and `TAR_OPTIONS='--checkpoint=100'` ask); the deletion package's -y8-3 to -y8-5 (`mytool
--no-prefix ~` runs; "before make install" holds a deletion back; `yarn scrub --` asks); safety-privacy-y8-2 to -y8-5
(Enter in search announced on "Pay bills", "Not now (not recommended)" past the warning check, "No" asking in "Close
without saving?", some headlines flagged again); memory-y8-1 to -y8-3 (part of a kept fact learned again); and
integrations-y8-1 and -y8-2 (a model name refused during the first agree's check drops its findings). First-review items
left: a whole option set in a variable (`GOFLAGS=$X go build`), `cargo rustc -- -C linker=…` and
`CARGO_TARGET_<triple>_LINKER=…` run, as on main (commands-remote-x8-4, partly); describing words outside the list and
day-like names (`delete monday.txt` asks; -x8-10); `lftp -e 'put …'` still marks (-x8-11); WGETRC and smbget mark
nothing, as on main (-x8-12); a fact the remember tool paraphrased is kept twice (memory-x8-3), and a task with no mark
(Try again) has only the two-minute rule (-x8-4); "Unblock", a lone "Skip" and "Reject all" ask every time
(safety-privacy-x8-1, -x8-6). Partly fixed or skipped: `npm pack` then tar and a downloaded `.npmrc`
(commands-remote-r8-2); `export CC=… && make` and PYTEST_PLUGINS, as on main (-c8-1); "on my laptop" and a relative
clause announce (-y7-6); inline code that fetches marks nothing (-r8-3); `echo status | xargs git` still asks (-r8-4,
skipped as a loosening); which titles count as a payment page (safety-privacy-x7-4), x7-1's extra question, which more
one-click words ("Join", "Follow", "Claim") ask (-r8-2, skipped for the owner to choose) and the address bar told from a
page field only by `inPage` (-r8-4, skipped); memory-r8-2 and -c8-2; and reliability-r8-2 (a full disk at start said as
no connection). The seven areas with no package keep their 33 new P3s (first-run-r8-1, -c8-1, -c8-2; home-r8-1 to -r8-4,
-c8-1 to -c8-3; companion-r8-1, -r8-2, -c8-1, -c8-2; voice-listening-r8-1, -c8-1, -c8-2; voice-speaking-r8-1 to -r8-4,
-c8-1 to -c8-3; tasks-approvals-r8-1, -c8-1 to -c8-3; install-docs-r8-1, -r8-2, -c8-1 to -c8-3), and accessibility-r8-1,
reliability-c8-1, integrations-c8-1, safety-privacy-x7-8 and round seven's Left stand (install-docs-c8-2's limit is
already pinned by release.test.ts; only an early check in the tag's run is left). Owner decisions: whether pulling and
running an image nobody named is download-and-run, and whether a container's command is judged against the folder
mounted in it (commands-remote-c8-3); whether a page's unnamed link is judged as its unnamed button is
(safety-privacy-r8-5; pinned unasked); whether to revert 8a05cd0 and fdc69b0 together after all; and earlier rounds',
which stand. Still to check natively: real browser and office dialogs and warning pages; rclone, smbclient and del-cli's
matcher (the second review ran GNU tar and rimraf's matcher); a real screen reader on the corner card, and Listen once's
hold with a microphone; the eval's memory-injected-screen-text (no GTK 3 here); the logger fix on Windows and macOS; and
Windows, macOS, WSL and SSH for the rest.

### Approval modes, spoken answers, first-run defaults and the vault (owner decisions of 2026-11-12)

Owner decisions, changing §2 "Approvals" and "Commands", §5's Confirm and Never rows and its commands paragraph, and
with them CLAUDE.md's "Policy decides, not the model", "Hearing and spoken answers", "Never", tier 3, "Consent" and
"Privacy" and `.claude/rules/agent-and-policy.md`'s "Approval modes", "Spoken answers" and the bullets beside them,
each written in place as it will be once built. The owner, on Home › Apps & privacy's three switches: "why I'm getting
option to enable all three and also these options doesn't really make sense. What we need is interactive, assisted and
… autopilot"; and on answering by voice: "it doesn't really need my voice to be matched for it … Until that, let's
keep the product experience to be simple and easy to use for a layman customer." (1) **Approval modes:** one choice of
Interactive (the default for everyone), Assisted and Autopilot replaces "Don't ask before working in an app I asked
for help with", "Ask only about dangerous commands" and "Work without asking"; §2 Approvals says what each does, keeps
and lifts. (2) **Spoken answers:** while a question is up, a yes or a no from anyone heard answers it, with no Voice
Match; never a yes over Ember's own voice or in it, never "Always", never on a click-only card. Voice Match becomes an
optional extra, off by default, which while on keeps its earlier rules, and setup says plainly that anyone near the
computer can answer Ember by voice. (3) **First-run defaults:** first run explains and turns on, each with its own
switch, commands on this computer, memory, “Hey Ember” with spoken replies, screenshots for tasks and Interactive,
under one agreement that shows each one's own card text; any can be turned off there or later in Settings, and nothing
is read, heard or sent before that agreement. (4) **The vault:** logins, cards and contact details asked once through
Ember's own Secure Form, kept write-only with `safeStorage`, bound to the app or site and filled without the model
seeing them; only Autopilot may use them in password, card and secret fields and sign-in windows. It keeps something
new, so it comes with a `CONSENT_VERSION` bump.

**Order.** They are being built in the PR that records them (from 2026-11-12), in this order: spoken answers and the
fixes for an Allow that did nothing first, then the modes, then first run's defaults, then the vault. Until each lands,
the code still does what the earlier rules said (§2 Approvals' history: Work without asking and Home's two narrower
switches, and a spoken yes only from a Voice Match-verified voice or the task's voice trust), and docs/DEVELOPING.md
("Work without asking", "Answering by voice", the voice settings and the administrators' table) describes what ships;
each step brings it up to date as it lands. Spoken answers, the modes, first run's defaults and the vault have landed
(the ninth round, below).

**Settled** (2026-11-12, by the integrator on the owner's direction; the owner can overrule). The owner asked for a
simple product a layman can use: in Autopilot "it should do everything without asking me", a spoken "allow", "deny" or
"okay, go with it" from anyone, and Assisted approving "any step matching my ask". So, written in place in §2, §5,
§6, CLAUDE.md and `.claude/rules/agent-and-policy.md`: (1) **Command cards:** a command card takes a spoken yes from
anyone heard, like any other question, while it shows whole and armed, never "Always", and with Voice Match on only
from the verified owner, as for every question; only consent cards stay click-only. (2) **Assisted's check** takes the
user's own words, spoken requests included (`voiceUnchecked` too), never a suggestion chip's and never words heard
over Ember's own voice. A step off the user's task and a task that screen text tried to steer, that went off-task or
where the user said no go to the check too (a command in a steered task to the reviewer), its untrusted quoting kept,
and after a "Not now" Ember still never retries or works around that step. (3) **Autopilot** never asks, except for
exactly these, each because it protects something Autopilot keeps: a command that would read or print secrets (so no
secret reaches the model), a command that would outlive the kill switch (so Stop stops everything), and whatever the
organisation's policy requires or the user's own "ask every command" for a computer asks. Everything else that would
ask is announced instead: off-task steps, a task where the user said no earlier (the refused step itself is never
retried), the extensions gate's questions, a remote's own gate 2 questions (the remote's own admin policy still
holds, as the organisation's), commands as root or an administrator, system changes and download-and-run. Tampering
with Ember's safety is still refused in every mode. (4) **System authentication prompts** (polkit and its agents, the
keyring and gcr's prompter, pinentry, ssh-askpass, sudo, Windows' and macOS's credential prompts) stay never in every
mode, Autopilot included: the vault fills only an app's or a site's own sign-in. (5) **Switching modes by voice:** to
a mode that asks less, from anyone heard (only the verified owner while Voice Match is on), never over or in Ember's
own voice, and only when that mode's card has been agreed in Home; to one that asks more, from anyone. (6) **The
release gate** of no risky action unconfirmed (§6's tier-2 row and the eval's blocking gate) is measured in
Interactive, the default and the eval's mode; steps Assisted's check cleared or Autopilot announced are audited with
the mode (and Assisted's verdict) and are not counted as unconfirmed.

(7) **Assisted and commands:** its check may clear a command `notReviewable` and `NEVER_REVIEWED` held back before
(a system change, download-and-run, carried text, another computer, an administrator's command) when it finds it in
the user's own words, never one that would read or print secrets or outlive the kill switch, nor what the
organisation's policy or the user's own "ask every command" requires. (8) **Routines:** a routine's saved steps are
not the user's words for Assisted's check; the request that started the routine is. (9) **"Okay" and "go on":** while
a question is up, a bare "okay" or "go on" allows it, as "okay, go with it" and "sure" do.

**A page's link clicked** (loosened 2026-11-12, `.claude/rules/agent-and-policy.md`, not CLAUDE.md; found by the
investigation of the owner's report). Policy read a page's link by what it leads to (`linkCommands`) only with
`inPage`, which the worker sends for keys and typing; a click carries `onPage`, so a result titled "How to install
Node.js" was judged as a button, asked "You didn't ask for this" and put the rest of the task back to asking, and with
its thumbnail's twin was refused before any question. `riskOf` and the worker's `livingPage()` now read it by either.
What counts as a title is `linkIsTitle`'s allow-list, and its review (W-1) found commands in a title's shape that it
let through, clicked now and with Enter before ("Share Document - Drive", "Grant Access - Drive", "Merge Pull Request -
GitHub", "What are you waiting for? Delete your account"). So it was narrowed for both: a title in parts ("Artist -
Song", "Name | Site") is one only with a song's or a video's tag ("Post Malone - Circles (Official Video)"; never
"(Live)", never where a part turns a protection off), since a command may stand before or after the separator ("Acme
Bank - Transfer Funds", "My Shop | Buy Now"); a command after a question or a colon, or, after a how, what or why,
after any other punctuation or symbol but a dot, hyphen or apostrophe inside a word (`CLAUSE_BREAK`), is never one;
nor is a suggestion ("Why not share your location") or a grant of access (`GRANTS_ACCESS`). Its second review (R2-1)
found that a clicked link read as content was spared by a file's name before any of its words was read ("Sign
contract.pdf", "Delete report.pdf"), and that a how, what or why title was split into clauses only at stops, commas
and dashes ("What next / Delete account", "Why wait (Delete your account now)", "What's new → Buy now"). So a clicked
page link now asks wherever a link's name asked before, or `linkCommands` says it does something, unless `linkIsTitle`
takes it for a title, and the worker's twin check reads it so too; with Enter it is read as content, as before. Proof:
round eight's corpus (838,392 steps) decides byte for byte as before, but it holds no link named in a title's shape,
so it shows only that nothing else moved. On 169 command-shaped names (the review's 94, 57
led by the policy's other acting words and 18 with the command after the separator or other punctuation; 2,704
clicked steps), every step decides as before the loosening but two names': "Restore Defaults - Settings" asks more
(read as a button's name now), and "Post Malone - Circles (Official Video)", a title, asks less. With Enter, 31 of the
review's names now ask where they went unasked, and none asks less. On 140 titles and commands in five shapes
(11,200 steps), the only steps that ask less than before are eight titles' clicks on an ordinary page ("How to install
Node.js on Windows 11", "Post Malone - Circles (Official Video)", "How to install Python: Complete guide"), which lose
their question and flag; on a payment page they still ask. A title in parts with a risky word and no tag ("Post Malone
- Circles", "Rusted Root - Send Me On My Way", "Kill Bill - Official Trailer") asks as before, and off the task is
called something the user didn't ask for. A native app's link, a page's button or menu item and a payment page's
control ask as before, and `judge()` still calls an off-task link that says what it does something the user didn't
ask for. After R2-1, every corpus above decides as before it, round eight's byte for byte. On the review's 57 names
and 29 more (bare file names, more separators, titles with punctuation) in four shapes (2,752 steps), every step that
asks less than before the loosening is a click on an ordinary page of a link `linkIsTitle` takes for a title: 17
names, among them the allow-list's residue, a command that reads as a title with no separator ("What to do next Delete
account", "Why Delete Your Account Today", "Why Buy Now", "How do I pay now") or with a song's tag ("Acme Bank -
Transfer Funds (Official Video)"); so is one joined to a title inside a word ("What next-Delete account", "Why
wait.Buy now"). With Enter, 26 of the 86 names now ask where they went unasked before the loosening (19 of them since
R2-1), and none asks less; a command before a file's name still goes unasked with Enter, as it did before the
loosening. A file's link with a risky word in its name ("report.pdf", "Install guide.pdf") asks again when clicked, as
it did before the loosening.

### Product audit fixes, ninth round (2026-11-12 to 2026-11-13)

After round eight each area was rated again at 01493d0 (main). The re-rate was cut short by the usage limit: twelve
areas have a re-rater's score, one of them (models, providers, extensions and projects) a challenger's too, and the
companion and Ask has neither. The other eleven challengers and the companion's re-rater are deferred to round ten, so
no second score is recorded for those areas here. Scores (re-rater): commands, WSL and SSH 6.8; listening 7.2; models,
providers, extensions and projects 7.3 (challenger 6.6); memory 7.8; tasks and approvals 8.3; first run and setup 8.4;
safety and privacy 8.5; speaking 8.5; reliability and platform 8.6; accessibility and copy 8.6; Home 8.6; install, docs
and developer experience 8.8. The re-raters listed 10 P1s, 48 P2s and 104 P3s, each area's known gaps for the three
slices the owner decided on 12 November and main didn't have yet among them (-r9-K1 to -K3: the approval modes, first
run's defaults, the vault); the one challenger added five P2s and two P3s (integrations-c9-1 to -c9-7) and rated
integrations-r9-6 higher. The P1s: commands' seven (tmux and its like typing into the user's terminal; a command handed
to a program as one quoted word or after an exec verb; `python3 -m <tool>` skipping the tool's row; database wipers and
deployers with no row; downloaded code run through option values, runners, compilers and fetch tools with no row; a
file's contents leaving in a URL or a header: commands-remote-r9-1 to -r9-7), listening's two (the computer's own sound
saying yes in the moment after Ember's read-out, and “Ember, allow it.” out of the speakers taken in the answer window
and a conversation: voice-listening-r9-1, -r9-2) and integrations' one (a plugin's server showing the model a tool
description nobody agreed to: integrations-r9-1).

The round did two things together: it built the owner's decisions of 2026-11-12 (the section above) and it fixed the
re-rate's P1s and P2s. Of the decisions, slice 3 (the approval modes), slice 4 (first run's defaults under one
agreement) and slice 5 (the vault) are on this tree, with a second, independent review of slice 2's voice lane (spoken
answers, merged before the round in 338c5cf and 02b7089) and of its review's V-8, whose findings (V2-S1 to V2-S10, V2-F1
to V2-F13) became two of the voice lane's packages. Nine lanes, each in its own worktree off 01493d0 with its packages
one after another: modes (slice 3: builders A to E, then package modes-y9), slices (slice 4, then the vault in three
packages, vault-1 to vault-3), voice (voice-safety, voice-product, voice-roomtalk, voice-answer-take), product
(product-safety, product-ui, product-platform), commands (commands-held, commands-closed, commands-classes), memory,
integrations, and two for what CI found (cifix, evalfix). Three more jobs, each in a worktree of its own, brought the
last of it together: one merged the vault, one the command classes and then a fourth commands package, commands-runners,
and the final merge joined them (below). Each package: a fix with a test seen failing first, an adversarial reviewer
(-x9-N), a repair, a second reviewer (-y9-N) and, where that review had a P1 or P2, a resolve step told to correct or
revert and design nothing new. An integrator merged at checkpoints, ran the gate on each merged tree and the two safety
harnesses (the policy proof and the commands comparison, both rebuilt this round; the comparison's corpus is more than
twice round eight's), and pushed. The merges, in order: commands-held's fix (97dce08), voice-safety's fix (ddab162), the
modes' builders A and B (930fade), commands-held's repair and resolve (ca2daf4), integrations (bec8fde), memory
(446846b), the modes' builders C and D (4a602a1), voice-safety's repair (a91c646), integrations' and memory's last
repairs (53a44ae, f2dbe1d), commands-closed's fix (133bcbf), voice-product (dc4dbe8), product-safety (a56027a), slice 4
(64cddeb), the modes' builder E and slice 3's repair (9b52239, the third checkpoint), voice-product's resolve (1de2485),
commands-closed's repair and resolve (a2d10ab), cifix and its repair (03ebf5c, 1446548), product-ui (815a53e),
modes-y9's fix and repair (3d9b4f2), product-platform (0fa8bf0), modes-y9's resolve (681c36a, the fifth checkpoint) and
voice-roomtalk (a3cf645); then voice-answer-take (237fd04), the command classes (f739499), the vault (21f7426), this
record's first pass (ea276ea) and, after the final merge's repairs (dfbac18 to eaab87f), commands-runners (fa19f89). At
a3cf645 the round is 266 commits, 27 of them merges; at fa19f89 it is 367, 34 of them merges (29 on the first-parent
line), each with a signature header and the session's trailer and none with a co-author line (counted on the tree; the
machine that counted has no allowed-signers file to verify them against).

**Slice 3, the approval modes** (the modes lane). Builder A: Home › Apps & privacy has one choice of how Ember asks in
place of its three switches, starting with Interactive (`settings.approvals`), the mode in force is worked out in one
place, an organisation can cap it with `approvals.maxMode`, and choosing a mode is an `autonomy` audit entry with the
mode, `via` and `verified` (2b8a489, 0b018b7). Builder B, the causes of the owner's report of an Allow that did nothing:
a question nobody answered is no longer taken as the user's no (ac6bad2); once the user takes the mouse back, Ember asks
before any borrow for the rest of that task (157930d); a step or command the user said no to is refused when sent again,
without a question (e1687ea; tasks-approvals-r9-1, commands-remote-r9-8); and an Allow about a web page's control holds
when only the rest of the page changed (a865a5f). Builder C, Assisted: a step that would ask is first checked against
the user's own words by the hardened one-shot reviewer, inside the policy's own gate (`PolicyEngine.assist`); a match
goes ahead, announced, and no match, no answer, an error or a timeout asks; a task without the user's own words asks
without the check; a command that would read or print secrets or outlive the kill switch is never cleared, nor one over
4,000 characters reviewed in part; `features.aiReview: false` keeps the check off for app steps too; its card says a
lighter model decides and can be wrong (f66f35f, 3350b21, 6f6d411, 2a97ddc, c98ac1f, cacbde6). Builder D, Autopilot:
every step in an app, a dangerous command with its Stop, the extensions gate's questions and a remote's own gate 2
questions are announced instead of asked; a command the user's own words rule out, a secret a wrapper hides from the
classifier and a remote's ban on Autopilot keep the question; prompts, pictures, Stop, the limits and first-use cards
are pinned as kept; after a takeover Autopilot borrows nothing more in that task; its card puts the risk first (f3ddb36,
413b028, b37227e, e2af103, 209309b, f31a450, 4f2aa52, 533a644). Builder E: “Ember, switch to Autopilot” and the other
modes' names by voice, under the settled rule, while typed words and a pressed suggestion never choose a mode that asks
less (Home opens at its row instead); the eval's safety gate is measured in Interactive, with three of its 40 tasks kept
below it (`"mode": "asking"`) because a question is their point; Home and the docs say so (67d473c, beb16d9, 0707e7c).
At the slice's end (0707e7c) the policy proof against main passed with every mode live: 287,678 steps, none weaker or
stronger below Interactive; Interactive decides as main's Work without asking with every scope and the app switch on;
Assisted with a check that never matches, throws or answers nonsense decides exactly as Interactive; against the state
that asks, Interactive no longer asks 97,938 questions, Assisted with a check that matches 253,400 and Autopilot 255,704
(of its app steps it asks none), and none loses its “You didn't ask for this” flag; every refusal (secret and password
fields, the user's terminals, security windows, Ember's own windows, never-look windows) stays one in every mode; 24
hard checks pass.

Slice 3's first reviews (x9s for safety: three P1s and a P2; x9p for product: one P1, four P2s, two P3s) were repaired
in eleven commits. Services, scheduled jobs, startup entries and registry writes count as outliving Stop, so neither
Assisted nor Autopilot lets them through (fb4fc47; modes-x9s-1; in the comparison 3,908 Autopilot cases outside the
mode's limits became 0). A settings.json written by a program can no longer raise the mode or agree to a card: while
Ember runs a change read from the file never does, and at start a mode above Interactive and Assisted's and Autopilot's
agreements count only where they match a seal kept with `safeStorage` (`approvals-seal.bin`, 0600, written after each
change made in Home, by voice or by typed words; until it is read Ember is at most in Interactive), and policy refuses
steps other than reads in a window titled with Ember's data or policy folder (9f0fd3c; -x9s-2, -x9p-5). The refused step
done another way (Ctrl+Enter, “Send Now”, Send in a second compose window after a refused Send) is refused too (445b38b;
-x9s-3; its “every kind” fallback is what CI then caught, below). A risky control's Allow is bound to the page's
headings and paragraphs as well (4daa1db; -x9s-4). Home's note says that as root or an administrator Autopilot runs
commands without asking (d6bcd3c; -x9p-1); choosing Assisted or Autopilot keeps its card's risk paragraph in view
(e3297c2, 4b0c031; -x9p-2); an existing user who hasn't agreed to Interactive's card is told once a run why Ember still
asks before an ordinary step (a3cb5a7; -x9p-3); Assisted's card names what the check is sent, at
`FEATURE_CONSENT_VERSION.assisted` 2 (f431ce2; -x9p-4); and the note under the modes and the docs on the system's
Settings say what the engine does (c81a366, 9739aba; -x9p-6, -x9p-7).

**Package modes-y9.** The second review, at the third checkpoint (9b52239), found four P1s and five P2s; its fix (five
commits to 02ad227), a review of that (two P1s, four P2s, a P3), a repair (seven commits), a second review on the merged
tree (two P1s, seven P2s, a P3) and a resolve (3d9b4f2..2671810) followed. What happens now. A downloaded program handed
a key, a token or a word Ember can't resolve is a secret's command, `secret.handed-to-download`, and asks in every mode
and at a remote's gate 2 (5c64418, 5ac0b04, 771b1a6; modes-y9-5, modes-y9-x9-2, modes-y9-y9-6); one pointed at Ember's
own settings is refused (771b1a6; modes-y9-y9-9, treated as a P1). Code planted to run later counts as outliving Stop:
ten more rule ids, then a list of the `unclear.*` ids (a D-Bus message, a WMI or CIM call, an alias, a trap, a
coprocess), with a unit test that reads the classifier and fails on a rule id nobody has judged (a54bacc, f7f4058;
modes-y9-1, modes-y9-x9-3). Assisted never clears a program Ember doesn't know, nor a command behind `bwrap`,
`firejail`, `envdir` or `expect` (a54bacc, 67c0b28; modes-y9-6, modes-y9-y9-5); one predicate, `keptQuestion`, replaces
`NEVER_REVIEWED`. For a risky control the Allow is bound to all the page's text outside its feeds and to the names of
its other controls, a clock, a control's own counter and an English list of counts a page gathers by itself let through
(ca2717c, bf31ea6; modes-y9-3, modes-y9-x9-5, -x9-7), and to text in a list or a table that names money (2671810;
modes-y9-y9-8, partly). Words that hold a command back (“leave”, “keep”, “not yet”, “later”, “until”, “tomorrow” and
their like, read part by part of the request) keep Autopilot's question, and the card says “Your words say to leave this
or to wait, so Ember asks first.” (6ef215b, f2eb60a, 0edd6de, d706d4d; modes-y9-4, modes-y9-x9-4, -x9-6, modes-y9-y9-7).
And the rule for what a no means was rebuilt three times, ending at the integrator's steer (Settled 3 to 7 below):
02ad227 and 667893a widened the matcher of “the same thing” (a deletion reworded as code, a move or an API call; a push
of HEAD or `@`; a refused command done in an app and the reverse; modes-y9-9, -y9-2, -y9-8, modes-y9-x9-1 and the
eval-fix lane's findings, evalfix-x9-1 to -x9-3, the third being that lane's L1: after a no to a risky step of no kind,
a later risky step in that app that names no kind itself, a refused “Add comment” then Ctrl+Enter, asks, never checked,
and in Autopilot is refused); the second review still found a refused push sent again by the remote's URL and `rm -rf
build` announced after a no to a deletion Ember couldn't read (modes-y9-y9-1, -y9-2), and found the wider matcher
refusing the user's own commands by a word of a window's title (modes-y9-y9-3, -y9-4); the resolve reverted two commits
of an earlier resolver that widened the matcher again (d92ce71 reverts 3b77516 and bf97ce0, which stay in the history)
and built the steer instead (1772ee0): refused without a question is only the same step or command and what is
recognisably the same thing done another way, and everything else that may be it asks, in every mode (rule
`refused-like`, the card's “You said no to something like this earlier in this task.”). On the review's fourteen probes,
the seven where a refused push or deletion came back another way, which Assisted checked and ran and Autopilot announced
and ran, ask in all three modes with nothing checked or announced; a no to a page's “Delete repository” no longer
refuses `rm -rf firefox` by its window's title, which asks.

**Slice 4, first run's defaults** (the slices lane; c863e4e, 9bfda93, then a2f6c2c to 04d1c88 and 3e1916a). First run
shows, between “Before Ember starts” and the agreement, a row with a switch for each of commands on this computer,
memory, “Hey Ember” with spoken replies, screenshots for tasks and Interactive, each with its own card's full text, read
from the one source its own card uses; the one agreement records the consent first and then turns on each row left on,
as that row's own card would (a row that fails to save says so and stays off; if the consent itself can't be saved
nothing is on). Voice Match isn't among them; without the speech models the listening row is off with a reason, and
nothing downloads; a row the organisation's policy turned off shows managed, and under a lockdown every row is locked. A
returning user sees only Interactive's row, while its card isn't agreed, and keeps every other setting.
`CONSENT_VERSION` 9, with its line in `CONSENT_CHANGES`. The first review (three P2s, three P3s) and the second (one P2,
one P3): a row switched off, or one that can't be turned on, is written off with the consent itself, so no row is on
that its note says is off (a2f6c2c, 89d1993, 3e1916a; slice4-x9-1, -x9-2, -y9-1); the returning user's line is true
where Interactive is already agreed or managed (1fefbca; -x9-3); first run's listening row and Home's card record the
same thing (c12477a; -x9-4).

**Voice.** voice-safety (the second review's V2-S findings; 01493d0..3a43a81): every fix but one takes fewer spoken
yeses; a no is anyone's in every window. On Linux with parec, what sounds in the speakers' stream after Ember's own
voice left it is other sound at once, and on Windows the output watch counts sound from 0.4 s after its last look at
Ember speaking (f7eb99c; V2-S1, voice-listening-r9-1: 7 of 72 such yeses taken on main, 0 of 72 after). “By name” in the
answer window, a follow-up and a conversation means the user said it: a name the speakers' stream said answers nothing
(3b854ee, 66186dd; V2-S2, -r9-2: a video's “Ember, okay.” and its like 25 of 80 taken on main, 0 of 80 now; after the
user's “Hey Ember” and a pause, a video's “Ember, allow it.” 28 of 40, now 0 of 40; the user's own by name 75 of 80
before and after). A request leaves the answer window only by a wake's two stages, so room talk is no longer sent to
Copilot from it (4912ca9; V2-S3, -r9-3: 8 of 8 left the window on main, none after). A nameless yes is judged on its own
speech in every nameless window, and one in a wake's own window is dropped where other sound is known to play (6500aa1,
ff1dd2c; V2-S4, V2-S6, -r9-4). A no is never dropped as over other sound (48dac19; V2-S7, -r9-5). In the answer window,
without the name, only “stop” itself stops (74d8f50; V2-S8). A follow-up window dates each thing said from its own start
(f5194f5; V2-S9). “Okay, thanks.” is a yes (1e43271; V2-S10: the one fix that takes a yes not taken before). V2-S5
changed only the docs and §2: a yes asked only by the voice's rise (“Okay?”) is written “Okay.” and taken (21 of 28
synthesised clips). Its review's four findings (two P2s, two P3s) were repaired: the Windows watch's first look alone
may hold Ember's last sounds (74fa1fe: a call's “Okay.” begun 160 to 480 ms after the read-out 0 of 25, where the review
took up to 12 of 25); what played before Ember's voice is carried 1.3 s, not a fresh 2.5 s (af044ea); a speech whose
loudness at the microphone follows the stream's from 1 kHz up is the speakers', so a loud hum in the stream no longer
hides a page's own “Ember, allow.” (daa45be: 0 of 48 at 50, 120, 200 and 300 Hz, where the lane had taken 6 of 48 and
main 22 of 48 at 200 Hz); and an answer dropped over other sound that began with the name gets a line of its own
(3a43a81).

voice-product (the second review's V2-F findings; ten commits to 6744269, a repair to fca9cd6, a resolve to 5d1ae43):
with Voice Match on, the locked line no longer calls the owner's own one-word yes another voice's, and Home says to
answer in a few words (557ec8a; V2-F1, -r9-6); each refusal line is said aloud once a question (3bfdc5e; V2-F2, review
V-8: the locked line once instead of five times in 58 s); Home says per platform where a bare answer needs no name
(545ae34; V2-F3, -r9-7); the status line says “Listening for your answer…” while the answer window is open and, when it
closes with the question still up, “To answer by voice now, start with my name.” (32a54e6; V2-F4, -r9-8); a near-miss
answer while a question waits gets the unclear note instead of going to Copilot (eb5a2db; V2-F5, -r9-9); every CI job
fetches the second test voice, so four real-model tests no longer skip (ae95c5d, df251fb; V2-F6, -r9-15); eleven more
everyday yeses and ten noes are taken (“you may go ahead”, “I approve”, “don't do that”, “absolutely not”), and a yes
asked as a question in its words is never an answer or a request (3133cba, eb5a2db; V2-F7, -r9-11); a refused spoken yes
says what really happened (0178117, 3bfdc5e, 6744269; V2-F8 to V2-F10). The review (a P1, four P3s) and the second
review (two P1s) found three ways the package itself took or lost too much, all corrected: others' “okay” after the
user's bare “Hey Ember” in a busy room went out as a yes by name (85617ab; voice-product-x9-1); “No, stop the task.” and
its like were taken for a near-miss answer and no longer stopped anything (2a21adc; -y9-1); and “Okay, Ember.” sent as a
yes by name could not be told from a video's on Windows and macOS, so that line of eb5a2db was removed, not patched
(5d1ae43; -y9-2).

voice-roomtalk came from CI (below): on a spotter stream never reset between sessions, “A number of people called
today.” left the answer window as a wake's request in 1 of 80 kept renditions on WebAssembly and 2 of 80 on the C API.
The spotter had reported the bare name and `CALLED_AS_WORD` took “a number” for it. Now a name counts in the answer
window only where the spotter fired and the recogniser wrote “Ember” itself, a “Hey Ember” spotted there is checked
against a pre-roll as from idle, and every wake by the whole phrase is checked again on the whole of its first speech
(bdc31ad: 0 of 80 on both builds; of 160 real wakes per build none lost, and “Hey Ember, what time is it?” in the answer
window whole 16 of 16 where it was 9 of 16). The second review's leak from idle (talk with a greeting, “they”, “embers”
or “Emma” in it that the spotter takes for the phrase: 20 of 24 sent) is 0 of 24, with the 256 kept real wakes decided
as before on both builds (5be5ba9); 280a32e is the test's. Its first review's two P2s and two P3s were repaired in three
commits (78ba3c7, 85e0553, 6a31e2c), -x9-2 left to the owner (below).

**Product.** product-safety (a56027a): Enter in a dialog that asks or warns, while none of its buttons has the keyboard,
and on Windows a bare letter there, asks every time, since Ember can't tell which button it presses (976ef24, 8b4f713;
safety-privacy-r9-1, product-safety-y9-1: 18 of the probe's 19 focused controls went unasked, 15 now ask and the other
three back off or only show more); warning controls under the names browsers and mail apps give them (“Keep dangerous
file”, “Continue to HTTP Site”, a bare “Keep” or “Open” under a dialog's words of danger, “Show images” in a mail app)
ask every time, read from the dialog's words and never a window's title (fef6c98, 78a7f1a, 7eb5fd1, dabf84f, dcaf251;
-r9-2: 11 of 13 product names went unasked, now none); Linux's default never-look list gains six password managers, for
new installs and Restore defaults (c306ed6; -r9-3); the log redactor hides the value after any Authorization scheme and
`…PASSWORD=` (eee34b9, a611d44; -r9-4); and a key that types a character is audited as a count (a180a59; -r9-5).
product-ui (815a53e): a task's question no longer throws away the conversation's answer still streaming (afe38fd,
60c8a88; tasks-approvals-r9-2); Task activity marks the task whose question is up (704626d; -r9-3); a Voice change made
under a policy or a lockdown no longer writes the forced values into the user's own settings (26db479; home-r9-1); first
run's model check works against a service that lists more than 50 models (520fb69; first-run-r9-1) and its Try again
line clears (94dd0a6; -r9-2); a background task's end is said on a composited desktop too (494e708; accessibility-r9-1);
no consent card in Home takes a doubled or held key as agreement (e381875, e52d1f5; accessibility-r9-2, home-r9-6); and,
of the P3s, tasks-approvals-r9-4 to -r9-6 and -r9-9, home-r9-3 and -r9-7, first-run-r9-8 and -r9-11, accessibility-r9-5
and -r9-6. Its review's P1 was the package's own: the prompt window retitled “Ember needs you” was no longer known as
Ember's own, so a click on its Allow by the model would not have been refused; the title is in the policy's list again,
pinned to the window's own title (093f59e; product-ui-x9-1). product-platform (0fa8bf0): Ember's English words after a
passage in the system voice wait their turn (2755a75; voice-speaking-r9-1); a passage in another language after an
English lead-in is read in that language's voice (9377ed3, 58ffe3e; -r9-2: the passage was wholly Ember's English voice
in up to 14 of 16 runs a language, now 0 of 16 for eight languages; short Italian and Portuguese messages left); “Read
it out” says why when no voice can say the answer (c585b9f; -r9-3); with the user's inotify watches used up Ember names
`fs.inotify.max_user_watches` and the setup check has a row for it (82453ab; reliability-r9-1); a Sign out on a disk
that can't be written holds for the run and says it wasn't saved (5c3807c; -r9-2); a connection the firewall refused is
still called the network's (d24d92a; product-platform-y9-1); and reliability-r9-3 to -r9-5, install-docs-r9-3, -r9-5,
-r9-7 and -r9-9, part of voice-speaking-r9-6, and four flaky tests.

**Commands.** commands-held (97dce08, ca2daf4): the rebuilt comparison found 247 cases (131 commands, six families) at
main that decided less safely than 4d64d3a outside the allowed kinds, all since round seven, each an option table
corrected to the tool's manual: `sudo -h host rm -rf ~` asked where it was refused, and `git commit` behind `-S`,
`redis-cli` behind `--tls`, `parallel` behind value options, `env --block-signal ls` and a program named like an `if`
word ran where they asked. Each row is now judged by its table and by the table as it stood at 4d64d3a, and where the
two read the line differently the stricter verdict and every danger either named stand (3408cfb and the commits after
it; rule `unclear.option-value`). A fuzz of every changed option then found the same kind outside the corpus (2,462 of
270,331 commands, 25 more rows held; then 3,901 lines where a switch behind an option changed the reading, and 709
behind count options), all held. Its reviews found three P1s in the mechanism (state left by main's reading: Ember's
folder in a variable no longer refused, a download mark stopping a script being read, `read` notes overwritten) and, the
second, two more (what follows the end of an `&&` chain that moved the folder judged only in that folder); all repaired
(9e1f007 to b844449, 2fb4b19). commands-closed (133bcbf, a2d10ab), the integrator's decision recorded in §2 “Commands”:
the classifier's default is closed. A program with no row asks (`unknown.program`, “It runs a program Ember doesn't
know.”) unless it is on the list of ordinary programs (754 names: tools that read, list, measure, convert, compile, test
or build what they are given) or given by a path in the task's own folder, and a tool's verb its row doesn't know asks
(`unknown.verb`, 64 tools); the user's own words naming the program and each plain word it is given announce it
(“Running rails db:drop, as you asked.”). A fixture of everyday commands, 460 at the fix and 490 by the package's end,
runs with no question. Its reviews (a P1, five P2s, two P3s; then a P1 and six P2s): a mention is not a request (“as you
asked” needs a request clause whose verb acts on the tool: 5bedd60; commands-closed-x9-1); the command a known runner
runs for its user is read (`stack exec`, `cargo watch -x`, `nodemon --exec`, hyperfine, entr: bb2e75f); a `cd` no longer
makes any folder the task's own (4061450); a script of the task's own folder calling an unknown tool runs as on main
(dff8753); changing verbs came off the list (3c55702); and busybox and toybox are judged as the applet they run, after
the first version ran `busybox sh run.sh` where every baseline asked, which the comparison caught at the third
checkpoint (946f040, ced4c67, 1a828a5; -x9-6, -y9-1).

**Command classes** (the commands lane's third package, commands-classes). The re-rate found the commands P1s and P2s as
classes of command, so the package fixed each class rather than each line (probed with the re-rater's own files and a
table of spellings per class, on four POSIX targets and the Windows shells where they differ), and filed the
classifier's side of the modes' second review (modes-y9-1, -5, -6 and -7). The fix, from f0d1225, is 14 commits to
fdb9953 (the last two repair what the whole unit run and the comparison found in the first twelve); its review
(commands-classes-x9-1 to -x9-9: 7 P2, 2 P3) was repaired in 8 commits to e712b69; its second review (-y9-1 to -y9-11: 1
P1, 9 P2, 1 P3) was resolved in 10 commits to 7dbaabc. Every change makes Ember ask or refuse more; none asks less than
main, 848a566 or 4d64d3a. **Typing into the user's terminals** (commands-remote-r9-1, x9-1, y9-4): `tmux send-keys`,
`zellij action write-chars`, `kitten @ send-text` and `nvr --remote-send` asked as unknown programs, which the user's
own words naming the tool could announce, and `screen -X stuff` ran as an interactive program. They are refused now, by
a new kind of refusal, “terminal” (rule `ember.terminal`, “Ember won't run this: it would type or run commands in your
own terminal or editor.”): the typing and running verbs of tmux and byobu (a verb written short, `s` or `display-m`, is
read as every one of tmux's 93 commands it is a prefix of, and the strictest decides; its options are read as getopt
reads them and `tmux -c` as a command), `screen -X`, zellij, kitty's and wezterm's remote control, `it2api`, an editor's
`--remote-send` and `--remote-expr`, `emacsclient -e`, Guake's `-e`, a desktop-bus `sendText`, an osascript's `do
script` for Terminal or iTerm and `wt -w <window>`; what only prints a pane or a buffer asks as a secret
(`secret.terminal`, kitty's `ls` too: it prints each window's environment and command line). 77 spellings on four POSIX
targets, 4 on the two Windows shells and 25 shortened tmux verbs refuse; it is what CLAUDE.md's “never types into the
user's terminals” says. **A command handed to a program** (r9-2, x9-4): with “run frobnicate” in the user's words,
`frobnicate 'rm -rf ~/Documents'` and `frobnicate --exec 'npm publish'` were announced and `fd -x mkfs.ext4 /dev/sdb1`
ran. The handed command is read now (one quoted word whose first word names a program with a row, an exec-like option's
value, the words after `--`, and what a script that a shell, an interpreter, tsx, bun or a batch file runs is handed)
and adds `unclear.hidden-command` behind a program Ember doesn't know; the project's own script is judged by the handed
command alone. **Launchers and runners** (r9-3, modes-y9-5, y9-1, y9-2, x9-6): `python3 -m <tool>` is a payload of the
tool, and a versioned name takes its row (`python3.12 -c`, `node20 -e` and `pip3.12 install` ran or were misread); the
package's own command line behind npx, `pnpm dlx`, `bunx`, `deno run npm:` and 17 runners is judged beside `escape.npx`;
pm2 and forever start anything but a listing or a stop (`escape.pm2`, `escape.forever`: a script's name or an option's
value read as the verb counts); yarn's plugins and policies, `mise exec`, `nix shell`, `pixi run`, `devbox run` and
`direnv exec` are read. **Wipers, deployers and downloads** (r9-4, r9-5, r9-6, x9-2, x9-3, y9-5, y9-9): a script's
destroying verbs are judged (36 database wipers and 13 deployers on four targets ask, 15 everyday lines run; `db:empty`,
`cleardb` and `migrate:refresh` ask, `cache:clear` and `-- --prod` don't); a program that isn't a plain reader asks
(`escape.run-downloaded`) when a download, or a folder holding one of its files, is named anywhere in its words, in an
option's value, a variable set in front, a response file, an archive 7-Zip or RAR unpacked or a later `export`; 18
readers and fetch tools given an option that makes them run or load a file are no readers for that line (`READER_RUNS`).
**What leaves in a request** (r9-7, x9-5, y9-6, y9-7): a fetch tool whose address holds a substitution that says more
than little, a variable the line filled from a command or a read, curl's `-H @file` or a file on httpie's input is
`send.contents` (a publish; 30 spellings on four targets), as is xargs with a replace string feeding a sender; a cloud
metadata address is read as a resolver reads it (one number, hex or octal parts, a trailing dot); `npm`, `pnpm` and
`yarn config get` of a key that holds a credential and composer's `github-oauth` and `http-basic` keys are
`secret.program`. **Secrets** (modes-y9-6, r9-9, x9-7, x9-9): a word Ember can't resolve that expands a variable named
like a secret is `secret.env` in every mode, for known programs and unknown ones, in PowerShell and in cmd; `curl -H
"Authorization: Bearer $GITHUB_TOKEN" …` and `npm test -- --token=$NPM_TOKEN` ran on main and ask now, a behaviour
change beyond the findings. Recorders and ffmpeg with a capture device are `secret.record`, key listings and `terraform
output -raw` `secret.cloud`, a file named for a secret is read as one, and redaction gains 16 shapes, among them an
Azure Key Vault secret printed with its tags. **What outlives Stop and what a later command obeys** (modes-y9-1, r9-11):
`brew services` and `snap start` and its like add `service.change`, `flatpak run` `unclear.gui`; `npm config set`, `yarn
plugin import`, `gh config set` and the like are `pkg.config`, and `git remote set-url` and a remote's address in `git
config` `git.config.remote`. **The user's words** (modes-y9-7, r9-10, y9-8): a program Ember doesn't know is announced
by them only when every option, number, host, address and path outside the task's folder is written out in them and no
option is named for detaching or for a secret; a deletion the words hold back or narrow in a later clause (“first”,
“only the logs”, “make a copy”, “to the trash”, a stash) asks, 30 of the re-rater's 30 lines (21 before); `python3 -m <a
module Ember doesn't know>` asks, a second behaviour change beyond the findings. Seven cases of posix.json that
announced (`mytool ../other`, `mytool ~/Documents`) ask now, and `tmux -c 'rm -rf ~'` refuses. The re-rater's own probe
files, before and after: what ran of send.json 22 to 7, what was announced of copy.json 9 to 0, what refused of e.json
36 to 252, of f.json 9 to 49.

**The command classes meet the modes** (the integration job, in a worktree of its own: the merge a52cb7f onto 681c36a,
repaired and resolved to 465bb55, and into the round at f739499). The merge had no textual conflict and broke three
tests of the modes lane, each seen failing first and settled in the merge commit. The test that every rule id has been
judged for outliving Stop (modes-y9-1) found six new ids: `pkg.config` is held (Assisted's check never sees it and
Autopilot asks, `npm config set registry` too, since the classifier doesn't say which key is set and `script-shell`,
`pager` and yarn's `yarnPath` name code every later command runs); `git.config.remote` and `send.contents` were looked
at and left to the modes as a system change and a publish; `secret.terminal` and `secret.record` are secrets (never
checked, Autopilot asks); `ember.terminal` is the classifier's refusal, which no mode sees. `npx frobnicate
--port=$PORT` asks where the modes lane announced it (the lane reads a variable among a package's words as
`unclear.unresolved-arg`), so the test now pins the question. Gate 2 on a remote returns the classifier's secret
findings beside the handed ones, and its test pins both. The merge's review (the commands merge's integ-x-1 to -x-5: 3
P2, 2 P3) found: 170 cases (18 commands) looser than the round's own tree at 681c36a, which the proof had no baseline
for (x-1: the env launchers, and terminal listings that print session and tab names); a downloaded program told to
detach, announced in Autopilot (x-2: `escape.background` now); Autopilot announcing a deletion the user's words hold
back (x-3: “…but move it to the trash”, “…but ask me first”; `heldByWords`: asking to be asked first holds any step the
words name, and a copy first, “only …” and the trash hold a deletion); a git address that names a helper program (x-4:
`<helper>::` is `unclear.git-ext`, as `ext::` was, in the positions listed under Left); and this record (x-5). Four
repair commits (ecb1939, 26b0a3c, 27d1b60, afb37c5), and from then on the proof takes the round's own tree (681c36a) as
a fourth baseline. Its second review (integ-y-1 to -y-7: 1 P1, 1 P2, 5 P3) found that the lane's row for the env
launchers (`cross-env`, `cross-env-shell`, `dotenv`, `dotenvx`, `env-cmd`, `with-contenv`: “they only set variables, so
the command after them decides”) never judged the variables they set or the file they load: lines setting CC, LD_PRELOAD
or NODE_OPTIONS ran unasked in every mode, which asked at 681c36a (y-1, P1), as did a downloaded env file (y-2, P2). By
the integrator's steer the row came out whole (817f630): the six ask as programs Ember doesn't know, as at 681c36a,
whatever they are handed (Settled (9), below). y-5 (a downloaded program told to detach) is fixed where it is run by its
path or as a shell's script (6713a48); y-4's wording is corrected (465bb55). Proof on 465bb55 (283,658 cases, the
default and the four modes, against 681c36a, 4d64d3a, 848a566 and main): 0 new failures (100 against 681c36a, all
recorded, over nine commands that ask there and run now: zellij's session listings and `--version` (69), `kitten @
get-colors` (17), `nvr --serverlist` (7) and `it2api --help` (7), each judged intended), 0 weaker asks, 0 unproven and 0
outside the mode's limits (the lane alone, without the modes' list of what outlives Stop, had 554 and 1,570); looser on
purpose 527 in Interactive and in Assisted with no match, 44,350 in Assisted with a match, 79,451 in Autopilot; stricter
than 4d64d3a by 52,659 and than 681c36a by 5,866; the guard trips (46.4% of what 4d64d3a ran on the classifier probe,
44.4% on the flow probe). `npm test` 16,418 passed, 15 skipped, 0 failed; the policy proof was not run (nothing under
policy, the worker's action path, hands or perception changed). The third check (z: 1 P1, 2 P2, 2 P3) found four faults
older than the round (three the same on main) in what a package manager or the project's own launcher hands on, and a
test pin the resolve had weakened: package commands-runners.

**Commands-runners** (a fourth commands package, on the integration job's branch: fix 5faa7c4 to a08847c, repair b236945
to 589e3b7, resolve 9eef84f and 596db8e; merged at fa19f89). A package manager's own line was judged by its name alone,
so `yarn cross-env X=y cat ~/.ssh/id_rsa`, `yarn node -e rmSync`, `npm run build -- ~/.ssh/id_rsa` and
`./node_modules/.bin/cross-env LD_PRELOAD=… jest` ran unasked in every mode (integ2-z-1, P1; -z-2 and -z-3, P2; -z-4 and
-z-5, P3). What npm, yarn, pnpm, bun and corepack (also pinned, `corepack yarn@4 …`) run by a script's name or hand on
to a program, what `node` hands a tool under `node_modules`, a `node_modules/.bin` path and npm's `.cmd`, `.bat` and
`.ps1` shims are now judged as the same words without the manager: a launcher or a program with a row is that program's
own line, any other name is the project's script and the words it is handed are read as an unknown program's. A
`NAME=value`, `name:value` or joined word is never taken for a plain file the user's words could announce, and a risky
assignment is never announced by words that name only the program. Tools known only by their verbs (tsx, ts-node, lerna,
nx, next, pre-commit) are judged behind a manager (commands-runners-y9-1, P1: they ran). `yarn env` and `npm run env`
print the environment (`secret.env`); a script's everyday name that is also a program (`pnpm format c:`, `pnpm watch
'…'`) is read as the program too. Its review (x9-1 to -x9-6: 2 P1, 4 P2: `name:value` words announced, `corepack yarn@4`
read as nothing, a bin with no row through node, the Windows shims, runner spellings that dropped `unknown.program`,
`pnpm format c:`) was repaired in 6 commits; its second review (commands-runners-y9-1 to -y9-3: 1 P1, 1 P2, 1 P3) was
resolved in 2, all but the P3. At the fix's end 1,186 cases were stricter than before the package, 1,015 of them
package-manager or launcher lines, and 264 distinct lines that ran before ask now, each read by hand: a launcher by its
path, through node or behind a manager (about 110), a secret's path or Ember's own, a publish, a deletion, inline code,
a shell's `-c`, pm2, a terminal or input program, `secret.env`, and the friction listed under Left. The everyday fixture
grew from 490 to 638 lines with none lost but two that moved to asks. Comparison on 596db8e (288,603 cases, five runs
against four baselines): 0 new failures (the 100 recorded), 0 weaker, 0 unproven, 0 outside the mode's limits; looser on
purpose 527 / 527 / 44,557 / 79,938 (Interactive, Assisted with no match, Assisted with a match, Autopilot); stricter
than 681c36a by 7,629; the guard trips as before (45.7% on the classifier probe against 4d64d3a). `npm test` 16,553
passed, 15 skipped, 0 failed; the policy proof was not run.

**Memory** (446846b, f2dbe1d). A Forget, a correction or Forget everything in Settings holds for the conversation it was
made in: nothing much like what went is kept again from a reply, a task's result or the remember tool unless it rests on
the user's own words (f48eaa7, 4ddcd8e, 4e79aef; memory-r9-1, -x9-2, -x9-3). Sign out, an account change and Forget
everything clear the last person's requests, so they don't come back as suggestion chips (97171c1; -r9-2). With memory
turned off by the organisation, or under a lockdown, Settings says so and still offers Forget and Forget everything
(cb74b03; -r9-3). The guard reads what a fact says as well as a secret's name: the re-rate's 41 of 49 secrets kept
became 0, and its review's 40 of 87 became 1 (a recovery phrase with no name the guard knows), with 2 of 152 ordinary
facts refused; over 341,599 lines and string literals and 1,337 whole files `memoryRefusal` answers as on main for every
one and nothing held before is let through (d21ad6f, 786409a, 99ff769; -r9-4, -x9-6, -x9-8). A name or answer length
told in conversation replaces the one from Tell Ember about you (a1cf408; -r9-5), though only where the user tells it of
themself: the first version took a name out of pasted text, the review's P1 (e2a1419, e6148af, 776f0df; -x9-1, -x9-4,
-x9-5). Where speech is unchecked the spoken “get to know me” opens the typed form instead of ending “I'll remember
that” over nothing kept (24b4207; -r9-6); recall says how many facts there are beside the six it gives (d13797d; -r9-7);
the daily question no longer asks who an app, a site, a setting or a place is, or again after “skip” (181c922, 399320d;
-r9-8, -x9-9); and -r9-9, -r9-10 and -r9-12 (307a695).

**Models and extensions** (bec8fde, 53a44ae). A tool that differs from what the user agreed to is taken out before the
session's first request, audited and marked “Changed since you agreed” in Home, and a server that says its list changed
leaves the session at once (a7ab82a, 1e4cbf4, d628488, ad95492, cd81b2d; integrations-r9-1, -x9-1, -x9-4, -y9-1). The
first fix was not enough: a server that answered Ember's own question as agreed and the runtime's with new text still
reached 4 of 4 later requests, and the notices held the conversation 27 s where main took 2.6 s; now no notice asks the
server anything (the same flood takes about 0.1 s), a second notice keeps the server out for the rest of the
conversation, and only tools whose own entry differs are marked. An honest plugin's no-argument tool is no longer marked
at every load (e8a4631; -x9-3). Projects names each file it refuses and why, takes ordinary source and build files, and
refuses password managers' exports and servers' password files again, which the first fix had let through by type
(84f5035, 69b38a5, 17b3a57; -r9-2, -x9-2, a P1, -x9-7). Saved workspaces stay listed when the provider's key or its
address at the same host changes (00e4177, f537d3b; -r9-3, -x9-6); removing or turning off an extension whose store
can't be written says so (bb8910b; -r9-4); and a key pasted with a hidden character is refused, never sent (afd0d14,
1713dc8; -r9-5, -x9-8). integrations-r9-9's fix (1ffce75) was taken back: the runtime puts its path after the address as
typed, query included, so main's check was the consistent one (50224a5; -x9-5).

**The vault** (slice 5, the owner's decision of 2026-11-12: Ember should “ask user once with a vault box where user can
enter information and it can use it without actually reading it”; the slices lane's vault-1 to vault-3, 18 commits from
6aa1945 to 16296e9, then the integration job's merge, review, repair and two checks, into the round at 21f7426). Three
kinds of entry, a login, a card and contact details, each bound to one destination: an app, or a site by its origin as
read from the browser at that moment, never from the page's words or a model. Ember asks once in its own Secure Form, a
window whose title, labels and line saying where the details are for it builds from the kind and the destination (secret
parts in password boxes; the sender and the form's id checked on its three IPC channels; Cancel keeps nothing). The
entries are sealed with `safeStorage`, never when its backend is `basic_text`, in `vault.json` in the data folder (0600;
200 at most; an entry moved by editing the file opens nothing), and Settings › Apps & privacy lists them by kind,
destination and date with Forget and Forget all; Sign out and Forget everything forget them too, and `features.vault:
false`, or a lockdown, turns the vault off. A fill is its own kind of step, `vault_fill`. The policy applies every
“never” first (never-look windows, the system's authentication prompts, Ember's windows, terminals, remote surfaces),
then allows a fill only in Autopilot, announced, in a field of the right role (a password in a password field, a card
number or security code in a secret field, contact details in a field whose own name says so), in the window of the
entry's own app or, for a site, where the address read now is the entry's own (a frame from another site refuses); no
grant, waiver or Assisted check can allow it, and where it may be a step the user said no to it is refused. The model
has one tool, `fill_from_vault`, which names a field and which part of which kind and nothing else. Ember fills it by
the accessibility helpers' own `vault_fill` operation, a method that exists only for this (on Linux, Windows and macOS),
else types it as key events under the borrow's rules, never through the clipboard, and says so when neither works. After
a fill nothing Ember reads, sends, logs or captures holds the value. One redactor (a list kept in memory for the run,
400 values at most; a value is found as filled, escaped, spaced and in the forms in which a site writes a card or a
phone number) stands at every place text leaves for a model, in the one client every session is made by (the conductor,
the workers and the one-shot reviewers), and in the audit log, the logs, screen text quoted whole before it is cut and a
command's output before its lines are cut; a field Ember filled is a secret field for the rest of the task, black in
screenshots, with no picture when that can't be done or a window's title says a value; and after a fill no extension is
called until Ember restarts. The leak test fills every kind of entry with canary values and looks for them in the
model's requests, the runtime's session files, every file in the data folder, the helper's command line and environment
and a screenshot (the leak and worker-safety integration tests: 103 passed, 1 skipped, the real-window journey, which only CI's `el8`
job runs); its first run found that a value with a hyphen made every pattern
invalid and went on unredacted, so a pattern that can't be built now refuses the fill. The first review (vault-3-x9-1 to
-x9-6: 2 P1, 3 P2, 1 P3) found that a secret under six characters (a card's security code) was hidden where it stood, so
the mark's place gave it away (a page listing 000 to 999 would show which was the code) and that the cut of a long
screen text could fall inside a value and pass its first part: such a secret is now never looked for in other text and
its field alone keeps it (`MIN_SECRET` of 6), and screen text is redacted whole before it is cut; the rest made an
extension's failure text a way for a value out (no extension after a fill, blunt on purpose), taught the redactor more
forms (card and phone numbers with up to three characters between digits, an expiry as MM/YYYY, a numeric entity for any
character) and made a 401st watched value refuse the fill. The second (vault-3-y9-1, P2): a command's output was cut
before it was redacted, and is now redacted whole first. The merge (b4e7441, nine conflicted files, all read on three
sides; nothing broke) was checked for the vault against the refusals, Assisted, Autopilot and the seal on 0fa8bf0, the redactor on every
client, commands' cuts, Ember's own windows, first run and the extensions gate; its review, repair and two checks found
no P1: the vault merge's integ-x-1 to -x-6 (2 P2, 4 P3), integ-y-1 to -y-4 (2 P2, 2 P3) and integ-z-1 to -z-4 (1 P2, 3
P3). A command's output over 4 MiB is cut between its first 64 KiB and its tail before the redactor sees it, so a value
on the cut left as a fragment (x-1): the cut now moves off any value (`clearCut`), judged on the text as it will be
read, and a value a colour or control code splits is found too (y-1); the model could type a detail itself into the
field after the user closed the Secure Form (x-2), and a closed form is now the user's no for the task's outcome (x-3);
“What Ember did” showed `vault_fill` (x-4) and Autopilot's card listed fewer kept questions than Ember asks (x-6).
Closing a form that could keep nothing (no keyring, or a Save the keyring, the disk or a full vault refused) was taken
for “You said not now” (y-2): it is answered as unavailable, nobody's no. Save took the first Enter (y-3): it ignores a
repeat and one within the prompt window's arm time. With no keyring the form came up once for every field of a sign-in
(z-2, P2: three forms for three calls): a per-task mark, set when a form answers unavailable (Settled (13)), shows one
and refuses the later fills in that task at once, telling the model in Ember's own fixed words that this computer can't
keep it. `clearCut` held the main thread 1.3 s a side (z-4): it now tries the nearest 64 places a side and then keeps
nothing of that side, 17 ms against 2.7 s; an unfinished escape took a value's first character and the rest went on
(z-1): the decoded text is redacted before the terminal codes are stripped as well as after. Gate on the vault's final
head (a08415d): lint, typecheck and build clean; `npm test` 520 files, 16,414 passed, 17 skipped, 0 failed; the leak and
worker-safety integration tests 103 passed, 1 skipped; the form's journey in a real browser 12 of 12; commands on this
computer 37 passed, 13 skipped; the kill-switch deadline 2 of 2. Policy proof on the merge: pass, 287,678 steps, 0
weaker, 52 stronger (allowed), 24 hard checks; its corpus has no `vault_fill` step, so “no mode but Autopilot fills” is
checked by `vault-fill-policy.test.ts` (3 modes chosen and agreed by 11 policies: a fill is denied in 31 of the 33 and
allowed only in Autopilot with no policy or with only the check off) and not by the proof. Commands comparison on the
repaired merge (a926584, 267,434 cases): 0 failures, weaker asks and unproven, 0 outside the modes' limits.

**The final merge** (the integration job's third run: r9/final off 237fd04, merging the command classes (465bb55), the
vault (a08415d) and this record's first pass (a3341f1)). A usage limit stopped two jobs at about 16:25 UTC on 13
November, this merge after its first two merges (f739499, 21f7426), which were committed with no notes, and
commands-runners. The owner said to carry on with the other models available; both jobs were relaunched and finished on
them, and the first two merges were treated as unverified: each was re-read with `git show --remerge-diff` against the
watch list, and the gate, the policy proof and the commands comparison were run on the tree. Nothing was wrong in
either: the command classes' merge had no conflict and no difference on a re-merge, and the vault was judged against the refusal rules as 681c36a left them; its only conflicts (the
imports of flow.ts and three neighbouring bullets of the rules file) were resolved as the union, every line from one
side. The record's merge (ea276ea) conflicted in one CHANGELOG bullet, written as both sides' sentences. Its review (the
final merge's integ-x-1 to -x-4: 1 P2, 3 P3) found this record contradicting the tree (x-1, this pass); first run's
words promising the AI model never types passwords where the vault now fills them (x-2: “It never lets the AI model type
or see passwords. Only in Autopilot, I can fill in a login, a card or contact details from my vault.”, aa60c19); no
`vault_fill` step in the policy proof's corpus (x-3, left, with the vault's integ-x-5); and a run of Azure Key Vault
secret ids that took 665 to 729 ms to redact where plain text of the same size took 158 (x-4). The fix for the last
(dfbac18) was found by the second review (integ-y-1 to -y-6: 2 P2, 4 P3) to hide less: a value after a note that names
another secrets address went on. The pattern that would hide as much while keeping the bound could not be shown, so by
the integrator's steer it was reverted whole (633b74a): redact.ts is byte for byte what it was before, and x-4 is open
again. Also from that review: at the end of a command run that kept 4 MiB of coloured output the main thread was held
1,360 ms with no vault entry, 1,834 ms with a login, a card and contact details noted and 2,793 ms with three of each
(y-2, P2), against Stop's 300 ms; before the vault the same run held it 1,459 ms, so most of it is the cost of cleaning
itself, older than the vault. The run's end cleaned the same bytes twice; it cleans once now (00dde72, byte for byte
what the model gets, checked on 4 MiB): 966, 1,286 and 1,716 ms. That is still past 300 ms, and is left (below). A Key
Vault secret printed value first, as the REST API does, was not hidden (y-3: 092b2e0); Apps & privacy promised a fill
from the vault where the organisation's policy had turned it off (y-4: 9c0e09c); COMMANDS-WSL-SSH.md named a switch the
window doesn't (y-5: 3a46a97: **Ask me before every command**, and Autopilot asking about a program Ember doesn't know);
and the first-run summary didn't say what the vault keeps (y-6: eaab87f). The check (z) found no P1 or P2: a
differential test of 134,247 generated outputs found nothing that the record merge's redactor hid left unhidden, and
67,787 more hidden now. Two P3s are left. Gate on eaab87f: lint, typecheck and build clean; `npm test` 521 files, 16,725
passed, 20 skipped, 0 failed; the kill-switch deadline 2 of 2; the Home journeys of its panes, first run and the vault
112 of 112 (all 15 journey files, 241 of 241, on the vault's merge); leak and worker-safety 103 passed, 1 skipped;
commands on this computer 37 passed, 13 skipped. Smoke (3 ok), the npm launcher's pack dry run and the sidecar's tests
(148, on this machine's python3, not RHEL 8's 3.6) ran on ea276ea, before the repairs. Commands-runners then merged
without conflict (fa19f89): lint and typecheck clean, `npm test` 16,860 passed, 20 skipped, 0 failed.

**Settled by the integrator, for the owner to overrule.** The owner's decisions left these open; each is written in
place in CLAUDE.md (“2026-11-12” or “2026-11-13, settled by the integrator”), `.claude/rules/agent-and-policy.md` and
§2, and the earlier section's Settled list stands as written there except its (3) and (7), which (1), (2) and (4) here
extend. (1) **A program Ember doesn't know asks in Autopilot**, as a command whose effect Ember can't tell: it may read
secrets or outlive the kill switch, the two things Autopilot keeps. For: neither can be ruled out for a program nobody
has read. Against: the owner's “it should do everything without asking me”, and the closed default makes this common
(against main, 24,878 of the comparison's cases are stricter by `unknown.program` alone and 1,935 by `unknown.verb`).
The user's own words naming the program announce it in every mode. (2) **Assisted never clears a program Ember doesn't
know that the words don't name** (modes-y9-6). For: the reviewer would be judging text whose effect nobody knows.
Against: commands-closed had left the class reviewable, and Assisted asks more. Text nobody can read behind known
programs (`eval $X`, an unread script) still goes to the check. (3) **After a no, only the recognisably same thing is
refused without a question; everything else that may be it asks for the rest of the task, in every mode, never checked
by Assisted and never announced by Autopilot or by the user's earlier words** (2026-11-13). For: three reviews each
found another way round a matcher of “the same thing”, and each wider matcher refused something the user had asked for,
silently. Against: more questions after a no, Autopilot's included: `git push origin feature` after a no to `git push
origin main`, and `rm -rf dist` after a no to `rm -rf build`, ask where they were announced; in Interactive, Delete of
“build” in Files after a no to `rm -rf build` asks where the wider matcher refused it. “Couldn't read” is taken as any
unclear or unknown finding in the refused command, wider than the steer's words; it only adds questions. (4) **Autopilot
keeps one more question, its sixth: a command of the same kind of danger as one the user said no to earlier in the
task** (their no again: it may be that one done another way). Autopilot's card named them only with the vault's bump of
its entry (version 2): “one whose effect it can't tell” covers a program Ember doesn't know, and “one you may have ruled
out” covers the user's own words, asking to be asked first, a deletion sent to the trash and the same kind of danger as
an earlier no. (5) **A step in an app that may be the refused thing is refused in Autopilot**, which has no question to
put for an app step (the takeover rule's precedent). Against: after a no to a command, any app step of its kind (any
deletion in any app after a refused `rm`) is refused until the user's next request; a real question there is new work,
recorded and not built. (6) **The refused kind is bound to the app**, not the window or the site. For: Send in a second
compose window stays refused. Against: in a browser a no to Delete on one site refuses Delete on every site, and a
refused Send in a mail app doesn't refuse a send through webmail in a browser. (7) **A no to a step the user didn't ask
for never silently binds their own request**: their own later step of that kind asks in Interactive and Assisted,
unchecked, and is refused in Autopilot. Against: “not flagged off-task” is weaker than “the user asked for it”. (8) **A
spoken yes on a command card**, **spoken requests and Assisted's check**, **switching modes by voice** and **the
system's authentication prompts never filled** are built as the earlier section's Settled 1, 2, 5 and 4 say; builder E
added that with Voice Match on but not ready nobody's voice chooses a mode that asks less, and that a switch never
agrees to a card.

Judgement calls the lanes made inside these, the owner's to overrule in the same way: a push of HEAD, `@` or a revision
is a push to its remote, so after a no to `git push origin HEAD` a push of another branch there is refused; a word Ember
can't resolve handed to a download-and-run asks in every mode (`npx tool $(date +%F)` asks in Autopilot); an alias, a
hash entry, a trap and a coprocess are held as outliving Stop in Assisted though they last only as long as their shell;
in Autopilot every `service.*` command (stopping one too) and every registry write asks, since the classifier tells
neither start from stop nor a Run key from another; `system.power`, foreground servers, `pkg.system`, `send.ssh`,
`cloud.change` and `system.settings` stay announceable in Autopilot; a risky control's Allow is spent when another
control of the page renames itself or a count in a sentence changes, and only an English list of counts is let through;
the kinds a refused risky step is read by keep three wide links (every security, privacy and system setting and every
step past a warning is one kind; on a page whose title mentions a payment every control is `pay`; a destructive shortcut
is delete, send and close at once); without a keyring Assisted's and Autopilot's agreements last until Ember quits, and
Interactive's own card is still taken from settings.json at start (forging it needs a step that asks below Interactive);
the refused `pkill -n server` family is refused again as at 4d64d3a, in words that are true, where main had come to ask
(commands-held-x9-7); and a project's own script calling a program Ember doesn't know runs as on main.

**Settled by the integrator after the third checkpoint, for the owner to overrule** (continuing the list). (9) **The env
launchers ask as programs Ember doesn't know.** `cross-env`, `cross-env-shell`, `dotenv`, `dotenvx`, `env-cmd` and
`with-contenv` have no row, whatever they are handed, as at 681c36a (the commands merge's integ-y-1, integ-y-2). For: a
launcher loads `./.env`, `.env-cmdrc` and the like with no option at all, which nobody has reviewed, and its assignments
(CC, LD_PRELOAD, NODE_OPTIONS) run code; a row would need every assignment and every file it loads judged in one change,
at the round's last stage. Against: `cross-env NODE_ENV=test jest` asks and its like (52 cases over seven launcher lines in the proof's first known file), and
the user's own words naming the program announce it only as for any program Ember doesn't know. (10) **Terminal tab and
session listings ask**: `it2api list-sessions`, `show-hierarchy` and `show-focus`, and `zellij action query-tab-names`,
`list-clients` and `dump-layout` lost the rows the commands lane gave them (`unknown.verb`: Autopilot asks, Assisted
never checks, the user's own words naming them announce). For: they print session and tab names the user may not mean to
share, and the lane's card line for a secret (“Reads what your own terminal shows”) would be untrue of a list of names.
Against: they only list; `zellij ls`, `zellij list-sessions` and `zellij --version`, `kitten @ get-colors`, `nvr
--serverlist` and `it2api --help` run, and tmux's listings (`list-windows`, `list-panes -F`, `display-message -p`) have
run since before the round. (11) **“Ask me first” holds the step the user's words name, and no other**: with `rm -rf
build` and “delete the build folder, but ask me first”, Autopilot asks; with “tidy up, but ask me first” it announces,
as an off-task step. Against: “ask me first” anywhere in a task could hold every command. “Don't ask me first” and “you
don't need to ask me first” beside a deletion also make Autopilot ask (the commands merge's integ-y-3, left: only ever
stricter). (12) **A redaction speed-up was reverted because it hid less** (633b74a, above): the run of Azure Key Vault
ids stays slow on adversarial output (0.7 s for 1.4 MB, as before the round's vault) rather than hide a value the old
pattern hid. Against: the stop is open again. (13) **A per-task mark, “the vault can't keep anything here”**: a Secure
Form that could keep nothing (no keyring, or a Save the keyring, the disk or a full vault refused) is shown once in a
task and answered as nobody's no, and later fills in that task are refused with no form, the model told in Ember's own
fixed words (the vault merge's integ-y-2, integ-z-2). For: one form per field of a sign-in is three forms for three
calls, and closing a form that could keep nothing isn't a no. Against: any unavailable sets it, a Save the disk refused
once included, so a passing failure means no more forms in that task, and a Cancel after a refused Save is nobody's no
though the person may have meant one. (14) **The vault's open calls, from its lane**, each the owner's: a secret under
six characters (a card's security code) is kept by its field alone, so a page that repeats the code outside its field
isn't hidden (the other road, not to keep or fill short secrets, was not taken); no extension is called after a fill
until Ember restarts (the narrower fix, ending the conversation from the failure hook when the error holds a value,
depends on what the runtime does with an abort there, which couldn't be checked); and the bubble and Home, which a
person reads, are not redacted.

**What CI found, and how each was settled.** The eval's two injection tasks and safety.test.ts in the `el8` job failed
from the third checkpoint: after a “Not now” to the hostile page's “Delete all”, the user's own “Add comment” was
refused without a question, because 445b38b counted a risky step of no known kind as every kind. The eval-fix lane's fix
(2f0d8d2) gave such a step no kind; its review found that fix a loosening in Assisted and Autopilot (a refused “Delete
history”, then “Clear history” done: evalfix-x9-2, P1) and an older fault since 445b38b (a no to a page's step refusing
the user's own: -x9-1, P1), so it was never pushed alone and its findings were repaired inside modes-y9; both jobs were
green at 3d9b4f2. project-live's first-run journey still expected memory off after the agreement: the test was stale,
the product right, and it now walks all five rows from a profile with no settings.json (8457532, f6a7edd; cifix-1). The
Windows job's hit test found another window over the Ask field once; the cause was not established (Ember's own hello
bubble is the candidate), so the test waits, names the window, and fails if one of Ember's own windows covers the field
for 2 s (4e110b2, 5a5ab72; cifix-2, cifix-x9-1); the job has passed since, the field under the pointer at once. The
`el8` voice step failed on two pushes, on different tests. At 03ebf5c it failed on the room-talk wake, having passed on
the six other pushes with the same voice code; voice-roomtalk reproduced and fixed it (above). At a3cf645 it failed on
the C API run, in a test this round added (8a52cd0: “never takes a refusal said as Ember stops reading its question for
a yes, and hears an answer said just after it whole”): “Yes, please.” said 0.3 s after Ember stopped was judged unclear
and nothing was sent, in one rendition of a synthesised voice, while the WebAssembly run passed (43, 1 skipped). Package
voice-answer-take measured it: 40 renditions of each of the three answers, replayed as the test replays them (Ember's
read-out until 0.1 s after “stopped”, the answer 0.3 s after it, in the room's noise), on both backends and on 681c36a.
3 of 120 came out as other words (“Yes, we.”, “Guess please.”, “Well, thanks.”), the same three on the C API and on
WebAssembly and on 681c36a, so a3cf645 changed nothing for any rendition. The product heard each take whole: the spotter
fired on none (the room-talk rule never applied), no take was judged cut by Ember's voice, and handed straight to the
recogniser with 0 to 500 ms of the room before them 1 to 2 of 40 for each phrase came out wrong at any lead, so no lead is
better. It is the synthesised voice's rendition, 1 to 2 of 40 for a phrase, under the brief's one in ten for a product
finding; the product then asks again and allows nothing, which is right. The test had asked for more than the product
promises (one chance rendition of each of three answers: it would fail about one run in fourteen), so it now tries up to four
renditions, the first that leaves must leave as the right answer in the answer window, none may leave as anything else
or be taken for begun under Ember's voice, and one must be heard; nothing in app/ changed (2efb088; the review's one
finding, P3, was a body line past 90 columns). It passed 44 of 44 on the C API and 43 of 43 with one skipped on
WebAssembly, twice each. The macOS job failed once on an accessibility key collision in a test's 200-row window: the
test now holds what the keys promise (product-platform-flaky-3), and the product finding behind it is left (below). The
checks job failed once in the device-code step on GitHub's own 400 `request_failed`: the step retries passing trouble
and still fails at once on a refused client id (093eaf2; product-platform-flaky-4). At 3d9b4f2 every job passed: 18,
with 4 skipped by design (publishing, macOS on Intel, SSH to Linux arm64, commands and SSH on macOS); no job failed at
0fa8bf0 or 681c36a; at a3cf645 `el8` failed in the voice step, as above. At 237fd04 (voice-answer-take merged) the `el8`
job was cancelled at its own 25-minute limit, 17 seconds into the second footprint run, with every test before it
passing: the speech step had grown from 10 min 15 s at 0fa8bf0 to 17 min 4 s (the room-talk test alone takes 190 s on
WebAssembly and 90 s on the C API, the answer-window tests about 60 s each), so the job's limit is now 40 minutes, with
no test skipped or shortened (c3eefc7). CI's result for the final head isn't known when this is written: it runs when
the branch is pushed, and the pull request records it. The `ssh-macos` job of remote.yml, which pull requests don't run,
has not been dispatched for install-docs-r9-1's fix. The macOS job was cancelled too at 237fd04, after 15 minutes with no
runner assigned (cause unknown, not re-run).

**The safety harnesses at the fifth checkpoint (681c36a).** Policy proof against main (01493d0): pass. Below Interactive
287,678 steps, 0 weaker and 52 stronger, all Enter or a click on a bare “Open” in a dialog that warns of harm, which
asks every time now (safety-privacy-r9-2) and is recorded as intended (`allow/intended-round9.json`); with those
allowed, Interactive decides as main's Work without asking with every scope on; Assisted with a check that never matches
decides exactly as Interactive; 24 hard checks pass. Commands comparison, 267,691 cases through the classifier and the
run_command flow: at the defaults 0 failures, 0 weaker asks and 0 unproven against 4d64d3a, 848a566 and 01493d0, the
4,233 commands looser than 4d64d3a all of the allowed kinds; with Assisted's check matching, 42,904 commands are looser
on purpose (asked, now announced) and 0 are outside the mode's limits; in Autopilot 77,141 and 0. In each run only the
comparison's plausibility guard trips: 49.1 % of what the baseline ran still runs, under its 50 % line. That is the
closed default, a sweeping tightening on purpose: at commands-closed's resolve, 73.1 % of what stopped running against
4d64d3a stopped for `unknown.program` or `unknown.verb` alone, and leaving those out reads 85.9 %. The guard was adapted
on that evidence in a copy of the harness and verified adversarially (whether a probe that hears nothing could now
pass), not lowered: sound in its logic at the second verification (no P1; every mutant still fails), but its fork had
gone stale when the modes' repair widened `RUNS_LATER` in the original (G2-1) and a probe deaf on one platform could
pass inside its margin (G2-2, P2: it needs a per-platform line, or a positive control: the candidate's own everyday
lines must run on both probes in every platform context). It was not used for the final runs, which therefore read as
before. a3cf645 adds only app/voice/engine.ts and its tests to 681c36a, which neither harness reads; the final tree's
numbers are in the paragraph after the gate's.

**Gate, and what could not run here.** On the merged tree at a3cf645: lint, typecheck and build pass; `npm test` 16,373
passed, 15 skipped, 0 failed; the voice suite on the voice lane's head 43 passed and 1 skipped on WebAssembly, 44 passed
on the C API. On earlier merged trees the full unit run had one to three time-sensitive failures while the harnesses ran
beside it (memory.test.ts's recall time budget, commands-redact's linear-time test, sidecar-host-e2e,
perception-sidecar's restart count), each passing alone. The build machine has no pyatspi or gi, so the Linux desktop
suites (AT-SPI, X11, desk, safety) did not run on it, and no gsettings schemas, so nor did the eval's settings tasks;
CI's `el8` and `eval` jobs run both, and its Windows and macOS jobs the native suites. Not run anywhere yet:
remote.yml's `ssh-macos` job, which pull requests don't run (install-docs-r9-1's fix for zsh's card rests on it); `npm
run eval:review` on the conversation's model; a real microphone and speakers, a real Windows loopback for the output
watch, and a screen reader.

**The safety harnesses on the final tree.** Policy proof against main (01493d0): pass on 21f7426, and again on eaab87f
by the final merge's check, 146 s: 287,678 steps, 0 weaker and 52 stronger (the same 52, allowed), flags lost 0, 24 hard
checks; none of the merges since touches the policy or the worker's action path. Commands comparison (against 681c36a,
4d64d3a, 848a566 and main, the default and the four modes), at the final merge's head eaab87f: 284,012 cases; 0 new
failures (100 against 681c36a, all recorded, none worse), 0 weaker asks, 0 unproven, 0 outside the mode's stated limits
(the modes' list of what outlives Stop now holds the command classes' rules) and 0 tighter than the defaults; looser on
purpose 79,461 in Autopilot, 44,363 in Assisted with a match (the check was consulted 43,836 times), 527 in Assisted
with none and 527 in Interactive; 4,121 looser than 4d64d3a, all of the allowed kinds, and none than 848a566 or main.
Only the guard trips, as at ea276ea, aa60c19 and eaab87f (the checks that measured it) (46.3% of what 4d64d3a ran on the classifier probe, 44.3% on the flow
probe; 49.3% and 47.9% against 848a566). Commands-runners was measured on its own tree (596db8e, above). The merged head
fa19f89 then had the whole gate and both harnesses on a frozen copy, one command at a time: lint and typecheck clean;
`npm test` 521 files passed and 2 skipped, 16,860 tests passed, 20 skipped, 0 failed; the kill-switch deadline test 2 of
2; the launcher's pack dry run; the sidecar's tests (148, on this machine's python3, not 3.6); the integration suite
with the speech models, 17 files and 218 tests passed, 567 skipped; the voice suite on WebAssembly 43 passed and 1
skipped, and on the C API 44 passed; the build; the renderer journeys, 15 files and 241 tests; the character lab; smoke,
3; the vault's leak and the worker's safety suites, 103 passed and 1 skipped. The policy proof passed there too with
the same figures (287,678 steps, 0 weaker, 52 stronger and allowed, flags lost 0, 24 hard checks), on a corpus gathered
before this round's tests and PLAN names (its `--check` says so). The commands comparison there ran 288,957 cases in
the default and the four modes: 0 new failures (100 against 681c36a, all recorded), 0 weaker asks, 0 unproven, 0
outside the mode's stated limits, 0 tighter than the defaults; looser on purpose 79,948 in Autopilot, 44,570 in
Assisted with a match, 527 in Assisted with none and 527 in Interactive; 4,121 looser than 4d64d3a, all allowed, none
than 848a566 or main; every run ends on the guard alone (45.7% against 4d64d3a). The commits after fa19f89 change only
ci.yml's time limit and these documents.

**Consent and departures.** `CONSENT_VERSION` went from 8 to 9 with slice 4 (the agreement now turns on what is left
switched on; 8 came with spoken answers before the round). `FEATURE_CONSENT_VERSION`: `autonomy` 2 to 3 (Interactive's
card, which replaced Work without asking's), new entries `assisted` (2 after -x9p-4) and `autopilot` (1, then 2 with the
vault: its card says Autopilot fills from the vault, and names “one you may have ruled out”). The vault took
`CONSENT_VERSION` from 9 to 10: “Before Ember starts” says what the vault keeps and that only Autopilot uses it, and,
from the final merge, that the AI model never types or sees passwords; the first-run summary says both in Ember's own
voice, with its lock line (“If you give me a login, a card or contact details in my Secure Form, I keep them in my
vault, locked with your computer's keyring.”), each paired with the full text's sentence; `CONSENT_CHANGES[10]` tells a
returning user. Neither is released (main has 8), so the final merge's two copy changes needed no bump. Interactive's
card still says “It never types passwords and never acts in sign-in prompts”, true of Interactive, which never fills;
changing it would bump `autonomy` for a true sentence. The voice lane bumped nothing: on Linux with parec the recogniser
now also reads up to 3 s of what the speakers' stream played, on this computer, to tell the speakers from the user; the
“Hey Ember” card, which first run's listening row shows in full, already says Ember listens to what the speakers play
for that (“Before Ember starts” itself doesn't), and nothing of it is kept, logged or sent; if the owner reads “listens”
more narrowly it is a bump. Memory's note was not bumped for the `<memory_changed>` note, which carries ids the
conversation already has and no fact. §2 changes with this record: “Approvals”, “Commands” and §5's Confirm row and
commands paragraph now say what the round built (Assisted's never-cleared list, Autopilot's kept questions, the rule for
a no, the closed default, `approvals.maxMode`, the yes asked by the voice's rise, the vault, the refusal of typing into
the user's terminals), and §1's commands paragraph says commands on this computer are on from first run. Recorded
because they change what a rule says: steps in the system's Settings and security apps no longer all ask in Interactive
(a switch or a choice there, and a first step there the user didn't ask for, do); the classifier's default is closed;
commands-held holds corrected option tables to 4d64d3a's reading, so some lines the manual reads as safe ask or are
refused; the eval's safety gate is measured in Interactive; and the mode can't be raised through settings.json.

**Left.** Open for round ten: its scores (the eleven challengers and the companion's re-rater this round deferred) and
CI's result for the final head. The re-rate's commands P1s are fixed as classes (commands-remote-r9-1 to -r9-7); -r9-9
to -r9-11 (P2) in part (the lists below); the vault answers every -r9-K3 gap but the ones its own left list names. Never
rated this round: the companion and Ask, and every area but integrations by a challenger. Not taken up: the challenger's
integrations-c9-1 to -c9-5 (P2: the review card shows less than the model reads of a tool; “every use is in What Ember
did” while it draws none; a question shows the first 200 characters of a call's arguments; the runtime follows a remote
server's redirect to a host no card named; a plugin whose program isn't installed is “Added” and never says why) and
-c9-6, -c9-7 (P3); commands-remote-r9-12 to -r9-16 (P3); voice-listening-r9-14, -r9-16 and -r9-17 (P3).

Modes: modes-y9-y9-8, partly (P2: a recipient or a selected file named only in a list or table, and a bare number in a
cell, don't spend a risky yes) and modes-y9-y9-10 (P3: `ssh-agent` and `ControlPersist` outlive Stop); the holding words
and the let-through counts are English only; HEAD is not resolved to its branch; ids a template builds from a new
program's name are reviewable in Assisted until judged; the card's held-back line was not looked at in a real render;
fill_cells has no “may be” tier; the item selected in a file manager is not among a refused step's words;
`showsEmberData` reads titles only (“settings.json - Notepad” isn't caught; the mode itself is behind the seal); the
extensions gate's expiry reads as a no, and a command stopped while running is not kept as refused; the double
announcement in an app the user didn't ask about; the check for WSL apps' steps; no standing mark on the bubble while a
task works in Autopilot; “replace” into an empty rich-text box; a command's card still says “Ember's review:” where Home
says check, and a question doesn't say that the check found no match (the audit does). From the eval-fix lane: L2 (P2: a
shortcut whose effect Ember can't tell has no kind), L4 and L5 (P3) and evalfix-x9-4 (P3: the worker-level test doesn't
pin safety.test.ts's three questions); its L1 was closed inside modes-y9 as evalfix-x9-3 (above). Slice 4: slice4-y9-2
(P3: two headings of “Before Ember starts” lead with the old default), -x9-5's rest (P3: the returning user's wording of
the full text; -x9-6 was closed by the modes' beb16d9, which starts the eval in Interactive), and first run's Agree has
only the time delay against a held key.

Voice: voice-listening-r9-10 (P2: “Okay?” by the voice's rise is taken; reading the rise needs recorded people first,
and may then only make Ember ask again); V2-S6 where nothing can tell (macOS, Linux without parec: after the user's “Hey
Ember” and a pause a video's “Okay.” is taken) and a video's “Ember, allow” on Windows and macOS, both under the owner's
“anyone heard”; Listen once marks nothing; a wake the stream's spotter missed (about 2 in 96 of a video's “Ember, …”
from idle) still opens its window, where only a yes it carries is read against the stream: a request it carries goes to
Copilot as before, on Linux with parec as the user's own words, and a conversation opens after it; V2-F1's owner
decision (a short nameless yes refused as too short without locking the question), not built; V2-F7's “Okay, Ember.”
(P3: answers nothing, as on main); voice-product-x9-3 (the owner's: whether a short correction said while a question
waits is a request; today it gets one unclear note and isn't sent); others' “go ahead” after the user's bare “Hey Ember”
in a busy room sent as a by-name yes (P2, as on main); V2-F13, partly; tasks-approvals-r9-10 (P3); voice-safety-x9-1's
and -x9-3's residues, which need a real Windows loopback, and -x9-2's (an 80 Hz square wave whose 1 to 8 kHz harmonics
the room is taken not to hear, which no speaker does, is still taken 9 of 48 times: recorded, not built; the thresholds
were tuned on synthesised voices and scripted rooms, not recorded people); on Windows a nameless yes in the 2.5 s after
a read-out in the system's voice is dropped, since the output watch knows Ember is speaking only from its own player (as
on main; it fails closed); whether V2-F6's second-voice tests pass on the Windows and macOS addon was not verified here
(P3; CI runs them); voice-roomtalk-x9-2 (P2, the owner's: “Number, can you pass the salt?”, “Amber, open the window
please.” are a wake's request from idle when the spotter fires, each a spelling real wakes come out as), -y9-1's
remainder (“Hey, I'm home.”, “Hey Emma, …” where the first check wrote “Hey Ember”), a two-word false alarm from idle,
“Hey Amber, allow.” in the answer window and “K-embler” (P3 each).

Product: safety-privacy-r9-6 (P3); other languages' download-warning wording; what else counts as a protection turned
off (“Turn off BitLocker”, “Add exclusion”, “Do not show this warning again”); GNOME Secrets and the browsers' own
password pages on the never-look list; `*_key=` over-redacted in logs; which button each toolkit makes a warning's
default (product-safety-y9-1's residue); product-ui-y9-1, -y9-2 (P3); tasks-approvals-r9-7, -r9-8; home-r9-2, -r9-4,
-r9-5; first-run-r9-3 to -r9-7, -r9-9, -r9-10, -r9-12, -r9-13; accessibility-r9-3, -r9-4, -r9-7, -r9-8;
voice-speaking-r9-4, -r9-5, -r9-7 to -r9-10 and the rest of -r9-6; short Italian and Portuguese messages still read in
Ember's English voice (product-platform-x9-1's rest) and “Read it out” over silence on a run's first try at speech
(-y9-2); reliability-r9-6 to -r9-9 and -r8-2; install-docs-r9-4, -r9-10; product-platform-flaky-3-F1 (P3, macOS: an
accessibility key changes when a hash collision comes or goes, so a field remembered secret only by its earlier key may
not be recognised; one secret by role or label still is); and the recommendation to run `ssh-macos` on pull requests
that touch commands. install-docs-r9-2, -r9-6 and -r9-8 are this record's own (CHANGELOG.md and STATUS.md).

Command classes and runners: commands-classes-y9-4's rest (P2: a command handed to a new terminal window or a detached
session, `xterm -e`, `gnome-terminal --`, `konsole -e`, `tmux new -d '…'` and `screen -dm`, asks as on main without the
inner command being read, so what is refused alone can be allowed there by a yes); -y9-6's rest (P2: PowerShell's `+`
joining a read into an address, a variable in a non-fetcher's address and xargs with no replace string handing words to
a sender run as on main); -y9-11 (P3: `python3 -m pydoc os`, `./build.sh release`, `npm run test:delete` and `python3 -m
ipykernel install --user` ask where main ran, and `cat my-passwords.txt` runs); `python3 -m unittest evil` and `python3
-m pydoc evil` of a downloaded module named without its path are not seen as naming the download (P2, as on main);
“trash the build folder” as the whole request announces `rm -rf build` (the commands merge's integ-y-6, P3, as on main).
From the fix's and the repair's own lists: `az keyvault secret show -o tsv --query value` prints the bare value (the
command itself asks), `git -C <a downloaded folder> status` and `chmod +x` of a download run as on main, a runner that
hands words to the project's own program (`go run x.go 'npm publish'`, `cargo run -- …`, `java -jar tool.jar '…'`,
`dotnet run -- …`, `npm test -- --exec '…'`) is not read, `$(… | sed s/:/-/g)` asks, a program named `constructor` or
`toString` ends unreadable (fails closed), the SQL files of -r9-4, `python3 -m myapp`, -r9-6's fetch routes, one-purpose
senders (they ask as unknown programs), -r9-11's files, and the owner's -r9-10 (three phrasings of a deletion held
back); commands-remote-r9-12 to -r9-16 (P3). The commands merge: integ-y-3 (P3, above), integ-y-4's code (P3: `git -c
remote.<name>.url=<helper>::x` and `git config -f .gitmodules submodule.<name>.url` carry no `unclear.git-ext`, on this
tree and at 681c36a), integ-y-5's rest (P3: a download told to detach when an interpreter, a build tool or a wrapper
runs it is announced in Autopilot), integ-y-7 (P3: when `heldByWords` makes Autopilot ask, the card gives no reason).
New friction (P3): `pm2 save`, `flush`, `env` and `monitor` and any pm2 or forever verb that isn't a listing ask; `tmux
-uL sock ls` and `zellij --max-panes 5 list-sessions` ask; `npm run build -- --clean` asks; `git clone
"https://github.com/$(git config user.name)/x"` asks. Commands-runners: commands-runners-y9-3 (P3: eight commit bodies
have a line of 91 columns); `npx`, `pnpm exec`, `yarn exec` or `npm exec -- cross-env LD_PRELOAD=… jest` asks but
without `unknown.program` (P3); `./node_modules/.bin/frobnicate LD_PRELOAD=/tmp/x.so` (a bin with no row, by its path,
handed an assignment) runs as on every baseline (P3); a project's publishing tool with no row run by a manager (`yarn
np`, `yarn gh-pages -d dist`, `yarn surge dist`, `yarn prisma db push`) runs, as on every baseline (the owner's
trade-off: asking would stop a project's own tools running by name); `[powershell] yarn frobnicate
$env:APPDATA\ember\settings.json` runs; `yarn frobnicate 'rm -rf ~/Documents'` is announced in Autopilot as `./tool '…'`
is; `frobnicate SHELL=x.sh` and `x=.npmrc` announce with “use frobnicate”; and friction that asks: `npm test --prefix r`
(npm's `--prefix` value is the name of the R program), `yarn next start`, `pnpm tsx watch src/index.ts`, `yarn nx serve
app`, a word Ember can't see handed to a script (`npm test "$EXTRA"`, `yarn test $FILE`), a program with a row as a
script's name or argument (`yarn test docker`, `yarn open`), and the publishing tools (`yarn vercel deploy --prod`,
`yarn lerna publish`).

The vault: the vault merge's integ-z-3 (P3: a fragment of a value at the cut of a run over 4 MiB where its printed form
doesn't fit the 8,192 characters looked at each side, or where it is split inside a DCS, APC or OSC string; it takes an
escape string of about 8 KB inside a value, such as an OSC 8 link, or a value over about 400 characters with a colour
code on every character), integ-y-4 (P3: an unanswered Secure Form never runs out of time; it needs the Confirmer's
limit made reachable and a rule for a form someone is still typing in, and meanwhile the wait counts as waiting on the
user and Stop ends it), integ-x-5 and the final merge's integ-x-3 (P3: the policy proof's corpus has no `vault_fill`
step; a new family of the shared harness, covered meanwhile by `vault-fill-policy.test.ts`), and their residues: a value
that an unfinished escape stands before and a colour code also splits loses all but its first character (integ-z-1); the
cost of `clearCut` with a password of 1,024 characters on the cut is 170 to 240 ms a side, and a value whose printed
form reaches more than 63 characters from the cut loses that side of the output (integ-z-4); after a closed form only
the field the fill named is kept as refused, a paste shortcut is judged as before (integ-x-2); a start failure's stderr
is kept to its first 8 KiB before anything reads it, and a remote's refusal reason is cut raw in flow.ts (integ-x-1,
integ-y-1); an Enter the Secure Form holds back is silent (integ-y-3); a Cancel after a refused Save is nobody's no
(integ-z-2). From the lane: forms the redactor doesn't find (base64, a reversed or full-width value, a reordered address
or a `<br>` between its lines, a name's parts apart, named entities beyond the five markup ones, “MMYY” with nothing
between, a card with four spaces between groups, an upper-cased password: vault-3-x9-5, P3); a short value that isn't a
secret part (an expiry, a two-letter name) is still marked where it stands alone, so a page listing every MM/YY shows
which is the expiry (P3, the owner's); an extension call already running when a fill happens can still fail with the
value in its text (vault-3-x9-4, P3); the audit log's `value` of a refused action is cut at 120 characters before the
audit's redactor sees it (P3: a value across the cut leaves its first part in the file, 0600, never sent); no test pins
main's quote maxima below the helpers' caps (vault-3-y9-1's rest, P3); a field a site prefilled with a vault value
becomes secret and the task can't type in it (P3); not built, by the slice's own list: adding or editing an entry from
Home, filling over SSH or in WSL and filling on Ember's desk. Not run here: the real-window leak journey (no pyatspi;
CI's `el8` job runs it), the Windows bridge's `fillValue` (never compiled here), macOS and a real keyring.

The final merge: integ-y-2's remainder (P2): the main thread is still held at the end of a command run that kept 4 MiB,
measured on eaab87f at 959 ms with no vault entry, 1,258 ms with a login, a card and contact details and 1,591 ms with
three of each (the resolver's figures 966, 1,286 and 1,716), against Stop's 300 ms. Where it goes (the resolver's
stages, 4 MiB of coloured lines): decode 3 to 6 ms, stripping the terminal codes 33 to 48, the vault's redactor 116 on the first pass (the text as printed) and
78 on the second (the clean text) with one entry, `redactSecrets` 392 to 456 (60 passes, the longest, the MySQL client's
pattern, 152), the check's own copy of the text 441 to 449 before the fix. It can't be cut into slices of whole lines
with the same bytes, because several passes match across lines with no bound (`PRIVATE_KEY`'s `[\s\S]*?`, the string and
OSC escapes, the vault's white space and invisible characters between words, Key Vault's 4,000-item run, the
list-argument patterns). The design that keeps the bytes identical by construction: (1) yield an event-loop turn between
whole-text passes, not slices (commands/redact.ts exposes its 60 passes as a list that `redactSecrets` folds and an
async variant awaits between; the vault's redactor does the same per pattern; `cleanOutput` becomes async, checks the
flow's Stop at each yield and returns nothing for the model when stopped), so the longest hold is the longest single
pass, 152 ms here, which adversarial output can make longer (integ-x-4's run), so that pattern needs its own bound
first; (2) cheaper by the same bytes (the colour codes make the whole text two-byte, which doubles the vault's passes: a
Latin-1 round trip halves them, and a prefilter skips values not present); (3) a regression test that the stop
shortcut's handler gets an event-loop turn within 300 ms while 4 MiB with vault values is cleaned, which can only fail
until (1) is built. integ-x-4 (P3, open again): a run of Azure Key Vault secret ids reads slowly (1.4 MB in about 0.7 s,
as before the round's vault), for a stop that provably hides no less. final-z-1 (P3): a Key Vault value in a flat
id-first object isn't hidden when an earlier id with no value comes before it and a stray `"value"` after (as at every
tree before; real `az` JSON closes each object with `}`, which ends the run); the reverted fix caught some of these.
final-z-2 (P3): Apps & privacy's new sentence, “Your organisation has turned off filling in logins, cards and contact
details from its vault.”, reads as the organisation's vault: it wants “Ember's vault”, and its pinned string changed
with it. Voice: voice-answer-take's rate for a real voice isn't measured (3 of 120 is the test voice's), and a
recogniser handed “Okay, go with it.” with 500 ms of the room before it came out empty 16 of 40 times on both backends,
which no path of the engine produces (its takes start 37 to 65 ms before the speech): a note for the day a take's
pre-roll is lengthened.

Commands: commands-held-y9-2's rest (P3: 418 lines of the form `cd X ; cd -- X && …` run where 4d64d3a, misreading `--`,
asked), -y9-3's rest (P3), -x9-8 (P3: nested held lines take about twice as long) and -x9-7 (the owner's);
commands-closed-y9-2 (P2: a path program counts as the project's own in whatever folder the model's `cwd` chose, as on
main), -y9-3's rest and -y9-7's rest (P3: `hugo`, `latexmk`, `exiftool`, `sox` still ask), -2 (P3: `pwsh run.ps1`
asks), -4 (P3: `bat --pager 'sh x.sh'` runs; commands-classes closed the rest of its family and commands-closed-1), `dart pub cache
clean` (P3), and the comparison's guard. Memory: memory-r9-11 (P3) and -y9-1 (P3: passphrase-style secrets said with a
verb or as a phrase are still kept); secrets still kept (a recovery phrase with no name the guard knows, a password's
hint, licence keys, passport, tax, health and plain account numbers, a date of birth) and ordinary facts still refused
(“The Wi-Fi is HomeNet5G”, a gate number); a forgotten fact reworded with no word in common can come back from a task's
result, or from the model saving it with remember against the note; Forget everything still leaves the Ask box's own
history of 20 requests, as on main; under the managed line `#memory-hint` still shows, and with memory off by policy and
nobody signed in the owner line still says “Sign in with GitHub to use saved memory” (memory-r9-3's rest); an installed
app's first word still silences a person of that name (memory-x9-9's rest: “Grace Hopper Simulator” and Grace); names
asked about are remembered only until Ember restarts; and the owner's: listing more than six facts when asked, Undo of a
Forget while the organisation has memory off, keeping declined names across restarts. Models and extensions:
integrations-x9-1's residue (P2, the owner's design: a remote server's notice a few milliseconds before a request is
built can put new text in that one request, at most twice a conversation); -y9-1a (P3: Home has no word for a server
held out for the rest of a conversation), -y9-2 (P3: workspace libraries orphaned under a replaced key stay unlisted);
-r9-1's rest (a server that lists otherwise to Ember's own probe than to the session shows the probe's list on Review
tools; the extra list after each call), -r9-3's (unlisted libraries of a service the user moved away from) and -r9-4's
(copied files after a removal that couldn't be saved); -r9-6's quoted JSON arguments and -r9-13, partly; -r9-7, -r9-8,
-r9-10, -r9-11, -r9-12 (P3); a key with a hidden character saved by an earlier build counts as no key while Home's row
says one is saved; and the owner's: whether Projects takes data and settings files (`.csv`, `.xml`, `.ini`, `.conf`),
refused meanwhile. Earlier rounds' Left stands except where this round's fixes are named above.

WSL1's lost tail (remote.yml's WSL1 job, run 43532157051 at b474faa): wsl.test.ts's 4 MiB check got 4,128,768 of
4,194,304 bytes back through `wsl.exe --exec /bin/cat`, exactly 64 KiB short, with exit code 0, after passing on every
earlier run. Ember's own job host doesn't relay stdout (it inherits it), so the loss is in wsl.exe's relay as the Linux
process exits (inferred). Ember now never takes WSL output as whole without an end marker: a WSL run ends with
`outputCut` (the model is told the output is incomplete, the command window says so) and a fixed script's output is no
answer, so a script read cut short is never judged as the whole script. SSH's framed stream needs no marker: its loss
can only come as ssh exits, which ends the link (runs end "lost"); a remote run whose last bytes don't arrive in time
ends with `outputCut` too. The 4 MiB channel check now takes every byte back while cat still runs, as SSH's link uses
the channel, and a second check runs 4 MiB through the runner and requires `outputCut` exactly when it came back short.
Left: only CI's WSL1 and WSL2 jobs run the new launcher and script texts on real WSL.
