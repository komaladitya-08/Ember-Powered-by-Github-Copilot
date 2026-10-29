# FIX: the lead's rulings on the integration reviewers' open questions

Read first: specs/sshwsl/pkg-common.md (and specs/pkg-common.md), specs/sshwsl/decisions.md (OWNER DECISION 4),
specs/sshwsl/handoffs.md (the INT-A/INT-B rows), and the design sections each item names. Base: the SSH/WSL branch with
every package, both integration packages and the docs merged. An adversarial whole-branch review runs in parallel
(read-only); keep each change minimal and in its own commit with a test that fails without it.

## Items (verify each against the code first; if one is already done or wrong, say so)
1. **Unknown host named as a place (safety).** "delete build/ on prod-db" where prod-db is neither a known target nor
   an ssh-config Host binds to the active computer and D4.4 can announce there. Ruling: when the user's words name a
   place that looks like a computer ("on/in/at/onto/into <token>" where the token contains a dot, a hyphen or a digit,
   or is an ssh-style user@host, and isn't the bound target's name/alias), D4.4 never announces in that task: every
   dangerous command asks, and the card's first line says "You named <token>, but this runs on <bound target>."
   Ordinary commands still run (they're ordinary anywhere). Keep it in TG's otherTargetsNamed / CL's intent seam, pure,
   tested with false-positive cases ("on the desktop", "in my home folder", "on line 12" must not trigger).
2. **Mixed scripts on the card (safety display).** INT-A ported UI's Latin+CJK exemption into CL's visible-text.ts.
   Ruling: follow §3.9.1 — a token mixing Latin letters with letters of another script is marked, CJK included; a token
   wholly in one non-Latin script (plus digits and punctuation) is not. Tests both ways.
3. **Screen lock scope.** INT-B stops every task on a remote whose screen locks. Ruling: follow §5.3.4 step 8 — a lock
   or an inactive session stops the tasks that use that computer's desktop (reads, steps, screenshots); tasks running
   only commands there continue (their command window is on the local PC). A Stop pressed at the remote, a lost link,
   Disconnect and the kill switch still stop everything there. Tests.
4. **WSL fix and check vs settings.** The wsl-a11y fix must refuse when the admin policy turns WSL off or WSL commands
   off ("Your organisation has turned this off."); the doctor's read-only check script must not run in a distro when
   the user's WSL switch is off (the row then says WSL is off). Tests.
5. **In-app setup check and its fix button.** The settings window's setup check must show targets.doctorRows() (as the
   CLI doctor does) and route IPC.applyFix("wsl-a11y:<distro>") to the targets runtime's applyFix(id), only from the
   home window (trusted sender), fail-closed on any other id. Tests.
6. **Wording.** Refusals for READING Ember's own files say "would read Ember's own …" (not "change"); check CL's D4.5
   reason table and pick the verb by the access kind. Tests.
7. **Docs.** docs/COMMANDS-WSL-SSH.md and the release notes: L10 also covers a local Linux/macOS run outliving an Ember
   crash until it writes output or ends (util-linux script ≥2.39 doesn't end at stdin's end); the rulings above (unknown
   place names ask, screen lock scope, WSL fix and admin policy); "delete build/" (with the slash) is the request form
   that runs with a notice, plain "delete build" asks. Re-check the docs' dangerous-class examples, redaction list,
   timeouts, stop ladder and non-interactive defaults against the merged code (DOC's open list in handoffs.md) and fix
   what's wrong.

## Checks
`npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, `xvfb-run -a npm run test:smoke`, and
`EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts`.

## Report (<= 40 lines)
Commits; per item: done / already right / not possible and why; checks with counts.
