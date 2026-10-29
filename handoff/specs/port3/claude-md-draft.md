# Draft: CLAUDE.md and .claude/rules after the Windows and macOS port

For the lead, to apply to the owner's files (`CLAUDE.md` and `.claude/rules/*` on
`ember-improve/20261021-apple-design`). Not committed anywhere. Written against that branch's text and the code at
`74a5cdc`; the docs it points to are on `port3/doc` (PLAN.md M11, docs/DEVELOPING.md §10–§13). Each part says what to
replace and gives the new text in the owner's style.

---

## 1. CLAUDE.md, first paragraph and the lists under it

Replace the first paragraph with:

> Ember is a desktop companion and agent for RHEL 8.4 (GNOME on Xorg, x86-64), Windows 10 22H2 and 11 (x64), and
> macOS 13 or later (Apple silicon; Intel Macs and macOS 13 best effort). A small character sits beside the cursor,
> answers questions and does tasks in the user's real apps, where they can watch. It is built with Electron 44 and
> strict TypeScript. The agent loop runs on the GitHub Copilot SDK: one conductor session, plus one hardened worker
> session per task. Ember reads and acts in apps through each OS's accessibility service: a Python 3.6 AT-SPI sidecar
> on Linux; on Windows and macOS a shared TypeScript host (Ember's own binary in Node mode) over a C# UI Automation
> bridge or the macOS AX API. Voice runs on the device with sherpa-onnx. Ember ships as an RPM and an AppImage, a
> Windows zip, and a macOS app (zip and dmg). Its windows use Apple's macOS 26 (Liquid Glass) design language, adapted
> to a desktop with no GPU.

In the docs list, change two bullets:

> - `PLAN.md` is the frozen v1 plan: §2 decisions, §4 task IDs (M0–M11; M11 is Windows and macOS), §5 safety, §6
>   release gates, §9 what comes after v1, §10 progress and departures. …(rest unchanged)
> - `docs/DEVELOPING.md` covers setup, commands, environment variables, native modules, packaging, the eval,
>   troubleshooting, where Ember keeps its data, and the current repository layout: §1–§9 for Linux, §10 Windows,
>   §11 macOS, §12 the platform layer, §13 CI.

In the rules list, add:

> - `platforms.md`: the platform layer, the accessibility host and the UI Automation bridge (Windows and macOS).

## 2. CLAUDE.md, Commands

After the "full gate" block, add:

> The gate runs on Linux. On Windows and macOS, `npm test`, `npm run build` and `npm run test:smoke` run too (CI runs
> the unit tests on all three, so they must pass everywhere), and the desktop suites run on their own OS with their
> variables, as CI's `windows` and `macos` jobs run them (the file lists are in ci.yml and docs/DEVELOPING.md §10.3,
> §11.3):
>
> ```sh
> # Windows (Git Bash), after npm run build
> EMBER_WIN32_TEST=1 EMBER_UIA_TEST=1 EMBER_WINSYS_TEST=1 node scripts/run-integration.mjs <files>
> # macOS: EMBER_DARWIN_TEST, EMBER_AX_TEST or EMBER_MACSYS_TEST, one per suite
> EMBER_DARWIN_TEST=1 node scripts/run-integration.mjs test/integration/darwin-desktop.test.ts
> npm run dev:mac                # macOS: Electron through LaunchServices, so permissions go to "Electron", not your terminal
> npm run package:win            # on Windows: dist/package/Ember and its zip
> npm run package:mac            # on a Mac: Ember.app, its zip and dmg, for that Mac's architecture
> ```
>
> - The Ember-level suites (`ember-win32`, `ember-darwin`) need the staged app: `EMBER_PACKAGED_APP=dist/package/Ember`
>   or `dist/package/Ember.app`.
> - Without the machine, run CI by hand for one OS: `gh workflow run ci.yml --ref <branch> -f only=windows` (or
>   `macos`). macOS minutes cost ten times Linux's, so don't run every platform for a one-OS change; `intel` adds the
>   Intel Mac job and `packages` keeps the packages (large, 3 days).

