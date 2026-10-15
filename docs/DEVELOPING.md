# Developing Ember on RHEL 8.4

This guide gets a development copy of Ember running on RHEL 8.4. It also works on
Rocky, Alma and Oracle Linux 8.

## 1. Log in to "GNOME on Xorg"

Ember v1 needs an X11 session. On the login screen, click your name, then the gear
icon next to **Sign In**, and choose **GNOME on Xorg**. Check it in a terminal:

```bash
echo $XDG_SESSION_TYPE   # must print: x11
```

The choice is remembered for the next login.

## 2. Install system packages

```bash
sudo dnf install -y git gcc-c++ make python3 \
  libX11-devel libXtst-devel libXt-devel \
  gtk3 nss alsa-lib mesa-libgbm libxkbcommon at-spi2-core at-spi2-atk cups-libs \
  xorg-x11-server-Xvfb xorg-x11-xauth
```

A standard RHEL Workstation install already has most of the runtime libraries. The
compilers and `-devel` packages are needed when native modules are rebuilt (§6).

Later milestones also use these (safe to install now):

```bash
sudo dnf install -y python3-pyatspi python3-gobject speech-dispatcher speech-dispatcher-espeak-ng pulseaudio-utils bzip2
sudo dnf install -y metacity   # optional: a window manager for Ember's desk (Xvfb and xauth are above)
```

## 3. Install Node 22 and npm 11

RHEL 8.4's own Node streams are too old, so use the official Node 22 build (it runs on
glibc 2.28):

```bash
curl -fsSLO https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz
sudo mkdir -p /opt/node22 && sudo tar -xJf node-v22.22.0-linux-x64.tar.xz -C /opt/node22 --strip-components=1
echo 'export PATH=/opt/node22/bin:$PATH' >> ~/.bashrc && source ~/.bashrc
npm install -g npm@11.6.2
```

npm 10 crashes while resolving the test tools (`Cannot read properties of null (reading
'edgesOut')`), so npm 11 is required.

## 4. Turn on accessibility

Ember reads apps through the accessibility service, with RHEL's own Python
(`/usr/libexec/platform-python` and `python3-pyatspi`):

```bash
sudo dnf install -y python3-pyatspi python3-gobject
gsettings set org.gnome.desktop.interface toolkit-accessibility true
```

The **Screen reading** row in Ember's setup check shows the state and has a **Turn on** button for the
second command. Restart open apps (or log out and in) so they pick it up.

## 5. Run it

```bash
git clone https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot.git ember
cd ember
npm ci
npm run dev
```

The Ember window opens with a **Setup check**. Every row should be green on RHEL 8.4
with GNOME on Xorg. If `npm ci` reports that Electron failed to download, run
`npx install-electron` and try again.

