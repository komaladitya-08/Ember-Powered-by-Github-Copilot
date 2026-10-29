# Ember — powered by GitHub Copilot

A small, expressive companion that lives next to your cursor, listens for "Hey Ember",
and does the work in your real apps where you can watch, without taking over your mouse.
The agent loop runs on the GitHub Copilot SDK.

Ember runs on:
- **RHEL 8.4** and the rest of the RHEL 8 family (Rocky, Alma, Oracle Linux 8) with GNOME on Xorg, its first platform;
- **Windows 10 22H2 and Windows 11**, x64 (Windows on Arm: best effort);
- **macOS 13 or later** on Apple silicon (Intel Macs and macOS 13: best effort until they are tried on real machines).

Ember's desk, a private display where Ember can work out of your way, is Linux-only.

## Download

Each release's files are on this repository's
[Releases page](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases), with `SHA256SUMS`, the
SHA-256 checksum of each file. Check what you downloaded before you open it:

```bash
sha256sum -c SHA256SUMS --ignore-missing                  # Linux: "OK" after each file you have
shasum -a 256 Ember-0.1.0-mac-arm64.dmg                   # macOS: the same as its line in SHA256SUMS
(Get-FileHash .\Ember-0.1.0-win-x64.zip).Hash.ToLower()    # Windows PowerShell: the same as its line in SHA256SUMS
```

To build them yourself, see [docs/DEVELOPING.md](docs/DEVELOPING.md) (§7 Linux, §10.5 Windows, §11.5 macOS). A
manual CI run with **packages** ticked also keeps them for 3 days as artifacts (`ember-packages`, `ember-windows`,
`ember-macos`, and `ember-macos-x64` when **intel** is ticked too).

## Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)

Download `ember-0.1.0-1.el8.x86_64.rpm` from the Releases page, then:

```bash
sudo dnf install ./ember-0.1.0-1.el8.x86_64.rpm
ember doctor               # checks this computer and explains anything to fix
```

