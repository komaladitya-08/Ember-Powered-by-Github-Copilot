---
paths:
  - "scripts/**"
  - "packaging/**"
  - ".github/**"
  - "package.json"
  - "package-lock.json"
  - "assets/fonts/**"
  - "app/voice/models.ts"
---

# Packaging, CI and dependencies

Ember ships as an RPM and an AppImage built on EL8, and every binary in them must run on RHEL 8.4's glibc 2.28.

## Building packages

- **Where packages are built.** Build them with `npm run package` (build, then stage.mjs, rpm.sh and appimage.sh), or `npm run package:rpm` for the RPM alone. Build only on EL8 or in `rockylinux:8`, as CI's `package` job does.
- **System dependencies.** Automatic dependency detection is off (`AutoReqProv: no`), so add each one to packaging/rpm/ember.spec yourself: `Requires:` when Ember needs it, `Recommends:` when it's optional. Load a library the RPM doesn't require with a guarded `koffi.load` and a fallback, as the local `optional()` in app/main/hands/input.ts does.
- **Native code.**
  - Prefer koffi FFI, WASM or prebuilt binaries over native addons (`ember.nativeModules` is `[]`).
  - If a native addon is unavoidable, list it there, run `npm run rebuild:el8`, and pass `scripts/check-symvers.sh`. The limits are at most GLIBC_2.28, GLIBCXX_3.4.25 and CXXABI_1.3.11.
- **Fuses.** Don't weaken the debug lockdown or `EMBER_FUSES`. Change them only together with scripts/package/fuses.mjs, its test and the CI check. When you change an export of fuses.mjs or licences.mjs, update the `.d.mts` file beside it.

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

## Dependencies and CI

- **Version pins.** Pin dependency versions exactly, with no `^` or `~`.
- **Actions.** Pin GitHub Actions to full commit SHAs, with the tag in a trailing comment. Keep `permissions: contents: read` and `persist-credentials: false`.
- **Downloads.** Pin downloaded tools and models by SHA-256, and check the hash before use.
- **Scripts.** Start each script with a comment that says what it does; command-line scripts add a `usage:` line. Bash scripts use `set -euo pipefail`, except check-symvers.sh, which keeps to `set -u` so it can report every failing binary.
- **New integration tests.** CI's `checks` job runs every integration file, but it has no AT-SPI. Add each new AT-SPI file, and each X11 file that must run on rockylinux:8, to the `el8` job's list in ci.yml and to docs/DEVELOPING.md §5. Otherwise it silently skips.
- **Test gates.** Gate an AT-SPI suite with `describe.skipIf(!available && !required)`, where `required = process.env.EMBER_ATSPI_TEST === "1"`. Voice suites use `EMBER_VOICE_TEST`, and X11-only suites use `describe.skipIf(!xvfb)`.
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
