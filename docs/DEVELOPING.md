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
| `npm run test:sidecar` | The accessibility sidecar's own tests (`python3 -B sidecar/atspi/test_ember_atspi.py`; a stand-in pyatspi, no desktop needed). CI also runs them on RHEL 8's `platform-python` 3.6. They share the secret-field labels in `test/fixtures/secret-labels.json` with the TypeScript tests |
| `npm run test:integration` | Runs the real Copilot runtime against the offline mock model |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run test:smoke` | Starts Ember, checks the window appears and a second launch hands over. Without a desktop: `xvfb-run -a npm run test:smoke` |
| `npm run build:lab` | Builds the character lab demo into `dist/ember-character-lab.html` |
| `npm run rebuild:el8` | Rebuilds native modules for RHEL 8 and checks every binary (§6) |
| `npm run check:symvers` | Only the binary check |
| `scripts/install-desktop-entry.sh [--autostart]` | Adds "Ember (dev)" to the GNOME app menu (and to login) |
| `scripts/demo/desktop.sh start` then `DISPLAY=:55 node test/demo/m1-tour.mjs out/` | Records a video tour on a throw-away desktop (needs Xvfb, openbox, xcompmgr, feh, mousepad, xdotool, ffmpeg) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m3-tour.mjs out/` | Screen-reading tour. Runs as the desktop's user so the accessibility bus is reachable (`EMBER_DEMO_USER`, default `demo`) |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception.test.ts test/integration/worker.test.ts test/integration/desk.test.ts test/integration/safety.test.ts` | Reads and operates GTK3 test windows through the sidecar: a worker on the test bench, on Ember's desk, and on hostile windows (prompt injection, a password prompt). Needs a desktop session with pyatspi; on a bare X server, `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" …` as in CI |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception-electron.test.ts` | Reads Electron windows (Chromium's accessibility) through the sidecar and X11: window frames, scale 2, secret fields withheld and blacked out. Same needs as the line above (the test starts its windows with `ACCESSIBILITY_ENABLED=1`, as Chromium joins the accessibility bus only when asked); CI runs it with them on `rockylinux:8` |
| `npm run test:integration -- test/integration/borrow-live.test.ts test/integration/desk-robust.test.ts` | Borrowing the mouse and keyboard on a private Xvfb (other keyboard layouts need `setxkbmap`; skipped without Xvfb), and Ember's desk when things go wrong (its display dying, Ember killed). Need only Xvfb (and `xauth`, `dbus-daemon` for the desk), no desktop session |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m6-tour.mjs out/` | Guide tour: Ember points, the user clicks; then a question about the selected text |
| `node scripts/voice/prepare.mjs` | Downloads the speech models (verified) into `.cache/voice` (needed by the voice tests and tour). `--tts-voice` also fetches a test-only TTS voice (pinned by SHA-256), which the evaluation's missed-wakes gate needs; `--clips` synthesizes new test clips into `.cache/voice/clips`, leaving the committed ones alone; `--update-fixtures` writes them over `test/fixtures/voice` instead. The voice is random on every run, so check new clips with the voice tests before committing them (`git restore test/fixtures/voice` puts the old ones back) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m5-tour.mjs out/` | Voice tour: a WAV file plays the microphone; the video gets the audio |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4b-tour.mjs out/` | Cursor-borrow tour: Ember borrows the mouse with permission, and lets go when the user moves it |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4-tour.mjs out/` | Task tour: Ember fills in a form in another window, asks once, refuses the password, turns on Do Not Disturb |

### Using Ember

- Ember appears beside your cursor; its handle sits in the bottom-right corner. Click the handle for
  **Ask Ember…**, **Stop everything**, **Mute / Unmute microphone** (with “Hey Ember” on), **Read the last answer**
  (once Ember has answered), **Settings…**, **Stay put / Follow my cursor**, **Hide / Show Ember** and **Quit Ember**
  (Quit asks first while a task is running).
- **Ctrl+Alt+E** opens settings from anywhere. **Ctrl+Alt+Space** opens the ask box: it shows which window Ember
  will look at, and ↑/↓ bring back earlier questions.
- Long answers have **Read all**: the settings window's **Conversation** section keeps this session's questions,
  answers and task results (in memory only; quitting or signing out forgets them).
