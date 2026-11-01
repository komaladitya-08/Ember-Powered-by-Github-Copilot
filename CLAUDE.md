# Ember

Ember is a desktop companion and agent. A small character sits beside the cursor, answers questions and does tasks in the user's real apps, where they can watch. It runs on RHEL 8.4 and its family (GNOME on Xorg, x86-64; the first platform), on Windows 10 22H2 and 11 (x64) and on macOS 13 or later (Apple silicon). It is built with Electron 44 and strict TypeScript. The agent loop runs on the GitHub Copilot SDK: one conductor session, plus one hardened worker session per task. Apps are read and used through the system's accessibility: a Python 3.6 AT-SPI sidecar on Linux, a C# UI Automation bridge on Windows and an AX provider on macOS. Ember can also run commands in its own command window, on this computer, in WSL distros and on computers reached over SSH (off until the user turns each on). Voice runs on the device with sherpa-onnx (its WebAssembly build on Linux, its native addon on Windows and macOS): "Ember" or "Hey Ember" by keyword spotting, Silero VAD, Moonshine v2 and optional Voice Match; replies are spoken in Ember's own Piper neural voice (or, opted into on Windows and macOS, Kokoro), and in the system's voices until it is downloaded. Ember ships as an RPM and an AppImage (Linux), a zip (Windows) and a zip and a dmg (macOS), published to GitHub Releases from CI, plus the `ember-copilot` npm launcher (`packages/npm`), which downloads and starts the matching release. Its windows use Apple's macOS 26 (Liquid Glass) design language, adapted to a desktop with no GPU.

The detail lives in the docs. Read the one for the area you are changing:
- `PLAN.md` is the frozen v1 plan: §1 what v1 runs on, §2 decisions, §4 task IDs (M0–M12; M11 is Windows and macOS, M12 SSH, WSL and commands), §5 safety, §6 release gates, §9 what comes after v1, §10 progress and departures. Where it and docs/RESEARCH.md differ, PLAN.md wins. Where §10 records a departure from §2, the code follows §10. §3's layout was the v1 target and is out of date.
- `docs/DEVELOPING.md` covers setup, commands, environment variables, native modules, packaging, the eval, troubleshooting, where Ember keeps its data, Windows (§10), macOS (§11), the platform layer (§12), CI (§13), SSH, WSL and commands (§14), publishing a release (§15) and the current repository layout.
- `docs/COMMANDS-WSL-SSH.md` is what users and administrators see of commands, WSL and SSH; README.md and CHANGELOG.md say what ships.
- `docs/DESIGN.md` covers the characters, the rig, the bubble, motion and the design system.
- `docs/RESEARCH.md` holds the background evidence.
- `docs/ASSISTANT.md` is the plan for voice latency, recognition, a natural voice and a smaller footprint, with the
  measurements behind it.
- `docs/MEMORY.md` is the long-term memory design: what it keeps, the safety limits, and the plan.
- `docs/CONVERSATION.md` is the proposed conversational voice mode (PLAN.md §9 item 9): measured voice latency and the ranked changes.

Topic rules in `.claude/rules/` load when you open matching files:
- `design-system.md`: renderers, windows, the bubble, the characters and the icon.
- `agent-and-policy.md`: agent, policy, hands, perception, desk, platform, commands and targets, voice, settings, sidecars and eval.
- `python.md`: all Python.
- `packaging-and-ci.md`: scripts, packaging, the npm launcher, workflows and dependencies.

## Commands

Use Node 22.12 or later and npm 11.6.2 (`engines` and `packageManager` in package.json). npm 10 crashes with "Cannot read properties of null (reading edgesOut)"; fix it with `npm install -g npm@11.6.2`. Install with `npm ci`. Where the Electron binary can't download, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` is enough for lint, typecheck, unit tests and build; `npx install-electron` fetches the binary later.

```sh
npm run dev                    # build into dist/app (scripts/build-app.mjs) and launch Electron; on a Mac: npm run dev:mac
npx electron . --no-sandbox    # as root or without user namespaces; development only
npm run doctor                 # the setup check-up (`ember doctor`)
```

