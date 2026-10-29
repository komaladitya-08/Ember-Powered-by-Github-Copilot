# Ember port spec: build, packaging, tests and CI portability (Linux to Windows 10/11 and macOS 13+)

Scope: `package.json`, `scripts/build-app.mjs`, `scripts/build-demo.mjs`, `scripts/package/*`, `scripts/check-symvers.sh`,
`scripts/rebuild-el8.sh`, `packaging/*`, `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`,
`.github/workflows/{ci,nightly-eval}.yml`, `test/smoke/launch.mjs`, `test/mock-llm/server.mjs`, `eval/run.mjs`,
`eval/src/*.ts`, every `test/unit/*.ts` and `test/integration/*.ts`.

Everything below was read from the repository at `b67b02e` (node_modules installed: Electron 44.5.0, koffi 3.2.1,
sharp 0.35.5, @github/copilot-sdk 1.0.21, sherpa-onnx 1.13.8 WASM). Platform package layouts for win32/darwin were
read from the npm registry (`npm pack --dry-run`) because only the Linux ones are installed here. "L" = line.
Statements marked **verify** are from knowledge of Electron/macOS/GitHub runners and should be confirmed on the
first real CI run.

---

## 0. Essentials (read this first)

1. **Nothing in the Copilot path works on win32/darwin until `app/main/agent/runtime.ts:9` changes.** It hard-codes
   `node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime`. On Windows npm installs
   `@github/copilot-sdk-win32-x64` with `prebuilds/win32-x64/copilot-runtime.exe`; on macOS
   `@github/copilot-sdk-darwin-arm64` with `prebuilds/darwin-arm64/copilot-runtime`. This breaks one unit test,
   three platform-neutral integration suites (conductor, persona, worker-safety), the smoke test's agent and the
   packaged app.
2. **`scripts/package/stage.mjs` is Linux-shaped in eight places** (2.2). The two that fail outright:
   `execFileSync("npm", ...)` (L36) throws `EINVAL` on Windows (Node refuses to spawn `npm.cmd` without a shell since
   the CVE-2024-27980 fix), and `path.dirname(require("electron"))` (L56) is
   `dist/Electron.app/Contents/MacOS` on macOS, so it would copy only the MacOS folder of the bundle.
3. **Fuses live in a different file on macOS**: `Ember.app/Contents/Frameworks/Electron Framework.framework/Electron Framework`,
   not the main executable. After flipping, the bundle must be re-signed (ad hoc) or arm64 macOS kills it.
   `fuses.mjs` also refuses universal binaries ("more than one fuse wire", `fuses.mjs:45`).
4. **`EMBER_FUSES.RunAsNode` must stay on** (`fuses.mjs:35-39`): the macOS AX sidecar runs as Ember's own binary with
   `ELECTRON_RUN_AS_NODE=1`, exactly like the Linux desk helper (`app/main/desk/agent.ts:93`).
5. **`AtspiSidecar` spawns `spawn(python, [script])`** (`app/main/perception/sidecar.ts:217-220`). PowerShell needs
   flags before the script, and the macOS sidecar needs `ELECTRON_RUN_AS_NODE=1` in its env (otherwise
   `process.execPath` under Electron starts a second Ember). The launcher must become `{command, args, env}`.