In "Useful switches", change the last sentence to:

> Ember's real data lives in `~/.config/ember/` (Windows `%LOCALAPPDATA%\ember`, macOS
> `~/Library/Application Support/ember`).

## 3. CLAUDE.md, Repository map

Replace the map with:

```
app/main/          Electron main: main.ts (wiring), windows.ts, overlay.ts + xshape.ts, handle.ts, ask.ts,
                   voice.ts, settings.ts, admin.ts, doctor.ts, hotkey.ts, x11.ts, follow.ts
  platform/        the one place that knows the OS: types.ts (the contract), index.ts (loadPlatform), compose.ts;
                   linux/ (adapters over x11.ts, xshape.ts, hands/* and the desk), win32/ and darwin/ (window
                   system, input, capture; system/: apps, policy, login item, setup checks, check-up rows)
  agent/           host, conductor, worker, tasks (TaskManager), confirm (Confirmer), killswitch,
                   presenter (what the bubble says), persona, worker-persona, session-config, auth, clipboard-formats
  policy/          policy.ts (PolicyEngine), audit.ts (AuditLog), vocabulary.ts (per-OS words), remote-surface.ts
  perception/      sidecar, elements (untrusted screen text), capture, marks, windows
  hands/           system.ts (tier 0, launchApp, appEnv), borrow.ts (tier 3), input.ts, keymap.ts, terminals.ts
  desk/            desk.ts (the Xvfb desk), agent-process.ts (every desk X call), view.ts
app/sidecar-host/  the Windows and macOS accessibility host (dist/app/ax-sidecar.cjs): protocol, ids, secrets,
                   labels, roles; providers/uia.ts, providers/ax-darwin*.ts, providers/fake.ts
app/preload/       one contextBridge preload per window
app/renderer/      home, overlay, handle, ask, mic, desk; shared/ember.css is the design system
app/shared/        IPC names and types, consent.ts, apps.ts; shortcuts.ts, words.ts, never-look.ts (one row per OS)
app/voice/         the voice utility process (wake word, VAD, ASR); models.ts pins the downloads
packages/          @ember/characters, @ember/bubble (BUBBLE_CSS), @ember/motion
sidecar/atspi/     ember_atspi.py (JSON-RPC over stdio) and test_ember_atspi.py
sidecar/uia/       ember_uia.ps1 (bootstrap), ember_uia.cs (the C# 5 UI Automation bridge), PROTOCOL.md
scripts/, packaging/, test/ (unit, integration, smoke, fixtures, mock-llm, demo), eval/
```

## 4. CLAUDE.md, Ground rules and Safety

Replace the **Platform** bullet with:

> - **Platform.** Ember targets three platforms, all switched on in `loadPlatform()`: the RHEL 8.4 family (also Rocky,
>   Alma and Oracle Linux 8) on GNOME on Xorg, x86-64, glibc 2.28 and the system's Python 3.6
>   (`/usr/libexec/platform-python`); Windows 10 22H2 and 11, x64; and macOS 13 or later (Apple silicon; Intel best
>   effort). Everything that differs by OS goes through `app/main/platform/` (`.claude/rules/platforms.md`). Linux
>   behaviour must not change when you work on Windows or macOS, and the Linux rows of every per-OS table are frozen.
>   Ember's desk is Linux-only. PLAN.md §1 lists what is outside v1: Wayland, RHEL 9 and 10, SSH, neural TTS, speaker
>   verification, screenshot OCR redaction and multi-pointer X. Work on those only when asked, and keep the X11 paths
>   working.

Add to the **Frozen decisions** departures list:

> - Ember.app's executable is `Contents/MacOS/Ember`, not Electron's name (an executable named "electron" makes
>   `app.isPackaged` false);
> - the UI Automation bridge's `PSModulePath` is set to Windows PowerShell's own modules folder, not removed;
> - a Mac needs Input Monitoring before Ember borrows the keyboard, until a real Mac shows key-state polling isn't
>   gated by it.

