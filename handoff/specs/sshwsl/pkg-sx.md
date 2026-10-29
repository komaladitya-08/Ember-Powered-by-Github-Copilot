# Package SX: remote extras (may slip): Linux remote view and tier 3, Windows remotes, macOS remote desktop

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (R2, R6), then
`specs/sshwsl/design.md`: header, "Limitations and departures" (L4, L6, L15), §5 entirely, §7, §11.4 (SX row, with the
spike notes of critique remote-30 and remote-31), §12 (Q4), and "Critique resolutions" remote-30, remote-31.

## Goal
The parts of R6 the main packages leave out, each as an independent sub-part the lead schedules separately, each
starting with a **spike** whose report decides whether it ships. Nothing here blocks the main packages; anything that
can't be shown safe stays a stated limitation.

## Start and merge
Starts after TG has merged. Each sub-part is its own branch and report; the lead decides per sub-part which shared files
it may touch.

## Sub-parts
1. **Linux remote view and tier 3 on remotes** (lifts L4's no-tier-3 only while the view is open): masked frames ≤ 1 fps,
   ≤ 1280 px, over the existing bulk channel (`app/main/remote/view*.ts`, `app/renderer/remote-view/**`,
   `app/remote/view.ts`); the borrow's takeover rules applied to the view; tier 1 may then follow the local confirm
   rules for that remote (L4's "every step asked" relaxed only while the view is visible). Spike first: frame cost on
   RHEL 8 over 2 and 10 Mbit/s.
2. **Windows remotes**: the agent on win-x64; a PowerShell bootstrap whose stage 1 is short plain text reading stage 2
   from raw stdin with exact-length loops (`[Console]::OpenStandardInput()`; cmd's 8191-character command line; no
   `-EncodedCommand`, an EDR detection); check that PowerShell 5.1 doesn't pre-read redirected stdin before `node.exe`
   inherits it; frames written from a worker thread (Node writes pipes synchronously on Windows); PowerShell commands
   with every command asking when the SSH token is elevated (D4.6); the consent card says that key logins get an S4U
   token without DPAPI or network credentials (Git Credential Manager, `gh` and shares fail inside commands). Then a
   per-link desktop helper: an interactive-logon scheduled task created and deleted per link, with a one-shot trigger
   whose `EndBoundary` makes Task Scheduler delete it even after a crash, in the console or RDP session chosen
   explicitly, reached through a named pipe admitting only the user's SID with a one-time secret; **EDR spike first, and
   the owner's yes (Q4)**.
3. **macOS remote desktop**: through an Ember.app already installed on the Mac; `open -g -a Ember --args` passes no
   arguments to a running Ember and `-n` meets the single-instance lock, so the helper needs its own entry that skips the
   lock, or a separate helper bundle; TCC grants on an ad hoc-signed app are lost on every update (say so); a 0600 Unix
   socket in a 0700 folder with a peer-uid check and a one-time secret; it exits when the link drops.

## Files
New files only: `app/main/remote/view*.ts`, `app/renderer/remote-view/**`, `app/remote/{view,win32,darwin}/**`,
`app/main/remote/scripts/bootstrap.ps1`, their tests. Shared files only as the lead allows per sub-part.

## Contracts
Everything in §5.4 (add ops only through a protocol version bump the lead approves), `RemoteLink`, the ports, gate 2's
rules (they can only refuse or ask).

## Tests
Unit tests OS-neutral as everywhere; integration on real Windows/macOS runners where possible (`remote.yml`, new jobs
the lead adds); the rest manual (§10.3 additions written by the sub-part).

## Acceptance criteria (per sub-part)
- The spike report states what was measured and recommends ship / don't ship with reasons.
- Shipped code keeps every rule of §7 (no listener beyond R2's local IPC, nothing persists, stops when the link drops,
  never approves).
