# Developing Ember

This guide gets a development copy of Ember running. §1–§9 cover RHEL 8.4 (also Rocky, Alma and Oracle Linux 8),
Ember's first platform; §10 covers Windows 10 and 11, §11 macOS 13 and later, §12 the platform layer the three share,
§13 CI, and §14 working on SSH, WSL and commands. What §5 says about using Ember holds on every OS, with that OS's
shortcuts (README.md has the table). What users and administrators see of commands, WSL and other computers is in
[COMMANDS-WSL-SSH.md](COMMANDS-WSL-SSH.md).

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

Ember notices the screen locking through logind, with `gdbus monitor` (glib2, which GNOME brings); without `gdbus` it
reads `loginctl` every 5 s.

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
| `npm run test:smoke` | Starts Ember (set up), checks the window appears, a second launch hands over, a third with `--ask` opens the ask box, and Ask Ember is in the jump list (Windows) or the Dock menu (macOS). Without a desktop: `xvfb-run -a npm run test:smoke` |
| `node test/smoke/launch.mjs --folder '<name>'` | The smoke test from a copy of the app in a folder of that name; checks the settings page loaded there (CI uses one with %, #, &, brackets and non-ASCII) |
| `npm run build:lab` | Builds the character lab demo into `dist/ember-character-lab.html` |
| `npm run rebuild:el8` | Rebuilds native modules for RHEL 8 and checks every binary (§6) |
| `npm run check:symvers` | Only the binary check |
| `scripts/install-desktop-entry.sh [--autostart]` | Adds "Ember (dev)" to the GNOME app menu, with its **Ask Ember** action as the RPM's entry has (and to login) |
| `scripts/demo/desktop.sh start` then `DISPLAY=:55 node test/demo/m1-tour.mjs out/` | Records a video tour on a throw-away desktop (needs Xvfb, openbox, xcompmgr, feh, mousepad, xdotool, ffmpeg) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m3-tour.mjs out/` | Screen-reading tour. Runs as the desktop's user so the accessibility bus is reachable (`EMBER_DEMO_USER`, default `demo`) |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception.test.ts test/integration/worker.test.ts test/integration/desk.test.ts test/integration/safety.test.ts test/integration/action-link.test.ts` | Reads and operates GTK3 test windows through the sidecar: a worker on the test bench, on Ember's desk, and on hostile windows (prompt injection, a password prompt); and a click that runs a modal dialog, which the user can still type in (PR10-1). Needs a desktop session with pyatspi; on a bare X server, `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" …` as in CI |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception-electron.test.ts` | Reads Electron windows (Chromium's accessibility) through the sidecar and X11: window frames, scale 2, secret fields withheld and blacked out. Same needs as the line above (the test starts its windows with `ACCESSIBILITY_ENABLED=1`, as Chromium joins the accessibility bus only when asked); CI runs it with them on `rockylinux:8` |
| `npm run test:integration -- test/integration/borrow-live.test.ts test/integration/desk-robust.test.ts` | Borrowing the mouse and keyboard on a private Xvfb (other keyboard layouts need `setxkbmap`; skipped without Xvfb), and Ember's desk when things go wrong (its display dying, Ember killed). Need only Xvfb (and `xauth`, `dbus-daemon` for the desk), no desktop session |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m6-tour.mjs out/` | Guide tour: Ember points, the user clicks; then a question about the selected text |
| `node scripts/voice/prepare.mjs` | Downloads the speech models (verified) into `.cache/voice` (needed by the voice tests and tour). `--tts-voice` also fetches a test-only TTS voice (pinned by SHA-256), which the evaluation's missed-wakes gate needs; `--clips` synthesizes new test clips into `.cache/voice/clips`, leaving the committed ones alone; `--update-fixtures` writes them over `test/fixtures/voice` instead. The voice is random on every run, so check new clips with the voice tests before committing them (`git restore test/fixtures/voice` puts the old ones back) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m5-tour.mjs out/` | Voice tour: a WAV file plays the microphone; the video gets the audio |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4b-tour.mjs out/` | Cursor-borrow tour: Ember borrows the mouse with permission, and lets go when the user moves it |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4-tour.mjs out/` | Task tour: Ember fills in a form in another window, asks once, refuses the password, turns on Do Not Disturb |

Each test run works in a temporary folder of its own (`ember-run-…`), which it removes at the end with vitest's module
cache (test/temp-folder.ts).

### Using Ember

- Ember appears beside your cursor; its handle sits in the bottom-right corner, or the bottom-left one with
  **Handle position** in settings' **Comfort & access**. Click the handle for **Ask Ember…**, **Stop everything**,
  **Mute / Unmute microphone** (with “Hey Ember” on), **Read the last answer** (once Ember has answered),
  **Settings…**, **Stay put / Follow my cursor**, **Hide / Show Ember**, **Move to the other side** (the handle and its
  task cards go to the other bottom corner) and **Quit Ember** (Quit asks first while a task is running).
- The shortcuts here are Linux's: Windows uses Win+Alt+… and macOS Control+Shift+Command+… with the same letters.
- **Ctrl+Alt+E** opens settings from anywhere. **Ctrl+Alt+Space** opens the ask box: it shows which window Ember
  will look at, and ↑/↓ bring back earlier questions.
- Long answers have **Read all** (counted at the text size you picked): the settings window's **Conversation** section
  keeps this session's questions, answers and task results (in memory only; quitting or signing out forgets them).
- If another app already holds one of Ember's shortcuts, Ember registers its fallback (the same chord with Shift;
  on a Mac Control+Shift+Command with another key, never VoiceOver's Option: `FALLBACK_SHORTCUTS` in
  `app/shared/shortcuts.ts`), and the **Setup check**, the greeting, the
  handle menu, settings and every hint name the chord it holds. A fallback stays Ember's until it quits, even once the
  default comes free. If another app holds the fallback too, the **Setup check** says which, Ember keeps trying to get
  them every minute, and the handle menu does the same things. Meanwhile the bubble and the command window don't name
  that shortcut: routes say "Or open Ember's settings…", errors and task results say "in Ember's settings", and an
  announced command names only its **Stop**.
- `--ask` (the Linux app menu's **Ask Ember** action, the one in the jump list of Ember's taskbar icon on Windows once
  Ember is pinned there, or while its settings, command, or password and consent window is open) opens the ask box: in the running Ember, or once a new one has started. Either way settings
  open instead while Ember isn't set up or the desktop session is one it can't use (the setup check says why). The macOS
  Dock menu's **Ask Ember** does the same in the running Ember.
