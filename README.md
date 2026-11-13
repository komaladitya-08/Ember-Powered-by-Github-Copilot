# Ember — powered by GitHub Copilot

A small, expressive companion that lives next to your cursor, listens for "Hey Ember",
and does the work in your real apps where you can watch, without taking over your mouse.
The agent loop runs on the GitHub Copilot SDK. Spoken replies use the native Kitten Nano 0.8 voice by default;
the Kokoro and Supertonic voices are explicit optional downloads on Windows and macOS. **Hear me more clearly**, a
clearer recogniser for what you say to Ember, is another optional download, and unavailable or failed neural speech
uses an installed local system voice.

Ember runs on:
- **RHEL 8.4** and the rest of the RHEL 8 family (Rocky, Alma, Oracle Linux 8) with GNOME on Xorg, its first platform;
- **Windows 10 22H2 and Windows 11**, x64 (Windows on Arm: best effort);
- **macOS 13 or later** on Apple silicon (Intel Macs and macOS 13: best effort until they are tried on real machines).

Ember's desk, a private display where Ember can work out of your way, is Linux-only.

## What you need

- A **GitHub account with Copilot** (for Copilot Business or Enterprise, your organisation must also turn on the
  **Copilot CLI** policy), or instead your own model provider or your organisation's model service (see **Use your own
  model provider** below).
- One of the computers above. On Linux, log in to a **GNOME on Xorg** session: on GNOME on Wayland, Ember reads apps
  but takes no screenshots and doesn't borrow the mouse or keyboard.
- About 1 GB of disk for Ember and its standard speech models, and each optional extra's size again if you turn it on
  (**Computers without internet access** lists them).
