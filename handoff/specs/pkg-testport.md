# Package testport: make the unit-test suite portable to Windows and macOS

Worktree: /home/user/wt/testport (branch port/testport).
Specs to read: build-test-ci.md §3 (per-test analysis of what fails on win32/darwin and why), gaps.md, decisions.md.

## Goal
`npm test` (vitest: test/unit/** and packages/**/*.test.ts) must pass on Windows (windows-2022, Node 22) and macOS
(macos-15, arm64) as well as Linux, WITHOUT changing app code, and WITHOUT changing what runs on Linux (same tests run and
pass on Linux: compare pass/skip counts before and after; baseline on Linux is 2306 passed, 7 skipped across 57 files when
the Electron binary is present).

## You own (and touch nothing else)
- test/unit/**/*.test.ts and helper files in test/unit/ EXCEPT: packaging.test.ts, fuses.test.ts, licences.test.ts,
  layout.test.ts, platform-*.test.ts, uia-files.test.ts, voice-models.test.ts, voice-untar*.test.ts, voice-bzip2*.test.ts
  (other packages own those)
- packages/**/*.test.ts
- vitest.config.ts
- a report file: /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/testport-report.md

## How
1. For each failing case in build-test-ci.md §3 (verify each one by reading the test and the code it exercises):
   - Behaviour that is genuinely Linux-only (X11, XTest, AT-SPI, the desk, gsettings, .desktop files, journald, /proc,
     POSIX modes as a security property, parec, RPM): gate it with `describe.skipIf(process.platform !== "linux")` /
     `it.skipIf(...)` and a one-line comment saying why. Prefer the narrowest gate.
   - Test-only portability problems (hard-coded "/" paths compared with path.join output, "/tmp", "/home/…" in
     pathToFileURL, HOME/TMPDIR overrides that Windows ignores (use os.tmpdir() and USERPROFILE too), realpath of temp dirs
     (macOS /var → /private/var), CRLF, process.getuid, SIGSTOP/SIGKILL semantics, `/bin/sh` scripts, file modes): fix the
     TEST so it checks the same behaviour portably.
   - Where the app code itself is not portable (e.g. PATH split on ":" instead of path.delimiter, "\\renderer\\" vs "/" in
     windows.ts isTrustedSender, hard-coded linux-x64 runtime path), do NOT change app code: gate or adapt the test if the
     behaviour is Linux-only, and record the app bug in your report (file:line, what breaks on which OS, suggested fix) so
     the platform phase fixes it. Leave a `// TODO(port):` comment in the test pointing at the report entry if you gate a
     test only because of such a bug.
2. Also look for failures §3 missed: run a careful review of every unit test file for platform assumptions.
3. You cannot run Windows or macOS here. To catch mistakes, you may run the Linux suite with environment tricks where they
   are faithful (e.g. TMPDIR with a symlinked path to mimic macOS realpath), but be honest in the report about what is
   reasoned rather than run. CI will run the suite on both OSes later.
4. Final check on Linux: `npm test` → same number of passing tests as the baseline (2306 passed, 7 skipped) unless you
   intentionally made a gated test run on Linux in a new form — explain any count change.