| Command | What it does |
|---|---|
| `npm run dev` | Build and start Ember |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Runs the real Copilot runtime against the offline mock model |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run test:smoke` | Starts Ember, checks the window appears and a second launch hands over. Without a desktop: `xvfb-run -a npm run test:smoke` |
| `npm run build:lab` | Builds the character lab demo into `dist/ember-character-lab.html` |
| `npm run rebuild:el8` | Rebuilds native modules for RHEL 8 and checks every binary (§6) |
| `npm run check:symvers` | Only the binary check |
| `scripts/install-desktop-entry.sh [--autostart]` | Adds "Ember (dev)" to the GNOME app menu (and to login) |
| `scripts/demo/desktop.sh start` then `DISPLAY=:55 node test/demo/m1-tour.mjs out/` | Records a video tour on a throw-away desktop (needs Xvfb, openbox, xcompmgr, feh, mousepad, xdotool, ffmpeg) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m3-tour.mjs out/` | Screen-reading tour. Runs as the desktop's user so the accessibility bus is reachable (`EMBER_DEMO_USER`, default `demo`) |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception.test.ts test/integration/worker.test.ts` | Reads and operates a GTK3 test window through the sidecar (needs a desktop session with pyatspi) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m6-tour.mjs out/` | Guide tour: Ember points, the user clicks; then a question about the selected text |
| `node scripts/voice/prepare.mjs` | Downloads the speech models (verified) and synthesizes test clips into `.cache/voice` (needed by the voice tests and tour) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m5-tour.mjs out/` | Voice tour: a WAV file plays the microphone; the video gets the audio |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4b-tour.mjs out/` | Cursor-borrow tour: Ember borrows the mouse with permission, and lets go when the user moves it |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4-tour.mjs out/` | Task tour: Ember fills in a form in another window, asks once, refuses the password, turns on Do Not Disturb |

### Using Ember

- Ember appears beside your cursor; its handle sits in the bottom-right corner. Click the handle for
  **Settings**, **Stay put / Follow my cursor**, **Hide / Show Ember** and **Quit**.
- **Ctrl+Alt+E** opens settings from anywhere.
- Without a compositor (xrdp, VNC), transparent windows can't work, so Ember lives in an opaque
  card in the corner instead.

### Asking Ember to do things

Ask for something in an app ("turn on Night Light", "put my name in this form and save") and Ember
starts a task in the background, with a card in the top-right corner. It works through the app's
accessibility interface, so your mouse and keyboard stay yours. Before its first action in an app it
asks **Allow / Always in this app / Not now**. Buttons that send, delete, pay and the like are always
confirmed. If an app can't be operated through accessibility, Ember asks to **borrow your mouse**:
it waits until you're still, moves the pointer visibly, and puts it back afterwards. Move the mouse
or press any key to take over instantly. Ember never types into password, payment or terminal
fields and never acts in authentication windows. While a password prompt (polkit, keyring, sudo) is open, Ember
doesn't read the screen, take screenshots or press keys. If something on screen tries to steer Ember (a page saying
"click Delete all"), Ember still asks first, and the question says you didn't ask for it. **Ctrl+Alt+X** (or
“Ember, stop”, or **Stop everything** in the handle menu) stops every task, question and borrowed mouse at once.
Apps you chose "Always" for are listed under `grants` in `settings.json`. **What Ember did** in the settings window
lists every request, question, action and refusal.

The first time it starts, Ember explains what it reads, what it sends and what it keeps, and does nothing until you
agree.

### Ember's desk

Say "on your desk" (or ask for a long typing job) and Ember opens the app on its own private,
invisible display instead of yours. There it can use a full mouse and keyboard without
borrowing yours, so you keep working undisturbed. A small **Ember's desk** window in the
bottom-right corner shows what it is doing. Click **Take over** to enlarge it and use the desk
yourself (Ember pauses), then **Hand back**. Files Ember makes there go to `~/Ember`. The desk
has its own clipboard and is closed when Ember quits. It needs `Xvfb`, `xauth` and `dbus-daemon`
(§2). Ember never runs terminals there.

### Learning with Ember

Ask “show me how to …” (or “where is …”) and Ember guides instead of doing it. It flies to each
control, highlights it, says what to do, and waits for you to click before moving on. When you call
Ember, it notes where you are (the window, the focused field and any text you selected), so you can
say “make this bold” or “what does this mean?”.

### Talking to Ember

In settings, turn on **Listen for “Hey Ember”**, read and accept the microphone note, and download
the speech models (about 120 MB, once). Then say “Hey Ember, …” with your request. You can say it in
one breath, or pause after “Hey Ember”. After Ember answers you have 8 seconds to follow up without
the wake word. “Ember, stop” stops everything, and **Ctrl+Alt+M** turns the microphone off and on.
Listening happens on this computer: no audio leaves it, and only the text of your request is sent to
Copilot. Ember ignores “Hey Ember” when it comes out of your speakers (needs `parec`, in
`pulseaudio-utils`).

### Connecting Copilot

Ember needs a GitHub account with Copilot. Until Ember's own GitHub App is registered (PLAN.md §7),
sign in with the GitHub CLI and Ember will reuse it:

```bash
sudo dnf install -y gh      # or download from cli.github.com
gh auth login
```

Ember checks, in order: a token it stored itself, `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`,
then `gh auth token`. Classic `ghp_` tokens are not accepted by Copilot. For Copilot Business or
Enterprise, your organization must enable the **Copilot CLI** policy.

Then press **Ctrl+Alt+Space** and type a question.

To try Ember offline without Copilot, run the mock model and point Ember at it:

```bash
node -e 'import("./test/mock-llm/server.mjs").then(m => m.startMockLlm({ port: 18090 })).then(s => console.log(s.baseUrl))' &
EMBER_TEST_PROVIDER_URL=http://127.0.0.1:18090/v1 npm run dev
```

### Where Ember keeps things

| What | Where |
|---|---|
| Settings | `~/.config/ember/settings.json` |
| Conversation (Copilot session state) | `~/.config/ember/copilot/`, id in `~/.config/ember/agent.json` |
| GitHub token (encrypted with your keyring) | `~/.config/ember/github-token.bin` |
| Logs (JSON lines, rotated at 5 MB) | `~/.config/ember/logs/ember.log` |
| Audit log: every decision and action Ember took (JSON lines, kept 30 days) | `~/.config/ember/audit/audit-YYYY-MM.jsonl` |
| Speech models (downloaded once, SHA-256 checked) | `~/.config/ember/models/` |
| What Ember made on its desk | `~/Ember/` |
| App profiles used on the desk (kept separate from yours) | `~/.config/ember/desk-profiles/` |

Environment variables for development:

| Variable | Effect |
|---|---|
| `EMBER_USER_DATA=/tmp/x` | Use another settings and log folder |
| `EMBER_LOG_LEVEL=debug` | More detail in the log |
| `EMBER_LOG_STDOUT=1` | Also print log lines to the terminal (on by default in development) |
| `EMBER_PYTHON=/usr/bin/python3.12` | Python for the accessibility sidecar (default: `/usr/libexec/platform-python`, then `python3`) |

Apps Ember must never read or capture are listed under `privacy.neverLook` in `settings.json`
(matched against app name and window title; password managers and polkit are listed by default).

### For administrators: `/etc/ember/policy.json`

An optional file that makes Ember stricter for everyone on the machine. Its values override users' settings, and
users can't loosen them. If the file exists but can't be read or has a mistake, Ember locks down (no actions,
no listening) until it is fixed, and says so in its settings window. Every key is optional:

```json
{
  "features": { "voice": false, "speak": true, "actions": true, "cursor": false, "desk": false, "screenImages": false },
  "neverLook": ["Thunderbird", "Remmina"],
  "confirmEveryAction": true,
  "allowGrants": false,
  "maxActionsPerMinute": 20,
  "models": { "allowed": ["fast-model-id", "vision-model-id"], "conductor": "fast-model-id" },
  "provider": { "type": "azure", "baseUrl": "https://ai.example.org/openai/deployments/ember", "apiKeyFile": "/etc/ember/api-key" },
  "auditRetentionDays": 90
}
```

| Key | Effect |
|---|---|
| `features.voice` / `speak` | No "Hey Ember" / no spoken replies |
| `features.actions` | Ember answers and guides ("show me") but never acts in apps |
| `features.cursor` / `desk` | No borrowing the user's mouse and keyboard / no private desk |
| `features.screenImages` | Accessibility text only; no screenshots go to the model |
| `neverLook` | Apps and windows Ember never reads, captures or acts in (added to each user's list) |
| `confirmEveryAction` | A click before every action, every time |
| `allowGrants` | `false` removes "Always in this app" |
| `models` | Only these models; or pin the conversation and task models |
| `provider` | Use the organisation's own endpoint (`openai`, `azure` or `anthropic`) instead of GitHub sign-in; the key is read from `apiKeyFile` |
| `auditRetentionDays` | How long the audit log is kept (default 30) |

Audit lines also go to the system journal: `journalctl -t ember-audit`. For testing, `EMBER_ADMIN_POLICY=/path/to/policy.json`
points Ember at another file.

## 6. Native modules and RHEL 8

Every compiled file Ember ships (`.node`, `.so`, executables) must work with RHEL 8.4's
glibc 2.28 and libstdc++ (GLIBCXX_3.4.25). Many npm packages ship prebuilt binaries made
on newer systems that **will not load** on RHEL 8 (for example `robotjs` 0.9.1 and
`uiohook-napi` 1.5.5).

Rules:

1. List every native module in `package.json` under `"ember": { "nativeModules": [...] }`.
2. Run `npm run rebuild:el8`. On RHEL 8 it rebuilds in place; elsewhere it runs inside a
   `rockylinux:8` container (needs podman or docker).
3. `scripts/check-symvers.sh` must pass. CI runs both steps on every pull request.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Setup check says "Wayland session" | Log in with **GNOME on Xorg** (§1) |
| `The SUID sandbox helper binary was found, but is not configured correctly` | User namespaces are disabled (common on STIG-hardened machines; check `sysctl user.max_user_namespaces`, 0 means disabled). For development only: `npx electron . --no-sandbox`. The RPM sets up the sandbox helper properly (task M9.2). |
| `npm ci` fails with `edgesOut` | Upgrade npm: `npm install -g npm@11.6.2` |
| Electron download fails | `npx install-electron` |
| Ember doesn't react to “Hey Ember” | Check the **Voice** section: the models must be downloaded and the state must say “Listening for ‘Hey Ember’”. Check the right microphone is selected in GNOME Settings → Sound. `EMBER_LOG_LEVEL=debug` logs every wake, rejection and transcript length |
| Ember says it can't read the screen | Check the **Screen reading** row; `python3-pyatspi` must be installed and accessibility on. Apps started before it was turned on must be restarted |

## Repository layout

```
app/main/           Electron main process (settings, logging, environment checks, windows, agent, perception)
sidecar/atspi       Python accessibility helper (reads app controls over AT-SPI)
app/voice           wake word, VAD and speech recognition (runs in a utility process)
app/preload/        contextBridge APIs, one per window
app/renderer/       window pages (home)
app/shared/         IPC channel names and types
packages/characters Ember's characters and the shared emotion rig
packages/bubble     reasoning bubble
packages/motion     follow spring and flight path
demo/character-lab  interactive character prototype
scripts/            build, RHEL 8 rebuild and binary checks
test/unit           Vitest tests;  test/integration  real runtime / real AT-SPI;  test/smoke  launch test
test/fixtures       GTK3 test bench window;  test/demo  recorded tours
```
