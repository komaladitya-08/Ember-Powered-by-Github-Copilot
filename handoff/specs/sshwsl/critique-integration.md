# Critique of sshwsl/design.md: integration and non-regression

Reviewer lens: does the design fit the code as it stands on `ember-improve/20261022-windows-macos` (832045e, I-win and
I-mac already merged as 74a5cdc/fc2bffb, FU as bdb160e)? Does Linux/Windows/macOS behaviour stay the same when no
WSL/SSH target is used? Do the build and packaging work on every OS, and can the packages really run in parallel next
to I-win/I-mac? Design line numbers are `design.md:N`. Code references are repo paths at 832045e.

What I checked and found sound (no finding):
- The `Pick<>` ports (`design.md:3399-3403`) cover every member the worker and Perception use today. The worker uses
  `perception.{read,perceive,windows,atPoint,systemDialogOpen}` and `sidecar.{readElement,canDo,doAction,setText,
  setValue,selectOption,listOptions,scaleOf}`. Perception uses the eight `PerceptionSidecar` members. Every worker
  `perception.read` call passes `null, undefined` for the X11 arguments (`worker.ts:2519-2797`), so the wire op
  `perceive.read {target, keep, cells}` is enough. `systemDialogOpen` is already async (`perception/index.ts:581`).
- The modules SB reuses on the remote load under plain Node. I bundled policy, audit, admin, killswitch, perception,
  sidecar, the Linux window system, x11, hands/system, logger and the darwin admin-policy loader with esbuild
  (platform node, koffi external). The graph has 102 inputs and no `electron`. sharp appears only as a lazy
  `requireCjs("sharp")` string (see finding 3).
- The `RunAsNode` fuse stays on (`scripts/package/fuses.mjs:39`), so the askpass helper and a job-host helper can run
  as Ember's own binary. `.gitattributes` forces LF, so `bootstrap.sh` and `.py` files keep LF when Windows builds
  them. The lockfile pins `@koromix/koffi-linux-{x64,arm64}` and `darwin-*` with integrity, so `remote-parts.mjs`
  can verify them.
- `TurnWatch` doesn't time out while a tool runs (`conductor.ts` `check()`: `this.working && !this.tools.size`), so a
  long `run_command` doesn't trip TURN_SILENT_MS.
- `script(1)` argv forms (`design.md:885-887`): util-linux 2.32 has `-q -e -f -c`. BSD takes
  `script -q file cmd args…`. Both accept a non-tty stdin (util-linux checks `isatty`; BSD opens the PTY without
  termios). See finding 31 for the one EOF caveat.

Findings, most severe first.

---

1. **Step 0's privacy hook undoes the merged macOS terminal check (bundle-id lookup).**
   - Evidence: `main.ts:1347` passes `isTerminalApp: name => isTerminalWindowApp(name, sys.apps, platform.os)` to the
     PolicyEngine. On macOS, `isTerminalWindowApp` (`hands/system.ts:377-384`) also matches a renamed Terminal by its
     catalogue entry's bundle names. FU merged this ("main.ts: on macOS pass the bundle id to the policy's terminal
     check", followups.md). Step 0 hook 2 (`design.md:3504-3508`) replaces it with
     `privacy.isTerminalApp({ id: name, name })`, built on `a => sys.apps.isTerminalApp(a)`, so that lookup is gone.
     A renamed Terminal.app (or iTerm) would no longer be refused at gate 1 on macOS. Step 0 is meant to change no
     behaviour (`design.md:3474`).
   - Severity: **blocker** (a safety rule regresses in the package that must change nothing).
   - Fix (S0): build the privacy union on top of today's check:
     `wslAwarePrivacy({ isSecurityWindow: sys.privacy.isSecurityWindow, isTerminalApp: a => isTerminalWindowApp(a.name ?? a.id, sys.apps, platform.os) })`.
     Then keep the PolicyEngine wiring as `isTerminalApp: name => privacy.isTerminalApp({ id: name, name })`. Add a
     Step 0 test: on darwin a catalogue app whose keyword is "Terminal" under another display name is still refused
     through `main`'s wiring. The test fakes `sys.apps` the way `darwin-terminal-window-app.test.ts` does.

2. **As specified, the remote bundle check fails every build on every OS, including I-win's and I-mac's CI jobs.**
   - Evidence: `design.md:2355-2357` fails the build if `sharp`, `fetch`, `net`, `http`… "appear in the bundle's esbuild
     metafile inputs or its code".
     - `perception/index.ts:15` imports `captureRect` statically, and `perception/capture.ts:49-53` contains
       `requireCjs("sharp")`. My trial bundle of the reused modules contains that string (line 18815 of the output).
     - The classifier's own tables contain `fetch`, `curl`, `wget`, `Invoke-WebRequest` (`design.md:1066-1067`).
     - Step 0 adds this entry to `scripts/build-app.mjs` (`design.md:3526-3530`), which every job runs:
       `ci.yml:52, 296, 482`.
   - Severity: **blocker** (breaks `npm run build` everywhere once Step 0 or SB lands).
   - Fix (S0/SB):
     - Check the metafile only. Fail on any input under `node_modules/` other than `zod`. Fail on any input under
       `app/main/{agent,desk,voice}`, `app/main/platform/{win32,darwin}`, `app/sidecar-host` (except `launch.ts`, see
       finding 19), `app/renderer` or `app/preload`. Fail on any import of `electron`, `node:net`, `node:http(s)`,
       `node:tls` or `node:dgram` recorded in `metafile.inputs[*].imports`.
     - Never grep the code text.
     - Make the remote's `PerceptionOptions.capture` required in `app/remote` and alias `./capture` to a stub
       (esbuild `alias`) in that one build, so sharp's loader isn't in the bundle at all.
     - Run the check as a unit test (`remote-agent-build`, as `desk-agent-build.ts` does), not inside
       `build-app.mjs`, so a failure names itself instead of breaking unrelated jobs.