6. **Unit tests today: about 21 tests fail on win32 and 5 on darwin** (table in 3.2). Causes: POSIX file modes,
   `/proc`, `:` as the PATH and XDG list separator, `/bin/sh`, `process.getuid`, SIGSTOP, `HOME`/`TMPDIR` overrides
   that Windows ignores, `path.join` producing `\`, `pathToFileURL` of POSIX absolute paths, `realpathSync("/tmp")`.
   No test depends on `fs.watch` (the app polls: `SettingsStore.watch`, `app/main/settings.ts:284-288`).
7. **`npm run test:integration` cannot run on Windows**: `"EMBER_INTEGRATION=1 vitest run"` (`package.json:24`) is
   POSIX-shell syntax and npm uses `cmd.exe` on Windows.
8. **The UIA sidecar's `.ps1`/`.cs` files must be ASCII (or UTF-8 with a BOM).** Windows PowerShell 5.1 and the C# 5
   CodeDom compiler read BOM-less files in the ANSI code page. The secret-label lists are multilingual
   (`test/fixtures/secret-labels.json`: "Contraseña", "Пароль", "密码"...). Pass the lists from Ember at run time,
   or use `\uXXXX` escapes. Add a unit test that checks the files are ASCII.
9. **Ad hoc signing gives every build a new code identity on macOS.** TCC grants (Accessibility, Screen Recording) are
   keyed to the code requirement, which for ad hoc signatures is the cdhash, so users must grant Ember again after
   every update. Use a stable self-signed certificate, or a Developer ID, if that matters.
10. **Eval stays Linux-only.** Every task is GNOME/GTK/gsettings/Xvfb-shaped (3.6). On win/mac every task is skipped,
    the blocking safety gates are "not measured", and `computeExit` fails the run.

---

## 1. How the app is built

### 1.1 `scripts/build-app.mjs` today (84 lines)

`common = { bundle: true, sourcemap: true, logLevel: "info", absWorkingDir: <repo> }` (L9). `dist/app/` is wiped
first (L13-14). All builds run in parallel (L16-72):

| L | entry | output | platform/format/target | externals |
|---|---|---|---|---|
| 17-25 | `app/main/main.ts` | `dist/app/main.cjs` | node / cjs / node24 | electron, koffi, @github/copilot-sdk, sharp |
| 27-35 | `app/main/desk/agent-process.ts` | `dist/app/desk-agent.cjs` | node / cjs / node24 | electron, koffi, sharp |
| 37-45 | `app/voice/process.ts` | `dist/app/voice.cjs` | node / cjs / node24 | electron, sherpa-onnx (loads its .wasm from beside itself) |
| 46-53 | `app/renderer/mic/worklet.ts` | `dist/app/renderer/mic/worklet.js` | browser / iife / chrome140 | none |
| 54-63 | `app/preload/<p>.ts` (p in `pages`) | `dist/app/preload/<p>.cjs` | node / cjs / node24 | electron |
| 64-71 | `app/renderer/<p>/main.ts` | `dist/app/renderer/<p>/main.js` | browser / iife / chrome140 | none |

`pages = ["home","overlay","handle","ask","mic","desk"]` (L11). Then it copies `index.html` and the optional
`styles.css` per page (L74-80), `app/renderer/shared/` to `dist/app/renderer/shared/` (L83) and `assets/fonts/` to
`dist/app/renderer/fonts/` (L84).

**Pinned by tests:** `test/unit/design-system.test.ts:84` asserts the exact text
`cp(new URL("assets/fonts/", root), new URL("renderer/fonts/", out)` in build-app.mjs. `:86` asserts that stage.mjs
contains `path.join(root, "assets/fonts/LICENSE.txt")`, and `:85` that the RPM spec's License: tag has `OFL-1.1`.
`test/unit/packaging.test.ts:121` asserts that `app/main/main.ts` contains `"/usr/share/ember/voice-models"`, and
`:157` parses the `<<'RUN'` heredoc of `scripts/package/appimage.sh`. Refactors must keep these strings or update
the tests.

The desk helper is built in two more places with the same entry: `eval/run.mjs:16-19` (to `dist/eval/desk-agent.cjs`,
target node22) and `test/unit/desk-agent-build.ts:11-21` (to `.cache/test/desk-agent.cjs`, beside the repository's
node_modules so `koffi`/`sharp` resolve). At run time `DeskManager` finds it at `path.join(__dirname, "desk-agent.cjs")`
(`app/main/desk/desk.ts:418`).

`scripts/build-demo.mjs` (`npm run build:lab`) bundles `demo/<name>/main.ts` into one HTML file. It is platform-neutral
and needs no change.

Everything here is portable as written: URL-based paths, `fileURLToPath`, esbuild with forward-slash entry points.

### 1.2 Changes to the build

**(a) macOS AX sidecar: a new entry.** Add it to the `Promise.all` in build-app.mjs:

```js
// macOS: the accessibility sidecar (AX API through koffi). Ember runs it with its own binary as plain Node
// (ELECTRON_RUN_AS_NODE), like the desk helper; it speaks the same newline-delimited JSON-RPC as ember_atspi.py.
build({
  ...common,
  entryPoints: ["app/main/platform/darwin/ax-sidecar.ts"],   // final path per the platform-layer spec
  outfile: "dist/app/ax-sidecar.cjs",
  platform: "node", format: "cjs", target: "node24",
  external: ["electron", "koffi"],          // + "sharp" only if it ever captures pixels itself
}),
```

- Build it on every OS. It is cheap, it keeps `dist/app` identical, and it lets unit tests import its pure logic.
  Stage it only for darwin (2.4).
- It should import `SECRET_WORDS`/`SECRET_ANYWHERE`, `secretIds`, etc. from `app/main/perception/elements.ts` directly.
  The Python sidecar has to keep its own copy, guarded by `perception.test.ts:288`; the AX sidecar avoids that.
- Run time: `command = process.execPath`, `args = [path.join(__dirname, "ax-sidecar.cjs")]`,
  `env = { ...env, ELECTRON_RUN_AS_NODE: "1" }`. The packaged path is
  `Ember.app/Contents/Resources/app/dist/app/ax-sidecar.cjs`. `require("koffi")` resolves to
  `Contents/Resources/app/node_modules/koffi`. In dev, `process.execPath` is
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
- Add a test helper like `test/unit/desk-agent-build.ts` (`axSidecarScript()` builds `.cache/test/ax-sidecar.cjs`),
  so darwin tests can spawn it with `process.execPath` (vitest's node).

**(b) Windows UIA sidecar: shipped as resources, not built.** Proposed source files are `sidecar/uia/ember_uia.ps1`
(the host: stdin/stdout loop, JSON) and `sidecar/uia/EmberUia.cs` (C# 5, `System.Windows.Automation`, P/Invoke).
Nothing in build-app.mjs changes. Resolve them like the AT-SPI script (`app/main/main.ts:801-803`): in dev,
`path.join(app.getAppPath(), "sidecar","uia",...)`; when packaged, `path.join(process.resourcesPath, "sidecar","uia",...)`.
stage.mjs copies them (2.3). The launch command:

```
command: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
args:    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", <ember_uia.ps1>]
```

Use the absolute path to Windows PowerShell 5.1, not `pwsh` and not a PATH lookup. Constraints that bear on build
and test:

- **C# 5 only.** In PS 5.1, `Add-Type` uses CodeDom and the .NET Framework 4.x `csc.exe`, which compiles C# 5. That
  rules out `$"..."` interpolation, `?.`, `nameof`, expression-bodied members, auto-property initialisers and
  `out var`. CI must compile the file with exactly that compiler (4.2).
- **Encoding.** Keep the files ASCII (0, item 8). In the host, set
  `[Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`. Write each
  answer with `[Console]::Out.Write($json + "`n"); [Console]::Out.Flush()`. Set `$ProgressPreference='SilentlyContinue'`,
  so CLIXML progress records don't land on stderr (stderr only reaches the debug log, `sidecar.ts:223-225`).
- **Start-up latency vs the 5 s request timeout.** `request()` defaults to `timeoutMs = 5000` and its timer starts
  when the request is written (`sidecar.ts:311-323`). A cold `Add-Type` (csc plus JIT, plus Defender scanning the
  temp DLL) can take seconds, so the first request may time out and the helper is killed and restarted in a loop.
  Fix it in one of two ways. (1) Cache the compiled assembly: `Add-Type -OutputAssembly
  %LOCALAPPDATA%\ember\uia\EmberUia-<sha256 of .cs>.dll`, then `Add-Type -Path <dll>` on later starts. (2) Give the
  first request on win32 a longer timeout (for example 20 s for `status`).
- **Execution policy.** `-ExecutionPolicy Bypass` on the command line is overridden by Group Policy
  (MachinePolicy/UserPolicy "AllSigned"). Constrained Language Mode (AppLocker/WDAC) blocks `Add-Type` outright.
  The sidecar should report `$ExecutionContext.SessionState.LanguageMode` in `status`, and doctor should explain it.
  These cannot be exercised on hosted runners; document them.
- **DPI.** `powershell.exe` is not per-monitor DPI aware, and UIA virtualises `BoundingRectangle` for DPI-unaware
  callers. The sidecar must call `SetProcessDpiAwarenessContext(-4)` (PER_MONITOR_AWARE_V2) before its first UIA call.
  Hosted runners run at 100 % scaling, so CI will not catch this. Cover it in a manual test plan.
- **Protocol invariants it must keep** (from `sidecar.ts`): honour `EMBER_ATSPI_ID_BASE` (ids from
  `ID_BLOCK = 10_000_000` blocks, L181); accept `remember_secrets` as the first message (L240-244); answer one request
  at a time, in order; never print non-protocol lines on stdout (they are logged as `sidecar.bad_line`, L265-271).

**(c) desk-agent stays as it is.** Keep building `desk-agent.cjs` everywhere (it is just a bundle). Stage it only on
Linux. stage.mjs's "build first" check (L29-31) must become per-platform: Linux `main.cjs` + `desk-agent.cjs`; darwin
`main.cjs` + `ax-sidecar.cjs`; win32 `main.cjs`. The font files are required everywhere.

**(d) The runtime locator, `app/main/agent/runtime.ts`.** Replace the constant at L9 with a per-platform computation.
It mirrors the SDK's own `getRuntimePlatform`, which is in `node_modules/@github/copilot-sdk/dist/runtimeArtifacts.js`:

```ts
const plat = process.platform === "linux" ? (isMusl() ? "linuxmusl" : "linux") : process.platform; // darwin | win32
const key = `${plat}-${process.arch}`;                                   // e.g. win32-x64, darwin-arm64
const exe = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
const RELATIVE = path.join("node_modules", "@github", `copilot-sdk-${key}`, "prebuilds", key, exe);
```

`ensureExecutable` (L32-39) is harmless on Windows. Callers: `main.ts:174`, `main.ts:1164`, `eval/src/main.ts:100`,
`test/unit/agent-misc.test.ts:113-121`, `test/integration/{conductor,persona,worker-safety}.test.ts`.

**(e) `package.json` scripts.**

| script | today | win32/darwin |
|---|---|---|
| `build`, `dev`, `start`, `build:lab`, `typecheck`, `lint`, `test`, `test:smoke`, `doctor`, `eval` | node/electron/tsc/eslint/vitest | run as they are (`&&` works in cmd.exe). `eval` runs but fails by design (3.6) |
| `test:integration` | `EMBER_INTEGRATION=1 vitest run` | **broken on Windows** (cmd.exe has no `VAR=x cmd`). Use `vitest run --config vitest.integration.config.ts` (a config with the integration include and `fileParallelism: false`), or `node scripts/vitest-integration.mjs`. Do not add cross-env just for this. CI's el8 job calls `npm run test:integration -- <files>`, which keeps working |
| `check:symvers`, `rebuild:el8` | bash | Linux only (glibc checks); leave as they are |
| `test:sidecar` | `python3 -B sidecar/atspi/test_ember_atspi.py` | Linux only. Add `test:sidecar:uia` (powershell.exe self-test) and run the AX sidecar's tests in vitest |
| `package`, `package:rpm` | `... && scripts/package/rpm.sh && scripts/package/appimage.sh` | Add `package:win` (`npm run build && node scripts/package/stage.mjs && node scripts/package/win.mjs`) and `package:mac` (`... && node scripts/package/mac.mjs`). Optionally make `package` dispatch on `process.platform` through `node scripts/package/all.mjs` |

**(f) `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`.**

- tsconfig (`types: ["node"]`, `lib` with DOM, `include` app/packages/demo/test/eval) needs no change. The new TS
  sidecar and backends live under `app/`. `.ps1`/`.cs` are not compiled.
- ESLint lints only JS/TS, so `.ps1`/`.cs` are ignored. The koffi rule (`eslint.config.mjs:14-17`):
  `no-restricted-properties` on `koffi.view`, with the message "koffi.view() makes an external ArrayBuffer, which
  aborts Electron (V8 memory cage). Copy with koffi.decode(ptr, "uint8_t", n)". It applies to the new Windows and
  macOS backends in the main process: GDI `GetDIBits`, `CGBitmapContext`/`CFDataGetBytePtr`. Prefer native calls
  that write into a JS-allocated `Buffer` you pass as an out pointer (`GetDIBits(..., buf, ...)`,
  `CGBitmapContextCreate(buf, ...)` plus `CGContextDrawImage`). That copies nothing extra and makes no external
  ArrayBuffer. The rule only matches the literal `koffi.view`, so an alias (`const k = koffi; k.view`) slips through.
  Keep importing koffi under the name `koffi`.
- vitest.config.ts (L15-16): `include` switches on `EMBER_INTEGRATION`; `fileParallelism` is off for integration. If
  you add a separate integration config, keep the aliases (L7-11).

---

## 2. Staging and packaging

### 2.1 Today (Linux)

`npm run package` = build, `stage.mjs`, `rpm.sh`, `appimage.sh`.

**`scripts/package/stage.mjs` (178 lines), step by step:**

- L21-26: `root`, `out = dist/package`, `app = dist/package/ember`, `resources = app/resources`.
- L29-31: requires `dist/app/{main.cjs, desk-agent.cjs, renderer/shared/ember.css, renderer/fonts/InterVariable.woff2, renderer/fonts/LICENSE.txt}`.
- L35-37: `prod` = `npm ls --omit=dev --all --parseable`, split on `\n`, minus root, minus
  `SKIP = [/linuxmusl/, /@img[\\/]sharp-wasm32/, /@emnapi/, /node_modules[\\/]tslib$/]`. On this machine `prod` is
  @github/copilot-sdk, -linux-x64, -linuxmusl-x64 (skipped), koffi, @koromix/koffi-linux-x64, sharp, @img/colour,
  @img/sharp-linux-x64, @img/sharp-libvips-linux-x64, the linuxmusl variants (skipped), sharp-wasm32, @emnapi/runtime
  and tslib (all skipped), sherpa-onnx, zod, vscode-jsonrpc, detect-libc, semver.
- L40-49: licence gate. Every bundled package's `license` (and, for packages matching `BUNDLED_LIBRARIES`, the
  libraries in their README licensing table) must be in `packaging/rpm/ember.spec`'s `License:` tag (spec L25).
  `scripts/package/licences.mjs` does the work: `spdxIds` L6, `specLicenceIds` L9, `BUNDLED_LIBRARIES` L16-32 (only
  `/^@img\/sharp-libvips-/`), `readmeLibraries` L35-43, `uncoveredLicences` L49-65.
- L52-53: removes only `dist/package/{ember,voice-models}`.
- L56-59: copies `path.dirname(require("electron"))` (the dist folder on Linux) to `dist/package/ember` with
  `verbatimSymlinks`, renames `electron` to `ember`, deletes `resources/default_app.asar`.
- L62-64: `flipFuses(app/ember, EMBER_FUSES)`, then `fuseMismatches`; throws if a fuse didn't take.
- L67-75: writes `resources/app/package.json` (name, `productName: "Ember"`, version, description, license, author,
  main, type, dependencies), `LICENSE`, and `dist/app` without `.map` files.
- L78-79: `NOTICE` regex plus the sharp-libvips README count as licence files and always ship.
- L80-93: copies each prod package to `resources/app/node_modules/...` without nested node_modules, test/docs/examples
  folders, `.md`/`.d.ts`/`.map` files (notices excepted).
- L95-98: prunes `node_modules/koffi/build/koffi/*` except `linux_x64`. **Dead code with koffi 3.2.1**: koffi no
  longer has `build/`. Its native binary comes from `@koromix/koffi-<plat>-<arch>`, which koffi's loader finds as
  `${__dirname}/../../../@koromix/koffi-${platform}-${arch}` (`node_modules/koffi/src/koffi/index.cjs:199`).
- L99: deletes `@koromix/koffi-linux-x64/musl_x64` (hard-coded).
- L103-105: deletes `ripgrep`, `tgrep`, `plugins`, `builtin-skills` from `@github/copilot-sdk-linux-x64` (hard-coded).
- L108-109: copies `sidecar/atspi/ember_atspi.py` to `resources/sidecar/atspi/`.
- L113-142: optional speech models in `dist/package/voice-models` (a separate RPM sub-package). Only when every model
  is verified against its `.ok` marker, and only the files Ember loads.
- L145-159: `dist/package/ember/THIRD_PARTY_NOTICES` (Ember LICENSE, Electron, Chromium, Inter, every package with
  its notice files).
- L162-171: `voiceModels()` bundles `app/voice/models.ts` with esbuild into an `os.tmpdir()` folder and requires it.
  Portable.
- L173-178: `du -sh` for the summary line. **Not available on Windows.**

**`rpm.sh`** needs `dist/package/ember/ember` to be executable (L10). It tars the staged folder plus the launcher,
`.desktop`, svg, a 256 px PNG from `icon.mjs` (L20) and the policy example, then runs `rpmbuild` with xz (L26-28).
**`appimage.sh`** pins appimagetool 1.9.1 and type2-runtime 20251108 by SHA-256 (L12-15). It writes `AppRun`
(L35-54: `--ozone-platform=x11`, `--no-sandbox` when `/proc/sys/user/max_user_namespaces` is 0, and a `doctor`
subcommand). **`fuses.mjs`**: `SENTINEL` L11, the 9-fuse order `FUSES` L15-25, `EMBER_FUSES` L35-39
(`RunAsNode: true`, `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false`).
`findWire` L42-51 requires exactly one sentinel and wire version 1. `flipFuses` L90-98 writes back only the wire
bytes, so the file keeps its mode. The CLI (L100-109) supports `--check`. **`icon.mjs`** renders the SVG to one PNG
with sharp (density 384). **`check-symvers.sh`** checks x86-64 ELF only, against GLIBC_2.28, GLIBCXX_3.4.25 and
CXXABI_1.3.11 (L8-10, L31). **`rebuild-el8.sh`** re-runs itself in rockylinux:8 through podman or docker (L12-31),
runs `electron-rebuild` on `ember.nativeModules`, which is `[]` (L33-39), and writes `/tmp/ember-symvers.txt`
(L42-46). **`packaging/`**: `ember` (sh launcher: `APP=/opt/ember/ember`, `doctor` with `--ozone-platform=headless|x11`,
`--no-sandbox` only as root), `ember.desktop`, `rpm/ember.spec` (`ExclusiveArch: x86_64`, explicit Requires, setuid
`chrome-sandbox`), `policy.example.json`. **All of these are Linux-only and stay as they are.** Note the
`ember doctor` subcommand exists only in the sh launchers: on Windows and macOS the binary has to accept `--doctor`
directly (2.3.6).

### 2.2 Portability defects in stage.mjs (fix before adding targets)

| # | where | problem on win32 / darwin | fix |
|---|---|---|---|
| 1 | L36 `execFileSync("npm", [...])` | win32: `npm` is `npm.cmd`, and since Node 18.20.2/20.12.2/22.x `child_process` refuses `.cmd` without `shell: true` (`EINVAL`) | `execFileSync(process.execPath, [process.env.npm_execpath, "ls", ...])` when `npm_execpath` is set (running under npm), else `execFileSync("npm", args, { shell: process.platform === "win32" })` |
| 2 | L37 `p !== root` | win32: npm may print the root with different drive-letter case | compare with `path.relative(root, p) === ""` (case-insensitive on win32); `trim()` each line |
| 3 | L56-58 Electron copy and rename | darwin: `require("electron")` returns `dist/Electron.app/Contents/MacOS/Electron`, so `dirname` is the MacOS folder. win32: the binary is `electron.exe` | copy `path.join(path.dirname(require.resolve("electron/package.json")), "dist")`. Rename per platform (2.3, 2.4) |
| 4 | L59 `resources/default_app.asar` | darwin: `Ember.app/Contents/Resources/default_app.asar` | per-platform resources dir |
| 5 | L62 `flipFuses(app/ember)` | win32: `ember.exe`; darwin: the Electron Framework binary (2.5) | per-platform fuse file |
| 6 | L95-99 koffi pruning | dead code (`build/koffi` doesn't exist in 3.2.1); musl path hard-coded | per-target table (2.6). **Never prune `koffi/src`**: `koffi/index.cjs` requires `./src/koffi/index.cjs`, which requires `./src/static.cjs` |
| 7 | L103-105 Copilot pruning | hard-coded `copilot-sdk-linux-x64` | `copilot-sdk-${key}` |
| 8 | L108-109 sidecar | AT-SPI only | per platform: linux `sidecar/atspi/ember_atspi.py`; win32 `sidecar/uia/{ember_uia.ps1,EmberUia.cs}`; darwin nothing extra (`dist/app/ax-sidecar.cjs` is already in `resources/app/dist/app`) |
| 9 | L153 THIRD_PARTY_NOTICES at `app/` | darwin: must sit inside the bundle (`Ember.app/Contents/Resources/`). Electron's `LICENSE`, `LICENSES.chromium.html` and `version` sit next to `Electron.app` in `dist/` and must move into `Contents/Resources/` too, or the shipped `.app` carries no Chromium licences | per-platform notices dir. Update the notice text that names "LICENSE beside this file" |
| 10 | L173 `du -sh` | win32: no `du` | JS `dirSize()` |
| 11 | L29-31 required files | `desk-agent.cjs` is Linux-only | per-platform list (1.2c) |
| 12 | L40-49 licence source | uses the RPM spec for every target; fine, but odd | keep it (simplest), or move the tag to `packaging/licences.txt` and have the spec test read it. Either way extend `BUNDLED_LIBRARIES` (2.7) |

Structure: add `scripts/package/layout.mjs`, exporting `layoutFor(platform, arch)`. It gives `appDir`, `exe`,
`resourcesDir`, `fuseFile`, `notesDir`, `renames[]`, `sidecarFiles[]`, `requiredDist[]` and `keep`/`prune` patterns.
It has no side effects, so it can be unit-tested on Linux for all three targets. stage.mjs then becomes target-driven.
Stage on the target OS: Electron and the native packages come from the host's `npm ci`. Cross-staging (`npm install
--os=win32 --cpu=x64` plus a downloaded Electron zip) is possible later, but signing and `hdiutil` need macOS anyway.

### 2.3 Windows target (staged folder + zip; NSIS later)

**2.3.1 Layout** (`dist/package/ember/`, zipped as `Ember-<version>-win32-x64.zip` with top folder `Ember/`):

```
Ember/
  ember.exe                      (electron.exe renamed; icon + version resource; fuses flipped)
  *.dll (ffmpeg, libEGL, libGLESv2, d3dcompiler_47, vk_swiftshader, vulkan-1), *.pak, icudtl.dat,
  snapshot_blob.bin, v8_context_snapshot.bin, locales/, vk_swiftshader_icd.json
  LICENSE, LICENSES.chromium.html, version, THIRD_PARTY_NOTICES
  resources/
    app/ package.json, LICENSE, dist/app/** (no .map), node_modules/**
    sidecar/uia/ember_uia.ps1, EmberUia.cs
    (voice-models/ only with --with-models; main.ts:160 already looks in process.resourcesPath/voice-models)
```

No `chrome-sandbox`. `default_app.asar` is removed.

**2.3.2 Order of operations** (the order matters):

1. Copy `node_modules/electron/dist` to `dist/package/ember`. Rename `electron.exe` to `ember.exe`. Delete
   `resources/default_app.asar`.
2. **Icon and version resource first**, using `resedit` (pure JS, runs on any OS) or `rcedit` (needs Windows or wine).
   Set `FileDescription=Ember` (Task Manager shows it), `ProductName=Ember`, `CompanyName`,
   `FileVersion`/`ProductVersion=<version>.0`, `OriginalFilename=ember.exe`, `InternalName=ember`, plus the icon group.
   `electron.exe` ships Authenticode-signed. Rewriting resources invalidates the signature; resedit only writes a
   signed PE when you pass `ignoreCert: true`, and its output has no certificate table. A stripped binary is better
   than one with a broken signature (antivirus heuristics treat the latter worse).
3. **Fuses after the resource edit.** The rewrite can move sections; `flipFuses` re-finds the sentinel. Then
   `readFuses` + `fuseMismatches`, failing on any mismatch (as L63-64).
4. App files, prod node_modules (2.6), sidecar files, notices.
5. (Later) Authenticode signing with `signtool` after fuses. Without it SmartScreen shows "Windows protected your PC"
   for a downloaded zip. Document "More info, then Run anyway".
6. Zip. On runners `7z a -tzip` is preinstalled; `tar.exe -a -c -f x.zip` (System32 bsdtar) works too. Avoid
   `Compress-Archive` on PS 5.1: slow, with some timestamp/encoding quirks. Or add a small JS zip dev-dependency, such
   as `yazl`, for reproducible zips.

**2.3.3 ICO.** sharp cannot write ICO. Extend `icon.mjs` with `--ico out.ico 16,24,32,48,64,128,256`: render each size
to PNG with sharp and pack them as PNG-compressed ICO entries (6-byte ICONDIR plus 16-byte entries; size 256 is stored
as 0). This is pure JS and can be unit-tested on Linux.

**2.3.4 Verification steps** (CI, Git Bash shell):

```
node scripts/package/fuses.mjs --check dist/package/ember/ember.exe
ELECTRON_RUN_AS_NODE=1 dist/package/ember/ember.exe -e "process.exit(0)"
ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--require=C:/nonexistent/x.js dist/package/ember/ember.exe -e "process.exit(0)"
dist/package/ember/ember.exe --inspect=127.0.0.1:9229  -> expect exit 2 and "Ember doesn't start with debugging switches." (main.ts:64-69)
node test/smoke/launch.mjs --exe dist/package/ember/ember.exe   (2.8 / 4.3)
test -f dist/package/ember/resources/sidecar/uia/ember_uia.ps1
```

**2.3.5 NSIS later.** A per-user install to `%LOCALAPPDATA%\Programs\Ember` (no elevation), a Start-menu shortcut
carrying the AppUserModelID (it must match `app.setAppUserModelId(...)` in main.ts for toasts and taskbar grouping),
and an uninstaller. Use `makensis` (check whether the runner image still preinstalls NSIS; otherwise
`choco install nsis`). electron-builder could do zip/NSIS/dmg/fuses/signing in one tool, but it would replace the
bespoke checks Ember relies on (licence gate, fuse verification). Keep the bespoke scripts.

**2.3.6 Windows-specific notes.**

- `ember.exe` is a GUI-subsystem binary. When run from an interactive console without redirection, its stdout does
  not appear. `ember --doctor` printing a report (`main.ts:85`, `--doctor`) therefore needs a console-friendly path:
  write the report to a file and open it, attach to the parent console, or ship an `ember-doctor.cmd` that redirects.
  When stdout is redirected (CI, the smoke test) output works.
- UIPI: a medium-integrity Ember can neither drive nor read elevated windows through SendInput or UIA. `uiAccess=true`
  needs a signed binary installed under Program Files. Hosted runners run with UAC off (everything elevated), so CI
  cannot see this difference.
- Long paths: the deepest bundled file is about 100 characters below `node_modules`
  (`@github/copilot-sdk-*/definitions/sidekick/test-sidekick-context-changed.yaml`). Under
  `%LOCALAPPDATA%\Programs\Ember\resources\app\` that is under 260. Do not nest the zip's contents deeper.

### 2.4 macOS target (Ember.app + ad hoc codesign + zip + dmg)

**2.4.1 Layout:** `dist/package/Ember.app` (arm64 on macos-14/15 runners; x64 needs an Intel runner or a cross
install):

```
Ember.app/Contents/
  Info.plist                     (edited, 2.4.3)
  MacOS/Ember                    (was MacOS/Electron)
  Frameworks/Electron Framework.framework/...   <- the fuse wire is here
  Frameworks/Electron Helper*.app (rename to "Ember Helper*", 2.4.2), Mantle/ReactiveObjC/Squirrel.framework (keep)
  Resources/
    ember.icns                   (replaces electron.icns)
    LICENSE, LICENSES.chromium.html, version, THIRD_PARTY_NOTICES   (moved in from dist/, 2.2 #9)
    app/ package.json, LICENSE, dist/app/** (incl. ax-sidecar.cjs), node_modules/**
    (no default_app.asar)
```

`process.resourcesPath` is `Contents/Resources` and `app.getAppPath()` is `Contents/Resources/app`. `process.execPath`
is `Contents/MacOS/Ember`, which the AX sidecar's launcher uses.

**2.4.2 Steps** (all on a macOS host):

1. `fs.cpSync(dist/Electron.app, dist/package/Ember.app, { recursive: true, verbatimSymlinks: true })`. The framework
   `Versions/Current` symlinks must survive. Copy `dist/{LICENSE,LICENSES.chromium.html,version}` into
   `Contents/Resources/`.
2. Rename `Contents/MacOS/Electron` to `Contents/MacOS/Ember`.
3. Helpers: rename `Electron Helper.app`, `Electron Helper (GPU).app`, `Electron Helper (Renderer).app` and
   `Electron Helper (Plugin).app` to `Ember Helper*.app`, together with each one's `Contents/MacOS/<exe>` and its
   Info.plist `CFBundleExecutable`, `CFBundleName` and `CFBundleIdentifier` (`<id>.helper`, `.helper.GPU`,
   `.helper.Renderer`, `.helper.Plugin`). This is what @electron/packager does. Electron looks for
   "Electron Helper" first and then "<app name> Helper" (**verify**), so leaving them unrenamed also works, but
   Activity Monitor would show "Electron Helper".
4. Info.plist (2.4.3). Run `plutil -convert xml1` first, then edit with `plutil -replace` or a small XML editor that
   lives in `layout.mjs`, so it can be unit-tested.
5. Icon: build `ember.icns` with `iconutil -c icns ember.iconset` (16, 32, 128, 256, 512 at @1x and @2x, from
   `icon.mjs`), or write the ICNS container in JS (PNG entries `ic07`-`ic14`). Delete `electron.icns` and set
   `CFBundleIconFile=ember.icns`.
6. Remove `Contents/Resources/default_app.asar`. Copy the app files and node_modules (2.6). Write the notices into
   `Contents/Resources`.
7. **Fuses** on `Contents/Frameworks/Electron Framework.framework/Electron Framework` (a symlink to
   `Versions/A/Electron Framework`; `readFileSync` and `openSync("r+")` follow it). Then verify.
8. **Ad hoc codesign, inside out, after every byte has changed.** Simplest:
   `codesign --force --deep --sign - --timestamp=none dist/package/Ember.app`. More precise: sign `Frameworks/*.framework`,
   then `Frameworks/*.app`, then the app, each with `--force --sign -`. Native code under `Contents/Resources`
   (`koffi.node`, `sharp-darwin-arm64-*.node`, `libvips-cpp.*.dylib`, the Copilot `runtime.node`,
   `libmsalruntime_arm64.dylib` and the `copilot-runtime` executable) is not "nested code". `--deep` does not re-sign
   it; it is sealed as data in `CodeResources` and keeps its npm-published (linker or ad hoc) signatures, which arm64
   requires. **Never modify anything inside the bundle at run time**: that breaks the seal. `runtime.ts`'s
   `ensureExecutable` `chmod` must stay a no-op, which it is when npm already set 0755.
9. `codesign --verify --deep --strict --verbose=2 Ember.app`. Do not use `spctl -a`, which rejects ad hoc signatures by
   design.
10. Zip: `ditto -c -k --sequesterRsrc --keepParent Ember.app Ember-<v>-darwin-arm64.zip`. Plain `zip -r` breaks the
    framework symlinks unless you pass `-y`.
11. DMG: make a staging folder with `Ember.app` and an `Applications -> /Applications` symlink, then
    `hdiutil create -volname Ember -srcfolder <dir> -ov -format UDZO Ember-<v>-darwin-arm64.dmg`. Retry up to three
    times: `hdiutil` sometimes fails on CI with "Resource busy".

**2.4.3 Info.plist keys**

| key | value | why |
|---|---|---|
| `CFBundleIdentifier` | e.g. `io.github.komaladitya-08.ember` (letters, digits, `-` and `.`; **no `_`**) | TCC grants, single instance, defaults domain |
| `CFBundleName` / `CFBundleDisplayName` | `Ember` | menu bar, Finder |
| `CFBundleExecutable` | `Ember` | matches `MacOS/Ember` |
| `CFBundleIconFile` | `ember.icns` | |
| `CFBundleShortVersionString` / `CFBundleVersion` | `pkg.version` | |
| `LSMinimumSystemVersion` | `13.0` | the stated target |
| `NSMicrophoneUsageDescription` | "Ember listens for "Hey Ember" on this Mac; nothing leaves it." | the mic page's getUserMedia; without it TCC refuses silently |
| `NSAppleEventsUsageDescription` | only if a backend sends Apple Events (System Events, osascript) | otherwise omit |
| `NSHighResolutionCapable` | `true` (already in Electron's plist) | |
| `LSUIElement` | **recommend `true`**: an ambient companion with no Dock icon and no app menu; call `app.dock.show()` while the settings window is open if wanted | start with `false` if you would rather keep Dock activation simple; it is a product decision |
| remove `ElectronTeamID`, `ElectronAsarIntegrity` (if present) | | not ours |

There is no Info.plist usage-description key for Accessibility or Screen Recording. Those prompts come from
`AXIsProcessTrustedWithOptions` and the first capture call.

**2.4.4 macOS surprises for packaging and tests.**

- **TCC identity:** grants are keyed to the code requirement. An ad hoc signature's requirement is its cdhash, so
  every build is a new app to TCC (stale "Ember" entries remain in System Settings). A self-signed code-signing
  certificate kept in CI secrets (`codesign --sign "Ember Dev"`) gives a stable requirement across builds. A Developer
  ID plus notarisation is the real fix.
- **Gatekeeper:** an ad hoc app from a downloaded zip/dmg gets quarantined. On macOS 13/14 right-click then Open
  works; on macOS 15 users must use System Settings, Privacy & Security, "Open Anyway". Running from Downloads also
  triggers App Translocation (a random read-only path; autostart paths change). Tell users to move the app to
  /Applications.
- **TCC "responsible process":** the AX sidecar child inherits Ember.app's Accessibility grant. In dev (`electron .`)
  the grant needed is the terminal's (Terminal/iTerm/VS Code). On CI it is the runner's (4.5).
- **Universal binaries:** a universal `Electron Framework` holds two fuse wires, and `findWire` throws "more than one
  fuse wire" (`fuses.mjs:45`). Teach it to flip every wire (or every Mach-O slice) before building universal apps.
- Future Developer ID with hardened runtime needs these entitlements: `com.apple.security.cs.allow-jit`,
  `...allow-unsigned-executable-memory`, `...disable-library-validation` (koffi.node and the sharp/Copilot natives are
  signed by other teams), `com.apple.security.device.audio-input`, and `com.apple.security.automation.apple-events` if
  Apple Events are used.

### 2.5 `fuses.mjs` changes

- Add `fuseFileFor(platform, appDir)`: linux `appDir/ember`; win32 `appDir/ember.exe`; darwin
  `appDir/Contents/Frameworks/Electron Framework.framework/Electron Framework` (what @electron/fuses does).
- The CLI keeps taking a file path. CI passes the right one (4.4).
- `findWire`: optionally accept N wires for universal builds (flip all and check that they agree).
- `test/unit/fuses.test.ts:79` ("matches the Electron in node_modules") hard-codes `node_modules/electron/dist/electron`,
  so it is vacuous on win32/darwin. Use `require("electron")`, and on darwin map it to the framework binary.

### 2.6 node_modules per target (keep / prune)

npm only installs the host's optional platform packages. The lockfile has entries for every platform
(`package-lock.json` lines 715-806 copilot-sdk-*, 894-1366 @img/sharp-*, 1450-1722 @koromix/koffi-*), so `npm ci`
works on every runner. Stage must **assert** that the expected platform packages are present and fail with a clear
message otherwise.

| target | keep | prune inside | skip whole package |
|---|---|---|---|
| linux-x64 | `@github/copilot-sdk-linux-x64`, `@koromix/koffi-linux-x64`, `@img/sharp-linux-x64`, `@img/sharp-libvips-linux-x64` | copilot: `ripgrep/ tgrep/ plugins/ builtin-skills/`; koffi: `musl_x64/` | `*linuxmusl*`, `@img/sharp-wasm32`, `@emnapi/*`, `tslib` |
| win32-x64 | `@github/copilot-sdk-win32-x64` (its `prebuilds/win32-x64/` holds **copilot-runtime.exe, runtime.node (117 MB), dpapi.node, msal-node-runtime.node, msalruntime.dll**: keep all), `@koromix/koffi-win32-x64` (`win32_x64/koffi.node`), `@img/sharp-win32-x64` (`lib/` 19.8 MB: libvips DLLs plus `sharp-win32-x64-0.35.5.node`; **no separate libvips package on Windows**) | copilot: `ripgrep/ tgrep/ plugins/ builtin-skills/`; koffi: `win32_x64/koffi.lib` (import library) | `@img/sharp-wasm32`, `@emnapi/*`, `tslib` |
| darwin-arm64 | `@github/copilot-sdk-darwin-arm64` (`prebuilds/darwin-arm64/`: **copilot-runtime, runtime.node (97 MB), msal-node-runtime.node, libmsalruntime_arm64.dylib**), `@koromix/koffi-darwin-arm64` (`darwin_arm64/koffi.node`), `@img/sharp-darwin-arm64` (`lib/sharp-darwin-arm64-0.35.5.node`), `@img/sharp-libvips-darwin-arm64` (`lib/libvips-cpp.8.18.7.dylib`) | copilot: same four; libvips: `lib/glib-2.0/include/` (a header) | same |
| darwin-x64 | the `-darwin-x64` equivalents | same | same |

Platform-neutral packages ship everywhere: `@github/copilot-sdk`, `koffi` (keep `src/koffi/*.cjs`; `doc/` is already
filtered as "docs"), `sharp`, `@img/colour`, `detect-libc`, `semver`, `sherpa-onnx` (WASM, about 15 MB), `zod`,
`vscode-jsonrpc`.

### 2.7 `licences.mjs` and the notices

- `@img/sharp-win32-x64` declares `"Apache-2.0 AND LGPL-3.0-or-later"` and **bundles libvips and its libraries
  itself**. Its README has the same licensing table as sharp-libvips (checked on npm: aom, cairo, cgif, expat,
  fontconfig, freetype, fribidi, glib, harfbuzz, highway, lcms, libarchive, libexif, libffi, libheif, libimagequant,
  libnsgif, libpng, librsvg, libtiff, libultrahdr, libvips, libwebp, libxml2, mozjpeg, pango, pixman, proxy-libintl,
  zlib-ng). `BUNDLED_LIBRARIES[0].package` (`/^@img\/sharp-libvips-/`, L18) does not match it, so on Windows the
  bundled libraries would **go unchecked**. Widen the pattern to `/^@img\/sharp-(libvips-|win32-)/`. Also extend
  `isNotice` (stage.mjs L79), and the spec's `%license` sed (Linux only), so its `README.md` ships as a notice.
- `test/unit/licences.test.ts:34` reads `node_modules/@img/sharp-libvips-linux-x64/README.md` and is skipped on
  win32/darwin. Add the equivalent for whichever README is present.
- `packaging.test.ts:128-136` filters the lockfile for linux/x64/glibc. Add win32-x64 and darwin-arm64 variants (all
  pass with the current tag; the test documents intent).

### 2.8 Speech models on Windows and macOS

Linux stages them as an RPM sub-package (L113-142). On win32/darwin, default to **not** bundling them (126 MB; Ember
downloads them on demand into `userData/models`). Offer `--with-models`, which copies into `resources/voice-models`;
`main.ts:160` already looks there. The downloader shells out to `curl` and `tar -xjf ... -C root`
(`app/voice/models.ts:98,116`, `scripts/voice/prepare.mjs:54,58`). Windows 10 1803+ ships both. On hosted runners,
make sure System32's bsdtar is used: GNU tar from Git's `usr/bin` reads `C:\...` as `host:path` (it needs
`--force-local`).

---

## 3. Tests

### 3.1 Causes, once

| cause | effect on win32 | effect on darwin |
|---|---|---|
| POSIX file modes | `stat().mode & 0o777` is 0o666, or 0o444 when read-only (no x bit, no group/other). `chmod 0o500` on a directory only sets the read-only attribute, which Windows ignores for writing into the directory. Read-only files can't be unlinked (EPERM) | fine |
| `/proc` | missing: `running()`, `startTime()`, `helperState()`, `deskProcesses()`, `mountPoints()`, `inotifyUse()` all return false/null/[] | missing (same) |
| `:` as list separator | breaks: `C:\...`. `listApps` (`hands/system.ts:326`), `which` (`desk/desk.ts:34-40`, `eval/src/runner.ts:88`) | fine |
| `path.join` with POSIX literals | gives `\tmp\rt\bus` | fine |
| `pathToFileURL("/home/x")` | `file:///C:/home/x` (resolved against the current drive) | fine |
| `/bin/sh`, `sh -c`, `true`, `sleep`, `setsid` | missing (Git Bash may put `sh` on PATH on runners) | `setsid` missing |
| `process.getuid` | `undefined` | fine |
| signals | only SIGINT/SIGTERM/SIGKILL/0. `SIGSTOP` throws; SIGTERM is TerminateProcess (exit code 1, `signal` null); no process groups (`kill(-pid)` throws) | fine |
| `HOME`/`TMPDIR` overrides | ignored: `os.homedir()` uses `USERPROFILE`, `os.tmpdir()` uses `TEMP`/`TMP` | honoured |
| temp paths | `os.tmpdir()` on runners is an 8.3 path (`C:\Users\RUNNER~1\...`) while `realpathSync` gives the long name | `/var/folders/...` is a symlink to `/private/var/...` |
| symlinks | directory/file symlinks need admin or Developer Mode (hosted runners are admin) | fine |
| CRLF checkout (`core.autocrlf=true` on Windows runners) | JS `m`-flag `^`/`$` still match around `\r\n` (checked), but explicit `\n` patterns fail, e.g. `packaging.test.ts:157` `/<<'RUN'\n([\s\S]*?)\nRUN\n/`. Shell scripts break under Git Bash | n/a |
| file locking / antivirus | `rename`/`rm` can fail with EBUSY/EPERM while another process (Defender, a lingering child) holds the file | n/a |
| no Xvfb, no libX11, no Python GTK | X/AT-SPI tests skip (gates below) | same; but a Mac with XQuartz sets `DISPLAY` and puts `Xvfb` on PATH, so gates that test only `DISPLAY` or `Xvfb` would run and fail |

Add `.gitattributes` (`* text=auto eol=lf`, plus `binary` for `*.wav *.woff2 *.png *.ico *.icns`). Belt and braces:
`git config --global core.autocrlf false` before checkout in the Windows job. Add `test/platform.ts`
(`export const linux = process.platform === "linux"`, etc.) and gate with `describe.runIf(linux)` and the like.

### 3.2 Every unit test file

Result columns: **P** = passes, **F** = fails (test name and L given), **S** = skipped. "Fix" says what to do in the
port. Electron is mocked (`vi.mock("electron")`) wherever a file name says window, overlay, place or revive.

| file | win32 | darwin | details and fix |
|---|---|---|---|
| agent-misc.test.ts | **F** 1 | **F** 1 | L113 "finds the bundled Copilot runtime in node_modules": `runtime.ts:9` is linux-x64 only. Fix runtime.ts (1.2d). L116 `EMBER_COPILOT_RUNTIME` passes. TokenStore writes 0o600 but asserts nothing about modes; clipboard and auth are pure |
| apps.test.ts | P | P | pure |
| ask-window.test.ts | P | P | mocked; reads an X11 XID with `readUInt32LE` from a fake `getNativeWindowHandle` (L36). Rework when focus goes through the platform layer: HWND is 8 bytes; on macOS it is an NSView* |
| borrow-keys.test.ts | P | P | fake XInput, X keysyms (pure) |
| borrow.test.ts | P | P | fake XInput |
| clipboard.test.ts | P | P | pure (Electron clipboard shape) |
| context.test.ts | P | P | fake X11 and sidecar |
| design-system.test.ts | P | P | pins strings in build-app.mjs, stage.mjs and the spec (1.1) |
| desk-agent-build.ts | (helper) | (helper) | portable; used only by desk-live (Linux) |
| desk-agent.test.ts | **F** 2 | **F** 2 | L105 "reaps a helper it gave up on (SIGSTOP)": `startTime()` reads `/proc/<pid>/stat` (desk.ts:115-123), so `born` is null and `expect(born).not.toBeNull()` fails; on win32 `process.kill(pid,"SIGSTOP")` also throws. L116 "stops quietly": `startTime` is null before and after, so `until(() => startTime(pid) !== born)` times out. Others pass (`running()` is always false, so those checks pass vacuously; `helperState()` null means no slow-helper grace). **Gate the file to linux**: the desk is Linux-only |
| desk-keys.test.ts | P | P | pure |
| desk-live.test.ts | **F** 2 | **F** 1 | "a real desk" (L82) is gated `available && libX11 && platform==="linux"` (L21), so S. Two suites are **not gated**. L26 "removeTree...": win32 F, because `removeTree`'s mount filter is `m.startsWith(dir + "/")` (desk.ts:223), so the injected backslash mount never matches, `unmount` isn't called and `expect(unmounted)` fails, and the 0o400 file can't be unlinked; darwin P. L55 "reapDesks...": win32 and darwin F, because L60 `readFileSync("/proc/self/stat")` throws ENOENT (and `true`/`sleep`/`setsid` are missing). **Gate the whole file to linux** |
| desk-view.test.ts | P | P | mocked |
| desk-wheel.test.ts | P | P | pure |
| desk.test.ts | **F** 6 (+1) | **F** 1 | L47 "knows a child has exited...": last line `running(process.pid)` reads /proc, so it is false (win32 and darwin F). L72 "gives LibreOffice a profile URL...": `new URL(url).pathname` is `/C:/...` but `encodeURI(path.join(...))` has `C:%5C...` (win32 F). L81 "runs LibreOffice on the desk with macros off...": mode asserts 0o500/0o400 (win32 F). L116 "clears the lock files...": `fs.symlinkSync(elsewhere, link)` needs symlink rights (P on admin runners, F for non-admin devs). L144 "...two folders down...": `locksIn()` returns `Documents\.~lock...`, not `Documents/...` (win32 F). L168 "...the moment it stops...": overrides `HOME`/`TMPDIR`, which Windows ignores, so `clearDeskLocksNear` scans the real profile and the test's `Documents` locks remain (win32 F). L208 "starts the desk's LibreOffice dialogs...": `pathToFileURL("/home/ana/Ember")` is `file:///C:/home/ana/Ember` (win32 F). The terminals, `appEnv`, `darkTheme`, `freeDisplay`, `deskWindowAt`, `guardX`, keys and policy tests pass. Fix: gate the desk/LibreOffice suites to linux; keep the pure ones |
| environment.test.ts | P | P | inputs injected (`platform:"linux"`). Will gain win32/darwin cases |
| eval-harness.test.ts | P | P | pure |
| eval.test.ts | **F** 3 | P | L201 "needs the session's display...": `path.join("/run/user/1000","bus")` gives backslashes in the message, so the regex fails. L207 "runs in the session": `path.join("/tmp/rt","bus")` is not `"/tmp/rt/bus"`. L239 "read files and folders": `realpathSync("/tmp")` is ENOENT. Fix: use `path.posix.join` in `exit.ts:58` (the paths are Linux paths) and `os.tmpdir()` in the test, or gate the live-desktop suite to linux |
| follow.test.ts | P | P | pure |
| fuses.test.ts | **F** 1 | P | L65 "flips a file in place, keeping its mode": mode 0o755 reads back as 0o666 on win32. Fix: assert the mode only off win32. L79 is vacuous on win32 and darwin (2.5) |
| handle-buttons.test.ts | P | P | pure |
| handle-window.test.ts | P | P | mocked |
| host.test.ts | **F** 1 | P | L1708 "this user's inotify instances are counted in /proc...": `process.getuid!()` is undefined on win32, so a TypeError (and dangling file symlinks need rights). Gate to `process.getuid` existing (or linux). The rest (fake SDK, fake timers, `runtimePath: "/nowhere/..."`) pass |
| hotkey.test.ts | P | P | pure |
| keybuffer.test.ts | P | P | pure keysym logic |
| launch-app.test.ts | P | P | `spawn` mocked; asserts Linux behaviour (`gtk-launch`, then the Exec fallback). Gate to linux once `launchApp` dispatches per OS |
| licences.test.ts | P (L34 S) | P (L34 S) | L34 needs the linux libvips README (2.7) |
| logger.test.ts | **F** 1 | P | L32 "never throws on circular values...": `mode & 0o077` is 0o066 on win32. Assert only off win32. Rotation (renames between appends) passes |
| overlay-question.test.ts | P | P | mocked |
| overlay-shape.test.ts | P | P | fakes koffi in Node's require cache (L44-58) and expects `load libX11.so.6`/`libXext.so.6` (L69). Once input shaping is per-platform, force the linux backend or gate to linux |
| packaging.test.ts | **F** 1 (+1 risk) | P (Intel: +1 F) | "ember doctor" (L27-82), "start at login" (L84-107, pure plus a temp autostart file), "the RPM" and "the RPM's licences" (file and lockfile reads) pass. L158 "run `ember doctor` without Chromium's sandbox only as root": `execFileSync("/bin/sh", ...)` fails on win32; darwin P (`/proc` is missing, so `noUserNs` is true, which matches AppRun's `echo 0` fallback). L175 "fails closed" (check-symvers): darwin arm64 S (`arch !== "x64"`); darwin x64 F (Mach-O is not ELF, so "FAIL no x86-64..." lacks `/true`); win32 S unless `sh`, `file` and `objdump` are all on PATH (Git Bash and Strawberry Perl's `objdump` on runners could make it run and fail). **Gate "the launchers" and "the glibc check" to linux** |
| perception-capture.test.ts | P | P | sharp has win32/darwin prebuilds |
| perception-sidecar.test.ts | P | P | the stand-in sidecar runs under node, so it is portable. win32: self-SIGTERM becomes TerminateProcess (code 1, signal null), still "stopped"; EPIPE may surface as EOF or EPIPE, both handled by `stdin.on("error")`. Timing bounds (<2000 ms) should hold. This is the template for UIA/AX transport tests |
| perception-windows.test.ts | P | P | fake X11 objects, sharp |
| perception-x11.test.ts | S | S | `describe.skipIf(!process.env.DISPLAY)` (L64). Add `|| process.platform !== "linux"` (XQuartz caveat) |
| perception.test.ts | P (L288 P or S) | P | L288 "uses the same label lists as the sidecar" runs `python3` importing `ember_atspi` with a stub pyatspi. darwin has python3, so P. win32 probably S (the `python3` App Execution Alias stub exits 9009), or P if a real python3 is there (the module imports on Windows: `select`/`socket`/`subprocess` exist at import, and `select.poll` is only used inside functions). Consider gating to linux: it tests the Linux sidecar |
| policy.test.ts | **F** 1 | P | L59 "appends JSON lines with owner-only permissions...": `mode & 0o777 === 0o600`. Assert only off win32 |
| presenter.test.ts | P | P | pure |
| private-windows.test.ts | P | P | L19-36 use fakes; L40 and L83 Python suites behave as perception.test.ts:288 |
| revive.test.ts | P | P | mocked |
| safety.test.ts | P | P | `loadAdminPolicy(tmpfile)` skips the root-owner check (only applies to `ADMIN_POLICY_FILE`, admin.ts:14, 91-96). Note for the platform layer: on win32 `stat().uid` is always 0 and `mode & 0o022` is non-zero, so a real `/etc/ember/policy.json` (`C:\etc\...`) would always lock down |
| session-tools.test.ts | P | P | pure |
| settings.test.ts | **F** 1 | P | L94 "a change that can't be saved isn't applied in memory either": `chmod(dir, 0o500)` doesn't block writes on Windows, and `getuid` is undefined so the assertion runs. Gate off win32, or make the directory read-only with an ACL. Risk: atomic `rename` (settings.ts:359-366) can flake with EPERM under antivirus; consider a short retry loop on win32 |
| tasks.test.ts | **F** 1 | P | L193 "reaches an app's name and GenericName...": `listApps({XDG_DATA_DIRS: root})` splits on `:` (system.ts:326). Use `path.delimiter`, or gate (the `.desktop` catalog is Linux-only; system.md covers the win/mac catalogs) |
| ui-copy.test.ts | P | P | regexes over CSS/HTML use `\s*` (CRLF-safe) |
| ui-place.test.ts | P | P | mocked |
| voice-capture.test.ts | P | P | pure |
| voice-engine.test.ts | P | P | pure |
| voice-models.test.ts | P | P | fake downloader; the only model rewritten is a `kind: "file"` model (rename, no tar) |
| voice-service.test.ts | P | P | mocked utilityProcess |
| voice-speakers.test.ts | P | P | `spawn` injected; `parec` is Linux-only at run time (needs a platform alternative, but no test breaks) |
| voice-spoken.test.ts | P | P | pure |
| worker-scroll.test.ts | P | P | `workDir: "/tmp"` is only a string unless a session starts (`worker.ts:1090` would `mkdirSync("C:\\tmp")`, harmless on runners) |
| worker-tools.test.ts | P | P | as above |
| packages/bubble/src/bubble.test.ts, markdown.test.ts, characters/src/rig.test.ts, motion/src/motion.test.ts | P | P | pure |

**Totals:** win32 has 21 failing tests in 13 files: agent-misc 1, desk-agent 2, desk-live 2, desk 6, eval 3, fuses 1,
host 1, logger 1, packaging 1, policy 1, settings 1, tasks 1. Two more fail conditionally: desk L116 without symlink
rights, and packaging L175 if the tools are on PATH. darwin (arm64) has 5 failing tests in 4 files: agent-misc 1,
desk-agent 2, desk-live 1, desk 1.

### 3.3 New unit tests the port should add (run on Linux too)

- `layout.mjs`: per-target paths, renames, fuse file, keep/prune decisions (feed it fake `npm ls` output with Windows
  paths).
- `icon.mjs`: ICO header and entries (and ICNS if written in JS).
- Info.plist editor: keys from 2.4.3; the bundle id has no `_`.
- `runtime.ts`: `locateRuntime` for linux-x64, linuxmusl, win32-x64 (`.exe`) and darwin-arm64 (inject
  platform/arch/exists).
- The sidecar launcher: `{command,args,env}` per platform; darwin sets `ELECTRON_RUN_AS_NODE=1`; win32 uses the
  absolute `powershell.exe` and `-File` last.
- `sidecar/uia/*`: ASCII-only (or UTF-8 with BOM) check; no C# 6 tokens (a regex for `$"`, `?.`, `nameof(`, `=>` in
  member position). The real compile runs on Windows CI (4.2).
- The AX sidecar's pure logic, by injecting a fake AX layer.
- Transport tests for each new sidecar on its own OS, modelled on `perception-sidecar.test.ts`: restart after a kill,
  timeout, EPIPE, `remember_secrets` preamble, `EMBER_ATSPI_ID_BASE` honoured, UTF-8 round trip of non-ASCII window
  titles.

### 3.4 Integration tests

`vitest.config.ts:15-16`: with `EMBER_INTEGRATION` set, include `test/integration/**/*.test.ts` and run files serially.

| file | needs | gate (L) | win32/darwin today |
|---|---|---|---|
| action-link | DISPLAY, Python+GTK3, pyatspi, XTest | `skipIf(!available && !required)` (57); `required` = `EMBER_ATSPI_TEST=1` | S. **Never set `EMBER_ATSPI_TEST=1` there**: "required" forces the run and it fails |
| borrow-live | Xvfb (`sh -c "command -v Xvfb"`, 18-19) | `skipIf(!xvfb)` (59) | S (add a linux gate: XQuartz has Xvfb) |
| clipboard-handoff | Xvfb (15) | `skipIf(!xvfb)` (40) | S |
| conductor | real Copilot runtime + mock LLM | none (`expect(runtime.exists)` in `beforeAll`, L26) | **F until runtime.ts is fixed**; then portable. L320 (`lanIp` proxy test) listens on the LAN address; on Windows the firewall or routing may interfere, so allow `skipIf(win32)` at first. Use `rmSync(..., {maxRetries})`: the runtime may still hold files briefly on Windows |
| desk-robust | Xvfb/dbus, libX11, linux | `available` includes `platform==="linux"` (46) | S |
| desk | Xvfb, xauth, dbus-daemon, pyatspi | `skipIf(!available && EMBER_ATSPI_TEST !== "1")` (47); `DeskManager.available()` splits PATH on `:` | S |
| keybuffer-live | Xvfb (13-14) | (43) | S |
| overlay-shape-live | Xvfb (13-14) | (35) | S |
| perception-electron | DISPLAY + pyatspi | (104) | S. Its pattern (an Electron page with secret fields at scale 1 and 2) is the best **cross-platform bench** for UIA/AX |
| perception | DISPLAY + pyatspi | (25) | S |
| persona | runtime + mock LLM | none | **F until runtime.ts**; then portable |
| safety | DISPLAY + pyatspi | (52) | S |
| voice | speech models from `prepare.mjs` | `skipIf(!ready && EMBER_VOICE_TEST !== "1")` (21) | portable (sherpa WASM) once models are prepared (curl, tar: see 2.8) |
| worker-safety | runtime + mock LLM; "Runs anywhere" | none | **F until runtime.ts**; then portable |
| worker | DISPLAY + pyatspi | (54) | S |

**New platform integration tests** (gate on the OS and require them with an env var, mirroring `EMBER_ATSPI_TEST`):

- `test/integration/uia-sidecar.test.ts`: `describe.skipIf(process.platform !== "win32" && process.env.EMBER_UIA_TEST !== "1")`.
  Start `powershell.exe ... -File sidecar/uia/ember_uia.ps1` through the generalised sidecar class. Cover `status`
  (including LanguageMode), `list_windows`, `read_window` of a bench, the secret field withheld
  (`UseSystemPasswordChar` gives UIA `IsPassword`), `do_action` click, `set_text`, `read_element`, `at_point`,
  `list_options`/`select_option`, error objects, restart after `kill`, and first-start latency. Bench options: a
  WinForms/WPF window started from `test/fixtures/winforms_bench.ps1` (the gtk3_bench.py counterpart, logging events
  to `EMBER_BENCH_LOG`), Notepad, and the perception-electron Electron page (Chromium's UIA).
- `test/integration/ax-sidecar.test.ts`: darwin, `EMBER_AX_TEST`. Spawn `ax-sidecar.cjs` with `process.execPath`
  (vitest's node; koffi loads ApplicationServices). Bench: the Electron page, plus TextEdit (`open -a TextEdit`).
  `AXSecureTextField` must be withheld. Fail fast with a clear message if `AXIsProcessTrusted()` is false.
- `test/integration/platform-windows.test.ts` / `platform-darwin.test.ts`: the koffi backends (window list, focus,
  capture, pointer, SendInput/CGEvent), against a window the test opens.

### 3.5 Test tooling

- **`test/mock-llm/server.mjs`**: portable (Node `http` on `127.0.0.1:0`, L80). No change.
- **`test/unit/desk-agent-build.ts`**: portable, but used only by Linux tests.
- **`test/smoke/launch.mjs`**: see 4.3.

### 3.6 Eval (`eval/run.mjs`, `eval/src/*.ts`): Linux assumptions

`eval/run.mjs` (L10-21) builds `eval/src/main.ts` into `dist/eval/eval.cjs` and `desk-agent.cjs` beside it, then
spawns node. That is portable, but the suite is not:

- `main.ts`: `pickPython()` (L92; RHEL `platform-python`, else `python3`); `openX11(name)` as the live-display probe
  (L84-88); `process.getuid?.() ?? 0` (L85); `machine.os` from `/etc/os-release` and `display` from `DISPLAY` (L130).
- `exit.ts:52-63` `liveDesktopProblem`: `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `/run/user/<uid>/bus`,
  "GNOME on Xorg" in its text; `path.join` makes backslashes on win32 (3.2, eval.test.ts).
- `checks.ts`: `gsettings get` (L29-30, L69-77); `atspi` checks read the AT-SPI sidecar (L38-48).
- `schema.ts`: check kinds `atspi`/`gsettings`; setup `gsettings`; app kinds `fixture` (GTK benches), `editor`
  (gedit/mousepad/pluma/xed), `command`; `hands: "desk"` (Xvfb).
- `runner.ts`: `EDITORS` (L86); `which` splits PATH on `:` and tests X_OK (L88); `gsettings` set/restore (L89, 297,
  411); `AtspiSidecar(sidecar/atspi/ember_atspi.py)` (L197); `openX11`/`openXInput` when `DISPLAY` is set (L198-199);
  a GTK probe through Python (L238); `DeskManager` (L249, 340); fixture benches `gtk3_bench.py`/`gtk3_hostile.py`
  (L307); `GDK_BACKEND=x11` (L315, 320); screen bounds fixed at 1280x1024, matching CI's `xvfb-run -s "-screen 0 1280x1024x24"`
  (L347); guide clicks with X button numbers (L359); `focusWindow().wmClass` (L367); process-group kill `kill(-pid)`
  (L407; on win32 it falls back to `app.kill()`).
- `gates.ts`: the AT-SPI read gate needs `DISPLAY` plus gtk3_bench (L122-141); the mouse gates use two
  `openXInput()` connections (L144-197); the voice gates are portable (sherpa WASM, L199-281).
- Tasks (27): 16 use the GTK fixture, 3 the editor, 3 a command (Files, Firefox, Writer), 4 are gsettings-only
  (`settings-*`), 1 the desk. Checks: atspi 7, gsettings 4, file 5, the rest event/audit/answer.

**Verdict:** keep eval and both workflows' eval jobs Linux-only. On win32/darwin every task is skipped
(`unavailable()`: no GTK, `which` fails on Windows, no Xvfb), the safety gates are "not measured", and `computeExit`
(exit.ts) returns 1 ("no task could run on this machine", and blocking gates must pass). A later port needs:

- a cross-platform bench, i.e. an Electron page or a native WinForms/AppKit bench with the same event log;
- an `a11y` check kind in place of `atspi`, going through whichever sidecar the platform uses;
- a `setting` check abstraction (registry and SystemParametersInfo on Windows, `defaults` on macOS) in place of
  `gsettings`;
- a `which` based on `path.delimiter` and PATHEXT;
- a per-OS editor list (Notepad, TextEdit);
- screen bounds from the platform layer.

---

## 4. CI

### 4.1 Today

`ci.yml` runs on push to main, on pull requests, and on **`workflow_dispatch`** (L7), so new jobs can be tried on a
branch from the Actions tab. Concurrency: `ci-${{ github.ref }}`, cancel-in-progress. Jobs:

- **checks** (ubuntu-24.04): `npm ci` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (L31-32); lint, typecheck, unit tests,
  the Python sidecar self-test, speech models (cached), `npm run test:integration` with `EMBER_VOICE_TEST=1` (on a
  bare runner the X/AT-SPI suites skip), build, `build:lab`.
- **el8** (rockylinux:8 container): `rebuild-el8.sh --here`, the self-test on platform-python 3.6, the smoke test
  under `xvfb-run` as user `ci`, and the AT-SPI integration suites with `EMBER_ATSPI_TEST=1` under
  `dbus-run-session -- xvfb-run`.
- **package** (rockylinux:8): stage; `check-symvers`; RPM; AppImage; `dnf install`; setuid `chrome-sandbox`; fuses
  `--check`; NODE_OPTIONS ignored; `--inspect` refused; `%license` files; `ember doctor`; installed launch greps
  `window.home.shown`; artifacts.
- **eval** (rockylinux:8): `node eval/run.mjs` under `xvfb-run` plus a dbus session.

`nightly-eval.yml` targets a self-hosted RHEL 8.4 GNOME VM (`reset` plus `live` jobs). It stays as it is.

### 4.2 Proposed jobs (lint and typecheck stay only in `checks`)

Two jobs (clearer than a matrix with many `if:` lines). Pin action SHAs the same way as the existing jobs.

```yaml
  windows:
    name: Windows (unit tests, build, smoke, UIA sidecar, package)
    runs-on: windows-2022            # or windows-latest; Server 2022/2025 stand in for Windows 10/11 APIs
    timeout-minutes: 45
    defaults: { run: { shell: bash } }   # Git Bash: set -eo pipefail. pwsh fails a step only on the LAST native command's exit code
    steps:
      - run: git config --global core.autocrlf false      # plus .gitattributes eol=lf
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with: { persist-credentials: false }
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with: { node-version: 22, cache: npm }
      - run: npm install -g npm@11.6.2
      - run: npm ci                                     # Electron binary needed (no ELECTRON_SKIP_BINARY_DOWNLOAD)
      - run: npm test
      - run: npm run build
      - name: The UIA sidecar compiles under Windows PowerShell 5.1 (C# 5) and answers status
        shell: pwsh
        run: |
          & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `
            "Add-Type -Path sidecar/uia/EmberUia.cs -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase"
          if ($LASTEXITCODE) { exit $LASTEXITCODE }
      - name: Launch smoke test
        run: npm run test:smoke
      - name: Integration (real Copilot runtime with an offline model; UIA sidecar on real windows)
        run: npx vitest run test/integration/conductor.test.ts test/integration/persona.test.ts test/integration/worker-safety.test.ts test/integration/uia-sidecar.test.ts test/integration/platform-windows.test.ts
        env: { EMBER_INTEGRATION: "1", EMBER_UIA_TEST: "1" }
      - name: Stage, check and zip the app
        run: |
          node scripts/package/stage.mjs
          node scripts/package/fuses.mjs --check dist/package/ember/ember.exe
          ELECTRON_RUN_AS_NODE=1 dist/package/ember/ember.exe -e "process.exit(0)"
          ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--require=C:/nonexistent/ember-fuse-check.js dist/package/ember/ember.exe -e "process.exit(0)"
          set +e; dist/package/ember/ember.exe --inspect=127.0.0.1:9229 > inspect.log 2>&1; code=$?; set -e
          grep -q "doesn't start with debugging switches" inspect.log && [ "$code" = 2 ]
          node scripts/package/win.mjs                       # icon/version (if not done in stage), zip
      - name: The packaged Ember starts and shows its window
        run: node test/smoke/launch.mjs --exe dist/package/ember/ember.exe
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        continue-on-error: true
        with: { name: ember-windows, path: dist/package/*.zip, retention-days: 14 }

  macos:
    name: macOS (unit tests, build, smoke, AX sidecar, package)
    runs-on: macos-15                 # arm64; pin rather than macos-latest (the TCC.db schema changes between versions)
    timeout-minutes: 45
    steps:
      - checkout / setup-node / npm install -g npm@11.6.2 / npm ci   (as above)
      - run: npm test
      - run: npm run build
      - name: Accessibility and screen-capture permission on this runner (fails loudly if missing)
        run: node scripts/ci/mac-permissions.mjs   # koffi: AXIsProcessTrusted(), CGPreflightScreenCaptureAccess()
      - run: npm run test:smoke
      - name: Integration (Copilot runtime; AX sidecar)
        run: npx vitest run test/integration/conductor.test.ts test/integration/persona.test.ts test/integration/worker-safety.test.ts test/integration/ax-sidecar.test.ts test/integration/platform-darwin.test.ts
        env: { EMBER_INTEGRATION: "1", EMBER_AX_TEST: "1" }
      - name: Stage Ember.app, sign it ad hoc, check it
        run: |
          node scripts/package/stage.mjs
          app=dist/package/Ember.app
          node scripts/package/fuses.mjs --check "$app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
          codesign --verify --deep --strict --verbose=2 "$app"
          ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Ember" -e 'process.exit(0)'
          ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--require=/nonexistent/x.js "$app/Contents/MacOS/Ember" -e 'process.exit(0)'
          test -f "$app/Contents/Resources/app/dist/app/ax-sidecar.cjs"
          test -s "$app/Contents/Resources/THIRD_PARTY_NOTICES" && test -f "$app/Contents/Resources/LICENSES.chromium.html"
          /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist"
          node scripts/package/mac.mjs                       # ditto zip + hdiutil dmg (with retries)
      - run: node test/smoke/launch.mjs --exe "dist/package/Ember.app/Contents/MacOS/Ember"
      - uses: actions/upload-artifact@...   with: { name: ember-macos, path: "dist/package/*.zip\ndist/package/*.dmg" }
```

Notes on the jobs:

- **Speech models:** the voice integration suite can join either job once `prepare.mjs` works there. Cache `.cache/voice`
  with the same key as checks. On Windows force System32 `tar` (2.8). Otherwise leave voice to Linux.
- **Electron download cache (optional):** `~/Library/Caches/electron` on macOS, `%LOCALAPPDATA%\electron\Cache` on
  Windows.
- **Windows shell:** the default on Windows runners is `pwsh`, and GitHub's pwsh wrapper checks only `$LASTEXITCODE`
  of the **last** native command in a step. Hence `shell: bash` (Git Bash) for multi-command steps. Call
  `powershell.exe` (5.1) explicitly for the sidecar, never `pwsh`, which is .NET (Core) and has a different `Add-Type`
  compiler.
- **Interactive desktop:** UIA, SendInput and screen capture need a desktop session. Hosted Windows runners are
  believed to run the agent in an auto-logged-on interactive session at 1024x768 (**verify** with a probe step:
  `GetForegroundWindow`/`EnumWindows` count, and a UIA `RootElement` child count). Do not hard-code 1280x1024 in new
  tests.
- **macOS TCC on runners:** GitHub's macOS images have SIP off and pre-grant TCC (Accessibility, and on some images
  ScreenCapture) to the runner's provisioner. Processes started by the runner inherit that grant through the
  "responsible process" rule, which is why AppleScript and UI tests work there (**verify** on the pinned image). If
  the probe fails, insert grants with
  `sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceAccessibility', '<client>', 1, 2, 4, 1)"`.
  The column set differs between macOS versions, which is another reason to pin the image. Mark the AX/platform
  steps `continue-on-error: true` until they are stable.
- **Cost:** macOS minutes are expensive on private repositories. The jobs can run on PRs that touch `app/**`,
  `sidecar/**`, `scripts/**`, `test/**` and on `main`, and always on `workflow_dispatch`.
- `fail-fast` does not apply (separate jobs). Each job keeps the repository's `timeout-minutes` style.
- `checks` keeps lint and typecheck (they are platform-independent) and runs `npm test` on Linux. The new unit tests
  for layout, icon and plist run there too.

### 4.3 `test/smoke/launch.mjs` changes

Today (65 lines): it resolves the Electron path (L10), makes a temporary `EMBER_USER_DATA` (L12), adds `--no-sandbox`
only as root or with `EMBER_SMOKE_NO_SANDBOX=1` (L14), and sets `EMBER_LOG_STDOUT=1` (L15). It spawns `electron <root>`
with piped stdio (L18) and parses JSON log lines for `msg`. It waits 30 s for `window.home.shown` (L45; logged at
`main.ts:253` on the home window's `ready-to-show`). A second launch must exit 0 having logged `instance.handover`
(main.ts:104-106), and the first must log `instance.second` within 10 s (main.ts:280-283). Cleanup: `first.child.kill()`
(SIGTERM) and `rmSync(userData, { maxRetries: 5, retryDelay: 200 })` (L58-63). The mechanism is portable;
`process.getuid?.()` is guarded.

Changes:

1. **`--exe <path>`** (or `EMBER_SMOKE_EXE`): launch a packaged binary with no app-path argument (`ember.exe`,
   `Ember.app/Contents/MacOS/Ember`, `/opt/ember/ember`). CI's packaged checks can then share it: the Linux package
   job's `timeout 25 ember ... grep window.home.shown` and the new win/mac steps.
2. **Windows teardown:** `child.kill()` is TerminateProcess on the main process only. GPU, renderer and utility
   children (the voice utility process, the UIA PowerShell sidecar) can outlive it for a moment and hold files in
   `userData` (Chromium's `Local State`, the GPU cache, `logs/ember.log`), so `rmSync` hits EBUSY/EPERM. Kill the tree
   (`spawnSync("taskkill", ["/pid", pid, "/T", "/F"])`), better yet quit gracefully first (a third launch with a
   `--quit` switch handled in `second-instance`, if main.ts gains one). Then retry cleanup (`maxRetries: 20,
   retryDelay: 250`) and **never fail the smoke test on cleanup alone**.
3. **Timeouts:** 30 s for the first window is tight for a cold start on Windows (Defender scanning `electron.exe` and
   the Copilot runtime). Use `EMBER_SMOKE_TIMEOUT_MS`, defaulting to 60 s on win32/darwin.
4. **Fail fast and say why:** if `app.start_failed` or `uncaught exception` appears, fail at once with that line.
   Print the collected stderr on failure, not only with `EMBER_SMOKE_VERBOSE` (L29).
5. **Platform assertions** (optional, valuable): require a log line naming the chosen backends (for example
   `platform.ready {windowSystem:"win32", sidecar:"uia"}`) and **no** `sidecar.error`. That catches "it started but
   loaded the Linux backend".
6. Update the header comment (L1-2): "Linux needs an X display (`xvfb-run -a`). Windows and macOS need a logged-in
   desktop session."
7. Leave the sandbox flags alone: no `--no-sandbox` on win32/darwin. `getuid` doesn't exist on win32, and macOS
   runners aren't root.

### 4.4 Packaged-app verification, per OS

| check | Linux (today, package job) | Windows | macOS |
|---|---|---|---|
| fuses | `fuses.mjs --check /opt/ember/ember` | `--check dist/package/ember/ember.exe` | `--check ".../Electron Framework.framework/Electron Framework"` |
| RunAsNode works | `ELECTRON_RUN_AS_NODE=1 /opt/ember/ember -e ...` | same with `ember.exe` | same with `Contents/MacOS/Ember` |
| NODE_OPTIONS ignored | yes | yes | yes |
| `--inspect` refused | `grep "doesn't start with debugging switches"` | same, plus exit code 2 | same |
| sidecar shipped | `desk-agent.cjs` present | `resources/sidecar/uia/*` present | `Contents/Resources/app/dist/app/ax-sidecar.cjs` present |
| notices | `%license`, THIRD_PARTY_NOTICES | THIRD_PARTY_NOTICES, LICENSES.chromium.html at the root | both inside `Contents/Resources` |
| signature | n/a | (later) `signtool verify /pa` | `codesign --verify --deep --strict` |
| launch | `window.home.shown` | `launch.mjs --exe` | `launch.mjs --exe` |
| doctor | `ember doctor` (+ headless) | `ember.exe --doctor > report.txt` | `Ember --doctor` |

### 4.5 nightly-eval.yml

No change: the self-hosted RHEL 8.4 GNOME VM. Windows and macOS live evaluation needs a portable task suite first
(3.6).

---

## 5. Risks and surprises (most important first)

1. **runtime.ts linux-x64 hard-coding** silently breaks Copilot on both new OSes, together with 1 unit test and
   3 integration suites (0.1).
2. **stage.mjs**: `npm.cmd` EINVAL on Windows; it copies only `Contents/MacOS` of `Electron.app`; fuses in the wrong
   file on macOS; Chromium licences left outside the `.app` (2.2).
3. **The macOS fuse flip invalidates the signature**: re-sign ad hoc afterwards or arm64 kills the app. Universal
   builds are refused by `findWire`.
4. **The sidecar spawn shape** (`spawn(python, [script])`) has no room for PowerShell flags or
   `ELECTRON_RUN_AS_NODE`. Forgetting the latter on macOS launches a second Ember, which hands over to the first
   through the single-instance lock: a confusing failure.
5. **PowerShell 5.1 encodings and C# 5.** A non-ASCII secret word in a BOM-less `.cs` file becomes mojibake, and secret
   fields then go unrecognised, which is a privacy failure, not a crash. Add the ASCII test and pass the lists at run
   time.
6. **First-request timeout on Windows** while `Add-Type` compiles leads to a kill/restart loop. Cache the assembly.
7. **TCC identity churn** with ad hoc signing; Gatekeeper's "Open Anyway" on macOS 15.
8. **The Windows licence gap**: sharp-win32 bundles libvips without a sharp-libvips package, so the existing check
   would not look at its libraries (2.7).
9. **`npm run test:integration` uses POSIX env syntax** and fails in cmd.exe.
10. **CRLF checkouts** on Windows runners break any explicit-`\n` file parsing (`packaging.test.ts:157`) and all
    shell scripts.
11. **pwsh step semantics** in GitHub Actions (only the last exit code counts), and pwsh is not PowerShell 5.1.
12. **Windows teardown and file locks**: smoke-test cleanup, `SettingsStore` renames, integration temp dirs.
13. **HOME/TMPDIR test overrides** don't move `os.homedir()`/`os.tmpdir()` on Windows (desk.test.ts:168). Watch for
    the same pattern in new tests.
14. **XQuartz Macs** set `DISPLAY` and have `Xvfb`, so the X tests gated only on those would run and fail. Add
    platform gates.
15. **`ember doctor` output** from a GUI-subsystem `ember.exe` doesn't reach an interactive console.
16. **The admin policy on Windows** (`/etc/ember/policy.json`, `uid === 0` check) would always lock down if the file
    existed. Platform layer (system.md).
17. **Eval cannot measure the safety gates** on win/mac. Keep it Linux-only rather than letting it fail.

## 6. Suggested order of work

1. `.gitattributes`; `test/platform.ts` gates; fix or gate the 21/5 failing unit tests (3.2). Add the Windows and
   macOS CI jobs with only `npm ci && npm test && npm run build`, so later steps land on a green baseline.
2. runtime.ts per platform, which unblocks conductor/persona/worker-safety on both OSes. Make `test:integration`
   portable.
3. Generalise the sidecar launcher; add `ax-sidecar.cjs` to build-app.mjs; add the `sidecar/uia` sources and the ASCII
   and C# 5 checks.
4. `layout.mjs`, then stage.mjs fixes 1-12, `icon.mjs` ICO/ICNS, the licences widening. Then `win.mjs` (resedit,
   fuses, zip) and `mac.mjs` (plist, helpers, icns, fuses, codesign, ditto, hdiutil).
5. Smoke-test changes; packaged-app checks in CI (4.4).
6. Platform integration suites (UIA/AX/backends) with permission probes; drop `continue-on-error` once stable.
7. Later: Authenticode and Developer ID signing, notarisation, NSIS, universal macOS builds (needs the `findWire`
   change), and a cross-platform eval bench.
