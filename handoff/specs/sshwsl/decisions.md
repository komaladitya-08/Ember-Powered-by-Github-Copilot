# SSH and WSL: the owner's decisions (binding; asked and answered 2026-10-22)

Request (owner's words, summarised): WSL — the agent should be able to interact with what the user wants to do in WSL.
SSH — when the user SSHes into a system, the local Ember installs its clone inside it; the user speaks to it from the
local PC; the voice request goes to the remote; the remote acts; whatever it says is spoken on the local machine only.
Maximum parallelism, finish as soon as possible.

## Answers
1. **WSL scope: Linux GUI apps AND shell commands.** Ember sees and acts inside WSLg Linux GUI apps, launches WSL apps,
   works with WSL files, AND may run commands in a WSL shell — in a visible terminal, confirmed by a click every time,
   secrets never reaching the model. This lifts the "never runs programs or commands / never acts in terminals" rule
   FOR WSL SHELLS ONLY, under a new, separately designed and fail-closed command capability.
2. **SSH acts on: the remote desktop AND the command line.** The remote Ember acts on the remote machine's logged-in
   graphical desktop (existing Linux/Windows/macOS backends) and may run shell commands on the remote — each confirmed by
   a click on the LOCAL PC. Works on headless servers too (commands only there). Lifts the no-commands rule for the
   remote SSH shell only, under the same command capability.
3. **SSH brain: LOCAL.** The Copilot sessions (conductor, workers), the presenter/bubble, the Confirmer, voice (wake word,
   VAD, ASR) and TTS all stay on the local PC. The remote "clone" is Ember's eyes and hands there (perception, hands,
   and the command runner), under the remote machine's own admin policy and its own audit log. The GitHub token never
   leaves the local PC; nothing Copilot-related is installed on the remote.

## Consequences the design must respect (lead's notes)
- Local commands stay forbidden: the new command capability applies only to a WSL distro shell and an SSH remote shell.
  Ember still never acts in the user's own terminals or runs programs on the local OS.
- Audio never leaves the local PC: the local wake word + ASR produce text; only text goes to the remote (the owner said
  "the voice input goes to the remote" — honoured as the *request* going there; say so in the report).
- Every command: shown in full before it runs, confirmed by a click/approval key on the local PC every time (never
  "Always"), runs in a visible terminal the user can watch and stop, never receives secrets from the model (sudo/password
  prompts go to the user, not the model), output returned to the model as untrusted text, logged in the audit log
  (both sides for SSH). Destructive/privileged commands get the risky wording. The kill switch stops a running command.
  An admin policy key can turn commands off (default: off for new features? — the design decides, fail-closed rules).
- The remote side accepts instructions only over the authenticated SSH channel the local Ember opened; it stops when the
  channel drops; it never listens on a network port; approvals can only originate from the local UI.
- Consent: the local consent text covers SSH/WSL use (bump CONSENT_VERSION); the remote machine's own admin policy binds
  the remote agent.

## Lead rulings (2026-10-22, after the understand pass; binding on the design unless it proves one unsafe or unworkable)
These settle the contradictions in gaps.md §1 and its owner questions §6 with the safest workable defaults. The lead
reports them to the owner.
- R0 Baselines: the brain is LOCAL (decisions 3). Ignore the remote-brain recommendations and the remote-brain sizing in
  agent-ui-split.md and install-transport.md. Headless remotes get commands only (decisions 2).
- R1 Visible terminal (Q1): an Ember-owned command window (X1) that shows the exact command, then its live output, with
  a Stop button; the user may type into it (passwords, answers) and that input goes straight to the process, never to
  the model, never to a log. Rendering may use @xterm/xterm (pure JS, MIT; pin exactly; renderer only) — the one new npm
  dependency allowed. No new native dependency: get a PTY on the far side (sshd's own PTY via a separate `ssh -tt`
  session, or `script(1)` inside the remote/distro), fall back to pipes with non-interactive defaults (sudo -n,
  DEBIAN_FRONTEND=noninteractive, stdin closed) where no PTY exists. While echo is off, output is withheld from the model.
