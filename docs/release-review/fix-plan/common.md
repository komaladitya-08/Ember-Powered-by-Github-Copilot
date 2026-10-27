# Release fixes: common brief for every package

Ember (Electron 44 + strict TypeScript desktop agent, powered by the GitHub Copilot SDK; RHEL 8 GNOME/Xorg, Windows
10/11, macOS 13+, plus WSL and SSH targets and commands) is about to be released. Twenty reviewers went over the
release candidate and found 277 issues. They are split into 21 packages that run AT THE SAME TIME. Your package's
findings are in `specs/relfix/pkg-<key>.json` (title, what it owns, and each finding with its id, severity, platforms,
file:line, scenario, evidence, suggested fix and the reviewer's confidence). Fix every one of them, polish items included.

All specs are under /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/.
The reviewers' own repro scripts and tests, where they wrote any, are under
/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/release-review/<lens>/
(the lens is each finding's `lens` field); use them to reproduce.

## Where you work
- Your worktree is `/home/user/wt/fx-<key>` on branch `fix/<key>`, based on `ember-improve/20261022-ssh-wsl` at 1b39bb3
  (main with the Windows/macOS port, plus the SSH/WSL/commands work). `node_modules` is a symlink: never run `npm ci` or
  `npm install`, never `git add -A` (add your files by name).
- Never touch the main checkout or another worktree, never push, never touch ~/.ssh, system services, users or packages.
- COMMIT EARLY AND OFTEN (the container can restart; only commits survive). One commit per finding, or per tightly
  related group of findings, so the lead can merge and revert them separately.

## Read first
- `specs/pkg-common.md`: the sections "Where you work", "Read first" (the owner's conventions and koffi/Electron rules),
  "Testing" and "Commit style" apply in full. Its "Touch only the files your package owns" is relaxed below.
- `specs/sshwsl/pkg-common.md`, section "Rules specific to this work": the bullets on koffi loading lazily, target paths,
  OS-neutral unit tests, failing closed, remote code loading under plain Node, and no new native or npm dependency apply.
  Its CI/push bullets and its contract-file bullets do not.
- The owner's binding decisions: `specs/decisions.md`, and `specs/sshwsl/decisions.md` (OWNER DECISION 4 at its end
  supersedes the earlier command rules). `docs/COMMANDS-WSL-SSH.md` §L1–L26 are accepted limitations.
- Your package file, then the code each finding names.

## The owner's decisions for this round (binding)
- **V1 Voice and commands.** On a computer where Ember can't tell its own voice or the speakers from the user (speaker
  rejection isn't running: Windows, macOS, and Linux without parec), (a) words that came by voice never satisfy D4.4's
  "you asked for exactly that": a dangerous command asks with the card, exactly as when the task has no user words;
  typed words still count; (b) Ember never speaks the kill phrase in its announcements there: it names the platform's
  stop chord instead (the existing shortcut words). Where speaker rejection runs, nothing changes.
- **S1 Sign-in.** The owner is registering Ember's GitHub App and will supply its public client id later. Make dropping
  it in a one-line change: one checked-in place for the id, baked into the build, with `EMBER_GITHUB_CLIENT_ID` still
  overriding it at run time. While that place is empty, every sign-in message, the doctor row and the README say plainly
  that sign-in needs a GitHub account with Copilot and the GitHub CLI (with how to install it on each OS).
  **Update:** the owner has now supplied the id: `Iv23liXa8A1wDXYg2jYw` (public by design). The package that builds the
  checked-in place (agent) puts this id there, so release builds sign in with the device flow; the empty-place wording
  stays for builds without an id (forks, development).
- **F Fix them all.** Take the reviewer's suggested fix unless the code shows a better or safer one. Keep each change
  minimal and in the style of the code around it. Linux, Windows and macOS behaviour that no finding names must not
  change.

## For each finding
1. Check it against the code on your branch. If it does not reproduce, or the reviewer misread the code, change nothing
   for it and say so in your report with the evidence (what you ran or read).
2. Reproduce it first: a unit test that fails on the current code (pure logic with fakes; renderer logic through an
   exported pure module or a DOM test if the repo has one), or for timing, process or OS cases a scratch script in the
   scratchpad. Windows/macOS-only behaviour: unit tests with fakes, plus a note of what only real CI can prove.
3. Fix the root cause, fail closed where safety is involved, and show the test passing.
4. If a finding can't be fixed without a design change beyond your package, do the safest reasonable part, and say
   exactly what is left and what you'd propose.
5. Docs: when a fix changes documented behaviour, update the line in docs/COMMANDS-WSL-SSH.md / DESIGN.md that says it
   (the docs package owns README.md, install docs and CHANGELOG; tell it via your report instead).

## Shared files
Other packages edit other areas at the same time. The hot files are app/main/main.ts, app/main/windows.ts,
app/main/targets/runtime.ts, app/renderer/home/**, app/renderer/shared/ember.css and app/main/agent/presenter.ts.
In a file your package doesn't own: make only the change your finding needs, in small self-contained hunks; never
reformat, move or rename code or shared exports; list every such hunk under "Shared hunks" in your report.

## Checks (all must pass before your last commit)
- While iterating: `npx vitest run <files>` (others run tests too on this 4-CPU machine).
- At the end: `npx tsc --noEmit`, `npm run lint`, `npm test` (full; if a timing-sensitive test fails under the load of
  other packages, re-run that file alone and report both), `npm run build`.
- If you changed any renderer, the overlay, the bubble or a window: `xvfb-run -a npm run test:smoke`.
- If you changed anything under app/main/commands/**: `EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run
  test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts`.
- If you changed the voice process: the voice unit tests, and the real-model voice integration suite if it runs here.

## UI copy
Sentence case, British spelling, plain words, no internal terms (worker, job host, brain, sidecar, tier), the same name
for the same thing everywhere. Never put a model name in code, comments, copy or commit text.