The full gate, in CI's order. Run all of it before you push, and put the commands and their pass and skip counts in the PR:

```sh
npm run lint
npm run typecheck
npm test                         # vitest: test/unit/** and packages/**/*.test.ts
npm run test:sidecar             # python3 -B sidecar/atspi/test_ember_atspi.py
node scripts/voice/prepare.mjs   # speech models (SHA-256 checked) for the voice tests
EMBER_VOICE_TEST=1 npm run test:integration
npm run build
npm run build:lab                # demo/character-lab → dist/ember-character-lab.html
xvfb-run -a npm run test:smoke   # launches dist/app, so build first; adds --no-sandbox as root
```

- Linux desktop suites (AT-SPI, X11, desk, safety) run as in CI's `el8` job: `EMBER_ATSPI_TEST=1 dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" npm run test:integration -- <files>`. The file list is in `.github/workflows/ci.yml`. The Windows and macOS suites are in docs/DEVELOPING.md §10.3 and §11.3; the commands, WSL and SSH suites (CI's `remote.yml`) in §14.4–14.5.
- The eval drives real windows, so give it a display and a session bus, as CI's `eval` job does (with gedit installed): `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node eval/run.mjs`. For a partial run use `node eval/run.mjs --only <id> --no-gates`.
- Without Copilot, start the mock model with `node -e 'import("./test/mock-llm/server.mjs").then(m => m.startMockLlm({ port: 18090 })).then(s => console.log(s.baseUrl))' &`, then run `EMBER_TEST_PROVIDER_URL=http://127.0.0.1:18090/v1 npm run dev`.
- Useful switches: `EMBER_USER_DATA` (a throwaway settings and logs folder), `EMBER_LOG_LEVEL=debug`, `EMBER_PYTHON`, and `EMBER_LOG_STDOUT=1` (logs to stdout from an installed Ember; development already does this). Ember's real data lives in `~/.config/ember/` (Linux), `%LOCALAPPDATA%\ember` (Windows) or `~/Library/Application Support/ember` (macOS).
- Also available: `npm run rebuild:el8`, `npm run check:symvers`, and the packages, each built on its own OS (see `packaging-and-ci.md`): `npm run package` (RPMs and AppImage, on EL8 or in `rockylinux:8`), `npm run package:win` (on Windows) and `npm run package:mac` (on macOS).

## Repository map

```
app/main/          Electron main: main.ts (wiring), windows.ts, overlay.ts, handle.ts, ask.ts, voice.ts, settings.ts,
                   admin.ts, doctor.ts, hotkey.ts, page-prefs.ts; x11.ts + xshape.ts (Linux, behind platform/linux)
  agent/           host, conductor, worker, tasks (TaskManager), confirm (Confirmer), killswitch,
                   presenter (what the bubble says), persona, worker-persona, session-config, auth, github-app
  policy/          policy.ts (PolicyEngine), audit.ts (AuditLog), vocabulary.ts, target-rules.ts
  perception/      sidecar, elements (untrusted screen text), capture, marks, windows
  hands/           system.ts (tier 0, launchApp, appEnv), borrow.ts (tier 3), input.ts, keymap.ts, terminals.ts
  desk/            desk.ts (the Xvfb desk, Linux), agent-process.ts (every desk X call), place.ts, view.ts
  platform/        everything that differs by OS: types.ts (the contract), index.ts (loadPlatform), linux/, win32/, darwin/
  commands/        run_command's flow, the command classifier, output shaping, the command window; run/: runners
  memory/          long-term memory (docs/MEMORY.md): graph, recall, consolidation, secret guard, MemoryService
  targets/, wsl/, remote/   which computers exist and binding a task to one; WSL; the PC's side of SSH
app/remote/        ember-remote, the agent Ember runs on a computer reached over SSH (plain Node 24)
app/askpass/       SSH's password helper on Linux and macOS
app/sidecar-host/  the Windows and macOS accessibility host (UI Automation and AX providers)
app/preload/       one contextBridge preload per window
app/renderer/      home, overlay, handle, ask, mic, desk, command, prompt; shared/ember.css is the design system
app/shared/        IPC names and types, consent.ts, apps.ts, per-OS tables (shortcuts.ts, words.ts, never-look.ts)
app/voice/         the voice and speech processes (Voice Match too), runtime.ts (native or WASM); models.ts pins the downloads
packages/          @ember/characters, @ember/bubble (BUBBLE_CSS), @ember/motion; npm/ (the ember-copilot launcher)
sidecar/           atspi/ (ember_atspi.py, Linux and WSL), uia/ (the Windows bridge), notice/ (a remote's Stop notice)
scripts/, packaging/, test/ (unit, integration, smoke, fixtures, mock-llm, demo), eval/
```

