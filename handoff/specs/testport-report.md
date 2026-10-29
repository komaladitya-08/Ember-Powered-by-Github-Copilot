# testport report: the unit-test suite on Windows and macOS

Branch `port/testport` (worktree /home/user/wt/testport), on top of `e89a93f`. Only test files and
`vitest.config.ts` changed; no app code. Linux runs exactly the same tests with the same results.

## 1. Rules applied

1. **Linux-only subject** (desk, X11, AT-SPI sidecar, `.desktop` catalogue, inotify and `/proc`, the eval's live
   tier): the failing test is skipped off Linux with `it.skipIf(process.platform !== "linux")` /
   `describe.skipIf(...)`, or a single `if (process.platform === "linux")` assertion when the rest of the test is
   portable. Each gate has a one-line reason.
2. **POSIX modes in portable features** (logger, audit log, the desk's macro folders): only the mode assertion is
   skipped, and only on win32 (macOS has POSIX modes and they matter there).
3. **Test-only portability problems**: fixed so the test checks the same behaviour everywhere.
4. **App bug behind a failure**: not fixed; gated or adapted, listed in section 3; `// TODO(port):` where a test is
   gated only because of the bug.

## 2. Changes, per file

| file | test | change | why |
|---|---|---|---|
| agent-misc | "finds the bundled Copilot runtime" | skip unless linux-x64, `TODO(port)` | A1 |
| desk-agent | "reaps a helper … (SIGSTOP)" | skip off Linux | `startTime()` reads `/proc/<pid>/stat`; no SIGSTOP on Windows |
| desk-agent | "stops quietly" | the "reaped" assertion runs on Linux only | `/proc` |
| desk-live | `removeTree`, `reapDesks` suites | skip off Linux (the real-desk suite already was) | mounts from `/proc/self/mountinfo` matched with `"/"` (desk.ts:223); `/proc/self/stat`, `true`, `sleep`, `setsid` |
| desk | "knows a child has exited" | `running(process.pid)` asserted on Linux only | `/proc` |
| desk | "profile URL that survives spaces…" | compare `fileURLToPath(url)` with the folder instead of `URL.pathname` with `encodeURI(path)` | Windows paths; and Node escapes `~` as `%7E`, which a runner's 8.3 temp path (`C:\Users\RUNNER~1\…`) has, so even a portable `encodeURI` comparison fails |
| desk | "macro folders read-only" | the mode assertion is skipped on win32 | POSIX modes |
| desk | "clears the lock files … (DSK9-2)" | link made with type `"junction"` (ignored off Windows); listed names normalised to `"/"` | symlink rights on Windows; `readdirSync({recursive})` follows the link and gives `link\…`, which the `"link/"` filter missed |
| desk | "two folders down (DSK10-1)" | listed names normalised to `"/"` | `Documents\…` on Windows |
| desk | "the moment it stops (DSK10-1)" | also sets USERPROFILE, TEMP, TMP | Windows ignores HOME/TMPDIR for `os.homedir()`/`os.tmpdir()`; it would have scanned the real profile and reaped real temp desks |
| desk | "LibreOffice dialogs in the hand-off folder" | hand-off `path.resolve("/home/ana/Ember")`, expected `pathToFileURL(...)` of it | `file:///C:/home/ana/Ember` on Windows; identical on Linux |
| eval | "the live tier …" suite | skip off Linux | Linux-only by D8; also A2 |
| eval | "read files and folders" | `realpathSync(os.tmpdir())` instead of `realpathSync("/tmp")` | no `/tmp` on Windows |
| host | "inotify instances are counted in /proc" | skip off Linux | inotify, `/proc`, `process.getuid` |
| logger | "never throws on circular values…" | mode assertion skipped on win32 | POSIX modes (A7) |
| policy | "AuditLog appends JSON lines with owner-only permissions" | mode assertion skipped on win32 | POSIX modes (A7) |
| settings | "a change that can't be saved…" | on win32 the settings file is made read-only instead of the folder | Windows ignores a folder's read-only flag; `MoveFileExW(REPLACE_EXISTING)` (libuv 1.51 `fs__rename`) refuses a read-only target |
| tasks | "reaches an app's name and GenericName…" | skip off Linux | `.desktop` catalogue, `XDG_DATA_DIRS` is a `:` list (A4) |
| perception, private-windows | the Python sidecar checks | Python looked for on Linux only | the AT-SPI sidecar is Linux's; elsewhere `python3` may be the Store alias (Windows) or the developer-tools install prompt (macOS) |
| perception-x11 | "X11 on a real display" | also skip off Linux | XQuartz sets DISPLAY on a Mac |
| vitest.config.ts | | `testTimeout: 15_000` on win32 only | slow process starts, 15.6 ms timers, AV scans; worker-scroll tests take ~3 s on Linux against the 5 s default. Tests' own time bounds unchanged |

Expected off Linux, in the files this package owns: 28 skipped (agent-misc 1, desk-agent 1, desk-live 11, eval 2,
host 1, perception-x11 6, perception 1, private-windows 4, tasks 1), everything else in them passes.

## 3. App-code portability bugs found (for the platform phase; not changed)

- **A1** `app/main/agent/runtime.ts:9` — `RELATIVE` is `node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime`.
  npm installs only the current platform's optional package (`@github/copilot-sdk-{win32-x64,win32-arm64,darwin-arm64,darwin-x64,linux-arm64,linuxmusl-x64,…}`,
  per the SDK's optionalDependencies), so the runtime is never found on Windows, macOS or linux-arm64: the agent
  can't start; the conductor/persona/worker-safety integration suites and the smoke test fail. Fix:
  `locateRuntime({platform, arch, musl})` building `@github/copilot-sdk-${platform}${musl ? "musl" : ""}-${arch}/prebuilds/<same>/copilot-runtime${win32 ? ".exe" : ""}`
  (file names per build-test-ci.md §0.1, from `npm pack` listings), with a unit test per platform; then drop
  the gate in agent-misc.test.ts.
- **A2** `eval/src/exit.ts:58` — `path.join(env.XDG_RUNTIME_DIR || "/run/user/<uid>", "bus")` gives `\run\user\1000\bus`
  on Windows. Harmless while the eval is Linux-only (D8); use `path.posix.join`.
- **A3** desk (Linux-only by D5; informational): `app/main/desk/desk.ts:35` `which` splits PATH on `:` and needs X_OK,
  so `DeskManager.available()` is always "missing" on Windows; `desk.ts:223` `removeTree` matches mounts with
  `dir + "/"`; `app/main/desk/place.ts:130` splits PATH on `:`; `running()`/`startTime()`/`deskProcesses()`/
  `helperState()` (`desk/agent.ts:65`) read `/proc`. Fine as long as no desk code runs off Linux.
- **A4** `app/main/hands/system.ts:326` `listApps` (and `:78`, GTK themes) split `XDG_DATA_DIRS` on `:` with Linux
  defaults: correct per the XDG spec, but the Windows/macOS app catalogue must come from `SystemPlatform`, never from
  this (it returns `[]` there today).
- **A5** `app/main/windows.ts:32` `isTrustedSender` tests `decodeURIComponent(url).includes(path.sep + "renderer" + path.sep)`:
  file URLs always use `/`, so on Windows no renderer is ever trusted and every IPC handler refuses (fail closed,
  but Ember is unusable). Fix: `fileURLToPath(url)` and require it to start with `path.join(appDir, "renderer") + path.sep`
  (also stricter on Linux); add a unit test with mocked electron.
- **A6** `app/main/admin.ts:14,91-96` — `ADMIN_POLICY_FILE = "/etc/ember/policy.json"` is `<current drive>:\etc\ember\policy.json`
  on Windows, which any user can create; there `stat().uid` is always 0 and `mode & 0o022` is non-zero, so such a
  file always means LOCKDOWN (fail closed, but not the admin channel). D7: registry on Windows,
  `/Library/Application Support/Ember/policy.json` on macOS.
- **A7** POSIX modes as privacy: `logger.ts:65,89`, `policy/audit.ts:23,37`, `settings.ts:355,359`, `agent/conductor.ts:333`,
  `agent/auth.ts:49` set 0700/0600, which Windows ignores (only the read-only flag). Privacy there rests on the ACL
  of `%LOCALAPPDATA%\ember`; an `EMBER_USER_DATA` elsewhere (a shared folder) would leave logs and the audit log
  readable by others. Consider checking (or setting) the folder's ACL on Windows, or documenting it.
- **A8** `app/main/agent/host.ts:197,219` `inotifyUse("/proc", process.getuid?.())` returns null off Linux, so
  "out of file watchers" is never blamed there: correct (diagnostic only).

## 4. Where build-test-ci.md §3 was wrong or incomplete

- desk.test "clears the lock files (DSK9-2)" fails on Windows even with symlink rights (recursive readdir follows the
  link and lists `link\…`), not only without them.
- desk.test "profile URL": a portable `encodeURI` comparison still fails on runners (`~` → `%7E` in 8.3 paths).
- §3.1 "read-only files can't be unlinked (EPERM)" is not so with Node 22 (libuv 1.51 unlinks with
  `FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE`, else clears the flag); but rename onto a read-only file does fail.
  desk-live `removeTree` fails on Windows only through the `"/"` mount filter (A3).
- Python sidecar checks: where `python3` is only macOS's stub, running it pops up the developer-tools install
  dialog (and fails); on Windows it may be the Store alias (exit 9009).
- §3.2's darwin "P" for eval/perception/private-windows/tasks still holds; those are now skipped there by rule 1.

## 5. Verification

Run on Linux (Node 22.22, vitest 5.0.2, Electron binary present):
- `npx tsc --noEmit` → exit 0. `npx eslint vitest.config.ts <the 13 changed test files>` → exit 0.
- `npm test` → 56 files passed, 1 skipped; 2306 passed, 7 skipped (2313) — the same test names and statuses as
  the baseline run (diffed name by name). One baseline run had fuses.test.ts L79 time out at 5 s under load from
  the other packages (owned by packaging; passes when the machine is quieter).
- `TMPDIR=<a symlink to a folder> npm test` (macOS's `/var` → `/private/var`): 2306 passed, 7 skipped.
- A simulation harness (scratch, not committed: a vitest setupFile that hides `/proc`, deletes `process.getuid`,
  makes `os.homedir()/os.tmpdir()` read USERPROFILE/TEMP, refuses SIGSTOP and process groups, serves repo text files
  with CRLF, and fakes `process.platform` for the gates):
  - macOS-like (`/proc` hidden, platform darwin, symlinked TMPDIR): 2284 passed, 28 skipped, 1 failed
    (packaging.test.ts L158, not this package's file).
  - Windows-like (all of the above, platform win32): only expected failures — settings "can't be saved" (Linux
    lets a rename replace a read-only file, so the Windows branch can't be simulated) and packaging.test.ts (CRLF,
    not this package's). The same simulation on the original test files failed 7 tests in this package's files
    (desk-agent 2, desk-live 1, desk 2, host 1, settings 1).
- Windows path rules checked with `path.win32` and `pathToFileURL(…, { windows: true })` for the desk URL and
  listing fixes. libuv 1.51 `src/win/fs.c` read for rename, unlink, chmod, stat modes and dirent types of junctions.

Reasoned, not run (CI must confirm on windows-2022 and macos-15):
- path separators in the desk fixes; the junction (no symlink rights needed; read as a link by `readdir`, followed
  by recursive `readdirSync`); the settings read-only-file branch; the env overrides (USERPROFILE/TEMP); timings
  under the 15 s win32 timeout; Defender briefly holding a just-written file (`removeTree` would return false).
- The 15 s win32 default does not reach tests with their own timeout: worker-tools.test.ts has 13 at 8–15 s,
  six of which take 5.0–7.7 s on Linux (the PR7-2 menu test 6.1 s of its 8 s), almost all of it a real 5 s
  `wait_for_click` deadline plus 100–2200 ms timers, so Windows' coarser timers should add little; check their
  durations in the first windows-2022 run.
- desk-agent.test.ts keeps 5 of its 7 tests off Linux (narrowest gate): they fork the stand-in helper with an env
  of only HELPER_TEST, PATH and ELECTRON_RUN_AS_NODE (no SystemRoot on Windows); expected to pass, not run.
- Expected: every unit test passes on both, with 28 skips in this package's files (section 2) plus whatever
  the packaging/licences/voice/platform packages' own gates skip.

## 6. Needs from others

- Platform phase: A1 (then remove the agent-misc gate), A5, A6, A7; when `Platform` lands, launch-app.test.ts (asserts
  gtk-launch), overlay-shape.test.ts (expects libX11/libXext), ask-window.test.ts (a 4-byte XID; an HWND is 8 bytes,
  an NSView* on macOS) and environment.test.ts (win32/darwin cases) need gating or new cases.
- packaging: `.gitattributes` (`eol=lf`); its packaging.test.ts L158/L175 gates; consider a longer timeout for
  fuses.test.ts L79 (reads the ~200 MB Electron binary; 14 s under load here).
- CI: run `npm test` on windows-2022 and macos-15 and compare the skip list with section 2.
