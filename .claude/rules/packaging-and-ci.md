---
paths:
  - "scripts/**"
  - "packaging/**"
  - ".github/**"
  - "package.json"
  - "package-lock.json"
  - "assets/fonts/**"
  - "app/voice/models.ts"
  - "packages/npm/**"
  - "CHANGELOG.md"
---

# Packaging, CI and dependencies

Ember ships as an RPM and an AppImage built on EL8, whose every binary must run on RHEL 8.4's glibc 2.28; as a Windows zip; and as a macOS zip and dmg. CI publishes them to GitHub Releases from a `v*` tag, and the `ember-copilot` npm launcher (`packages/npm`) downloads and starts them.

## Building packages

- **Where packages are built.** Each target is staged on its own OS, from that machine's `npm ci`; cross-staging isn't supported. `scripts/package/layout.mjs` says what each target holds, and every `package*` script runs build, remote-parts.mjs and stage.mjs first:
  - Linux: `npm run package` (then rpm.sh and appimage.sh) or `npm run package:rpm`, only on EL8 or in `rockylinux:8`, as CI's `package` job does;
  - Windows: `npm run package:win` (archive.mjs zips `Ember\Ember.exe`), on Windows;
  - macOS: `npm run package:mac` (`Ember.app`, signed ad hoc, as a zip and a dmg), on a Mac of the target's architecture.
- **System dependencies (RPM).** Automatic dependency detection is off (`AutoReqProv: no`), so add each one to packaging/rpm/ember.spec yourself: `Requires:` when Ember needs it, `Recommends:` when it's optional. Load a library the RPM doesn't require with a guarded `koffi.load` and a fallback, as the local `optional()` in app/main/hands/input.ts does.
- **Native code.** Many npm prebuilds won't load on RHEL 8 (sherpa-onnx's native addon needs glibc 2.32, so voice uses its WebAssembly build on every OS).
  - Prefer koffi FFI or WASM over native addons (`ember.nativeModules` is `[]`).
  - If a native addon is unavoidable, list it there, run `npm run rebuild:el8`, and pass `scripts/check-symvers.sh`. The limits are at most GLIBC_2.28, GLIBCXX_3.4.25 and CXXABI_1.3.11 (docs/DEVELOPING.md §6).
  - A package published once per platform goes in `PLATFORM_FAMILIES` in layout.mjs, so each target ships only its own build. Windows and macOS have no glibc gate.
- **Fuses.** Don't weaken the debug lockdown or `EMBER_FUSES`. Change them only together with scripts/package/fuses.mjs, its test and the CI check. RunAsNode stays off on macOS (Ember.app never runs as plain Node) and on for Linux's and Windows' helpers; PLAN.md §2 "Node mode" says why. When you change an export of a `scripts/package/*.mjs` module, update the `.d.mts` file beside it.

## Licences

- **Before adding a production dependency,** check that its licence, and the licence of anything it bundles, is in the spec's first `License:` tag, and update the comment above that tag. Add any library that sharp-libvips bundles to `BUNDLED_LIBRARIES` in scripts/package/licences.mjs. Otherwise stage.mjs refuses to stage.
- **Bundled assets.** Every one ships with its licence. stage.mjs builds `THIRD_PARTY_NOTICES`. A new font or asset needs:
  - its licence file;
  - a notices section;
  - its SPDX id in `License:`;
  - a test.
- **The font pipeline.** Keep it intact:
  - `assets/fonts/InterVariable.woff2` with `LICENSE.txt` (OFL-1.1);
  - build-app.mjs copies it to `renderer/fonts/`;
  - stage.mjs checks it;
  - `OFL-1.1` stays in `License:`.
- **Speech models.** Pin each one in app/voice/models.ts with its URL, SHA-256 and licence. The download is checked against the hash before use.

## Releases and the npm launcher

- **Publishing.** A release is a `v<v>` tag on `main` whose version matches package.json's and has a `## <v> (<date>)` section in CHANGELOG.md, which becomes its notes. The tag runs all of ci.yml; its `release` job (the only one with write access) checks the eight files with `scripts/package/release.mjs`, writes `SHA256SUMS` and creates the release (docs/DEVELOPING.md §15). When you rename a package file, change release.mjs, README.md's download section and the launcher together.
- **The launcher.** `packages/npm` has no dependencies and runs on Node 18.17 or later. Bump its `version` with the app's (npm-launcher.test.ts checks they match). `.github/workflows/npm.yml` publishes it after the tag's ci run passes, and skips rather than fails without credentials.

## Dependencies and CI

- **Version pins.** Pin dependency versions exactly, with no `^` or `~`.
- **Actions.** Pin GitHub Actions to full commit SHAs, with the tag in a trailing comment. Keep `permissions: contents: read` at the top of every workflow, widen it only in the one job that needs it (ci.yml's `release`, npm.yml's publish), and keep `persist-credentials: false`.
- **Workflows.** ci.yml runs the Linux, Windows and macOS jobs (docs/DEVELOPING.md §13); remote.yml runs the commands, WSL and SSH suites. When a file remote.yml's suites load, run or read is new, add a pattern to both of its `paths` lists (remote-workflow.test.ts checks).
- **Downloads.** Pin downloaded tools and models by SHA-256, and check the hash before use.
- **Scripts.** Start each script with a comment that says what it does; command-line scripts add a `usage:` line. Bash scripts use `set -euo pipefail`, except check-symvers.sh, which keeps to `set -u` so it can report every failing binary.
- **New integration tests.** CI's `checks` job runs every integration file, but it has no AT-SPI, no Windows or macOS desktop, sshd or WSL. Add each new AT-SPI file, and each X11 file that must run on rockylinux:8, to the `el8` job's list in ci.yml and to docs/DEVELOPING.md §5; a Windows or macOS suite to its job in ci.yml (§10.3, §11.3); a commands, WSL or SSH suite to its remote.yml job (§14.4). Otherwise it silently skips.
- **Test gates.** A suite skips without what it needs and fails when its variable is 1 and that is missing: `describe.skipIf(!available && !required)`, where `required = process.env.EMBER_ATSPI_TEST === "1"` for AT-SPI. Voice suites use `EMBER_VOICE_TEST`, the other OSes and targets their own variables (`EMBER_DARWIN_TEST`, `EMBER_SSH_TEST`, `EMBER_WSL_TEST`, `EMBER_COMMANDS_TEST`…), and X11-only suites use `describe.skipIf(!xvfb)`.
- **Package tests that read source text.**
  - Unit tests match `path.join(root, "assets/fonts/LICENSE.txt")` in stage.mjs and the font copy in build-app.mjs.
  - In the spec they match:
    - the `%attr(4755, root, root) /opt/ember/chrome-sandbox` line;
    - `AutoReqProv: no` and the `Requires:`/`Recommends:` packages;
    - `%{_datadir}/ember/voice-models`, and the `sed` expression that tags licence files with `%%license`;
    - the `chmod -R u=rwX,go=rX %{buildroot}/opt/ember` line in `%install`;
    - the `License:` ids.
  - packaging.test.ts also cuts the AppRun script out of appimage.sh by its `<<'RUN'` heredoc.

  Change a test together with its line.