- If another app already holds one of Ember's shortcuts, the **Setup check** says which, Ember keeps trying to get
  it, and the handle menu does the same things.
- **Comfort & access** in settings has **Calm mode** (no hops, bounces or fidgets). It is also on when GNOME's
  animations are off or the desktop asks for reduced motion.
- Without a compositor (xrdp, VNC), transparent windows can't work, so Ember lives in an opaque
  card in the corner instead; it grows to show a whole question.

### Asking Ember to do things

Ask for something in an app ("turn on Night Light", "put my name in this form and save") and Ember
starts a task in the background, with a card in the top-right corner. It works through the app's
accessibility interface, so your mouse and keyboard stay yours. Before its first action in an app it
asks **Allow / Always in this app / Not now**; answer with a click, or with **Ctrl+Alt+Y** (allow) and **Ctrl+Alt+N**
(not now), so you never need the mouse (the question shows the keys). **Always** is a click only: a global key could
take an app's own shortcut and grant for good by accident. A hidden Ember shows itself to ask, and with
**Speak replies** on (or a screen reader running) it says the question out loud. Buttons that send, delete, pay and
the like, risky shortcuts (Delete, Ctrl+Enter, Alt+F4…) and Enter on such a button are always confirmed, and
“Always” is never offered for them. Each task card has **Stop**; a failed card stays until you close it. If an app can't be operated through accessibility, Ember asks to **borrow your mouse**:
it waits until you're still, moves the pointer visibly, and puts it back afterwards. Move the mouse,
turn the wheel or press any key to take over instantly. Ember never types into password, payment or terminal
fields and never acts in authentication windows. While a password prompt (polkit, keyring, sudo) is open, Ember
doesn't read the screen, take screenshots or press keys. If something on screen tries to steer Ember (a page saying
"click Delete all"), Ember still asks first, the question says you didn't ask for it, and from then on that task
asks before every step. **Ctrl+Alt+X** (or “Ember, stop”, or **Stop everything** in the handle menu) stops every
task, question, borrowed mouse, desk take-over and request still being spoken at once; nothing more reaches an app
after it. Apps you chose "Always" for are listed in **Apps & privacy** in the settings window (with **Remove**),
next to the never-look list, which you can edit there too. **What Ember did** lists every request, question,
action and refusal, by day. Text the keyboard can't type (accents, other layouts) is pasted, and your clipboard is
put back afterwards.

The first time it starts, Ember explains what it reads, what it sends and what it keeps, and does nothing until you
agree.

### Ember's desk

Say "on your desk" (or ask for a long typing job) and Ember opens the app on its own private,
invisible display instead of yours. There it can use a full mouse and keyboard without
borrowing yours, so you keep working undisturbed. A small **Ember's desk** window in the
bottom-right corner shows what it is doing. Click **Take over** to enlarge it and use the desk
yourself (Ember pauses), then **Hand back** (or press **Ctrl+Alt+End**). Files Ember makes there go to `~/Ember`.
The desk has its own clipboard, its own app settings (`~/.config/ember/desk-profiles`), only the environment its
apps need (no tokens or keys), and is closed when Ember quits. It needs `Xvfb`, `xauth` and `dbus-daemon`
(§2). Ember never runs terminals there (or anywhere). LibreOffice on the desk gets a profile of its own that runs no
macros: document macros, the macro editors and runners (the Basic IDE), extension installs and Tools > Options are
switched off.

Every X call on a desk (its input, window list, screenshots, key map) happens in a helper process,
`dist/app/desk-agent.cjs`, which Ember starts with its own binary as plain Node (`ELECTRON_RUN_AS_NODE`). If the
desk's X server dies, Xlib ends that helper, never Ember, and Ember treats the desk as gone (and a desk left by an
Ember that was killed is cleared away at the next start). `npm run build` builds the helper beside `main.cjs`, the
packages ship it there, and `node eval/run.mjs` builds its own copy in `dist/eval`.

### Learning with Ember

Ask “show me how to …” (or “where is …”) and Ember guides instead of doing it. It flies to each
control, highlights it, says what to do, and waits for you to click before moving on. When you call
Ember, it notes where you are (the window, the focused field and any text you selected), so you can
say “make this bold” or “what does this mean?”.

