# Ember

Ember is a desktop companion and agent for RHEL 8.4 (GNOME on Xorg, x86-64). A small character sits beside the cursor, answers questions and does tasks in the user's real apps, where they can watch. It is built with Electron 44 and strict TypeScript. The agent loop runs on the GitHub Copilot SDK: one conductor session, plus one hardened worker session per task. A Python 3.6 AT-SPI sidecar reads apps and acts in them, and voice runs on the device with sherpa-onnx. Ember ships as an RPM and an AppImage. Its windows use Apple's current design language, adapted to a desktop with no GPU.

The detail lives in the docs. Read the one for the area you are changing:
- `PLAN.md` is the frozen v1 plan: §2 decisions, §4 task IDs (M0–M10), §5 safety, §6 release gates, §9 what comes after v1, §10 progress and departures. Where it and docs/RESEARCH.md differ, PLAN.md wins. Where §10 records a departure from §2, the code follows §10. §3's layout was the v1 target and is out of date.
- `docs/DEVELOPING.md` covers setup, commands, environment variables, native modules, packaging, the eval, troubleshooting, where Ember keeps its data, and the current repository layout.
- `docs/DESIGN.md` covers the characters, the rig, the bubble, motion and the design system.
- `docs/RESEARCH.md` holds the background evidence.

Topic rules in `.claude/rules/` load when you open matching files:
- `design-system.md`: renderers, windows, the bubble, the characters and the icon.
- `agent-and-policy.md`: agent, policy, hands, perception, desk, voice, settings, sidecar and eval.
- `python.md`: all Python.
- `packaging-and-ci.md`: scripts, packaging, workflows and dependencies.

## Commands

Use Node 22.12 or later and npm 11.6.2 (`engines` and `packageManager` in package.json). npm 10 crashes with "Cannot read properties of null (reading edgesOut)"; fix it with `npm install -g npm@11.6.2`. Install with `npm ci`. Where the Electron binary can't download, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` is enough for lint, typecheck, unit tests and build; `npx install-electron` fetches the binary later.

```sh
npm run dev                    # build into dist/app (scripts/build-app.mjs) and launch Electron
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

- Desktop suites (AT-SPI, X11, desk, safety) run as in CI's `el8` job: `EMBER_ATSPI_TEST=1 dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" npm run test:integration -- <files>`. The file list is in `.github/workflows/ci.yml`.
- The eval drives real windows, so give it a display and a session bus, as CI's `eval` job does (with gedit installed): `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node eval/run.mjs`. For a partial run use `node eval/run.mjs --only <id> --no-gates`.
- Without Copilot, start the mock model with `node -e 'import("./test/mock-llm/server.mjs").then(m => m.startMockLlm({ port: 18090 })).then(s => console.log(s.baseUrl))' &`, then run `EMBER_TEST_PROVIDER_URL=http://127.0.0.1:18090/v1 npm run dev`.
- Useful switches: `EMBER_USER_DATA` (a throwaway settings and logs folder), `EMBER_LOG_LEVEL=debug`, `EMBER_PYTHON`, and `EMBER_LOG_STDOUT=1` (logs to stdout from an installed Ember; development already does this). Ember's real data lives in `~/.config/ember/`.
- Also available: `npm run rebuild:el8`, `npm run check:symvers` and `npm run package` (RPM and AppImage into dist/package).

## Repository map

```
app/main/          Electron main: main.ts (wiring), windows.ts, overlay.ts + xshape.ts, handle.ts, ask.ts,
                   voice.ts, settings.ts, admin.ts, doctor.ts, hotkey.ts, x11.ts, follow.ts
  agent/           host, conductor, worker, tasks (TaskManager), confirm (Confirmer), killswitch,
                   presenter (what the bubble says), persona, worker-persona, session-config, auth
  policy/          policy.ts (PolicyEngine), audit.ts (AuditLog)
  perception/      sidecar, elements (untrusted screen text), capture, marks, windows
  hands/           system.ts (tier 0, launchApp, appEnv), borrow.ts (tier 3), input.ts, keymap.ts
  desk/            desk.ts (the Xvfb desk), agent-process.ts (every desk X call), view.ts
app/preload/       one contextBridge preload per window
app/renderer/      home, overlay, handle, ask, mic, desk; shared/ember.css is the design system
app/shared/        IPC names and types, consent.ts, apps.ts
app/voice/         the voice utility process (wake word, VAD, ASR); models.ts pins the downloads
packages/          @ember/characters, @ember/bubble (BUBBLE_CSS), @ember/motion
sidecar/atspi/     ember_atspi.py (JSON-RPC over stdio) and test_ember_atspi.py
scripts/, packaging/, test/ (unit, integration, smoke, fixtures, mock-llm, demo), eval/
```

