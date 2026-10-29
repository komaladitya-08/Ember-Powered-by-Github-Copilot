# Release fixes, round 4: common brief for every package

Ember (Electron 44 + strict TypeScript desktop agent on the GitHub Copilot SDK; RHEL 8 GNOME/Xorg, Windows 10/11,
macOS 13+, plus WSL and SSH targets and commands) is about to be released. Rounds 1-3 of the release fixes are merged
into `ember-improve/20261027-release-fixes` (worktree /home/user/wt/relfix-int), gate green. Three final adversarial
reviews (safety, what users see, cross-platform) found the items in this round, and round 3's packages left a few. This
is the last round: keep each change minimal and exactly in the style of the code around it. Packages run AT THE SAME
TIME (up to three at once). Your package's items are in `specs/relfix4/pkg-<key>.json`. Each review item carries the
reviewer's scenario and evidence but was NOT checked by a second reviewer: confirm it against the code first (common
step 1) and say not-reproduced, with evidence, where it is wrong.
Fix every item.

All specs are under /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/.
The cross-reviewers' scratch repros are under .../scratchpad/xreview/ (paths are in each finding's evidence).

## Where you work
- Worktree `/home/user/wt/fx4-<key>` on branch `fix4/<key>`, based on the integration head your task names (BASE). If it
  doesn't exist yet, create it: `git -C /home/user/wt/relfix-int worktree add -b fix4/<key> /home/user/wt/fx4-<key> <BASE>`
  then `ln -s /home/user/Ember-Powered-by-Github-Copilot/node_modules /home/user/wt/fx4-<key>/node_modules`. `node_modules` is a symlink: never run
  `npm ci` or `npm install`; never `git add -A` (add your files by name).
- Never touch the main checkout or another worktree, never push, never touch ~/.ssh, system services, users or packages.
- COMMIT EARLY AND OFTEN (the container can restart; only commits survive). One commit per item, or per tightly related
  group, so the lead can merge and revert them separately. Commit style: imperative subject that says what changed for
  the user, a body that says what was wrong, how it is fixed and how it was checked, citing the item ("(cross-review
  X3)" or the review number it continues, "(review #263)"), then exactly these two trailer lines:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CKo9mzHVkVu9toQkifgnWy
- If your worktree already has commits since bbe8ab2 or uncommitted changes, an earlier run of your package was stopped:
  `git log --oneline <BASE>..HEAD`, `git status`, `git diff`; keep what is right, finish or discard the rest.

## Read first
- `specs/relfix2/decisions.md` (the owner's round-2 decisions).
- `specs/relfix/common.md`, sections "The owner's decisions for this round" (V1 voice and commands, S1 sign-in: the
  client id is now baked in, F fix them all), "For each finding", "Shared files" and "UI copy": they apply here too.
- `specs/pkg-common.md` sections "Read first" (the owner's conventions, koffi/Electron rules), "Testing", "Commit style".
- `specs/sshwsl/pkg-common.md` "Rules specific to this work"; `specs/decisions.md`; `specs/sshwsl/decisions.md` (OWNER
  DECISION 4 at its end supersedes earlier command rules); `docs/COMMANDS-WSL-SSH.md` §L1–L26 are accepted limitations.
- Your package file, then the code each item names (line numbers may have moved: search).

## For each item
1. Check it against the code. If it doesn't reproduce, change nothing and say so with evidence.
2. Reproduce it first: a unit test that fails on the current code (pure logic with fakes; renderer logic through an
   exported pure module or the repo's DOM tests), or a scratch script for timing/process/OS cases. Windows/macOS-only:
   unit tests with fakes, plus what only real CI can prove (ciOnly).
3. Fix the root cause, fail closed where safety is involved, show the test passing.
4. If it can't be fixed without a design change beyond your package, do the safest part and say exactly what is left.
5. Docs: there is no docs package this round. Update README.md, CHANGELOG.md, docs/DEVELOPING.md, DESIGN.md and any doc
   your change makes wrong yourself, in small hunks (other packages edit them too); the docs tests (test/unit/*docs*)
   must pass.

## Checks (all must pass before your last commit)
- While iterating: `npx vitest run <files>` (other packages run tests too on this 4-CPU machine).
- At the end: `npx tsc --noEmit`, `npm run lint`, `npm test` (full; a timing-sensitive test that fails under load: re-run
  that file alone and report both), `npm run build`.
- Renderer, overlay, bubble or a window changed: `xvfb-run -a npm run test:smoke`.
- Anything under app/main/commands/**: `EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run
  test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts`.
- A workflow file changed: parse it (python3 -c "import yaml; yaml.safe_load(open(...))") and `bash -n` every run block
  you touched (extract them).

## UI copy
Sentence case, British spelling, plain words, no internal terms (worker, job host, brain, sidecar, tier), the same name
for the same thing everywhere. Never put a model name in code, comments, copy or commit text.