In **Safety and privacy**, make the OS-specific bullets OS-neutral:

> - Approval comes only from a click in Ember's bubble or corner card, or from the allow and not-now shortcuts while a
>   question is up (Ctrl+Alt+Y / Ctrl+Alt+N on Linux, Win+Alt+Y / Win+Alt+N, Control+Shift+Command+Y / N). Never from
>   voice or the model.
> - It never acts in authentication windows (polkit, keyring, pinentry, sudo; UAC, Windows Security and credential
>   prompts; SecurityAgent and Keychain prompts). While one is open, it reads, captures and sends nothing.
> - On Windows it never acts in a remote surface (Remote Desktop and WSLg windows, `policy/remote-surface.ts`) and
>   blacks them out of screenshots: it can't see what runs inside.
> - **Kill switch.** The stop shortcut (Ctrl+Alt+X, Win+Alt+X, Control+Shift+Command+X), "Ember, stop" and "Stop
>   everything" call `KillSwitch.pull()`, … (rest unchanged)
> - `~/.config/ember` is mode 0700 and the audit files are 0600. Windows ignores those modes, so there privacy rests
>   on `%LOCALAPPDATA%`'s per-user permissions. … (rest unchanged)
> - **Admin policy.** It can only tighten Ember, and anything but "not there" that keeps Ember from trusting it applies
>   `LOCKDOWN`. Linux: `/etc/ember/policy.json`, root-owned, not writable by group or others. Windows: the `PolicyJson`
>   value of `HKLM\SOFTWARE\Policies\Ember` (no file; `provider.apiKeyFile` locks down there). macOS:
>   `/Library/Application Support/Ember/policy.json`, with the same checks on the file and its folder.

In **Writing UI copy**, replace the **Shortcuts** bullet with:

> - **Shortcuts.** Take a shortcut's words from `SHORTCUTS[os]` (app/shared/shortcuts.ts: `label`, `keys`, `say`);
>   never write "Ctrl+Alt" into copy. Name a shortcut only if Ember holds it (`hasKey`, `questionKeyHint()`), because
>   another app may have taken it.

## 5. CLAUDE.md, Code conventions, Testing and Gotchas

Replace the **Electron imports** bullet's last sentence with:

> Code in agent/, perception/, policy/, hands/, desk/ (except view.ts), platform/ and app/sidecar-host/ must load
> under plain Node; Electron objects reach it through structural types (`ScreenLike`, `OwnWindowHandle`).

Replace the **koffi** bullet with:

> - **koffi.** Never call `koffi.view()`, which aborts Electron (lint enforces this); copy with
>   `koffi.decode(ptr, "uint8_t", n)`. Load koffi lazily inside the function that opens a backend, never at import
>   time, so every module imports on every OS; guard every `koffi.load`. Bind a library once per module, never per
>   call or per frame; koffi type names are process-wide (pass structures as Buffers, or name a type `Ember…` and
>   define it once); Win32's `BOOL` is `int`. Keep one X connection
>   open per display. `platforms.md` has the rest.

Replace the **Native code** bullet with:

> - **Native code.** Prefer koffi, WASM or prebuilt binaries over native addons. On Linux every binary must need glibc
>   2.28 or older (`packaging-and-ci.md`); Windows and macOS ship each target's own builds.

In **Where tests go**, add:

> Tests that need Windows or macOS go in `test/integration/*.test.ts`, skip on other OSes, and fail instead of
> skipping when their variable is 1 (`EMBER_WIN32_TEST`, `EMBER_UIA_TEST`, `EMBER_WINSYS_TEST`, `EMBER_DARWIN_TEST`,
> `EMBER_AX_TEST`, `EMBER_MACSYS_TEST`). A check the CI runner can't make prints "not testable on this runner:
> <reason>", never passes. Unit tests run on all three OSes in CI: compare paths with `path.join`, and don't rely on
> POSIX tools or modes.

Add to **Gotchas**:

> - On macOS, permissions go to the app macOS holds responsible: your terminal for `npm run dev`, "Electron" for
>   `npm run dev:mac`, Ember for Ember.app. Every ad hoc build is a new identity: remove Ember from each list and add
>   it again after installing one.
> - On Windows, the first accessibility read after a change to `ember_uia.cs` compiles the bridge (seconds); the
>   build is cached in `%LOCALAPPDATA%\ember\uia-cache`. Keep the bridge's files ASCII and C# 5.
> - CI's Windows runner is Windows Server 2022, elevated, with one 1024×768 screen; its macOS runner's permissions come
>   from its own processes, so only the LaunchServices check-up says what Ember.app gets.

## 6. New file `.claude/rules/platforms.md`

```markdown
---
paths:
  - "app/main/platform/**"
  - "app/sidecar-host/**"
  - "sidecar/uia/**"
  - "test/integration/win32-*.test.ts"
  - "test/integration/darwin-*.test.ts"
  - "test/integration/ember-*.test.ts"
  - "test/integration/uia-*.test.ts"
  - "test/integration/ax-sidecar*.test.ts"
  - "test/fixtures/win_bench.ps1"
  - "test/fixtures/mac_bench.js"
  - "app/shared/shortcuts.ts"
  - "app/shared/words.ts"
---

# Platforms: Linux, Windows and macOS

Everything that differs by OS lives in `app/main/platform/` (PLAN.md §2 "Platform layer", M11). `loadPlatform()`
(index.ts) picks the backend by `process.platform` alone, never by `$DISPLAY`, and main gets one `Platform` object:
window system, input, overlay shaping, the accessibility helper's launch, `system` (apps, settings, paths, policy,
login item, audit sink, checks, check-up rows, vocabularies, words, shortcuts) and the desk (Linux only).
`types.ts` is the contract. docs/DEVELOPING.md §10–§12 has the detail.

## The boundary

- **One composition root.** Outside `app/main/platform/`, main never tests `process.platform` and never calls
  `getNativeWindowHandle()`: ask the `Platform` object (`platform.os`, the window system's `windowId`).
  test/unit/platform-boundary.test.ts enforces it; an exception needs a reason in its `ALLOWED` list. Data that is
  read at module load uses `HOST_OS` (platform/os.ts).
- **Linux doesn't change.** The Linux backend wraps today's X11 modules. Work on Windows or macOS must leave Linux's
  log events, model-facing text, keystrokes and sidecar launch exactly as they were, and the Linux row of every
  per-OS table equal to its frozen copy in the tests.
- **Plain Node.** Nothing under platform/ or app/sidecar-host/ imports `electron`. Electron's objects come in through
  structural types (`ScreenLike`, `OwnWindowHandle`, `PlatformDeps.electron`), so the unit tests run under Node.
- **New members are optional.** Add a member to a shared type only as optional, with a default that keeps the other
  OSes as they are. An extension one OS needs stays on that backend's own type (as `Win32WindowSystem.activate` does).

## Conventions every backend keeps

- **Units** are native: physical pixels on Linux and Windows (Per-Monitor-V2), points on macOS, the same unit in the
  window system, input, capture and the accessibility host. Coordinates may be negative off Linux: check a point with
  `onScreen()`, never against 0 or `screenSize()`. Only Ember's own windows use DIP, through `toDip`/`toDipPoint`.
  A capture is one image pixel per screen unit (macOS resamples to points), or masking misses.
- **Window ids** are one number space per backend (X window, HWND, CGWindowID), compared with `===`. Ember's own
  windows are told by `pid === process.pid`.
- **App names**: WM_CLASS on Linux; Windows the program's file name without `.exe`, lower case as the system reports
  it (`conhost` for a console window, the hosted app's program for a UWP frame); macOS the localised app name. The
  accessibility helper reports the same name, so policy, never-look and grants match.
- **Keys** are X keysym names and numbers; mouse buttons X's numbers (1 left, 2 middle, 3 right, 4–7 wheel) and mask
  bits (256, 512, 1024). Key codes are opaque per backend and never 0.
- **Per-OS data** lives once, keyed by OS, with Linux's row frozen: `app/shared/shortcuts.ts` (shortcuts and the
  primary modifier: `mod` is ctrl on Linux and Windows, cmd on macOS), `app/shared/words.ts`,
  `app/shared/never-look.ts`, `app/main/policy/vocabulary.ts`, `app/main/hands/terminals.ts`,
  `app/main/agent/clipboard-formats.ts`, `app/main/policy/remote-surface.ts`. Add a word to its OS's row, with a
  positive and a negative test.

## koffi

- Load it lazily: through `createRequire(__filename)` inside the factory (`open…()`, `loadWin32()`) that runs only on its
  own OS, never at import time, so every module imports on every OS (the unit tests import them on Linux).
- Bind each library once per module (memoise the bindings), never per call or per frame. Guard every `koffi.load`: a
  missing library or symbol gives null or a safe default, never a throw at import.
- koffi type names are process-wide: pass structures as Buffers (`void *`), as the Windows backend does, or give a named
  type an `Ember` prefix and define it once (`EmberWin32Point`; `EmberCGPoint` through darwin/native.ts's
  `namedStruct()`, which reuses a type already defined).
- Win32 `BOOL` is `int` (koffi's `bool` is one byte). Pointers come back as BigInt or null. HKEYs are passed as
  `intptr_t`.
- Never call `koffi.view()` (lint enforces it); copy native memory with `koffi.decode(ptr, "uint8_t", n)` or a typed
  decode. Release what you retain (CFRelease) on every path.
- Never make a synchronous cross-process call that can wait on another app from Electron's main thread: AX calls in
  main use the 0.25 s timeout, a broadcast uses koffi's async form, `SetWindowPos` is asynchronous.

## Fail closed

- A check that can't run refuses, answers null or sends no image: `systemDialogOpen()` is true when it can't tell;
  macOS captures only with Screen Recording; input is refused for an elevated window (Windows), without Accessibility
  or Input Monitoring, with secure input on, or with an input method selected (macOS).
- Admin policy: anything but "not there" that keeps Ember from trusting it locks Ember down (registry errors, wrong
  type, too large, bad JSON; a folder or file not owned by root, writable by others, or a link).
- Never work around an administrator's choice: execution policies, Constrained Language Mode, AppLocker and WDAC are
  reported with their reason, never bypassed. The only fix Ember applies, **Unblock it**, runs when the user presses
  it, only for `RemoteSigned` with the Mark-of-the-Web, and only on Ember's two helper files.
- The accessibility host never reads Ember's own process (`EMBER_OWNER_PID`) and never reads a password field's value.
  Apps Ember opens get Explorer's or launchd's environment, never Ember's (`explorer.exe`, `/usr/bin/open -a`; never
  ShellExecute, `shell.openPath` or a shell).

## The accessibility host and the bridge

- `app/sidecar-host/` speaks exactly the Linux sidecar's JSON-RPC (methods, shapes, error wording, AT-SPI roles), so
  `AtspiSidecar` and perception don't change. Platform knowledge stays in the providers; shared rules (ids, secrets,
  labels, budgets, verification) stay in the host. Secret words come from perception/elements.ts: no third copy.
- The UI Automation bridge (`sidecar/uia`) is C# 5 for .NET Framework 4, compiled by Windows PowerShell 5.1's
  `Add-Type`: keep `ember_uia.ps1` and `ember_uia.cs` ASCII, and no screen data through a PowerShell cmdlet.
  sidecar/uia/PROTOCOL.md is the wire contract; `test/unit/uia-files.test.ts` checks its method list. CI compiles the
  bridge by running `ember_uia.ps1` itself.
- The macOS AX provider gives each app 0.8 s and marks a slow one busy; it never raises a window.

## How to test

- Put decisions in pure functions and test them on Linux with fakes: `test/unit/platform-*`, `win32-*`, `darwin-*`,
  `sidecar-host-*`, `vocabulary-*` (the fakes are `*-fakes.ts` beside them). A composition test passes a `screen`
  Proxy that throws, to prove nothing touches Electron's `screen` before ready.
- Real-OS tests go in `test/integration/`: `describe.skipIf(!onWindows && !required)` (or `onMac`), where `required`
  is its variable: `EMBER_WIN32_TEST` (window system, input, Ember-level), `EMBER_UIA_TEST` (bridge and host),
  `EMBER_WINSYS_TEST` (system integration, vocabularies), `EMBER_DARWIN_TEST`, `EMBER_AX_TEST`, `EMBER_MACSYS_TEST`.
  With it set they fail, naming what is missing, instead of skipping.
- Facts a runner can't show (Windows Server, elevated, one screen; macOS grants from the runner's own processes) are
  printed as "not testable on this runner: <reason>" from `EMBER_CI_*`, never passed. Add each such item to PLAN.md §9
  item 7.
- A suite that needs the packaged app reads `EMBER_PACKAGED_APP`. Add every new integration file to its job's list in
  ci.yml (`run-integration.mjs` fails on a missing file, so a rename can't skip silently).
- Without a Windows or macOS machine, run CI for that OS only: `gh workflow run ci.yml --ref <branch> -f only=windows`.
  Unit tests run on all three OSes in CI, so keep them portable.
```