3. **Commands and SSH work only where a local window system opened.**
   - Evidence: `main.ts:1338` builds `hands` only when `ws` exists, and `host.ts:766` creates the TaskManager only when
     there are hands (`this.tasks = hands ? new TaskManager(…) : null`). Without it, `start_task` answers "Ember cannot
     operate applications in this session (no desktop access)" (`conductor.ts:116-119`). The design's per-target
     `makeWorker` (`design.md:423-440`) sits inside that branch. So on a session where the window system doesn't open,
     no local commands run, and no SSH or WSL tasks either, though none of them needs this screen. That covers a
     macOS without the permissions `openWindows` needs, a Linux session where X can't be opened, and the doctor's
     headless runs. Also `captureContext` returns before the remote branch when `perception` is null (`main.ts:684`
     versus hook 9, `design.md:3520`). D4.1 makes commands available on every target, and §2.5's local
     `desktop: "none"` row implies tasks still run.
   - Severity: **major**.
   - Fix (S0 + AG):
     - Split the TaskManager's dependencies from the local hands. Add `HostOptions.taskBase = { audit, confirmer }`,
       which main always has: the Confirmer and AuditLog are built unconditionally around `main.ts:1279-1281`.
     - Create the TaskManager when `hands || targets` exists, with `currentWindow: hands?.currentWindow ?? (() => null)`.
     - `handsFor("local")` with no window system returns a commands-only `TargetHands` (`desktop: "none"`, Perception
       and sidecar ports that refuse).
     - Hook 9: check `targets?.quickContext()` before the `!perception` early return.
     - Add a Step 0 test: an AgentHost with `targets` and no `hands` starts a task.

4. **A screen-wide screenshot can include Ember's always-on-top command window unmasked, which defeats L2 and
   redaction.**
   - Evidence: `perception/index.ts:453-454`: when the target window isn't found, `windowScope` is false and `rect` is
     the whole screen. Masks are then only `privateWindows()` (never-look and remote surfaces, `:645-673`) and shell
     overlays. Ember's own windows are blacked out only as covering windows in window scope
     (`perception/windows.ts:106-115`). `hideOverlay` hides the overlay and handle only (`main.ts:1270-1275`). The
     new command window is on top and shows raw output (`design.md:3036-3056`). That includes the spans L2 withholds
     from the model (`design.md:29`) and the output of an approved class-d command before `redactSecrets`. A worker
     with an empty target (an SSH-free local task right after start, or after a window closed) gets the whole screen
     with it.
   - Severity: **major** (a second path to the model around R-cmd-3 and the redaction).
   - Fix (S0, `perception/index.ts`): in `perceive`, add the frames of every stacked window whose `pid === ownPid`,
     except the overlay title (already hidden), to `blacked` in both scopes. Add a test with a stack holding an "Ember
     commands" window over the screen. Better still, the command and prompt windows call
     `setContentProtection(true)` (Windows, macOS) as defence in depth. That doesn't help on X11, hence the mask.

5. **The settings IPC for targets can't check its sender, and the riskiest renderer could turn commands on.**
   - Evidence: main's settings channels accept only the home window (`main.ts:318-321`:
     `event.sender !== home.webContents`). TG registers `TARGETS_IPC` itself through `IpcLike`, whose `sender` has only
     `id` and `send` (`design.md:3380-3385`). `TargetsDeps` gives TG no way to tell which `webContents` is the
     settings window (`design.md:3352-3378`). `targets:act` can do `{kind:"commands", on:true}`, `connect`,
     `uninstall` and `add`. The command window renders remote-controlled bytes through xterm. A bug there that
     reaches `ipcRenderer` (its preload bridges `commands:*`) must not be able to switch commands on or connect.
   - Severity: **major**.
   - Fix (S0): add `isHome(sender: WebContentsLike): boolean` to `TargetsDeps`, implemented in main with the existing
     `guard` predicate (`home.webContents.id === sender.id && isTrustedSender(url)`). Or have main register
     `TARGETS_IPC` with `guard` and forward to `targets.settingsAct(a)`. Require each preload to expose only its own
     channels (`command.ts`: `commands:*`; `home.ts`: `targets:*`), and add a `trusted-sender.test.ts` case per new
     channel.