## Ground rules

- **Platforms.** Linux is the RHEL 8.4 family (also Rocky, Alma and Oracle Linux 8): GNOME on Xorg, x86-64, glibc 2.28 and the system's Python 3.6 (`/usr/libexec/platform-python`); capture, input and the overlay rely on X11 there, and Ember's desk is Linux-only. Windows 10 22H2/11 and macOS 13+ run the same app through `app/main/platform/` (PLAN.md M11). Everything that differs by OS lives there, and nothing outside it tests `process.platform` (`platform-boundary.test.ts`); docs/DEVELOPING.md §12 has the rules. A change for one OS must leave the others behaving as before. PLAN.md §1 lists what is outside v1: Wayland sessions, RHEL 9 and 10, screenshot OCR redaction and multi-pointer X. Work on those only when asked.
- **Frozen decisions.** PLAN.md §2 changes only in a PR that says what changed and why. These departures recorded in §10 are current, so don't "restore" the original choice:
  - XGetImage capture, not desktopCapturer;
  - XTest through koffi, not robotjs;
  - an Xvfb desk that sends JPEG frames over IPC;
  - an explicit rpmbuild spec;
  - Silero VAD with offline Moonshine;
  - a 1.5 s idle wait before Ember borrows the cursor.
- **Session shape.** There is one conductor session (text only, never sent images) and one worker session per task. Work is split across plain TypeScript classes in main, never an LLM or an SDK sub-agent:
  - `TaskManager` owns scheduling, window leases and the queue;
  - `PolicyEngine` and `Confirmer` own approvals;
  - `AuditLog` keeps the record.

  The limits are fixed:
  - at most 2 running tasks (and beside them at most 2 guides), and one task per window;
  - a worker stops after 150 tool calls or 20 minutes;
  - a finished worker's session is deleted at once (TaskManager's `keepMs` defaults to 0);
  - at most 40 actions a minute, which an admin's `maxActionsPerMinute` can only lower.

## Safety and privacy

Ember drives a real person's desktop, so these rules are hard limits. They implement PLAN.md §5 and the §6 gates. When a safety check can't run, fail closed: refuse, send no image, lock down or stop. `.claude/rules/agent-and-policy.md` has the implementation detail.

- **Agent tools.** Build every Copilot session with `hardenedSessionConfig()` and `verifySessionTools()`. SDK built-ins stay off, and no agent gets the SDK's shell, edit or fetch tools. Every change Ember makes goes through its own zod-typed tools: tier 0 (app settings and `launchApp()`), the accessibility helper, Ember's desk, the borrowed cursor, or `run_command`.
- **Policy decides, not the model.**
  - `PolicyEngine.decide()` in main decides every action, and question text is built from the request, never from model output.
  - Approval comes only from a click in Ember's bubble, corner card or prompt window, or from the allow and deny shortcuts while a question is up (`app/shared/shortcuts.ts`: Ctrl+Alt+Y/N on Linux, Win+Alt+Y/N on Windows, Control+Shift+Command+Y/N on macOS). Never from voice or the model.
  - Risky actions (send, post, submit, share, delete, overwrite, pay, install, sign out, security settings, destructive keys, moving data between windows) are confirmed every time and never offer "Always".
  - After a deny or "Not now", Ember never retries or works around it.
