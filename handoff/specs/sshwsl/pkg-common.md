# Common brief for every SSH/WSL work package

You are one of several packages running AT THE SAME TIME to add SSH and WSL support to Ember. Everything in
/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/pkg-common.md
still applies (worktree rules, COMMIT EARLY AND OFTEN, the owner's conventions, koffi and Electron rules, testing, commit
style and trailers, final report format). Read it first, then this file, then your brief.

## Read, in this order
1. The owner's binding decisions: specs/sshwsl/decisions.md (every word binds: local brain; the remote is eyes, hands and
   a command runner; audio and the GitHub token never leave the local PC). OWNER DECISION 4 at its end supersedes the
   earlier command rules: commands may run on every target (local Linux/Windows/macOS, WSL, SSH); ordinary commands run
   without asking, in Ember's own visible command window, stoppable and audited; only dangerous commands ask (or run
   with an announcement when the user's own words explicitly asked for exactly that); output is untrusted; secrets are
   redacted best-effort and never typed by the model.
2. The binding design: specs/sshwsl/design.md (header, "Limitations and departures", then §11 for your package row, then
   every section your row names, then the rows that name your package in "Resolutions of gaps.md" and "Critique
   resolutions"). Its TypeScript is normative.
3. Your brief: specs/sshwsl/pkg-<key>.md (files you own, contracts, tests, acceptance criteria).
(All specs live under /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/.)

## Rules specific to this work
- Your worktree's base already contains Step 0a (the shared SSH/WSL contract: types, schemas, normative launcher texts,
  stubs, build entries, lint rules, `.github/workflows/remote.yml`), and Step 0b (the shared hooks) when your brief says
  you start after it. Code against the files on your branch exactly. If the contract lacks something you need, add an
  extension interface in YOUR files and list it under "Needs from others"; never edit the contract files unless your
  brief owns them. A stub file your brief names as yours (marked "(S0a stub)") is yours to replace; keep its exported
  signature.
- Two Windows/macOS integration packages (I-win, I-mac) are editing app/main/platform/{win32,darwin}/**,
  app/sidecar-host/**, sidecar/uia/** and the windows/macos jobs in .github/workflows/ci.yml in parallel. Do not edit
  those files unless your brief says so; put SSH/WSL code in new files. No SSH/WSL package edits `ci.yml`.
- Shared files (main.ts, agent/**, policy/**, hands/**, perception/**, app/shared/**, app/renderer/**, scripts/**,
  package.json): edit only those your brief lists, minimally, and keep behaviour identical when no WSL/SSH target is in
  use and when the admin policy turns WSL/SSH/commands off. Linux, Windows and macOS behaviour without SSH/WSL must not
  change: run the full `npm test` before your final commit. List every shared-file hunk in your report.
- Anything that runs on a remote machine must load under plain Node (no Electron import anywhere in its import graph;
  the ESLint rule from Step 0a checks it).
- **koffi loads lazily** inside the function that needs it, in every file under `app/main/commands/**`,
  `app/main/wsl/**`, `app/main/remote/**` and `app/remote/**` (a top-level import crashes the agent on a macOS remote,
  which ships no koffi). Never `koffi.view()`.
- **Paths of a target use the target's rules**: `node:path/posix` or `node:path/win32` (or CL's `resolveTargetPath`),
  never bare `node:path`, in `app/main/commands/**`, `app/main/wsl/{runner,service}.ts`, `app/main/remote/**` and
  `app/remote/**` (lint-enforced).
- **Unit tests are OS-neutral** (they run in I-win's and I-mac's CI jobs too): spawn, fs, `/proc`, koffi, timers and the
  environment come in as fakes or parameters; never read `process.env`, `process.platform` or the real filesystem
  outside a temp folder; never spawn `script`, `sh`, `ssh`, `wsl.exe` or PowerShell from `test/unit`. Real processes go
  in `test/integration` behind the variable your brief names. vitest runs with `environment: "node"`: test renderer
  logic through exported pure modules.
- Safety fails closed: an unknown target, a malformed message from a remote or a distro, an unverifiable bundle, a policy
  that can't be read, a command that can't be shown exactly as it will run: refuse, and say why in plain words.
- Never run real `ssh` to another machine or modify the system's WSL state from tests. Unit tests use fakes for ssh and
  wsl.exe. Integration tests run only in `remote.yml`'s jobs (sshd on localhost, setup-wsl on Windows runners) and are
  gated by the env var your brief names: skip without it, FAIL when it is "1" and the facility is missing.
- **CI**: this container is Linux without sshd or WSL. If the lead's task text for your package allows pushing, you may
  push ONLY your own branch `ember-improve/20261022-sshwsl-<key>` and dispatch `remote.yml` with `only` set to your
  job (procedure: specs/pkg-i.md "Running CI yourself", with `workflow_id: "remote.yml"`), at most 4 runs (macOS at
  most 1). Otherwise don't push: report your integration job as "not run" and the lead runs it after merging. Never
  push any other branch. You may edit only the set-up steps of the `remote.yml` jobs your brief names.
- No new native dependency and no new network listener. A new npm dependency only if your brief explicitly allows it
  (only Step 0a adds one: `@xterm/xterm` 5.5.0).

## Final report (your return value)
At most 60 lines, as pkg-common.md says, plus: the exact contract functions you call from other packages (name +
signature) and anything you had to assume about them; every shared-file hunk (file and one line each); which
"(verify)" items of the design you settled and how, and which remain.
