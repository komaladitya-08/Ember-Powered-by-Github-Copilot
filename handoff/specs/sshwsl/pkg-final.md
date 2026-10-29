# FINAL-<group>: fix what the whole-branch adversarial review confirmed

Read first: specs/sshwsl/pkg-common.md (and specs/pkg-common.md), specs/sshwsl/decisions.md (OWNER DECISION 4 and the
lead rulings), specs/sshwsl/handoffs.md, and the design sections a finding names.

Your findings are in specs/sshwsl/review/final-<group>.json (your group is in your task). Each was raised by a finder and
survived two independent skeptics trying to refute it; their notes (skeptic_notes) often sharpen the scenario or the
fix — read them. For the cmd group, also read specs/sshwsl/review/lead-notes.md (the lead's ruling to classify a shell
script's text before running it, and the corrected builtin list).

Two other FINAL packages run in parallel on other areas (cmd: app/main/commands/** and targets/resolve.ts; remote:
app/main/remote/**, app/remote/**, the remote parts of targets/runtime.ts and the command window's remote tab; wslreg:
app/main/wsl/**, policy/remote-surface.ts, agent/host.ts, and the WSL/binding/offer parts of targets/runtime.ts). Stay
in your area; in a shared file keep your hunks small and self-contained.

## For each finding
1. Reproduce it first (a unit test that fails on the current code, or a scratch script for timing/process cases).
2. Fix the root cause with the smallest change that closes it, fail-closed. Where a skeptic said a severity is overstated
   or the fix list is wider than needed, you may take the narrower fix if it still closes every scenario they proved.
3. Show the test now passes. One commit per finding (conventions and trailers per the common brief).
If a finding can't be fixed without a design change, say exactly why and what you'd propose; don't paper over it.

## Checks
`npx tsc --noEmit`, `npm run lint`, `npm test` (counts), `npm run build`, `xvfb-run -a npm run test:smoke`, and
`EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts`.

## Report (<= 40 lines)
Commits; per finding: fixed (how, test) / not fixed and why; checks with counts.