- About 900 MB of memory while Ember is idle and listening (about 1.1 GB where listening runs on WebAssembly, as it
  does when the faster speech libraries can't load), and about 550 MB more with **Hear me more clearly**. Measured on
  Linux, signed in, with Ember's window open.
- A microphone only for “Hey Ember”: everything else works typed.

## Download

This README describes 0.1.1, which isn't published yet. Until it is,
[0.1.0 remains the downloadable beta](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases/tag/v0.1.0):
install it with [0.1.0's own README](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/blob/v0.1.0/README.md),
not the steps below, because 0.1.1 packages Ember differently. In 0.1.0 the speech models are a separate
`ember-voice-models` RPM on RHEL 8 and the AppImage downloads them when voice is turned on; 0.1.1 carries them in the RPM
and the AppImage, and adds the `Ember-voice-models` zip, the `source-*.zip` archives, **Tell me when a new version is
out** and the npm launcher, none of which 0.1.0 has.

Each release's files are on this repository's
[Releases page](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases), with `SHA256SUMS`, the
SHA-256 checksum of each file. Check what you downloaded before you open it:

```bash
sha256sum -c SHA256SUMS --ignore-missing                  # Linux: "OK" after each file you have
shasum -a 256 Ember-0.1.1-mac-arm64.dmg                   # macOS: the same as its line in SHA256SUMS
(Get-FileHash .\Ember-0.1.1-win-x64.zip).Hash.ToLower()    # Windows PowerShell: the same as its line in SHA256SUMS
```

To build them yourself, see [docs/DEVELOPING.md](docs/DEVELOPING.md) (§7 Linux, §10.5 Windows, §11.5 macOS). A
manual CI run with **packages** ticked also keeps them for 3 days as artifacts (`ember-packages`, `ember-windows`,
`ember-macos`, and `ember-macos-x64` when **intel** is ticked too).

### From npm (beta)

The npm launcher is new in 0.1.1 and goes to npm with that release: `ember-copilot` isn't on npm until 0.1.1 is
published (`npm i -g ember-copilot` answers "404 Not Found" until then), so meanwhile install from the
[Releases page](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases) as below.

With Node.js 18.17 or later, `npm i -g ember-copilot` and then `ember` (or just `npx ember-copilot`) downloads this
version's Windows zip, macOS zip or Linux AppImage from the Releases page, checks it against `SHA256SUMS`, caches it in
your user account and starts it. Behind a proxy it uses npm's proxy setting or `HTTPS_PROXY`, as npm does. The builds
are unsigned betas, as below; see [packages/npm/README.md](packages/npm/README.md).

## Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)

Download `ember-0.1.1-1.el8.x86_64.rpm` from the Releases page, then:

```bash
sudo dnf install ./ember-0.1.1-1.el8.x86_64.rpm
ember doctor               # checks this computer and explains anything to fix
```

Log in to **GNOME on Xorg**: in a GNOME on Wayland session Ember says so in its greeting, takes no screenshots and
doesn't borrow the mouse or keyboard (reading apps still works), and opens its settings even when started at login. To
use it fully, log out, click the gear on the login screen, choose **GNOME on Xorg** and log in again. When you turn on
screen reading (the setup check's **Turn on**, or `gsettings set org.gnome.desktop.interface toolkit-accessibility
true`), restart the apps that were already open, or log out and in, so Ember can read them. If Ember's spoken replies
are silent, settings shows a **Speaking** row and a note under **Speak**: run `sudo dnf install speech-dispatcher
speech-dispatcher-espeak-ng`, then restart Ember.

The RPM carries Ember's verified speech models, so nothing is downloaded when voice is turned on. The standard
model downloads total about 220 MB: listening needs 130 MB, the default Kitten Nano 0.8 voice 63.8 MB, and Voice
Match 26.5 MB. These are download sizes; the archives expand when installed. Kitten runs locally on one CPU thread.
Kitten is Ember's neural voice on RHEL: the optional Kokoro and Supertonic voices are Windows and macOS only, so Voice
settings doesn't offer them here. Both the RPM and the AppImage also carry the
libraries that run speech natively on this computer (sherpa-onnx and ONNX Runtime: 32 MB installed, about 9 MB of each
download). On a processor or system where they can't run, listening uses WebAssembly and spoken replies use an
installed local system voice (`ember doctor` shows the speech backend).

Or run `Ember-0.1.1-x86_64.AppImage` without installing Ember itself. It doesn't bring the system packages the RPM
would bring for reading apps, so install those:

```bash
sudo dnf install python3-pyatspi python3-gobject at-spi2-core
# Optional, for “Hey Ember”, speaking and Ember's desk:
sudo dnf install pulseaudio-utils speech-dispatcher speech-dispatcher-espeak-ng xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon
chmod +x Ember-0.1.1-x86_64.AppImage
./Ember-0.1.1-x86_64.AppImage doctor    # checks this computer, as ember doctor does
```

Start Ember with `./Ember-0.1.1-x86_64.AppImage` (`--ask` after it opens the ask box). It adds no entry to your apps
menu, so run the file again to start Ember again or to open its settings while it runs. The RPM installs a menu
entry, which also has **Ask Ember** when you right-click it.

The AppImage carries the speech models too, as the RPM does, so nothing is downloaded when voice is turned on. Should
Kitten (63.8 MB) or Voice Match (26.5 MB) be missing or damaged, Ember still listens, replies in the system's voice or
takes no spoken yes meanwhile, and settings offers just that one to download. The AppImage needs `fusermount` to start
(`sudo dnf install fuse`; without it, it stops with "No suitable fusermount binary found"). Where you can't install
that, run it unpacked: `APPIMAGE_EXTRACT_AND_RUN=1 ./Ember-0.1.1-x86_64.AppImage`. Where user namespaces are off
(STIG-hardened computers), it runs without Chromium's sandbox: install the RPM there instead.

To update, quit Ember, then install the new RPM the same way (`sudo dnf upgrade ./ember-<version>-1.el8.x86_64.rpm`,
which also replaces the separate `ember-voice-models` RPM of 0.1.0); then start Ember again (it starts by itself at your next
login when **Start Ember when I log in** is on). If Ember was running during an update (GNOME Software or automatic
updates included), it asks the next time it opens a window: choose **Restart Ember** to finish the update. To update
the AppImage, quit Ember, save the new AppImage where the old one was, make it executable and delete the old one.
Start the new one once: Ember then points **Start Ember when I log in** at it, if that is on. To remove
Ember, first remove its helper from the computers you added over SSH (below). Then turn off
**Start Ember when I log in** in its settings (or delete `~/.config/autostart/ember.desktop`), quit it, run
`sudo dnf remove ember` or delete the AppImage, and delete `~/.config/ember` (its
settings, logs, audit log, speech models, Voice Match voiceprint, sign-in and the Node.js it downloaded for other computers, in
`remote/runtime`) and `~/Ember` (what it made on its desk).

## Install on Windows

1. Download `Ember-0.1.1-win-x64.zip` from the Releases page.
2. Extract it into a folder of your own, for example `%LOCALAPPDATA%\Programs` (the zip holds an `Ember` folder), and
   start `Ember\Ember.exe`. The first start adds Ember to the Start menu.
3. Ember isn't signed yet, so Windows checks with you first:
   - SmartScreen says "Windows protected your PC": choose **More info**, then **Run anyway**.
   - Smart App Control (on new Windows 11 installations) blocks apps that aren't signed and can't make an exception
     for one app: Windows says "Smart App Control blocked an app that may be unsafe" (or "Smart App Control has
     blocked part of this app"), with no **Run anyway**. To use Ember on that PC, turn it off in **Windows Security ›
     App & browser control › Smart App Control settings** (Windows asks for an administrator's OK). Since the April
     2026 update (Windows 11 24H2 build 26100.8116, 25H2 build 26200.8116) you can turn it on again there later; on
     older builds, turning it back on needs a Windows reset. On a PC managed by your organisation, ask your
     administrator instead. Otherwise, use Ember on another computer until a signed build is out.
   - Where your organisation lets PowerShell run downloaded scripts only when they are signed (`RemoteSigned`),
     Ember's setup check says Windows blocked its accessibility helper because it came from the internet: press
     **Unblock it**. (Or unblock the zip before you extract it: right-click it, **Properties**, tick **Unblock**.)
     Where only signed scripts may run at all (`AllSigned`), Ember can't read apps until your administrator allows its
     helper; screenshots and the borrowed mouse still work.

Windows asks for no permission up front. For “Hey Ember”, desktop apps must be allowed the microphone (**Settings ›
Privacy & security › Microphone › Let desktop apps access your microphone**; on Windows 10, **Settings › Privacy ›
Microphone › Allow desktop apps to access your microphone**). While they aren't, the setup check's **Microphone** row
and the Voice section in settings have **Open Settings**, which opens that page. Start Ember normally, not as
administrator. Ember won't borrow the mouse and keyboard for a window of a program that runs as administrator
(Windows would drop its input there). It never acts in Remote Desktop windows, or in a Linux app that WSL shows on
Windows unless WSL is turned on for Ember and it can tell which app it is, and blacks such windows out of its
screenshots, because it can't tell what runs inside them.

To check this computer, open a Command Prompt or PowerShell in the `Ember` folder and run `.\ember-doctor.cmd`. If
Ember's spoken replies are silent, settings shows a **Speaking** row and a note under **Speak**: add a voice in
**Settings › Time & language › Speech**, then restart Ember.

To update, quit Ember and replace the `Ember` folder with the new one, in the same place; your settings stay in
`%LOCALAPPDATA%\ember`. To remove Ember, first remove its helper from the computers you added over SSH (below), then
turn off **Start Ember when I log in** in its settings, quit it, and delete the `Ember` folder, `Ember.lnk` in
`%APPDATA%\Microsoft\Windows\Start Menu\Programs`, and `%LOCALAPPDATA%\ember` (its settings, logs, audit log, speech
models, Voice Match voiceprint, sign-in and the Node.js it downloaded for other computers, in `remote\runtime`).

## Install on macOS

1. Download `Ember-0.1.1-mac-arm64.dmg` (or the `.zip`; `mac-x64` for an Intel Mac) from the Releases page.
2. Open the dmg, drag Ember into **Applications** and open it from there. Run from the dmg or from Downloads, macOS
   starts Ember from a temporary copy, and its permissions and login item don't stick.
3. Ember is signed ad hoc and not notarised, so macOS stops its first start:
   - macOS 15 and later: open Ember once and choose **Done**, then in **System Settings › Privacy & Security** choose
     **Open Anyway** next to the message about Ember, and confirm.
   - macOS 13 and 14: Control-click Ember in Applications, choose **Open**, then **Open** again.
   - If macOS says Ember "is damaged", clear the download mark and open it again:
     `xattr -dr com.apple.quarantine /Applications/Ember.app`.

Ember needs these permissions. For the first four, its setup check says which are missing and opens the right pane
of **System Settings › Privacy & Security**:

| Permission | Why |
|---|---|
| Accessibility | To read your apps and act in them, and to move the mouse and type when you lend them |
| Screen Recording | To take screenshots for its tasks and to read other apps' window titles. After allowing it, quit and reopen Ember. macOS asks again about once a month: choose **Allow** |
| Input Monitoring | To notice at once when you take the keyboard back. Without it, Ember uses neither the mouse nor the keyboard for you |
| Microphone | Only when you turn on “Hey Ember” |
| Automation (System Events) | Only the first time Ember changes Dark Mode for you |
| Local Network | Only if your organisation's AI service or proxy is on your local network (macOS 15) |

macOS ties each permission to the exact copy of Ember. After you install a new build, Ember can show as switched on
without the permission working: remove Ember from each list with **−** and add it again. Once a row's **Open System
Settings** didn't take, the setup check offers **Reset Ember's permissions**, which takes Ember off the Accessibility,
Screen Recording and Input Monitoring lists: then switch each on again.

With an input method selected (Japanese, Pinyin, Korean…), Ember still clicks, scrolls and presses Command shortcuts,
but won't type with the keyboard: switch to a keyboard layout, or let Ember fill the field directly. The setup check
shows this as a **Typing** warning. If Ember's spoken replies are silent, settings shows a **Speaking** row and a note
under **Speak**: choose a voice in **System Settings › Accessibility › Spoken Content**, then restart Ember.

To update, quit Ember, drag the new Ember.app into Applications over the old one, and give the permissions again as
above. After every update macOS asks for your login keychain password so Ember can read its saved sign-in ("Ember Safe
Storage"): choose **Always Allow**. If you choose **Deny**, Ember says it couldn't read the saved sign-in, and you sign
in again from settings. To remove Ember, first remove its helper from the computers you added over SSH (below), then
turn off **Start Ember when I log in** in its settings, quit it, remove it from each Privacy & Security list with
**−**, and delete Ember.app from Applications and `~/Library/Application Support/ember` (its settings, logs, audit log,
speech models, Voice Match voiceprint, sign-in and the Node.js it downloaded for other computers, in `remote/runtime`).

To check this Mac, run Ember's setup check through `open`, so that macOS judges Ember's own permissions (run from
Terminal, `/Applications/Ember.app/Contents/MacOS/Ember --doctor` reports Terminal's instead):

```bash
: > ~/ember-doctor.txt
open -n -W --stdout ~/ember-doctor.txt -a /Applications/Ember.app --args --doctor; cat ~/ember-doctor.txt
```

## First steps

1. Start Ember from your apps (Linux), the Start menu (Windows) or Applications (macOS); the AppImage by running the
   file, and the npm launcher with `ember`. Its first window takes you
   through 6 steps: a hello, **What I do, and what I don't** (nothing is read, heard or sent until you agree), **Sign
   in to GitHub** (or **Use my own provider**), **Checking this computer** (what to fix, with a button where Ember can
   do it), **Try me out** (stop Ember, ask it something, and say “Hey Ember” if you like) and **Ready to start**, a
   summary of what you chose.
2. To ask, press Ctrl+Alt+Space (on Windows Win+Alt+Space, on a Mac Control+Shift+Command+Space; see **Shortcuts**),
   type your request and press Enter. Ember answers in its bubble beside your cursor, and asks "May I?" before it does
   something in an app.
3. To stop, press Ctrl+Alt+X (on Windows Win+Alt+X, on a Mac Control+Shift+Command+X) or say “Ember, stop”:
   everything stops at once.
4. If something doesn't work, run the setup check (`ember doctor`, the AppImage's `doctor`, `.\ember-doctor.cmd` on
   Windows, or the `open` command above on a Mac), or open Ember's settings with Ctrl+Alt+E (on Windows Win+Alt+E, on
   a Mac Control+Shift+Command+E) or by starting Ember again.

## Hear about new versions

Ember doesn't update itself. To hear when a new version is out, turn on **Tell me when a new version is out** under
**Updates** in its settings and agree to its note. Once a day Ember then asks GitHub, sends nothing about you, and tells
you once, in a notification that opens **Updates** when you click it (**See what's new…** there opens the release's
page). It never downloads or installs anything: you install the new version as above, and **Updates** says how for
the way you installed Ember (the RPM, the AppImage, the zip, the dmg or npm). The source of the voice's
GPL-licensed part is on each release, as `source-*.zip`.

## Computers without internet access

Everything Ember hears and says is worked out on the computer itself: the wake word, speech recognition, Ember's
voice and Voice Match need no network. Ember's packages carry everything it needs to run: its standard speech models,
and the Node.js runtime it installs on computers you bring it to over SSH (each checked against its pinned SHA-256).
Four optional extras are downloaded only when you turn them on, each showing its size first and checked against its
pinned SHA-256, so a computer that can't reach their host goes without them:

- **Hear me more clearly** (482 MB, Settings › Voice), the clearer recogniser, and the Kokoro voice (350 MB, Windows
  and macOS) and the Supertonic voice (129 MB, Windows and macOS), from sherpa-onnx's releases on `github.com`, which
  hands the files over from `release-assets.githubusercontent.com`;
- Better recall (23 MB, Settings › Memory), a small language model from Hugging Face (`huggingface.co`, served from
  `*.hf.co`), only when you click its Download.

Without them Ember listens with its standard recogniser, speaks in Kitten Nano, and its memory still works, matching
your words. Only Copilot itself, and the review of commands, need the network: your organisation's model service, your own model provider, or GitHub Copilot's. With your own provider
on a model server on this computer (below), nothing needs the network at all.

What to install so nothing is downloaded:

| Computer | Install |
|---|---|
| Windows | `Ember-0.1.1-win-x64.zip`: the speech models are inside it |
| macOS | `Ember-0.1.1-mac-arm64.dmg` (or the .zip; mac-x64 for Intel): the speech models are inside it |
| RHEL 8 | `ember-0.1.1-1.el8.x86_64.rpm`: the speech models are inside it; `dnf` takes the RPM's system packages (speech-dispatcher, AT-SPI…) from your distribution's repositories, so point it at your organisation's mirror |
| AppImage | `Ember-0.1.1-x86_64.AppImage`: the speech models are inside it (it still needs the system packages above for reading apps) |

`Ember-voice-models-0.1.1.zip` (check it against `SHA256SUMS`) also serves IT that installs the models once per
computer for every copy of Ember: unzip it so its `voice-models` folder lands in `%ProgramData%\Ember\voice-models`
(Windows), `/Library/Application Support/Ember/voice-models` (macOS) or `/usr/share/ember/voice-models` (Linux, for an
AppImage built without them; the RPM puts its own there). It holds the standard models only, not the optional extras.

Ember checks each model against its SHA-256 and uses that folder without downloading anything; it never changes it.

## Sign in to Copilot

Ember needs a **GitHub account with Copilot** (for Copilot Business or Enterprise, your organisation must also turn on
the **Copilot CLI** policy). Once you have agreed to how Ember works in its first window, press **Sign in with GitHub**
on its **Sign in to GitHub** step (later, in Settings › **Models & connections**). Your browser opens GitHub's device page: enter the code Ember shows (**Copy** puts it on the
clipboard) and approve. Ember connects within a few seconds, with no restart. It keeps the sign-in encrypted by your
system (the GNOME keyring, Windows' own protection or the macOS Keychain); where it can't, you sign in again the next
time Ember starts. Ember's own GitHub sign-in lasts eight hours at a time: Ember renews it by itself before it runs out
(when it isn't in the middle of something, where it can), and as soon as the computer wakes if it ran out during
sleep, so you don't need to sign in again.

Ember also uses a sign-in it finds on this computer: a `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` in its
environment (classic `ghp_` tokens don't work), or the **GitHub CLI**'s (run `gh auth login`, then press
**Check again**). Ember's own sign-in comes first, then the environment's, then the GitHub CLI's; one that Copilot refuses
gives way to the next.

A build without Ember's GitHub App (a fork, or a development build without a client id) signs in only through the
GitHub CLI. Install it, run `gh auth login` in a terminal, and press **Connect with GitHub CLI** in Ember's settings:

- RHEL 8: `sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo`, then
  `sudo dnf install gh`
- Windows: `winget install --id GitHub.cli` in PowerShell, or the installer from [cli.github.com](https://cli.github.com)
- macOS: `brew install gh`, or the installer from [cli.github.com](https://cli.github.com)

## Use your own model provider

Instead of GitHub Copilot, Ember can use a model service of your own. In its first window, press **Use my own
provider** on the **Sign in to GitHub** step: choose the provider's type (OpenAI-compatible, Azure OpenAI or
Anthropic), enter its address (an `https://` address, or `http://localhost:…` for a model server on this computer such
as Ollama or LM Studio, which may need no key), its API key and the name of a model, then press **Agree and check the
models**. Ember first shows what it will send to that service, screenshots of the windows it works in included, and
uses it only once you agree; the check says what the service answered. **Back** takes you to GitHub Copilot instead.

Later, open Settings › **Models & connections** and turn on **Use my own model provider** under **Model provider**:
choose the **Provider**, enter its **Endpoint**, paste the **API key** and press **Save**, and enter the
**Conversation model** (and, if it differs, a **Model for tasks** that understands images). **Test connection** checks
the address and the key. A change applies from your next message, without a restart.

The key is kept encrypted by your system's keyring, apart from Ember's settings, and goes only to that service; Ember
never shows it again (**Replace** and **Remove** are there), and signing out deletes it. Where there is no keyring
(Linux without GNOME Keyring or KWallet), Ember won't keep a key, but a local server that needs none still works. If
your organisation set its own model service, or turned this off, the switch shows as managed.

## Shortcuts

| | Linux | Windows | macOS |
|---|---|---|---|
| Ask Ember | Ctrl+Alt+Space | Win+Alt+Space | Control+Shift+Command+Space |
| Stop everything | Ctrl+Alt+X | Win+Alt+X | Control+Shift+Command+X |
| Settings | Ctrl+Alt+E | Win+Alt+E | Control+Shift+Command+E |
| Microphone off and on | Ctrl+Alt+M | Win+Alt+M | Control+Shift+Command+M |
| Allow, while Ember asks | Ctrl+Alt+Y | Win+Alt+Y | Control+Shift+Command+Y |
| Not now, while Ember asks | Ctrl+Alt+N | Win+Alt+N | Control+Shift+Command+N |

If another app already holds one, Ember uses its fallback: on Linux and Windows the same chord with Shift
(Ctrl+Alt+Shift+Space, Win+Alt+Shift+Space), for every shortcut in the table. On a Mac it is Control+Shift+Command
with another key, never Option (Control+Option is VoiceOver's): A for Ask Ember, Period for Stop everything (as ⌘.
stops), Comma for settings (as ⌘, opens them), U for the microphone, Return to allow and Esc for not now. The setup
check says so ("Ctrl+Alt+Space is taken by another app, so Ask Ember is
Ctrl+Alt+Shift+Space"), and the greeting, the handle's menu, settings and every hint name the chord Ember holds.

If another app holds the fallback too, the setup check says which, and Ember keeps trying to get them. Meanwhile click
Ember's handle in its corner, or from the keyboard start Ember again (from your apps, the AppImage, `ember`, the Start
menu or Applications) or press the settings shortcut: settings then opens at **Ask Ember…** and **Stop everything**, at the
top of **Home**. On Windows, PowerToys' Command Palette uses Win+Alt+Space and Xbox Game Bar uses Win+Alt+M by
default.

**Ask Ember** is also in the system's own launcher, whatever another app holds: right-click Ember in the dash or the
app grid (Linux, with the RPM), Ember's taskbar icon (Windows: its jump list), or Ember's Dock icon while it runs (macOS). On Windows,
Ember has a taskbar icon while its settings, command, or password and consent window is open, or once you pin it there: right-click
Ember in the Start menu and pin it to the taskbar. On Linux and Windows it starts Ember with `--ask` (`ember --ask`,
`Ember.exe --ask`), which opens the ask box, starting Ember first if it isn't running (settings instead until Ember is
set up).

On Windows and macOS, wait for the ask box before you type: letters typed before it appears go to the app underneath.
(On Linux, Ember holds them and puts them in the box.) The ask box reminds you the first five times it opens.

On Windows and Linux, Ember's windows have no menu bar: quit with **Quit Ember** in the handle's menu, which asks
first while something is running (Ctrl+Q doesn't quit). The settings window zooms with Ctrl+= or Ctrl++, Ctrl+- and
Ctrl+0 (back to 100 %), from 58 % to 249 %.

## Accessibility

Almost all of Ember works from the keyboard and with a screen reader (the rest is under **Known gaps**). Its own
windows (settings, the ask box, the command window, the sign-in and consent cards) are ordinary pages with headings,
labels and a visible focus. Ember itself, its bubble, its task cards and its handle can't be reached with the keyboard,
so Ember never pulls the keyboard out of your app: the keys below reach what they do. Ember hasn't been tried with
Orca, NVDA, JAWS, Narrator or VoiceOver on real computers yet; please
[report](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/issues) what doesn't work.

**Screen readers.** Ember notices Orca on Linux (GNOME's screen reader switch), NVDA, JAWS and Narrator on Windows,
and VoiceOver on a Mac. While one runs:

- Ember speaks its questions and results itself, unless you choose otherwise in Settings › **Voice** › **Speak
  replies, questions and results out loud**: **When a screen reader runs**, **Always** (the default) or **Never**.
  When your organisation turns speaking off, Ember never speaks.
- The bubble's words are read out as they change: a question with the keys that answer it ("To allow, press
  Ctrl+Alt+Y; for not now, press Ctrl+Alt+N") and all of a long text it would type (then "You can allow it once all of it has been shown.
  Ctrl+Alt+Y shows the next part", and "You can allow it now" once it has), and for a question shown in another of
  Ember's windows, how to get there ("press Alt+Tab to go there").
- The command window reads out what a command prints, and its lines can be read again one by one. A dangerous command
  you asked for waits 15 seconds instead of 4 before it runs.

**Keyboard routes.** The keys named here are Linux's; Windows and macOS use their own (see **Shortcuts**).

| To | From the keyboard |
|---|---|
| Ask Ember | The ask shortcut opens the ask box with the keyboard in it: Enter sends (Shift+Enter adds a line), ↑ and ↓ bring back earlier requests, Esc closes. If another app holds it and its fallback: **Ask Ember…** in settings, at the top of **Home**, or **Ask Ember** in the system's launcher (app menu, Dock menu, or the jump list once Ember is pinned to the taskbar) |
| Answer "May I?" | Ctrl+Alt+Y allow, Ctrl+Alt+N not now, while the question is up. **Always in this app** is a click only, so that a key meant for an app never grants for good. A question about typing a long text shows all of it in a box under it and allows only once all of it has been in view: until then Ctrl+Alt+Y shows the next part, and once it has, a moment later, Ctrl+Alt+Y pressed again allows |
| Stop | The stop shortcut, or "Ember, stop": every task, question and command at once. If another app holds it and its fallback: **Stop everything** at the top of settings' **Home** |
| Open settings | The settings shortcut, or start Ember again from your apps, the AppImage, `ember`, the Start menu or Applications |
| What the handle's menu does | Settings' **Home**: **Ask Ember…** and **Stop everything**. Settings › **Your Ember › Ember on screen**: **Hide Ember until it needs me** for **Hide Ember**, **Follow my cursor** for **Stay put**, **Handle position** for **Move to the other side**, and **Quit Ember**. The microphone: its shortcut, or **Voice** in settings. **Read the last answer** and a long answer's **Read all**: settings' **Conversation**. **Bring Ember to a computer…**, **Disconnect** and **Cancel connecting**: settings' **Computers**. **Work on**: name the computer in your request ("on build-01, …") |
| A command card (**Allow**, **Not now**) | Alt+Tab to **Ember commands** and Tab to the button; or Ember's allow and not-now keys, once the card has shown the whole command; or say “allow” or “not now” once Ember has asked (“Ember, allow” later), then (with **Only my voice can say yes (Voice Match)** on, only your voice can say yes) |
| Any question of Ember's | Say “allow” or “not now” once Ember has asked (no name needed for a few seconds; “Ember, allow” later; on macOS, and on Linux without PulseAudio's parec, where Ember can't tell whether something else is playing, a yes always needs the name): anyone near the computer can answer by voice, unless you turn on **Only my voice can say yes (Voice Match)**, which then takes a yes only from your voice. Never “Always” by voice. **Apps & privacy › How Ember asks › Interactive** has Ember tell you instead of asking before routine steps; risky ones still ask. **Assisted** adds a check: before Ember asks, a lighter AI model reads the step against what you asked, and when it matches Ember goes ahead and tells you. **Autopilot** doesn't ask: Ember sends, deletes, pays, installs and runs dangerous commands without asking and tells you as it goes, a risk you accept on its card; it still asks before a command that would show passwords, keep running after you stop it or that it can't tell the effect of, and your organisation can turn it off |
| The command window | Tab and Shift+Tab move between the tabs, the buttons and the command's terminal, never into the command (Ctrl+I types a Tab for a program that wants one); Ctrl+Shift+C copies (Command+C on a Mac), and **Copy output** copies all a command printed |
| Bubble buttons for other computers (**Bring Ember**, **Reconnect**, **Try again**) | Settings › **Computers** has the same; the bubble says so |
| Sign-in and consent cards | Their window takes the keyboard; where the system keeps it in another app, a card you type into says so, and Alt+Tab reaches the card. Tab to a button, Enter presses the highlighted one, Esc cancels (**Not now** on a consent card). A consent card's yes counts once you have read all of it: Tab to its words and scroll with the arrow keys or Page Down. It is answered there only, never with Ember's keys or by voice |
| Ember's desk (Linux) | **Take over** is a click; while you have the desk, every key goes to it, Tab included, until Ctrl+Alt+End hands it back. A screen reader is told so when you take over |

**Seeing, motion and time.** Settings › **Comfort & access** has **Text size** (Large or Larger, for settings, the
bubble, task cards, the handle, the ask box, the desk window's bar on Linux, the command window and its terminal,
and the password and consent cards), **Glass** (Clear, Regular or Solid: how much of your screen shows through Ember's
bubble, cards, handle and ask box; solid in Calm mode and when your system asks for less transparency or more contrast),
**Calm mode** (no hops, bounces or fidgets; also on when your system asks for less motion; Ember's bubble and cards still fade in and out) and **More
time to read and answer** (messages stay ten times as long, also ones that waited behind another or were covered for a
while, and Ember's own notices; a question waits 20 minutes instead of 2 before it ends unanswered, and one with a
long text to read 10 minutes more instead of 1 for every 1000 characters of it). At Large and
Larger, an answer that needs more than six lines at that size offers **Read all**. Windows' contrast themes keep
switches, edges, focus and state visible, and the handle's microphone and computer badges change shape as well as
colour.

**Where the handle sits.** Ember's handle sits in the bottom-right corner of your main screen, with its task cards
just above it, clear of the taskbar, Dock or panel. If it covers something you need there, such as a status bar or a
scroll corner, choose **Bottom left** in Settings › **Your Ember** › **Handle position**, or click **Move to the
other side** in the handle's menu. The task cards go with it, and on Linux Ember's desk view takes the other corner.

**Known gaps.**
- A task card's own **Stop** and the desk's **Take over** are clicks only: the stop shortcut stops every task.
- Ember's shortcuts can't be changed; when another app holds one and its fallback, use the routes in the table.
- **Read the last answer** has no shortcut of its own: it is in the handle's menu and settings' **Conversation**.
- On Linux, while GNOME's Typing Assist (Slow Keys, Bounce Keys or Sticky Keys, in Settings › Universal Access) is on,
  Ember won't use the keyboard on your screen, because its keys would be lost or changed. It still clicks and scrolls
  and can fill fields directly, Ember's desk isn't affected, and the setup check shows a **Typing** warning. Ember never
  changes the setting.
- On Windows, a command can't take typing (§2.9 of [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md)). On a Mac,
  Command+Tab doesn't list the command window: answer a command card with Ember's allow and not-now keys.

## Commands, WSL and other computers

Ember can also run commands, work in WSL on Windows, and work on other computers you reach over SSH. Each is off until
you turn it on in settings (**Commands**, **Computers**) and accept the card that says what it means.

- **Commands** run in Ember's own **Ember commands** window, never in your terminal, where you can watch and stop
  them. Most run straight away. Ember stops and asks before anything that deletes or overwrites data, pushes or
  publishes anywhere, touches passwords or keys, changes the system, or downloads and runs code; when you asked for
  exactly that yourself ("delete build/", "can you delete build/?", but not a question, a how-to or something already
  done), it says so and gives you 4 seconds to stop it. Asked for by voice, such a command asks instead on Windows, on
  macOS and on Linux without parec, where Ember can't tell your voice from what your speakers play. It reads a shell
  script before running it: a script that does any of that always asks, and so does one it can't read in full, as most
  real build and install scripts are. It never runs a command that would read or change its own safety
  settings, records or programs, or press keys in its own windows.
- **WSL**: Ember reads and uses the Linux apps WSL shows on Windows, opens them, and runs commands in your distros.
- **Other computers**: on your click, Ember opens its own SSH connection with your SSH settings and keys, copies a
  helper there (about 33 MB, unpacked to about 130 MB) that runs only while it is connected, and works there:
  commands, and the apps on that computer's screen when it is a Linux computer with an X11 desktop and you are the
  person logged in at it, asking before every step. When it sees you `ssh` somewhere, it can offer to come along. Your
  voice and your GitHub sign-in always stay on this computer.

The same switches turn them off, and the stop shortcut stops every command at once. Administrators can turn each off,
or make every command ask, in the organisation policy (`features.wsl`, `features.ssh`, `commands`, `ssh`, which 0.1.0
knows too; the `features` keys 0.1.1 adds lock a 0.1.0 Ember down, as the RPM's `policy.README` says).
[docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md) has the details, including what Ember can't do yet.

**Before you remove Ember from this computer**, press **Remove helper** beside each computer you added in Settings ›
**Computers**: it removes the helper there and keeps that computer's record of what Ember did. Once Ember is
gone from here, the helper can only be removed on that computer itself
([docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md) §4.7):

```bash
sh ~/.local/share/ember-remote/versions/*/uninstall.sh                     # Linux
sh ~/Library/Application\ Support/Ember\ Remote/versions/*/uninstall.sh    # macOS
```

## Report a problem

Report what doesn't work, or what is hard to use, on the
[issue tracker](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/issues). Settings'
**About this build** shows the same address under **Report a problem**, to copy, and the setup check's advice points
there when only a report can help. **About this build** also shows Ember's **Log file** (`ember.log`), with **Copy** and
**Show in Files** (**Show in File Explorer** on Windows, **Show in Finder** on a Mac): look it over, then attach it to
your report. What to try first for common problems is in the developer guide's troubleshooting tables, for
[Linux](docs/DEVELOPING.md#9-troubleshooting), [Windows](docs/DEVELOPING.md#109-troubleshooting) and
[macOS](docs/DEVELOPING.md#118-troubleshooting).

## Develop

```bash
npm ci && npm run dev      # needs Node 22 and npm 11, see docs/DEVELOPING.md
```

- **[PLAN.md](PLAN.md)**: the frozen v1 plan, task list and progress (Windows and macOS: milestone M11; SSH, WSL and
  commands: M12)
- [docs/DEVELOPING.md](docs/DEVELOPING.md): set up a development machine (RHEL 8.4 §1–§9, Windows §10, macOS §11;
  SSH, WSL and commands §14), and troubleshooting (§9, §10.9, §11.8)
- [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md): commands, WSL and other computers, for users and administrators
- [CHANGELOG.md](CHANGELOG.md): release notes
- [docs/RESEARCH.md](docs/RESEARCH.md): background research and evidence
- [docs/DESIGN.md](docs/DESIGN.md): characters, emotions and motion
- `demo/character-lab`: interactive character prototype (`npm run build:lab`)
