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

The launcher is published from Ember 0.1.1 on (Ember 0.1.0 has none), each version after its Ember release is out.
If the release for its version isn't there, for example on a mirror that hasn't caught up, it says "Ember <v> isn't
on GitHub Releases yet" (or names the mirror) and starts nothing.

## Install

```bash
npm i -g ember-copilot
ember            # or: ember-copilot
```

Or run it without installing:

```bash
npx ember-copilot
```

Needs Node.js 18.17 or later. Any arguments are passed on to Ember. `ember doctor` (or `ember --doctor`) runs Ember's
setup check in the terminal: it prints the report and exits with the check's code (on a Mac through `open`, so macOS
judges Ember's own permissions). A plain `ember` starts Ember and returns after a few seconds; if Ember stops in that
time (no display, for example), the launcher prints what it said and exits with its code instead of saying it started.
What Ember prints after that goes to `.<v>-start.log` beside the version folder (a disk too full to write in it
doesn't stop Ember starting; one too full to make the file is said as such). On Linux without a display (an ssh
session without `-X`, a text console), it says to start `ember` inside your desktop session or to run `ember doctor`,
and downloads nothing. `ember --help` lists what Ember takes, and the launcher's own options.

## What gets downloaded

| Platform | Release file | Cache folder |
| --- | --- | --- |
| Windows x64 | `Ember-<v>-win-x64.zip` (unpacked with `tar.exe`, or `Expand-Archive`) | `%LOCALAPPDATA%\ember-npm\<v>` |
| macOS Apple silicon | `Ember-<v>-mac-arm64.zip` (unpacked with `ditto`, quarantine flag removed) | `~/Library/Caches/ember-npm/<v>` |
| macOS Intel | `Ember-<v>-mac-x64.zip` | `~/Library/Caches/ember-npm/<v>` |
| Linux x64 | `Ember-<v>-x86_64.AppImage` (made executable) | `$XDG_CACHE_HOME/ember-npm/<v>` (default `~/.cache`) |

If the download doesn't match `SHA256SUMS`, or `SHA256SUMS` has no line for it, nothing is installed, and the
launcher says what to do next (run `ember` again, or download the file in your browser). On macOS Ember is started with `open`, so macOS asks
for Accessibility and Screen Recording permissions for Ember itself. Its setup check warns that Ember isn't in the
Applications folder, as the cache isn't: its **Move to Applications** takes Ember out of the cache (the next `ember`
downloads it again), so for permissions that last across updates install the dmg from the Releases page instead. On Linux the AppImage needs `fusermount` (on RHEL 8
and its family, `sudo dnf install fuse`); without it, run `APPIMAGE_EXTRACT_AND_RUN=1 ember`. The RPM for EL8 is on the Releases page too.

## Launcher options

| Option | |
| --- | --- |
| `--npm-install-only` | download and check Ember if needed, print the program's path, and exit |
| `--npm-reinstall` | download it again even if it is cached |
| `--npm-where` | print this version's cache folder |
| `--npm-help` | list these options, and Ember's (also `--help` and `-h`) |

Environment: `EMBER_NPM_CACHE` moves the cache folder, `EMBER_NPM_DOWNLOAD_BASE` points at a mirror of
`https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases/download`, `EMBER_NPM_QUIET=1` hides the
progress messages.

## Proxies and offline computers