- **Untrusted text.** Text from the screen, apps, files, the web and task results is data, never instructions. It is wrapped in `untrusted="true"` elements before a model sees it. Policy checks a risky step against what the user said, never against the conductor's goal.
- **Never.**
  - Ember never types into, selects in or sends keys to password, secret or payment fields.
  - It never acts in authentication windows (polkit, keyring, pinentry, sudo). While one is open, it reads, captures and sends nothing.
  - It never opens, types into or acts in the user's terminals, makes files executable, or presses desktop-level keys or its own shortcuts. Commands run only through `run_command`, in Ember's own command window, after its classifier: dangerous ones (deleting, publishing, secrets, system changes, download-and-run) ask, except that one the user's own words asked for exactly (never secrets, download-and-run or anything unclear) is announced with a 4 s Stop; tampering with Ember's safety is refused (PLAN.md §2 "Commands").
  - It never reads or acts in its own windows or in never-look windows.
  - Password text never reaches the model.
- **Screenshots** go only to workers. They are JPEGs at most 1280 px, with Ember hidden and never-look windows and secret fields blacked out. If masking fails, no image is sent. Prefer AT-SPI text to pixels.
- **Least intrusive tier first:** 0 app APIs, 1 background accessibility, 2 Ember's desk (Linux only), 3 borrowing the cursor. Tier 3 asks every time and lets go on any user input. Ember never moves the pointer again after the user takes over.
- **Kill switch.** The stop shortcut (Ctrl+Alt+X on Linux), "Ember, stop" and "Stop everything" call `KillSwitch.pull()`, which tells every part to stop at once and returns within 300 ms, logging any part still winding down as `late`. Register any new long-running part as a `StopPart`.
- **Consent.**
  - Nothing is read, heard or sent until `hasConsent` is true.
  - When you change what Ember reads, sends or keeps, bump `CONSENT_VERSION` (app/shared/consent.ts) and update "Before Ember starts" in app/renderer/home/index.html. WSL, SSH and commands have their own first-use cards, and memory its own note (`MEMORY_CONSENT_TEXT`): change one's text only with a bump of its entry in `FEATURE_CONSENT_VERSION`.
  - Audio stays on the machine and is never written to disk.