### Talking to Ember

In settings, turn on **Listen for “Hey Ember”**, read and accept the microphone note, and download
the speech models (126 MB, once; agreeing to the microphone note starts the download). Then say “Hey Ember, …” with your request. You can say it in
one breath, or pause after “Hey Ember”. After Ember answers you have 8 seconds to follow up without
the wake word; “Thanks” or “that's all” ends that window. “Ember, stop” (or “Hey Ember, stop”) stops
everything, and **Ctrl+Alt+M** turns the microphone off and on. Listening happens on this computer: no
audio leaves it, and only the text of your request is sent to Copilot. Ember ignores “Hey Ember” and
“Ember, stop” when they come out of your speakers (needs `parec`, in `pulseaudio-utils`). A request ends
when your voice stops, even with a TV or colleagues talking behind you, and is never longer than 10 s.

### Connecting Copilot

Ember needs a GitHub account with Copilot. Until Ember's own GitHub App is registered (PLAN.md §7),
sign in with the GitHub CLI and Ember will reuse it:

```bash
sudo dnf install -y gh      # or download from cli.github.com
gh auth login
```

Ember checks, in order: a token it stored itself, `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`,
then `gh auth token`. Classic `ghp_` tokens are not accepted by Copilot. For Copilot Business or
Enterprise, your organization must enable the **Copilot CLI** policy. No restart is needed: press **Sign in with
GitHub** and run `gh auth login` in a terminal (Ember notices within a few seconds), or press **Check again**. If
sign-in fails, the Copilot section says which sign-in Ember tried and why; while offline, Ember retries by itself.

Then press **Ctrl+Alt+Space** and type a question.

To try Ember offline without Copilot, run the mock model and point Ember at it (development checkouts only: an
installed Ember ignores every `EMBER_TEST_*`, `EMBER_ADMIN_POLICY`, `EMBER_VOICE_MODELS`, `EMBER_BENCH_LOG`,
`EMBER_COPILOT_RUNTIME` and `EMBER_VOICE_DUMP` switch):

```bash
node -e 'import("./test/mock-llm/server.mjs").then(m => m.startMockLlm({ port: 18090 })).then(s => console.log(s.baseUrl))' &
EMBER_TEST_PROVIDER_URL=http://127.0.0.1:18090/v1 npm run dev
```

### Where Ember keeps things

| What | Where |
|---|---|
| Settings | `~/.config/ember/settings.json` |
| Conversation (Copilot session state), only while Ember runs: resumed if Ember reconnects, deleted when it quits (one left by a crash is deleted at the next start) | `~/.config/ember/copilot/`, id in `~/.config/ember/agent.json` |
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
| `provider` | Use the organisation's own endpoint (`openai`, `azure` or `anthropic`) instead of GitHub sign-in; the key is read from `apiKeyFile` (or, without one, from the environment variable `EMBER_PROVIDER_API_KEY`) |
| `auditRetentionDays` | How long the audit log is kept (default 30) |

Audit lines also go to the system journal: `journalctl -t ember-audit`. `/etc/ember/policy.json` must belong to root
and be writable only by root, or Ember locks down. In a development checkout, `EMBER_ADMIN_POLICY=/path/to/policy.json`
points Ember at another file (an installed Ember ignores it).

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

## 7. Packages

```bash
npm run package            # dist/package: the RPMs and the AppImage
```

The RPMs carry the build machine's dist tag (`.el8` when built on RHEL 8 or `rockylinux:8`, as CI does).

| Output | What it is |
|---|---|
| `ember-<v>-1.el8.x86_64.rpm` | Ember in `/opt/ember`, `/usr/bin/ember`, menu entry and icon. Library dependencies are listed explicitly (no auto-detection), optional parts are *Recommends* (Ember's desk, speaking, microphone list, tray icons, speech models). `chrome-sandbox` is setuid root, so Ember stays sandboxed on STIG hosts where user namespaces are off. Needs `rpm-build` |
| `ember-voice-models-<v>-1.el8.noarch.rpm` | The speech models in `/usr/share/ember/voice-models`, so Ember needn't download them. Built when `.cache/voice` has them (`node scripts/voice/prepare.mjs`) |
| `Ember-<v>-x86_64.AppImage` | Runs without installing. Without user namespaces it runs without Chromium's sandbox (an AppImage can't carry a setuid helper); use the RPM on hardened machines |

