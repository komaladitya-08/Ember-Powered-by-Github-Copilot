# Ember release fixes: handoff (stopped 2026-10-29, about 17:00 UTC)

This branch, `ember-improve/20261029-round4-handoff`, only carries notes; **don't merge it into the product**.
Read this file first. Everything it refers to is in `handoff/`:

| Path | What it is |
| --- | --- |
| `handoff/OUTCOMES.md` | The outcome of every finding: all 277 from round 1 and every item from rounds 2–4 |
| `handoff/specs/` | Every spec and report the work used, with paths unchanged (see "Reading the specs" below) |
| `handoff/specs/relfix/lead-notes.md` | The lead's running log of the release fixes, minute by minute; the most detailed record |
| `handoff/workflows/` | The orchestration scripts used for each round (Claude Code workflow scripts), reusable as templates |

## 1. In one paragraph

Ember is ready except for round 4. `ember-improve/20261027-release-fixes` (and `ember-improve/20261022-sshwsl-release`,
fast-forwarded to it) is at `0866316`. That commit has rounds 1–3 merged and passed every CI job: ci.yml run 147 on
every OS including the Intel Mac, and remote.yml run 19. Round 4 has 12 small items from the reviews of round 3. Their
fixes are committed on six `ember-improve/20261029-fix4-*` branches but are **not verified, not merged and not run on
CI**. To finish: verify each branch, merge them, gate, review, run CI until green, fast-forward the release branch.
Section 6 gives exact steps.

## 2. Background

- Ember is an Electron 44, strict TypeScript desktop agent built on the GitHub Copilot SDK. It runs on RHEL 8
  (GNOME/Xorg), Windows 10/11 and macOS 13+, and can work in WSL and over SSH, including running commands there.
- Earlier work, all done and on these branches: the Windows and macOS ports, then SSH and WSL. The specs for those
  are `handoff/specs/*.md`, `port3/` and `sshwsl/`.
- Pre-release review: 20 reviewers (10 release-readiness, 10 UI/UX) found **277 findings**, in
  `handoff/specs/relfix/pkg-*.json` (key `findings`).
- Release fixes, run in rounds:

| Round | What | Result |
| --- | --- | --- |
| 1 | All 277 findings, in 21 packages (`specs/relfix/`) | 261 fixed, 16 partial (their remainder went to round 2 and the owner decisions) |
| 2 | 46 follow-ups from a cross-review of round 1, in 11 packages, plus two owner-decision packages (`specs/relfix2/`) | Merged (9912de5); gate green |
| 3 | The owner's remaining decisions and leftovers, in 5 packages (`specs/relfix3/`) | Merged (aa399c0); gate green |
| CI fixes | Two test fixes from ci.yml run 146 and remote.yml run 18 (`fix3/ci-tests`) | Merged (0866316); **CI green** |
| 4 | 12 items from three adversarial reviews of round 3, in 6 packages (`specs/relfix4/`) | **Stopped part-way** |

## 3. Branches on GitHub

| Branch | Commit | State |
| --- | --- | --- |
| `ember-improve/20261027-release-fixes` | `0866316` | The integration branch. Rounds 1–3 plus the CI fixes. CI green (ci.yml run 147 with Intel, remote.yml run 19). |
| `ember-improve/20261022-sshwsl-release` | `0866316` | The release target; the same commit. |
| `ember-improve/20261029-fix4-auth4` | `919a5b4` | Round 4, see section 5 |
| `ember-improve/20261029-fix4-cmdwin4` | `6a1a5f0` | Round 4 |
| `ember-improve/20261029-fix4-offer4` | `2e2ecad` | Round 4 |
| `ember-improve/20261029-fix4-perception4` | `cdafbc0` | Round 4 |
| `ember-improve/20261029-fix4-launch4` | `fd433a4` | Round 4 |
| `ember-improve/20261029-fix4-ux4` | `366803a` | Round 4; the last commit is WIP |
| `ember-improve/20261029-fix2-*`, `ember-improve/20261029-fix3-ci-tests`, `ember-improve/20261027-fix-*` | | Backups of earlier rounds' package branches, all merged. Nothing to do. |

