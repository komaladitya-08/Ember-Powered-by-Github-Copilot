# Release fixes: where things stand (handoff, 2026-10-29)

This branch (`ember-improve/20261029-round4-handoff`) holds only these notes; don't merge it into the product.
`handoff/round4/` has round 4's specs (the rules every fix followed, the merge rules, and one JSON per
package with its items). `handoff/lead-notes.md` is the running log of all four rounds.

## Branches

| Branch | What it holds |
| --- | --- |
| `ember-improve/20261027-release-fixes` @ `0866316` | Rounds 1–3 merged plus the CI-test fixes. CI green on this commit: ci.yml run 147 (every OS + Intel Mac) and remote.yml run 19. |
| `ember-improve/20261022-sshwsl-release` | Fast-forwarded to the same `0866316`. |
| `ember-improve/20261029-fix4-<key>` | Round 4's six packages, each based on `0866316`, **not merged and not independently verified** (see below). |

## What is done

- Round 1: all 277 pre-release review findings fixed (21 packages).
- Round 2: 46 follow-up items from the cross-review (11 packages).
- Round 3: the owner's five decisions (RunAsNode, typed-ahead, shortcuts, handle position, the whole typed text
  shown before Allow).
- Round 4 (stopped part-way): 12 items found by round 3's reviews.

## Round 4: state of each package

The round was stopped while fixes were being verified. The disk filled up between about 15:10 and 16:40 UTC
and the workflow's record of the verifiers' results was lost, so treat every branch as unverified.

| Branch suffix | Items | State |
| --- | --- | --- |
| `fix4-auth4` | S1: signing out while a stored sign-in is renewed at start-up gets undone (`app/main/agent/auth.ts`) | 2 commits, fix agent reported done |
| `fix4-cmdwin4` | S2: a crashed command window page keeps the approve-key guard showing and its countdown running (`app/main/commands/window.ts`) | 2 commits (the second probably answers its verifier) |
| `fix4-offer4` | F-scanmax: past 5,000 `/proc` entries a running ssh looks ended (`app/main/targets/runtime.ts`) | 2 commits; the agent stalled when the disk filled and never reported |
| `fix4-perception4` | S3: "keeper", "seahorse", "strongbox" on the never-look list no longer cover window titles; P1: the ask context loses `Focused:` and `Selected text:` on Windows/macOS | 4 commits, fix agent reported done |
| `fix4-launch4` | P3: `--ask` left in argv reopens the ask box on every restart; P2: the smoke test's `--ask` check passes without the box showing | 2 commits, fix agent reported done |
| `fix4-ux4` | U1: the 2-minute answer time ignores reading the whole typed text; U2: the greeting drops the ask chord when there's no stop chord; U3: README/release notes promise a jump list that usually isn't there; U4: the ask box has two names; F-shortcuts-left: doctor hints, the dev `.desktop` entry and the consent words name the default chord | 7 commits plus `366803a`, a **WIP** repair (task time limit while a question waits) that was never run through the checks: finish it or drop it |

## Next steps, in order

1. For each `fix4-*` branch: read its JSON in `handoff/round4/`, check that each item's scenario is really gone,
   and run the checks: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`,
   `xvfb-run -a npm run test:smoke`, and, if the package touches `app/main/commands/`,
   `EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts`.
   Run the new tests against `0866316` too: they should fail there.
2. Merge into `ember-improve/20261027-release-fixes` one at a time, with merge commits, in this order: auth4,
   cmdwin4, offer4, perception4, launch4, ux4 (`handoff/round4/merge.md` has the rules for conflicts and checks).
3. Gate the merged head: the checks in step 1 plus `npm run test:integration`.
4. Review the round's diff (`git diff 0866316..HEAD`) adversarially, once for safety and what users see, once for
   cross-platform and lifecycle bugs. Fix whatever is real.
5. Push, then dispatch CI on the branch: ci.yml with `only=all`, `intel=true`, and remote.yml with `only=all`.
   Fix failures at the root (no skipped tests, no empty commits) until both are green.
6. Fast-forward `ember-improve/20261022-sshwsl-release` to the green head.

## For the release notes / final report

- RunAsNode is fused off on **macOS only**. Fuses are per OS, and the privilege it guards (inheriting Ember's
  macOS privacy permissions) only exists there. Windows and Linux keep it on; the reason is written down in
  the code. On macOS the accessibility helper runs as a utility process and SSH askpass runs as Ember itself
  (`--ember-askpass`).
- Typed-ahead: documented, and focus comes back faster (no keyboard hook). Measured on CI: Windows takes the
  keyboard back in about 25 ms (1 of 15 letters lost), macOS in about 49 ms (1 of 15; it was 3 of 15).
- Shortcuts: a fallback chord when the default is taken, plus an Ask Ember launcher entry; no remapping screen.
- Handle position: bottom right or bottom left, plus "Move to the other side".
- A typed text is shown whole before Allow; Allow arms only once all of it has been in view.
- Known limitation: an SSH offer can stay up to 25 s after its ssh ends.

## Environment note

Unit tests leave `ember-*` folders in the system temp folder, and vitest 5 leaves `ssr` module-cache folders
(up to 32 MB each) there. After a week of runs the old container had about 21 GB of them, which filled its
disk. On a long-lived machine, clear old ones now and then.