## 7. Changes to the existing rule files

`agent-and-policy.md`:
- **Launching apps on the user's screen**: "Use only `launchApp()` … runs `gtk-launch <desktop id>`…" is Linux's.
  Add: "On Windows and macOS the platform's `system.apps.launch` does it: the terminal check first, then
  `explorer.exe` with the Start Menu shortcut or `shell:AppsFolder\<AUMID>` (Windows) or `/usr/bin/open -a <bundle>`
  (macOS), so the app gets the shell's or launchd's environment, never Ember's."
- **The overlay**: "Its X input shape is exactly the rectangles…" and "No-ops on Linux" are Linux's. Add: "Off Linux
  there is no input region: hover polling flips `setIgnoreMouseEvents` (`forward` only on macOS), and the overlay,
  handle and ask box are `toolbar` windows on Windows and non-activating `panel`s on macOS, with no
  `setVisibleOnAllWorkspaces` call there (it would hide the Dock icon)."
- **The audit log**: "The journald copy…" add "(Linux only; Windows and macOS keep the file alone)".
- **The admin policy file**: name the three locations as in §4 above.

`packaging-and-ci.md`:
- Opening line: "Ember ships as an RPM and an AppImage built on EL8, a Windows zip built on Windows, and Ember.app (zip
  and dmg) built on a Mac; every Linux binary must run on RHEL 8.4's glibc 2.28."
