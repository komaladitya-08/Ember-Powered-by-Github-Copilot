---
paths:
  - "app/main/agent/**"
  - "app/main/policy/**"
  - "app/main/hands/**"
  - "app/main/perception/**"
  - "app/main/desk/**"
  - "app/main/main.ts"
  - "app/main/overlay.ts"
  - "app/main/xshape.ts"
  - "app/main/x11.ts"
  - "app/main/voice.ts"
  - "app/main/settings.ts"
  - "app/main/admin.ts"
  - "app/renderer/overlay/main.ts"
  - "app/renderer/mic/**"
  - "app/voice/**"
  - "app/shared/consent.ts"
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

The eval computes its gates from the audit log.

## Copilot sessions and prompts

- **Hardening.** Build every session with `hardenedSessionConfig()`, then call `verifySessionTools()` (app/main/agent/session-config.ts). That gives `availableTools: []`, `excludedBuiltinAgents: BUILTIN_AGENTS`, and an `onPreToolUse` that denies any tool Ember didn't grant.
- **System prompt.** Use `customize` mode through `emberSections()` (persona.ts). Never replace or remove the platform safety section, and put tone inside the identity replacement.
- **Model-facing text.** Describe new worker behaviour in `WORKER_RULES`/`GUIDE_RULES` (worker-persona.ts), and conductor behaviour in `TOOL_RULES` (persona.ts).

## Adding or changing a worker tool

