# TAIL-misc: the runtime download's stall limit, and the docs brought up to date

Read first: specs/sshwsl/pkg-common.md (and specs/pkg-common.md), decisions.md, handoffs.md, review/lead-notes.md.

## Items
1. **Runtime download stall.** app/main/remote/runtime-download.ts has no stall limit: if no bytes arrive for 60 s, abort
   the download with a plain message ("The download of what Ember needs for <host> stalled. Try again.") and end the attempt
   as FINAL-remote's Cancel path does. Test with a fake fetch.
2. **Docs** (README.md, docs/COMMANDS-WSL-SSH.md, docs/DEVELOPING.md, PLAN.md, release notes — whichever hold each fact):
   - shell scripts are read and classified before they run (local, WSL; SSH on the remote's own check), a script the same
     command or an earlier command of the task wrote/downloaded asks if it can't be read in full, and other large scripts
     keep L8 (update L8's text);
   - remove "here" from the naming rules (design §2.3 rule 4 changed: a bare "here" no longer moves a task);
   - COMMANDS-WSL-SSH.md §3.4 (FINAL-wslreg's note), GWSL's program names in DEVELOPING.md's remote-surface list, and the
     `NoticerDeps.wsl` comment in app/main/targets/offer.ts (reads only distros running now, never boots one);
   - the remote fixes users notice: on OpenSSH before 8.5 a server's prompt is shown quoted as "<host> asks" (never as
     Ember's unlock card); output a slow link can't carry is dropped past a cap and the tab says so; the stalled-link
     countdown; a reconnect that gives up asks the user to sign in again;
   - the unknown-computer rule as FIX widened it (the forms listed in its commit), and that Windows without WSL treats
     "Linux"/"WSL" words as another computer for dangerous commands (they ask);
   - PLAN M12 statuses (all packages merged; CI not run yet: budget) and the list of CI runs owed (remote.yml jobs).
   Check every statement against the code on your branch.

## Checks / report
tsc, lint, npm test (counts). Report <= 30 lines.
