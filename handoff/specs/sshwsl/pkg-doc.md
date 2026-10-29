# Package DOC: documentation for SSH, WSL and commands

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (all of it: the docs must
say what the owner decided, in plain words), then `specs/sshwsl/design.md`: header, "Limitations and departures"
(every row), §1, §3.5 (what asks), §3.7 (what announces), §5.2.3 and §5.2.7 (where the helper lives; removing it), §7.4
(consent), §8 (the words users see), §9 (admin keys and defaults), §10.3 (what was checked by hand), §12, and "Critique
resolutions" integration-17.

## Goal
Write the user, administrator and developer documentation for commands on every computer, WSL and SSH, so that every
limitation the design states is said plainly where a user or administrator will read it, and the release notes warn
that an older Ember locks down on a policy with the new keys (R5).

## Start and merge
Starts when S0a has merged (draft from the design); finalises after TG merges (check the words against the shipped UI).
Merges last of the main packages.

## Files you own
None new unless the repo has no place for a topic (then a new `docs/` page, linked from the README).

## Shared files you may touch
- `README.md`: a short section "Commands, WSL and other computers" (what Ember does, what it asks about, how to turn it
  off).
- `DEVELOPING.md`: the new folders (`app/main/{targets,commands,wsl,remote}`, `app/remote`, `app/askpass`), the new
  build entries, `remote.yml` and its variables, the OS-neutral unit-test rule, how to run the integration tests
  locally where possible, R12's remote-surface behaviour (the follow-up the DOC package of the port left), the policy
  lock-down note.
- `PLAN.md`: the SSH/WSL milestone, the open questions (§12 Q1-Q5) and the SX items.
- The release notes file the repo uses (`CHANGELOG.md` or equivalent): new features, the admin keys of §9.1 with the
  example of §9.2, "an older Ember locks down when it reads a policy with these keys", and every limitation L1-L26 a
  user can meet, in sentence case and British spelling.

## Contracts
None (documentation). Quote UI strings exactly as §8 has them; quote admin keys exactly as §9.1 has them.

## What to write (minimum)
- Commands: they run in Ember's own window; most run straight away; what asks (the D4.3 classes in plain words); what
  Ember announces when you asked for exactly that, with the 4 s Stop; what it never runs; Windows commands use
  PowerShell and can't ask for passwords (L3); profiles aren't loaded (L9); output goes to Copilot with secrets hidden
  best-effort; instruction-like output makes every later command ask (L26).
- WSL: what the WSL card means; the helper packages to install; why some Linux apps can't be read (no bus, X servers,
  Qt/Chromium apps); no mouse or keyboard in Linux apps yet (L7); WSL1 is commands only.
- SSH: what is copied, where, how big; that nothing persists; how to remove it with and without Ember; that voice and the
  GitHub sign-in stay on the PC; remote desktops: same user, local console session only, every step asked, no
  screenshots shown to you, VNC/xrdp not used (L21), macOS and Windows remotes (L6), Wayland (L5); the 20 s command
  grace (L10); Windows PCs and passwords (L15); jump hosts; noticing your own `ssh` and turning the offer off.
- Administrators: every key of §9.1, the defaults table of §9.3, where policies live (§9.2), the remote's own policy,
  `ssh.allowedHosts`, `ssh.commandGraceSeconds`, `ssh.runtimeMirror`, fapolicyd (L24).

## Tests
`npm run lint` (and any markdown link check the repo has) passes; no code changes.

## Acceptance criteria
- Every limitation L1-L26 appears in the user or admin docs in plain words, with its fallback.
- Every UI string quoted matches §8 exactly; every key matches §9.1.
- The release notes carry R5's lock-down warning.
