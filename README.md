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
(Windows would drop its input there). It never acts in Remote Desktop windows or in Linux apps that WSL shows on
Windows, and blacks them out of its screenshots, because it can't tell what runs inside them.

To check this computer, open a Command Prompt or PowerShell in the `Ember` folder and run `.\ember-doctor.cmd`.

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

Ember needs these permissions. Its setup check says which are missing and opens the right pane of **System Settings
› Privacy & Security** for each:

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

## Develop

```bash
npm ci && npm run dev      # needs Node 22 and npm 11, see docs/DEVELOPING.md
```

- **[PLAN.md](PLAN.md)**: the frozen v1 plan, task list and progress (Windows and macOS: milestone M11)
- [docs/DEVELOPING.md](docs/DEVELOPING.md): set up a development machine (RHEL 8.4 §1–§9, Windows §10, macOS §11)
- [docs/RESEARCH.md](docs/RESEARCH.md): background research and evidence
- [docs/DESIGN.md](docs/DESIGN.md): characters, emotions and motion
- `demo/character-lab`: interactive character prototype (`npm run build:lab`)