- **Comfort & access** in settings has **Calm mode** (no hops, bounces or fidgets). It is also on when GNOME's
  animations are off or the desktop asks for reduced motion. Its **Text size** (Default, Large, Larger) changes the text
  in settings, Ember's bubble, task cards and handle, the ask box, the desk window's bar, the command window and its
  terminal, and Ember's password and consent cards. **More time to read and answer** keeps every bubble ten times as long
  (Ember's own notices, and a bubble that waited behind another or was covered for a while, included), a question waits
  20 minutes instead of 2 before it counts as **Not now**, and an offer to bring Ember to a computer 250 seconds instead
  of 25.
- Without a compositor (xrdp, VNC), transparent windows can't work, so Ember lives in an opaque
  card in the corner instead; it grows to show a whole question (up to 360 px, or 640 px within the work area for a
  question with a long typed text, whose sentence keeps its lines while the text's box gives way first).

### Asking Ember to do things

Ask for something in an app ("turn on Night Light", "put my name in this form and save") and Ember starts a task in the
background, with a card just above Ember's handle (in its corner). It works through the app's accessibility interface, so
your mouse and keyboard stay yours. Before its first action in an app it asks **Allow / Always in this app / Not now**;
answer with a click, or with **Ctrl+Alt+Y** (allow) and **Ctrl+Alt+N** (not now), so you never need the mouse (the
question shows the keys). **Always** is a click only: a global key could take an app's own shortcut and grant for good
by accident. A hidden Ember shows itself to ask, and with **Speak replies, questions and results out loud** set to
**Always** (the default), or a screen reader running and it set to **When a screen reader runs**, it says the question
out loud; **Never** keeps it quiet even for a screen reader. Buttons that send, delete, pay and the like, risky
shortcuts (Delete, Ctrl+Enter, Alt+F4…) and Enter on such a button are always confirmed, and “Always” is never offered
for them. Each task card has **Stop**; a failed card goes on its own after about a minute (the settings window's
Conversation section keeps what went wrong). If an app can't be operated through accessibility, Ember asks to **borrow
your mouse**: it waits until you're still, moves the pointer visibly, and puts it back afterwards. Move the mouse, turn
the wheel or press any key to take over instantly. Ember never types into password, payment or terminal fields and never
acts in authentication windows. While a password prompt (polkit, keyring, sudo) is open, Ember doesn't read the screen,
take screenshots or press keys. If something on screen tries to steer Ember (a page saying "click Delete all"), Ember
still asks first, the question says you didn't ask for it, and from then on that task asks before every step.
**Ctrl+Alt+X** (or “Ember, stop”, or **Stop everything** in the handle menu) stops every task, question, borrowed mouse,
desk take-over and request still being spoken at once; nothing more reaches an app after it. Apps you chose "Always" for
are listed in **Apps & privacy** in the settings window (with **Remove**), next to the never-look list, which you can
edit there too. **What Ember did** lists every request, question, action and refusal, by day. Text the keyboard can't
type (accents, other layouts) is pasted, and your clipboard is put back afterwards. With commands turned on (settings'
**Commands** section), a task can also run commands, in Ember's own **Ember commands** window rather than a terminal of
yours; it asks before dangerous ones ([COMMANDS-WSL-SSH.md](COMMANDS-WSL-SSH.md)).

The first time it starts, Ember explains what it reads, what it sends and what it keeps, and does nothing until you
agree.

### Ember's desk

Say "on your desk" (or ask for a long typing job) and Ember opens the app on its own private,
invisible display instead of yours. There it can use a full mouse and keyboard without
borrowing yours, so you keep working undisturbed. A small **Ember's desk** window in the
bottom-left corner (bottom-right when Ember's handle is in the bottom left) shows what it is
doing. Click **Take over** to enlarge it and use the desk yourself (Ember pauses), then
**Hand back** (or press **Ctrl+Alt+End**). Files Ember makes there go to `~/Ember`.
The desk has its own clipboard, its own app settings (`~/.config/ember/desk-profiles`), only the environment its
apps need (no tokens or keys), and is closed when Ember quits. It needs `Xvfb`, `xauth` and `dbus-daemon`
(§2). Ember never opens terminals there (or anywhere: commands, when turned on, run only in its own command window).
LibreOffice on the desk gets a profile of its own that runs no
macros: document macros, the macro editors and runners (the Basic IDE), extension installs and Tools > Options are
switched off.

Every X call on a desk (its input, window list, screenshots, key map) happens in a helper process,
`dist/app/desk-agent.cjs`, which Ember starts with its own binary as plain Node (`ELECTRON_RUN_AS_NODE`). If the
desk's X server dies, Xlib ends that helper, never Ember, and Ember treats the desk as gone (and a desk left by an
Ember that was killed is cleared away at the next start). `npm run build` builds the helper beside `main.cjs`, the
packages ship it there, and `node eval/run.mjs` builds its own copy in `dist/eval`.

### Learning with Ember

Ask “show me how to …” (or “where is …”) and Ember guides instead of doing it. It flies to each
control, highlights it, says what to do, and waits for you to click it (or press Enter or Space on it)
before moving on. When you call Ember, it notes where you are (the window, the focused field and any
text you selected), so you can say “make this bold” or “what does this mean?”.

### Talking to Ember

In settings, turn on **Listen for “Hey Ember”**, read and accept the microphone note, and download
the speech models (142 MB, once; agreeing to the microphone note starts the download). Then say “Ember, …” (or “Hey
Ember, …”) with your request. You can say it in one breath, or pause after the name. Ember answers out loud in its own
neural voice (it comes with the speech models; until then, the system's voice), sentence by sentence as the answer
arrives. To have Ember answer only you, turn on **Answer only my voice (Voice Match)** under it and say the four
phrases it shows; a request in another voice is then ignored (“Ember, stop” still works for anyone), and **Forget my
voice** deletes your voiceprint. After Ember answers a “Hey Ember” request you have 8 seconds for
one follow-up without the wake word; “Thanks”, “OK” or “that's all” ends that window (when Ember asked something,
“OK” is the answer). “Ember, stop” (or “Hey Ember, stop”, also while Ember is speaking) stops everything; while
Ember is speaking, “Hey Ember” alone makes it stop talking and listen (needs `parec`); a short request said all
over its voice isn't sent, so say it again once Ember is quiet. **Ctrl+Alt+M** turns the
microphone off and on. Listening happens on this computer: no
audio leaves it, and only the text of your request is sent to Copilot. Ember ignores “Hey Ember” and
“Ember, stop” when they come out of your speakers (needs `parec`, in `pulseaudio-utils`); it follows the default sound
output when you change it (`pactl`, from the same package), and keeps that output from idle-suspending while it
listens. A request ends
when your voice stops, even with a TV or colleagues talking behind you, and is at most 10 s long (20 s in a
quiet room); when a longer one is cut, Ember says it only caught the first part.

### How speech runs (WebAssembly, or natively on Windows and macOS)

Listening (the wake word, the two voice detectors and Moonshine) and Ember's voice run on sherpa-onnx 1.13.8, each in a
utility process of its own (`app/voice/process.ts`, `app/voice/tts-process.ts`), through `app/voice/runtime.ts`:

| | Linux | Windows, macOS |
|---|---|---|
| Build | WebAssembly (`sherpa-onnx`): one thread, no GPU, runs on RHEL 8's glibc 2.28 | The native addon (`sherpa-onnx-win-<arch>`, `sherpa-onnx-darwin-<arch>`: the binaries `sherpa-onnx-node` loads), WebAssembly if it doesn't load |
| Threads | 1 | Moonshine 2, Ember's voice 2 (Kokoro 4), leaving a core free; the per-frame models 1 |
| GPU | — | macOS: CoreML for Moonshine and the voice, kept only when it is faster than the CPU on that Mac (both are timed when they load). Windows: none: the prebuilt addon's `onnxruntime.dll` has no DirectML (it imports neither `DirectML.dll` nor `d3d12.dll`, and sherpa-onnx quietly uses the CPU when asked for it) |
| Voice | Piper "Kristin" | Piper "Kristin", or Kokoro (below) |

Ember depends on the platform packages directly (`optionalDependencies`, so npm installs only the computer's own):
`sherpa-onnx-node`'s JavaScript would bring `sherpa-onnx-linux-x64` too, which needs glibc 2.32 and would fail
`npm run check:symvers`. No Linux package carries the addon (`scripts/package/layout.mjs`; CI checks the staged Linux
folder has no `sherpa-onnx-*`). The log says which build each process runs: `voice.ready` and `voice.tts_ready`
carry `backend` (`native` or `wasm`), `detail` (the addon's and onnxruntime's versions, or why WebAssembly runs),
`provider`, `threads` and `tried` (each provider's probe time); `voice.tts_ready` also has the voice and its measured
real-time factor (`rtf`).

**Falling back.** A model the addon can't make throws, and WebAssembly is used as before. A damaged model file aborts
the addon's onnxruntime instead (an uncaught C++ exception, which ends the process), so a voice or speech process that
dies before it is ready is started again at once on WebAssembly (`voice.native_failed`, `voice.tts_native_failed`),
which then says the models are damaged and Ember downloads them again; after that, the native build is tried again.
`EMBER_VOICE_BACKEND=wasm` forces WebAssembly and `EMBER_VOICE_PROVIDER=cpu` turns CoreML off (both honoured by an
installed Ember: neither loads code). `npx electron test/smoke/voice-backends.mjs` (after `npm run build` and
`node scripts/voice/prepare.mjs`) starts both processes in Electron, has them hear a clip and speak a reply on the
build Ember picks and then on WebAssembly, and prints each one's build, load time and latency; CI runs it on Windows
and macOS, after `test/integration/voice.test.ts` (which runs on the picked build too; `EMBER_SHERPA_ADDON=<a
sherpa-onnx.node>` tries an addon where none is installed, such as `sherpa-onnx-linux-x64`'s on a newer Linux).

**The natural voice (Kokoro).** Where Ember's voice runs natively on the Piper voice at no more than 0.083 of real time
(Kokoro is about six times the work: `NATURAL_COST` in `app/voice/tts.ts`), Ember downloads Kokoro (`kokoro-en-v0_19`,
US English, Apache-2.0, 320 MB, pinned by SHA-256) in the background into the user's models folder
(`voice.natural_fetching`, `voice.natural_ready`), and the speech process starts again with it once it has nothing to
say. Each time it loads, Kokoro is timed on a sentence (on 4 threads): at more than 0.5 of real time (`NATURAL_MAX_RTF`)
the Piper voice speaks instead for the rest of the session, and `voice.tts_ready` says why (`natural`). No package
carries Kokoro. The int8 Kokoro builds aren't used: onnxruntime made them slower on x86 (below).

Measured in a Linux container (2.1 GHz Xeon, 4 vCPUs) with `sherpa-onnx-linux-x64`, the same addon as Windows' and
macOS' builds, in Electron's utility processes as Ember runs them (`test/smoke/voice-backends.mjs`), and in Node
(`test/integration/voice.test.ts`, the Piper/Kokoro benchmarks):

| | WebAssembly | Native |
|---|---|---|
| Hearing "Hey Ember, turn on night light" (spotter, both detectors, Moonshine) | 0.149 of real time | 0.042 (2 threads) |
| Voice process load | 1.6–3.0 s | 1.2–1.5 s |
| The 25 real-model voice tests | 36 s | 21 s |
| Piper "Kristin", real-time factor | 0.30–0.49 | 0.07–0.09 (1–2 threads) |
| Piper, first audio of a reply | 1.34 s | 0.33 s |
| Kokoro fp32 (`kokoro-en-v0_19`) | several times real time | 0.74 / 0.53 / 0.48 (2 / 3 / 4 threads) |
| Kokoro int8 (`kokoro-int8-multi-lang-v1_0`) | — | 1.14–1.27 (2–4 threads) |

### Connecting Copilot

Ember needs a GitHub account with Copilot. **Sign in with GitHub** uses Ember's own GitHub App (the device flow:
enter the code Ember shows on GitHub's page). The app's public client id is checked in at
`app/main/agent/github-app.ts` and built into `main.cjs`; `EMBER_GITHUB_CLIENT_ID` overrides it at run time. ci.yml's
`checks` job asks GitHub for a device code with the built-in id, so a client id GitHub doesn't accept (or the app's
device flow turned off) fails CI. Ember renews its own sign-in before the app's 8-hour token runs out. A build
without a client id (a fork) shows **Connect with GitHub CLI** instead, and signs in through the GitHub CLI:

```bash
sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo   # RHEL 8 has no gh of its own
sudo dnf install gh
gh auth login
```

Ember checks, in order: a token it stored itself, `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`,
then `gh auth token --hostname github.com`; a sign-in Copilot refuses gives way to the next (the message names it), and
**Sign out** forgets the refusals. Classic `ghp_` tokens are not accepted by Copilot. For Copilot Business or
Enterprise, your organisation must enable the **Copilot CLI** policy. No restart is needed: run `gh auth login` in a
terminal (Ember notices within a few seconds), or press **Check again**. If sign-in fails, the Copilot section says
which sign-in Ember tried and why; while offline, Ember retries by itself.

Then press **Ctrl+Alt+Space** and type a question.

To try Ember offline without Copilot, run the mock model and point Ember at it (development checkouts only: an
installed Ember ignores every `EMBER_TEST_*`, `EMBER_ADMIN_POLICY`, `EMBER_VOICE_MODELS`, `EMBER_BENCH_LOG`,
`EMBER_COPILOT_RUNTIME`, `EMBER_VOICE_DUMP` and `EMBER_AX_PROVIDER` switch):

```bash
node -e 'import("./test/mock-llm/server.mjs").then(m => m.startMockLlm({ port: 18090 })).then(s => console.log(s.baseUrl))' &
EMBER_TEST_PROVIDER_URL=http://127.0.0.1:18090/v1 npm run dev
```

### Where Ember keeps things

On Linux (Windows: §10.6, macOS: §11.6):

| What | Where |
|---|---|
| Settings | `~/.config/ember/settings.json` |
| Conversation (Copilot session state), only while Ember runs: resumed if Ember reconnects, deleted when it quits (one left by a crash is deleted at the next start) | `~/.config/ember/copilot/`, id in `~/.config/ember/agent.json` |
| GitHub token (encrypted with your keyring) | `~/.config/ember/github-token.bin` |
| Logs (JSON lines, rotated at 5 MB) | `~/.config/ember/logs/ember.log` |
| Audit log: every decision and action Ember took, with each task's request and result (JSON lines, each entry kept 30 days) | `~/.config/ember/audit/audit-YYYY-MM.jsonl` |
| Speech models (downloaded once, SHA-256 checked) | `~/.config/ember/models/` |
| What Ember made on its desk | `~/Ember/` |
| App profiles used on the desk (kept separate from yours) | `~/.config/ember/desk-profiles/` |
| Computers added over SSH, WSL's switch, and each computer's command switches | `settings.json` (`targets`, `commands`) |
| SSH's password helper: a two-line wrapper, and a socket for each connection while it asks | `~/.config/ember/ssh/askpass`; `$XDG_RUNTIME_DIR/ea-*/` |
| Node.js downloaded for other computers (SHA-256 checked) | `~/.config/ember/remote/runtime/` |

A hand edit of `settings.json` that Ember can't use is copied aside as `settings.json.bad-<time>` (the three newest
are kept); one it can repair is tidied once it has stayed the same for 2 s. A `settings.json` that can't be read at
start-up is never replaced with defaults: Ember says so, keeps changes in memory and saves them over the file once it
reads again.

Environment variables for development:

| Variable | Effect |
|---|---|
| `EMBER_USER_DATA=/tmp/x` | Use another settings and log folder |
| `EMBER_LOG_LEVEL=debug` | More detail in the log: `debug`, `info`, `warn` or `error`, in any case; anything else means `info` (and is logged) |
| `EMBER_LOG_STDOUT=1` | Also print log lines to the terminal (on by default in development) |
| `EMBER_PYTHON=/usr/bin/python3.12` | Python for the accessibility sidecar (Linux; default: `/usr/libexec/platform-python`, then `python3`) |
| `EMBER_AX_PROVIDER=fake` | Windows and macOS, development only: the accessibility host reads a pretend desktop instead of the real one (a small bench, or the windows in the JSON file `EMBER_AX_FAKE_DESKTOP` names) |
| `EMBER_TEST_ALLOW_LOOPBACK_SSH=1` | Development only: lets Ember connect over SSH to this same computer (`127.0.0.1`), for the SSH tests (§14.5) |
| `EMBER_REMOTE_DEV=1` | For the remote agent only: lets `ember-remote.cjs` run from a checkout's `dist/remote` instead of a verified install (§14.5); an installed agent ignores it |

Apps Ember must never read or capture are listed under `privacy.neverLook` in `settings.json` (matched against app name
and window title, ignoring characters that show nothing, such as a soft hyphen, and accents written apart; password
managers and polkit are listed by default).

### For administrators: `/etc/ember/policy.json`

On Windows the same JSON goes in the registry (§10.7), on a Mac in `/Library/Application Support/Ember/policy.json`
(§11.7).

An optional file that makes Ember stricter for everyone on the machine. Its values override users' settings, and
users can't loosen them. If the file exists but can't be read or has a mistake, Ember locks down until it is fixed,
and says so in its settings window: no actions, commands or listening, nothing sent to any model service (neither
GitHub Copilot nor the organisation's own endpoint), and nothing deleted from the audit log. Ember reads the policy
again every 10 seconds. Once it changes (tightened, repaired, added or removed, and the next read says so too), Ember
stops everything and stays locked down until the user restarts it (the bubble offers **Restart Ember**, and the
settings window says so), and the restart reads the new policy whole. Every key is optional:

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
| `confirmEveryAction` | A click before every action and every command, every time |
| `allowGrants` | `false` removes "Always in this app", and Ember asks before working in an app even when the user asked for help in it |
| `features.aiReview` | `false`: no command is sent to the model for review; every command Ember's rules flag asks the user ("Ask only about dangerous commands" off, managed) |
| `models` | Only these models; or pin the conversation and task models |
| `provider` | Use the organisation's own endpoint (`openai`, `azure` or `anthropic`) instead of GitHub sign-in; the key is read from `apiKeyFile` (or, without one, from the environment variable `EMBER_PROVIDER_API_KEY`) |
| `auditRetentionDays` | How long the audit log is kept (default 30; nothing is deleted while Ember is locked down) |
| `features.wsl` / `features.ssh` | No WSL / no connecting to other computers over SSH |
| `commands` | Commands on this computer, in WSL and over SSH: `"on"`, `"ask"` (every command asks) or `"off"` |
| `ssh` | Allowed hosts, no remote desktop, console consent, a Node.js mirror, the command grace |

The last three are explained in [COMMANDS-WSL-SSH.md](COMMANDS-WSL-SSH.md) §6. A policy that exists but doesn't
mention `commands` turns commands off. An Ember older than the release that added these keys reads them as a mistake
and locks down, so update Ember before deploying a policy that uses them.

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

A prebuilt binary that can't meet that may still ship for Windows and macOS only, as an optional dependency npm
installs only there, left out of the Linux layout (`scripts/package/layout.mjs`): sherpa-onnx's native addon is one
(§5, How speech runs). It isn't in `ember.nativeModules` (nothing is rebuilt), and Linux never installs it.

## 7. Packages

```bash
npm run package            # dist/package: the RPMs and the AppImage
```

This section is Linux's. The Windows zip is in §10.5, Ember.app and its dmg in §11.5.

The RPMs carry the build machine's dist tag (`.el8` when built on RHEL 8 or `rockylinux:8`, as CI does).

| Output | What it is |
|---|---|
| `ember-<v>-1.el8.x86_64.rpm` | Ember in `/opt/ember`, `/usr/bin/ember`, menu entry and icon. Library dependencies are listed explicitly (no auto-detection), optional parts are *Recommends* (Ember's desk, the system voice, microphone list, tray icons). It carries the speech models in `/usr/share/ember/voice-models` (a release must: `EMBER_RPM_MODELS=required`; they come from `node scripts/voice/prepare.mjs`), and replaces 0.1.0's separate `ember-voice-models` RPM on upgrade. `chrome-sandbox` is setuid root, so Ember stays sandboxed on STIG hosts where user namespaces are off. Needs `rpm-build` |
| `Ember-voice-models-<v>.zip` | The same models for computers that can't download them, unzipped where Ember looks (`scripts/package/models-zip.mjs`; README: Computers without internet access) |
| `Ember-<v>-x86_64.AppImage` | Runs without installing. Without user namespaces it runs without Chromium's sandbox (an AppImage can't carry a setuid helper); use the RPM on hardened machines |

The RPM's example policy, `/usr/share/doc/ember/policy.example.json`, turns commands on for this computer, WSL and
SSH, and leaves `ssh.allowedHosts` out: with `allowedHosts` set, even to `["*"]`, the settings window says SSH is
limited to some computers. Its notes are in `/usr/share/doc/ember/policy.README`.

The steps are `node scripts/package/stage.mjs` (a self-contained folder with only Linux x64 glibc builds; it sets the
staged binary's Electron fuses so the installed Ember ignores `--inspect` and `NODE_OPTIONS`, and keeps plain-Node mode
for its helpers, the desk helper and SSH's askpass helper, where Node's own `--inspect` still works but reaches only
that new process, not the running Ember: `node scripts/package/fuses.mjs <binary>` lists them; see §11.5 for what
plain-Node mode allows), `scripts/package/rpm.sh` and `scripts/package/appimage.sh` (pinned, checksummed appimagetool
and runtime). CI builds Ember's RPM, the speech models RPM (from the cached, checksum-verified models) and the AppImage
on `rockylinux:8`, checks every binary against glibc 2.28, installs the RPM with `dnf`, checks the installed binary's
fuses (no debugger, `NODE_OPTIONS` ignored), runs `ember doctor` and starts the installed Ember as a normal user. It
then installs the speech models RPM, runs `rpm -V` on both, writes an administrator's `/etc/ember/policy.json`, rebuilds
both as Release 2 (`EMBER_RPM_RELEASE=2 scripts/package/rpm.sh`), upgrades to them with `dnf upgrade`, runs `rpm -V`
again, checks `chrome-sandbox` is still setuid root and removes both with `rpm -e`. It fails if `/opt/ember`,
`/usr/share/ember`, `/usr/bin/ember`, the menu entry or `/usr/share/doc/ember` is left, or if the policy changed or
belongs to a package. It uploads Release 1's packages only when asked (§13): **Actions › ci › Run workflow** with
**packages** ticked (kept 3 days), and on a `v*` tag for the release (§15); at about 450 MB a run with the speech
models, uploading them every time filled the account's artifact storage. Bundled licences ship in `/opt/ember/THIRD_PARTY_NOTICES` (and as `%license` files in the
RPM); staging stops if the spec's `License:` tag doesn't cover a bundled package's licence or a library it bundles
(sharp-libvips's licensing table, and what sherpa-onnx's WebAssembly and its native addon hold, eSpeak NG's GPL-3.0-or-later among them:
`scripts/package/licences.mjs`), or if a bundled package ships no licence file and `licences.mjs` supplies none (the
texts are in `packaging/licences/`; sherpa-onnx's is pinned to 1.13.8, whose WebAssembly was checked). `sudo ember
doctor` works (it adds `--no-sandbox` only for the setup check run as root).

A restart (**Restart Ember** after an update, or after the administrator's policy changed) starts the AppImage again
(`$APPIMAGE`, with the same arguments) only when Ember runs from it, that is when `process.execPath` is inside
`$APPDIR`. An RPM Ember started from a shell in another AppImage app's terminal inherits that app's `APPIMAGE` and
`APPDIR`, and still restarts itself, as Electron does by default. A restart never passes on a launcher's `--ask`: an
Ember that **Ask Ember** started doesn't open the ask box again when it restarts.

`ember doctor` (or `npm run doctor` in a checkout) prints "Ember <v> setup check" with the settings window's rows: the
session, **Transparent windows** (the compositor), **Screen reading**, **Mouse and keyboard** (XTest), Copilot sign-in
or the organisation's endpoint, the admin policy, the microphone, speech models, **Speaking** (speech-dispatcher),
Ember's desk, **Window sandbox** and **Copilot's file watchers** (inotify), and says what to do about each problem. On a
Linux other than the RHEL 8 family, the operating system row says Ember is tested on RHEL 8 and may work but isn't
supported. It exits 1 if Ember can't work. **Start Ember when I log in** in the settings window adds
`~/.config/autostart/ember.desktop` (marked `X-Ember-Managed=true`); an `ember.desktop` you made yourself is left alone,
and the settings window says it is there.

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
harness turns off the Confirmer's guard against too-early clicks, which would drop its answers), and reads a long
typed text through first, as a user scrolls to its end before **Allow** works. Ember's test
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

On Linux (Windows: §10.9, macOS: §11.8):

| Symptom | Fix |
|---|---|
| Setup check says "Wayland session" | Log in with **GNOME on Xorg** (§1) |
| `The SUID sandbox helper binary was found, but is not configured correctly` | User namespaces are disabled (common on STIG-hardened machines; check `sysctl user.max_user_namespaces`, 0 means disabled). For development only: `npx electron . --no-sandbox`. The RPM installs the setuid sandbox helper, so installed Ember works there; `ember doctor` checks it. |
| `npm ci` fails with `edgesOut` | Upgrade npm: `npm install -g npm@11.6.2` |
| Electron download fails | `npx install-electron` |
| Ember doesn't react to “Hey Ember” | Check the **Voice** section: the models must be downloaded and the state must say “Listening for ‘Hey Ember’”. Check the right microphone is selected in GNOME Settings → Sound. `EMBER_LOG_LEVEL=debug` logs every wake, rejection and transcript length |
| "Copilot isn't answering. Reconnecting…", or "this computer has run out of file watchers" | Each Copilot conversation holds a file watcher (an inotify instance) and the per-user limit is often 128. Run `ember doctor`; raise the limit with `sudo sysctl -w fs.inotify.max_user_instances=512` and keep it with `fs.inotify.max_user_instances = 512` in `/etc/sysctl.d/90-ember.conf` |
| Ember says it can't read the screen | Check the **Screen reading** row; `python3-pyatspi` must be installed and accessibility on. Apps started before it was turned on must be restarted |
| "Ember couldn't start: Ember can't write to its data folder" | Make the folder yours again, for example `sudo chown -R $USER ~/.config/ember` (starting Ember with `sudo` can leave it owned by root); when the dialog says the disk is full or can only be read, free some space or start Ember where your home folder can be written to |

## 10. Windows

Ember runs on Windows 10 22H2 and Windows 11, x64 (Windows on Arm is best effort). §13 says what CI checks on
GitHub's `windows-2022` runners; PLAN.md §9 item 7 lists what still needs a real Windows 10 or 11 machine (a
`RemoteSigned` policy and **Unblock it** among them) and the CI runs still owed.

### 10.1 Set up

Install these, then open a new terminal:

- Node 22 (22.12 or later) from nodejs.org, then `npm install -g npm@11.6.2`;
- Git for Windows (`winget install --id Git.Git`); its Git Bash runs the shell commands below, as CI does;
- optionally the GitHub CLI, for signing in (`winget install --id GitHub.cli`).

Windows PowerShell 5.1 and .NET Framework 4, which Ember's accessibility helper needs, come with Windows. Nothing
else is needed, and PowerShell 7 (`pwsh`) is never used.

Check out with LF line endings: `.gitattributes` asks for them, and several tests compare source text.

```bash
git clone -c core.autocrlf=false https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot.git ember
cd ember
npm ci
npm run dev
```

The Ember window opens with its **Setup check**. The first time Ember reads an app, Windows PowerShell compiles the
accessibility helper, which takes a few seconds once per version of the helper (§10.4).

### 10.2 Commands

These work as in §5, from Command Prompt, PowerShell or Git Bash: `npm run dev`, `npm test`, `npm run lint`,
`npm run typecheck`, `npm run build`, `npm run test:smoke` and `npm run doctor` (the setup check, printed in the
terminal). CI runs the Copilot-runtime integration suite on Linux only, and the voice suite on Linux (WebAssembly),
Windows and macOS (the native addon, with `test/smoke/voice-backends.mjs`); on Windows it also runs the suites in
§10.3. Linux only: `npm run test:sidecar`, `npm run rebuild:el8`, `npm run check:symvers`, `npm run package`, Ember's
desk and the eval.

| Command | What it does |
|---|---|
| `npm run package:win` | Builds Ember, stages `dist/package/Ember` and zips it (§10.5) |
| `node test/smoke/launch.mjs --exe dist/package/Ember/Ember.exe` | The smoke test against the staged Ember |
| `node scripts/package/fuses.mjs dist/package/Ember/Ember.exe` | Lists the staged Ember.exe's fuses (`--check` fails unless they are Ember's) |

Lint, typecheck, unit tests, the build and staging need no desktop. The smoke test, the integration suites and the
setup check's window and helper rows need a signed-in desktop session.

Environment variables (§5) are set per command in Git Bash (`EMBER_LOG_LEVEL=debug npm run dev`), or for the session
in PowerShell (`$env:EMBER_LOG_LEVEL = "debug"`).

### 10.3 Integration suites

Each suite skips off Windows. With its variable set to 1, it fails instead of skipping when something it needs is
missing, so CI learns what broke. As CI's `windows` job runs them (Git Bash, after `npm run build`):

```bash
EMBER_WIN32_TEST=1 EMBER_UIA_TEST=1 EMBER_WINSYS_TEST=1 node scripts/run-integration.mjs \
  test/integration/win32-desktop.test.ts test/integration/uia-bridge.test.ts test/integration/ax-sidecar.test.ts \
  test/integration/win32-system.test.ts test/integration/win32-vocabulary.test.ts
node scripts/package/stage.mjs && node scripts/package/archive.mjs
EMBER_WIN32_TEST=1 EMBER_PACKAGED_APP=dist/package/Ember node scripts/run-integration.mjs test/integration/ember-win32.test.ts
```

| Suite | Variable | What it drives |
|---|---|---|
| `win32-desktop` | `EMBER_WIN32_TEST` | The window system and input against Ember's bench, `EmberBench.exe` (built by `test/fixtures/win_bench.ps1`, also as a 32-bit program): the stack, activation from a timer, capture, clicks, Unicode typing, keys released, a console window named `conhost` |
| `uia-bridge` | `EMBER_UIA_TEST` | The UI Automation bridge started as the host starts it: compiled into its cache, then started from it; reading, acting, a modal dialog, exiting when its input closes |
| `ax-sidecar` | `EMBER_UIA_TEST` | The accessibility host end to end through Ember's own client, against the bench |
| `win32-system` | `EMBER_WINSYS_TEST` | System integration: the app list, Notepad opened through `explorer.exe` without Ember's environment, dark mode switched and put back, no HKLM policy, the login item on and off |
| `win32-vocabulary` | `EMBER_WINSYS_TEST` | The vocabularies against real windows: a console, the stored-credentials dialog, File Explorer's address box, the Run dialog, the clipboard's password markers |
| `ember-win32` | `EMBER_WIN32_TEST`, `EMBER_PACKAGED_APP` | Ember's own composition and Perception against the bench: no system dialog at rest, the password field blacked out, the overlay out of screenshots, the Settings window matched by process id, the packaged host's ping; then Ember itself (`npm run build` first) opened with the real Win+Alt+Space, pressed while the user types in the bench's Name field, printing what the ask box holds of letters typed straight after (the typed-ahead probe: Windows has no keyboard hold) and, from Ember's log (`ask.open`, `ask.keyboard`), when Ember heard the chord, showed the box and had the keyboard, how many letters were typed before then and how many reached the bench's Name field, and expecting the box's "wait for this box" tip on these first openings; then Ember started again with Text size at Larger, opening the ask box at 728 × 111 (142 with that tip's row) with its field's text at 23.4 px |

CI's first step exports what the runner is (`EMBER_CI_ELEVATED`, `EMBER_CI_LUA`, `EMBER_CI_SERVER`): Windows Server
2022, run as an administrator (its shell too), one 1024×768 screen at 100 % and no Store apps. A check that runner
can't make prints "not testable on this runner: <reason>" instead of passing. On your own machine they are unset; set
`EMBER_CI_LUA=1` (UAC on, as on any normal Windows) to include the Settings-window check in `ember-win32`. In
PowerShell, set the variables first (`$env:EMBER_WIN32_TEST = "1"`, and so on), then run the same `node` commands.

The suites drive the real desktop: they open windows, click, type, use the clipboard, switch dark mode for apps (and
put it back) and add and remove Ember's login item. Leave the computer alone while they run.

### 10.4 The accessibility helper (UI Automation)

Ember reads and operates apps through Windows UI Automation, in two processes. Ember starts its accessibility host,
`dist/app/ax-sidecar.cjs`, with its own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`, no console window); it speaks
the same JSON-RPC as the Linux sidecar. The host starts the UI Automation bridge with this command line:

```
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\ember_uia.ps1
```

- `ember_uia.ps1` is a small bootstrap. Windows PowerShell 5.1's `Add-Type` compiles `ember_uia.cs` (C# 5, on .NET
  Framework 4), and the bridge then speaks newline JSON on stdin and stdout (`sidecar/uia/PROTOCOL.md`). No screen
  data passes through a PowerShell cmdlet, so PowerShell's logging never records what is on screen. Keep both files
  ASCII and C# 5: CI compiles them with Windows PowerShell 5.1 itself.
- The compiled helper is cached in the folder `EMBER_UIA_CACHE` names. Ember sets it to
  `%LOCALAPPDATA%\ember\uia-cache`, which holds `ember_uia-<SHA-256 of ember_uia.cs>.dll` with its own hash beside it.
  The bridge loads the DLL from its bytes after checking that hash, so it is never locked and a Mark-of-the-Web never
  blocks it. A new version compiles on its first start (3–10 s, longer while antivirus scans it); later starts take
  about a second. A compile deletes the older versions; deleting the folder makes the next start compile again. Without
  `EMBER_UIA_CACHE` the bridge compiles in memory every time.
- The two files are in `sidecar\uia\` in a checkout and `Ember\resources\sidecar\uia\` packaged; Ember names the
  script to the host in `EMBER_UIA_SCRIPT`.
- `PSModulePath` is set to `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`, so no user or PowerShell 7 module
  loads.
- Every UI Automation call has a deadline (about 0.8 s). An app that misses it is "busy" and skipped until it answers
  again; a UWP app is judged by its own process, not by ApplicationFrameHost, which hosts every UWP window.
- Ember's own process is never read (`EMBER_OWNER_PID`), and password fields' values never are.

To try the bridge by hand, from a Command Prompt in the checkout: it prints its ready line,
`{"ready":true,"version":1,"dpi":"per-monitor-v2",…}`, and exits when its input closes.

```bat
set PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules
set EMBER_UIA_CACHE=%TEMP%\ember-uia
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File sidecar\uia\ember_uia.ps1 < NUL
```

**When Windows won't run the helper.** A Group Policy execution policy, under
`SOFTWARE\Policies\Microsoft\Windows\PowerShell` in `HKLM` or `HKCU`, overrides `-ExecutionPolicy Bypass`. Ember never
works around an administrator's policy: the setup check's **Screen reading** row (in the settings window) and
**PowerShell** row (`ember-doctor.cmd`) say which case applies, and Ember keeps working with screenshots and the
borrowed mouse.

| Case | What Ember does |
|---|---|
| `AllSigned` or `Restricted`, or scripts turned off | Says "Your organisation allows only signed PowerShell scripts…". The helper isn't signed (PLAN.md §9), so an administrator has to allow it |
| `RemoteSigned`, and the helper's files carry the Mark-of-the-Web (a zip downloaded by a browser and extracted by Explorer) | Says "Windows blocked Ember's accessibility helper because it came from the internet" and offers **Unblock it**, which removes the `Zone.Identifier` stream from exactly `ember_uia.ps1` and `ember_uia.cs` (what `Unblock-File` does), only when the user presses it. The host starts the bridge again on its next request |
| Constrained Language Mode (AppLocker, WDAC, `__PSLockdownPolicy`) | Says "Windows PowerShell is restricted on this computer…". `Add-Type` can't run, and the host doesn't try again until Ember restarts |
| Any other failed start | The host tries again after 5 s, 30 s and 2 min, then every 10 min |

For an endpoint-protection or application-control allow-list, the setup check's **Helper command line** row prints the
exact command line, the script's path, and the compiled DLL's path and SHA-256. When Group Policy turns on PowerShell
module logging or transcription, the setup check notes that the helper's start-up is logged there (never what is on
screen).

### 10.5 Packages

```bash
npm run package:win        # npm run build, then node scripts/package/stage.mjs and node scripts/package/archive.mjs
```

| Output | What it is |
|---|---|
| `dist/package/Ember/` | The app folder: `Ember.exe` (Electron's `electron.exe`, renamed), `resources\app\` (the built app and its production modules, Windows builds only), `resources\sidecar\uia\` (the accessibility helper's two files, compiled at first use: §10.4), `resources\sidecar\atspi\ember_atspi.py` (the helper Ember runs inside a WSL distro, with the distro's own Python, to read its Linux apps), `resources\ssh\ember_askpass.cs` (SSH's password helper, compiled at first use into `%LOCALAPPDATA%\ember\ssh\`), `resources\remote-parts\` (the helper archives Ember copies to computers it reaches over SSH, with `remote-parts.json` and `remote-runtime.json`, which hold their SHA-256s and the pinned Node.js), `resources\ember.ico`, `ember-doctor.cmd`, `THIRD_PARTY_NOTICES` and Electron's licences |
| `dist/package/Ember-<v>-win-x64.zip` | That folder, zipped by Windows' own `tar.exe` |

Of these, only the two `.cs` files become programs on Windows: Windows PowerShell compiles them with `Add-Type` (an
application-control policy that allows Ember must allow those builds too). `ember_atspi.py` runs only inside WSL, and
the remote parts only on the computers Ember connects to.

`scripts/package/layout.mjs` says what each target holds; `stage.mjs` stages for the OS it runs on, never another.
For Windows it:
- gives `Ember.exe` Ember's own version resource (FileDescription and ProductName "Ember", the package's author and
  version) and icon with `resedit` (`scripts/package/exe-resources.mjs`), so Task Manager, the privacy settings and
  firewall prompts say "Ember". It leaves out Electron's certificate table, which any change voids, so Windows reports
  the file `NotSigned` rather than `HashMismatch`, which some endpoint protection reads as tampering;
- then sets the fuses in `Ember.exe`: no `--inspect`, no `NODE_OPTIONS`, and Node mode kept for its helpers (the
  accessibility host, and the job host that runs commands, WSL's launcher and SSH; §11.5 says what Node mode allows);
- adds `ember-doctor.cmd`: Ember.exe is a windowed program, which `cmd.exe` doesn't wait for, so the launcher runs
  `start "" /wait Ember.exe --doctor` and keeps its exit code;
- carries the Node.js runtimes for SSH remotes with `--with-runtimes` (from `node scripts/package/runtimes.mjs`, each
  checked against `remote-runtime.json`; release builds do), so Ember sends one without downloading it;
- bundles the speech models only with `--with-models` (release builds do; otherwise Ember downloads them when “Hey Ember” is turned
  on);
- refuses to stage without `dist/app/ax-sidecar.cjs` and the helper's files (`--allow-missing-sidecar` is for a local
  try only).

The zip is unsigned: README.md says what SmartScreen, Smart App Control and a `RemoteSigned` policy do on first start.
CI checks the staged Ember.exe as Windows sees it (`(Get-Item Ember.exe).VersionInfo`, and `Get-AuthenticodeSignature`
reporting `NotSigned`), its fuses, that `--inspect` is refused, that it starts and holds all six shortcuts, and its
setup check (§10.9). On first start a packaged Ember adds `Ember.lnk` to the user's Start menu (toasts need it) and
sets its AppUserModelId, `io.github.komaladitya08.ember`.

### 10.6 Where Ember keeps things

| What | Where |
|---|---|
| Settings | `%LOCALAPPDATA%\ember\settings.json` |
| Conversation (Copilot session state), only while Ember runs | `%LOCALAPPDATA%\ember\copilot\`, id in `%LOCALAPPDATA%\ember\agent.json` |
| GitHub token (encrypted for your Windows account with DPAPI) | `%LOCALAPPDATA%\ember\github-token.bin` |
| Logs | `%LOCALAPPDATA%\ember\logs\ember.log` |
| Audit log: every decision and action Ember took, with each task's request and result (JSON lines, each entry kept 30 days; the file only: no copy goes to a system log) | `%LOCALAPPDATA%\ember\audit\audit-YYYY-MM.jsonl` |
| Speech models | `%LOCALAPPDATA%\ember\models\`, or bundled: `Ember\resources\voice-models`, then `%ProgramData%\Ember\voice-models` |
| The compiled accessibility helper | `%LOCALAPPDATA%\ember\uia-cache\` |
| SSH's compiled password helper (OpenSSH 8.4 or newer) | `%LOCALAPPDATA%\ember\ssh\ember-askpass.exe` |
| Node.js downloaded for other computers | `%LOCALAPPDATA%\ember\remote\runtime\` |
| A marker that the marks' font cache was built for this version of Ember | `%LOCALAPPDATA%\ember\text-warmed` |
| Start menu shortcut (packaged Ember) | `Ember.lnk` in the user's Start menu programs folder |
| **Start Ember when I log in** | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `io.github.komaladitya08.ember` |

Ember keeps its data out of the roaming profile: Chromium's caches, Copilot's session state and 142 MB of speech
models would bloat it. Windows ignores the 0700 and 0600 modes Ember sets on Linux, so privacy rests on
`%LOCALAPPDATA%`'s per-user permissions: don't point `EMBER_USER_DATA` at a shared folder. Saving settings tries again
when an antivirus scan or a sync client holds the file.

### 10.7 For administrators

**The policy** is the same JSON as `/etc/ember/policy.json` (§5), kept in the registry: `HKLM\SOFTWARE\Policies\Ember`,
value `PolicyJson`, a string (`REG_SZ`) or a multi-string (`REG_MULTI_SZ`, whose lines are joined with line breaks).
Only administrators and SYSTEM can write there. Ember reads the 64-bit registry view, and no file. No value means no
policy; anything else Ember can't trust locks it down (§5: no actions, commands, listening or model service) until it
is fixed: a value it can't read, of another type, over 256 KiB, not JSON, or not valid for the schema.
`provider.apiKeyFile` isn't supported on Windows and locks Ember down too: put the key in a `ProviderApiKey` string
value beside `PolicyJson`, or in the `EMBER_PROVIDER_API_KEY` environment variable. Ember reads the value again every
10 seconds: once it changes, a running Ember stops and stays locked down until the user restarts it (§5).

From an elevated Windows PowerShell:

```powershell
New-Item -Path HKLM:\SOFTWARE\Policies\Ember -Force | Out-Null
New-ItemProperty -Path HKLM:\SOFTWARE\Policies\Ember -Name PolicyJson -PropertyType String -Force `
  -Value (Get-Content -Raw C:\path\to\policy.json)
```

The setup check's **Organisation policy** row then says "In force from HKLM\SOFTWARE\Policies\Ember (PolicyJson)".

For Group Policy or Intune, this template puts the JSON in one multi-line box, written as a `REG_MULTI_SZ` (each line
of the box at most 4096 characters). It isn't checked in CI, so try it in the Group Policy editor before deploying it.
Save the first part as `ember.admx` in `%SystemRoot%\PolicyDefinitions` (or your domain's central store), and the
second as `ember.adml` in its `en-US` folder:

```xml
<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="ember" namespace="Ember.Policies" />
    <using prefix="windows" namespace="Microsoft.Policies.Windows" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="Ember" displayName="$(string.Ember)" />
  </categories>
  <policies>
    <policy name="PolicyJson" class="Machine" displayName="$(string.PolicyJson)" explainText="$(string.PolicyJson_Help)"
      presentation="$(presentation.PolicyJson)" key="SOFTWARE\Policies\Ember">
      <parentCategory ref="Ember" />
      <supportedOn ref="windows:SUPPORTED_Windows_10_0" />
      <elements>
        <multiText id="PolicyJson" valueName="PolicyJson" required="true" maxLength="4096" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>
```

```xml
<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName>Ember</displayName>
  <description>Ember's organisation policy</description>
  <resources>
    <stringTable>
      <string id="Ember">Ember</string>
      <string id="PolicyJson">Organisation policy (JSON)</string>
      <string id="PolicyJson_Help">Makes Ember stricter for everyone on this computer: the same JSON as Ember's policy.json. If it isn't valid, Ember locks down until it is fixed.</string>
    </stringTable>
    <presentationTable>
      <presentation id="PolicyJson">
        <multiTextBox refId="PolicyJson">Policy JSON:</multiTextBox>
      </presentation>
    </presentationTable>
  </resources>
</policyDefinitionResources>
```

**Speech models for everyone**: Ember also looks in `%ProgramData%\Ember\voice-models`, after the copy beside it,
for the folder `node scripts/package/stage.mjs --with-models` puts in `resources\voice-models`.

**Allow-lists and logging**: the setup check's **Helper command line** row (§10.4). Ember warns when it runs as
administrator: it should run as the user, so that it can't act with administrator rights by mistake.

### 10.8 Remote desktops and WSL

Every window of Windows' own remote-desktop clients is a remote surface: `msrdc` (Remote Desktop and Azure Virtual
Desktop sessions, and WSLg, which draws each Linux app as an `msrdc` window), `mstsc` (Remote Desktop Connection, its
RemoteApp windows too), `msrdcw`, `Windows365` (the Windows App) and `RdClient.Windows` (the Store's Remote Desktop
app). Ember names a window by its program, so to Ember whatever runs inside one, a Linux terminal, a password prompt
or a whole remote desktop, is just "msrdc" or "mstsc": its terminal, security-window and never-look checks can't see
in, and one grant would cover every Linux app. So Ember refuses every action in these windows ("Ember can't tell
what's inside a remote window…") and blacks them out of every screenshot. Reading their titles is unchanged. Other
remote viewers on Windows (Hyper-V's `vmconnect`, VNC, TeamViewer, Citrix) aren't covered yet. On Linux and macOS the
remote-desktop and virtual-machine viewers are remote surfaces too, refused and blacked out the same way: on Linux
Remmina, virt-manager, virt-viewer and remote-viewer, GNOME Boxes and Connections, Vinagre, KRDC, the VNC viewers
(TigerVNC, TightVNC), FreeRDP, rdesktop, X2Go, AnyDesk, TeamViewer, NoMachine, SPICE's spicy, VirtualBox, VMware, QEMU
and Citrix Workspace; on macOS Screen Sharing, Apple Remote Desktop, Microsoft Remote Desktop and the Windows App, UTM,
Parallels Desktop, VMware Fusion, VirtualBox, TeamViewer, AnyDesk, VNC Viewer, TigerVNC, Jump Desktop, Royal TSX,
Citrix Viewer and NoMachine. The rule is `app/main/policy/remote-surface.ts` (`test/unit/remote-surface.test.ts`; no
Windows CI run has included it yet).

With WSL turned on for Ember (§14), WSLg's windows are identified instead: `app/main/wsl/rail.ts` tells WSLg's `msrdc`
from a Remote Desktop client's by its program's path (`isWslgImage`), a helper inside the distro reads the Linux apps
over AT-SPI, and `app/main/wsl/match.ts` pairs each RAIL window with its Linux window. A matched window's app becomes
`wsl:<distro>:<program>` ("gedit (Ubuntu)" to the user) everywhere Ember names windows, so grants, never-look, the
terminal and security-window checks apply to the Linux app itself, and it is no longer a remote surface. A window that
can't be matched (no helper, no session bus, an app without AT-SPI such as xterm, two windows Ember can't tell apart)
keeps "msrdc" and stays refused and blacked out; its title is then judged by the Linux vocabulary too (a Linux
"Authentication Required" title is a security window). The borrowed mouse and keyboard stay refused in every WSLg
window (`app/main/policy/target-rules.ts`) until the Windows backend checks a RAIL window's owner chain and types by
scancode there. The Windows X servers `vcxsrv`, `x410`, `xming`, `xwin` (Cygwin/X) and GWSL's programs (`gwsl` and
every `gwsl_*`: `GWSL_vcxsrv` and `GWSL_vcxsrv_lowdpi`, the X server whose windows the Linux apps are, and
`GWSL_service`) join the remote surfaces: their windows are Linux apps Ember can't identify. The WSL setup check row
(`app/main/wsl/doctor.ts`) recognises the same programs when it says an X server shows Linux apps.

### 10.9 Troubleshooting

Run the setup check: `.\ember-doctor.cmd` in the `Ember` folder, or `npm run doctor` in a checkout. It exits 1 when
Ember can't work.

| Setup check row | When it warns or fails | What to do |
|---|---|---|
| Platform | Not x64 or Arm (fails) | Use a 64-bit Windows |
| Operating system | Windows 10 before 22H2 (warns), before 1809 (fails) | Update Windows |
| Desktop session | Ember runs in a service's session | Sign in to Windows and start Ember from the Start menu |
| Transparent windows, Mouse and keyboard | Windows' window or input functions didn't load | Reinstall Ember |
| Accessibility helper | The helper didn't answer, or can't read apps; the row says what it reported (PowerShell's language mode, its display scaling) | Check the PowerShell row; if it is fine, reinstall Ember |
| Microphone | Windows doesn't let desktop apps use the microphone | **Settings › Privacy & security › Microphone › Let desktop apps access your microphone** (on Windows 10: **Settings › Privacy › Microphone › Allow desktop apps to access your microphone**); in the settings window, the row and the Voice section have **Open Settings** for it |
| Administrator | Ember runs as administrator | Start it from the Start menu, not with **Run as administrator** |
| PowerShell | A policy stops Windows PowerShell running the helper | §10.4: **Unblock it**, or ask your administrator |
| Helper command line | Never: it is the facts for an allow-list | — |
| Copilot | Not signed in, or the Copilot runtime is missing from the package | Sign in from Ember's settings (Win+Alt+E) or with `gh auth login`; reinstall if the runtime is missing |
| Organisation policy | The registry policy can't be trusted, so Ember is locked down | Fix `PolicyJson` (§10.7) |
| Speech models, Speaking | As on Linux; speech runs on sherpa-onnx's native addon (§5, How speech runs) | — |

The settings window's setup check adds **Screen reading** (the helper's state, with **Unblock it**), **Display
scaling** (the helper and Ember disagree on scaling, so a click may land in the wrong place on some monitors: set every
monitor to the same scale in **Settings › System › Display**, then restart Ember; if it still clicks in the wrong
place, report it at https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/issues) and **Keyboard
shortcuts**.

| Symptom | Fix |
|---|---|
| The first question about an app takes several seconds | The helper compiles once per version (§10.4); later starts take about a second |
| A shortcut is taken | PowerToys' Command Palette uses Win+Alt+Space and Xbox Game Bar Win+Alt+M by default: change theirs, or use Ember's handle |
| Ember won't borrow the mouse for a window | The window's program runs as administrator; Windows would drop Ember's input |
| Ember can't open an app by name | Store (MSIX) apps that have no Start menu shortcut, such as the new Teams, can't be opened by name yet |
| Ember refuses to act in a window | A Remote Desktop or WSL window (§10.8) |
| The first screenshot with marks waits for the font cache | About 10 s after start (60 s at login), Ember draws one mark's text with sharp so that fontconfig builds its cache before the first marked screenshot. The log says `text_warm.done` (with ms), `text_warm.failed` (tried again at the next start) or `text_warm.marker_failed`. It never runs for `--doctor`. Delete `text-warmed` (§10.6) to make it run again |
| Ember won't open a file or folder in File Explorer | File Explorer hides file types, so a program can show as "setup": Ember never opens an item whose name shows no type, and asks every time before opening one that shows a document's. Folders are opened by their path (the address box) or from the navigation pane |

## 11. macOS

Ember runs on macOS 13 or later, on Apple silicon; Intel Macs and macOS 13 are best effort until they are tried on
real machines. §13 says what CI checks on GitHub's `macos-15` runners, and on `macos-15-intel` for the Intel build;
PLAN.md §9 item 7 lists what still needs a real Mac (a fresh install from the dmg and a new build's permissions
among them).

### 11.1 Set up

Install the Xcode command line tools (`xcode-select --install`, for git), Node 22 (22.12 or later, from nodejs.org or
Homebrew's `node@22`) and then npm 11 (`npm install -g npm@11.6.2`), and optionally the GitHub CLI for signing in
(`brew install gh`).

```bash
git clone https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot.git ember
cd ember
npm ci
npm run dev:mac
```

Lint, typecheck, unit tests, the build and staging need no permissions and no logged-in desktop. The smoke test,
the integration suites and the setup check's permission rows need a logged-in desktop session and the permissions in
§11.2.

### 11.2 Running Ember in development, and its permissions

macOS gives a permission (Accessibility, Screen Recording, Input Monitoring…) to the app it holds responsible for a
process, not to the process itself. Which app that is depends on how Ember was started:

| Started with | macOS asks for, and lists | Notes |
|---|---|---|
| `npm run dev` in a terminal | The terminal app: Terminal, iTerm2, or Visual Studio Code for its built-in terminal | Every program that terminal starts shares the grants. Logs print in the terminal |
| `npm run dev:mac` | "Electron" (`node_modules/electron/dist/Electron.app`) | Builds, then starts the development Electron through LaunchServices (`open -n -W … --args "$PWD"`), as Ember.app is started. Your shell's environment variables don't reach it; logs go to `~/Library/Application Support/ember/logs/ember.log` |
| The packaged `Ember.app` | "Ember", by its bundle id `io.github.komaladitya08.ember` | Its ad hoc signature changes with every build, so after installing a new one, remove Ember from each list with **−** and add it again |

Ember's accessibility host is an Electron utility process of Ember's, started by Ember, so it shares whatever Ember
gets. `npm run doctor` judges the terminal it runs in. The setup check in the settings window shows each permission
with an **Open System Settings** button, which first makes macOS list Ember in that pane (macOS lists an app only
once it has asked).

### 11.3 Integration suites

Each suite skips off macOS. With its variable set to 1, it fails instead of skipping when something it needs is
missing (another OS, the backends, a permission), printing which processes macOS may hold responsible, so CI learns
which one needed the grant. The suites only read permissions and never ask for one: a prompt nobody answers would sit
over every later test. As CI's `macos` job runs them:

```bash
npm run build
EMBER_DARWIN_TEST=1 node scripts/run-integration.mjs test/integration/darwin-desktop.test.ts
EMBER_AX_TEST=1 node scripts/run-integration.mjs test/integration/ax-sidecar-darwin.test.ts
EMBER_MACSYS_TEST=1 node scripts/run-integration.mjs test/integration/darwin-system.test.ts test/integration/darwin-vocabulary.test.ts
node scripts/package/stage.mjs && node scripts/package/archive.mjs
EMBER_DARWIN_TEST=1 EMBER_PACKAGED_APP=dist/package/Ember.app node scripts/run-integration.mjs test/integration/ember-darwin.test.ts
EMBER_DARWIN_TEST=1 EMBER_PACKAGED_APP=dist/package/Ember.app node scripts/run-integration.mjs test/integration/askpass-darwin.test.ts
```

| Suite | Variable | What it drives |
|---|---|---|
| `darwin-desktop` | `EMBER_DARWIN_TEST` | The window system and input against the AppKit bench (`test/fixtures/mac_bench.js`, run by `osascript`) and TextEdit: the stack, activation from a process with no UI, typing read back over AX, Command+S. It also prints the permission answers, the input source, the cost of the borrow's polling, and whether a key another process holds shows without Input Monitoring |
| `ax-sidecar-darwin` | `EMBER_AX_TEST` | The accessibility host with the AX provider, through Ember's own client, against the bench; the same keys from a second host process |
| `darwin-system` | `EMBER_MACSYS_TEST` | System integration: the app list, TextEdit opened through LaunchServices, the VoiceOver probe, no admin policy, Dark Mode switched through System Events and back, a red window captured at one pixel per point |
| `darwin-vocabulary` | `EMBER_MACSYS_TEST` | The vocabularies against real windows: Terminal, Console and Calculator, System Settings' privacy pages, an administrator prompt's owner, the clipboard's password markers |
| `ember-darwin` | `EMBER_DARWIN_TEST`, `EMBER_PACKAGED_APP` | Ember itself, built and started as a login start: it shows beside the user's app without taking its place, the ask box takes keys while TextEdit stays the active app, screenshots with the password field blacked out and the overlay left out, polling under 2 ms, the ask box opened with the real ⌃⇧⌘Space, printing what it holds of letters typed straight after (the typed-ahead probe: macOS has no keyboard hold) and, from Ember's log (`ask.open`, `ask.keyboard`), when Ember heard the chord, showed the box and had the keyboard and how many letters were typed before then, and expecting the box's "wait for this box" tip on these first openings; the ask box at Text size Larger, 728 × 111 points (142 with that tip's row) with its field's text at 23.4 px; then the packaged host's answer |
| `askpass-darwin` | `EMBER_DARWIN_TEST`, `EMBER_PACKAGED_APP` | SSH's askpass as Ember runs it: real `ssh-add` unlocks a new key through Ember's askpass wrapper and its real askpass server, with the development Electron and Ember.app; sampled every 50 ms, the askpass process is never a regular app to LaunchServices (no Dock icon), there is one, and it starts no other process; a cancel leaves the key locked |

On your own Mac, run them from a terminal that has Accessibility, Screen Recording and Input Monitoring (the terminal
is the responsible app). With `EMBER_MACSYS_TEST=1`, `darwin-system` switches Dark Mode and back (macOS first asks to
let your terminal control System Events), and `darwin-vocabulary` raises a real administrator password prompt, which
it closes itself. The suites open windows, type and use the clipboard: leave the Mac alone while they run.

**How CI grants the permissions.** Permissions live in TCC databases that System Integrity Protection guards on a
normal Mac. GitHub's macOS runners let a job write them (SIP is off there), so `scripts/package/tcc.mjs` does it:

| Command | What it writes |
|---|---|
| `node scripts/package/tcc.mjs grant-paths --ancestors <binary>…` | Accessibility, Screen Recording and Input Monitoring (posting and listening to events) in the system database, and Apple Events to System Events in the user's database, for each binary and for the runner's own processes above this one: CI passes the development Electron, `node`, `/bin/bash` and `/bin/zsh` |
| `node scripts/package/tcc.mjs approve-capture <binary>…` | macOS 15's screen-capture approval, so no alert waits for an answer before the first capture |
| `node scripts/package/tcc.mjs grant-bundle dist/package/Ember.app` | The same rows for Ember.app, by its bundle id and with the bundle's real code requirement (an ad hoc signature's requirement is its own hash, so a row without one would describe no build) |
| `node scripts/package/tcc.mjs show` | The rows now in both databases |

On a Mac of your own, grant permissions in System Settings instead. The runner's processes already hold their grants,
so a test in one of them proves nothing about what Ember.app gets. CI therefore runs the packaged setup check the way a
user opens Ember, through LaunchServices (`open -n -W --stdout <file> -a dist/package/Ember.app --args --doctor`),
twice: before Ember.app's own rows exist, when the **Reading and using apps** and **Accessibility helper** rows must
fail, and after, when both must pass. It also records whether key-state polling works without Input Monitoring
(PLAN.md §10 M11, departure 6).

### 11.4 The AX provider

Ember reads and operates Mac apps through the accessibility API (AX). Ember's main process uses AX only for its window
system (the focused window, and bringing a window to the front), with a 0.25 s timeout, since those calls block the UI
thread. Reading and acting on apps happens in the accessibility host, through koffi in the host's own process
(`app/sidecar-host/providers/ax-darwin*.ts`):

- an app gets 0.8 s per call; one that misses it is busy for 5 s and its windows are listed as last seen, and the
  window list asks apps within a budget, so hung apps can't hold up a request;
- Ember's own process is never asked anything, and the system's credential and consent prompts (SecurityAgent and the
  like) are listed but never read; password fields and hidden elements give their facts, never their values;
- elements are keyed `<pid>:h<CFHash>`, the same in every host process while the element lives, so a password field
  stays known as one across host restarts (two elements of one answer with the same hash get index-path keys);
- Chromium and Electron apps build their tree only when asked: the first read sets `AXManualAccessibility` once;
- no action raises a window, so tier 1 works in the background.

The host is an Electron utility process of Ember's (Ember sends each request as a message on its parent port; it
answers on stdout), so when LaunchServices started Ember, macOS holds Ember.app responsible for the host too, and one
grant covers both (CI's attribution check shows it). The macOS build never runs Ember's binary as plain Node (§11.5).

### 11.5 Packages

```bash
npm run package:mac        # npm run build, then node scripts/package/stage.mjs and node scripts/package/archive.mjs
```

| Output | What it is |
|---|---|
| `dist/package/Ember.app` | Electron.app, renamed; its executable is `Contents/MacOS/Ember`; the app, notices and licences are in `Contents/Resources`; signed ad hoc |
| `dist/package/Ember-<v>-mac-<arch>.zip` | Made with `ditto`, which keeps the frameworks' links and the signature (`zip -r` breaks both) |
| `dist/package/Ember-<v>-mac-<arch>.dmg` | Made with `hdiutil`: Ember.app beside a link to Applications |

`stage.mjs` stages for the Mac it runs on (`scripts/package/layout.mjs` says what the bundle holds). For macOS it:
- renames the executable to `Contents/MacOS/Ember` (`CFBundleExecutable` = `Ember`). Electron's `app.isPackaged` is
  false for an executable named "electron", and an Ember that took itself for a development build would honour the
  `EMBER_*` switches and `--inspect`. The helper apps keep Electron's names, which Electron looks for;
- edits `Info.plist` (`scripts/package/mac-bundle.mjs`): the name "Ember", the bundle id
  `io.github.komaladitya08.ember` (the permissions hang on it), `LSMinimumSystemVersion` 13.0, and the texts macOS
  shows when Ember asks for the microphone, to control System Events and to reach the local network. `LSUIElement` is
  unset: Ember has a Dock icon and an app menu, which starts with **About Ember** (the version and the MIT licence) and
  whose Quit goes through Ember's own question while a task runs;
- sets the fuses in the Electron Framework binary inside the bundle, not in the small `Contents/MacOS/Ember` launcher
  (`scripts/package/fuses.mjs` lists them, given that binary's path, as CI's packaged checks do); RunAsNode is off, so
  Ember.app refuses `ELECTRON_RUN_AS_NODE` (CI gives it a script that would leave a mark and checks that Ember started
  as itself instead), while Linux and Windows keep plain Node for their helpers (`fuses.mjs` says why). With node mode,
  any program running as the user could start Ember's binary as Node with a script of its own and, started so that
  macOS holds Ember responsible for it (by launchd, say), act with Ember's Accessibility and Screen Recording grants
  (review #177). Ember's own helpers don't need it on a Mac: the accessibility host is a utility process (§11.4) and
  SSH's askpass is Ember itself, started with `--ember-askpass`. The hardened runtime closes the `DYLD_*` and debugger
  ways in;
- signs the whole bundle ad hoc last, under the hardened runtime (`--options runtime`), with `mac-bundle.mjs`'s
  `ENTITLEMENTS`: JIT and unsigned executable memory for V8, library validation off (an ad hoc signature has no team
  ID, so library validation would refuse Electron Framework, koffi, sharp and the speech runtime), the microphone and
  Apple events. It then reads back the runtime flag and the entitlements, fails if
  `allow-dyld-environment-variables` or `get-task-allow` is there, and verifies the bundle (`codesign --verify --deep
  --strict`). Flipping the fuses voids Electron's signature, and Apple silicon kills code whose signature doesn't
  match. Every build is a new identity to macOS, which is why permissions must be given again after an update;
- builds one architecture, the Mac's own: an Intel `Ember.app` is built on an Intel Mac (in CI, the `macos-x64` job on
  `macos-15-intel`, which checks with `lipo -archs` that every Mach-O file in it runs on x86_64);
- bundles the speech models only with `--with-models`.

CI reads the hardened-runtime flag on Ember.app's signature, and tries `DYLD_INSERT_LIBRARIES` only where SIP is on.
The hosted macOS runners report SIP off, so there it leaves a notice, and the `DYLD_*` behaviour is unproven in CI.

A Developer ID signature and notarisation are out of scope (no certificates; PLAN.md §9). README.md says what
Gatekeeper does on first start.

### 11.6 Where Ember keeps things

| What | Where |
|---|---|
| Settings | `~/Library/Application Support/ember/settings.json` |
| Conversation (Copilot session state), only while Ember runs | `~/Library/Application Support/ember/copilot/`, id in `agent.json` beside it |
| GitHub token (encrypted with a key kept in your login Keychain) | `~/Library/Application Support/ember/github-token.bin` |
| Logs | `~/Library/Application Support/ember/logs/ember.log` |
| Audit log: every decision and action Ember took, with each task's request and result (JSON lines, each entry kept 30 days; the file only: no copy goes to the system log) | `~/Library/Application Support/ember/audit/audit-YYYY-MM.jsonl` |
| Speech models | `~/Library/Application Support/ember/models/`, or bundled: `Ember.app/Contents/Resources/voice-models`, then `/Library/Application Support/Ember/voice-models` |
| SSH's password helper, and Node.js downloaded for other computers | `~/Library/Application Support/ember/ssh/`, `~/Library/Application Support/ember/remote/runtime/` |
| A marker that the marks' font cache was built for this version of Ember | `~/Library/Application Support/ember/text-warmed` |
| **Start Ember when I log in** | A login item for Ember.app (**System Settings › General › Login Items**) |

A copy run from the dmg or from Downloads is moved by macOS to a temporary place before it starts (App Translocation),
so its permissions and its login item don't stick: the setup check's **Applications folder** row offers **Move to
Applications**.

### 11.7 For administrators

**The policy** is the same JSON as `/etc/ember/policy.json` (§5), in `/Library/Application Support/Ember/policy.json`.
The folder must be a real folder, not a link, that belongs to root and only root can write; the file must be a file,
not a link, that belongs to root and that group and others can't write. No folder or no file means no policy; anything
else Ember can't trust locks it down until it is fixed. `provider.apiKeyFile` works as on Linux. Ember reads the file
again every 10 seconds: once it changes, a running Ember stops and stays locked down until the user restarts it (§5).
Ember reads this file only, not managed preferences, so deploy it as a file (a package or a script from your
management tool):

```bash
sudo mkdir -p "/Library/Application Support/Ember"
sudo chown root:wheel "/Library/Application Support/Ember" && sudo chmod 755 "/Library/Application Support/Ember"
sudo install -o root -g wheel -m 644 policy.json "/Library/Application Support/Ember/policy.json"
```

The setup check's **Organisation policy** row then says the policy is in force from that file.

**Speech models for everyone**: Ember also looks in `/Library/Application Support/Ember/voice-models`, after the copy
inside Ember.app, for the folder `node scripts/package/stage.mjs --with-models` puts in
`Contents/Resources/voice-models`.

### 11.8 Troubleshooting

Run the setup check through LaunchServices, so that macOS judges Ember's own permissions (README.md has the commands).
Run from Terminal, `/Applications/Ember.app/Contents/MacOS/Ember --doctor` reports Terminal's permissions instead, and
`npm run doctor` in a checkout reports your terminal's. It exits 1 when Ember can't work.

| Setup check row | When it warns or fails | What to do |
|---|---|---|
| Operating system | Older than macOS 13 | Update macOS |
| Transparent windows | macOS's window functions didn't load | Reinstall Ember |
| Accessibility helper | The helper didn't answer, or can't read apps | Allow Ember under Accessibility, then run the setup check again |
| Mouse and keyboard | No Accessibility permission, or an app holds secure input | Allow Ember under Accessibility; see Secure input |
| Reading and using apps | Not allowed | **System Settings › Privacy & Security › Accessibility**: switch Ember on (after an update: remove it with **−** and add it again) |
| Screen Recording | Not allowed: no screenshots, and no other apps' window titles | **Privacy & Security › Screen Recording**: switch Ember on, then quit and reopen Ember. macOS asks again about once a month: choose **Allow** |
| Input Monitoring | Not allowed: Ember can't notice when you take over the keyboard, so it uses neither the mouse nor the keyboard for you | **Privacy & Security › Input Monitoring**: switch Ember on |
| Microphone | Off for Ember | **Privacy & Security › Microphone**: switch Ember on |
| Secure input | An app (the row names it) has secure keyboard entry on, so Ember won't look at the screen or use the mouse or keyboard until it's off; the settings window's setup check shows this row too | Close the password field, or turn off Secure Keyboard Entry there (Terminal: **Terminal › Secure Keyboard Entry**) |
| Applications folder | Not in the Applications folder | Quit Ember, drag it into Applications and open it from there |
| Root | Ember runs as root | Start it as yourself |
| Copilot, Organisation policy, Speech models, Speaking | As on Linux; Ember speaks with macOS's own voices | — |

| Symptom | Fix |
|---|---|
| A permission is switched on but doesn't work | A new build is a new identity to macOS. Once a row's **Open System Settings** didn't take, the setup check adds **Reset Ember's permissions**: it takes Ember off the Accessibility, Screen Recording and Input Monitoring lists, then switch each on again. By hand: remove Ember from the list with **−** and add it again |
| Ember can't change Dark Mode | Allow Ember to control System Events: **Privacy & Security › Automation** |
| Ember won't type, and says to switch to a keyboard layout | An input method (Japanese, Pinyin, Korean…) is selected, and it would compose from Ember's keys. Choose a keyboard layout; Ember can still fill fields directly |
| **Start Ember when I log in** doesn't stick | Allow Ember in **System Settings › General › Login Items**; a copy outside Applications can't register |
| Ember can't reach your organisation's AI service on the local network (macOS 15) | Allow Ember under **Privacy & Security › Local Network** |
| The first screenshot with marks waits for the font cache | About 10 s after start (60 s at login), Ember draws one mark's text with sharp so that fontconfig builds its cache before the first marked screenshot. The log says `text_warm.done` (with ms), `text_warm.failed` (tried again at the next start) or `text_warm.marker_failed`. It never runs for `--doctor`. Delete `text-warmed` (§11.6) to make it run again |
| Ember won't open a file or folder in Finder | Finder hides file types (an app's `.app` always), so Ember never opens an item whose name shows no type, and asks every time before opening one that shows a document's. It opens the sidebar's places by name (Recents, Applications, Desktop, Documents, Downloads, iCloud Drive, the startup disk, Network…); the home folder, other disks, servers, folders you added to the sidebar and folders in the window itself are opened by their path (**Go › Go to Folder**) |