- **Privacy.**
  - There is no telemetry.
  - Network calls go only to Copilot (or the admin's BYOK provider), GitHub sign-in, the user-approved, SHA-256-pinned model download, and, once the user turns SSH on, the computers they name and the pinned Node.js download for them. Ember listens on no network port.
  - Ember's data folder is created mode 0700 and the audit files are 0600. Typed text appears in the audit log only as a character count.
  - Never log window titles, typed text or the user's words anywhere more widely readable.
  - The GitHub token is stored only with `safeStorage`, and never when its backend is `basic_text`.
- **Admin policy.** The organisation's policy (`/etc/ember/policy.json` on Linux, `/Library/Application Support/Ember/policy.json` on macOS, `HKLM\SOFTWARE\Policies\Ember` on Windows) can only tighten Ember. If it is unreadable, invalid, or (as a file) not owned by root or writable by group or others, Ember applies `LOCKDOWN`.

## Writing UI copy

- **Case and punctuation.** Use sentence case everywhere (buttons, headings, menus, states), and never tracked all-caps or monospace labels. Use curly double quotes around names (“Hey Ember”), straight apostrophes, and a single `…` for states in progress ("Thinking…") and items that open a window ("Settings…"). Use British spelling in UI, docs and comments, and keep `color` and `license` where an API needs them.
- **Voice.** Ember speaks in the first person where it talks to you ("May I?", "Ctrl+Alt+X stops me"). Home and the docs call it Ember. Say specifically what it is doing ("Working in Settings").
- **Names.** Name things the way people say them:
  - apps through `friendlyApp` (app/shared/apps.ts);
  - keys through `keyLabel` in app/renderer/home/copy.ts (Return becomes "Enter");
  - times with `toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })`.

  On Ember's desk, never say "your keyboard" or "your mouse".
- **No raw errors or markdown.** Never show raw SDK, HTTP or stack text. `friendlyError` turns an error into one plain sentence, and `plainText()` strips markdown before the bubble or speech. Keep model-facing instructions out of user text (`forUser`).
- **Shortcuts.** Name a shortcut only if Ember holds it (`hasKey`, `questionKeyHint()`), because another app may have taken it.
- **Tested strings.** Put new Home words in app/renderer/home/copy.ts as pure functions. ui-copy.test.ts and bubble.test.ts pin exact strings, so change a test together with its string.

## Code conventions

- **TypeScript and formatting.** TypeScript is strict with `noUnusedLocals` and `noUnusedParameters`; prefix an intentionally unused name with `_`. Use `import type` for type-only imports and `export type` for type re-exports (isolatedModules). No formatter is configured: match the surrounding code (double quotes, semicolons, 2-space indent, `10_000` separators) and don't reformat lines you didn't change.
- **Comments.** Start each module with a doc comment that says what it is and the constraint behind it, and put JSDoc on exports. Inline comments say why: a measurement, a platform quirk, or a PLAN.md ID such as M8.9.
- **Names.** Use kebab-case files, PascalCase classes and SCREAMING_SNAKE constants. IPC channels are `"area:kebab-action"` in `as const` maps. Log events are `"area.snake_case"` with a fields object (`log.info("killswitch.pulled", { source, ms })`).
- **Lint exceptions.** Disable an ESLint rule for the narrowest scope with the reason after `--`. Give every empty `catch` a comment saying why the error is ignored.
- **Electron windows.** Every BrowserWindow has `contextIsolation: true, sandbox: true, nodeIntegration: false` and a preload from `dist/app/preload/<page>.cjs`. Keep the global `web-contents-created` handler that blocks `window.open` and navigation. Every permission request is denied except the mic window's audio.
- **IPC.** A renderer reaches main only through its preload's `contextBridge` API. Every `ipcMain` handler checks its sender first. In a new handler, type the arguments as `unknown` and check their type and size before use.
- **Electron imports.** Import `electron` only in the preloads and in app/main's main.ts, windows.ts, overlay.ts, handle.ts, ask.ts, voice.ts, revive.ts and desk/view.ts (ESLint enforces it); everything else loads under plain Node and takes Electron's objects by injection.
- **Validation and switches.** Validate input with zod: settings, admin policy, and every Copilot tool's parameters. Read test-only and demo-only switches through `devEnv()` so a packaged Ember ignores them, and list new ones in docs/DEVELOPING.md.
- **koffi.** Never call `koffi.view()`, which aborts Electron (lint enforces this); copy with `koffi.decode(ptr, "uint8_t", n)`. Bind a library once per module, never per call or per frame, and keep one X connection open per display. Code that imports on every OS loads koffi lazily, inside a factory that runs only on its own OS.
- **Native code.** Prefer koffi or WASM over native addons: Linux ships none (`ember.nativeModules` is `[]`), and sherpa-onnx's, for Windows and macOS only, is the one exception. See `packaging-and-ci.md`.

## Testing and verifying changes

- **Where tests go.** Unit tests go in `test/unit/*.test.ts` or `packages/**/*.test.ts`; they run on Linux, Windows and macOS, so keep them OS-neutral (docs/DEVELOPING.md §14.4). Anything that needs the Copilot runtime, a real desktop, accessibility, sshd, WSL or voice models goes in `test/integration/*.test.ts`, which runs only with `EMBER_INTEGRATION=1`. A unit test that needs a real X server skips itself without one (as desk-live.test.ts and perception-x11.test.ts do).
- **How to write them.**
  - Move decisions into pure functions with no Electron and no DOM, and unit-test them.
  - Use `vi.mock` only at a module boundary (`electron`, `node:child_process`, `@github/copilot-sdk`); otherwise pass small fakes in.
  - Add a regression test with every fix.
  - Name tests as a spec: `describe` names the subject, and `it` states the behaviour from the user's side, citing the review ID or WCAG criterion in parentheses.
- **Tests that read source text.** Some unit tests match exact source text:
  - the font copy in build-app.mjs and the licence path in stage.mjs;
  - the voice-models path in main.ts, `const SIZE = { width: 560, height: 92 }` in ask.ts, and many more lines of main.ts and app/main/agent/tasks.ts (docs.test.ts, app-chrome.test.ts, ask-open.test.ts);
  - several lines of the RPM spec and the AppRun heredoc in appimage.sh (listed in `packaging-and-ci.md`);
  - the CSS rules listed in `design-system.md`.

  When you change one, update its test in the same commit.
- **Eval.** Keep the eval green (Linux only): eval/tasks/*.json run against the scripted mock model with blocking safety gates.
- **UI changes.** Check them in real renders as well as tests; `design-system.md` says how.

## How to work in this repo

- **Scope.** The request sets the scope. Make routine judgment calls yourself, and ask only when different readings would lead to materially different work. A pre-existing bug, a performance concern or cleanup the task doesn't need goes in your summary as a follow-up, not into the change.
- **Edits.** Edit files surgically. Don't rewrite a whole file for a local change.
- **Checking before "done."** Before you call a change done, run a real check that exercises it: the relevant tests from the gate, the typecheck, the build, and for visual changes the render check. A syntax-only check, or a command that failed to start, doesn't count. If a check can't run here (no platform-python, no Electron binary), say which one and why.
- **Reporting.** Report outcomes as they are: failing tests with their output, skipped steps as skipped.
- **Scratch files.** Keep scratch scripts and screenshots outside the repository. Commit tests where this repository keeps them, sized like the neighbouring tests.

## Git, commits and PRs

- **Branches.** Work on a branch and open a PR against `main`; never push to main. Releases are `v*` tags on `main` (docs/DEVELOPING.md §15). Name branches like the recent ones: `ember-improve/<YYYYMMDD-HHMM>` or `ember-improve/<YYYYMMDD>-<slug>`. The owner merges with a merge commit, so every commit must be coherent and pass the gate.
- **Commits.** The subject is one imperative sentence in sentence case that states the user-visible outcome, with no period and no `feat:` or area prefix ("Refuse a silent Copilot runtime instead of hanging at startup"). Wrap the body at 90 columns. Open with how the problem was found and checked. Then use `- ` bullets that say what was wrong and what happens now, with the numbers you measured where you measured any.
- **PR body.** Summary; what changed, by area or window; Testing (exact commands, results, counts and visual checks); then "Known, not addressed here". Reference PLAN.md task IDs where they apply.
- **Docs in the same change.**
  - docs/DEVELOPING.md: commands, environment variables, behaviour users or admins see, troubleshooting.
  - PLAN.md §10: progress and departures.
  - docs/DESIGN.md: design changes.
  - This file and `.claude/rules/`: whenever a rule they state changes, update the rule in place rather than adding a note about the drift. A stale doc your change doesn't touch is a follow-up for your summary.

## Gotchas

- On a GNOME on Wayland session the setup check's session row fails, and Ember takes no screenshots and borrows nothing (reading apps still works). Log in to "GNOME on Xorg".
- Device-flow sign-in uses Ember's built-in GitHub App (`GITHUB_CLIENT_ID` in app/main/agent/github-app.ts; `EMBER_GITHUB_CLIENT_ID` overrides it). In development you can also sign in with `gh auth token` or `COPILOT_GITHUB_TOKEN`.
- Electron's `screen.getCursorScreenPoint()` goes stale on X11 after the pointer jumps. Ask the platform's window system for the pointer (XQueryPointer on Linux), which reports native units: physical pixels on Linux and Windows, points on macOS.
- GNOME 3.32 has no tray by default, so never put anything only in a tray. The ways in are the handle, the shortcuts and the launcher (the `.desktop` entry on Linux).
- Each Copilot session holds an inotify instance, and the per-user limit is often 128. Delete sessions you are done with.
- The local `python3` is usually newer than RHEL 8's 3.6, so a passing `npm run test:sidecar` does not prove the sidecar runs on the target. See `python.md`.
