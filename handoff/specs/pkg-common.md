# Common brief for every early work package of the Windows/macOS port

Project: Ember, an Electron 44 + strict TypeScript desktop companion/agent that today runs only on RHEL 8 (GNOME on
Xorg). We are porting it to Windows 10/11 and macOS 13+ without changing Linux behaviour.

## Where you work
- You work ONLY in your own git worktree (given in your package brief), on its branch. `node_modules` there is a symlink to
  the main checkout's; do not run `npm ci`/`npm install` (exception: the voice package may add one dependency, see its brief).
- Never modify `/home/user/Ember-Powered-by-Github-Copilot` (the main checkout) or any other worktree under /home/user/wt.
- Never `git push`. Commit on your branch (several coherent commits are fine).
- COMMIT EARLY AND OFTEN: the container can restart without warning and only committed work survives. Commit at every
  meaningful milestone (at least every ~20-30 minutes of work), even if the package isn't finished; a later commit can
  complete or amend the work (you may squash your own commits at the end with `git reset --soft` + one commit).
- `node_modules` in your worktree is a symlink and is excluded from git; never `git add -A` blindly — add your own files.
- Touch only the files your package owns (listed in its brief). If you find something outside your files that must
  change, do NOT change it: write it under "Needs from others" in your final report.
- Several packages run at the same time on this 4-CPU machine: run vitest on the files you need (`npx vitest run <files>`)
  while iterating, and the full `npm test` once at the end.

## Read first
- The lead's binding decisions: /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/decisions.md
- The interim platform contract: `app/main/platform/types.ts` in your worktree (WindowSystem, Input, ScreenLike,
  OwnWindowHandle, and the conventions for units, window ids, app names, keys and buttons). Implement against it exactly.
  If it is missing something you need, add it ONLY in your own files as an extension interface and say so in your report.
- The subsystem specs in /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/
  named in your brief (they were written from the code; verify against the code before relying on them).
- The owner's conventions: `git show origin/ember-improve/20261021-apple-design:CLAUDE.md` and the files under
  `.claude/rules/` on that branch (`git show origin/ember-improve/20261021-apple-design:.claude/rules/<file>`). Follow them:
  strict TS (noUnusedLocals/Parameters), `import type`, double quotes, semicolons, 2-space indent, a module doc comment
  saying what the file is and the constraint behind it, JSDoc on exports, comments that say why, kebab-case files, log
  events "area.snake_case", British spelling in UI/docs/comments, sentence-case UI copy, empty catch blocks get a comment,
  lint exceptions are narrow with a reason after `--`.
- koffi 3.2.1 rules: never call `koffi.view()` (lint enforces; it aborts Electron); copy native memory with
  `koffi.decode(ptr, "uint8_t", n)` or typed decode; bind each library once per module (lazily, inside the factory), never
  per call; pointers come back as BigInt or null; Win32 BOOL is `int` (koffi `bool` is 1 byte). Guard every `koffi.load`
  so a missing library returns null / a safe default instead of throwing at import time. Modules must import cleanly on
  every OS (tests import them on Linux): load native libraries only when a factory runs on its own OS.
- Electron may be imported only in app/main/main.ts, windows.ts, overlay.ts, handle.ts, ask.ts, voice.ts, revive.ts,
  desk/view.ts and preloads. Everything else (including app/main/platform/**) must load under plain Node: take Electron
  objects by injection (structural types such as `ScreenLike`).
- Safety: fail closed. If a check can't run, refuse / return null / send no image.

## Testing
- Put pure logic in pure functions and unit-test it on Linux with small fakes (test/unit/*.test.ts, vitest, `describe`
  names the subject, `it` states the behaviour). Tests must pass on Linux AND must not break on Windows/macOS.
- Tests that need the real target OS go in test/integration/*.test.ts and must skip unless running on that OS; when the
  package's env var (given in your brief) is "1" they must FAIL instead of skipping if the OS facility is missing.
  Integration files run only with `EMBER_INTEGRATION=1` (see vitest.config.ts).
- Before you finish: `npx tsc --noEmit`, `npx eslint <your files>` (or `npm run lint`), and `npm test` all pass on Linux.
  Report the exact commands and pass/skip counts.

## Commit style
Subject: one imperative sentence in sentence case stating the outcome, no period, no prefix. Body wrapped at 90 columns:
how it was checked, then "- " bullets of what changed. End every commit message with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CKo9mzHVkVu9toQkifgnWy
Never put a model name anywhere in code, comments or commit text.

## Final report (your return value)
Plain text, at most 60 lines: branch name and commit hashes; files added/changed; what is implemented; what was verified
(commands + counts); what can only be verified on the target OS (be specific, so CI can check it); "Needs from others";
risks/open questions.
