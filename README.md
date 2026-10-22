# Ember — powered by GitHub Copilot

A small, expressive companion that lives next to your cursor, listens for "Hey Ember",
and does the work in your real apps where you can watch, without taking over your mouse.
The agent loop runs on the GitHub Copilot SDK.

Ember runs on:
- **RHEL 8.4** and the rest of the RHEL 8 family (Rocky, Alma, Oracle Linux 8) with GNOME on Xorg, its first platform;
- **Windows 10 22H2 and Windows 11**, x64 (Windows on Arm: best effort);
- **macOS 13 or later** on Apple silicon (Intel Macs and macOS 13: best effort until they are tried on real machines).

Ember's desk, a private display where Ember can work out of your way, is Linux-only.

## Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)

```bash
sudo dnf install ./ember-0.1.0-1.el8.x86_64.rpm
ember doctor               # checks this computer and explains anything to fix
```

For “Hey Ember” without downloading the speech models on each computer, also install
`ember-voice-models-0.1.0-1.el8.noarch.rpm` when you build it (`node scripts/voice/prepare.mjs` before packaging;
see docs/DEVELOPING.md). Without it, Ember offers to download the models (126 MB) when voice is turned on.

Or run `Ember-0.1.0-x86_64.AppImage` without installing.

## Install on Windows

1. Get `Ember-0.1.0-win-x64.zip`. `npm run package:win` builds it (docs/DEVELOPING.md §10.5), and a manual CI run with
   **packages** ticked keeps it for 3 days as the `ember-windows` artifact.
2. Extract it into a folder of your own, for example `%LOCALAPPDATA%\Programs` (the zip holds an `Ember` folder), and
   start `Ember\Ember.exe`. The first start adds Ember to the Start menu.
3. Ember isn't signed yet, so Windows checks with you first:
   - SmartScreen says "Windows protected your PC": choose **More info**, then **Run anyway**.
   - Smart App Control (on some new Windows 11 installations) blocks unsigned apps outright and can't make an
     exception for one app.
   - Where your organisation lets PowerShell run downloaded scripts only when they are signed (`RemoteSigned`),
     Ember's setup check says Windows blocked its accessibility helper because it came from the internet: press
     **Unblock it**. (Or unblock the zip before you extract it: right-click it, **Properties**, tick **Unblock**.)
     Where only signed scripts may run at all (`AllSigned`), Ember can't read apps until your administrator allows its
     helper; screenshots and the borrowed mouse still work.

Windows asks for no permission up front. For “Hey Ember”, desktop apps must be allowed the microphone (**Settings ›
Privacy & security › Microphone › Let desktop apps access your microphone**). Start Ember normally, not as
administrator. Ember won't borrow the mouse and keyboard for a window of a program that runs as administrator
(Windows would drop its input there). It never acts in Remote Desktop windows, or in a Linux app that WSL shows on
Windows unless WSL is turned on for Ember and it can tell which app it is, and blacks such windows out of its
screenshots, because it can't tell what runs inside them.

To check this computer, open a Command Prompt or PowerShell in the `Ember` folder and run `.\ember-doctor.cmd`.

To update, quit Ember and replace the `Ember` folder with the new one, in the same place; your settings stay in
`%LOCALAPPDATA%\ember`. To remove Ember, turn off **Start Ember when I log in** in its settings, quit it, and delete
the `Ember` folder, `Ember.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs`, and `%LOCALAPPDATA%\ember`
(its settings, logs and sign-in).

## Install on macOS

1. Get `Ember-0.1.0-mac-arm64.dmg` (or the `.zip`; `mac-x64` for an Intel Mac). `npm run package:mac` builds them
   (docs/DEVELOPING.md §11.5), and a manual CI run with **packages** ticked keeps them as the `ember-macos` artifact
   (`ember-macos-x64` when **intel** is ticked too).
2. Open the dmg, drag Ember into **Applications** and open it from there. Run from the dmg or from Downloads, macOS
   starts Ember from a temporary copy, and its permissions and login item don't stick.
3. Ember is signed ad hoc and not notarised, so macOS stops its first start:
   - macOS 15: open Ember once and choose **Done**, then in **System Settings › Privacy & Security** choose **Open
     Anyway** next to the message about Ember, and confirm.
   - macOS 13 and 14: Control-click Ember in Applications, choose **Open**, then **Open** again.
   - If macOS says Ember "is damaged", clear the download mark and open it again:
     `xattr -dr com.apple.quarantine /Applications/Ember.app`.

