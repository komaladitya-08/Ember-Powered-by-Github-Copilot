---
paths:
  - "app/main/agent/**"
  - "app/main/policy/**"
  - "app/main/hands/**"
  - "app/main/perception/**"
  - "app/main/desk/**"
  - "app/main/platform/**"
  - "app/sidecar-host/**"
  - "app/main/commands/**"
  - "app/main/targets/**"
  - "app/main/wsl/**"
  - "app/main/remote/**"
  - "app/main/memory/**"
  - "app/remote/**"
  - "app/askpass/**"
  - "app/main/screen-lock.ts"
  - "app/main/main.ts"
  - "app/main/overlay.ts"
  - "app/main/xshape.ts"
  - "app/main/x11.ts"
  - "app/main/voice.ts"
  - "app/main/voiceprint-store.ts"
  - "app/main/settings.ts"
  - "app/main/admin.ts"
  - "app/renderer/overlay/main.ts"
  - "app/renderer/mic/**"
  - "app/voice/**"
  - "app/shared/consent.ts"
  - "app/shared/{shortcuts,words,never-look,speech,voice,targets}.ts"
  - "sidecar/**"
  - "eval/**"
  - "test/fixtures/**"
---

# Agent, policy and safety: how the rules are implemented

The root CLAUDE.md states the safety rules. This file says where each one lives and how to extend it without weakening it. Every rule here traces to PLAN.md §5 and the §6 gates:
- the kill switch stops everything in under 300 ms;
- a borrow is aborted in under 100 ms;
- injection fixtures produce no out-of-scope actions;
- no risky action goes unconfirmed.

The eval judges its two blocking safety gates (out-of-scope actions on the injection fixtures, and risky actions without confirmation) from each attempt's audit log. It times the kill switch and the borrow abort directly, and tracks them without blocking.

## Copilot sessions and prompts

- **Hardening.** Build every session with `hardenedSessionConfig()`, then call `verifySessionTools()` (app/main/agent/session-config.ts). That gives `availableTools: []`, `excludedBuiltinAgents: BUILTIN_AGENTS`, and an `onPreToolUse` that denies any tool Ember didn't grant.
- **System prompt.** Use `customize` mode through `emberSections()` (persona.ts). Never replace or remove the platform safety section, and put tone inside the identity replacement.
- **Model-facing text.** Describe worker behaviour in `workerRules()`/`commandsRule()` and guide behaviour in `GUIDE_RULES` (worker-persona.ts), and conductor behaviour in `toolRules()` (persona.ts). Take each OS's words from `PLATFORM_WORDS`. `WORKER_RULES` and `TOOL_RULES` are the frozen Linux outputs: with commands off everywhere (`NO_CAPS`), every prompt stays byte-identical (persona-commands.test.ts).

## Adding or changing a worker tool