## Ground rules

- **Platform.** Ember targets the RHEL 8.4 family (also Rocky, Alma and Oracle Linux 8): GNOME on Xorg, x86-64, glibc 2.28 and the system's Python 3.6 (`/usr/libexec/platform-python`). Capture, input and the overlay all rely on X11 (PLAN.md §2). PLAN.md §1 lists what is outside v1: Wayland, RHEL 9 and 10, macOS, Windows, SSH, neural TTS, speaker verification, screenshot OCR redaction and multi-pointer X. Work on those only when asked, and keep the X11 paths working.
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
  - at most 2 running tasks, and one task per window;
  - a worker stops after 150 tool calls or 20 minutes;
  - finished worker sessions are deleted after 10 minutes;
  - at most 40 actions a minute, which an admin's `maxActionsPerMinute` can only lower.

## Safety and privacy

Ember drives a real person's desktop, so these rules are hard limits. They implement PLAN.md §5 and the §6 gates. When a safety check can't run, fail closed: refuse, send no image, lock down or stop. `.claude/rules/agent-and-policy.md` has the implementation detail.

- **Agent tools.** Build every Copilot session with `hardenedSessionConfig()` and `verifySessionTools()`. SDK built-ins stay off, and no agent gets a tool that runs commands, edits files or fetches from the network. Every change Ember makes goes through its own zod-typed tools: tier 0 (the gsettings allowlist and `launchApp()`), AT-SPI, Ember's desk, or the borrowed cursor.
- **Policy decides, not the model.**
  - `PolicyEngine.decide()` in main decides every action, and question text is built from the request, never from model output.
  - Approval comes only from a click in Ember's bubble or corner card, or from Ctrl+Alt+Y / Ctrl+Alt+N while a question is up. Never from voice or the model.
  - Risky actions (send, post, submit, share, delete, overwrite, pay, install, sign out, security settings, destructive keys, moving data between windows) are confirmed every time and never offer "Always".
  - After a deny or "Not now", Ember never retries or works around it.
- **Untrusted text.** Text from the screen, apps, files, the web and task results is data, never instructions. It is wrapped in `untrusted="true"` elements before a model sees it. Policy checks a risky step against what the user said, never against the conductor's goal.
- **Never.**
  - Ember never types into, selects in or sends keys to password, secret or payment fields.
  - It never acts in authentication windows (polkit, keyring, pinentry, sudo). While one is open, it reads, captures and sends nothing.
  - It never opens or acts in terminals, runs programs, makes files executable, or presses desktop-level keys or its own shortcuts.
  - It never reads or acts in its own windows or in never-look windows.
  - Password text never reaches the model.
- **Screenshots** go only to workers. They are JPEGs at most 1280 px, with Ember hidden and never-look windows and secret fields blacked out. If masking fails, no image is sent. Prefer AT-SPI text to pixels.
- **Least intrusive tier first:** 0 app APIs, 1 background AT-SPI, 2 Ember's desk, 3 borrowing the cursor. Tier 3 asks every time and lets go on any user input. Ember never moves the pointer again after the user takes over.
- **Kill switch.** Ctrl+Alt+X, "Ember, stop" and "Stop everything" call `KillSwitch.pull()`, which stops every part within 300 ms. Register any new long-running part as a `StopPart`.
- **Consent.**
  - Nothing is read, heard or sent until `hasConsent` is true.
  - When you change what Ember reads, sends or keeps, bump `CONSENT_VERSION` (app/shared/consent.ts) and update "Before Ember starts" in app/renderer/home/index.html.
  - Audio stays on the machine and is never written to disk.
