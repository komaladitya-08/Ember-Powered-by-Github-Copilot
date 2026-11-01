# Release notes

## 0.1.0 (2026-10-31)

Ember's first release: a small, expressive companion that lives beside your cursor, listens for "Hey Ember" and does
the work in your real apps where you can watch, without taking over your mouse. It is powered by GitHub Copilot.
[README.md](README.md) says how to install it on each computer.

### Ember

- **Where it runs**: RHEL 8 and its family (Rocky, Alma, Oracle Linux 8) on GNOME with Xorg, as an RPM or an
  AppImage; Windows 10 22H2 and Windows 11 on x64, as a zip (Windows on Arm: best effort); macOS 13 or later on Apple
  silicon, as a dmg or a zip (Intel Macs and macOS 13: best effort).
- **In your real apps**: Ember reads apps through the system's accessibility (AT-SPI on Linux, UI Automation on
  Windows, the accessibility API on a Mac) and screenshots, and uses their controls in the background, so your mouse
  and keyboard stay yours. When an app can't be used that way, it asks to borrow the mouse, and gives it back the
  moment you move. "Show me how…" guides you to each control instead of doing it.
- **It asks first**: before its first action in an app (**Allow**, **Always in this app**, **Not now**), and every
  time before sending, deleting, paying and the like. It never types into password, payment or terminal fields. The
  stop shortcut, "Ember, stop" and **Stop everything** stop everything at once.
- **Questions show what will be typed**: text Ember is about to type shows as it will be typed, real double quotes
  (a formula's `=IF(A1="x";1;0)`), emoji and spaces included, with a line break shown as ⏎ and a tab as ⇥. Other
  quote marks, quote marks set side by side (’’), and characters that show nothing or reorder text are marked in ⟨ ⟩
  (⟨”⟩, ⟨’’⟩, ⟨ZWSP⟩). Text that holds quote marks says how long it is right after the quote, so typed text can't
  pass for Ember's own words. Text over 160 characters shows its first 110 and last 40 characters and its length, and
  all of it in a box under the question (so does each cell's whole value when Ember fills several cells at once):
  **Allow** works once you have scrolled to its end, or it fits ("Scroll down to read it all first."), and until then
  Ember's allow shortcut shows the next part of it (a press within half a second of the last one, or a held key, never
  allows). Screen readers hear all of it, and when **Allow** works. Such a question waits a minute longer for every
  1000 characters of its text (ten with **More time to read and answer**), so there is time to read all of it.
- **Your Mac's permissions stay Ember's**: Ember.app never runs as a plain Node.js program, so another program can't
  start it that way to borrow its Accessibility and Screen Recording permissions.
- **Signing in**: **Sign in with GitHub** shows a code to enter on GitHub's page. A `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`
  or `GITHUB_TOKEN`, or the GitHub CLI's sign-in, works too: a sign-in Copilot refuses gives way to the next, and the
  message names it.
- **Staying signed in**: Ember renews its GitHub sign-in by itself before it runs out, waiting where it can until it
  isn't in the middle of something, and as soon as the computer wakes if it ran out during sleep. Copilot switches to
  the renewed sign-in at once, and a renewed sign-in Ember couldn't save (a full or read-only disk) is still used until
  Ember quits. On a Mac, Ember keeps working while the Keychain asks to open or save the sign-in.
- **Voice**: call Ember by its name ("Ember, open the terminal"; "Hey Ember" and "OK Ember" work too), with speech
  recognition on this computer (Moonshine v2 tiny, punctuated; the models download once, 142 MB, or come with the
  `ember-voice-models` RPM); only the text of a request goes to Copilot. The name heard inside another word
  ("remember", "September", "the embers") shows nothing: a wake by the bare name shows once the recogniser has heard
  the name start what was said. Ember speaks its replies, questions and results in its own natural neural voice (Piper
  "Kristin", made on this computer), sentence by sentence while Copilot is still writing, so it starts talking within
  about a second; until its voice is downloaded, or should it fail, the system's most natural voice speaks (a Natural
  voice on Windows 11, a Premium or Enhanced one on a Mac). It speaks always (the default), when a screen reader runs,
  or never (**Speak replies, questions and results out loud** in Settings › **Voice**; an organisation that turns
  speaking off shows it as Never, managed).
