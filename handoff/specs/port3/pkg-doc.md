# DOC: document Ember on Windows and macOS

Read first: /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/pkg-common.md
(conventions, commit style and trailers, commit early and often). Then the port's binding design specs/design.md
(header, "Departures from decisions", §1, §10–§12, "Critique resolutions"), specs/decisions.md, specs/followups.md and
specs/ci-findings.md. The code on your branch is the truth: Windows and macOS are switched on and proven on real
windows-2022 / macos-15 runners (see the merge commits' messages: `git log --merges --format='%h %s%n%b' -15`).

Worktree: /home/user/wt/doc (branch port3/doc, base 74a5cdc). Never push. Touch ONLY documentation: PLAN.md, README.md,
docs/DEVELOPING.md (and docs/DESIGN.md only if something there is now wrong for Windows/macOS). No code, no CI.

## What to write
1. PLAN.md: it's the frozen v1 plan for RHEL 8. Don't rewrite history. Add the port as a recorded departure/extension:
   §1 (what v1 is: now also Windows 10/11 and macOS 13+), §2 rows that the port changes (each with a pointer to §10),
   a new milestone M11 "Windows and macOS" in §4 with its task list (done items marked as such, with the CI evidence),
   §9 (what comes after: the remaining manual checks from design §12.3, signing/notarisation, the open follow-ups),
   §10 progress (a dated entry for the port: what was built, how it was proven, departures from the design and why).
2. README.md: what Ember runs on now, how to install/run it on each OS (the zip / Ember.app / dmg as CI builds them;
   unsigned: what the user sees and does on first launch — SmartScreen "More info → Run anyway", macOS right-click Open
   or System Settings → Privacy & Security → Open anyway), the permissions macOS asks for (Accessibility, Screen
   Recording, Input Monitoring) and why, and the shortcuts per OS (Linux Ctrl+Alt+…, Windows Win+Alt+…, macOS
   Control+Shift+Command+… — take the exact table from app/shared/shortcuts.ts).
3. docs/DEVELOPING.md: a Windows section and a macOS section (setup, commands, what works without a display, the
   integration suites and their env vars as ci.yml runs them, the UIA bridge (PowerShell 5.1 Add-Type, the DLL cache
   EMBER_UIA_CACHE, execution policy notes incl. AllSigned/Restricted/CLM and the "Unblock it" fix), the AX provider and
   TCC (how CI grants it; what a developer grants locally, for the dev Electron vs Ember.app), packaging per OS
   (layout.mjs, Ember.exe resources via resedit, Ember.app's Contents/MacOS/Ember rename, fuses, ad-hoc signing, zip/dmg),
   where Ember keeps its data on each OS, the admin policy location per OS (registry HKLM\SOFTWARE\Policies\Ember
   PolicyJson; macOS profile/plist per the design), the audit log sink per OS, troubleshooting (the check-up's rows)),
   the CI workflow's manual inputs (`packages`, `intel`, `only`) and why (macOS minutes cost 10×; artifact storage),
   and the remote-surface rule (WSLg/Remote Desktop windows are refused and blacked out on Windows until WSL support
   identifies them). Update the repository map for app/main/platform/**, app/sidecar-host/**, sidecar/uia/**.
4. A DRAFT of the platform rule wording for the owner's CLAUDE.md and .claude/rules (the owner keeps those on another
   branch: `git show origin/ember-improve/20261021-apple-design:CLAUDE.md` and `.claude/rules/*`). Do NOT commit it:
   write it to /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/port3/claude-md-draft.md
   (what to change in the first paragraph, the Commands section, the repository map, and a new rule file
   "platforms.md" for app/main/platform/** and app/sidecar-host/**: units, ids, keys, koffi rules, Electron-import rule,
   fail closed, how to test on each OS).
Style: the owner's (British spelling, sentence case, plain words, short paragraphs, precise commands). Don't mention SSH
or WSL support beyond the remote-surface rule (that work is still being designed).

## Checks
`npm run lint` (markdown isn't linted, but keep the tree clean), and make sure every command you document exists
(package.json scripts, ci.yml steps, file paths). Commit.

## Report (<= 30 lines)
Commits, files changed, sections added, anything you found in the code that contradicts the design (for the lead).