6. **The remote's step stamps can't work: the remote compares the PC's clock with its own, and `at` is set before
   the user answers.**
   - Evidence:
     - Gate 2 refuses a stamp "older than 10 s" (`design.md:2507`), but `ActStamp.at` is the PC's "ISO time of the
       decision" (`design.md:3415-3416`). Any server with more than 10 s of skew refuses every step, or accepts stale
       ones if its clock is behind.
     - L4 asks about every remote step (`design.md:31`). The Confirmer gives the user up to 120 s (`confirm.ts:63`).
       After `authorize()`, the worker still runs `stillSame`, waits for the window lease (unbounded) and 350 ms
       before `run()` (`worker.ts:1751-1769`).
     - The AG row puts `onAuthorized` "in `authorize`" (`design.md:3545`), while `TargetHands` says "just before the
       step is sent" (`design.md:240`).
     - RemoteSidecar's own 10 s check (`design.md:2763-2765`) then refuses steps whose question took longer.
   - Severity: **major** (remote tier 0 and tier 1 fail intermittently or always).
   - Fix (S0 contract + AG + SB):
     - `ActStamp` gets `ageMs` (milliseconds since the approval, or since the decision when nothing was asked, measured
       on the PC when sent) instead of relying on `at`.
     - Gate 2 checks `ageMs < 10_000` plus its own link freshness (1.5 s), never the absolute time.
     - AG calls `onAuthorized` immediately before `run()` (after the lease and the 350 ms), carrying the decision and
       approval that `authorize()` returned.
     - RemoteSidecar's 10 s window runs from that call.

7. **`open_app` on a remote can't see gate 2's answer: `AppCatalog.launch` is synchronous.**
   - Evidence: `WorkerSystem.apps` is `Pick<AppCatalog, … "launch" …>` (`worker.ts:51`). `launch(app: DesktopApp):
     void` (`platform/types.ts:318`), and the worker calls `apps.launch(app);` without `await`, then polls windows
     for 10 s (`worker.ts:1064-1071`). RemoteApps.launch sends `apps.launch` and gets back `deny`, `needs_confirm`,
     `stale` or `changed` (`design.md:2681, 2768-2770`). A refused launch is lost (or becomes an unhandled
     rejection), and the model reads "Started X, but its window hasn't appeared yet". `RemoteApp` (`design.md:2651`)
     also lacks the Exec argv and `Terminal=` facts that Linux's `isTerminalApp` follows, so gate 1 judges remote
     apps by name only.
   - Severity: **major**.
   - Fix (S0 type + AG):
     - Widen only the worker's view: `launch(app): void | Promise<void>` in `WorkerSystem.apps`.
     - The worker `await`s it inside `system()`, so a thrown gate-2 error becomes the tool's `fail`/`denied` text.
     - `RemoteApp` gains `argv?: string[]` and `terminal?: boolean` from the remote's `.desktop` file, so gate 1 uses
       the same Linux vocabulary as gate 2.

