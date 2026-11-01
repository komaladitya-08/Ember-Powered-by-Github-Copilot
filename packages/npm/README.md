# ember-copilot

Install [Ember](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot), the cursor-companion agent powered
by the GitHub Copilot SDK, from npm.

> **Beta, unsigned.** The Windows build has no code-signing certificate (SmartScreen may warn the first time), the
> macOS builds are only ad-hoc signed (not notarized), and the Linux build is an AppImage. Use it if you're comfortable
> running a beta.

This package is a small launcher with no dependencies. The first time you run it, it downloads the Ember release with
the same version as the package from
[GitHub Releases](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases), checks the file against
the release's `SHA256SUMS`, unpacks it into a cache folder in your user account, and starts it. After that it starts
the cached copy straight away.

## Install

```bash
npm i -g ember-copilot
ember            # or: ember-copilot
```

Or run it without installing:

```bash
npx ember-copilot
```

Needs Node.js 18.17 or later. Any arguments are passed on to Ember (for example `ember --doctor`).

## What gets downloaded

| Platform | Release file | Cache folder |
| --- | --- | --- |
| Windows x64 | `Ember-<v>-win-x64.zip` (unpacked with `tar.exe`, or `Expand-Archive`) | `%LOCALAPPDATA%\ember-npm\<v>` |
| macOS Apple silicon | `Ember-<v>-mac-arm64.zip` (unpacked with `ditto`, quarantine flag removed) | `~/Library/Caches/ember-npm/<v>` |
| macOS Intel | `Ember-<v>-mac-x64.zip` | `~/Library/Caches/ember-npm/<v>` |
| Linux x64 | `Ember-<v>-x86_64.AppImage` (made executable) | `$XDG_CACHE_HOME/ember-npm/<v>` (default `~/.cache`) |

If the download doesn't match `SHA256SUMS`, nothing is installed. On macOS Ember is started with `open`, so macOS asks
for Accessibility and Screen Recording permissions for Ember itself. On Linux the AppImage needs FUSE 2 (`libfuse2`);
without it, run `APPIMAGE_EXTRACT_AND_RUN=1 ember`. Linux packages (RPMs for EL8) are on the Releases page too.

## Launcher options

| Option | |
| --- | --- |
| `--npm-install-only` | download and check Ember if needed, print the program's path, and exit |
| `--npm-reinstall` | download it again even if it is cached |
| `--npm-where` | print this version's cache folder |
| `--npm-help` | list these options |

Environment: `EMBER_NPM_CACHE` moves the cache folder, `EMBER_NPM_DOWNLOAD_BASE` points at a mirror of
`https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases/download`, `EMBER_NPM_QUIET=1` hides the
progress messages.

## Uninstall

```bash
npm rm -g ember-copilot
```

and delete the cache folder above (`ember --npm-where` prints it).

## License

MIT
