# Pre-release review and release fixes (work in progress)

Review material and fix plan for the release candidate (main with the Windows/macOS port, plus the SSH/WSL/commands
branch). Nothing here is merged; the fixes live on their own branches until they are merged and verified together.

- `REPORT.md`: the 20-reviewer pre-release review: 277 findings (3 blocker, 69 major, 133 minor, 72 polish), every
  blocker and major merged into 30 themes, then the other items by area, with each finding's scenario, evidence and fix.
- `findings.json`: every finding as data (its `id` is the number the fix commits cite as "review #N").
- `clusters.json`: the 30 themes and the findings in each.
- `fix-plan/`: how the fixes are split into 21 packages (`packages.mjs`, one `pkg-<key>.json` per package), the brief
  every fix agent works under (`common.md`, with the owner's decisions V1 on voice and S1 on sign-in), and the lead's
  notes (`lead-notes.md`).
- `wip/<key>.patch`: unfinished edits of the six packages whose agents were paused mid-change; each applies on top of
  its branch's tip (`git apply`).

Fix branches: `ember-improve/20261027-fix-<key>` (21 of them), each based on `ember-improve/20261022-ssh-wsl` at
1b39bb3. They hold finished commits only; their packages' independent verification had not run for most of them when
the work was paused.