- **Voice Match**: Settings › **Voice** › **Answer only my voice** teaches Ember your voice from four short phrases,
  and from then on it answers only you: a request in another voice (someone else in the room, a call, a video) is
  ignored. "Ember, stop" still works for anyone. Your voiceprint (256 numbers that describe how your voice sounds; it
  can't be turned back into speech) stays on this computer, in `voiceprint.json` in Ember's data folder, readable by
  you alone; **Forget my voice** deletes it. Measured on 40 real speakers (LibriSpeech), Ember turned away 3–4 % of
  the owner's requests and took 2–3 % of other people's.
- **Four characters**: Cinder, Wisp, Glassling and Glint share one rig of twelve emotions. Pick one in setup or
  settings, or ask Ember to switch.
- **Ember's desk** (Linux): a private display where Ember uses a full mouse and keyboard out of your way, which you
  can watch and take over.
- **Accessibility**: Ember works from the keyboard and with screen readers (README.md has every route). Settings ›
  **Comfort & access** has **Text size** (Default, Large, Larger: settings, the bubble, task cards, the handle, the ask
  box, the desk window's bar on Linux, the command window and the password and consent cards), **Calm mode** and
  **More time to read and answer**. Text size also reaches the command window's terminal (13, 15 or 17 px, at once when you change it; a
  running command keeps its columns and rows) and the height of buttons, pop-up buttons and text fields, so larger words
  keep their room. Windows' contrast themes are supported: switches, the slider, the chosen character, button edges,
  tabs, state symbols and keyboard focus stay visible, and first run's **Start Ember** row stays opaque at the window's
  foot, so the terms scrolling under it don't show through. Keyboard focus on filled buttons, checked switches and the
  chosen character shows as a ring with a gap, also under Increase Contrast.
- **For organisations**: a policy (`/etc/ember/policy.json` on Linux, `/Library/Application Support/Ember/policy.json`
  on a Mac, `HKLM\SOFTWARE\Policies\Ember` on Windows) turns features off, and an audit log records every decision
  and action.
- **Setup check**: `ember doctor` and the settings window say what this computer is missing and how to fix it.
  `ember doctor`'s report opens "Ember 0.1.0 setup check" and its rows take the settings window's names (Screen
  reading, Reading and using apps, Microphone, Applications folder…).

### Commands, WSL and other computers

Ember can also run commands for you on this computer, in WSL and on other computers, work with Linux apps in WSL, and
work on other computers you reach over SSH. Each is off until you turn it on and accept its card.
[docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md) has the details.

- **Commands on every computer** (Linux, Windows, macOS, WSL, SSH). They run in Ember's own **Ember commands**
  window, never in your terminal, with live output, a **Stop** button and a record in the audit log. Most run straight
  away. Ember stops and asks before a command that deletes or overwrites data, submits or publishes anywhere (`git
  push`, pull requests, `p4 submit`, package publishing, uploads), deletes from source control or a service, reads or
  changes passwords, keys or other secrets, changes the system or needs privileges, downloads code and runs it, keeps
  running after Ember stops, or that Ember can't read with certainty. The question shows the whole command, with
  invisible characters made visible, and is answered with **Allow** or **Not now** (never "Always", never by voice).
- **The command window**: Tab and Shift+Tab always move between the window's buttons and tabs and never go into the
  command; Ctrl+V pastes into a command that takes typing (Command+V on a Mac), Ctrl+C copies selected output, and
  **Copy output** copies all of it. When a command waits for you to type (a password, a "[y/N]"), its tab says so, the
  window comes up and flashes, and the task's bubble says so as **Needs you**, with **Show**, which brings the command
  window up with the keyboard, and "Or press Alt+Tab to go there." on Linux and Windows; screen readers hear it. Closing
  the window while a command runs asks (**Stop and close** or **Keep it open**), so a command never runs on unseen.
  While a screen reader runs, a command's output is read to it, and an announced command waits 15 seconds before it
  starts; every announcement names the stop chord, or only **Stop** while another app holds the chord, and the spoken
  one names where the command runs as the bubble's badge does (in WSL, or on this computer when your words named
  another). A command the kill switch ended says "Stopped with everything else". One very long line of output doesn't
  freeze Ember, and a run that prints more than 4 MiB doesn't slow the overlay or the stop chord.
- **The command card** says which computer the command runs on, marks a command that deletes data, and underlines
  look-alike letters word by word: your own folders in your alphabet (`C:\Users\Иван`) aren't marked, an address
  spelled in letters that only look Latin (`https://аррӏе.com`) is. Hebrew and Arabic text is shown in the order it
  runs. A command another computer sends back for your OK says "Not run: you didn't allow it." if you don't.
- **Read-only cloud commands run without a card**: `aws s3 ls`, `aws logs tail`, `terraform validate`, `output`,
  `fmt`, `show`, `state list` and `providers`, `kubectl config current-context` and `get-contexts`, `kubectl
  api-resources`, `kubectl rollout status` and `history`, `helm repo list`, `history` and `status`, `gsutil ls`, `gcloud
  storage ls`, `az webapp log tail`, and `ansible-playbook --syntax-check` and `--list-*`. `ansible-playbook --check`,
  `terraform providers mirror` and `lock`, and `terraform init` still ask, and an unknown cloud verb asks with "Ember
  can't tell whether this changes AWS.".
