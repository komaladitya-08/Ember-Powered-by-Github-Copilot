# TAIL-scripts: scripts read on every target, and the padding bypass closed

Read first: specs/sshwsl/pkg-common.md (and specs/pkg-common.md), decisions.md (OWNER DECISION 4), review/lead-notes.md
(the script-reading ruling), and what FINAL-cmd built: `git log --oneline 42ada31..HEAD -- app/main/commands` on your
branch (readScriptText / decodeScript in app/main/commands/run/inspect.ts, the script findings in classify/flow).

## Items
1. **WSL scripts.** Give the WSL runner `readScript(path, cwd): Promise<string | null>` (the CommandRunner extension FINAL-cmd
   defined): through WA's runScript WITHOUT mayBoot (a stopped distro → null), a fixed script that reads at most 65 537 bytes
   of a REGULAR file only (test -f, not a FIFO/device; never /dev, /proc, /sys; resolve relative to cwd), with a short
   timeout; raw bytes decoded like decodeScript (keep the BOM). Wire it where FINAL-cmd's flow asks the runner.
2. **SSH scripts.** Read on the REMOTE in gate 2 (the agent has the files): the agent's command gate reads a script with the
   same rules on its own filesystem and classifies its text with the same classifier; if the script's findings go beyond
   what the PC's stamp covered, gate 2 asks (as it already does for any extra danger). The PC side may stay unread (L8 for
   gate 1) — say so in the docs. Tests with the agent's fakes.
3. **Padding bypass.** Track files this TASK wrote in earlier commands (redirection targets, cp/mv/tee/sed -i destinations,
   unpack outputs: reuse FINAL-cmd's same-command write detection, now remembered per task like downloads). Running a script
   that this task wrote or downloaded asks when it can't be read in full (over the cap, unreadable, not a regular file). A
   script the task didn't write (a repo's ./configure, a 500 KiB build script) keeps today's L8 behaviour.
4. **"Starting Ubuntu…" in the command window.** Check whether FINAL-remote's followStatus in flow.ts already shows WSL's
   status on the tab before facts are read; if not, follow WslRunner.onStatus(fn) before factsOf so it does. Test.
Tests: unit tests that fail without each item; the local end-to-end suite still passes.

## Checks / report
As pkg-final.md (tsc, lint, npm test, build, smoke, commands-flow-local). Report <= 40 lines.