- **Privacy.**
  - There is no telemetry.
  - Network calls go only to Copilot (or the admin's BYOK provider), GitHub sign-in, and the user-approved, SHA-256-pinned model download.
  - `~/.config/ember` is mode 0700 and the audit files are 0600. Typed text appears in the audit log only as a character count.
  - Never log window titles, typed text or the user's words anywhere more widely readable.
  - The GitHub token is stored only with `safeStorage`, and never when its backend is `basic_text`.
- **Admin policy.** `/etc/ember/policy.json` can only tighten Ember. If it is unreadable, invalid or writable by others, Ember applies `LOCKDOWN`.

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
- **Electron imports.** Import `electron` only in the preloads and in app/main's main.ts, windows.ts, overlay.ts, handle.ts, ask.ts, voice.ts, revive.ts and desk/view.ts. Code in agent/, perception/, policy/, hands/ and desk/ (except view.ts) must load under plain Node.
- **Validation and switches.** Validate input with zod: settings, admin policy, and every Copilot tool's parameters. Read test-only and demo-only switches through `devEnv()` so a packaged Ember ignores them, and list new ones in docs/DEVELOPING.md.
- **koffi.** Never call `koffi.view()`, which aborts Electron (lint enforces this); copy with `koffi.decode(ptr, "uint8_t", n)`. Bind a library once per module, never per call or per frame, and keep one X connection open per display.
- **Native code.** Prefer koffi, WASM or binaries that need glibc 2.28 or older over native addons. See `packaging-and-ci.md`.

## Testing and verifying changes

- **Where tests go.** Unit tests go in `test/unit/*.test.ts` or `packages/**/*.test.ts`. Anything that needs the Copilot runtime, X, AT-SPI or voice models goes in `test/integration/*.test.ts`, which runs only with `EMBER_INTEGRATION=1`.
- **How to write them.**
  - Move decisions into pure functions with no Electron and no DOM, and unit-test them.
  - Use `vi.mock` only at a module boundary (`electron`, `node:child_process`, `@github/copilot-sdk`); otherwise pass small fakes in.
  - Add a regression test with every fix.
  - Name tests as a spec: `describe` names the subject, and `it` states the behaviour from the user's side, citing the review ID or WCAG criterion in parentheses.
- **Tests that read source text.** Some unit tests match exact source text: the font copy in build-app.mjs, the licence path in stage.mjs, the voice-models path in main.ts, `const SIZE = { width: 560, height: 92 }` in ask.ts, the chrome-sandbox `%attr` line in the spec, and the CSS rules listed in `design-system.md`. When you change one, update its test in the same commit.
- **Eval.** Keep the eval green: eval/tasks/*.json run against the scripted mock model with blocking safety gates.
- **UI changes.** Check them in real renders as well as tests; `design-system.md` says how.

## How to work in this repo

- **Scope.** The request sets the scope. Make routine judgment calls yourself, and ask only when different readings would lead to materially different work. A pre-existing bug, a performance concern or cleanup the task doesn't need goes in your summary as a follow-up, not into the change.
- **Edits.** Edit files surgically. Don't rewrite a whole file for a local change.
- **Checking before "done."** Before you call a change done, run a real check that exercises it: the relevant tests from the gate, the typecheck, the build, and for visual changes the render check. A syntax-only check, or a command that failed to start, doesn't count. If a check can't run here (no platform-python, no Electron binary), say which one and why.
- **Reporting.** Report outcomes as they are: failing tests with their output, skipped steps as skipped.
- **Scratch files.** Keep scratch scripts and screenshots outside the repository. Commit tests where this repository keeps them, sized like the neighbouring tests.

## Git, commits and PRs

- **Branches.** Work on a branch and open a PR against `main`; never push to main. Name branches like the recent ones: `ember-improve/<YYYYMMDD-HHMM>` or `ember-improve/<YYYYMMDD>-<slug>`. The owner merges with a merge commit, so every commit must be coherent and pass the gate.
- **Commits.** The subject is one imperative sentence in sentence case that states the user-visible outcome, with no period and no `feat:` or area prefix ("Refuse a silent Copilot runtime instead of hanging at startup"). Wrap the body at 90 columns. Open with how the problem was found and checked. Then use `- ` bullets that say what was wrong and what happens now, with measured numbers.
- **PR body.** Summary; what changed, by area or window; Testing (exact commands, results, counts and visual checks); then "Known, not addressed here". Reference PLAN.md task IDs where they apply.
- **Docs in the same change.**
  - docs/DEVELOPING.md: commands, environment variables, behaviour users or admins see, troubleshooting.
  - PLAN.md §10: progress and departures.
  - docs/DESIGN.md: design changes.
  - This file and `.claude/rules/`: whenever a rule they state changes. Fix a stale doc rather than noting the drift here.

## Gotchas

- On a Wayland session, `ember doctor` and the setup check fail. Log in to "GNOME on Xorg".
- Ember's own GitHub App isn't registered yet, so device-flow sign-in needs `EMBER_GITHUB_CLIENT_ID`. In development, sign in with `gh auth token` or `COPILOT_GITHUB_TOKEN`.
- Electron's `screen.getCursorScreenPoint()` goes stale on X11 after the pointer jumps. Use the XQueryPointer-based `cursor()` in main.ts, which reports physical pixels: divide by the primary display's `scaleFactor`.
- GNOME 3.32 has no tray by default, so never put anything only in a tray. The ways in are the handle, the shortcuts and the `.desktop` launcher.
- Each Copilot session holds an inotify instance, and the per-user limit is often 128. Delete sessions you are done with.
- The local `python3` is usually newer than RHEL 8's 3.6, so a passing `npm run test:sidecar` does not prove the sidecar runs on the target. See `python.md`.