Ember needs these permissions. For the first four, its setup check says which are missing and opens the right pane
of **System Settings › Privacy & Security**:

| Permission | Why |
|---|---|
| Accessibility | To read your apps and act in them, and to move the mouse and type when you lend them |
| Screen Recording | To take screenshots for its tasks and to read other apps' window titles. After allowing it, quit and reopen Ember. macOS asks again about once a month: choose **Allow** |
| Input Monitoring | To notice at once when you take the keyboard back. Without it, Ember won't use the keyboard for you |
| Microphone | Only when you turn on “Hey Ember” |
| Automation (System Events) | Only the first time Ember changes Dark Mode for you |
| Local Network | Only if your organisation's AI service or proxy is on your local network (macOS 15) |

macOS ties each permission to the exact copy of Ember. After you install a new build, Ember can show as switched on
without the permission working: remove Ember from each list with **−** and add it again.

To update, quit Ember, drag the new Ember.app into Applications over the old one, and give the permissions again as
above. To remove Ember, turn off **Start Ember when I log in** in its settings, quit it, remove it from each Privacy &
Security list with **−**, and delete Ember.app from Applications and `~/Library/Application Support/ember` (its
settings, logs and sign-in).

To check this Mac, run Ember's check-up through `open`, so that macOS judges Ember's own permissions (run from
Terminal, `/Applications/Ember.app/Contents/MacOS/Ember --doctor` reports Terminal's instead):

```bash
: > ~/ember-doctor.txt
open -n -W --stdout ~/ember-doctor.txt -a /Applications/Ember.app --args --doctor; cat ~/ember-doctor.txt
```

## Shortcuts

| | Linux | Windows | macOS |
|---|---|---|---|
| Ask Ember | Ctrl+Alt+Space | Win+Alt+Space | Control+Shift+Command+Space |
| Stop everything | Ctrl+Alt+X | Win+Alt+X | Control+Shift+Command+X |
| Settings | Ctrl+Alt+E | Win+Alt+E | Control+Shift+Command+E |
| Microphone off and on | Ctrl+Alt+M | Win+Alt+M | Control+Shift+Command+M |
| Allow, while Ember asks | Ctrl+Alt+Y | Win+Alt+Y | Control+Shift+Command+Y |
| Not now, while Ember asks | Ctrl+Alt+N | Win+Alt+N | Control+Shift+Command+N |

If another app already holds one, the setup check says which, and Ember's handle in the bottom-right corner does the
same things. On Windows, PowerToys' Command Palette uses Win+Alt+Space and Xbox Game Bar uses Win+Alt+M by default.

## Commands, WSL and other computers

Ember can also run commands, work in WSL on Windows, and work on other computers you reach over SSH. Each is off until
you turn it on in settings (**Commands**, **Computers**) and accept the card that says what it means.

- **Commands** run in Ember's own **Ember commands** window, never in your terminal, where you can watch and stop
  them. Most run straight away. Ember stops and asks before anything that deletes or overwrites data, pushes or
  publishes anywhere, touches passwords or keys, changes the system, or downloads and runs code; when you asked for
  exactly that yourself, it says so and gives you 4 seconds to stop it. It reads a shell script before running it, and
  a script that does any of that always asks. It never runs a command that would read or change its own safety
  settings, records or programs, or press keys in its own windows.
- **WSL**: Ember reads and uses the Linux apps WSL shows on Windows, opens them, and runs commands in your distros.
- **Other computers**: on your click, Ember opens its own SSH connection with your SSH settings and keys, copies a
  small helper there (about 31 MB) that runs only while it is connected, and works there: commands, and the apps on
  that computer's screen when you are the person logged in at it, asking before every step. When it sees you `ssh`
  somewhere, it can offer to come along. Your voice and your GitHub sign-in always stay on this computer.

The same switches turn them off, and the stop shortcut stops every command at once. Administrators can turn each off,
or make every command ask, in the organisation policy (`features.wsl`, `features.ssh`, `commands`, `ssh`); an Ember
older than this release locks down when its policy uses those keys. [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md)
has the details, including what Ember can't do yet.

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