## 12. Working on the platform layer

Everything that differs between Linux, Windows and macOS lives in `app/main/platform/`. `loadPlatform()` (`index.ts`)
picks the backend by `process.platform` alone, never by `$DISPLAY`, and gives main one `Platform` object: the window
system, input, overlay shaping, the accessibility helper's launch, system integration (`system`) and the desk (Linux
only). `types.ts` is the contract. Outside `app/main/platform/`, the main process never tests `process.platform` or
reads a native window handle: `test/unit/platform-boundary.test.ts` fails if it does.

Every backend keeps the X11 conventions, so the code above it doesn't change:
- **Units** are native: physical pixels on Linux and Windows (Windows: Per-Monitor-V2), points on macOS. Coordinates
  can be negative on Windows and macOS (a monitor left of or above the primary one), so test a point with
  `onScreen()`, never against 0. Only Ember's own windows use Electron's DIP, through `toDip`.
- **Window ids** are one space per backend (the X window, the HWND, the CGWindowID), compared with `===`.
- **App names**: WM_CLASS on Linux; on Windows the program's file name without `.exe` (`notepad`; `conhost` for a
  console window; the hosted app's program for a UWP frame); on macOS the app's localised name. The accessibility
  helper reports the same name, so the policy, never-look and grants match on both.