`main` is not an ancestor of `0866316` (it moved on separately). No pull request has been opened: the owner opens
one when they decide to.

## 4. Where it stopped, exactly

- 13:59 UTC: the round 4 workflow started from `0866316`, with fixes, verification and repair running three at a
  time. ci.yml run 147 and remote.yml run 19 on `0866316` both passed.
- About 15:10–16:40: the container's disk filled up. Test runs had left about 21 GB of temp folders over a week
  (see section 10). The workflow's record of results broke, the offer4 fix agent stalled, and the ux4 and offer4
  agents finished their work in RAM-backed copies.
- About 16:50: the owner asked to stop and hand off. I stopped the workflow and committed ux4's half-done repair as WIP.
  I pushed all six packages, fast-forwarded the release branch to `0866316`, and pushed this branch.
- Verifier results for round 4 were not recorded. cmdwin4's second commit and ux4's WIP commit look like answers to
  their verifiers, but treat every package as unverified.

## 5. Round 4 packages

Each package's JSON in `handoff/specs/relfix4/` holds the reviewer's scenario and evidence for each item, and the
files that package owns. Reviewers saw each item once, and no second reviewer confirmed it. Confirm the scenario
before trusting the fix.

| Package | Item | What was wrong | Commits on the branch |
| --- | --- | --- | --- |
| auth4 | S1 (major) | Signing out while a start-up renewal of a stored sign-in is in flight is undone: the renewed sign-in is saved again and Ember reconnects (`app/main/agent/auth.ts` ~529) | b78d124 the renewal isn't saved back after a sign-out; 919a5b4 a sign-in look overtaken by Sign out connects nothing |
| cmdwin4 | S2 | A crashed command window page keeps the approve-key guard "in view" and its countdown running while the page is blank, up to a minute per crash (`app/main/commands/window.ts` ~651) | 861b4fd nothing on a crashed page counts as seen until it reloads; 6a1a5f0 the model is told a crash or close ended a countdown, not the user's Stop |
| offer4 | F-scanmax | `SCAN_MAX` stops a process scan at 5,000 `/proc` entries, so on a busy Linux computer a running ssh past that point looks ended and its offer goes (`app/main/targets/runtime.ts`) | 908c26e keep an ssh offer on a computer running over 5,000 processes; 2e2ecad the same when WSL's process list was cut short. The agent never reported back. |
| perception4 | S3 | A never-look entry equal to "keeper", "seahorse" or "strongbox" no longer covers window titles, e.g. the Keeper web vault in a browser (`app/main/perception/elements.ts` ~466) | 291c22a |
| perception4 | P1 | On Windows and macOS the ask box takes the keyboard before the quick context is read, so `Focused:` and `Selected text:` drop out of the ask context (`app/main/ask-open.ts` ~36) | 10accf1, a8e4dbe (also from the handle's menu), cdafbc0 (CI checks of the read on real Windows/macOS; docs say only what is proven) |
| launch4 | P3 | A start from the launcher's Ask Ember keeps `--ask` in argv, so Restart Ember and the policy restart reopen the ask box unasked (`app/main/install-watch.ts` ~73) | 329a002 |
| launch4 | P2 | The smoke test's "--ask opened the ask box" check passes without the box ever showing (`test/smoke/launch.mjs` ~81) | fd433a4 |
| ux4 | U1 | A long typed text can't be read before its question runs out: the 2-minute question time ignores the whole-text block (`app/main/agent/confirm.ts` ~283) | fadb68f; plus **366803a WIP**: the time a question waits shouldn't count against the task's 20 minutes. It was never run through the checks, and the new `test/unit/task-time-limit.test.ts` may not pass. Finish it or drop it. |
| ux4 | U2 | The greeting drops the ask chord whenever Ember holds no stop chord, and the reverse (`app/main/hello.ts` ~18) | 608c2a6 |
| ux4 | U3 | README and the release notes send Windows users to a taskbar jump list that usually isn't there (`README.md` ~214) | 5542c6d |
| ux4 | U4 | The ask box has two names, "the Ask box" and "the ask box" (`app/renderer/home/index.html` ~185) | 3d8b264 |
| ux4 | F-shortcuts-left | `ember doctor` hints, the development `.desktop` entry and the consent words name the default chord, not the fallback Ember actually holds | 5218b76, 95780bf, de5c51b |

## 6. How to finish, step by step

Setup: Node 22.12 or later, `npm ci`. On Linux the smoke test needs `xvfb-run`. Work from
`ember-improve/20261027-release-fixes`.

1. **Verify each round 4 branch**, in a worktree based on `0866316`:
   - Read the package JSON and confirm each item's scenario on `0866316`.
   - Run the branch's new tests against `0866316`: they must fail there and pass on the branch.
   - Read the diff for behaviour changed beyond the items, safety that fails open, per-OS breakage, and docs that
     say what the code doesn't do.
   - Run `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build`.
   - If renderer, overlay or window code changed: `xvfb-run -a npm run test:smoke`.
   - If `app/main/commands/**` changed:
     `EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts`.
   - Fix problems with new commits on the package branch.
   - For ux4, settle the WIP commit first.
2. **Merge** into `ember-improve/20261027-release-fixes` one package at a time, with `git merge --no-ff`, in this
   order: auth4, cmdwin4, offer4, perception4, launch4, ux4. Follow `handoff/specs/relfix4/merge.md`: resolve
   conflicts keeping both sides' intent, and run the changed packages' tests after each merge.
3. **Gate** the merged head: everything in step 1, plus `npm run test:integration` (the checks job's list; speech
   tests skip without their models, which is expected). Parse workflow files with
   `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <file>`.
4. **Review** `git diff 0866316..HEAD` adversarially, twice:
   - Safety and what users see: approval gates, never-look lists, secret fields, sign-in and sign-out, the command
     window, copy, keyboard and screen-reader routes, the ask box.
   - Cross-platform and lifecycle: Windows, macOS, RHEL 8, WSL, SSH, argv and relaunches, process scans, timers and
     listeners that leak.

   Fix what is real. If a review finds several real bugs, run a short round 5 the same way.
5. **Push and run CI.** Dispatch both on `ember-improve/20261027-release-fixes`:
   - `ci.yml` with `only=all` and `intel=true`.
   - `remote.yml` with `only=all` and an empty `ref`.

   Root-cause every failure: no skipped tests, no empty commits to re-run.
6. **Fast-forward** `ember-improve/20261022-sshwsl-release` to the green head.
7. **Write the final report** (section 9) and give it to the owner.

## 7. How the rounds were run (to keep the same quality bar)

- **Process:** each package's agent fixes items test first. An independent verifier then checks the code, not the
  report, and runs the new tests against the base. The fix agent repairs what the verifier found. Packages are then
  merged one at a time, the gate runs, and two or three adversarial reviewers each take a different lens.
  `handoff/workflows/ember-release-fix-round4.js` is that pipeline as a script.
- **Rules every fix followed:** `handoff/specs/relfix4/common.md`. It points to `specs/relfix/common.md` (owner
  decisions, "For each finding", shared files, UI copy), `specs/pkg-common.md` (conventions, testing, commit style)
  and `specs/sshwsl/pkg-common.md`. Owner decision 4 at the end of `specs/sshwsl/decisions.md` supersedes earlier
  command rules. `docs/COMMANDS-WSL-SSH.md` §L1–L26 are accepted limitations.
- **Commits:**
  - The subject is imperative and says what changed for the user.
  - The body says what was wrong, how it was fixed and how it was checked, citing the item (e.g. "(review #263)",
    "(cross-review X3)").
  - Commits so far end with a co-author trailer and a session trailer. A new session uses its own attribution.
  - One commit per item or per tightly related group. Merge commits, never rebase or force-push shared branches.
  - Never push to `main`. Open a pull request only when the owner asks.
- **UI copy:** sentence case, British spelling, plain words, no internal terms (worker, job host, brain, sidecar,
  tier), one name for one thing everywhere. No model names in code, comments, copy or commit text.

## 8. CI and test notes learned the hard way

- `workflow_dispatch` works on non-default branches. A push of an existing commit to a new branch doesn't trigger
  workflows, so dispatch them. Path filters only see the first 300 changed files.
- ci.yml inputs: `only` (all / linux / windows / macos), `intel` (adds the Intel Mac job) and `packages` (upload
  build artifacts). remote.yml inputs: `ref` and `only` (all / unit / commands / wsl / ssh / macos / wayland /
  arm64).
- `test/warm-text.ts` (vitest globalSetup) builds the fontconfig cache. Without it, the first text drawing on a
  Windows runner can take more than 15 s.
- OpenSSH before 8.5 doesn't mark a server's prompts, so every secret prompt there is the host's quoted question
  ("other"). `ssh-transport.test.ts` follows `ssh -V`.
- The Windows commands tests warm PowerShell in `beforeAll`: a cold first start can take longer than a test's time.
- The UIA bridge reads long lists through a slim prefetch (`sidecar/uia/ember_uia.cs`, `ShortLevel = 400`,
  `ListedOffscreen = 50`). `PROTOCOL.md` and `providers/fake.ts` mirror it.
- macOS app names can contain a soft hyphen ("System­einstellungen"); names are folded with `\p{Cf}` removed.
- A Windows probe path ending in a backslash broke the app's argument; test paths go through `path.resolve`.

## 9. Owner decisions and what the final report must say

Owner decisions (details in `specs/relfix2/decisions.md` and `specs/relfix/common.md`):
- V1: voice and commands both ship.
- S1: the GitHub App client id `Iv23liXa8A1wDXYg2jYw` lives in one checked-in place
  (`app/main/agent/github-app.ts`). `EMBER_GITHUB_CLIENT_ID` overrides it. ci.yml's checks job verifies the id
  starts a device sign-in.
- F: fix them all, including minor and polish findings.
- D-177, RunAsNode: "move the helpers, fuse off". This applies to **macOS only**. Fuses are set per OS, and the
  privilege involved (inheriting Ember's macOS privacy permissions, TCC) only exists on macOS. Windows and Linux keep
  RunAsNode on, with the reason in the code. On macOS the accessibility host runs as a utility process, and SSH
  askpass runs as Ember itself (`--ember-askpass`). **Tell the owner this scoping explicitly.**
- D-78, typed-ahead: documented, and the box takes the keyboard sooner; no keyboard hook. Measured on CI: Windows
  about 25 ms with 1 of 15 letters lost; macOS about 49 ms with 1 of 15 lost (it was 3 of 15).
- D-45b, shortcuts: a fallback chord when the default is taken, plus an Ask Ember launcher entry. No remapping screen.
- D-75, handle: a position setting (bottom right / bottom left) plus "Move to the other side".
- Lead decision, in line with command cards: a typed text is shown whole before Allow, and Allow arms only once all
  of it has been in view.

Final report checklist:
- The per-finding outcome table (`handoff/OUTCOMES.md`, with round 4's rows updated).
- CI status on the final head.
- The macOS-only RunAsNode scoping.
- Known limitations:
  - An SSH offer can stay up to 25 s after its ssh ends.
  - What only real Windows, macOS, WSL or SSH can prove (each package report's `ciOnly`).
  - `docs/COMMANDS-WSL-SSH.md` §L1–L26.

## 10. Environment notes

- Unit tests leave `ember-*` folders in the system temp folder, and vitest 5 leaves `ssr` module-cache folders
  there, up to 32 MB each. A week of runs left about 21 GB, which filled the old container's 40 GB allowance. On a
  long-lived machine, clear old ones now and then. A cleanup in the tests would be a reasonable follow-up.
- Specs mention old container paths. Read them this way:

| Path in the specs | Means |
| --- | --- |
| `/tmp/claude-0/.../scratchpad/specs/` | `handoff/specs/` |
| `/home/user/wt/relfix-int` | A checkout of `ember-improve/20261027-release-fixes` |
| `/home/user/wt/fx4-<key>` on `fix4/<key>` | `ember-improve/20261029-fix4-<key>` |
| `.../scratchpad/xreview/` | The cross-reviewers' scratch copies (173 MB), not kept; each finding's evidence still names the code |