- **Definition.** Define the tool with `this.tool()` in worker.ts. It parses the zod arguments (the runtime does not), counts the 150-step limit, and runs one call at a time.
- **Routing actions.** Send every action through `act()` or `system()`. These call `authorize()`, which asks `PolicyEngine.decide()`, asks the user when needed, and writes the audit entries.
- **Refusals and errors.** Refuse through `refuse()` (logged as a `decision`), return `denied(…)` for a refusal and `fail(…)` for an error.
- **Stopping.** After every `await`, check `if (this.isOver) return STOPPED();`, so a stop takes effect at once.
- **Wiring.**
  - Decide whether guide mode gets the tool (the `guide` set in `tools()`).
  - Give it bubble words in `TOOL_STEPS` (presenter.ts), and describe it in the persona rules.
  - Keep eval/tasks/*.json calling it with arguments it accepts (eval-harness.test.ts checks this).
- **Tests.** Test it in worker-tools.test.ts and policy.test.ts.

## Policy and confirmation

- **Decisions.** Describe each action as an `ActionRequest`, and let `PolicyEngine.decide()` (app/main/policy/policy.ts) decide it. Build question text from the request (`describe(r)`), never from model output.
- **Matching.** Normalise labels with `normalizeLabel`/`foldLabel` before matching word lists. Policy checks a risky step against `TaskSpec.userWords`, never against the conductor's goal string.
- **New risky verbs.** Add each one to `RISKY` and to the per-language `RISKY_WORDS`/`RISKY_ANYWHERE` lists. These are confirmed every time:
  - risky actions themselves;
  - OK or Yes in a dialog about one of them;
  - destructive keys;
  - moving data between windows;
  - security settings.

  They never offer "Always". After a deny or "Not now", never retry or work around it, and don't soften "Don't try another way".
- **Confirmer guards.** Keep them in confirm.ts:
  - a 500 ms arm delay;
  - a 700 ms gap between questions;
  - expiry as "no" after 120 s;
  - no answers accepted while Ember borrows the mouse.

  "Always in <app>" is a click only, never bound to a key, because a global key could take an app's own shortcut and grant for good.

## Untrusted text, secrets and never-look windows

- **Untrusted text.** Wrap text from the screen, apps, files, the web or other tasks in an element marked `untrusted="true"`: `<screen>`, `<context>`, `<windows>`, `<options>`, `<task_results>` or `<tasks>`. Quote it with `quoteUntrusted()`, and escape role and action names with `screenWord()`.
- **Secrets.** `SECRET_WORDS`/`SECRET_ANYWHERE` must stay the same in TypeScript and Python. Add new labels to test/fixtures/secret-labels.json (and options to chosen-options.json), because both test suites read these files.
- **Never-look windows.** Check the never-look list (`settings.privacy.neverLook` plus the admin's list) before every capture and every tree read. Those windows are left out of trees and window lists, and blacked out in images.
- **Screenshots.** Only workers get them. If `maskAfter` returns null, send no image.
- **Launching apps.** Launch apps only through `launchApp()` (app/main/hands/system.ts). It refuses terminals, runs `gtk-launch <desktop id>`, falls back to the parsed Exec line (`execArgv`, no shell), uses the home folder as the working directory, and always passes `appEnv()`. `appEnv()` drops tokens, keys and Ember's, GitHub's, Copilot's and SSH's variables.
- **Ember's own windows.** Ember never reads or acts in them: `EMBER_WINDOW` in policy.ts matches their titles.

## Tiers, the desk and the kill switch

- **Tier 1** (background AT-SPI) never moves the pointer, takes focus or raises a window. Return `background_unavailable` instead, and let the router ask to escalate.
- **Tier 3** (borrowing the cursor):
  - confirm every time;
  - wait for the user to be still;
  - let go on any user input;
  - restore the pointer and the active window.

  When the keyboard layout can't type the text, paste it and put the clipboard back.
- **The desk** is a private Xvfb with its own D-Bus, clipboard and app profiles. Make every desk X call in the desk helper (app/main/desk/agent-process.ts, bundled as dist/app/desk-agent.cjs and run with `ELECTRON_RUN_AS_NODE`), never in Ember's own process. Risky steps on the desk are still confirmed. Desks use displays :90 to :139.
- **The kill switch.** Register every new long-running part with `KillSwitch` as a `StopPart`. After a stop, no tool sends anything to any app.

## The overlay

- **One window per display.** Each display gets one transparent, frameless, `focusable: false`, click-through window, shown with `showInactive()`.
- **What takes clicks.** Its X input shape is exactly the rectangles `reportInteractive()` sends (app/renderer/overlay/main.ts). To make a new element clickable:
  - put it in `bubble.interactiveRects()` or `taskRects`;
  - set `interactiveDirty` when its box changes.

  The report goes to main only when the rectangles change. While Ember borrows the mouse the shape is empty, so the overlay takes no clicks.
- **No-ops on Linux.** `setIgnoreMouseEvents({forward:true})` and `setContentProtection` do nothing here.

## Consent, voice and privacy

- **Consent.** Read, hear and send nothing until `hasConsent` is true. A change to what Ember reads, sends or keeps bumps `CONSENT_VERSION` and updates the consent text in app/renderer/home/index.html.
- **The microphone.**
  - It opens only when all of these hold: Hey Ember is on, voice consent and general consent are given, the models are verified, and Ember isn't muted.
  - Keep the constraints `echoCancellation: true, noiseSuppression: false, autoGainControl: false`, because gain control and noise suppression distort speech enough to miss the wake word.
  - Speak replies only from the mic window, which tells the voice process while Ember speaks.
- **Audio** stays on the machine and is never written to disk.
- **Permissions.** Every web permission request is denied except audio `media` for Ember's mic window (`voicePermissions`). The spellchecker stays off, because it would download dictionaries.
- **Conversation data.**
  - Ember's own conversation log is in memory only.
  - Copilot's session state lives in `~/.config/ember/copilot/` only while Ember runs. It is deleted at quit, at the next start after a crash, and on sign-out.
- **The audit log.** Write every decision, question, answer, action, refusal, task outcome and stop to `AuditLog`:
  - workers use their `audit()` helper;
  - TaskManager writes task requests and outcomes;
  - KillSwitch writes stops.

  Typed text appears only as a character count. The journald copy (`journalctl -t ember-audit`, built by `journalLine()`) replaces goals, window titles, element names, chosen values and errors with their sizes; reasons, app names and shortcuts stay.
- **Tokens.** Store the GitHub token only with `safeStorage`, and never when its backend is `basic_text`. Accept `gho_`, `ghu_` and `github_pat_` tokens; refuse classic `ghp_` tokens.

## Settings and admin policy

- **New settings.**
  - Add the field to `SettingsSchema` with a `.default()`; a bad value is repaired field by field.
  - Read and change settings only through `SettingsStore`: `get()` returns them with the admin's policy applied, and `update()` writes atomically. Never write settings.json yourself.
  - Test it in settings.test.ts.
- **Admin-controlled settings.** If an admin should be able to turn a setting off, add the key to `AdminPolicySchema`, `applyAdminPolicy` and `managedKeys`, so Home shows it as managed. Document it under docs/DEVELOPING.md "For administrators".
- **The admin policy file.** `/etc/ember/policy.json` (`AdminPolicySchema`, `.strict()`) can only tighten Ember. If the file is unreadable or invalid, or isn't root-owned with no group or other write, apply `LOCKDOWN`. Because the schema is strict, an older Ember treats an unknown key as a broken file.