- **Keys** are X keysym names ("Return", "Control_L"); mouse buttons are X's numbers and button-mask bits; key codes
  are opaque per backend and never 0.

Rules for code under `app/main/platform/` and `app/sidecar-host/`:
- It loads under plain Node: no `electron` import. Electron's objects come in through structural types
  (`ScreenLike`, `OwnWindowHandle`, `PlatformDeps.electron`).
- Every module imports on every OS (the unit tests import them on Linux). koffi is loaded lazily, through
  `createRequire(__filename)` inside a factory (`loadWin32()`, `openCoreGraphics()`…) that runs only on its own OS;
  each library is bound once per module; every `koffi.load` is guarded, so a missing library gives null or a safe
  default. koffi's type names are process-wide: pass structures as Buffers (`void *`), as the Windows backend does, or
  give a named type an `Ember` prefix and define it once (`EmberWin32Point`; `EmberCGPoint` through `namedStruct()`).
  Win32's `BOOL` is `int`; pointers come back as BigInt or null; never call `koffi.view()`.
- Fail closed: a check that can't run refuses, returns null or sends no image (`systemDialogOpen()` is true when it
  can't tell; no capture without Screen Recording; a policy Ember can't trust locks it down).
- A window's screenshot blacks out what covers it, Ember's own windows and its secret fields. The app's own popups
  over it (menus, lists, autofill panels) are looked through for secret fields only when accessibility lists them as
  windows of the app; one it doesn't list (a macOS menu, a Windows menu's shadow) is pictured as it is, and
  `perception.popup_unmatched` in the log names its app, size and OS.