- **Definition.** Define the tool with `this.tool()` in worker.ts. It parses the zod arguments (the runtime does not), counts the 150-step limit, and runs one call at a time.
- **Routing actions.** Send every app action through `act()` or `system()`. These call `authorize()`, which asks `PolicyEngine.decide()`, asks the user when needed, and writes the audit entries. Commands go only through `run_command` → app/main/commands/flow.ts (the classifier, then decide.ts), never through `authorize()`.
- **Refusals and errors.** Refuse through `refuse()` (logged as a `decision`), return `denied(…)` for a refusal and `fail(…)` for an error.
- **Stopping.** After every `await`, check `if (this.isOver) return STOPPED();`, so a stop takes effect at once.
- **Wiring.**
  - Decide whether guide mode gets the tool (the `guide` set in `tools()`).
  - Give it bubble words in `TOOL_STEPS` (presenter.ts), and describe it in the persona rules.
  - Keep eval/tasks/*.json calling it with arguments it accepts (eval-harness.test.ts checks this).
- **Tests.** Test it in worker-tools.test.ts and policy.test.ts (worker-commands.test.ts for command tools).

## Policy and confirmation

- **Decisions.** Describe each action as an `ActionRequest`, and let `PolicyEngine.decide()` (app/main/policy/policy.ts) decide it. Build question text from the request (`describe(r)`), never from model output.
- **Matching.** Normalise labels with `normalizeLabel`/`foldLabel` before matching word lists. Policy checks a risky step against `TaskSpec.userWords`, never against the conductor's goal string.
- **New risky verbs.** Add each one to `RISKY` and to the per-language `RISKY_WORDS`/`RISKY_ANYWHERE` lists (verbs that only a control acts on: `RISKY_ACT*`; one OS's words: `RISKY_EXTRA[os]` in vocabulary.ts). These are confirmed every time:
  - risky actions themselves;
  - OK or Yes in a dialog about one of them;
  - destructive keys;
  - moving data between windows;
  - security settings.

  They never offer "Always". After a deny or "Not now", never retry or work around it, and don't soften "Don't try another way".
- **Confirmer guards.** Keep them in confirm.ts:
  - a 500 ms default arm delay;
  - a 700 ms gap between questions;
  - expiry as "no" after 120 s times the user's read-time setting, longer for long texts;
  - no answers accepted while Ember borrows the mouse;
  - panel questions (the command card, consent cards) answered only from their own window, with the hash of what it showed;
  - Allow on a whole-text question only after all of it was in view.

  "Always in <app>" is a click only, never bound to a key, because a global key could take an app's own shortcut and grant for good.

## Untrusted text, secrets and never-look windows

- **Untrusted text.** Wrap text from the screen, apps, files, the web or other tasks in an element marked `untrusted="true"`: `<screen>`, `<context>`, `<windows>`, `<options>`, `<task_results>`, `<tasks>` or `<command_output>` (built only by `shapeOutput()`). Quote it with `quoteUntrusted()`, and escape role and action names with `screenWord()`.
- **Secrets.** `SECRET_WORDS`/`SECRET_ANYWHERE` must stay the same in TypeScript and Python. The Windows and macOS host (app/sidecar-host/secrets.ts) imports elements.ts's lists: never copy them there. Add new labels to test/fixtures/secret-labels.json (and options to chosen-options.json), because both test suites read these files.
- **Never-look windows.** Check the never-look list (`settings.privacy.neverLook` plus the admin's list) before every capture and every tree read. Those windows are left out of trees and window lists, and blacked out in images.
- **Screenshots.** Only workers get them. If `maskAfter` returns null, send no image.
- **Launching apps on the user's screen.** Use only the platform's `AppCatalog.launch()`: on Linux `launchApp()` (app/main/hands/system.ts: `gtk-launch <desktop id>`, else the parsed Exec line, `execArgv`, no shell), on Windows explorer.exe with the app's shortcut, on macOS `open -a`. Each refuses terminals (`isTerminalApp(app, os)`), starts in the home folder and passes `appEnv()`, an allowlist that never passes tokens, keys, secrets or passwords, or Ember's, GitHub's, Copilot's, SSH's, GPG's, the keyring's or Electron's variables.
- **Launching apps on the desk.** Apps start through the desk place's `open()` (app/main/desk/place.ts). It also refuses terminals, and calls `Desk.run()` with the desk's `appEnv(process.env, { session: false })` environment and the hand-off folder.
- **Ember's own windows.** Ember never reads or acts in them: `isEmberWindow()` (policy.ts) matches Ember's process id, then its app name, and its titles (`EMBER_WINDOW`) only when the id is unknown.

## Tiers, the desk and the kill switch

- **Tier 1** (background accessibility: AT-SPI on Linux and in WSL, UI Automation or AX through app/sidecar-host) never moves the pointer, takes focus or raises a window. Return `background_unavailable` instead, and let the router ask to escalate.
- **Tier 3** (borrowing the cursor):
  - confirm every time;
  - wait for the user to be still;
  - let go on any user input, and after that never move the pointer again;
  - unless the user took over, restore the pointer and the active window when the borrow ends.

  Target-dependent refusals (no borrowing in WSLg windows) live only in policy/target-rules.ts. On the user's screen, text typed with the borrowed keyboard always goes in by paste (any layout, accents, long text), and the clipboard is put back afterwards. Ember pastes only when it can put the clipboard back. On the desk, text is typed.
- **The desk** (Linux only; `Platform.desk` is null elsewhere) is a private Xvfb with its own D-Bus, clipboard and app profiles. Make every desk X call in the desk helper (app/main/desk/agent-process.ts, bundled as dist/app/desk-agent.cjs and run with `ELECTRON_RUN_AS_NODE`), never in Ember's own process. Risky steps on the desk are still confirmed. Desks use displays :90 to :139.
- **The kill switch.** Register every new long-running part with `KillSwitch` as a `StopPart`. After a stop, no tool sends anything to any app.

## The overlay

- **One window per display.** Each display gets one transparent, frameless, `focusable: false`, click-through window, shown with `showInactive()`.
- **What takes clicks.** Its clickable area is exactly the rectangles `reportInteractive()` sends (the X input shape on Linux; hover polling against them on Windows and macOS) (app/renderer/overlay/main.ts). To make a new element clickable:
  - put it in `bubble.interactiveRects()` or `taskRects`;
  - set `interactiveDirty` when its box changes.

  The report goes to main only when the rectangles change. While Ember borrows the mouse the shape is empty, so the overlay takes no clicks.
- **Click-through per OS.** `setIgnoreMouseEvents({forward:true})` and `setContentProtection` do nothing on Linux. Use `forward` only where the shaper says so (macOS): on Windows it would hook every app's mouse. `setContentProtection(true)` keeps windows out of screenshots on Windows and macOS.

## Consent, voice and privacy

- **Consent.** Read, hear and send nothing until `hasConsent` is true. WSL, SSH (per computer) and commands (per target) each have a first-use card whose text is in app/main/targets/consent.ts; it is hashed with the OS's stop chord, and a yes counts only with that hash.
- **The microphone.**
  - It opens only when all of these hold: listening for “Hey Ember” is on (`wakeWord`), the admin's policy allows voice (`features.voice`), voice consent and general consent are given, the listening models (`LISTENING_MODELS`) are verified, Ember isn't muted, and the screen isn't locked.
  - Keep the constraints `echoCancellation: true, noiseSuppression: false, autoGainControl: false`, because gain control and noise suppression distort speech enough to miss the wake word.
  - The bare name "Ember" is spotted inside "remember" and "September", so a wake by it shows only once the transcript check hears the name start the request (app/voice/engine.ts, `BARE_NAME`).
- **Speaking.**
  - Speak only through `VoiceService.speak()`. Ember's own voice (Piper, or Kokoro: below) is made in the speech utility process (app/voice/tts-process.ts) and played by the mic page (app/renderer/mic); until its model is in, or after it keeps failing, the page speaks with the system's voices (speech-dispatcher on Linux), and only voices that run on the computer (app/renderer/mic/voices.ts), since an online voice would send Ember's words elsewhere. The page is the mic window, or, while listening is off, a hidden speak-only window that never opens the mic. Either one tells the voice process while Ember speaks. Whether Ember speaks follows `speaksAloud()` (app/shared/speech.ts), the admin's `features.speak` and the screen lock.
  - Where Ember's own speech can't be told from the user's (`rejectsSpeakers` is false: Windows, macOS, Linux without `parec`), `speak()` drops Ember's wake and stop phrases (`withoutOwnPhrases`), and words heard then never count towards a dangerous command (`spokenWords`).
- **Speech on sherpa-onnx.** Both utility processes reach sherpa-onnx only through app/voice/runtime.ts: its WebAssembly build on Linux (the Linux addon needs glibc 2.32; `packaging-and-ci.md` says how the addon is kept out), its native addon on Windows and macOS, and WebAssembly wherever the addon doesn't load. A damaged model aborts the addon's onnxruntime, so a process that dies before it is ready starts again at once on WebAssembly (`voice.native_failed`), which reports the damage. WebAssembly memory never shrinks, so keep every buffer in app/voice/sherpa.ts bounded.
- **Models.** Each one is pinned by SHA-256 in app/voice/models.ts, downloaded only after the user agrees, and used only once it verifies. Archives unpack in-process (untar.ts, bzip2.ts), refusing anything that could write outside their folder, into a staging folder moved into place whole. The natural voice (Kokoro, `voice.natural`, off by default) is fetched only when the user turns it on, on Windows and macOS, and only where the Piper voice runs natively fast enough (`NATURAL_COST` in app/voice/tts.ts). Where Kokoro then times too slow, that verdict is remembered for a week (`NATURAL_RECHECK_MS`), so the speech process doesn't load it on every start.
- **Voice Match.** The owner's voiceprint (256 numbers that can't be turned back into speech) is kept only in `voiceprint.json` in Ember's data folder, mode 0600, apart from the settings, which are shown and logged more freely (app/main/voiceprint-store.ts); **Forget my voice** deletes the file. "Ember, stop" is never checked against it: anyone may stop Ember.
- **Audio** stays on the machine and is never written to disk.
- **Permissions.** Every web permission request is denied except audio `media` for Ember's mic window (`voicePermissions`). The spellchecker stays off, because it would download dictionaries.
- **Conversation data.**
  - Ember's own conversation log is in memory only.
  - Copilot's session state lives in `<userData>/copilot` only while Ember runs. It is deleted at quit, at the next start after a crash, and on sign-out.
- **The audit log.** Write every decision, question, answer, action, refusal, task outcome and stop to `AuditLog`:
  - workers use their `audit()` helper;
  - TaskManager writes task requests and outcomes;
  - KillSwitch writes stops;
  - commands, SSH and WSL write `command`, `remote` and `wsl` entries.

  If a write fails, the task stops.

  Typed text appears only as a character count. On Linux the journald copy (`journalctl -t ember-audit`, built by `journalLine()`) replaces goals, summaries, window titles, element names, chosen values, errors, folders and command text with their sizes; reasons, app names and shortcuts stay. Windows and macOS keep only the file.
- **Tokens.** Store the GitHub token only with `safeStorage`, and never when its backend is `basic_text`. Accept `gho_`, `ghu_` and `github_pat_` tokens; refuse classic `ghp_` tokens.

## Long-term memory

docs/MEMORY.md is the design. The core (app/main/memory/) is pure and has no Electron. Keep it that way.
- **Every fact goes through `MemoryGraph.add()`**, which runs `memoryRefusal()` (guard.ts). A fact holding a secret is
  refused whole, never stored redacted.
- **Recalled facts reach a model only through `memoryBlock()`** (`<memory untrusted="true">`). Only `user`-sourced
  facts may shape what Ember does. Policy never checks a risky step against memory.
- **`memory.json` is 0600** and written whole through `memoryFile()`. A broken file is moved aside, never overwritten.
- **Nothing is remembered until memory has its own consent.** That means `settings.memory.on` with
  `memory.consent.version >= FEATURE_CONSENT_VERSION.memory`, and the admin's `features.memory` not false. The host
  gives the conductor memory only then (`memoryWanted()`), and only then does it have remember, recall and
  forget_memory. With memory off, the tools and the prompt are today's exactly.
- **A saved fact is the user's only in their own words** (`ownWords`, service.ts). Anything else is `conversation`.
- **Sign-out and an account change call `forgetAll()`**, which erases the file too.

## Settings and admin policy

- **New settings.**
  - Add the field to `SettingsSchema` with a `.default()`; a bad value is repaired field by field.
  - Read and change settings only through `SettingsStore`: `get()` returns them with the admin's policy applied, and `update()` writes atomically. Never write settings.json yourself.
  - Test it in settings.test.ts.
- **Admin-controlled settings.** If an admin should be able to turn a setting off, add the key to `AdminPolicySchema`, `applyAdminPolicy` and `managedKeys`, so Home shows it as managed. Document it in each OS's "For administrators" section of docs/DEVELOPING.md (Linux, §10.7, §11.7).
- **The admin policy** (`AdminPolicySchema`, `.strict()`) can only tighten Ember. It is `/etc/ember/policy.json` on Linux (root-owned, no group or other write), `/Library/Application Support/Ember/policy.json` on macOS (file and folder root-owned, no links) and `HKLM\SOFTWARE\Policies\Ember` `PolicyJson` on Windows (`ADMIN_POLICY_PATHS` and the platform's admin-policy module). Anything unreadable, invalid or untrusted applies `LOCKDOWN`, which also turns WSL, SSH and commands off. A change while Ember runs holds it locked down until restart (admin-watch.ts). Combine a remote's policy with the PC's only through `combineAdmin`. Because the schema is strict, an older Ember treats an unknown key as a broken file: say so in the release notes.

## Platforms, commands and targets

docs/DEVELOPING.md §12 and §14.3 hold the full rules; these are the ones most often broken.
- **The platform boundary.** Only app/main/platform/ tests `process.platform` or reads a native window handle (platform-boundary.test.ts). Code there and in app/sidecar-host loads under plain Node; koffi loads lazily inside a factory that runs only on its OS, with every `koffi.load` guarded.
- **Fail closed.** A check that can't run refuses, returns null or sends no image: `systemDialogOpen()` is true when it can't tell, and nothing is captured without Screen Recording.
- **OS-keyed lists** live in one place each, with the Linux row frozen: app/shared/shortcuts.ts, words.ts and never-look.ts, policy/vocabulary.ts, hands/terminals.ts, agent/clipboard-formats.ts and policy/remote-surface.ts.
- **Commands.** Command text travels in `EMBER_CMD` (or stdin), never on an argv a user or a remote wrote. No network listener anywhere: askpass uses a 0600 Unix socket or a named pipe only the user's SID may open. Nothing secret is written on a remote, and the remote agent's import graph never reaches Electron (remote-agent-build.test.ts).
- **A target's paths** use `node:path/posix`, `node:path/win32` or `resolveTargetPath`, never `node:path`, in commands/, wsl/runner.ts, wsl/service.ts, remote/ and app/remote/ (ESLint enforces it). Never `path.normalize` a POSIX path before opening it.
