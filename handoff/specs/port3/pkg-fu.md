# FU: the shared-file follow-ups left by the Windows/macOS integration

Read first: /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/pkg-common.md
(conventions, commit style and trailers, commit early and often, testing). Background: specs/design.md (the port's
binding design), specs/followups.md (where these items came from, with file:line hints). Windows and macOS are now
switched on and proven on real runners; Linux behaviour must stay byte-for-byte identical unless an item says otherwise.

Worktree: /home/user/wt/fu (branch port3/fu, base 74a5cdc). Never push.

## Items (verify each against the code first; if one is already done or wrong, say so instead of forcing it)
1. macOS terminal check by bundle id: main.ts doesn't pass the app's bundle id to the policy's terminal check, so a
   terminal (Terminal.app com.apple.Terminal, iTerm2 com.googlecode.iterm2, Warp dev.warp.Warp-Stable, Alacritty,
   kitty, WezTerm, Ghostty…) shown under another display name could slip through. Make the darwin terminal check use
   the bundle id where Ember knows it (the vocabulary already has TERMINAL ids per OS — find them).
2. RUN_ANSWER lacks "Open" (policy.ts): on macOS, Gatekeeper's "are you sure you want to open it?" sheet runs a
   downloaded program when "Open" is pressed. Ember must never press it. Add it for darwin only (or in the darwin row of
   whatever table holds the run answers), with a test.
3. hands/system.ts idIsTerminal: treats any id part "console" as a terminal on every OS, so macOS's Console.app (the log
   viewer, com.apple.Console) is refused. Read TERMINAL_ID_WORDS[os] (or the equivalent per-OS table) so Linux keeps
   exactly today's words and macOS/Windows use their own. Test both.
4. Windows: File Explorer (and the desktop, both explorer.exe) runs .exe .com .bat .cmd .ps1 .vbs .vbe .js .jse .wsf .wsh
   .hta .msi .msp .scr .pif .cpl .lnk .url .appref-ms .jar files on double-click, Enter or the "Open"/"Run as
   administrator" menu items with no dialog. Add a policy rule: in an explorer.exe window, activating (click with
   double-click semantics, Enter/keys, the "Open"/"Run as administrator"/"Open with" items, invoking) a list or grid item
   whose name ends with one of those extensions → never("Ember doesn't run programs, so it never opens programs or
   scripts from File Explorer"). Single-click selection and reading stay allowed. Look at how runsProgram /
   RUNS_PROGRAM_EXTRA and the Run-dialog rule (READ_ONLY_WINDOW) are structured and follow them; Windows only.
   Note: hidden extensions — when Explorer hides known extensions the item name lacks the extension. If the element
   exposes its type/kind (UIA ItemType or a "Type" column like "Application", "Windows Batch File", "Shortcut") use it;
   otherwise document the gap.
5. The Run dialog rule (READ_ONLY_WINDOW) matches by app and title only, so a File Explorer folder window named "Run"
   is refused too. If the request carries the window's class (#32770 for the Run dialog) or a program other than
   explorer for a folder, narrow it; if nothing distinguishes them, keep the over-refusal (safe) and say so.
6. win32/system/apps.ts: findApp(apps, query) is called without the "win32" OS argument somewhere (followups.md) —
   check and fix if still true.
7. Pre-existing: APP_NAMES["constructor"] (app/shared/apps.ts) is a prototype lookup bug ("constructor", "toString"…
   return functions). Use Object.hasOwn (or a null-prototype map). This changes Linux only for those bogus names; say so.
Files you may touch: app/main/main.ts (minimal), app/main/policy/{policy,vocabulary}.ts, app/main/hands/system.ts,
app/main/platform/{win32,darwin}/** (only where an item needs it), app/shared/apps.ts, and tests. Keep each change
minimal; a parallel design for SSH/WSL will touch policy.ts later.

## Tests
Unit tests on Linux for every item (each new test must fail without its change — check by stashing only the source).
Full gate: `npx tsc --noEmit`, `npm run lint`, `npm test` (counts).

## Report (<= 40 lines)
Commits, per item: done / not needed / not possible and why; checks with counts; anything only a real Windows/Mac can
confirm.
