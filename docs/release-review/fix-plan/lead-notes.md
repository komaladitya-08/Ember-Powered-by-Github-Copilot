# Release fixes: lead notes (started 2026-10-27 ~06:00 UTC)

User asked (2026-10-27): fix ALL 277 review findings; voice: recommended approach (V1 in common.md); sign-in: user is
registering the GitHub App and will send the client id (S1: one checked-in place; then a one-line change).

Base: ember-improve/20261022-ssh-wsl at 1b39bb3. Packages: specs/relfix/packages.mjs, pkg-<key>.json, common.md.
Worktrees /home/user/wt/fx-<key>, branches fix/<key>. Workflow script:
/root/.claude/projects/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/workflows/scripts/ember-release-fix-wf_5d7cc7e3-726.js

| task id   | run id          | packages                       |
|-----------|-----------------|--------------------------------|
| wbnaz9st2 | wf_5d7cc7e3-726 | classify, cmdcore, voice       |
| w1sph7eq4 | wf_2c3bd8e0-f4d | perception, policy, lifecycle  |
| wlt5oplln | wf_286a6b1e-565 | agent, input, platform         |
| w76vz8av0 | wf_df7be1b8-93a | bubble, remote, prompt         |
| w7inzg87g | wf_82d6f4b2-323 | cmdwin, onboard, settings      |
| wkblj49w9 | wf_c14d0ee6-7e3 | shell, packaging, docs         |
| w8hjgmuwf | wf_02eb9d9c-e2d | css, ask, overlay              |

Plan after they finish:
1. Integration branch ember-improve/20261027-release-fixes from the ssh-wsl head (merge in any later ssh-wsl CI commits).
2. Merge fix/<key> one by one (--no-ff), resolve conflicts (hot: main.ts, windows.ts, targets/runtime.ts, home renderer,
   ember.css, presenter.ts), full gate after each few merges.
3. Docs follow-ups: collect every report's forDocs lines; apply.
4. Whole-diff adversarial review workflow (find -> verify) over base..integration; fix confirmed findings.
5. Full gate (tsc, lint, npm test, build, smoke, commands integration), push, dispatch ci.yml + remote.yml (via the
   -sshwsl-ci style branch name, or add the new branch to remote.yml's push triggers), iterate to green.
6. Report to the user: per-finding outcome table (fixed / not reproduced / left), CI status, what only real CI proves.

## GitHub App client id (from the user, 2026-10-27 ~06:05)
`Iv23liXa8A1wDXYg2jYw`. Added to common.md S1. At merge: make sure it sits in the agent package's checked-in place (else
set it there), and add a ci.yml step that POSTs https://github.com/login/device/code with it and expects a device_code
(proves the id is valid and device flow is enabled; this container's proxy blocks that endpoint, CI runners don't).
Can't verify from here whether Copilot accepts this app's user tokens: first real sign-in proves it.

## SSH/WSL CI state (06:35)
remote.yml run 12 green on every job (WSL1: WSL 16/16, PowerShell 8/8, Windows SSH 6 passed + the hello test's WSL1
refusal branch; WSL2 16/16). ci.yml run 138 green (Windows needed one re-run: win32-desktop foreground timing and an
Electron 0xc0000005 in win32-system, both flakes in port tests unrelated to SSH/WSL).
Still untested: a real-kernel Windows->remote hello (idea: sshd in the WSL2 job after its WA tests). The macOS commands
and SSH job never ran (dispatch/schedule only): now on push too (commit after 8df102b); read its first run.

## ssh-wsl commits after the fix base 1b39bb3 (merge them into the integration branch first)
57e29a8 accept-new first connect (WSL1 job); 4a70d2b remote parts in WSL1 job; 8df102b ssh-windows hello/refusal;
8b7fe3b macOS job on push; 5556bcd BSD script stdin fix (REAL macOS bug: every command failed to start on a Mac:
script's tcgetattr on Node's socket stdin -> EOPNOTSUPP); 63b88cd dnf --nobest (Rocky mirror skew).
Conflict watch: app/main/commands/run/{local,shells}.ts (cmdcore/cmdwin may touch), .github/workflows/*.yml (packaging).

## SSH/WSL branch fully green at 63b88cd (07:20)
remote.yml run 14: all 11 jobs green, incl. the first macOS job (commands-flow-local 17/17, commands-local macOS 4/4,
remote-ssh 11 + 1 skipped). ci.yml run 139: all jobs green first time. Remaining known gap: a real-kernel
Windows->remote hello (WSL1 is refused by the 4.18 gate, correctly).

## PAUSED by the user at ~07:25 UTC ("pause all agents as we are hitting limits")
All 7 workflows stopped (TaskStop). No scheduled check-ins pending. Committed work per package (commits since 1b39bb3 /
uncommitted files left by the stopped agents): classify 3/0, cmdcore 12/0, voice 15/2, perception 17/0, policy 25/0,
lifecycle 15/0, agent 27/0, shell 10/0, packaging 18/0, docs 17/1, bubble 26/0, cmdwin 20/0, prompt 12/1, onboard 22/0,
settings 18/0, css 12/3, remote 15/0, ask 17/3, overlay 15/0, input 8/0, platform 15/4.
To resume (when the user says so): re-invoke each workflow with
  Workflow({scriptPath: <script above>, resumeFromRunId: <run id>, args: <same packages>})
Completed agents replay from cache; stopped ones restart and should first look at their worktree's commits and
uncommitted files (git status) before redoing anything. Consider running fewer at once (limits): e.g. 3 workflows.
