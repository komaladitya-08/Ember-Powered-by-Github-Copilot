# Package packaging: per-target staging, Windows zip, macOS app bundle, CI jobs for Windows and macOS

Worktree: /home/user/wt/packaging (branch port/packaging).
Specs to read: build-test-ci.md (primary), gaps.md (G11, packaging items), decisions.md D3, D8, D10.

## You own (and touch nothing else)
- scripts/package/** (stage.mjs, fuses.mjs, licences.mjs, icon.mjs, rpm.sh, appimage.sh, and new files: layout.mjs +
  layout.d.mts, mac-bundle.mjs, zip helpers, etc.)
- packaging/** (new: packaging/macos/Info.plist additions or a plist template, anything Windows needs)
- test/smoke/launch.mjs
- test/unit/packaging.test.ts, test/unit/fuses.test.ts, test/unit/licences.test.ts, new test/unit/layout.test.ts
- .github/workflows/ci.yml
- .gitattributes (new: `* text=auto eol=lf`, binaries marked binary)
- package.json — the "scripts" section ONLY (e.g. a portable test:integration via a new scripts/run-integration.mjs which
  you also own, package:win / package:mac)
- scripts/run-integration.mjs (new)
Do not touch app/** (the app's runtime-path fix, sidecar launch and build entries come in another phase).

## Build
1. `scripts/package/layout.mjs` (pure, side-effect free, + `.d.mts`): `layoutFor(platform, arch)` for linux-x64 (today's
   layout, unchanged), win32-x64, win32-arm64, darwin-arm64, darwin-x64: app folder name, executable name, resources path,
   the binary whose fuses are flipped (Linux: the main binary; macOS: `Contents/Frameworks/Electron Framework.framework/
   Electron Framework`; Windows: Ember.exe), renames (electron → ember on Linux, electron.exe → Ember.exe on Windows,
   Electron.app → Ember.app on macOS — keep the inner executable and helper app names), which node_modules platform
   packages to keep (@github/copilot-sdk-<plat>-<arch>, @img/sharp-<plat>-<arch>, @img/sharp-libvips-<plat>-<arch>,
   @koromix/koffi-<plat>-<arch>) and prune (every other platform's), sidecar files to ship (Linux: sidecar/atspi/**;
   Windows: sidecar/uia/ember_uia.ps1 + ember_uia.cs; macOS: none besides dist/app/ax-sidecar.cjs), required dist files
   (dist/app/main.cjs, preload/*, renderer/**, desk-agent.cjs on Linux only, ax-sidecar.cjs on Windows and macOS).
   Unit-test it thoroughly on Linux (test/unit/layout.test.ts).
2. stage.mjs works per target on its own OS (process.platform/process.arch by default): use the layout; spawn npm
   portably (on Windows `npm.cmd` needs a shell or `process.execPath` + npm-cli.js — choose the robust way); on macOS copy
   the whole Electron.app (not just Contents/MacOS); no `du` dependency; keep the Linux path byte-for-byte equivalent in
   behaviour (the RPM/AppImage CI job and the tests that read stage.mjs's source text must keep passing — update those
   tests together with the text they match). Electron's licence files go inside the app folder on every target.
   Tolerate files that do not exist yet in this branch (dist/app/ax-sidecar.cjs, sidecar/uia/*) only behind an explicit
   `--allow-missing-sidecar` flag that CI does NOT use once they exist; by default stage fails closed on a missing file.
   Hmm — CI in this branch can't have them yet: make CI pass `--allow-missing-sidecar` for now with a TODO comment naming
   the later phase, so the lead can drop it.
3. fuses.mjs: support the macOS framework binary and refuse universal binaries clearly, keep every current fuse decision
   (RunAsNode stays ON: the macOS/Windows accessibility host runs as Ember's own binary in node mode, like desk-agent);
   after flipping fuses on macOS the bundle must be re-signed ad hoc (`codesign --force --deep --sign - Ember.app`), done
   by stage or a mac-bundle step. Update the .d.mts beside any changed export.
4. macOS bundle: Info.plist edits with `plutil` (or a careful XML edit): CFBundleName/CFBundleDisplayName "Ember",
   CFBundleIdentifier "io.github.komaladitya08.ember", NSMicrophoneUsageDescription ("Ember listens for “Hey Ember” on this
   Mac only when you turn it on. Audio never leaves your Mac."), NSAppleEventsUsageDescription (for changing appearance
   settings when you ask), LSApplicationCategoryType public.app-category.productivity, NSHighResolutionCapable true,
   LSMinimumSystemVersion 13.0, and the app icon (icon.mjs can produce an .icns via `iconutil` on macOS from the existing
   SVG/PNG pipeline, or skip the icon with a TODO if it needs new tooling). Outputs: dist/package/Ember-<v>-mac-<arch>.zip
   (ditto -c -k --keepParent) and .dmg (hdiutil create -volname Ember -srcfolder … -ov -format UDZO).
5. Windows: dist/package/Ember-<v>-win-<arch>.zip of the staged folder (PowerShell Compress-Archive or a Node zip writer
   with no new dependency — prefer `tar.exe -a -c -f x.zip` which ships with Windows 10+), plus an exe icon only if it can be
   done without a new dependency (otherwise TODO).
6. licences.mjs: widen the sharp bundled-libvips check so @img/sharp-win32-* (which bundles libvips itself) is inspected;
   keep the staging refusal when a licence is missing.
7. test/smoke/launch.mjs portable: `--exe <path>` for packaged binaries; on Windows kill the whole process tree
   (taskkill /T /F); no xvfb on Windows/macOS; timeouts up to 60 s; fail fast on an "app.start_failed" log line; cleanup
   retries and never fails the test; keep the Linux behaviour (CI's el8 job runs it under xvfb-run).
8. CI (.github/workflows/ci.yml): keep every existing job unchanged in behaviour. Add `windows` (runs-on windows-2022,
   timeout 30) and `macos` (runs-on macos-15, timeout 30 — keep it lean, private repo minutes are 10x) jobs:
   checkout (persist-credentials false) → setup-node 22 (cache npm) → npm install -g npm@11.6.2 → npm ci → npm test →
   npm run build → smoke test → stage + package (with --allow-missing-sidecar for now) → packaged-app checks (fuses check
   via `node scripts/package/fuses.mjs --check <fuse binary>`, ELECTRON_RUN_AS_NODE works, NODE_OPTIONS ignored, --inspect
   refused, macOS `codesign --verify --deep --strict`, the packaged app launches via smoke --exe) → upload artifacts
   (retention 14). Integration steps: Windows `EMBER_WIN32_TEST=1 EMBER_UIA_TEST=1 node scripts/run-integration.mjs
   test/integration/win32-desktop.test.ts test/integration/uia-bridge.test.ts test/integration/ax-sidecar.test.ts`
   (files from other packages; vitest must pass when a listed file is absent: use --passWithNoTests or filter existing
   files in run-integration.mjs); Windows C# compile check: `powershell.exe -NoProfile -Command "Add-Type -Path
   sidecar/uia/ember_uia.cs -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase,System.Web.Extensions"`
   when the file exists (Windows PowerShell 5.1, not pwsh; a failing compile fails the job). macOS: grant TCC per
   decisions.md D10 (Accessibility + ScreenCapture for every candidate binary) before `EMBER_DARWIN_TEST=1 EMBER_AX_TEST=1
   node scripts/run-integration.mjs test/integration/darwin-desktop.test.ts test/integration/ax-sidecar.test.ts`.
   Use `shell: bash` where the steps are POSIX-y (Git Bash exists on windows-2022) and set `defaults.run.shell` sensibly;
   remember pwsh only checks the last command's exit code. Pin every action to the same full SHAs the file already uses.
   Keep `permissions: contents: read`. Validate the YAML (actionlint is configured: .github/actionlint.yaml; run it if you
   can install it without changing the repo, else at least parse the YAML with node).
9. Everything Linux-only (rpm.sh, appimage.sh, check-symvers, rebuild-el8) stays as it is; stage.mjs's Linux output must
   be identical. Run the packaging/fuses/licences/layout unit tests and `node scripts/package/stage.mjs` on Linux if it can
   run here (it needs `npm run build` first; if it can't run here, say why).
