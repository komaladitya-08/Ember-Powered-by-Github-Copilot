# Release notes

## Unreleased: commands, WSL and other computers

Ember can now run commands for you on this computer, in WSL and on other computers, work with Linux apps in WSL, and
work on other computers you reach over SSH. Each is off until you turn it on and accept its card.
[docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md) has the details.

### New

- **Commands on every computer** (Linux, Windows, macOS, WSL, SSH). They run in Ember's own **Ember commands**
  window, never in your terminal, with live output, a **Stop** button and a record in the audit log. Most run straight
  away. Ember stops and asks before a command that deletes or overwrites data, submits or publishes anywhere (`git
  push`, pull requests, `p4 submit`, package publishing, uploads), deletes from source control or a service, reads or
  changes passwords, keys or other secrets, changes the system or needs privileges, downloads code and runs it, keeps
  running after Ember stops, or that Ember can't read with certainty. The question shows the whole command, with
  invisible characters made visible, and is answered with **Allow** or **Not now** (never "Always", never by voice).
- **Shell scripts are read before they run.** When a command runs a shell script (`sh t.sh`, `./t.sh`, `source`,
  `powershell -File`, a `.bat`), Ember reads it first on the computer that runs it (on another computer over SSH,
  Ember's helper there does) and judges its text like a command: a dangerous script asks, even when you asked for that
  kind of operation. A script the same command writes first, or one this task downloaded, always asks; one this task
  wrote earlier asks when it can't be read in full; other scripts too big to read (over 64 KB) are judged by their
  name as before. A script named with `..` (`sh sub/../t.sh`, `cd link && sh ../t.sh`) is read where the computer
  really runs it (beside the link's target), and asks ("Ember can't tell which script this runs.") when the computer
  can't say where that is; any other path with `..` is judged where it really leads too.
- **When you asked for exactly that**, a dangerous command runs after an announcement with a 4-second **Stop**
  ("Pushing feature-x to origin, as you asked."). Only your own typed or spoken words count, and only for what they
  name: "delete build/" (with the slash) or "delete the build folder" covers `rm -r build`, plain "delete build" asks.
  Secrets, downloading and running code, commands that outlive Ember and anything Ember can't read always ask. If your
  words also name another computer, or a place that looks like one Ember doesn't know ("delete build/ on prod-db",
  "from the server web-2", "at deploy@10.0.0.5", "prod-db: …"), nothing in that task runs on an announcement: every
  dangerous command asks, and the card says first where it runs ("You named prod-db, but this runs on this
  computer."). On a Windows PC without WSL turned on in Ember, "WSL", "Linux" and "the Linux side" keep a task on this
  computer, and count as another computer for dangerous commands, which ask.
- **Naming a computer**: "on build-01, …", "in Ubuntu, …" or "build-01: …" picks it for the task; "this computer" and
  "locally" mean this one. A bare "here" keeps the task on the computer picked in **Work on**.
- **What Ember never runs**: commands that would read or change Ember's own safety settings, records or programs
  ("Ember won't run this: it would read …" or "… change …"), or press keys and click in Ember's windows.
- **Command output** goes to Copilot as untrusted data, at most 200 lines, with what you typed cut out, output after a
  password prompt withheld, and recognised passwords, keys and tokens hidden. Output that reads like instructions to
  Ember makes every further command in that task ask.
- **WSL** (Windows): Ember reads and uses the Linux apps WSLg shows ("gedit (Ubuntu)"), opens them from their Start
  menu entries, and runs commands in your distros. Each distro that has a Linux app open gets a small helper while one
  is open; Ember never starts a distro to read it. The first command in a stopped distro starts it, and the task's
  bubble and the command window say "Starting Ubuntu…" meanwhile: a line above the tabs while Ember checks the
  command, then the command's tab.
- **Other computers over SSH**: add a computer in Settings › **Computers**, or accept Ember's offer when it sees you
  `ssh` somewhere ("You're connected to build-01"). Ember opens its own connection with your SSH settings, keys, agent
  and jump hosts, asks for passwords in its own window and never keeps them, checks the other computer before copying
  anything, then copies a small helper there (about 31 MB) that runs only while it is connected and leaves no service
  or autostart behind. It works there on commands, and on the apps of that computer's screen when you are the person
  logged in at it, asking before every step and showing a notice with **Stop** there. When that screen locks or its
  session goes inactive, the tasks using the screen stop; a task only running commands there goes on (a **Stop** at
  that computer, a lost connection, **Disconnect** and the stop chord stop everything there). Your voice, Copilot and
  your GitHub sign-in stay on this computer. **Remove Ember from build-01** removes the helper again.
- **SSH connections, in detail**: with OpenSSH older than 8.5 on this computer (RHEL 8, Ubuntu 20.04, Debian 11),
  every password or code is shown as "build-01 asks" with the question quoted, never as "Unlock your SSH key", because
  those clients can't mark a server's own questions. A silent connection shows "build-01 isn't answering" in the
  bubble and a countdown on each running command's tab. A command that prints faster than the connection can carry is
  paused until its output catches up; a stopped command that keeps printing past that limit has the rest dropped. When
  reconnecting needs you to sign in, Ember stops trying and says "build-01 needs you to sign in again", with
  **Reconnect**. If **Bring Ember** can't connect, the bubble says why. A Node.js download that gets nothing for 60
  seconds ends with "The download of what Ember needs for build-01 stalled. Try again."
- **Settings**: new **Computers** and **Commands** sections (per-computer switches, **Ask me before every command**,
  **Offer to bring Ember along when I connect with ssh**). The handle menu gains **Work on** (with more than one
  computer), **Bring Ember to a computer…** and **Disconnect build-01**; the handle, task cards and questions say where
  Ember works.
- **Check-up** (`ember doctor` and the settings window's setup check): new rows for the SSH client, the command
  window's terminal (`script`), PowerShell, WSL and each running distro's Linux apps and accessibility (with a button
  in the setup check that turns accessibility on there, refused when your organisation has turned WSL or commands in
  WSL off), the helper for other computers, and a connected Mac's protected folders. With WSL off in Ember's settings,
  the check-up doesn't look inside your distros.

### For administrators

The organisation policy gains these keys. Compared with having no policy, none of them makes Ember less strict; but a
policy that exists and doesn't mention `commands` turns commands off (below), so adding `commands` is what allows them.

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
  before this release reads `features.wsl`, `features.ssh`, `commands` or `ssh` as a mistake and locks down (no
  actions, no listening) until the policy is fixed or Ember is updated. Update Ember on every computer before
  deploying a policy that uses them.

### Changed

- On Windows, a Linux app WSLg shows was refused and blacked out like a Remote Desktop window. With WSL on, Ember now
  tells which app it is and treats it like any app (without borrowing the mouse there); one it can't identify is
  still refused and blacked out. Linux apps
  shown by an X server on Windows (VcXsrv, X410, Xming, GWSL, Cygwin/X) are now refused and blacked out too.

### Limits you may meet

- People who already use Ember aren't shown the "Before Ember starts" page again: each new feature's own card (WSL
  once, each SSH computer, commands on each computer) asks first instead.
- Ember can't see when a program turns off echo for a password: it cuts everything you type out of what Copilot gets,
  and withholds the output after a password-like prompt, which may hide a little more than needed.
- On Windows, commands run in Windows PowerShell 5.1 only and can't take typing, so they can't ask you for a password
  or an answer.
- On a remote Linux screen, every step is asked, Ember never borrows the mouse and keyboard, and you aren't shown the
  screen.
- On a remote Wayland desktop, reading and using controls only, no screenshots; until Ember's Wayland test passes,
  commands only.
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
- `set -P`, `set -o physical` and zsh's `chase_links` or `chase_dots` ask, because they make every later `cd` follow
  links in a way Ember doesn't follow; `cd -P` alone is followed.
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