Log in to **GNOME on Xorg**: in a GNOME on Wayland session Ember says so in its greeting, takes no screenshots and
doesn't borrow the mouse or keyboard (reading apps still works), and opens its settings even when started at login. To
use it fully, log out, click the gear on the login screen, choose **GNOME on Xorg** and log in again. When you turn on
screen reading (the setup check's **Turn on**, or `gsettings set org.gnome.desktop.interface toolkit-accessibility
true`), restart the apps that were already open, or log out and in, so Ember can read them. If Ember's spoken replies
are silent, settings shows a **Speaking** row and a note under **Speak**: run `sudo dnf install speech-dispatcher
speech-dispatcher-espeak-ng`, then restart Ember.

For “Hey Ember” without downloading the speech models on each computer, also install
`ember-voice-models-0.1.0-1.el8.noarch.rpm` from the same release (to build it, run `node scripts/voice/prepare.mjs`
before packaging: docs/DEVELOPING.md §7). Without it, Ember offers to download the models (126 MB) when voice is
turned on.

Or run `Ember-0.1.0-x86_64.AppImage` without installing Ember itself. It carries only Ember, so it still needs the
system packages the RPM would bring for reading apps:

```bash
sudo dnf install python3-pyatspi python3-gobject at-spi2-core
# Optional, for “Hey Ember”, speaking and Ember's desk:
sudo dnf install pulseaudio-utils speech-dispatcher speech-dispatcher-espeak-ng xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon
chmod +x Ember-0.1.0-x86_64.AppImage
./Ember-0.1.0-x86_64.AppImage doctor    # checks this computer, as ember doctor does
```

The AppImage downloads the speech models when voice is turned on (the models RPM needs Ember's RPM). Where user
namespaces are off (STIG-hardened computers), it runs without Chromium's sandbox: install the RPM there instead.

To update, quit Ember, then install the new RPM the same way (`sudo dnf upgrade ./ember-<version>-1.el8.x86_64.rpm`,
with the new `ember-voice-models` RPM if you installed it); Ember starts again at your next login. If Ember was running
during an update (GNOME Software or automatic updates included), it asks the next time it opens a window: choose
**Restart Ember** to finish the update. To remove Ember, first remove its helper from the computers you added over SSH
(below). Then turn off **Start Ember when I log in** in its settings (or delete `~/.config/autostart/ember.desktop`),
quit it, run `sudo dnf remove ember` (it removes `ember-voice-models` too) or delete the AppImage, and delete
`~/.config/ember` (its settings, logs, audit log, speech models, sign-in and the Node.js it downloaded for other
computers, in `remote/runtime`) and `~/Ember` (what it made on its desk).

## Install on Windows

1. Download `Ember-0.1.0-win-x64.zip` from the Releases page.
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
models, sign-in and the Node.js it downloaded for other computers, in `remote\runtime`).

## Install on macOS

1. Download `Ember-0.1.0-mac-arm64.dmg` (or the `.zip`; `mac-x64` for an Intel Mac) from the Releases page.
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
speech models, sign-in and the Node.js it downloaded for other computers, in `remote/runtime`).

To check this Mac, run Ember's setup check through `open`, so that macOS judges Ember's own permissions (run from
Terminal, `/Applications/Ember.app/Contents/MacOS/Ember --doctor` reports Terminal's instead):

```bash
: > ~/ember-doctor.txt
open -n -W --stdout ~/ember-doctor.txt -a /Applications/Ember.app --args --doctor; cat ~/ember-doctor.txt
```

## Sign in to Copilot

Ember needs a **GitHub account with Copilot** (for Copilot Business or Enterprise, your organisation must also turn on
the **Copilot CLI** policy). Once you have agreed to how Ember works in its first window, press **Sign in with GitHub**
in its Copilot section. Your browser opens GitHub's device page: enter the code Ember shows (**Copy** puts it on the
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

## Shortcuts

| | Linux | Windows | macOS |
|---|---|---|---|
| Ask Ember | Ctrl+Alt+Space | Win+Alt+Space | Control+Shift+Command+Space |
| Stop everything | Ctrl+Alt+X | Win+Alt+X | Control+Shift+Command+X |
| Settings | Ctrl+Alt+E | Win+Alt+E | Control+Shift+Command+E |
| Microphone off and on | Ctrl+Alt+M | Win+Alt+M | Control+Shift+Command+M |
| Allow, while Ember asks | Ctrl+Alt+Y | Win+Alt+Y | Control+Shift+Command+Y |
| Not now, while Ember asks | Ctrl+Alt+N | Win+Alt+N | Control+Shift+Command+N |

If another app already holds one, the setup check says which, and Ember keeps trying to get it. Meanwhile click
Ember's handle in the bottom-right corner, or from the keyboard start Ember again (from your apps, the Start menu or
Applications) or press the settings shortcut: settings then opens at **Ask Ember…** and **Stop everything**, under
**Comfort & access**. On Windows, PowerToys' Command Palette uses Win+Alt+Space and Xbox Game Bar uses Win+Alt+M by
default.

On Windows and macOS, wait for the ask box before you type: letters typed before it appears go to the app underneath.
(On Linux, Ember holds them and puts them in the box.)

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
  replies, questions and results out loud**: **When a screen reader runs** (the default), **Always** or **Never**.
  When your organisation turns speaking off, Ember never speaks.
- The bubble's words are read out as they change: a question with the keys that answer it ("Ctrl+Alt+Y allow;
  Ctrl+Alt+N not now"), and for a question shown in another of Ember's windows, how to get there ("press Alt+Tab to
  go there").
- The command window reads out what a command prints, and its lines can be read again one by one. A dangerous command
  you asked for waits 15 seconds instead of 4 before it runs.

**Keyboard routes.** The keys named here are Linux's; Windows and macOS use their own (see **Shortcuts**).

| To | From the keyboard |
|---|---|
| Ask Ember | The ask shortcut opens the ask box with the keyboard in it: Enter sends (Shift+Enter adds a line), ↑ and ↓ bring back earlier requests, Esc closes. If another app holds the shortcut: **Ask Ember…** in settings, under **Comfort & access › Ember on screen** |
| Answer "May I?" | Ctrl+Alt+Y allow, Ctrl+Alt+N not now, while the question is up. **Always in this app** is a click only, so that a key meant for an app never grants for good |
| Stop | The stop shortcut, or "Ember, stop": every task, question and command at once. If another app holds the shortcut: **Stop everything** under **Comfort & access › Ember on screen** |
| Open settings | The settings shortcut, or start Ember again from your apps, the Start menu or Applications |
| What the handle's menu does | Settings › **Comfort & access › Ember on screen**: **Ask Ember…**, **Stop everything**, **Hide Ember**, **Stay put**, **Quit Ember**. The microphone: its shortcut, or **Voice** in settings. **Read the last answer** and a long answer's **Read all**: settings' **Conversation**. **Bring Ember to a computer…**, **Disconnect** and **Cancel connecting**: settings' **Computers**. **Work on**: name the computer in your request ("on build-01, …") |
| A command card (**Allow**, **Not now**) | Alt+Tab to **Ember commands** and Tab to the button; or Ember's allow and not-now keys, once the card has shown the whole command |
| The command window | Tab and Shift+Tab move between the tabs, the buttons and the command's terminal, never into the command (Ctrl+I types a Tab for a program that wants one); Ctrl+Shift+C copies (Command+C on a Mac), and **Copy output** copies all a command printed |
| Bubble buttons for other computers (**Bring Ember**, **Reconnect**, **Try again**) | Settings › **Computers** has the same; the bubble says so |
| Sign-in and consent cards | Their window takes the keyboard; where the system keeps it in another app, a card you type into says so, and Alt+Tab reaches the card. Tab to a button, Enter presses the highlighted one, Esc cancels (**Not now** on a consent card). A consent card's yes counts once you have read all of it: Tab to its words and scroll with the arrow keys or Page Down. It is answered there only, never with Ember's keys or by voice |
| Ember's desk (Linux) | **Take over** is a click; while you have the desk, every key goes to it, Tab included, until Ctrl+Alt+End hands it back. A screen reader is told so when you take over |

**Seeing, motion and time.** Settings › **Comfort & access** has **Text size** (Large or Larger, for settings, the
bubble, task cards, the handle, the command window and its terminal, and the password and consent cards; the Ask box
keeps its size),
**Calm mode** (no hops, bounces or fidgets; also on when your system asks for less motion) and **More time to read
and answer** (messages stay ten times as long, and a question waits 20 minutes instead of 2 before it counts as
**Not now**). Windows' contrast themes keep switches, edges, focus and state visible, and the handle's microphone and
computer badges change shape as well as colour.

**Known gaps.**
- A task card's own **Stop** and the desk's **Take over** are clicks only: the stop shortcut stops every task.
- Ember's shortcuts can't be changed; when another app holds one, use the routes in the table.
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
or make every command ask, in the organisation policy (`features.wsl`, `features.ssh`, `commands`, `ssh`); an Ember
older than this release locks down when its policy uses those keys. [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md)
has the details, including what Ember can't do yet.

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
[issue tracker](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/issues). Settings' **About** has the
same link (**Report a problem**), and the setup check's advice points there when only a report can help.

## Develop

```bash
npm ci && npm run dev      # needs Node 22 and npm 11, see docs/DEVELOPING.md
```

- **[PLAN.md](PLAN.md)**: the frozen v1 plan, task list and progress (Windows and macOS: milestone M11; SSH, WSL and
  commands: M12)
- [docs/DEVELOPING.md](docs/DEVELOPING.md): set up a development machine (RHEL 8.4 §1–§9, Windows §10, macOS §11;
  SSH, WSL and commands §14)
- [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md): commands, WSL and other computers, for users and administrators
- [CHANGELOG.md](CHANGELOG.md): release notes
- [docs/RESEARCH.md](docs/RESEARCH.md): background research and evidence
- [docs/DESIGN.md](docs/DESIGN.md): characters, emotions and motion
- `demo/character-lab`: interactive character prototype (`npm run build:lab`)