- **Building packages**: add "`npm run package:win` and `npm run package:mac` build on their own OS only (stage.mjs
  never cross-stages; `scripts/package/layout.mjs` says what each target holds). On Windows, `exe-resources.mjs` gives
  Ember.exe its own version resource and icon with `resedit` and drops the certificate table before the fuses are set;
  on macOS, `mac-bundle.mjs` edits Info.plist and signs ad hoc last. Keep `CFBundleExecutable` `Ember`."
- **Dependencies and CI**: add "The `windows`, `macos` and `macos-x64` jobs: macOS minutes cost ten times Linux's, so
  keep the macOS steps lean, and use the manual inputs (`only`, `intel`, `packages`) instead of extra jobs.
  `.cmd` and `.bat` files are CRLF (.gitattributes); everything else LF. `scripts/package/tcc.mjs` writes the macOS
  grants (runners only)."
- **Test gates**: add the six Windows and macOS variables (as in platforms.md).
- **Package tests that read source text**: add "packaging.test.ts also reads ci.yml's Windows and macOS steps (the
  runner facts, the bridge compile, Ember.exe's version and signature, `--forbid shortcut.unavailable`, the TCC
  grants, the Intel job's condition) and package.json's `dev:mac`."
- `paths`: nothing to add (platforms.md covers the platform files).