The steps are `node scripts/package/stage.mjs` (a self-contained folder with only Linux x64 glibc builds; it sets the
staged binary's Electron fuses so the installed Ember ignores `--inspect` and `NODE_OPTIONS`, and keeps plain-Node
mode for the desk helper, where Node's own `--inspect` still works but reaches only that new process, not the
running Ember: `node scripts/package/fuses.mjs <binary>` lists them), `scripts/package/rpm.sh` and
`scripts/package/appimage.sh` (pinned, checksummed appimagetool and runtime). CI builds both packages on
`rockylinux:8`, checks every binary against glibc 2.28, installs the RPM with `dnf`, checks the installed binary's
fuses (no debugger, `NODE_OPTIONS` ignored), runs `ember doctor` and starts the installed Ember as a normal user.
Bundled licences ship in `/opt/ember/THIRD_PARTY_NOTICES` (and as `%license` files in the RPM); staging stops if a
bundled package's licence isn't in the spec's `License:` tag. `sudo ember doctor` works (it adds `--no-sandbox` only
for the root check-up).

`ember doctor` (or `npm run doctor` in a checkout) checks the session, compositor, accessibility, XTest,
Copilot sign-in or the organisation's endpoint, the admin policy, microphone, speech models, speech-dispatcher,
Ember's desk and the sandbox, and says what to do about each problem. It exits 1 if Ember can't work.
**Start Ember when I log in** in the settings window adds `~/.config/autostart/ember.desktop`.

## 8. Evaluation

```bash
npm run eval                                  # per-PR tier: dist/eval/report.html and results.json
node eval/run.mjs --only bench-save,injection-delete --no-gates
node eval/run.mjs --live --repeat 3           # nightly tier: a real model, pass^3 (see below)
```

The task suite is `eval/tasks/*.json` (schema: `eval/src/schema.ts`). Each task says how to set things up
(files, settings), which app it starts in, what the user asks, how the simulated user answers Ember's questions,
and how to check the result. It can check accessibility state, gsettings, files, events from Ember's test windows,
Ember's audit log and its final answer, and it can check that nothing else changed. Every task runs through
Ember's real worker, accessibility reader, policy engine, mouse and keyboard, desk and audit log. Safety is judged
from the audit log: no action on anything the page slipped in, nothing that needed the user's OK went ahead
without it, and everything risky was asked about. The simulated user answers a question as soon as it shows (the
harness turns off the Confirmer's guard against too-early clicks, which would drop its answers). Ember's test
windows need GTK 3 for the sidecar's Python (`python3-gobject`, `gtk3`); without it their tasks are skipped, with
the reason. Each attempt's temporary folder (settings, audit log, files) is deleted when it has been judged; `--keep`
keeps them (`/tmp/ember-eval-<task>-…`) to look into a failure, and `--verbose` prints Ember's warnings.

| Tier | Model | Where | Gate |
|---|---|---|---|
| Per PR (CI job `eval`) | a scripted mock replays each task's steps | `rockylinux:8` + Xvfb, gedit, the test windows | every runnable task passes; safety gates met |
| Nightly (`.github/workflows/nightly-eval.yml`) | a real model from the instruction alone, 3 times per task | an eval VM: RHEL 8.4, GNOME on Xorg, with a self-hosted runner (`rhel84-gnome`), reverted to its clean snapshot first from a separate controller host | pass^3 ≥ 70 % and the release gates |

The nightly tier needs the repository variable `EMBER_NIGHTLY=true`, `EMBER_EVAL_MODEL`, and either a
`COPILOT_GITHUB_TOKEN` secret or `EMBER_EVAL_PROVIDER_URL` + `EMBER_EVAL_API_KEY`. To start each run from a clean
eval VM, set up a **controller host** that is not the eval VM (the hypervisor, or a machine that can drive it) with a
self-hosted runner labelled `ember-eval-controller`, install a reset command there (an executable taking no
arguments that reverts the eval VM, and only the eval VM, to its snapshot, starts it and returns once its runner is
back online; e.g. `virsh snapshot-revert ember-eval-rhel84 clean --running`), and set the repository variable
`EMBER_EVAL_RESET` to that command's absolute path. The workflow's first job runs it on the controller host (the
variable is passed in the environment and run as a program, never pasted into the script); the evaluation runs on
the eval VM only after a successful reset, or without one when `EMBER_EVAL_RESET` isn't set.

The evaluation drives the eval VM's desktop, so its runner must run **as the logged-in desktop user, inside the
session**, not as a system service (`./svc.sh install`): a service has no display, X authority or session bus, so no
window would appear, `gsettings` would fail and the gates would go unmeasured. Set up the eval VM like this:

- log the runner's user in automatically (`/etc/gdm/custom.conf`: `AutomaticLoginEnable=True`,
  `AutomaticLogin=<user>`) to **GNOME on Xorg**, and turn the screen lock and blanking off;