The download goes through the proxy npm itself uses: npm's `https-proxy` or `proxy` setting (from `npm config set`,
your `.npmrc` or npm's global `npmrc`), otherwise `HTTPS_PROXY` (`HTTP_PROXY` for an `http://` mirror), in upper or
lower case. Hosts in `NO_PROXY` (or npm's `noproxy`) are reached directly: names, `.example.com` for a domain,
addresses and IPv4 ranges such as `10.0.0.0/8`, each with an optional `:port`. A user name and password go in the
proxy's address (`http://name:password@proxy.example.com:8080`); the launcher never prints them. Behind a proxy that
inspects HTTPS, set `NODE_EXTRA_CA_CERTS` to your organisation's certificate file, as for any Node program.

When the download can't be reached, or a proxy or server answers with an error, the launcher says why in one sentence
(for example "Ember couldn't reach GitHub Releases through the proxy at proxy.example.com:8080: the proxy asked for a
user name and password (407).") and what to do: fix the proxy setting, ask for the host it names to be allowed when a
proxy blocks it (after GitHub's redirect, that is its storage host), run `ember` again later when the server itself
fails (an error answer inside an HTTPS proxy's tunnel is the server's, not the proxy's, except that a proxy that
inspects HTTPS sends its own "Bad Gateway" or "Gateway Timeout" there too, so for those two it names both and says to
ask whoever runs the proxy if it keeps happening), download the release file
from the Releases page in your browser, or point `EMBER_NPM_DOWNLOAD_BASE` at your organisation's mirror. It gives up
on a connection that is silent for 30 seconds. If the cache folder's disk or your quota is full, or fills up as Ember
is downloaded or unpacked, it says there isn't room and where (and how big the download is, once it knows): free some
space or set `EMBER_NPM_CACHE` to a folder with room, then run `ember` again.

## Failed or interrupted installs

A reinstall keeps the previous copy until the checked replacement is published. If publication fails, the launcher
restores the previous copy so a normal launch can still work offline. If restoration also fails, the error gives the
paths to the saved previous copy and checked replacement; neither is deleted. Close Ember before manually restoring
one of those folders to the path printed by `ember --npm-where`, and do not overwrite another completed install.

If the cache folder, or a folder above it, belongs to another user (running the launcher once with `sudo` can leave it
so) or is read-only, the launcher says it can't write there: set `EMBER_NPM_CACHE` to a folder of your own, or make
that one yours again. If what comes for `SHA256SUMS` is a web page, such as a hotel Wi-Fi's or a proxy's sign-in page,
it says so without showing it: open the Releases page in your browser, sign in if it asks, and run `ember` again. A
`--npm-reinstall` that fails for want of room, or of a folder it can write in, keeps the copy you had, which `ember`
starts.

Only one installer per version runs at a time. A second one says "Another 'ember' is already downloading Ember
<version>" and starts nothing; run `ember` again once the first has finished. A normal launch can still use a complete
cached copy while a reinstall downloads.

Ctrl+C, closing the terminal or stopping the launcher while it downloads or unpacks Ember ends that and removes what
it had made, starting nothing, its `.<version>-install-lock` folder included, so the next `ember` starts over (it exits with 130 after Ctrl+C).
A stopped `--npm-reinstall` keeps the copy you had, which `ember` starts.
An installer killed outright (`kill -9`, a crash, a power cut) leaves its lock, which names its process: the next
`ember` on the same computer sees that process is gone, takes the lock over and removes the half-made download. A lock
whose installer is still running, was started on another computer sharing the cache, or names no process is never
taken over; if no installer is running, delete the lock folder the message names and run `ember` again. An
interruption between publication renames may also leave the previous copy in `.<version>-<random>/previous`, which is
never removed for you: restore it before retrying offline.

## Update

Quit Ember, then run `npm i -g ember-copilot@latest` and start `ember` again (or run `npx ember-copilot@latest`). The
first start downloads and checks the new version, and once the new version has started (it then points **Start Ember
when I log in** at itself), removes the older versions from the cache; one that is still running, or that another
installer is working on, stays until the next start. `ember doctor` and `--npm-install-only` remove nothing, since
they don't start Ember. If an older Ember is still running, the new one hands what you asked over to it instead of
starting: the launcher says which version is running ("Ember 0.1.1 is already running, so it took this instead of
starting 0.1.2") and removes nothing, so quit Ember and run `ember` again. On Windows, where the launcher can't see
which one is running, it says that Ember was already running and took it, and what to do if that is an older Ember you
installed from the zip (every Ember on a PC hands over to the one running, wherever it was installed from), or, when
the cache also holds another version, if it is older.

## Uninstall

1. In Ember's settings, turn off **Start Ember when I log in** (its login entry points into the cache), remove Ember's
   helper from any computer you added over SSH (**Remove helper** in Settings › Computers), and quit Ember.
2. Delete the cache folder: `%LOCALAPPDATA%\ember-npm` on Windows, `~/Library/Caches/ember-npm` on macOS, or
   `~/.cache/ember-npm` on Linux (`$XDG_CACHE_HOME/ember-npm` when that is set). If you moved it with
   `EMBER_NPM_CACHE`, `ember --npm-where` prints where this version is, so run it before the next step.
3. Remove the launcher:

   ```bash
   npm rm -g ember-copilot
   ```

4. On Windows, delete `Ember.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs`, the Start menu entry Ember
   adds. On a Mac, remove Ember with **−** from each **System Settings › Privacy & Security** list it is on
   (Accessibility, Screen Recording, Input Monitoring, Microphone).
5. To remove what Ember keeps as well (its settings, logs, audit log, speech models, Voice Match voiceprint and
   sign-in), delete its data folder: `~/.config/ember` on Linux, `%LOCALAPPDATA%\ember` on Windows, or
   `~/Library/Application Support/ember` on macOS, and on Linux also `~/Ember` (what Ember made on its desk).

## License

MIT
