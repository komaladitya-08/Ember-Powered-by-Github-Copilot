# Classifier, round 3: make Ember's approval gate ask in the cases the review found

## What this work is
Ember is a desktop assistant whose AI model can propose shell commands. Before any proposed command runs, Ember's
classifier (`app/main/commands/classify.ts`) reads the command text and decides: run it, or stop and ask the user to
approve it on a card. This package makes that approval gate stricter: in each case below the classifier currently lets
a command through without asking, and the fix makes it ask the user first. Nothing here runs any command; the work is
pure string analysis plus test fixtures (`test/fixtures/commands/*.json`, run by `test/unit/commands-classify.test.ts`)
that list a command and the verdict Ember must give (`run`, `ask`, `refuse`).

Write test fixtures with plain example names: `~/.ssh/id_rsa` or `~/.aws/credentials` for a protected file,
`example.com` for a host, `build/` for a folder. The verdict is what matters, not the command's purpose.

## Read first
- `specs/relfix/common.md` (binding rules, commit style, checks; "Resuming after a pause" applies: the worktree already
  holds three commits from round 1, e5609a6, af9a30d and 9b161e4).
- `specs/relfix/pkg-classify-neutral.json`: the findings (ids 108, 165-175, 178), each with a scenario and a suggested fix.
- `specs/relfix/classify-verifier-neutral.txt`: the independent verifier's list after round 1, including four
  regressions round 1 introduced (commands that asked on the base and run now).
- A probe that prints the classifier's verdict for any command:
  /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/classify-probe/run.sh
  (and addcases.py beside it, which appends fixture cases without changing the file format).

## Your step
Your task text names your step (one of A-E). Do only that step, in `/home/user/wt/fx-classify` on branch
`fix/classify`, on top of the commits already there. For each item: add fixture cases that fail on the current code
(the verdict is `run` where it must be `ask`), make the smallest change in classify.ts that makes them ask, keep every
existing fixture passing, and commit (one commit per finding or tightly related group, citing "(review #N)").
- A. Round 1's regressions and partial fixes: bazel run's arguments read again; cmake -P reads its other arguments and
  -D values again; tar (and cmake -E tar) judge -T/-X/--files-from/--exclude-from values as files read (this also
  covers #174's tar part); a defaults path domain still goes through the LSQuarantine and security-domain checks;
  plutil judges every file argument, not only the last; the new NATIVE names (trust, plutil, plistbuddy, systemsetup,
  update-ca-trust, update-ca-certificates, bazelisk) no longer make an unknown program that merely mentions them ask
  (`mise trust` must run as on the base); #108's path-domain and dconf path points from the verifier.
- B. #165 and #166: a program given in an option value (git grep -O / --open-files-in-pager, ag/ack --pager, ugrep
  --filter, gdb/lldb -batch -ex) is classified as the command it is; a tool that reads its program from stdin or a
  here-document (make -f -, ninja -f, cmake -P -, awk -f -, sqlite3, psql, mysql, ex, ed, gdb -x) asks unless the
  program text is visible to the classifier and ordinary.
- C. #169 and #174: path rules apply to destinations given as option values (wget -P, aria2c -d, lwp-download, git
  checkout-index --prefix, git worktree add), Ember's own settings included; and options that name a file to read
  (date -f, du/sort/wc --files0-from, plus a general pass for file-valued options) are judged as reads.
- D. #170 and #171: docker/podman bind mounts (-v, --mount, --volume) are judged as access to the host path (a write
  unless :ro), and mounting the container engine's socket or a system folder asks; on Windows, a UNC path
  (\\fileserver\share\...) as a program, script or file argument asks (it reaches another computer).
- E. #172, #173 and #178: the protected start-up and PATH locations and the secret-store list gain the entries the
  findings name; local listeners, tunnels and data channels (python -m http.server, php -S, caddy/miniserve/busybox
  httpd, cloudflared tunnel, openssl s_client fed a file, the rest the finding lists) ask as network exposure.

## Checks before your last commit
`npx vitest run test/unit/commands-*.test.ts`, `npx tsc --noEmit`, `npm run lint`. The last step (E) also runs the
full `npm test`, `npm run build`, and `EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run
test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts`.

## Return
Per finding id in your step: fixed / partial / not reproduced, what changed, and the fixture cases; your commits; the
check results with counts.
