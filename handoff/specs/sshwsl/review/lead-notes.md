# Lead notes for the final fix package (FINAL)
- From the commands lens's skeptic (L8 tightening, lead ruling): running a SHELL script (sh/bash/zsh/dash x.sh, source/.,
  ./x.sh with a shebang naming a shell, powershell -File / & .\x.ps1, cmd x.bat/.cmd) reads the script first through the
  target's inspect (size cap 64 KiB, the target's own filesystem, no network paths) and classifies its text with the same
  classifier as a nested command; the script's findings join the command's (a dangerous script asks; a refusal refuses).
  Unreadable/too big/not a shell script → today's behaviour (L8) unchanged. This closes `echo 'rm -rf build' > t.sh; sh
  t.sh` and `echo 'cat ~/.ssh/id_rsa' > t.sh; sh t.sh` (and the curl|sh form) running unasked. Corpus + flow tests.
- Commands-lens blocker fix list correction (skeptic 1, verified on bash 5.2): the builtins whose variable name operand
  runs a hidden subscript are printf -v, read, declare/typeset (with =), test -v / [ -v, unset (indexed arrays); treating
  any unresolved name operand of NAME_TAKERS as unclear is acceptable (asks more).
- After FINAL-wslreg (merged): flow.ts should follow WslRunner.onStatus(fn) before factsOf so the command window also
  shows "Starting Ubuntu…" (cmd area); docs: COMMANDS-WSL-SSH.md §3.4, GWSL program names in DEVELOPING.md, the
  NoticerDeps.wsl comment in offer.ts. Accepted: main.ts passes activeWindow to createTargets (one line).