- Each OS-keyed list lives in one place, with the Linux row frozen (tests pin it): `app/shared/shortcuts.ts`,
  `app/shared/words.ts`, `app/shared/never-look.ts`, `app/main/policy/vocabulary.ts`, `app/main/hands/terminals.ts`,
  `app/main/agent/clipboard-formats.ts` and `app/main/policy/remote-surface.ts`.
- Test the logic on Linux with fakes (`test/unit/platform-*`, `win32-*`, `darwin-*`, `sidecar-host-*`), and what
  needs the real OS in `test/integration` (§10.3, §11.3), skipped elsewhere and failing when its variable is 1.

## 13. CI on Linux, Windows and macOS

`.github/workflows/ci.yml` runs on pushes to `main`, on `v*` tags, on pull requests, and when started by hand.

| Job | Runner | What it checks |
|---|---|---|
| `checks`, `el8`, `package`, `eval` | `ubuntu-24.04`, most in `rockylinux:8` | Linux, as in §5–§8 |
| `windows` | `windows-2022` | Runner facts, unit tests, build, the bridge compiled and started as Ember starts it, the smoke test, the integration suites (§10.3), the zip and the packaged checks (§10.5), the setup check's rows (§10.9) |
| `macos` | `macos-15` (Apple silicon) | Runner facts and the image's own grants, unit tests, build, the smoke test, the grants (§11.3), the integration suites, the bundle, zip and dmg with the packaged checks (§11.5), and the attribution and Input Monitoring checks through LaunchServices |
| `macos-x64` | `macos-15-intel` | The Intel bundle: build, `darwin-desktop`, every Mach-O file x86_64, the packaged checks and the smoke test. Runs on pushes to the default branch, on tags, and when asked |

