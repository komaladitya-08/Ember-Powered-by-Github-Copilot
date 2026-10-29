# LAST: the two gaps TAIL-scripts' reviewer left, and their docs

Read first: specs/sshwsl/pkg-common.md (and specs/pkg-common.md), decisions.md (OWNER DECISION 4), review/lead-notes.md,
and app/main/commands/scripts.ts + the classifier's path handling as they stand on your branch.

## Items
1. **`..` in a script's path (safety).** The classifier collapses `..` lexically, so `sh sub/../t.sh` or `cd link && sh ../t.sh`
   (sub/link a symbolic link) reads `<cwd>/t.sh` while the kernel runs the file beside the link's target. Ruling: resolve
   the script's path through the target's real-path report (inspectPaths) before reading, as §3.6 says; where the real
   path can't be had, a POSIX script path containing `..` asks ("Ember can't tell which script this runs"). Same for
   PowerShell/cmd if the same lexical collapse applies there. Unit tests (fail without the fix) + a commands-flow-local case
   with a real symlink.
2. **"Starting Ubuntu…" before the tab exists.** Add `pending(taskId: string, text: string | null): void` to the command window
   (app/main/commands/window.ts) and a renderer line in the command window that shows it until the run's tab appears or the
   text is cleared; flow.ts calls it from the WSL runner's onStatus before factsOf. Sentence case, British spelling. Tests.
3. **Docs.** docs/COMMANDS-WSL-SSH.md (and the release notes): the two items above, plus the accepted limits — writes Ember
   can't see (uudecode, split, macOS base64 -o, a program that generates a script, e.g. `python gen.py`) don't make that
   script's unreadable size ask (L8); an SSH remote forgets what a task wrote or downloaded when its agent restarts on a
   reconnect, so a padded script written before a reconnect runs unread after it.

## Checks / report
tsc, lint, npm test (counts), build, smoke, `EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run
test/integration/commands-flow-local.test.ts`. Report <= 30 lines.