- R2 Helpers and listeners (Q2): nothing persists. No autostart, no service, no logon task left behind. Linux remote
  desktop = option A: a child of the SSH login that joins the SAME user's active local session (discovered from logind
  and that session's processes, never from the SSH login's env; refuse a DISPLAY with a host part). Windows/macOS remote
  desktop: an on-demand helper inside the user's interactive session is allowed ONLY if started by the SSH-side agent for
  the life of the link, reached over a user-only local IPC endpoint (Unix socket 0600 in a 0700 dir with a peer-uid check,
  or a named pipe whose ACL admits only the user's SID), single client, a one-time secret handed over the SSH channel, and
  it exits when the link drops. That is not a network port, so decisions allow it. Where that can't be done safely (e.g.
  macOS TCC refuses the helper), that OS is "commands only" in v1 — a stated limitation with the fallback.
- R3 Root (Q3): refuse to act (desktop or commands) when the SSH login is uid 0 or a WSL distro's default user is root;
  tell the user how to fix it. Never use `wsl.exe -u root`. Hide docker-desktop* distros. `sudo` inside a confirmed
  command is allowed, worded as privileged; the password is typed by the user in the command window.
- R4 Noticing the user's own ssh (Q4): yes. Read-only detection of local ssh client processes (process list + the host
  argument only, never their terminal), then a one-click "Bring Ember to <host>?" offer in the bubble. Ember always opens
  its OWN connection. A setting turns the offer off; admin policy can turn SSH off entirely.
- R5 Admin defaults (Q5): no admin policy → WSL GUI, SSH and commands available (commands still need the user's first-use
  opt-in per target). An admin policy that exists but doesn't mention the new keys → WSL GUI and SSH desktop allowed
  under the existing rules; commands OFF (the admin never agreed to them). Both machines' policies bind for SSH; the
  stricter wins. Older Embers locking down on unknown keys is acceptable (fail closed); document it.
- R6 v1 remote matrix (Q6): Linux x64/arm64 remotes: X11 desktop (full) + POSIX commands; a Wayland session: reading and
  accessibility actions only (no synthetic input), or less if the design finds AT-SPI unusable there; headless: commands.
  macOS remotes: POSIX commands; desktop only if the remote user has granted the helper (else commands only). Windows
  remotes: PowerShell commands (confirmed every time, conservative classification) + desktop via the R2 helper if the
  design finds it safe. Order the packages so Linux remotes and WSL land first and the Windows/macOS remote-desktop
  packages can slip without blocking anything.
- R7 Approving commands (Q7): a command is approved only by a click on Allow in the command card that shows the whole
  command (monospace, every control/bidi/zero-width character made visible, nothing truncated), or by the approve chord
  ONLY while that card is on screen showing the whole command. Never through an OS notification: the notification and
  the spoken text say only "Ember wants to run a command on <target>" and bring up the card. Approval binds to the exact
  bytes + target + task; any change needs a new approval. No "Always".
- R8 Parsing: no tree-sitter. A hand-written conservative POSIX tokenizer (and a conservative PowerShell one for Windows
  remotes) classifies reads/changes/privileged/destructive; anything it can't parse confidently is refused with "Ember
  can't show exactly what this would do". Never-run classes (background/outlive the kill switch, download-and-run, other
  hosts, reading known secret paths, touching Ember itself, interactive full-screen programs) are refused.
- R9 WSL interop: a WSL command may not start Windows programs or write Windows drives. Disable interop for the command's
  process tree if WSL allows it (verify), and in any case refuse commands that name /mnt/<drive>, \\wsl$ paths back, *.exe,
  cmd/powershell/pwsh/wslview/explorer; the card says such a command could reach Windows files when it touches /mnt.