To start a run by hand: **Actions › ci › Run workflow**, or `gh workflow run ci.yml --ref <branch> -f only=windows`.

| Input | Default | What it does | Why |
|---|---|---|---|
| `packages` | off | Uploads the packages as artifacts, kept 3 days (a `v*` tag always uploads them, for the release job, §15): `ember-packages` (RPM and AppImage), `ember-windows` (the zip), `ember-macos` (zip and dmg), `ember-macos-x64` | They are 200–400 MB each, and uploading them on every run filled the account's artifact storage, after which no artifact could be uploaded at all |
| `intel` | off | Also runs `macos-x64` (with `only` set to `all` or `macos`) | macOS minutes cost ten times Linux's on a private repository, so the Intel job runs only on the default branch and tags unless asked |
| `only` | `all` | Runs only one platform's jobs: `linux` (the four Linux jobs), `windows` or `macos`. Pushes and pull requests always run them all | The same cost: after a fix for one OS, rerun only that OS |

The Windows and macOS runners can't show everything (§10.3, §11.3): what they can't, a suite prints as "not
testable on this runner: <reason>", and PLAN.md §9 item 7 keeps it for a real machine.

## 14. Working on SSH, WSL and commands

What users and administrators see is in [COMMANDS-WSL-SSH.md](COMMANDS-WSL-SSH.md); this section is for changing the
code. A task acts on one **target**: `local`, `wsl:<distro>` or `ssh:<host id>`. Ember's brain (Copilot, the
conductor and workers, the bubble, questions, voice and the GitHub token) always stays on the PC; a WSL distro or a
computer reached over SSH is eyes, hands and a command runner. PLAN.md M12 lists the packages and their state.