8. **Windows spawn options for the command runners aren't specified, and the one the design gives breaks PowerShell
   and pops up consoles.**
   - Evidence: the ladder says "the shell is spawned `detached: true`" (`design.md:1660`), and no Windows spawn options
     are given for the local or WSL runners (`design.md:883-891`). In libuv, `detached` on Windows means
     `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, so there is no console at all:
     - `PS_INNER`'s `[Console]::OutputEncoding=…` (`design.md:895-898`) then throws "The handle is invalid" in
       PowerShell 5.1.
     - Every console program that cmd or PowerShell starts (git, ping, wsl.exe) opens its own visible console window.
     - `windowsHide` is specified only for probes (`design.md:1809`).
   - Severity: **major**.
   - Fix (RUN, normative table row): on win32 spawn every runner child (powershell, cmd, wsl.exe, the job host of
     finding 9) with `{ detached: false, windowsHide: true, stdio: [stdinMode, "pipe", "pipe"] }`. libuv then sets
     `CREATE_NO_WINDOW`, so there is one hidden console that children inherit. On POSIX use `detached: true`. Pin
     both in `commands-run-argv` with a fake spawn.

9. **Stop and the kill switch on Windows: the "polite" step does nothing, and the job object is assigned too late.**
   - Evidence: step 1 is `taskkill /PID <pid> /T` without `/F` (`design.md:1660`). That fails for windowless console
     processes ("can only be terminated forcefully"), and there is no Ctrl+C path with stdin closed (L3). So a local
     Windows run keeps going until `TerminateJobObject` at t = 1000 ms (`design.md:1663`), well after the kill
     switch's 300 ms race (`killswitch.ts:37`). The job is assigned "right after spawn", and a child created before
     that escapes (`design.md:1670-1671`). An Ember crash leaves PowerShell trees running.
   - Severity: **major** (Stop and the kill switch are core safety mechanisms).
   - Fix (RUN):
     - Run every Windows command through a tiny job host: Ember's own binary as Node (`ELECTRON_RUN_AS_NODE=1`, fuse
       on), `dist/app/job-host.cjs`, koffi loaded lazily.
     - The host creates a `KILL_ON_JOB_CLOSE` job and assigns itself (`GetCurrentProcess`) before it spawns the
       shell, so every descendant is in the job from birth.
     - It relays stdio and exits with the child's code. It exits when its stdin closes (Ember gone).
     - Stop and the kill switch then `TerminateProcess` the host at t = 0. Closing the job's last handle kills the
       whole tree atomically. No polite phase exists on Windows: say so in the status line.
     - Put `wsl.exe` runs under the same host. This also covers interop children, which critique-wsl #16 asks for.

10. **PowerShell launcher: wrong exit status, Constrained Language Mode, and a BOM.**
    - Evidence:
      - `PS_INNER` (`design.md:895-898`) ends `if ($LASTEXITCODE) {…} elseif (-not $?) { exit 1 }`. Evaluating the
        `if` condition resets `$?` to true, so a cmdlet's non-terminating error (`Remove-Item missing`) exits 0 and
        the model is told the command succeeded (verify on windows-2022; the fix is harmless either way).
      - Under Constrained Language Mode, which `cleanEnv` deliberately keeps for helpers (`platform/compose.ts:54`)
        and which I-win's `win32/system/powershell.ts` already detects, `[Console]::…` and `[Text.Encoding]::…` are
        refused, so every command's output starts with two errors.
      - `[Text.Encoding]::UTF8` in `$OutputEncoding` writes a BOM into stdin piped to native programs.
    - Severity: **major** (the model gets wrong results; managed fleets).
    - Fix (RUN): `$s=…; & $s; $ok=$?; $c=$LASTEXITCODE; if ($c) { exit $c } elseif (-not $ok) { exit 1 }`. Guard the
      encoding lines with `if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { … }`, and use
      `New-Object Text.UTF8Encoding $false`. Pin all three in `commands-local.test.ts` on win32.

11. **Target paths are resolved with the PC's `path` module, so WSL and SSH targets break on a Windows PC (and
    Windows targets on a POSIX PC in SX).**
    - Evidence: §3.6, §3.14 and §3.2 resolve cwd, `~`, relative and `..` paths lexically (`design.md:846, 1231-1236,
      1686-1691`) but never say which path flavour. On a Windows PC, Node's `path` is `path.win32`:
      - `path.resolve("/home/ana", "build")` gives `C:\home\ana\build`.
      - `path.normalize("/etc/../root")` mixes separators.
      - The secret and Ember path rules would then compare Windows-shaped strings with POSIX tables, and `rm -r /`
        resolves to a drive root.
      The codebase already guards this elsewhere (`platform/darwin/system/index.ts:31`: "macOS paths are POSIX paths:
      joined as such wherever this module runs (its unit tests run on Windows too)").
    - Severity: **major** (a wrong `cwd` on every WSL and SSH command from Windows, and wrong safety-path matches).
    - Fix (S0 contract, CL, RUN, WA, SC):
      - `resolveTargetPath(p, { os: RunnerFacts["os"], home, cwd })` picks `path.posix` or `path.win32` from the
        *target's* OS.
      - Ban bare `path.*` in `app/main/commands/**`, `app/main/wsl/{runner,service}.ts` and `app/main/remote/**`
        through a lint rule (`no-restricted-imports` of `node:path` there, allowing `node:path/posix` and
        `node:path/win32`).
      - Add CL tests that run the POSIX corpus with `os: "linux"` while asserting the same results when
        `process.platform` is win32. The Windows CI job runs them.

12. **The new unit tests run inside I-win's and I-mac's CI jobs, but the packages can only test on Linux.**
    - Evidence: the `windows` and `macos` jobs run the whole unit suite (`ci.yml:296, 482`). §10.1 says "every OS's CI
      runs them; Linux at least" (`design.md:3251`). Tests that read `/proc`, spawn `script` or `sh`, use bare
      `path`, or read `process.env.SystemRoot` will fail on windows-2022 or macos-15. Those failures land in jobs the
      SSH/WSL packages don't own, and they can't reproduce them locally (this container is Linux; it has `script`,
      but no `ssh` or `sshd`).
    - Severity: **major** (breaks other packages' CI; it only shows after merge).
    - Fix:
      - Add a rule to sshwsl/pkg-common.md: every `test/unit` file is OS-neutral. It uses fakes for spawn, fs, `/proc`
        and koffi, path flavours explicit (finding 11), and env given, not read.
      - Real processes go in `test/integration` behind `EMBER_COMMANDS_TEST`, `EMBER_WSL_TEST` and `EMBER_SSH_TEST`.
      - Step 0 creates `.github/workflows/remote.yml` with a `unit-matrix` job (ubuntu, windows-2022, macos-15 on
        dispatch) that runs `vitest run test/unit/{commands,wsl,ssh,remote,targets,command,prompt}-*`. Packages prove
        cross-OS before merge with their own `workflow_dispatch` runs (finding 17).

13. **Packaged Windows builds don't ship the AT-SPI sidecar, so WSLg reading can't work after install, and no package
    owns that change.**
    - Evidence: WB launches `resources/sidecar/atspi/ember_atspi.py` inside each distro (`design.md:1868`). The win32
      layout ships only `sidecar/uia/*` (`scripts/package/layout.mjs:73-76`); `ember_atspi.py` is Linux-only (`:51`).
      WB's shared files don't include `layout.mjs` (`design.md:3548`). SB's row touches `layout.mjs` only for
      remote parts (`design.md:3550`). `layout.test.ts` and `packaging.test.ts` pin the layouts.
    - Severity: **major** (the headline WSLg feature is dead in releases; only dev builds work).
    - Fix (WB, with `layout.mjs` and `layout.test.ts` added to its shared list): add
      `{ from: "sidecar/atspi/ember_atspi.py", to: "sidecar/atspi/ember_atspi.py" }` to the win32 `sidecarFiles`.
      Add a doctor row that fails when it's missing. Coordinate with I-win (`layout.mjs` is in their packaging path)
      through the lead.

14. **The remote-parts pipeline has no owner for its hook into packaging, needs tools Node lacks, and would change
    I-win's and I-mac's package jobs.**
    - Evidence:
      - `package:*` scripts run `build → stage → archive/rpm` (`package.json:27-30`), and nothing runs
        `scripts/package/remote-parts.mjs`. SB's shared list has `stage.mjs` and `layout.mjs` but not `package.json`
        (`design.md:3550`).
      - "The PC re-packs the parts as gzip" when a remote lacks xz (`design.md:2384-2385`). Node has no xz, and new
        npm dependencies are forbidden.
      - Building `.tar.xz` needs an external `tar -J`/`xz` on each staging OS. Each target is staged on its own OS
        (`layout.mjs:3-6`), so Windows' `tar.exe` (bsdtar) would build parts. Its xz support isn't established, and
        archives differ per OS (mtime, owner, order).
      - If `stage.mjs` requires `dist/remote-parts/`, I-win's and I-mac's `package` steps (`ci.yml` windows and macos
        jobs) fail. If it doesn't, releases ship without parts.
    - Severity: **major**.
    - Fix (SB):
      - Write the parts as `.tar.gz` with a ~100-line deterministic JS tar writer (sorted entries, mtime 0, uid and gid
        0, mode from a table) plus `zlib.gzipSync`. The repo already reads tar in JS (`voice-untar.test.ts`). Then no
        external tool and no repacking is needed, and the bytes are identical on all three staging OSes.
      - Keep the Node runtime as the pinned `.tar.gz` (or `.tar.xz` when the probe shows `xz`), forwarded as is.
      - Add `node scripts/package/remote-parts.mjs` to every `package*` script (SB gains `package.json`).
      - `stage.mjs` fails closed without `dist/remote-parts/remote-parts.json` unless `--allow-missing-remote-parts`,
        mirroring `--allow-missing-sidecar`.
      - Land the `ci.yml` side only through the lead, after telling I-win and I-mac.
      - Extend `check-symvers.sh` (or a remote-parts test) to aarch64 for `koffi-linux-arm64`: only x86-64 is checked
        today (`check-symvers.sh:31`), yet remotes promise glibc 2.28.

15. **The conductor and worker prompts change for everyone, and the conductor's prompt can't follow the command
    switches.**
    - Evidence:
      - Today's identity says "You never run shell commands or edit files directly" (`persona.ts:21`). The terminal
        rule says Ember "doesn't act in terminals" (`persona.ts:32`).
      - §3.15 replaces both unconditionally (`design.md:1695-1710`) and adds `list_computers`/`offer_connect` to the
        rules, even when commands are off on every target (the default until the card), no targets runtime exists
        (eval, tests) or the admin turned SSH off.
      - The conductor's system message is fixed when its session is created and kept on resume (`conductor.ts:374,
        402`). When the user turns commands on mid-conversation, nothing tells the conductor: `activeLine()` is absent
        for local with nothing connected (`design.md:414-416`).
      - Result: with commands off the model promises "I'll run it in my command window" and then fails. With commands
        just turned on, it still says Ember never runs commands. The nightly eval's release gates move for every user.
    - Severity: **major** (non-regression of default behaviour on all three OSes).
    - Fix (AG):
      - `identity(words, caps)` and `toolRules(words, caps)` give today's exact text when
        `caps = { commands: false, targets: false }`. The tools `list_computers` and `offer_connect` exist only with a
        targets runtime that has more than "local" or SSH allowed.
      - Put every dynamic fact in the per-request trusted line. `activeLine()` always says what commands can do now,
        e.g. "(Commands: on for this computer; off in Ubuntu (WSL).)", whenever any target has commands on or needs
        consent.
      - Pin "unchanged when off" in `persona-commands.test.ts` against today's strings.

16. **Work-package ordering serialises work needlessly.**
    - Evidence:
      - Step 0 is one monolith: every contract, the full zod protocol, Confirmer guards, the Perception text-function
        refactor, admin and settings schemas, main hooks, two windows, build entries and stubs. "Nothing else starts
        before it merges" (`design.md:3316-3317`).
      - `mux.ts` (framing for both ends) belongs to SA (`design.md:3549`), but SB's `serve` and its integration tests
        need it (`design.md:3550`), and SB merges after SA (`design.md:3320`).
      - `remote.yml` belongs to SB (`design.md:3550`), yet RUN, WA and SA are "done when" their §10.2 jobs pass
        (`design.md:3543, 3547, 3549`). Those jobs don't exist until SB merges, after RUN, WA and SA.
    - Severity: **major** (schedule: the owner asked for maximum parallelism).
    - Fix:
      - Split Step 0 into S0a, the type-only contracts (`shared/targets.ts`, `commands/types.ts`, `wsl/types.ts`,
        `remote/{types,protocol}.ts` types, ports, stubs, build entries). This is a few hours, and CL, RUN, WA, SA and
        SC start on it.
      - S0b holds the behavioural shared edits (Confirmer panels, perception text functions, admin, settings, main
        hooks). It runs in parallel and is needed only by UI, AG and TG.
      - Move `mux.ts` (normative in §5.1.10) and the protocol's zod schemas into S0a, so SA and SB both build on them.
      - S0a creates `remote.yml` with every job, each skipping when its test file doesn't exist yet, and with
        `workflow_dispatch` inputs `ref` and `only`. Each package adds only its own test files and proves its job on
        its own branch.

17. **Shared files have overlapping owners, and some have none.**
    - Evidence:
      - `app/main/policy/policy.ts` is edited by S0 (`EMBER_WINDOW`), AG (`carriedText`) and WB (the `wsl:` tier-3
        rule) in parallel (`design.md:3482, 3545, 3548`).
      - `scripts/package/{stage,layout}.mjs` are SB's but also I-win's and I-mac's packaging path (git log: c54b59d,
        c64f7f9…).
      - `app/renderer/home/**` is UI's, but I-win and I-mac edit platform copy there (followups.md: "home/styles.css
        hard-codes 'Press Ctrl+Alt+Space'").
      - No owner: `package.json` scripts (finding 14), the win32 layout entry (finding 13), DEVELOPING.md and the
        release notes that R5 and §9.3 require (`design.md:3245`), README and PLAN.md, and the `ci.yml` changes
        findings 12 and 14 imply.
    - Severity: **major** (merge conflicts, and work that never gets done).
    - Fix:
      - S0 adds two one-line seams to `policy.ts`: `const extra = targetRules(r, os)` (stub
        `policy/target-rules.ts` returning null), owned by WB; and `export { runsIn }`. AG puts `carriedText` in
        `app/main/commands/carried.ts`. No package then edits `policy.ts` after S0.
      - Name owners: SB gets `package.json` scripts; WB gets `layout.mjs`'s win32 entry; a DOC package (or TG) gets
        DEVELOPING.md, README and release notes.
      - The lead applies any `ci.yml` edits after telling I-win and I-mac.
      - Each package's report lists shared hunks so the lead can merge them against I-* work.

18. **The macOS command environment lacks every Homebrew and nvm tool; the local environment also diverges from
    Ember's own helpers.**
    - Evidence:
      - Apps started from Finder get launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`); the code says so itself
        (`platform/darwin/system/index.ts:33-37` `extraBinDirs`).
      - L9 runs commands without profile files (`design.md:36`), and §3.3.1 starts from `process.env`
        (`design.md:905-918`). So on a Mac, `npm test`, `node`, `brew`, `python3` (Homebrew) and `gh` are "not found":
        D4.2's own examples fail on most developer Macs.
      - The same holds on a macOS SSH remote (sshd starts `sh -s` without `/etc/zprofile`'s `path_helper`).
      - Separately, `commandEnv` keeps what `appEnv` deliberately drops or repairs: Electron's rewritten
        `XDG_CURRENT_DESKTOP` (`appEnv` restores `ORIGINAL_XDG_CURRENT_DESKTOP`), `CHROME_DESKTOP` and `NO_AT_BRIDGE`
        (`hands/system.ts:489, 516`). GUI apps a command starts would then be inaccessible to Ember.
    - Severity: **major** for macOS usability; the environment details are minor.
    - Fix (RUN, SB):
      - `RunnerFacts.extraPath` is computed where it is known (local darwin: main passes
        `extraBinDirs(home).filter(exists)` via `TargetsDeps`; remote darwin: the agent computes the same list and adds
        `/etc/paths` and `/etc/paths.d/*`, read as data, not run). Append it to PATH in `commandEnv`.
      - Apply `appEnv`'s repairs in `commandEnv`: restore `XDG_CURRENT_DESKTOP`, drop `CHROME_DESKTOP`, `NO_AT_BRIDGE`,
        `ELECTRON_*` and `EMBER_*`, and drop AppImage's `APPDIR`, `APPIMAGE`, `ARGV0` and `OWD`, while keeping the
        user's own tokens as designed.
      - Add the facts to §3.15's worker rule ("Tools from Homebrew are found in /opt/homebrew/bin…" is unnecessary
        once PATH is right).

19. **The remote bundle reaches into files I-win and I-mac own, and koffi must stay lazy for macOS remotes.**
    - Evidence:
      - `platform/linux/window-system.ts:9` imports `platform/compose.ts`, which imports `app/sidecar-host/launch.ts`
        (`compose.ts:9`). My trial bundle includes it.
      - SB imports `platform/darwin/system/admin-policy.ts` (`design.md:2428`). Both are I-* territory and change in
        parallel.
      - macOS remote parts ship no koffi (`design.md:2342`). Yet RUN's `run/win32-job.ts` and `elevation.ts` sit in
        the shared `commands/run/` that the agent bundles (`design.md:2426`). A top-level `import koffi` would crash
        the agent on macOS remotes at load. The repo convention is lazy `requireCjs("koffi")` (`x11.ts:7`,
        `win32/ffi.ts:298`, `darwin/native.ts:31`).
    - Severity: **minor** (latent breakage).
    - Fix:
      - Step 0 moves `TEST_SWITCHES` into a tiny `app/shared/test-switches.ts` re-exported by `sidecar-host/launch.ts`
        (one line in I-* territory, agreed with them), or `compose.ts` imports it from there.
      - Put the macOS policy path in `admin.ts` as data (`ADMIN_POLICY_PATHS`) for SB to use.
      - pkg-common.md states that every koffi use in `commands/**`, `wsl/**` and `remote/**` loads lazily inside the
        function that needs it.
      - The metafile allow-list of finding 2 enforces the rest.

20. **WB can't route element ids by "block" without a sidecar change that Step 0 doesn't make.**
    - Evidence: blocks come from a module-private counter (`perception/sidecar.ts:220-221, 262`), and `AtspiSidecar`
      doesn't expose which bases it has used (they change on every revive). The router routes "by the id's block
      (each distro sidecar process owns the blocks it was started with)" (`design.md:1873, 1925-1927`). Step 0 adds
      only `mayStart` to `sidecar.ts` (`design.md:3485-3486`), and WB's shared files don't include it.
    - Severity: **minor**.
    - Fix (S0): `AtspiSidecar.ownsId(id: number): boolean`, true for any block this instance has used. Alternatively WB
      records the ids each distro's reads return (every read passes through the router) and maps unknown ids to "call
      perceive_window again".

21. **The window seam is too thin for what the new windows need on Windows and macOS.**
    - Evidence:
      - `BrowserWindowLike` (`design.md:3386-3391`) has no `setAlwaysOnTop`, `moveTop`, `isFocused` or `setBounds`,
        yet "`alwaysOnTop` set by its controller" (`design.md:3497-3500`), and `cardReady` must know "on top".
      - The factories in `windows.ts` ignore the platform's floating-window options (`platform/compose.ts`
        `HOVER_FLOATING`). On macOS a normal window activates Ember, and its first click only activates, so "Allow"
        needs two clicks unless `acceptFirstMouse` is set. On Windows it takes focus from the user's app on every card.
    - Severity: **minor**.
    - Fix (S0): add those members to `BrowserWindowLike`. Give the command and prompt windows a `FloatingKind` entry
      (darwin: panel + `acceptFirstMouse`; win32: toolbar for the command window; the prompt window stays activating
      because it takes typing) and build them through `platform.overlay.floating(kind)`.

22. **UI copy hard-codes Linux's stop chord.**
    - Evidence: "Ctrl+Alt+X stops everything" (`design.md:3033`), "press Ctrl+Alt+X" (`design.md:3011`), "Stopped by
      Ctrl+Alt+X" (`design.md:3049`). Windows uses Win+Alt+X and macOS Control+Shift+Command+X
      (`shared/shortcuts.ts:38-42`). Consent texts are hashed (`ConsentPanel.sha256`), so they must be built per OS
      before hashing.
    - Severity: **minor**.
    - Fix (UI): take `SHORTCUTS[os].stop.label` everywhere, and add these strings to the per-OS copy tests
      (`home-platform-copy.test.ts` pattern).

23. **Elevation (D4.6) is re-detected by parsing localised text when the platform already knows it.**
    - Evidence: RUN's `elevation.ts` parses a `whoami /groups` fixture (`design.md:3257`). Group names are localised,
      and only the SID column is stable. I-win's code already reads `TokenElevation` (`win32/system/environment.ts:
      65-71`; doctor row `win32/system/doctor.ts:81-88`).
    - Severity: **minor**.
    - Fix: TG passes `privileged: () => sys.environment(...).elevated` (or a new `TargetsDeps.elevated()` main fills
      from the platform) into `createLocalRunner`. If a parser stays, match `S-1-16-12288` and `S-1-16-16384`, never
      the label text.

24. **Smaller seams in the agent integration.**
    - `refusedWorker` must be a `Worker` (`TaskManagerDeps.makeWorker: … => Worker`, `tasks.ts:37`), a class with
      private members. Either widen it to
      `Pick<Worker, "run" | "steer" | "dispose" | "sessionId">`, or refuse in `startTask` before queueing (call
      `handsFor` there too).
    - The task's window target crosses targets. `startTask` passes the turn's quick-context target (`host.ts:887`),
      which is the remote's when an SSH target is active (§2.8). A request that names "this computer" then gives a
      local task a remote pid, and the reverse. The design clears it only for SSH tasks (`design.md:419-420`). Fix:
      keep `r.target` only when the bound target equals the one the context was read from (store `context.targetId`).
    - The `needs_confirm` "ask and resend once" (`design.md:2516-2519`) has no owner. RemoteSidecar has no Confirmer,
      and AG's worker changes don't list it. With L4 every remote step already carries an approval. Fix: treat
      `needs_confirm` from gate 2 as `denied("build-01 asks for confirmation on its own screen…")` in v1, and drop
      the retry.
    - `ui:cmdstop:<runId>` from the bubble is ignored while Ember drives the mouse for another task (`main.ts:990-991`
      lets only `task:…:stop` through). An announcement's Stop must always work: add `ui:cmdstop:` to that exception.
      The announcement bubble is also swallowed by `guardWhileAsking` while another question is up (`confirm.ts:182-
      189`). Say the command window's countdown is the authoritative Stop.
    - D4.5's `ember.pids` must stay live (renderers, the sidecar and voice restart). `createLocalRunner` takes a
      static `ember` (`design.md:3543`). Pass `emberPids: () => number[]` from main
      (`app.getAppMetrics().map(m => m.pid)` plus the sidecar's and the desk's pids).
    - Severity: **minor** (each).

25. **Behaviour changes when WSL and SSH are unused.**
    - Evidence:
      - AG drops bare "wsl" from `TERMINAL_WIN32` regardless of whether WSL is on (`design.md:3545`; risk 13 at
        `design.md:3575`), so "open wsl" stops being a terminal request for every Windows user.
      - After TG, the handle menu always gains "Work on ▸ This computer" and "Bring Ember to a computer…"
        (`design.md:2928-2935`), even with one target or SSH turned off by the admin.
      - The ssh-noticing poll (default on) spawns a CIM query (PowerShell) on Windows at most every 10 s whenever a
        focused terminal's title changes (`design.md:476-488`), and terminal titles change on every prompt.
    - Severity: **minor**.
    - Fix:
      - Choose the vocabulary row by state (`TERMINAL_REQUEST` as today unless WSL is on).
      - Show "Work on" only with two or more targets, and "Bring Ember…" only when SSH is allowed.
      - On Windows, run the CIM query only when the new title looks like an SSH session (`@` or `ssh `). Do it only
        while SSH is allowed and either a host record exists or the user hasn't dismissed the first offer.

26. **Classifier path forms on Windows that a lexical resolver misses.**
    - Evidence: §3.6 normalises separators, drive letters and case (`design.md:1233-1236`). It doesn't handle 8.3
      short names (`C:\Users\ANA~1\.aws\credentials`), `\\?\C:\…`, `\\localhost\c$\…`, `subst` drives or junctions.
      The secret and Ember path rules are prefix matches, so `type C:\Users\ANA~1\.aws\credentials` reads secrets
      without a question (no basename rule covers `credentials`).
    - Severity: **minor** (the security critique owns the tables; this is the cross-OS resolver).
    - Fix (CL/RUN): for the local Windows target, canonicalise existing path operands with `fs.realpathSync.native`.
      The runner already probes existence (`exists`), so add a `canonical(paths)` op. Treat any remaining `~\d`
      segment, `\\?\`, `\\.\` or admin-share form as class g.

27. **The cmd launcher never expands `%VAR%` in the command.**
    - Evidence: `cmd /d /s /v:off /c "%EMBER_CMD%"` (`design.md:891, 901-902`). cmd expands percent signs once, while
      reading the line, so `%USERPROFILE%` inside the expanded text stays literal. The classifier resolves `%TEMP%`
      and others "from facts" (`design.md:1015-1016`), so what it judges and what runs differ.
    - Severity: **minor** (functional; the mismatch fails safe).
    - Fix (RUN/CL): offer only `powershell` as a Windows shell in v1. `cmd /c "…"` typed inside PowerShell already
      expands normally and is classified recursively (`design.md:1042`). Otherwise keep cmd, document that `%VAR%`
      stays literal, and make the classifier treat `%NAME%` as literal text to match.

28. **No check enforces the Electron-import rule that the design relies on.**
    - Evidence: L13 (`design.md:40`) and the owner's rule. No test or lint rule checks it (`eslint.config.mjs` has none;
      no `test/unit` file scans for `from "electron"`). Many new plain-Node modules (targets, commands, remote, wsl)
      are written in parallel.
    - Severity: **minor**.
    - Fix (S0): add an ESLint `no-restricted-imports` for `electron` with an `overrides` allow-list (main.ts,
      windows.ts, overlay.ts, handle.ts, ask.ts, voice.ts, revive.ts, desk/view.ts, app/preload/**). Add the
      remote-bundle metafile allow-list test of finding 2.

29. **Test feasibility details.**
    - UI's `renderer-command.test.ts` "xterm options" (`design.md:3258`) can't instantiate xterm: vitest runs with
      `environment: "node"` (`vitest.config.ts:17`), and jsdom is not allowed (R1). Export the options object from a
      pure module and test that.
    - SA and SB integration needs `sshd` (absent here). Only the remote.yml jobs can run it (finding 16).
    - `build-app.mjs` cleans only `dist/app` (`scripts/build-app.mjs:14-15`), so `dist/remote/` keeps stale files.
      Remove it at start too.
    - Severity: **minor**.

30. **Win32-OpenSSH version for a binary stdio channel.**
    - Evidence: the minimum is OpenSSH 7.6 (`design.md:2056`). Windows 10 1809's inbox client is 7.7p1. The design
      uploads about 30 MB and runs a binary mux over ssh.exe's stdio, and older Win32-OpenSSH builds had stdio
      handling bugs (verify). CI tests only windows-2022 (`design.md:3278`).
    - Severity: **minor** (the SHA-256 checks fail closed).
    - Fix (SA): on Windows PCs require ssh.exe ≥ 8.1, with a doctor row telling the user how to update OpenSSH Client.
      Have `ssh-windows.test.ts` push 4 MiB of random bytes both ways through the mux.

31. **`script(1)`: one cross-version rule and one kill gap to state.**
    - Evidence:
      - util-linux 2.32 (RHEL 8) ends the session when its stdin reaches EOF. 2.35+ waits for the child.
      - The design keeps stdin open only for interactive runs (§3.10).
      - On PTY runs the shell lives in a session that `script` created, so SIGTERM and SIGKILL "to the group"
        (`design.md:1661-1663`) reach only `script`. The environment sweep must catch the rest, and on macOS that
        sweep is itself "verify" (`design.md:1668-1669`).
    - Severity: **minor**.
    - Fix (RUN):
      - Never end `script`'s stdin before the run ends, interactive or not.
      - On macOS and Linux also signal the child's session (`pkill -s <sid>` with sid = the pid of `script`'s child,
        from `pgrep -P`), as step 2's fallback when `ps -E` doesn't show environments.
      - Add both to `commands-local.test.ts` on ubuntu, el8 and macos.