- **Shell scripts are read before they run.** When a command runs a shell script (`sh t.sh`, `./t.sh`, `source`,
  `powershell -File`, a `.bat`), Ember reads it first on the computer that runs it (on another computer over SSH,
  Ember's helper there does) and judges its text like a command: a dangerous script asks, even when you asked for that
  kind of operation. A script the same command writes first, or one this task downloaded, always asks; one this task
  wrote earlier asks when it can't be read in full; other scripts too big to read (over 64 KB) are judged by their name.
  A script also asks when Ember can't read all of it: an sh or bash script's `if`, `for`, `while` and plain `[[ … ]]`
  tests are read through, but `case`, functions, `trap`, `{ … }` groups, a `[[` that compares numbers or uses `-v`,
  zsh's `if`, `for` and `while`, PowerShell's and cmd's `if` and `for`, more than 64 commands or more than 8,000
  characters ask, so most real build and install scripts ask. The card says why ("Ember can't read all of build.sh (it
  has more commands than Ember can check one by one).", "In build.sh: Runs code Ember can't see."); when you named the
  script and that is all the card says, it doesn't add "You didn't ask for this.". A script named with `..` (`sh
  sub/../t.sh`, `cd link && sh ../t.sh`) is read where the computer really runs it (beside the link's target), and asks
  ("Ember can't tell which script this runs.") when the computer can't say where that is; any other path with `..` is
  judged where it really leads too.
- **When you asked for exactly that**, a dangerous command runs after an announcement with a 4-second **Stop** (15
  seconds while a screen reader runs) ("Pushing feature-x to origin, as you asked."). Only your own words count, only
  when they ask for it, and only for what they name: "delete build/", "please delete build/", "can you delete build/?"
  and "I want to delete build/" announce; a question ("should I delete build/?"), a how-to, something already done ("I
  pushed my branch"), a maybe ("I might delete build/ later") and words about something else ("fix the script that
  deletes build/") ask. "delete build/" (with the slash) or "delete the build folder" covers `rm -r build`, plain
  "delete build" asks. Typed words count everywhere, spoken ones only where Ember can tell your voice from what your
  speakers play (Linux with speaker rejection on and parec installed). On Windows, on macOS and on Linux without it, a
  dangerous command you asked for by voice asks with the card, as a call, a video or Ember's own voice could say the
  same words. Secrets, downloading and running code, commands that outlive Ember and anything Ember can't read always
  ask. If your words also name another computer, or a place that looks like one Ember doesn't know ("delete build/ on
  prod-db", "from the server web-2", "at deploy@10.0.0.5", "prod-db: …"), nothing in that task runs on an announcement:
  every dangerous command asks, and the card says first where it runs ("It looks like you named another computer
  (prod-db), but this runs on this computer."). A folder or a branch the computer shows isn't a computer: "delete build/
  in my-app" works on this computer when my-app is a folder where the task works or one it is in, and announces only for
  the build directly in my-app (and "on feature-x" when feature-x is the folder's branch). On a Windows PC without WSL
  turned on in Ember, "WSL", "Linux" and "the Linux side" keep a task on this computer, and count as another computer
  for dangerous commands, which ask.
- **Naming a computer**: "on build-01, …", "in Ubuntu, …" or "build-01: …" picks it for the task; "this computer" and
  "locally" mean this one. A bare "here" keeps the task on the computer picked in **Work on**. A computer added by
  its full name also answers to its first part ("on build-01" for build-01.example.com), and a distribution's WSL
  distro to its first word ("in Ubuntu" for Ubuntu-22.04); a distro you imported, such as build-env, answers only to
  its full name. A longer name wins only when written as one name: "on db-01, back up…" with db-01 and db-01-backup
  added asks which one. Adding a computer Ember already has under another spelling connects the one it has and says
  "Already added as build-01".
- **What Ember never runs**: commands that would read or change Ember's own safety settings, records or programs
  ("Ember won't run this: it would read …" or "… change …"), or press keys and click in Ember's windows.
- **Command output** goes to Copilot as untrusted data, at most 200 lines, with what you typed cut out, output after a
  password prompt withheld, and recognised passwords, keys and tokens hidden, including the value given to an option
  named like a secret (`--db-pass=…`, `--api-token=…`). Output that reads like instructions to
  Ember makes every further command in that task ask; ordinary system reports (`hostnamectl`, `docker info`, `kubectl
  describe node`, `inxi`) don't, while lines that look like a transcript ("System:", "Assistant:") still do.
- **What Ember did** in settings lists each command's question, answer, refusal and end (where it ran, the shell and
  how it ended, never the command's text), and each connection made, lost, ended or failed; a reconnect that gives up
  is one line ("Reconnect to build-01"), and removing Ember's helper is a line too. Its reasons speak to you ("your
  never-look list", "…wasn't yours."). When Ember won't type into a terminal, it says it doesn't use terminal windows
  and runs commands in its own command window when **Commands** is on.
- **WSL** (Windows): Ember reads and uses the Linux apps WSLg shows ("gedit (Ubuntu)"), opens them from their Start
  menu entries, and runs commands in your distros. Each distro that has a Linux app open gets a small helper while one
  is open; Ember never starts a distro to read it. A Linux app Ember can't identify is refused and blacked out of
  screenshots like a Remote Desktop window, and so are Linux apps shown by an X server on Windows (VcXsrv, X410,
  Xming, GWSL, Cygwin/X). The first command in a stopped distro starts it, and the task's bubble and the command
  window say "Starting Ubuntu…" meanwhile: a line above the tabs while Ember checks the command, then the command's
  tab.
- **First-use cards** (commands, WSL, SSH) open big enough to show the whole card on most screens, and **Turn on** or
  **Connect** works only once the whole card has been in view ("Scroll down to read it all first."), at Large or
  Larger text on a short screen too, as a command card's **Allow** does. A card Ember couldn't show changes nothing and
  says so: "Ember couldn't show the card that asks you first, so nothing changed." (when connecting, in the bubble with
  **Try again**). With your organisation's own model service, the cards name it instead of GitHub Copilot.
- **Other computers over SSH**: add a computer in Settings › **Computers**, or accept Ember's offer when it sees you
  `ssh` somewhere ("You're connected to build-01"). Ember looks for your own `ssh` only once you have added a computer,
  and never offers for one that carries a command (git over ssh, `scp`, `rsync`), uses `-T` or goes to a git hosting
  service. An offer goes after 25 seconds as **Not now**, ignores a press in its first half second, and holds Ember
  still while it is up; one nobody asked for waits while "Lost build-01" or "Can't connect to build-01" is up, but
  25 seconds at most, and it goes, up or waiting, the next time Ember looks and finds the `ssh` it names has ended. The
  SSH card says what changed when your SSH settings send the name somewhere else, names the helper's folder on a Mac,
  and says that a server with no desktop gets commands only. Ember opens its own connection with your SSH settings,
  keys, agent and jump hosts, asks for passwords in its own window and never keeps them (one at a time: a sign-in
  that gives up while it waits its turn no longer holds up the ones after it), checks the other computer
  before copying anything, then copies a helper there (about 33 MB, unpacked to about 130 MB) that runs only while it is
  connected and leaves no service or autostart behind. It works there on commands, and on the apps of that computer's
  screen when it is a Linux computer with an X11 desktop and you are the person logged in at it, asking before every
  step and showing a notice with **Stop** there. When that screen locks or its session goes inactive, the tasks using
  the screen stop; a task only running commands there goes on (a **Stop** at that computer, a lost connection,
  **Disconnect** and the stop chord stop everything there). Your voice, Copilot and your GitHub sign-in stay on this
  computer. Its **Remove helper** in Settings › **Computers** removes the helper again.
- **SSH connections, in detail**: with OpenSSH older than 8.5 on this computer (RHEL 8, Ubuntu 20.04, Debian 11),
  every password or code is shown as "build-01 asks" with the question quoted, never as "Unlock your SSH key", because
  those clients can't mark a server's own questions. The sign-in, host-key and consent cards take the keyboard on
  macOS and Windows too; if another app keeps it, the card and a notification say so before you type. **Cancel** or
  Esc on a sign-in card ends the connection quietly, and a sign-in card Ember can't show, "Is this really build-01?"
  included and also when the card's window crashes, ends it with "Ember couldn't show build-01's sign-in question." and
  **Try again**. A silent connection shows "build-01 isn't answering" in the
  bubble and a countdown on each running command's tab. A command that prints faster than the connection can carry is
  paused until its output catches up; a stopped command that keeps printing past that limit has the rest dropped. When
  reconnecting needs you to sign in, Ember stops trying and says "build-01 needs you to sign in again", with
  **Reconnect**. If **Bring Ember** can't connect, the bubble says why. A Node.js download that gets nothing for 60
  seconds ends with "The download of what Ember needs for build-01 stalled. Try again."
- **Settings**: **Computers** and **Commands** sections (per-computer switches, **Ask me before every command**,
  **Offer to bring Ember along when I connect with SSH**). The handle menu has **Work on** (with more than one
  computer), **Bring Ember to a computer…** (whenever SSH is allowed; it opens Settings › **Computers** ready to type a
  host) and **Disconnect build-01**, and a computer that is connecting can be cancelled from it; the handle, task cards
  and questions say where Ember works. In **Computers**, **Remove helper** asks first, says it stops anything running
  there and forgets the computer here, shows "Removing Ember's helper…" with a **Cancel**, and says when it is done;
  **Forget** asks first too. Rows say "Connected, commands off" (with what to do, or your organisation's line when it
  turned commands off over SSH) and "Connected, but not answering"; a distro reads "Off" while WSL is off in Ember, and
  the default distro is marked "default for “in WSL”".
- **Setup check** (`ember doctor` and the settings window): rows for the SSH client, the command window's
  terminal (`script`), PowerShell, WSL and each running distro's Linux apps and accessibility (with a button in the
  setup check that turns accessibility on there, refused when your organisation has turned WSL or commands in WSL
  off), the helper for other computers, and a connected Mac's protected folders. With WSL off in Ember's settings, the
  setup check doesn't look inside your distros.
- **Tested on real runners**: CI runs the SSH, WSL and commands suites on pull requests, `main` and release tags,
  including RHEL 8's OpenSSH 8.0 client, password sign-in and a Linux arm64 computer (docs/DEVELOPING.md §14.4).

#### For administrators

The organisation policy has these keys for them. Compared with having no policy, none of them makes Ember less strict;
but a policy that exists and doesn't mention `commands` turns commands off (below), so adding `commands` is what
allows them.

| Key | Effect |
|---|---|
| `features.wsl` | `false`: no WSL (Linux apps, the WSL computer, WSL commands) |
| `features.ssh` | `false`: no connecting to other computers; in a remote computer's own policy, Ember is refused there |
| `commands.local`, `commands.wsl`, `commands.ssh` | `"on"` (the user still turns them on), `"ask"` (every command asks) or `"off"`, per kind of computer |
| `ssh.allowedHosts` | Patterns (`*`, `?`) of the only computers Ember may connect to, matched against `user@host:port`, `host:port` and `host` |
| `ssh.desktop` | `false`: commands only on remote computers, no desktop |
| `ssh.requireConsoleConsent` | In a remote computer's policy: a person at its screen must allow Ember first |
| `ssh.runtimeMirror` | An `https://` mirror of nodejs.org for the Node.js the helper runs on (still SHA-256-checked) |
| `ssh.commandGraceSeconds` | 3 to 120 (default 20): how long a remote command survives a silent connection |

```json
{
  "features": { "ssh": true, "wsl": false },
  "commands": { "local": "off", "ssh": "ask" },
  "ssh": { "allowedHosts": ["*.build.example.com"], "desktop": false }
}
```

- With no policy, WSL, SSH and commands are available to users who turn them on. **A policy that doesn't mention
  `commands` turns commands off on every kind of computer**: add `"commands"` to allow them. `features.actions: false`
  turns them off too.
- A computer Ember connects to is bound by its own policy as well (`/etc/ember/policy.json`, or
  `/Library/Application Support/Ember/policy.json` on a Mac): the stricter of the two applies, and a broken one there
  refuses Ember.
- **An older Ember locks down when it reads a policy with these keys.** The policy schema is strict, so an Ember from
  before this release (a pre-release build) reads `features.wsl`, `features.ssh`, `commands` or `ssh` as a mistake and
  locks down (no actions, no listening) until the policy is fixed or Ember is updated. Update Ember on every computer
  before deploying a policy that uses them.

### In detail

#### Signing in and Copilot

- When Copilot refuses the sign-in partway through a session, the handle says "Sign-in refused", and settings offer
  **Sign in** and **Check again**. A refused `GITHUB_TOKEN` or `GH_TOKEN` gives way to the GitHub CLI's sign-in and is
  named in the message; the GitHub CLI is asked for github.com's token.
- A sign-in survives a network blip while it waits for your approval, and one Ember can't save still connects for
  this run. If GitHub refuses Ember's sign-in request, Ember says so instead of showing a code: "GitHub didn't accept
  Ember's sign-in request. Make sure Ember is up to date, or run “gh auth login” in a terminal and press Check
  again." Passing Copilot problems while connecting (its server's errors, rate limits, timeouts) are tried again by
  themselves.
- Copilot's errors are shown in plain words, and problems with your organisation's own model service are titled with
  its name, never Copilot's. A notice that Ember can't reach Copilot, or needs you to sign in, goes as soon as Copilot
  is back or you have signed in.
- Default models are chosen with cost in mind, and settings mark the models that cost more than one premium request.
- A finished task's Copilot session, which holds the screen text the task read, is deleted as soon as the task ends.
- A "show me" guide starts at once, beside tasks that are running.

#### Safety and privacy

- Every setting changed in GNOME Settings, Windows Settings or macOS System Settings asks first, every time. On a Mac
  in German, and in any language where Apple writes an app's name with a soft hyphen, Ember recognises System
  Settings and security apps by that name and asks before every setting it changes there; the never-look list matches
  such names however they are written.
- In File Explorer and Finder, Ember never opens an item whose name shows no file type, because it may be a program,
  and it asks every time before opening one that shows a document's type. Folders are opened by their path, from
  Explorer's navigation pane, or from Finder's sidebar places.
- Remote-desktop and virtual-machine viewers on Linux and macOS (Remmina, virt-manager, Boxes, VNC and RDP viewers,
  Screen Sharing, UTM, Parallels, VMware, VirtualBox…) are treated like Windows' Remote Desktop: Ember never acts in
  them and blacks them out of screenshots.
- While this computer's screen is locked, or another session is in front, Ember doesn't listen for "Hey Ember",
  doesn't speak, takes no requests ("Your screen is locked, so I didn't take that.") and doesn't read this computer's
  screen, open apps on it or change its settings, even for a request already under way. Tasks that used the screen
  stop, and are reported once you're back; a task running only commands goes on.
- On Linux, Ember refuses Ctrl+Alt with a key not named in Latin letters (another script's letter, or an accented
  one), which another keyboard layout could put on Ctrl+Alt+T or on Ember's own shortcuts.
- Quote marks in names can't rewrite a question, and a slider's new value is quoted.
- In PowerShell, a backtick before a line break inside a word is read as PowerShell reads it: the word keeps the line
  break, so ``git`<line break>status`` is never taken for `git status`, and after a Windows (CRLF) line break the next
  line is checked as a command of its own.
- Secret fields are recognised by more words: wallet seed and recovery phrases, "6-digit code" and other two-factor
  prompts, security, session, refresh and ID tokens, master and SSH keys, JWTs, webhook, private, GPG and SSH signing
  keys, and show-password switches in Korean, Danish, Norwegian, Hungarian, Romanian, Greek, Vietnamese, Indonesian,
  Arabic, Hebrew and Thai. On Windows and macOS, as on Linux, a name that carries a secret field's value is withheld.
- The never-look list's 'keeper', 'seahorse' and 'strongbox' match those apps, and a window title only where a word
  starts with them, so a page titled "Housekeeper wanted" isn't taken for a password manager and Keeper's web vault
  ("My Vault | Keeper") stays private, whether the word is a default or you added it. The first-run terms name only
  what the never-look list covers ("App windows on your never-look list and password prompts are never read. The list
  is in settings, and common password managers are on it already."), and say that the audit record includes what you
  asked each task to do and how it went.
- A screenshot of a window Ember can't find takes no picture, and says only that the window can't be found.
- DevTools can't be opened in an installed Ember.

#### Ember on screen

- While tasks run, the handle says "Working on 1 task…" or "Working on 3 tasks…"; a reason Ember can't answer you,
  such as "Waiting for tasks" or "Reconnecting…", still shows first. A task waiting its turn behind running ones shows
  a grey clock and "Waiting its turn".
- A task card's **Stop** is larger and red-tinted, and shows "Stopping…" the moment you press it; a long result keeps
  to four lines on its card. After **Stop everything**, the bubble names any part still stopping (commands, a
  computer reached over SSH…).
- The status pill moves to the bottom of the screen when it would cover the control Ember is typing into or clicking,
  and the task cards move to the other bottom corner. With more than one display, Ember keeps clear only of the task cards on
  its own display, and shows its bubble only on the display it is on. Ember and its bubble also step clear of the
  command window and of the sign-in and consent cards while they ask.
- **Handle position** in Settings › **Comfort & access** puts Ember's handle in the bottom-right corner (as before)
  or the bottom-left one, clear of the taskbar, Dock or panel, so it no longer has to cover a status bar or scroll
  corner there; **Move to the other side** in the handle's menu switches it. The small tab while Ember is hidden, the
  card without a compositor and the task cards follow it, and on Linux the desk view takes the other corner.
- **Hide Ember** shrinks the handle to a small tab showing Ember's face, and a question or an answer that brings a
  hidden Ember back makes the handle the full pill again. In the desk window, once you take over, a screen reader is
  told that your keys go to the desk and that Ctrl+Alt+End hands it back.
- On a Mac, the Command key is called Command everywhere. Notifications too long to show end at a word, with an
  ellipsis.
- The handle's microphone badge has a shape for each state (listening, muted, starting, problem) and is read out. A
  microphone problem, or voice not being set up, shows on the handle's line, and its menu offers "Microphone problem:
  open Settings…".
- At the Large and Larger text sizes, an answer that needs more than six lines at that size offers **Read all**. With
  **More time to read and answer**, a bubble that waited behind another or was covered stays ten times its time, and
  so do Ember's own notices (the screen-lock notices, "I can't take screenshots", the "Commands are off" hint).
- When another app already holds one of Ember's shortcuts, Ember takes its fallback: on Linux and Windows the same
  chord with Shift (Ctrl+Alt+Shift+Space, Win+Alt+Shift+Space); on a Mac Control+Shift+Command with another key,
  never Option, which is VoiceOver's (Control+Shift+Command+A asks, +Period stops, +Comma opens settings). The setup
  check ("Ctrl+Alt+Space is taken by another app, so Ask Ember is Ctrl+Alt+Shift+Space"), the greeting, the handle's
  menu, settings, the consent cards and every hint name the chord it holds.
- **Ask Ember** is in the system's own launcher: the app menu's right-click on Linux, the jump list of Ember's
  taskbar icon on Windows (once Ember is pinned to the taskbar, or while its settings, command, or password and consent window is open) and
  the Dock menu on a Mac. `ember --ask` (`Ember.exe --ask`) opens the ask box, starting Ember if needed.
- While another app holds Ember's stop or settings shortcut and its fallback, the bubble, the command window and task
  results don't name it: they say "in Ember's settings", and an announced command names only its **Stop**.
- "May I?" questions name controls in plain words: "Click the “Save” button", "Turn on the “Night Light” switch",
  "Tick the “Bold” checkbox", "on the “report.odt” window".
- Calm mode also stops the springs and fades of the ask box, the command and card windows and the desk view, and
  Ember's movement follows the desktop's reduce-motion setting as soon as it changes.
- Ember's title bars are dark on Windows, macOS and GNOME, whatever the system's appearance; menus and dialogs are
  dark on macOS, and menus on Windows (on Linux they follow the GTK theme, and Windows' message boxes stay light). The
  app icon is simpler at 16 to 32 pixels, so it holds on dark taskbars, and on Linux every Ember window carries it.

#### The ask box

- It keeps a paste's lines and grows to four lines. A paste cut at 2,000 characters says so on a line of its own, and
  the line that says what Ember will see keeps the window's name (it shortens what else is sent, and another
  computer's name but never its state).
- A right-click in it offers **Cut**, **Copy**, **Paste** and **Select all**; dismissing that menu by clicking another
  app puts the box away instead of taking the keyboard back.
- On Windows and macOS it takes the keyboard sooner: it shows before Ember reads the screen. Letters typed before it
  appears still go to the app underneath (on Linux, Ember holds them for the box), so the first five times it opens
  there it says to wait for it before typing. Letters typed into it as it opens are kept: what was left in it from
  last time is selected when it closes, not as it opens.
- It follows **Text size**: at Large and Larger the box is wider, and its words and lines are larger.
- It stays up while the keyboard is being handed to it (on Windows, a moment after it appears), and on a Mac a click in
  another app puts it away even in that moment. On a Mac, the text you had selected in a field is what goes with your
  question.

#### Voice

- Where Ember can't tell its own voice from yours (Windows, macOS, and Linux without parec), spoken announcements name
  the stop shortcut ("Press Windows key, Alt, X to cancel.") instead of "Say 'Ember, stop'".
- A microphone that sends only silence (muted, or the wrong input) is reported instead of "Listening for 'Hey Ember'".
- Damaged speech models show "The speech models look damaged. Download them again.", and the download repairs them.
  Models installed with Ember are never changed: the download goes to your own models folder, and shows "Unpacking
  speech models… N%" after its last byte.
- On Linux, speaker rejection follows the default sound output when it changes (`pactl`, from `pulseaudio-utils`, as
  `parec` is), and keeps that output from idle-suspending while Ember listens.
- Voice starts again by itself when it stops answering or its speech recognition keeps failing (after 1, 5, then 30
  seconds).

#### Seeing and using apps

- Ctrl+Alt+Space opens the ask box when Caps Lock or the Windows key is remapped to Ctrl or Alt. Ctrl+1, Alt+1 and the
  like don't add Shift on French, Belgian or Czech layouts (Windows, Linux). Ember's clicks stay left clicks under a
  left-handed button map on X11. Quitting Ember in the middle of a borrow puts the pointer and the keyboard back.
- On Linux, while GNOME's Typing Assist (Slow Keys, Bounce Keys or Sticky Keys) is on, Ember won't use the keyboard on
  your screen, because its keys would be lost or changed: it refuses keys and typing before it brings your window to the
  front, clicks or touches the clipboard, and never switches Sticky Keys off. The setup check shows a Typing warning.
  Typing uses the keyboard layout of the window it types into, so it works when your own window uses another layout
  (GNOME's "Switch input sources individually for each window").
- On macOS, an input method (Japanese, Pinyin, Korean…) stops only typing: Ember still clicks, scrolls and presses
  Command shortcuts. Without the Screen Recording permission, Ember says so instead of "the window is off screen", and
  once a run shows "I can't take screenshots" with a button to the setup check. Secure keyboard entry is named, with
  the app that holds it, instead of "a system dialog", in a **Secure input** row of the setup check too.
- On a Mac in another language, Ember finds Apple's apps by their names there (Calculator as Rechner, System Settings as
  Systemeinstellungen in German) and recognises their windows. It reads its saved sign-in without freezing while the
  Keychain asks after an update, says when the Keychain refused, and shows "Reading your saved sign-in from the
  keychain…" only on the first start after an update.
- On Windows and macOS, the first screenshot with Ember's marks on a new computer doesn't wait seconds for the font
  cache: Ember builds it once in the background shortly after it starts.
- On Windows, Ember reads long lists and pages that are scrolled down: it reads what shows in full and leaves most of
  what is scrolled away out, so a list of thousands of rows or a very big page no longer reads as empty, and its
  screenshot isn't refused.
- On Windows, Start Menu shortcuts saved in the system's own code page (older installers in Cyrillic, Greek and other
  languages) are read in it, so those apps can be opened by name.
- On Linux, a window that closes while Ember is reading it or using it no longer makes Ember exit.
- Windows' setup check has a **Microphone** row, and the Voice section a button to the microphone's privacy settings;
  the advice names both Windows 10's and Windows 11's page. The advice for mixed display scaling gives a way round it
  and the issue tracker's address.

#### Settings, first run and the setup check

- In first run, whatever you move to with Tab scrolls clear of the **Start Ember** row at every text size, window width
  and zoom. The setup check stays on the first-run screen until **Start** while something needs you. After **Start**,
  settings stays at the setup check while a row holds Ember back, Ember's hello names it, and the handle says "Setup
  needed".
- A settings change that can't be saved (a full disk, a folder that can't be written) is explained in the settings
  window, and the control goes back to the setting in use; a size-slider change that couldn't be saved is saved with
  the next change.
- With commands off, Ember points to Settings › **Commands**, in a hint after the answer that prompted it, for the
  hint's whole time.
- On Windows and Linux, Ember's windows have no menu bar: Ctrl+Q doesn't quit from a window (use **Quit Ember** on the
  handle's menu, which asks first while something is running), and Ctrl+R, Ctrl+W, F11, Ctrl+Shift+I and the Alt menu
  bar do nothing. The settings window zooms with Ctrl+= or Ctrl++, Ctrl+- and Ctrl+0 (back to 100 %), from 58 % to
  249 %. On a Mac, the Ember menu has **About Ember**, and the app is signed ad hoc under the hardened runtime.
- Quitting while tasks run asks first, and says that quitting stops them where they are.
- The setup check's X session row fails when the display can't be opened, instead of saying the session is fine, and
  `ember doctor` exits with 1 when one of its checks can't finish, instead of waiting.

#### Starting, updating and your data

- When Ember can't write its data folder (owned by root after `sudo ember`, a read-only home, a full disk), it says so
  in a dialog and exits with 1.
- `settings.json` and `/etc/ember/policy.json` saved with a byte-order mark or as UTF-16 (as Windows PowerShell 5.1's
  `Set-Content` and `Out-File` write them) are read as they are. A `settings.json` that can't be read at start-up is
  never replaced with defaults: Ember says so, keeps changes in memory and saves them over your settings once the file
  reads again.
- Ember never deletes an `~/.config/autostart/ember.desktop` it didn't make: its own is marked
  `X-Ember-Managed=true` (an entry an older Ember wrote with Windows line endings counts as its own too), and the
  settings window says when another entry starts it at login. Starting at login starts the Ember you turned it on in,
  never an AppImage whose name Ember only inherited from the program that started it.
- Audit entries are kept for `auditRetentionDays` by their own time, not by whole months, and pruned at start and once a
  day, without losing lines another process writes meanwhile. An old month that can't be removed (a file another program
  holds open on Windows) doesn't stop the other old months being pruned, on this computer or on a remote, and on a
  remote the audit log stays open when pruning fails, so steps and commands are still recorded. When the audit log can't
  be written, a task stops with a plain sentence; a step already taken is reported as done, and the task queue keeps
  moving.
- `EMBER_LOG_LEVEL` takes `debug`, `info`, `warn` or `error` in any case; anything else means `info`, and is logged.
  GPU, utility and page crashes are logged (`app.child_process_gone`, `window.renderer_gone`), a crashed SSH sign-in
  or consent window closes instead of staying blank, and a command window whose page crashes comes back with its
  commands instead of closing. While it is blank, the allow shortcut doesn't allow its question and a command counting
  down there doesn't run; Ember then says the command window couldn't show it to the end, not that you stopped it.
- Ember's windows load from a folder whose name has a % in it (for example "100% Free" or "50%AB").
- Linux RPM: when an update replaces Ember's files while it runs, Ember offers to restart, and dnf says so too.
  AppImage: Ember starts without Chromium's sandbox where unprivileged user namespaces are off (Debian's
  `kernel.unprivileged_userns_clone=0` too), and the setup check warns instead of failing.
- The packages carry the licence texts for the Copilot SDK, koffi's builds for each platform and sherpa-onnx, whose
  WebAssembly includes eSpeak NG under GPL-3.0-or-later; the RPM's License tag names GPL-3.0-or-later.

#### For organisations

- When the policy can't be read or has a mistake, Ember locks down: no actions, commands or listening, no model
  service (neither GitHub Copilot nor the organisation's own endpoint) and no audit records deleted, until the policy
  is fixed. An unknown key's message says this Ember may be older than the policy.
- Ember reads the policy again every 10 seconds. When it changes, and the next read confirms it, Ember stops
  everything and stays locked down until the user clicks **Restart Ember**, which reads the new policy whole.
  **What Ember did** records "Everything stopped: your organisation changed Ember's policy".
- `confirmEveryAction` asks before every command too, on this computer, in WSL and over SSH.
- The RPM's example policy (`/usr/share/doc/ember/policy.example.json`) turns commands on for this computer, WSL and
  SSH, and has notes beside it (`policy.README`).

### Limits you may meet

- Ember isn't signed yet: Windows (SmartScreen, Smart App Control) and macOS (Gatekeeper) stop its first start, and
  the README says what to do. On a Mac, permissions belong to the exact copy of Ember, so after an update give them
  again.
- On Linux, Ember needs GNOME on Xorg. In a Wayland session it says so, takes no screenshots and doesn't borrow the
  mouse or keyboard; reading apps still works.
- A granted browser has no confirmation for new domains or downloads, and the policy has no domain rules.
- An app's own popups over its window (menus, lists, autofill panels) are checked for secret fields only when the
  system's accessibility lists them as windows; macOS menus and some Windows popups aren't, and are pictured as they
  are.
- On Windows and macOS, text you select in a web page doesn't go with what you ask: Ember notes the page you were in,
  not what you selected there.
- On Windows and macOS, tools that work by capturing the screen (TeamViewer, AnyDesk, Quick Assist, VNC, magnifiers)
  show a blank space where the command window and Ember's small cards are: they are left out of screen captures, so
  no other app records a command's output or a card. Remote Desktop shows them.
- Each of commands, WSL and SSH asks with its own card when you turn it on (WSL once, each SSH computer, commands on
  each computer), not on the "Before Ember starts" page.
- Ember can't see when a program turns off echo for a password: it cuts everything you type out of what Copilot gets,
  and withholds the output after a password-like prompt, which may hide a little more than needed.
- On Windows, commands run in Windows PowerShell 5.1 only and can't take typing, so they can't ask you for a password
  or an answer.
- On a remote Linux screen, every step is asked, Ember never borrows the mouse and keyboard, and you aren't shown the
  screen.
- A remote Linux computer with a Wayland desktop gets commands only for now; reading and using its controls (with no
  screenshots) waits for Ember's Wayland test to pass.
- A Mac reached over SSH gets commands only, and they can't open Desktop, Documents or Downloads without "Allow full
  disk access for remote users"; Windows computers can't be reached over SSH yet.
- Ember doesn't use the mouse or keyboard in Linux apps under WSL yet (it uses their controls), and doesn't use Linux
  apps shown by an X server at all.
- Ember judges the command line it can see and the shell scripts it can read (up to 64 KB): a build file, a program, a
  script in another language or a larger shell script runs like a build unless its name says publish, delete, install
  or the like (a script this task downloaded always asks, and one it wrote asks when it can't be read in full).
  Writes Ember can't see (`uudecode`, `split`, `base64 -o` on a Mac, a program that generates a script such as
  `python gen.py`) don't make a script the task's own, so a padded script made that way runs by its name. Over SSH,
  Ember's helper forgets what a task wrote or downloaded when it restarts on a reconnect, so a padded script written
  before the reconnect runs unread after it.
- `set -P`, `set -o physical`, zsh's `chase_links` or `chase_dots`, a command that sets or removes `PWD`, and `env -i`
  ask, because they make later `cd`s go where Ember doesn't follow; after `cd -P` in a longer command, and in what
  `env -C` runs, a relative name asks.
- Commands run without your shell profile, so aliases and tools set up there (conda, nvm, pyenv) are missing; on a Mac
  Homebrew's folders are added.
- Stop can miss a program that leaves on purpose (detached, run as another user, handed to a service); Ember asks
  before the forms it recognises (`nohup`, `setsid`, `&`, `sudo`, `docker run -d`…), but not before a program that
  detaches by itself. Over SSH, a command survives a silent connection for up to 20 seconds (an administrator can
  set 3 to 120). If Ember itself crashes, a command on Linux or macOS (or in WSL) runs on until it writes output or
  ends (newer `script` versions don't end it); on Windows it ends with Ember.
- Another always-on-top window could cover the command card; the approve keys work only while the card shows the
  whole command.
- The account on a remote computer (and root there) can see and change Ember's helper; nothing from it can approve
  anything or run anything on your PC.
- Other programs of yours can reach Ember's SSH password channel, a shared SSH connection and a running command's
  text, as they can already use your keys.
- On a Windows PC, Ember's SSH password window needs OpenSSH 8.4 or newer; with older clients, use keys and the
  ssh-agent, and accept a new computer's key once with `ssh build-01` in a terminal.
- Remote screenshots travel as PNG, so they are slower on slow connections (they are masked before they leave).
- Ember doesn't use a remote screen as root, or the Linux apps of a distro whose default user is root; commands there
  ask every time.
- Interactive programs (vim, less, top, a REPL) ask, and you use them yourself in the command window.
- Commands in WSL can reach your Windows files and programs; the card says so.
- A task works on one computer; text read on one computer and typed on another is always asked about.
- VNC and xrdp desktops on remote computers aren't used: commands only there.
- `ssh` typed in a WSL tab is noticed, but Ember connects with Windows' SSH unless connecting through the distro is
  proven; through a distro, keys and the agent only.
- A remote that is WSL on another PC gets commands only.
- On hardened remotes (fapolicyd, confined SELinux users, `noexec` home folders) the administrator must trust Ember's
  helper before it can run.
- A link changed between Ember's check of a path and the command's run isn't caught.
- A chain of ordinary commands steered by subtle output can still run; dangerous ones always show the whole command.