- R10 Same machine: the same-machine check (machine id, loopback, the user's own WSL) runs BEFORE anything is uploaded.
  Tests may connect to localhost only with a test-only switch honoured solely in unpackaged builds.
- R11 Consent: a first-use consent card per feature (WSL, SSH, commands) and per host, recorded locally (and on the remote
  for SSH), instead of bumping CONSENT_VERSION for every user — unless the design shows the global bump is required.
- R12 WSLg windows today: the lead is fixing the gap now on the integration branch (an msrdc/WSLg window Ember can't
  identify gets no action at any tier and is masked in captures). The WSL packages build on that and replace the
  blanket refusal with real identification.
  (Done: merged as dcbbb6b — app/main/policy/remote-surface.ts, REMOTE_SURFACE/isRemoteSurface/remoteSurfaceCheck and
  the unused-yet isWslgImage(path); policy.ts refuses non-read, non-open_app actions on them; Perception's
  isRemoteSurface option masks them in captures.)

## OWNER DECISION 4 (2026-10-22, later the same day; SUPERSEDES every command rule above where they conflict)
Owner's words: "whether it's on a Linux machine, Windows machine, or macOS, or through WSL or SSH, we should allow most
of the commands because the models are not smart enough to do most of the work [otherwise], except the dangerous work
like deleting some files or submitting to GitHub or Perforce, or deleting some files from Perforce or GitHub, or such
kind of dangerous activities, or any sensitive files, etc. So we should be only stopping those kind of options, that
too in an ask manner. If the user is intentionally doing it, we should be allowing them. Otherwise, we should stop and
ask for the input."

What this means (binding; the lead's reading of the owner's words):
- D4.1 Targets: the command capability exists on EVERY target: the local machine (Linux, Windows, macOS), a WSL
  distro, an SSH remote. Decision 1/2's "commands only in WSL/SSH shells" and "local OS commands stay forbidden" are
  REPLACED. (Ember still never types into the user's own terminal windows through the GUI: commands go through the
  command tool and Ember's own command window. The GUI terminal refusals in policy.ts stay as they are.)
- D4.2 Default = run without asking. Ordinary commands (reads, builds, tests, searches, edits inside the user's work,
  git status/diff/log/add/commit, p4 opened/sync/edit, installing nothing, etc.) run straight away. They still run in
  Ember's visible command window (live output, a Stop button), the kill switch stops them, they are audited, and their
  output reaches the model as untrusted, size-bounded text with secrets redacted best-effort.
- D4.3 Dangerous commands STOP AND ASK (a question the user answers; never a silent run, never a flat refusal).
  Dangerous classes (the design must make this complete and precise, per shell: POSIX sh/bash/zsh, PowerShell, cmd):
  a) deleting or destroying data: rm/rmdir/unlink/shred/srm, del/erase/rd/rmdir /s, Remove-Item, find -delete/-exec rm,
     git clean, git reset --hard, discarding changes (git checkout -- / git restore on modified files), git branch -D,
     git stash drop/clear, overwriting an existing file (> redirection, mv/cp/Copy-Item/Move-Item onto an existing file,
     dd of=, tee without -a), truncate, mkfs/format/diskpart/fdisk/parted, emptying the trash/recycle bin;
  b) submitting or publishing anywhere: git push (any form), gh pr create/merge/close, gh release create, gh repo
     create/edit, gh api with a write method, p4 submit / p4 shelve / p4 unshelve -f, npm/pnpm/yarn publish, docker push,
     twine upload, uploading files to another host (scp/rsync/sftp/curl -T/--upload-file/-F @file, Invoke-WebRequest
     -InFile);
  c) deleting from source control or a remote service: p4 delete / obliterate / revert of opened work, git push --delete
     or :ref, git push --force/--force-with-lease, deleting remote branches/tags, gh repo/release/issue delete;
  d) sensitive files and secrets: reading, copying or changing credentials and secrets (~/.ssh, ~/.gnupg, ~/.aws,
     ~/.azure, ~/.kube, ~/.config/gh, ~/.docker/config.json, .netrc, .npmrc/.pypirc with tokens, .env files, keychains /
     Credential Manager / secret-tool / security find-*-password, browser profiles, password managers' stores,
     /etc/shadow, SAM/SECURITY hives), printing tokens (gh auth token, env | grep TOKEN, printenv of secret-looking names);
  e) privilege and system changes: sudo/su/doas/pkexec/runas/Start-Process -Verb RunAs, package install/remove/upgrade,
     services (systemctl/service/sc/launchctl load|unload|bootstrap), registry writes (reg add/delete, Set-ItemProperty
     HKLM/HKCU), firewall, users and groups, recursive chmod/chown/icacls/takeown, cron/at/schtasks/launchd agents,
     shutdown/reboot/logoff, killing processes the user didn't start in this task;
  f) download-and-run (curl|sh, wget -O- | bash, iwr | iex, running a file downloaded in this task), and commands that
     outlive the kill switch (nohup, setsid, disown, &, start /b, Start-Process without -Wait, docker run -d, systemd-run);
  g) anything the parser can't classify confidently (unknown syntax, eval, aliases it can't see, encoded commands like
     powershell -EncodedCommand, base64 | sh) → ASK, never run silently.