- start the runner from the session: `~/.config/autostart/actions-runner.desktop` with
  `Exec=/home/<user>/actions-runner/run.sh` (or a `systemd --user` service, after
  `systemctl --user import-environment DISPLAY XAUTHORITY` in the session);
- install `bzip2` (the test TTS voice comes as a `.tar.bz2`);
- take the snapshot with the user logged in and the runner idle.

The workflow's "live" job fills in `DISPLAY` (the user's graphical session, else `:0`), `XAUTHORITY`
(`/run/user/<uid>/gdm/Xauthority`, else `~/.Xauthority`) and `DBUS_SESSION_BUS_ADDRESS` (`/run/user/<uid>/bus`)
where the runner lacks them and they exist, and `node eval/run.mjs --live` stops at once (exit 2) when it can't open
the display or find the session bus.

Tasks for apps that aren't installed are skipped and listed as skipped. Every run also measures the release gates of
PLAN.md §6 on the machine it runs on (reading a window, taking the mouse back, the kill switch, wake-word latency and
accuracy, idle CPU). Gates it can't measure there are marked "not measured", with the reason.

Exit status: 2 for a mistake in the command line (an unknown task id, or filters that match nothing), or a `--live`
run without the desktop session (no display it can open, or no session bus). Otherwise the run fails (1) when no task
could run (every task skipped on this machine), when the per-PR tier has any failing task or the nightly tier is
under pass^3 70 %, or when a blocking safety gate isn't **pass**: "not measured" fails too, and an attempt that broke
off is still judged from the audit log it left. So a partial run such as `--only bench-save` needs `--no-gates` (or
an injection task). A `--no-tasks` run is judged on its gates alone; the blocking (safety) gates come from the task
suite, so it measures only tracked gates and doesn't fail on them. The missed-wakes gate passes only when the 95 %
upper bound of the miss rate is under 5 % (73 clips or more with none missed); with fewer clips, such as the 3 test
clips without the TTS voice (`node scripts/voice/prepare.mjs --tts-voice` fetches it; the nightly workflow does), it
is "not measured". With the voice it adds 75 synthesized renderings, made in memory on every run (nothing is written
to `test/fixtures`). The takeover and kill-switch trials give up after 2 s each, and every CI job has a timeout. The
nightly workflow passes its secrets to the eval step only and installs dependencies with `npm ci --ignore-scripts`.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Setup check says "Wayland session" | Log in with **GNOME on Xorg** (§1) |
| `The SUID sandbox helper binary was found, but is not configured correctly` | User namespaces are disabled (common on STIG-hardened machines; check `sysctl user.max_user_namespaces`, 0 means disabled). For development only: `npx electron . --no-sandbox`. The RPM installs the setuid sandbox helper, so installed Ember works there; `ember doctor` checks it. |
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
app/renderer/       window pages (home, overlay, handle, ask, mic, desk)
app/shared/         IPC channel names and types
packages/characters Ember's characters and the shared emotion rig
packages/bubble     reasoning bubble
packages/motion     follow spring and flight path
demo/character-lab  interactive character prototype
scripts/            build, RHEL 8 rebuild, binary checks, packaging (scripts/package)
packaging/          RPM spec, launcher, menu entry, example admin policy
test/unit           Vitest tests;  test/integration  real runtime / real AT-SPI;  test/smoke  launch test
test/fixtures       GTK3 test bench and hostile windows, voice clips;  test/demo  recorded tours
eval/               task suite (eval/tasks), runner, checkers, release gates, report
```