### 14.1 Where the code lives

| Folder | What it holds |
|---|---|
| `app/main/targets/` | The targets runtime (`runtime.ts`, the only part main calls): the registry of computers (`registry.ts`), naming a computer from the user's own words and binding a task to it (`resolve.ts`), each target's hands and command service, the handle menu's part, the first-use consent cards (`consent.ts`), noticing the user's own `ssh` (`offer.ts`), quick context, the settings window's channel and the setup check rows (`doctor.ts`) |
| `app/main/commands/` | Commands on every target: the contract (`types.ts`); the classifier (`lex-posix.ts`, `lex-powershell.ts`, `lex-cmd.ts`, `tables.ts`, `paths.ts`, `classify.ts`, which also records each shell script a command runs and asks for one it can't read first), the intent matcher (`intent.ts`) and the decision (`decide.ts`); output shaping (`output.ts`, `redact.ts`, `prompts.ts`, `taint.ts`); `run_command`'s flow (`flow.ts`, with `carried.ts`: it reads each recorded script through the target's runner and classifies its text before deciding, L8) and the command window's controller (`window.ts`) |
| `app/main/commands/run/` | Running a command: the fixed launchers (`shells.ts`: the command text travels in `EMBER_CMD`, never on any argv), the environment, the local runner (`local.ts`), the stop ladder and the sweep, the target's facts and path checks (`inspect.ts`, with `readScriptText` and `decodeScript`: a script's first 64 KiB, a regular file only, never `/dev`, `/proc` or a UNC path), and the Windows job host (`job-host.ts`: Ember's binary in Node mode holding a kill-on-close job object, so Stop ends the whole tree) |
| `app/main/wsl/` | WSL discovery from the registry and `wsl.exe`, never starting a distro (`discover.ts`, `lxss.ts`, `decode.ts`), the WSL runner (`runner.ts`), the `wsl` setup check row (`doctor.ts`), and the WSLg layer: the router over UIA and each distro's AT-SPI helper (`router.ts`, `routed-sidecar.ts`, `routed-windows.ts`, `launch-sidecar.ts`), window matching (`match.ts`), RAIL identification (`rail.ts`), Start-menu launching (`apps.ts`) and the joined vocabularies (`privacy.ts`) |
| `app/main/remote/` | The PC's side of SSH: the protocol's schemas (`protocol.ts`), the framed stream both ends share (`mux.ts`), the link's worker thread (`link-worker.ts`), connections (`connections.ts`), ssh's argv, configuration and errors, the bootstrap script (`scripts/bootstrap.sh`), the install plan and the same-machine check, the Node.js download, the askpass server, noticing ssh (`notice-ssh.ts`), the prompt window's controller (`prompt-window.ts`), and the remote target's perception, accessibility, apps and runner (`target.ts`, `remote-*.ts`) |
| `app/remote/` | `ember-remote`, the agent Ember runs on a computer reached over SSH (plain Node 24, `main.ts`): the protocol loop, gate 2 (its own re-check of every step and command, which also reads the shell scripts a command runs on its own filesystem: the PC can't, so its gate 1 leaves them to L8), the commands it runs (`commands.ts`: output held back while the link's bulk queue is over 1 MiB), desktop discovery and the desktop child, PNG capture, the single-instance lock, liveness, and the remote's own policy and audit |
| `app/askpass/` | `askpass.cjs`, which ssh runs to ask for a password on a Linux or macOS PC (on Linux as plain Node; on a Mac inside Ember itself, started with `--ember-askpass`, which runs it as a worker thread and shows nothing: `in-ember.ts`); the answer comes from Ember's prompt window over a Unix socket made for that one ssh run |
| `app/renderer/command/`, `app/renderer/prompt/` | The command window (xterm.js, no add-ons) and the prompt window (host keys, passwords, consent cards) |
| `app/shared/targets.ts`, `commands.ts`, `consent.ts`, `remote-ui.ts`, `visible-text.ts` | Target ids and summaries; the two windows' IPC names and types; the consent cards' versions (`FEATURE_CONSENT_VERSION`); `visibleText`, which shows every invisible character of a command |
| `app/main/policy/target-rules.ts` | The policy's one seam for refusals that depend on the target (the borrowed mouse in WSLg windows) |
| `sidecar/atspi/ember_atspi.py` | Also runs inside a WSL distro, with `EMBER_ATSPI_FIND_BUS=1` (finding the session bus the Linux apps use); without the variable it is the Linux sidecar, unchanged |
| `sidecar/notice/ember_notice.py` | The notice with **Stop** on a remote's screen while Ember uses it |

### 14.2 Builds and packages

`npm run build` also builds `dist/app/askpass.cjs`, `dist/app/remote-link.cjs` (the link worker) and
`dist/app/job-host.cjs`, the `command` and `prompt` pages, and the remote agent: `dist/remote/ember-remote.cjs`, with
esbuild's metafile in `dist/remote/meta.json`. The agent's bundle takes `app/remote/capture-stub.ts` wherever code
imports `app/main/perception/capture.ts`, so sharp isn't in it, and `test/unit/remote-agent-build.test.ts` checks from
the metafile that nothing from Electron, sharp, the Copilot SDK, Node's network modules, the renderers or the
PC-only folders is in it. `@xterm/xterm` 5.5.0 (MIT, pinned exactly, renderer only) is the one dependency this work
added.

What a remote runs is packaged per target (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`):
`scripts/package/remote-parts.mjs` writes `ember-remote-parts-<partsId>-<target>.tar.gz` and `remote-parts.json` into
`dist/remote-parts/` with its own deterministic tar writer (the same bytes on every OS), every `package*` script runs
it, and `stage.mjs` copies the folder to `resources/remote-parts/`, refusing to stage without it unless
`--allow-missing-remote-parts` is given. `scripts/package/remote-runtime.json` pins the Node.js 24 release remotes run
(`pinned`, `minimum`, and each target's file, size and SHA-256 from that release's signed `SHASUMS256.txt`); the PC
downloads it on first use per target and checks it before sending.

### 14.3 Rules for this code

- **Electron** may be imported only in `main.ts`, `windows.ts`, `overlay.ts`, `handle.ts`, `ask.ts`, `voice.ts`,
  `revive.ts`, `desk/view.ts` and the preloads; ESLint enforces it. The two new windows' factories are in
  `windows.ts`, and their controllers take the window by injection.
- **What a remote runs loads under plain Node**: nothing in the agent's import graph reaches Electron (the bundle
  test). **koffi loads lazily**, inside the function that needs it, in `app/main/commands/**`, `app/main/wsl/**`,
  `app/main/remote/**` and `app/remote/**`: a macOS remote ships no koffi, so a top-level import would crash the agent
  there. Never `koffi.view()`.
- **A target's paths use the target's rules**: `node:path/posix` or `node:path/win32`, or `resolveTargetPath`, never
  `node:path`, in `app/main/commands/**`, `app/main/wsl/runner.ts`, `app/main/wsl/service.ts`, `app/main/remote/**`
  and `app/remote/**` (ESLint enforces it): a Windows PC runs commands on Linux targets.
- **`..` is the kernel's on a POSIX target**: `x/..` is the folder above where x really leads, so with a link before
  it, `resolveTargetPath`'s lexical form isn't the file that opens. The classifier also probes `physicalForm` (the
  path with its `..` kept) and judges that form's real path; a script named with `..` is read by that form
  (`ScriptRef.open`), judged by its real path (`ScriptRef.real`), and asks when the target can't resolve it; inspect
  and `readScriptText` walk `..` through links, so never `path.normalize` a POSIX path before opening it; and every
  POSIX run (`launchArgv`: this computer, an SSH remote's agent, and WSL through `WSLENV`) gets `PWD` set to its
  folder, so the shell's own logical `cd ..` matches the classifier's. A shell's `cd` is lexical; `cd -P` leaves the
  folder unknown for the rest of the command (never a real path from the second pass: the first pass must probe every
  name the second judges, so no folder may depend on what the target reported; `env -C` likewise), and `set -P`,
  `set -o physical`, zsh's `-w` and `chase_*`, setting or removing `PWD`, and `env -i`/`exec -c` ask. Win32 and PowerShell remove `..` lexically, as `resolveTargetPath`
  does, so Windows keeps the lexical form.
- **Nothing on an argv that a user or a remote wrote**: commands travel in the environment, WSL's fixed scripts on
  stdin, ssh's destination after `--`. Nothing secret is written on a remote. No network listener anywhere: askpass
  and the remote's helpers use local IPC only (a 0600 Unix socket in a 0700 folder; a named pipe that admits only the
  user's SID).
- **Fail closed**: an unknown target, a malformed message from a remote or a distro, an unverifiable bundle, a policy
  that can't be read, or a command that can't be shown exactly as it will run is refused, saying why in plain words.
- **Nothing changes without them**: with commands off everywhere and only this computer, the prompts are today's
  exact texts (`persona-commands.test.ts`), the terminal words are unchanged unless WSL is on, and Linux, Windows and
  macOS behave as before.
- **Consent**: `CONSENT_VERSION` stays 1. The three cards (WSL, SSH per host, commands per target) carry their own
  versions in `FEATURE_CONSENT_VERSION` (`app/shared/consent.ts`): changing a card's text means bumping its version,
  which asks that card again and nothing else. A card's text is hashed with the OS's stop chord already in it, and a
  yes counts only with that hash.

### 14.4 Tests and CI

**Unit tests are OS-neutral.** They run on Linux here and in the Windows and macOS CI jobs, so spawn, the file
system, `/proc`, koffi, timers and the environment come in as fakes or parameters: never read `process.env` or
`process.platform`, never touch the real file system outside a temporary folder, never spawn `script`, `sh`, `ssh`,
`wsl.exe` or PowerShell, and give the path flavour (`os`) explicitly. vitest runs with `environment: "node"`, so test
renderer logic through exported pure modules (state reducers, option objects), never a DOM or xterm. Name the files
`test/unit/{sshwsl,commands,wsl,ssh,remote,targets,command,prompt,askpass,visible-text}*`: those are what the
`unit-matrix` job runs on every OS. The classifier's cases live in `test/fixtures/commands/{posix,powershell,cmd,wsl}.json`;
add one with every fix.

**Integration suites** that need a real `script`, sshd, WSL or desktop are in `test/integration/`, skip without their
variable, and fail when it is 1 and what they need is missing. `.github/workflows/remote.yml` runs them; `ci.yml` is
unchanged. remote.yml runs on pull requests and on pushes to `main` and the `ember-improve/20261022-sshwsl-*` branches
that change a file its suites load, run or read (its two `paths` lists, which must stay equal;
`test/unit/remote-workflow.test.ts` fails and names the file when one is left out, so add a pattern to both lists),
and on every `v*` tag, where paths don't apply. Its macOS job runs on each of those pushes (release tags included),
when dispatched and on Mondays, but not on pull requests: the repository is public, so its runners cost nothing. The
Linux arm64 job runs only on release tags, when dispatched and on Mondays, on `vars.EMBER_ARM64_RUNNER` (default
`ubuntu-24.04-arm`; set it to `none` where the repository has no such runner). **Actions › remote › Run workflow** (or
`gh workflow run remote.yml --ref <branch> -f only=ssh`) takes `ref` and `only` (`all`, `unit`, `commands`, `wsl`,
`ssh`, `macos`, `wayland`, `arm64`). A suite named in a job that doesn't exist yet is skipped (`run-integration.mjs
--allow-missing`). Each job's set-up belongs to the package named above it in the workflow.

| Job | Runner | Suites (`test/integration/…`) | Variables |
|---|---|---|---|
| `unit-matrix` | `ubuntu-24.04`, `windows-2022`, and `macos-15` when dispatched and on release tags | the SSH/WSL unit files | — |
| `commands-linux`, `commands-linux-el8` | `ubuntu-24.04`; a `rockylinux:8` container (util-linux 2.32), as a normal user | `commands-local`, `commands-flow-local` | `EMBER_COMMANDS_TEST` |
| `ssh-linux` | `ubuntu-24.04`, sshd on 127.0.0.1:2222, a jump host on 2223, and a third sshd on 2224 that takes only passwords (and keyboard-interactive), for a user with a password made for the run | `ssh-transport`, `remote-ssh`, `remote-e2e`, `remote-desktop` (under Xvfb) | `EMBER_SSH_TEST`, `EMBER_TEST_ALLOW_LOOPBACK_SSH`, `EMBER_SSH_TEST_SUDO` (the runner's sudo writes the remote's policy file), `EMBER_SSH_TEST_PASSWORD_PORT`, `EMBER_SSH_TEST_PASSWORD_USER`, `EMBER_SSH_TEST_PASSWORD`, `EMBER_REMOTE_DEV` (desktop) |
| `ssh-el8` | a `rockylinux:8` container as the remote | `remote-el8` | `EMBER_SSH_TEST` |
| `ssh-el8-client` | a `rockylinux:8` container as the client (OpenSSH 8.0, as on RHEL 8), as a normal user, against sshds in the container on 2222, 2223 (jump host) and 2224 (passwords only) | `ssh-transport` | `EMBER_SSH_TEST`, `EMBER_TEST_ALLOW_LOOPBACK_SSH`, `EMBER_SSH_TEST_PASSWORD_PORT`, `EMBER_SSH_TEST_PASSWORD_USER`, `EMBER_SSH_TEST_PASSWORD` |
| `wayland-remote` | `ubuntu-24.04`, headless mutter | `remote-wayland` | `EMBER_SSH_TEST`, `EMBER_TEST_ALLOW_LOOPBACK_SSH` |
| `wsl-windows` | `windows-2022`, Ubuntu 22.04 as WSL 1 with sshd | `wsl`, `commands-local` and `commands-flow-local` (PowerShell), `ssh-windows` (WSL 1's 4.4 kernel, which Ember refuses: "Linux 4.18") | `EMBER_WSL_TEST`, `EMBER_COMMANDS_TEST`, `EMBER_SSH_TEST`, `EMBER_TEST_ALLOW_LOOPBACK_SSH`, `EMBER_SSH_TEST_EXPECT_HELLO=0` |
| `wsl2-windows` | `windows-2025`, WSL 2 with a non-root default user; after its WSL tests, sshd in the distro on 127.0.0.1:2222 for `ember`, with the runner's new Windows key | `wsl`, then `ssh-windows` (Win32-OpenSSH to a real Linux kernel: the remote agent installs, serves and says hello) | `EMBER_WSL_TEST`; `EMBER_SSH_TEST`, `EMBER_TEST_ALLOW_LOOPBACK_SSH`, `EMBER_SSH_TEST_EXPECT_HELLO=1` |
| `wslg-probe` | `windows-2025` | `wslg-probe`: records what WSLg looks like as artefacts, never passes or fails | `EMBER_WSL_TEST` |
| `ssh-macos` | `macos-15`; every push, dispatch and Mondays | `commands-local`, `commands-flow-local`, `remote-ssh` (commands only) | `EMBER_COMMANDS_TEST`, `EMBER_SSH_TEST_MACOS` (set only once the runner's sshd starts), `EMBER_TEST_ALLOW_LOOPBACK_SSH` |
| `ssh-linux-arm64` | `vars.EMBER_ARM64_RUNNER` (default `ubuntu-24.04-arm`), sshd on 127.0.0.1:2222; release tags, dispatch and Mondays | `remote-ssh`, `remote-e2e`, `remote-desktop` (under Xvfb, koffi's arm64 build) | `EMBER_SSH_TEST`, `EMBER_TEST_ALLOW_LOOPBACK_SSH`, `EMBER_REMOTE_DEV` (desktop) |

`EMBER_SSH_TEST_EXPECT_HELLO` makes `ssh-windows` strict: `1` requires the hello, `0` requires the refusal of a kernel
older than 4.18. When it is set, missing remote parts (`node scripts/package/remote-parts.mjs`) or an unreadable kernel
version fail the test instead of skipping it.

Hosted runners can't show another user's desktop session, real logind sessions (desktop discovery is tested with
captured real `loginctl` and `busctl` output), macOS TCC, Windows remotes, NFS homes, real network loss, fapolicyd, or
WSLg if the probe finds none: PLAN.md §9 item 8 keeps them for real machines.

### 14.5 Running the suites yourself

Build first (`npm run build`). Never point a test at another computer: the SSH suites connect only to this one.

- **Commands** on Linux or macOS, as a normal user (as root every command asks); the Linux PTY path needs util-linux's
  `script`:

  ```bash
  EMBER_COMMANDS_TEST=1 node scripts/run-integration.mjs test/integration/commands-local.test.ts \
    test/integration/commands-flow-local.test.ts
  ```

- **SSH** on Linux: start an sshd of your own on 127.0.0.1:2222 (and a second on 2223 as the jump host) with your key
  authorised, add both host keys to `~/.ssh/known_hosts` and the `ember-master` and `ember-jumped` aliases to
  `~/.ssh/config`, exactly as the `ssh-linux` job's set-up step does, then:

  ```bash
  EMBER_SSH_TEST=1 EMBER_TEST_ALLOW_LOOPBACK_SSH=1 node scripts/run-integration.mjs \
    test/integration/ssh-transport.test.ts test/integration/remote-ssh.test.ts test/integration/remote-e2e.test.ts
  EMBER_SSH_TEST=1 EMBER_TEST_ALLOW_LOOPBACK_SSH=1 EMBER_REMOTE_DEV=1 \
    dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" \
    node scripts/run-integration.mjs test/integration/remote-desktop.test.ts
  ```

  They connect to your own account, so Ember's helper lands in your home folder; COMMANDS-WSL-SSH.md §4.7 says how to
  remove it. `EMBER_TEST_ALLOW_LOOPBACK_SSH` lets Ember connect to this same computer, and only an unpackaged Ember
  honours it; `EMBER_REMOTE_DEV` lets the agent run from `dist/remote` instead of a verified install, and an installed
  agent ignores it.
- **WSL** on Windows (Git Bash), with a distro that has a normal default user; the suite runs commands in it, which
  starts it if it is stopped:

  ```bash
  EMBER_WSL_TEST=1 EMBER_WSL_TEST_DISTRO=Ubuntu-22.04 node scripts/run-integration.mjs test/integration/wsl.test.ts
  ```

  The `EMBER_WSL_EXPECT_*` variables the CI jobs set are optional: each pins one more fact about their distros.

### 14.6 The policy, and Embers older than these keys

`admin.ts` holds the new keys (`features.wsl`, `features.ssh`, `commands`, `ssh`) and the pure functions every side
uses: `commandMode` (no policy: on; a policy without `commands`: off; a broken one: off), `adminSummary`, `combineAdmin`
(each value the stricter of the PC's and a remote's, property-tested never to loosen either), `hostAllowed`, and
`ADMIN_POLICY_PATHS` (the Linux and macOS files, which the remote agent reads). `LOCKDOWN` turns WSL, SSH and commands
off. The schema is strict, so **an Ember from before these keys locks down when it reads a policy that uses them**:
that is the intended fail-closed behaviour, and why CHANGELOG.md tells administrators to update Ember first. Any key
added later has the same effect on the Embers before it: say so in the release notes.

## 15. Publishing a release

The README sends users to the Releases page and tells them to check each file against `SHA256SUMS`, so every release
needs both. CI publishes them when a `v<v>` tag is pushed:

1. On `main`, set `version` in package.json to `<v>` and give CHANGELOG.md a `## <v> (<date>)` section: its text
   becomes the release's notes.
2. Tag that commit and push the tag: `git tag v<v> && git push origin v<v>`.
3. The tag runs every job of `ci.yml`, the Intel Mac's included, and each platform's job uploads its packages
   (`ember-packages`, `ember-windows`, `ember-macos`, `ember-macos-x64`). Once all of them pass, the **release** job,
   the only one with write access, downloads the four artifacts into one folder, and `scripts/package/release.mjs`
   checks that it holds exactly the eight files the README downloads: `ember-<v>-1.el8.x86_64.rpm`,
   `Ember-<v>-x86_64.AppImage`, `Ember-voice-models-<v>.zip`, `Ember-<v>-win-x64.zip`,
   `Ember-<v>-mac-arm64.dmg`, `Ember-<v>-mac-arm64.zip`, `Ember-<v>-mac-x64.dmg` and `Ember-<v>-mac-x64.zip`. It
   refuses a tag that isn't package.json's version, and takes the notes from CHANGELOG.md, with relative links made
   absolute at the tag and wrapped lines joined. The job then writes the checksums, one line per file (a hash, two
   spaces and the file name, which is what `sha256sum -c` reads):

   ```bash
   sha256sum ember-*.rpm Ember-*.AppImage Ember-*.zip Ember-*.dmg > SHA256SUMS
   ```

   and creates the release `Ember <v>` for the tag with the eight files and `SHA256SUMS`.

When a job fails, nothing is published: fix it on `main`, move the tag to the fixed commit (`git tag -f v<v>` and
`git push -f origin v<v>`) and the run starts again. To publish by hand instead, run **Actions › ci › Run workflow**
with **packages** and **intel** ticked (§13), download the four artifacts into one folder, write `SHA256SUMS` there
with the command above, and create the release with those files.

## Repository layout

```
app/main/           Electron main process (settings, logging, environment checks, windows, agent, perception)
  targets/          the targets runtime: which computers exist, naming and binding, consent cards, noticing ssh (§14)
  commands/         run_command's flow, the classifier, output shaping, the command window's controller; run/: runners
  wsl/              WSL discovery, the WSL runner, the WSLg router and matcher
  remote/           the PC's side of SSH: protocol, mux, link worker, connections, askpass, the remote target
  platform/         everything that differs by OS (§12): types.ts (the contract), index.ts (loadPlatform), compose.ts
                    (what the compositions share), which.ts, os.ts
    linux/          adapters over the X11 modules (x11.ts, xshape.ts, hands/*, the desk), behaving as before
    win32/          window system and input over user32, gdi32 and dwmapi (koffi); platform.ts composes Windows;
                    system/: apps (with a .lnk reader), registry, admin policy, login item, setup check rows
    darwin/         window system and input over CoreGraphics, AX and CoreFoundation (koffi), desktopCapturer capture;
                    platform.ts composes macOS; system/: apps (with a plist reader), policy, login item, permissions
app/remote/         ember-remote, the agent Ember runs on a computer reached over SSH (plain Node 24)
app/askpass/        SSH's askpass helper for Linux and macOS PCs
app/sidecar-host/   the Windows and macOS accessibility host (dist/app/ax-sidecar.cjs: Ember's binary in Node mode on
                    Windows, a utility process on macOS): protocol, ids, secrets, labels, roles, launch.ts;
                    providers/uia.ts (the bridge's client), providers/ax-darwin*.ts (macOS AX), providers/fake.ts (tests)
sidecar/atspi       Python accessibility helper (Linux, and inside WSL distros: reads app controls over AT-SPI)
sidecar/notice      the notice with Stop on a remote's screen while Ember uses it
sidecar/uia         UI Automation bridge (Windows): ember_uia.ps1 (the bootstrap), ember_uia.cs (C# 5), PROTOCOL.md
app/voice           wake word, VAD and speech recognition (runs in a utility process)
app/preload/        contextBridge APIs, one per window
app/renderer/       window pages (home, overlay, handle, ask, mic, desk, command, prompt)
app/shared/         IPC channel names and types; per-OS tables: shortcuts.ts, words.ts, never-look.ts, apps.ts;
                    targets, commands, consent versions, the prompt window's cards
packages/characters Ember's characters and the shared emotion rig
packages/bubble     reasoning bubble
packages/motion     follow spring and flight path
demo/character-lab  interactive character prototype
scripts/            build, RHEL 8 rebuild, binary checks, run-integration.mjs, packaging (scripts/package:
                    layout.mjs per target, stage, archive, fuses, exe-resources, mac-bundle, tcc)
packaging/          RPM spec, launcher, menu entry, example admin policy; windows/ember-doctor.cmd
test/unit           Vitest tests;  test/smoke  launch test
test/integration    real runtime, AT-SPI, the Windows and macOS desktops, and commands, WSL and SSH (§14.4)
test/fixtures       GTK3 test bench and hostile windows, the Windows bench (win_bench.ps1), the macOS bench
                    (mac_bench.js), plist samples, voice clips;  test/demo  recorded tours
eval/               task suite (eval/tasks), runner, checkers, release gates, report
```