- D4.4 "If the user is intentionally doing it, allow it": a dangerous command runs WITHOUT a question when the user's OWN
  words for this task (typed or spoken text — the trusted channel; never the model's text, screen text, file contents or
  command output) explicitly ask for that kind of operation on that target and that object: e.g. "push my branch to
  GitHub" covers `git push origin <that branch>` (not --force, not another remote/branch); "delete build/" covers
  `rm -r build` (not paths outside what was named, not a broader glob); "submit my changelist" covers `p4 submit -c <n>`.
  Matching is deterministic code, conservative, and covers only the class, target and object the user named, for that
  task only. When it matches, Ember announces it in the bubble ("Pushing to GitHub, as you asked") with a short Stop
  window before it runs, and audits it as "user-requested". Anything broader than what the user named (force flags,
  wildcards, recursion outside the named path, a different repo/branch/changelist/host) → ASK. Classes d (secrets) and
  f (download-and-run, outliving the kill switch) and every command the parser can't classify ALWAYS ASK, even when
  requested. Whenever it asks: the question shows the whole command (R7's card), and the user's yes runs it.
- D4.5 The only flat refusals left for commands: anything that would disable or tamper with Ember's own safety
  machinery (its admin policy, audit log, token store, install, settings files, the kill switch, its own processes) or
  drive Ember itself (approving its own questions, sending keys to Ember's windows). Say why in plain words.
- D4.6 Root / Administrator: when the shell runs as uid 0 or an elevated Windows token (SSH as root, a WSL distro whose
  default user is root, an elevated Ember), every command counts as privileged (class e) and asks. R3's flat refusal of
  root is replaced by this for commands; acting on a remote DESKTOP as root stays refused.
- D4.7 Admin policy can: turn commands off (per target kind: local, wsl, ssh), force "ask for every command", and list
  allowed SSH hosts. R5 still holds: an admin policy that exists but doesn't mention commands turns them OFF. No admin
  policy → commands on with D4.2-D4.4.
- D4.8 R1 (Ember-owned command window), R2, R4, R6, R7 (how an ask is shown and answered), R10, R11 still hold. R8 is
  amended: "can't parse confidently" → ask (D4.3 g), not refuse; the never-run classes become asks (D4.3 f) except
  D4.5. R9 is withdrawn: Windows programs started from WSL are ordinary commands, classified like any other (a
  dangerous one asks). Consent (R11): one first-use consent card for commands, naming that Ember runs most commands
  without asking and asks before dangerous ones.
