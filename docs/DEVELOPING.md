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
reads `loginctl` every 5 s. If logind cannot find a graphical session at startup, Ember retries discovery
5 s after each attempt finishes, then starts one monitor and reads the recovered session immediately. A terminal-only
session stays unlocked and is never monitored; discovery continues at that bounded cadence. Quitting cancels retries.

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
| `npm run test:voice` | Voice end to end in the Electron app (Linux): Ember's mic window hears WAV files through Chromium's fake microphone (`EMBER_TEST_MIC_WAV`, development builds only) and the scripted model answers; checks from the log the wake, the request, the spoken reply reaching the page, self-speaking and the follow-up window, three requests with spoken replies between them (`multi`, the last two without a wake word), "Hey Ember, stop" during a reply reaching the app-wide kill switch (`killswitch.pulled`, source `voice`), and Voice Match turning away another voice. Needs `npm run build`, `node scripts/voice/prepare.mjs` and `node scripts/voice/prepare.mjs --voice ryan --clips`; without a desktop: `xvfb-run -a npm run test:voice` (one scenario: `… test:voice -- stop`) |
| `node test/smoke/launch.mjs --folder '<name>'` | The smoke test from a copy of the app in a folder of that name; checks the settings page loaded there (CI uses one with %, #, &, brackets and non-ASCII) |
| `npm run build:lab` | Builds the character lab demo into `dist/ember-character-lab.html` |
| `npm run rebuild:el8` | Rebuilds native modules for RHEL 8 and checks every binary (§6) |
| `npm run check:symvers` | Only the binary check: node_modules and the native speech libraries, which it fetches first (a 28 MB download the first time, then reused from `.cache/voice/capi`; §6) |
| `scripts/install-desktop-entry.sh [--autostart]` | Adds "Ember (dev)" to the GNOME app menu, with its **Ask Ember** action as the RPM's entry has (and to login) |
| `scripts/demo/desktop.sh start` then `DISPLAY=:55 node test/demo/m1-tour.mjs out/` | Records a video tour on a throw-away desktop (needs Xvfb, openbox, xcompmgr, feh, mousepad, xdotool, ffmpeg) |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m3-tour.mjs out/` | Screen-reading tour. Runs as the desktop's user so the accessibility bus is reachable (`EMBER_DEMO_USER`, default `demo`) |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception.test.ts test/integration/worker.test.ts test/integration/desk.test.ts test/integration/safety.test.ts test/integration/action-link.test.ts` | Reads and operates GTK3 test windows through the sidecar: a worker on the test bench, on Ember's desk, and on hostile windows (prompt injection, a password prompt); and a click that runs a modal dialog, which the user can still type in (PR10-1). Needs a desktop session with pyatspi; on a bare X server, `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" …` as in CI |
| `EMBER_ATSPI_TEST=1 npm run test:integration -- test/integration/perception-electron.test.ts` | Reads Electron windows (Chromium's accessibility) through the sidecar and X11: window frames, scale 2, secret fields withheld and blacked out. Same needs as the line above (the test starts its windows with `ACCESSIBILITY_ENABLED=1`, as Chromium joins the accessibility bus only when asked); CI runs it with them on `rockylinux:8` |
| `npm run test:integration -- test/integration/borrow-live.test.ts test/integration/desk-robust.test.ts` | Borrowing the mouse and keyboard on a private Xvfb (other keyboard layouts need `setxkbmap`; skipped without Xvfb), and Ember's desk when things go wrong (its display dying, Ember killed). Need only Xvfb (and `xauth`, `dbus-daemon` for the desk), no desktop session |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m6-tour.mjs out/` | Guide tour: Ember points, the user clicks; then a question about the selected text |
| `node scripts/voice/prepare.mjs` | Downloads the standard verified speech models into `.cache/voice`, including the default Kitten Nano voice (63.8 MB), for the voice tests and tour. `--tts-voice` also fetches a separate test-only Piper Amy/Ryan voice (pinned by SHA-256), which the evaluation's missed-wakes gate needs; `--clips` synthesises new test clips into `.cache/voice/clips`, leaving the committed ones alone (with `--voice ryan`, in another speaker's voice into `.cache/voice/clips-ryan`, for the voice end-to-end test's Voice Match); `--update-fixtures` writes them over `test/fixtures/voice` instead. The voice is random on every run, so check new clips with the voice tests before committing them (`git restore test/fixtures/voice` puts the old ones back) |
| `node scripts/voice/match-bench.mjs <speakers> [--cache <file>]` | Voice Match that keeps learning (docs/ASSISTANT.md §7): false rejects and accepts before and after learning, in the enrolment's room and on another microphone, and the drift attack, on a folder of speakers' 16 kHz clips (LibriSpeech dev-clean through ffmpeg, as its header says). `--cache` keeps the voiceprints (numbers only) for trying other limits. Needs the speech models |
| `node scripts/voice/words-bench.mjs [--show]` | Personal vocabulary for recognition (docs/ASSISTANT.md §7): word error rate of the voice clips and of synthesised requests with app and people's names, raw, corrected against a lexicon, and with corrections taught from a first take. Needs `node scripts/voice/prepare.mjs --tts-voice --voice ryan` |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m5-tour.mjs out/` | Voice tour: a WAV file plays the microphone; the video gets the audio |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4b-tour.mjs out/` | Cursor-borrow tour: Ember borrows the mouse with permission, and lets go when the user moves it |
| `DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4-tour.mjs out/` | Task tour: Ember fills in a form in another window, asks once, refuses the password, turns on Do Not Disturb |

Each test run works in a temporary folder of its own (`ember-run-…`), which it removes at the end with vitest's module
cache (test/temp-folder.ts).

After building, CI also runs the Ask, conversation, first-run (home-first-run-renderer: Copilot, own provider, failures, models), memory, speech-consent, reminders/desk and natural-voice renderer journeys with
`EMBER_BROWSER_TEST=1 EMBER_CONVERSATION_TEST=1 EMBER_FIRST_RUN_TEST=1 EMBER_MEMORY_TEST=1 EMBER_MIC_RECIPIENT_TEST=1 EMBER_SPEECH_CONSENT_TEST=1 EMBER_UIUX_TEST=1 EMBER_VOICE_UI_TEST=1`
and `EMBER_CHROMIUM_PATH` pointing to Chrome or Chromium. The exact file list is in `.github/workflows/ci.yml`.
The same workflow enables `EMBER_APPROVAL_TEST=1 EMBER_TASK_CONTROLS_TEST=1` for native approval and task-card
journeys on X11. `EMBER_KITTEN_TEST=1` requires actual synthesis with the verified default Kitten model in native
speech integration tests. `node scripts/voice/prepare.mjs` includes it; the gate needs a supported native sherpa
runtime. It does not change the app's consent or speaking settings.

### Using Ember

- **First run** is six essential steps in the settings window, with optional character and personalisation detours (`app/renderer/home/welcome.ts`, its words
  in `welcome-copy.ts`): Ember says hello; you choose a character; you read what Ember does and doesn't do (five short
  lines, the full text under **Read the full text**) and **Agree and continue**, or **Not now**, which keeps Ember off
  and offers **Quit Ember**; you sign in to GitHub (the device flow; a build without Ember's GitHub App offers the GitHub CLI's page and **Check again**; with the organisation's own model service, or under its lockdown, there is nothing to sign in to and the step only goes on; or **Skip for now**); the setup check shows only
  the rows that need you, in plain words, with their fix button or the command to copy (main writes it to the clipboard: pages have no clipboard permission) (**Show the details** has every
  row); you try the stop shortcut, “Hey Ember” with a level meter that follows your request after the wake word (only while it is on, agreed to, allowed by the organisation, not muted and listening) and a first
  request in the ask box; and **Your Ember** sums it up before **Start Ember**. Nothing is read, heard or sent before
  **Agree and continue** (it saves the consent; the steps after it can't be reached without it). Back works on every
  step but the first. A run that agreed but didn't finish opens at sign-in next time. Everything chosen here stays in
  settings for later.
- Ember appears beside your cursor; its handle sits in the bottom-right corner, or the bottom-left one with
  **Handle position** in settings' **Your Ember**. Click the handle for **Ask Ember…**, **Stop everything**,
  **Mute / Unmute microphone** (with “Hey Ember” on), **Read the last answer** (once Ember has answered),
  **Settings…**, **Stay put / Follow my cursor**, **Hide / Show Ember**, **Move to the other side** (the handle and its
  task cards go to the other bottom corner) and **Quit Ember** (Quit asks first while a task is running).
- The shortcuts here are Linux's: Windows uses Win+Alt+… and macOS Control+Shift+Command+… with the same letters.
- **Ctrl+Alt+E** opens settings from anywhere. **Ctrl+Alt+Space** opens the ask box: it shows which window Ember
  will look at, and ↑/↓ bring back earlier questions.
- **The settings window** shows one pane at a time, picked in its sidebar as System Settings does: **Home**, **Projects**, **Models & connections**,
  **Voice**, **Your Ember** (character, size, start at login, and **Ember on screen**: **Handle position**, **Follow my
  cursor**, **Hide Ember until it needs me**, **Quit Ember**), **Memory** (with routines and reminders), **Apps &
  privacy**, **Comfort & access**, **Computers** and **Commands** (once available), **Extensions**, and **Setup &
  about**. **Search settings** at the top of the sidebar narrows it to the panes that hold the words typed; Enter goes
  to a selected labelled result (ArrowDown/Tab enters results; Escape clears them). The window reopens on the pane you last viewed (kept in the page's own storage).
  - **Home** is a status panel (Ember's still presence ring, its state in a few words, which of listening, memory and
    commands are on, today's tasks and approvals, **Ask Ember…** and **Stop everything** with the stop chord), then the
    **Conversation**, **Task activity** and the folded **What Ember did**.
  - **Task activity** shows each task of this session, newest first and the one that needs you on top: its state and
    clock, its steps in one line, its plan as a checklist, a row for each thing it did with the time after it started
    (steps of one kind folded, each listed when opened), its questions with how they were answered, and how it ended
    (the worker's summary and view). A finished task folds to its head. A task waiting for your answer says where it is
    asked and with which keys; Home never answers it. From five tasks, **All**, **Needs you**, **Working** and **Ended**
    filter the list. It is kept in memory only, for the tasks with a card and the 20 newest finished ones, and gone at
    quit; main sends it on `tasks:activity` and pushes changes on `tasks:activity-changed`, at most twice a second,
    only to the settings window.
  - Once Ember is set up, starting it on Linux, Windows or macOS (the app menu entry, `ember`, the Start menu, Ember.app
    from the Dock or Finder) only greets you, unless a setup row needs you (`startView`'s `setupNeeded`): then settings
    opens. Starting it again while it runs, the
    settings shortcut, the handle's **Settings…** and `ember --show-settings` open settings.
- Long answers have **Read all** (counted at the text size you picked): the **Conversation** on the settings window's **Home**
  keeps this session's questions, answers and task results (in memory only by default; quitting or signing out forgets them).
  - **Keep my recent conversation after Ember closes** (`keepConversation`, off by default; Home › Conversation): saves the
    latest 60 messages (at most 2 MiB) in `conversation.json` in the data folder (mode 0600, folder 0700; written
    atomically through a temp file, fsync and rename, last state wins), and shows them again after a restart once the
    signed-in account is known and is the one that saved them (a file of another account, or while the account can't be
    told, is never shown; another account's file is deleted). The saved lines are for the person to read: the model starts a
    fresh session at every launch and never sees them, a restored question is not one a later "yes" agrees to, and nothing
    is spoken, sent or run again. A file that can't be read (not JSON, another version, too large) is moved to
    `conversation.json.broken` and Ember starts empty. Turning the switch off, **New conversation**, **Sign out** and
    **Forget everything** (Memory) delete `conversation.json` (and `.broken`), and a write queued before any of them can't
    bring it back; Forget everything leaves the messages on screen but doesn't save them again (its question says so). The
    copy belongs to an owner written into the file and compared at every start: `github:<id>|<service>` (or `none|<service>`
    with no GitHub account), the service being `copilot` or `provider:<kind>|<hash of the address>|<keyId>`. `keyId` is a
    random id made whenever the person saves a key, sealed in `provider-key.bin` with the key (never derived from it); a
    key saved before ids existed, and the administrator's key, have none, so for them nothing is saved and an earlier copy is
    deleted (a known limitation). Any difference (another account, service, address or key) deletes the copy, never shows it.
    What a connection that began before such a change says (a late answer, a stopped stream, a task's result) is shown but
    never saved (`connGen`). A copy that can't be deleted is emptied if possible, never loaded again, retried first thing,
    and Sign out and Forget everything say so; a copy that can't be written is said under the switch (`historyProblem`).
    A clear sticks across a restart: before deleting, it writes `conversation.erased` (`{ version, gen }`; temp, fsync, atomic
    rename, mode 0600) and every saved file carries the generation `gen` it was saved under. A load honours the marker first:
    a file of a lower generation is never shown and is deleted again, and the marker goes only once nothing is left or a
    newer save (written under the marker's generation) replaced the file. If neither the deletion nor the marker can be done,
    the problem is "exposed" and says the copy may show again; history on with a provider key that has no id says "owner".
    The key id travels with the key: saving a key makes a new id (also for the same key), and that is a new owner. Known
    limitation: the owner is the account and service the copy was saved under, so GitHub → own provider → restart with the
    same key doesn't bring the earlier provider conversation back (the account is unverified on launch).
    Nothing is saved until the saved copy of that owner has been
    looked at, and lines said before then are added after the saved ones, so an earlier copy is never silently replaced. A
    saved line never carries a per-run id (`answerId`, `heardId`). The file's folder is flushed after the rename (best
    effort). The organisation's policy has no key for it. Code: app/main/agent/conversation-store.ts, host.ts (`restoreHistory`, `forgetHistory`). With a build ready,
    `EMBER_CONVERSATION_LIVE=1 npm run test:integration -- test/integration/conversation-history-live.test.ts` launches the
    real app three times on one data folder against a mock model (the switch found by its label, quit, relaunch, off).
- When a task closes its window with keys (Ctrl+W or Ctrl+Q, Command+W or Command+Q on macOS), the next read tells it
  the window closed, as a click on Close does. Closing a tab leaves a live window alone; denied or failed keys never
  claim a close. A task never carries on in an unrelated window in the closed window's place.
- **Memory** (Settings › Memory › **Remember what I tell you**, off until you turn it on and agree to its note):
  Ember remembers what you tell it about yourself and your work after it closes (docs/MEMORY.md).
  - Switching memory off stops remembering and recall during existing turns too. Pending recall is dropped on
    Stop or Forget; unchecked speech never counts as your own words when a fact is saved.
  - It keeps this in `memory.json` in its data folder (mode 0600).
  - While it is in force, the names in what you told it (its `user` facts) also help Ember hear them right
    (app/main/personal/correct.ts); nothing more is kept for that.
  - With each request, the few facts that bear on it go to Copilot as an untrusted `<memory>` block.
  - A fact counts as yours only when it is mostly your own words. Otherwise it is the model's inference, and context
    only.
  - It never keeps passwords, codes, keys or card numbers.
  - **Forget** removes one fact and **Forget everything** removes them all; saying "forget that" works too, and
    signing out forgets it all. The list says where each fact came from (you, our conversation, a task).
  - Turning it on or off reconnects Copilot before the next request, between turns, with the conversation resumed.
  - **It learns on its own** (docs/MEMORY.md steps 3–5; its note says so, `FEATURE_CONSENT_VERSION.memory` 2, so
    someone who agreed to the first note is asked again and memory stays off until they do). After conversation
    turns and finished tasks, a short session of its own on the conversation's model, hardened and with no tools,
    picks out lasting facts as JSON (zod-checked, dropped whole if invalid): at most one call per three turns or a
    minute, 12 an hour, 60 a day. A fact is yours only when you were heard to say it and every word of it is yours,
    the same way round; a task's are `task`; nothing that reads like an instruction is ever learned (the remember
    tool keeps one only in your own words). Learned facts are recalled by meaning too, once Better recall's model is
    in. After 5 idle minutes (no turn, no task,
    the screen unlocked) it tidies (consolidate, then one model pass, at most 6 a day). At most once a day while
    idle it asks about a name it keeps finding nothing on (**Ask me questions now and then**, on by default). A new
    fact shows in the conversation as "Ember learned: …" with **Undo**. The kill switch stops all of it (`memory`).
  - **Tell Ember about you** (Settings › Memory, and first run's optional personalisation detour): what to call you, your role
    and work, the apps you use most, short or detailed and spoken or not, your timezone or hours, each optional, kept
    as things you told it. "Ember, get to know me" asks the same aloud; an answer heard where Ember can't tell you
    from its speakers isn't kept.
  - **Better recall** (under the list, while memory is on): **Download (23 MB)** fetches a small language model
    (all-MiniLM-L6-v2, int8, pinned by SHA-256 in `app/voice/models.ts`) that runs on this computer, so Ember finds a
    fact when you ask in other words ("Who is my manager?" finds "Priya leads the platform team"). It comes from
    `huggingface.co`, which redirects to its CDN, `*.hf.co` (`us.aws.cdn.hf.co`): a firewall must allow both. The
    click is the agreement, as for the speech models; nothing is fetched while memory is off, and turning memory off
    cancels a download under way. Each fact is turned into numbers in the background in the "Ember memory" process
    (onnxruntime-web's WebAssembly, one thread), which holds 300–400 MB while it runs and ends after 5 idle minutes;
    opening Ask or saying "Hey Ember" starts it early. The numbers stay in `memory-vectors.json` beside `memory.json`
    (0600), go with a fact you forget, and **Forget everything**, signing out and **Remove** delete them. At most one
    fact found by meaning alone goes with a request. Without the model, or when it is slow (1.5 s) or fails, recall
    works as before. `node scripts/memory/bench.mjs` measures it (docs/MEMORY.md §2).
- **Extensions** (Settings › **Extensions**): plugins and extensions from marketplaces the user adds, and connectors
  (GitHub-hosted services such as Slack or Notion). Only the user adds, turns off, removes, connects or disconnects,
  and only here.
  - **Added** lists each item with its status in words beside a dot, a switch to turn it off, its tools (each badged
    **Read-only**, **Can change things** or **Changed**), and **Remove** (a connector: **Disconnect**). A tool whose
    name, description, schema or annotations changed since the user agreed shows **Changed since you agreed** with
    **Agree again**; Ember stops using the changed tools until then.
  - **Marketplaces** takes a GitHub repository (`owner/repo`, or its `https://github.com/…` address) or any `https://`
    address (no `http`, user names or passwords); **Browse** shows its entries as cards (name, kind, description,
    publisher, source, version, and **Added** once added).
  - **Connectors** lists GitHub's catalog. **Connect** opens GitHub's consent page in the system browser (main opens
    only `https://github.com` and its subdomains), shows **Waiting for you to finish in your browser** with **Check
    again**, then **Connected**; one whose sign-in lapsed says **Needs you to sign in again**.
  - Every add and connect first shows a consent card in place: only you add, read-only tools run once you agree,
    Ember asks before any tool that changes or sends anything, results are information and never instructions, and
    where the item reaches (the marketplace's source, or GitHub's Copilot service for a connector).
    The first yes also records extensions' own consent (`settings.extensions`, `FEATURE_CONSENT_VERSION.extensions`;
    `consentCard`'s words are pinned to that version in extensions-runtime.test.ts) and turns extensions on; nothing
    loads before it. Connectors' catalog is empty for now (see "Extensions: the runtime and the gate").
  - With `features.extensions` false, or while Ember is locked down, the section says so and lists what was added,
    with nothing to change. A build without the extensions runtime says extensions aren't available yet.
  - Main's side is `app/main/extensions-ipc.ts` (`EXTENSIONS_IPC`: the settings window only, every argument checked,
    errors in one plain sentence); the words are `app/renderer/home/extensions-copy.ts`.
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
  terminal, and Ember's password and consent cards. **Glass** (Clear, Regular, Solid; `settings.glass`, put on the floating pages as
  `html[data-glass]`) sets how much of the screen shows through the bubble, task cards, handle and ask box: Clear is an even,
  lighter tint, and Calm mode, Reduce Transparency and Increase Contrast make it solid.
  **More time to read and answer** keeps every bubble ten times as long
  (Ember's own notices, and a bubble that waited behind another or was covered for a while, included), a question waits
  20 minutes instead of 2 before it counts as **Not now**, and an offer to bring Ember to a computer 250 seconds instead
  of 25.
- Without a compositor (xrdp, VNC), transparent windows can't work, so Ember lives in an opaque
  card in the corner instead; it grows to show a whole question (up to 360 px, or 640 px within the work area for a
  question with a long typed text, whose sentence keeps its lines while the text's box gives way first).

### Asking Ember to do things

Ask for something in an app ("turn on Night Light", "put my name in this form and save") and Ember starts a task in the
background, with a card just above Ember's handle (in its corner). The card is where the task lives:
- under its title, it says how the task works now ("In the background", "On my desk", or "Using your mouse and
  keyboard");
- it lists the task's plan as the task goes;
- when the task ends, it shows what it found or made: a list, a few facts, a small table or a saved file, kept for a
  minute.

The bubble beside your cursor stays for your conversation, for guides, and for a task while it uses your mouse; a
task in the background doesn't speak there, but its questions still do. It works through the app's accessibility interface, so
your mouse and keyboard stay yours. Before its first action in an app it asks **Allow / Always in this app / Not now**;
answer with a click, or with **Ctrl+Alt+Y** (allow) and **Ctrl+Alt+N** (not now), so you never need the mouse (the
question shows the keys). **Always** is a click only: a global key could take an app's own shortcut and grant for good
by accident. A hidden Ember shows itself to ask, and with **Speak replies, questions and results out loud** set to
**Always** (the default), or a screen reader running and it set to **When a screen reader runs**, it says the question
out loud; **Never** keeps it quiet even for a screen reader. Buttons that send, delete, pay and the like, risky
shortcuts (Delete, Ctrl+Enter, Alt+F4…) and Enter on such a button are always confirmed, and “Always” is never offered
for them. Each task card has **Stop**, says what Ember is doing now in its own words ("Clicking in Text Editor…",
"Waiting for you" while it asks), how long it has worked and which step of its plan it is on, and shows what it did
under **Details**; a failed card goes on its own after about a minute when not being read (Home's Conversation keeps
what went wrong). More time multiplies the lifetime by ten; expanded Details, hover or keyboard focus pauses expiry,
with at least five seconds to move on after the last reader leaves. Its **Try again** starts the latest accepted request again, retaining any changed instructions,
restrictions and the original computer and window, and asking every question again. A change the worker could not accept
does not replace that retry request. Conversation requests are dispatched in order even when memory recall finishes out
of order; each turn keeps its own words, screen context and voice provenance. An unmatched runtime message cannot start
or steer a task. If an app can't be operated through accessibility, Ember asks to **borrow
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

**Work without asking** (Apps & privacy, off by default; owner decision of 2026-11-02, PLAN.md §2 "Approvals"). Turning
it on shows its card first: what runs without asking, what still asks, that Ember says what it does, and that a stop
always works (`FEATURE_CONSENT_VERSION.autonomy`). While it is on, Ember doesn't ask before its first step in an app,
before borrowing your mouse and keyboard (it still waits until you're still and lets go when you move), before
moving text between apps (it says which apps and how many characters, never the text), before pressing OK on a
message box whose only button is that OK, with nothing to choose, tick or type, and nothing in it Ember couldn't see ("Answering a message box in Notepad…";
any dialog with a Cancel, a check box or another control, or a title bar's Close (except in a real Windows dialog box) still asks, and so does one that asks a question, says what has happened or will happen, is longer than 120 characters, is cut
short, is a web page's, a browser's, an installer's or a permission prompt, or names something risky), or before
typing line breaks into a plain text editor's main document with the borrowed keyboard (Notepad, gedit, Mousepad, Kate,
TextEdit and the like, when it is the window's main document; their consoles, any other app, a spreadsheet's cell, a web page and a tab still ask). Controls in a separate top-level window a dialog owns can't be detected (no reader lists them under the dialog). While
Ember runs as an administrator or as root every command asks, and the hint under the switch says so; an ordinary command on this
computer that asks only because it carries text read elsewhere runs after its Stop countdown (WSL and SSH commands ask
as before). Steps in the system's Settings and security apps always ask. It says each such step in its bubble and on
the task's card by its kind, app and size ("Clicking in Text Editor, without asking as you let me."), never with
typed text or words from the screen, and **What Ember did** lists it as "Without asking" (the audit entry has
`autonomy: true`), and lists turning the mode on or off with how (Home, voice, typed). Risky steps ask every time as before, with no "Always", and so do dangerous
commands; a task that text on screen tried to steer, that went off-task or where you said no (at any point in it) goes
back to asking.
Say “Ember, work without asking” (Voice Match must recognise you, and the card must already be agreed to: otherwise
Ember opens the switch or its card here) or “Ember, ask me first again” (anyone) to switch it by voice.

**Answering by voice.** While a question is up, “Ember, allow” (or “yes”, “go ahead”) answers it, and “Ember, not now”
(or “no”, “don't”) declines it. A yes counts only when **Answer questions with my voice (Voice Match)** is on and recognises you
in what you say after “Hey Ember”, from at least half a second of your voice (“Ember, go ahead” is enough). A shorter
yes (“Ember, allow”) counts too for a question asked by a task you asked for in a voice Voice Match recognised, within
10 minutes of asking, unless that short yes is too quiet or clipped to tell (it is then too short, never trusted) or sounds clearly unlike
you, Voice Match has turned another voice away since, you forgot or taught your voice again,
or the task was changed by a request it didn't recognise (typed, say); never for a command card, a consent card or
another task's question (owner decision of 2026-11-03; the audit says `trust: "task-voice"`). A yes asked as a
question (“Proceed?”) or a bare “okay” isn't one. Otherwise the bubble says how, and the question stays. Measured on
LibriSpeech dev-clean (33 speakers): half a second of another voice passes 0.5 % of the time. With the task trust,
someone else saying “Hey Ember, allow” is taken about 2.5 % of the time, and someone who plays your recorded “Hey
Ember” then says “allow” 35–40 %, once: any voice turned away ends the trust; a yes too
quiet or clipped to score is refused (PLAN.md §2 “Approvals”). It counts only for the question that was up, and armed, when you started speaking, and
once Voice Match turned another voice away during a question, that question takes a click or the keys only. “Not now” works for anyone, also in a follow-up window (“Cancel” and “never mind” aren't answers). Ember never takes its
own voice as an answer (nothing it hears while it speaks, or that started before it last spoke, counts), never says
“Always” by voice, and never takes a spoken yes for a consent card. A command card or a long typed text is allowed by
voice only as the approve key would: once all of it has been shown. The audit records `via: "voice"` and whether Voice
Match verified it.

The first time it starts, Ember explains what it reads, what it sends and what it keeps, and does nothing until you
agree.

### Extensions: the runtime and the gate

The runtime is `app/main/extensions/` (ExtensionsService, the `ExtensionsApi` Home calls); the contract is
`app/shared/extensions.ts`. A spike on the bundled runtime (Copilot SDK 1.0.21, empty mode, the mock model) decided what
it builds on:

- **Only MCP servers load.** Ember reads a plugin's manifest (`plugin.json`, `.github/plugin/plugin.json`,
  `.claude-plugin/plugin.json`) and its MCP servers (`mcpServers`, `mcp.json`, `.mcp.json`), copies the plugin into
  `extensions/plugins/<id>/`, and passes each server to the conductor's session as an explicit `mcpServers` entry. Its
  hooks, agents, skills, rules and `extension.mjs` files are never loaded: passed as `pluginDirectories`, a plugin's
  command hooks ran inside Ember's hardened session, outside every tool gate.
- **Admitted one by one.** `hardenedSessionConfig({ extensions })` lists exactly `mcp:<server>-<tool>` for each agreed
  tool in `availableTools` (never `builtin:`), filters each server's `tools`, and drops any name Ember grants itself:
  an MCP tool silently replaces an Ember tool of the same name. `verifySessionTools` accepts an extension tool only as
  that MCP tool and checks its description and schema against the pin. With no extension tool the session is today's
  exactly.
- **Checked at every call, not only at load.** A server can change a tool mid-session (`notifications/tools/list_changed`),
  so `verifySessionTools` binds the gate to the session's live tool list, and every call compares what the model is
  shown now with the pin; a tool that differs is denied and marked changed for good (off until the user agrees again).
  A session never bound, or whose list can't be read, denies every extension call.
- **Ember's gate decides every call** (`gate.ts`, from `onPreToolUse`): off (the admin's `features.extensions`,
  LOCKDOWN, the user's switch or consent `FEATURE_CONSENT_VERSION.extensions`), stopped, disabled, changed, shown
  differently, or refused this turn: deny. A read-only tool in an agreed item, with no injected text seen: allow.
  Read-only means `readOnlyHint` true with neither `destructiveHint` nor `openWorldHint` true, on a stdio server whose
  tool list hasn't changed this session: every call to a remote (HTTP) server's tools asks, since it sends its
  arguments there. Anything else: the Confirmer asks every time ("Use “post_message” from Slack? With "{…}"."), with
  Allow and Not now, never Always. A yes counts only if the gate still allows the call when it comes. Every decision,
  answer and result is an `extension` audit entry, with sizes only.
- **Hints changed mid-session.** The runtime's tool list has no hints, so a change of hints alone (`readOnlyHint` to
  `destructiveHint`) can't be compared with the pin during a session. When a server sends `tools/list_changed`
  (`mcp.tools.list_changed`), every tool of that server asks for the rest of the session; the next start's check
  (`refresh()`) re-pins nothing and turns the changed tool off.
- **Failures are untrusted too.** The SDK can't rewrite a failed call's text, so `onPostToolUseFailure` adds Ember's
  note that it is untrusted data, audits its size, and taints the conversation (any extension failure).
- **Taint lasts the conversation**, across reconnects; it ends when the conversation is forgotten.
- **Results are untrusted.** `onPostToolUse` replaces each result with `<extension_result untrusted="true">` text (`<`
  escaped, capped at 60 000 characters, images dropped); `injection.ts` scans it, and a flagged result makes every
  later call ask. Output over about 2.5 MB the runtime saves to a file in its temporary folder and passes as a pointer
  ("Saved to: …copilot-tool-output-….txt") and a preview: Ember can't scan the rest, so it treats such a result as
  flagged and audits it as `truncated`. The runtime's temporary folder is `copilot-tmp/` in Ember's data folder
  (`TMPDIR`, `TMP` and `TEMP`, 0700, emptied at each connect and at sign-out), never the shared /tmp, where those files
  would be readable by every user.
- **Pins.** At install and at each start (and when an item is turned on) Ember lists each server's tools itself
  (`probe.ts`, in its own process group, ended whole) and compares SHA-256 pins of name, description, schema and hints
  (`pin.ts`); a changed tool is off until the user agrees again in Home. Known gap: **Agree again** (and install)
  pins the tools the server serves at that moment without showing them to the user first; the card naming the served
  tools, with a hash carried back on the yes, is a follow-up.
- **Servers' environment.** The runtime would start a stdio server with its whole environment (the spike saw
  `GH_TOKEN` and cloud keys reach it), so it starts Ember's launcher (`dist/app/mcp-launch.cjs`, plain Node), which
  starts the server with `appEnv()`'s allowlist and the plugin's own values only, no shell, and records its process id
  in `extensions/run/` (Linux and macOS: as the leader of its own process group, so the kill switch ends everything
  it started; Windows: `taskkill /T`). A server that needs a `${VAR}` from the user's environment is refused, and
  proxy addresses reach it without their user name and password. This (and the blanked credential variables: see "Where the sign-in goes") keeps Ember's sign-in out of the server's
  own environment; it is not a sandbox. A stdio server runs as the user and can read what the user can, including the
  environment of the Copilot runtime that started it (`/proc/<pid>/environ` on Linux), which holds the GitHub token
  (the SDK passes it as `COPILOT_SDK_AUTH_TOKEN`). Install only extensions you would run yourself. `node` is Ember's own
  Node. macOS has no plain-Node mode, so stdio servers don't run there yet; remote servers must use HTTPS.
- **Hot reload.** Installing, removing, turning an item on or off, agreeing again and the kill switch move
  `generation`; the host reconnects between turns (the conversation resumed), as memory does.
- **The kill switch** part `extensions` refuses every call from sessions loaded before it, drops their questions and
  ends every server the launcher recorded.
- **Off for now:** connectors (`connectors()` is empty, `connect()` says they aren't available: they need GitHub's
  service, which the spike couldn't reach without a real sign-in), `extension.mjs` extensions (bare tool names that
  aren't filtered by `availableTools` and could shadow Ember's), the SDK's catalog, legacy SSE servers, servers that
  need a sign-in (shown as needing one), and workers (only the conversation gets extension tools).
- Marketplaces are registered with the runtime (`server.plugins.marketplaces`), which fetches them; a plugin kept in a
  GitHub repository of its own is fetched by the runtime's install, copied, and uninstalled from the runtime again.
  Only a GitHub repository (`owner/repo`) or an `https://` address can be added (`EMBER_EXTENSIONS_LOCAL=1`: a local
  folder in development).
- Tests: `test/unit/extensions-runtime.test.ts`; `test/integration/extensions.test.ts` (the real runtime, the mock model
  and the launcher).

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

If neural speech fails, already generated audio finishes before an explicitly local system voice says only the
ungenerated remainder. Further replies use the system voice until Ember restarts, so speech engines never compete
while recovery is queued. Stop or a replacement reply cancels queued recovery too. If no local voice matches the
system language, Ember waits up to three seconds for the voice list to load, then shows a speech warning in Settings;
the reply remains readable in the bubble. It never submits speech to an unspecified default or online voice.


In settings, turn on **Listen for “Hey Ember”**, read and accept the microphone note, and download
the standard speech models (about 138.5 MB of downloads, once; agreeing to the microphone note starts the download).
Then say “Ember, …” (or “Hey Ember, …”) with your request. You can say it in one breath, or pause after the name.
Ember answers out loud in the default Kitten voice when its native runtime and model are ready, or a local system
voice otherwise, sentence by sentence as the answer
arrives. To answer Ember's questions out loud, turn on **Answer questions with my voice (Voice Match)** under it and say
the four phrases it shows. It decides only what a voice may approve: every voice is heard, and a request it doesn't
match simply can't approve anything (owner decision of 2026-11-05: on a laptop's microphone the owner's own requests
scored 0.50–0.74 against the 0.75 bar, in the range of other people's). **Forget my voice** deletes your voiceprint. With **Keep learning my voice** (on by default once Voice Match knows you), the
voiceprint follows your voice slowly, from requests it is sure are yours: never from Ember's own voice, a request with
two voices in it, an answer to a question, or for two minutes after it turned another voice away or you stopped
Ember; at most one request a minute (with 2 s of voice or more), a small step at a time, and never far from what you
taught it. A spoken “allow” must still match what you taught at the original threshold. **Reset to my enrolment** goes
back to that (shown while Voice Match is on). `voiceprint.json` (mode 0600) then also holds the enrolment's print and
the prints of up to 24 of your requests: numbers, never audio. It is version 2: an older Ember reads it as no
voiceprint at all (Voice Match off until you teach it again), so going back to an older Ember means teaching it again.
**Forget my voice** deletes it and `words.json`. Ember corrects names it mishears against your installed apps and, with Memory on, the names you
asked it to remember; when it still gets one wrong, **That's not what I said** under the request in Conversation
lets you type what you said, and with **Learn my words** on it hears it right from then on (`words.json`, mode 0600,
listed under **Words Ember learnt** with Forget; never a swap of common words or of a verb such as open for close). A
correction never makes a request risky: one about sending, deleting or paying, or one that addresses someone (message,
call, tell, invite…), keeps every name as heard, and a person's name from Memory is only used in a request that looks
something up (find, who, what, where…). **Suggest what I might say next** shows two or three likely next requests under
Ember's answers and in Ask Ember, made on this computer; choosing one asks Ember as typing it would, but never counts
as your own words for a command (a dangerous one always asks), and nothing risky is suggested unless built from what
you just asked. Both are in “Before Ember starts” (`CONSENT_VERSION` 2). After a “Hey Ember” request the microphone stays open as a conversation
(**Keep listening after I call Ember**, on by default): what you say next needs no name, also while Ember speaks and works,
until “That's all” or 30 seconds after everything has gone quiet (`CONVERSATION_IDLE_MS`, app/voice/engine.ts). Speech over
Ember drops its voice at once (`duck`, 0.15 of its level: without it the echo canceller left almost nothing of the user's
words), and stops it when what the recognizer made of it isn't Ember's own words (`spokenByEmber`) or a “yeah”
(`BACKCHANNEL`). What is said then replaces the reply on its way (`AgentHost.ask` `replaces`); tasks go on. It never
approves anything (`overEmber`). With other sound playing, only what is said by name counts: Windows reads the output's
level while a conversation is open (app/renderer/mic/output-watch.ts: Chromium gives system audio only with a screen's
video, which is stopped at once), Linux uses the speakers' stream, macOS can't tell yet. With the switch off, after Ember
answers you have 8 seconds (12 when it asked you something) for
a follow-up without the wake word (up to three in a row; “Hey Ember” works then too); “Thanks”, “OK” or “that's all” ends that window (when Ember asked something,
“OK” is the answer). While Ember is talking, “Hey Ember” stops it and listens; on Windows, macOS and Linux without
`parec`, where Ember can't hear its own speakers, “Ember” alone doesn't (Ember's own words have it), and what you said before it went quiet isn't
sent: say the request once it has stopped. “Ember?” on its own, “status?” or “what are you doing?” is answered at once from Ember's own
record of its tasks (the step each one is on, one waiting for your answer or stopping, how many wait, how the last one
went), with no Copilot request, so it works offline too. A spoken request's short acknowledgement (“On it.”) comes only
once the request has gone to Copilot, after anything Ember is already saying. “Ember, just show me” (or “stop telling me”) keeps finished tasks' results on screen without
reading them out, and “read them out again” undoes it (the same switch as **Read finished tasks out loud** under
**Voice**); while Ember isn't speaking replies at all, it says results stay on screen instead of promising to read them. “What did I miss?” or “catch me up” names the tasks that finished in the last two hours and
how each went, from the same record. “Ember, systems check” (or “are you working?”) says whether Copilot is connected,
whether Ember is listening and speaking, and what is under way, also when Copilot can't be reached. “Remind me in 20 minutes to call Priya” or “at 3 pm, remind me to stand up” sets a
reminder: when it is due, Ember shows it in its bubble, says it when replies are spoken (after what it is saying), and
sends a notification if you are away (only “A reminder is due.” while the screen is locked). Only your own words set
or cancel one. Reminders last while Ember runs, unless you turn on **Keep my routines
and reminders** under **Conversation** (and agree to its note): then they are kept in `routines.json` (mode 0600) and a
reminder that fell due while Ember was closed is told at the next start, also before Copilot connects. With it on you
can also name a routine (“when I say start my day, open Mail and show today's calendar”); saying its name runs the steps
as if you had just asked each one, and Ember still asks before anything risky, with the usual question; a command a
step names (“delete the build folder”) always asks too, since the step isn't what you said just now. Only your own
words make, run or delete a routine: making one needs its name and each of its steps in what you said, running one
needs your request to be its name (alone, or “run my start my day routine”), and deleting one “delete my start my day
routine”; a reminder is cancelled only by a direct request now, such as “cancel the reminder to call Priya”,
not a question about cancelling or a saved routine step. A named reminder must match; “cancel the reminder” works
only when one is waiting, and “cancel all my reminders” must name all without exceptions. Text written as instructions to an AI
(“ignore your previous instructions”) in a window, in any open window's title, or in what Ember read on the screen
before a task makes that task ask before every step. Home lists them with
**Delete**, and signing out deletes them all, also while your organisation has routines turned off.
“Ember, stop” (or “Hey Ember, stop”, also while Ember is speaking) stops everything; while
Ember is speaking, “Hey Ember” alone makes it stop talking and listen. With `parec` on Linux Ember tells its own voice
apart; on Windows, macOS and Linux without `parec` it interrupts too, but “Ember” alone doesn't there, and nothing said
before Ember has gone quiet is sent. A short request said all over its voice isn't sent, so say it again once Ember
is quiet. **Ctrl+Alt+M** turns the
microphone off and on. Listening happens on this computer: no
audio leaves it, and only the text of your request is sent to Copilot. Ember ignores “Hey Ember” and
“Ember, stop” when they come out of your speakers (needs `parec`, in `pulseaudio-utils`); it follows the default sound
output when you change it (`pactl`, from the same package), and keeps that output from idle-suspending while it
listens. A request ends
when your voice stops, even with a TV or colleagues talking behind you, and is at most 10 s long (20 s in a
quiet room); when a longer one is cut, Ember says it only caught the first part.

### How speech runs (native synthesis, native or WebAssembly listening)

Listening (the wake word, the two voice detectors and Moonshine) and neural synthesis use sherpa-onnx 1.13.8,
each in a utility process (`app/voice/process.ts`, `app/voice/tts-process.ts`), through `app/voice/runtime.ts`.
Kitten Nano 0.8 FP32 is the default production voice, `DEFAULT_VOICE` with model id `tts`; Piper is no longer a
production model or fallback. Listening still works through WebAssembly when the native runtime is unavailable.
Neural synthesis needs the native runtime; otherwise replies use an installed local system voice.

| | Linux | Windows, macOS |
|---|---|---|
| Native build | sherpa-onnx's prebuilt C API (`libsherpa-onnx-c-api.so` and `libonnxruntime.so`, in `resources/voice-native`) through koffi (`app/voice/capi.ts`) | The native addon (`sherpa-onnx-win-<arch>`, `sherpa-onnx-darwin-<arch>`: the binaries `sherpa-onnx-node` loads) |
| Listening fallback | WebAssembly (`sherpa-onnx`: one thread, no GPU) | WebAssembly if the addon cannot load |
| Threads | As on Windows and macOS (WebAssembly listening: 1) | Moonshine 2, Kitten 1, Kokoro up to 4 leaving a core free; the per-frame models 1 |
| GPU | None required | macOS may probe CoreML for optional Kokoro and keep it only when faster than CPU; Kitten and Moonshine use CPU. Windows has no supported DirectML backend in the pinned addon. |
| Spoken replies | Default Kitten, explicitly selected optional Kokoro, or the installed local system voice | The same choices |

**Which build on Linux.** At start, main asks `capiChoice()` (app/voice/runtime.ts) and logs its answer as
`voice.backend` (`backend`, `why`); `ember doctor` shows it under **Speech**. The native libraries must be present
in `resources/voice-native` (an RPM's `/opt/ember/resources/voice-native`, or inside the AppImage), and the processor
must have `CAPI_CPU_NEEDS` (app/voice/capi.ts, checked through `/proc/cpuinfo`, with an unreadable result treated as
unavailable). The pinned libraries need no features beyond x86-64: their AVX, AVX2 and AVX-512 implementations are
selected by ONNX Runtime's CPU probes. A development build uses this C API only with `EMBER_SHERPA_CAPI`.

Ember depends on the platform packages directly (`optionalDependencies`, so npm installs only this computer's own).
`sherpa-onnx-node` would also install `sherpa-onnx-linux-x64`, which needs glibc 2.32 and would fail
`npm run check:symvers`. No Linux package carries that addon (`scripts/package/layout.mjs`); Linux carries the C API
libraries, which need only GLIBC_2.17, GLIBCXX_3.4.19 and CXXABI_1.3.7. `voice.ready` and `voice.tts_ready` record the
backend, provider, threads and attempted provider timings; neural readiness includes its measured real-time factor.

**Fallbacks.** A listening process that cannot load natively, or dies before readiness, is retried on WebAssembly
(`voice.native_failed`). That path retains ASR coverage. Kitten and Kokoro have no neural WebAssembly fallback:
unsupported, slow, missing or failed default Kitten uses the installed local system voice. Only local system voices
are allowed, so this fallback does not send speech elsewhere. `EMBER_VOICE_BACKEND=wasm` forces the listening
fallback and leaves neural replies to that system voice; `EMBER_VOICE_PROVIDER=cpu` turns CoreML off. These switches
load no external code and are honoured by an installed Ember.

After `npm run build` and `node scripts/voice/prepare.mjs`, `npx electron test/smoke/voice-backends.mjs` checks the
supported native and WebAssembly paths and reports backend, load time and latency. CI keeps WebAssembly listening
tests and separately requires real native synthesis with the default Kitten model. `EMBER_SHERPA_ADDON=<a
sherpa-onnx.node>` can exercise a native addon on a development host; `EMBER_SHERPA_CAPI=<folder>` uses the verified
C API directory printed by `scripts/voice/fetch-capi.mjs`. Package checks still require installed RPM/AppImage native
speech capability where that runtime is supported.

**Default and optional voices.** Kitten Nano 0.8 FP32 downloads 63.8 MB as part of the standard model manifest. Its
complete Apache-2.0 archive includes the matching style tables and phonemiser data. It uses one CPU thread and the
measured `NATURAL_MAX_RTF` <= 0.5 gate; a slow verdict is kept for a week per model/provider/thread configuration.
Corrupt, future and expired verdicts are ignored. A failed gate uses the local system voice.

Kokoro v1.0 FP32 (`af_heart`, Apache-2.0, about 350 MB) remains an explicit optional download in Voice settings. Saving
a choice while off does not enable speech or start that download. Enabling or changing the optional model names the
download size and waits for confirmation. Kokoro uses the same real-time gate and falls back to Kitten when unavailable
or too slow; if Kitten cannot run either, the system voice speaks. Saved preferences remain inspectable. Policy,
consent and speaking controls still apply, and a late or obsolete download cannot restart a cancelled choice.

The standard `VOICE_MODELS` manifest and bundled-model staging include Kitten; optional Kokoro is not packaged.
Pinned Piper Amy/Ryan voices may still generate ASR/evaluation test fixtures, but are not production voices or shipped
speech models. Keep the bundled sherpa, eSpeak NG and phonemiser licence notices: removing Piper as a model does not
remove those transitive library obligations. The neural synthesis utility releases after two minutes without pending
generation and rewarms on the next wake; queued playback retains its own ownership. Captured audio remains in memory
and on the device.

`node scripts/voice/bench.mjs --kokoro <models-directory>` compares default Kitten with explicitly requested Kokoro in
fresh processes, including loaded/peak process RSS, CPU work, first-chunk latency and real-time factor. The optional
flag may fetch Kokoro's pinned archive for this development benchmark. Process RSS is not total application PSS, and
speed does not establish naturalness. The 4 November research and recognition results are in
[the speech follow-up](voice-review-2026-11-04.md).

**Historical measurements, before the Kitten default.** The table below preserves the earlier Piper/Kokoro baseline;
it does not describe the current production model selection or promise a neural WebAssembly path.

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
| Kokoro v1.0 fp32 (`kokoro-multi-lang-v1_0`) | several times real time | 0.52 / 0.41 / 0.38 (2 / 3 / 4 threads) |
| Kokoro v0.19 fp32 (`kokoro-en-v0_19`) | — | 0.74 / 0.53 / 0.48 (2 / 3 / 4 threads) |
| All 4 cores kept busy by other work: listening / Piper (1 thread) / Piper WebAssembly | 0.237 / — / 0.56 | 0.071 / 0.14 |
| Kokoro int8 (`kokoro-int8-multi-lang-v1_0`) | — | 1.14–1.27 (2–4 threads) |

**How long a spoken answer takes.** Each spoken request logs one `voice.latency` line, with times only, never words.
- `asrMs` is what transcribing the request took.
- The other fields count from when its transcript arrived:
  - `sentMs`: the request handed to Copilot, after the screen read of up to 3 s;
  - `ackMs`: Ember's acknowledgement handed to the voice (below), when it gave one;
  - `firstTokenMs`: the answer's first words;
  - `firstChunkMs`: its first piece handed to the voice;
  - `firstAudioMs` marks the first speaking report during the trace. The neural player reports when it schedules audio,
    and the system voice reports synthesis start. The first report may come from an acknowledgement or other local speech.
- A step that didn't happen is left out: a stop, or speaking off.

When speech is interrupted, `voice.hush_ack` records the time from main requesting cancellation to the speaking renderer
confirming it. It contains only the renderer kind (`mic` or `speaker`) and milliseconds (`ms`). It measures renderer
response. Check audible silence separately on real devices.

**Native speech on Linux.** `node scripts/voice/fetch-capi.mjs` fetches sherpa-onnx's prebuilt C API for Linux x64
(`CAPI_RELEASE` in app/voice/models.ts: the archive and each library Ember loads pinned by SHA-256; they need only
GLIBC_2.17) into `.cache/voice/capi` and prints the libraries' folder. `npm run package` runs it, and stage.mjs copies
the two libraries into `resources/voice-native`, refusing any that doesn't match its pin; nothing is downloaded at run
time. In development, run Ember with `EMBER_SHERPA_CAPI=<that folder>` (a development switch, ignored by an installed
Ember) and listening and Ember's voice run natively through koffi (app/voice/capi.ts). The settings and logs say
`C API through koffi`. `EMBER_SHERPA_CAPI=<folder> node scripts/voice/bench.mjs` and `scripts/perf/latency.mjs` time it
against WebAssembly. When sherpa-onnx's version changes, run `node scripts/voice/capi-structs.mjs <its c-api.h>
<version>` to regenerate app/voice/capi-structs.ts, pin the new libraries, and check them again for processor
features (`CAPI_CPU_NEEDS`). `ELECTRON_RUN_AS_NODE=1 /opt/ember/ember test/smoke/capi-load.mjs
/opt/ember/resources/voice-native` prints `sherpa-onnx 1.13.8` when an installed Ember's libraries load.

**Does Ember hear itself?** Before Ember can be interrupted without "Hey Ember" (docs/ASSISTANT.md 2.3), its own
voice must not reach its microphone. Ember plays its voice through Web Audio, which Chromium's echo cancellation is
documented not to cover; `EMBER_TTS_OUTPUT=element` (development builds) plays it through an `<audio>` element
instead, which it is documented to cover. `node scripts/voice/echo-check.mjs` (after `npm run build` and
`node scripts/voice/prepare.mjs`) measures both on the computer it runs on: quiet room, then six of Ember's sentences
per path. It prints how many dB above the room Ember's voice came back, and any wakes, speech onsets or utterances it
caused (lower is better; `--json out.json` keeps the numbers). Run it with speakers, not headphones, and nobody
talking; `--fake` only checks the script itself. The recording is deleted when it ends.

When Copilot hasn't started answering a spoken request within 0.7 s, Ember acknowledges it in a few words that fit
the request ("On it." for something to do, "Let me look." for a question about the screen, "Let me check." for other
questions, "Let me show you." for "show me how", "Got it." for something to remember), and the answer follows it. A
request that fits none of these (or isn't in English) gets no acknowledgement: a generic filler helps no one
(app/main/acknowledge.ts).

A streamed answer is spoken from its first clause once that has at least 18 characters and 4 words ("I can't do that
one,"). Ember doesn't wait for Copilot to finish the whole first sentence (`SpeechStream`, app/voice/tts.ts), and a
first sentence of more than 48 characters said whole is cut at its first such clause: the voice takes about 18 ms a
character in WebAssembly. A list can be split after its first item that way ("The bench has a name field, a password
field…" starts with "The bench has a name field,").

**When a request ends.** The VAD ends a request after 0.6 s of silence (about 0.72 s after the voice, with Silero's own
lag). At a quiet pause of 0.35 s in it, what was said so far is transcribed ahead (`SPECULATE_FRAMES`,
app/voice/engine.ts): if the VAD then ends the request with no sound since, that transcript is the request's, and it
is sent without waiting for Moonshine again, but only when the VAD's own speech ended by the time that transcript was
made (soft words it heard as speech after the pause are in its segment, which is then transcribed), and only for a
request of up to 6 s so far (`AHEAD_MAX`). When a request ends doesn't change: a request that goes on after the pause
throws that transcript away. A bare "Ember, …" not shown yet, a cut-in over Ember's voice, a wake still being
checked and a room where others talk are transcribed from the VAD's own segment, as before.

**Timing the latencies.** `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/perf/latency.mjs`
(after `node scripts/voice/prepare.mjs --tts-voice --voice ryan`, its test voice; `--only voice,tts,ask,task,kill`,
`--runs N`, `--json out.json`) prints the median and p95 of each step: wake word → listening and end of speech →
transcript on the real models (clips synthesized with another voice, fed frame by frame on a real-time clock, and
requests said with a pause in the middle, to count those cut short), the first spoken audio of an answer streamed at
the mock model's pace, a typed question → the first token through the real Copilot runtime and the mock model, a
task's start → its first tool call and each tool's time (the eval's scripted tasks; set `EMBER_PYTHON` to a Python
with GTK 3), and the kill switch with a turn streaming and the mouse borrowed. Run it on `main` and on a change, on
the same computer, one after the other.
The eval's wake gate also honours `EMBER_SHERPA_CAPI` and names the backend in its result. Both measurements count
compute queued by an earlier slow frame. Compare the same backend and machine load before treating a wake over
300 ms as a recognition regression; selecting the native libraries for the app does not select them for a separate
eval unless its environment includes that directory too.

A follow-up's admission stays tied to the original wake's loudness, even across successive requests. Once admitted,
its own loudness decides when its softer words end. Reusing the louder wake for both checks cut a third request at
"And make the text" before "a bit bigger"; the real-model suite keeps that slightly softer three-turn recording as a
regression alongside the Electron smoke.

**What Ember costs at rest.** On Linux, after `npm run build` and `node scripts/voice/prepare.mjs`, run
`dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/perf/footprint.mjs`.
- It starts the built app with a throwaway data folder, consent and voice on, and silence for a microphone (`--sound`
  plays a tone instead).
- It prints each process's memory (PSS) and CPU, and each page's main-thread CPU, then the same as JSON.
- Compare a change against `main` on the same computer: Xvfb has no GPU or compositor.
- On 4 vCPUs at 2.1 GHz it measured 741 MB and 35 % of one core. The setup page was open (no sign-in) and cost 10.6 %;
  the speech process cost 1.1 % in silence.

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

**Where the sign-in goes (BE audit #1).** Only the one sign-in Ember picked goes to the Copilot runtime, and only as
the environment variable `COPILOT_SDK_AUTH_TOKEN` of the runtime process (the pinned @github/copilot-sdk 1.0.21 does
it so: `--auth-token-env COPILOT_SDK_AUTH_TOKEN` is all that is on its command line). Ember removes every other
GitHub or Copilot credential from the environment it gives the runtime (`withoutGitHubCredentials`,
app/main/agent/runtime-env.ts), and hands none over when another model service is in use. Extension servers start
through Ember's launcher with `appEnv()`'s allowlist, and Ember sets every credential variable (`CREDENTIAL_VARS`,
app/main/agent/credential-env.ts: `COPILOT_SDK_AUTH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_GITHUB_TOKEN`, the two
`*_ENTERPRISE_TOKEN`s, `COPILOT_CONNECTION_TOKEN` and the two `COPILOT_PROVIDER_*` credentials) to an empty string in the
`env` of every stdio MCP server it gives a session (`hardenedSessionConfig`): the runtime merges that `env` over its own
environment, so the launcher and any other stdio server start with those variables empty, not holding the sign-in. Any
GitHub-token-shaped text, any token the commands redactor knows by its shape (`TOKEN_SHAPES`: AWS, Slack, Google, npm,
OpenAI, Anthropic, Stripe, Hugging Face, GitLab), `Bearer` or `token=` value and URL password is replaced in the
finished line of every Ember log (logger.ts, `redactSecretText`) and in the sentence a failed start shows; the user's provider key is replaced by
exact match in messages, scopes, keys and fields (`redactingLogger`). Observed on the real runtime with
`scripts/runtime-env-live.sh` (a network namespace with only loopback, dummy tokens, not in CI): before this blanking
both the directly started server and the launcher held the dummy token in their environment; now neither does, nor does
the extension's process, and the credential variables in their environment are all empty. Still true: the runtime
process itself holds the token (its `/proc/<pid>/environ` shows it), and a stdio server, being the runtime's child,
can read that file as the same user; the SDK has no option to keep the runtime's environment from it. Remote (HTTP)
servers' headers are not scrubbed. The runtime's own shell, file and web tools are not offered to the model:
`availableTools` is an allowlist of the agreed `mcp:` tools only (session-config.ts, `hardenedSessionConfig`; pinned in
extensions-runtime.test.ts), so the model has no runtime tool that could print its environment (`verifySessionTools` checks the list the runtime reports). A token from `gh auth token` or the environment is still accepted when no Ember sign-in exists.

Then press **Ctrl+Alt+Space** and type a question.

To try Ember offline without Copilot, run the mock model and point Ember at it (development checkouts only: an
installed Ember ignores every `EMBER_TEST_*`, `EMBER_ADMIN_POLICY`, `EMBER_VOICE_MODELS`, `EMBER_BENCH_LOG`,
`EMBER_COPILOT_RUNTIME`, `EMBER_VOICE_DUMP`, `EMBER_MEMORY_LOG`, `EMBER_AX_PROVIDER`, `EMBER_TTS_OUTPUT`, `EMBER_NO_OUTPUT_WATCH` (a test that speaks through the speakers as the user would count as other sound) and `EMBER_SHERPA_CAPI` switch):

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
| Speech models and Better recall's model (downloaded once, SHA-256 checked) | `~/.config/ember/models/` |
| Long-term memory, and Better recall's vectors of it (0600) | `~/.config/ember/memory.json`, `~/.config/ember/memory-vectors.json` |
| What Ember made on its desk | `~/Ember/` |
| App profiles used on the desk (kept separate from yours) | `~/.config/ember/desk-profiles/` |
| Computers added over SSH, WSL's switch, and each computer's command switches | `settings.json` (`targets`, `commands`) |
| SSH's password helper: a two-line wrapper, and a socket for each connection while it asks | `~/.config/ember/ssh/askpass`; `$XDG_RUNTIME_DIR/ea-*/` |
| Node.js downloaded for other computers (SHA-256 checked) | `~/.config/ember/remote/runtime/` |
| Extensions: what is installed and the tools the user agreed to (0600), Ember's copy of each plugin, and the process ids of the servers running (folders 0700) | `~/.config/ember/extensions/` (`extensions.json`, `plugins/<id>/`, `run/`) |
| The Copilot runtime's temporary files (large tool output it saves; 0700, emptied at each connect and at sign-out) | `~/.config/ember/copilot-tmp/` |
| Marketplaces the user added, and the runtime's copy of their catalogues | `~/.config/ember/copilot/settings.json`, `~/.config/ember/copilot/.cache/copilot/marketplaces/` |

A hand edit of `settings.json` that Ember can't use is copied aside as `settings.json.bad-<time>` (the three newest
are kept); one it can repair is tidied once it has stayed the same for 2 s. A `settings.json` that can't be read at
start-up is never replaced with defaults: Ember says so, keeps changes in memory and saves them over the file once it
reads again.

A short filesystem write is completed before settings replace the previous file. If writing stops or the disk fills,
the previous file stays intact and Ember reports that the change was not saved. An immediate change is not applied;
a slider change already in use stays pending for the next save. Audit retention also completes each byte write
before publishing a replacement; a failure preparing that replacement leaves the original audit file intact.

Environment variables for development:

| Variable | Effect |
|---|---|
| `EMBER_USER_DATA=/tmp/x` | Use another settings and log folder |
| `EMBER_LOG_LEVEL=debug` | More detail in the log: `debug`, `info`, `warn` or `error`, in any case; anything else means `info` (and is logged) |
| `EMBER_LOG_STDOUT=1` | Also print log lines to the terminal (on by default in development) |
| `EMBER_PYTHON=/usr/bin/python3.12` | Python for the accessibility sidecar (Linux; default: `/usr/libexec/platform-python`, then `python3`) |
| `EMBER_AX_PROVIDER=fake` | Windows and macOS, development only: the accessibility host reads a pretend desktop instead of the real one (a small bench, or the windows in the JSON file `EMBER_AX_FAKE_DESKTOP` names) |
| `EMBER_TEST_EXTENSIONS=demo` | Development only: settings' **Extensions** section runs on a pretend runtime held in memory (`app/main/extensions-demo.ts`), which reaches no network, runs nothing and opens no browser: `demo` has marketplaces, plugins (one with a changed tool) and connectors (one needing a sign-in again), `empty` has nothing added, and `managed` is turned off by the organisation. For the render checks |
| `EMBER_TEST_ALLOW_LOOPBACK_SSH=1` | Development only: lets Ember connect over SSH to this same computer (`127.0.0.1`), for the SSH tests (§14.5) |
| `EMBER_MEMORY_LOG=30` | Development only: every that many seconds, logs `memory.report`: each Electron process's private bytes (Windows) and working set in MB, each renderer named after its page and window (`renderer mic Ember microphone`), and the totals. Working set counts the pages processes share once per process, so its sum over-counts; compare private bytes. The accessibility host and the Copilot runtime are processes of their own and aren't in it |
| `EMBER_EXTENSIONS_LOCAL=1` | Development only: ExtensionsService accepts an absolute local folder holding a `marketplace.json` as a marketplace (Home's field still takes only GitHub repositories and https addresses, so this is for scripts and tests that call the service) |
| `EMBER_REMOTE_DEV=1` | For the remote agent only: lets `ember-remote.cjs` run from a checkout's `dist/remote` instead of a verified install (§14.5); an installed agent ignores it |

Apps Ember must never read or capture are listed under `privacy.neverLook` in `settings.json` (matched against app name
and window title, ignoring characters that show nothing, such as a soft hyphen, and accents written apart; password
managers and polkit are listed by default).

### Your own model provider ("bring your own key")

Removing a key, signing out, or changing the provider settings invalidates keyring work already in progress.
A late keyring answer cannot restore a removed key or reconnect an old endpoint.

Home › Models & connections › **Model provider** lets a user point Ember at a model service of their own instead of GitHub Copilot
(`settings.provider`, off by default; app/main/provider.ts): **Provider** (OpenAI-compatible, Azure OpenAI or
Anthropic), **Endpoint** (https, or plain http only for a server on this computer: `localhost`, `127.0.0.1`, `::1`,
such as Ollama at `http://localhost:11434/v1` or LM Studio at `http://localhost:1234/v1`), **API key**, the
**Conversation model** and **Model for tasks** (the conversation's when empty; it must take images), and under
**Advanced** the wire API (`completions` or `responses`) and Azure's API version. **Test connection** makes one GET of the
service's model list with the saved key and says in one sentence what came of it. It is disabled, and main refuses it,
until the card below is agreed for the endpoint's host: nothing at all goes to a host the user hasn't agreed to, with
or without a key. It refuses redirects: a redirected fetch drops `Authorization` across origins but keeps custom
headers, so Azure's `api-key` and Anthropic's `x-api-key` would reach whatever address the service named.

- **Consent.** Turning it on with an address shows a card naming the endpoint's host and everything that goes there
  instead of to Copilot, screenshots for tasks included. Nothing goes there until the user agrees, and the yes holds
  only for that host (`provider.consent.host`, `FEATURE_CONSENT_VERSION.provider`): another address asks again. The
  yes is recorded only by main (`PROVIDER_IPC.agree`, for the host the endpoint in settings names); Home's general
  settings changes can't carry it (`settingsFromHome` drops `provider.consent`), and they merge into the user's own
  settings (`withOwnProvider`), never writing back values the policy applied. "I agree" is armed as Ember's questions
  are: for 500 ms after the card is drawn for another host it ignores activation, and the host is taken when it is
  pressed, so a card redrawn at all between the press and the click (pressing blurs the address field, which saves it) agrees
  to nothing (`AgreeGuard`).
- **The key** is sealed with the OS keyring (`safeStorage`) in `provider-key.bin` in Ember's data folder (0600), apart
  from `settings.json`, together with the host it was entered for (also in `provider-key.host`, which isn't secret, so
  no keyring is asked to know it). It goes only to that host: moving the endpoint to another host deletes it, and the
  user enters it again; so does clearing the Endpoint field (on purpose: a key with no host to go to isn't kept).
  While it is read at a start, the status line says "Reading your saved API key…" (a macOS Keychain prompt then has
  context). A key replaced or removed stays redacted from the log for the rest of the run, as a task may still run on it. The keyring is asked only once the provider is on with a key saved for its host (never at a
  start otherwise), and on macOS only asynchronously: a synchronous Keychain check on the main thread can block on a
  headless Mac, and a second Ember handing over to a blocked first one hangs. Where the keyring is `basic_text` (no GNOME Keyring or KWallet), Ember refuses to keep a key and
  says why; a local server that needs no key still works. The key is never logged, audited, shown again (Home says
  "Key saved", with **Replace** and **Remove**) or put in any process's environment: it reaches only the Copilot
  runtime's provider config. **Remove** and **Sign out** delete it. Another GitHub account signing in leaves it in
  place: the key belongs to the user's model service, not to a GitHub account, so an account change has nothing to do
  with it (Sign out deletes it only because signing out forgets everything the user set up).
- **Switching** applies from the next message, without a restart; tasks already running finish on the service they
  started with. A request asked while a turn or a task is still under way on the service before is held, with a bubble
  saying so ("Switching model service", up for as long as anything is held), and sent to the new one once they are
  done, in the order asked (one asked during the switch goes behind them); it never goes to the one before, and no new
  task starts on it (a queued one ends saying the service changed). "Done" is the runtime's own word for the turn, not
  the bubble's; after a Stop the turn is over at once. The switch's connect is waited on for at most 15 s, as a
  request waits for any connect: then they go on, and are told Ember is still connecting. Stop, Stop everything and
  quitting drop the held requests and end the switch's wait. A
  conversation isn't carried to another service: a new one starts (memory stays). While the user's
  provider is in force, no GitHub sign-in is passed to the runtime, and the setup check's model row says
  "Your own model provider (host)". The runtime gets the address as the URL parser writes it, and the agent's log has
  the key replaced by `[key]` wherever an error quotes it.
- **Images.** The user's models are taken to read images (the service doesn't say otherwise until it refuses one), so
  tasks send screenshots; a model that refuses them ends the task with "This model can't read images" and where to
  choose another, not the service's raw error.
- **The administrator's** `provider` always wins, and `features.userProvider: false` or a lockdown turns the user's off.

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
| `features.voice` / `speak` | No "Hey Ember" / no spoken replies; either one also keeps the optional native voice off and its model download from starting, shown as managed |
| `features.actions` | Ember answers and guides ("show me") but never acts in apps |
| `features.cursor` / `desk` | No borrowing the user's mouse and keyboard / no private desk |
| `features.screenImages` | Accessibility text only; no screenshots go to the model |
| `neverLook` | Apps and windows Ember never reads, captures or acts in (added to each user's list) |
| `confirmEveryAction` | A click before every action and every command, every time |
| `allowGrants` | `false` removes "Always in this app", and Ember asks before working in an app even when the user asked for help in it |
| `features.memory` | `false`: Ember remembers nothing between runs ("Remember what I tell you" off, managed), learns nothing on its own (no extraction, refinement or questions, so none of memory's own model requests), and "Tell Ember about you" says memory is managed; a memory file already there is left unused (signing out still deletes it). Better recall's model isn't downloaded or run either |
| `features.updates` | `false`: Ember never asks GitHub about new versions ("Tell me when a new version is out" off, managed) |
| `features.routines` | `false`: no routines, and reminders end when Ember quits ("Keep my routines and reminders" off, managed); a routines file already there is left unused (signing out still deletes it). An Ember from before this key reads a policy that has it as broken and locks down, so update Ember first |
| `features.extensions` | `false`: no extension loads or runs, and none can be added (the Extensions section says so and lists what was added, read only); what was installed is left untouched and unused. LOCKDOWN turns it off too. An Ember from before this key reads a policy that has it as broken and locks down, so update Ember first |
| `features.aiReview` | `false`: no command is sent to the model for review; every command Ember's rules flag asks the user ("Ask only about dangerous commands" off, managed) |
| `features.autonomy` | `false`: "Work without asking" is off and managed; Ember asks before a first step in an app, a borrow and moving text between apps, as before. `allowGrants: false`, `confirmEveryAction: true`, `features.actions: false` and LOCKDOWN turn it off too. `true` turns nothing on. An Ember from before this key reads a policy that has it as broken and locks down, so update Ember first |
| `models` | Only these models; or pin the conversation and task models |
| `provider` | Use the organisation's own endpoint (`openai`, `azure` or `anthropic`) instead of GitHub sign-in; the key is read from `apiKeyFile` (or, without one, from the environment variable `EMBER_PROVIDER_API_KEY`). It always wins over a user's own provider, which Home then shows as managed |
| `features.userProvider` | `false`: users can't point Ember at a model service of their own ("Use my own model provider" in Home › Models & connections is off and managed; a key already saved stays unused until signing out or Remove deletes it). Allowed when absent; the organisation's own `provider` and LOCKDOWN turn it off too, and `models.allowed` and pinned models still hold for the user's model ids. An Ember from before this key reads a policy that has it as broken and locks down, so update Ember first |
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

Linux ships no Node addons (`ember.nativeModules` is `[]`), and these libraries loaded with koffi, by name:
`libsherpa-onnx-c-api.so` and `libonnxruntime.so` (sherpa-onnx 1.13.8's prebuilt C API, in `resources/voice-native`,
pinned by SHA-256 in `CAPI_RELEASE`). `npm run check:symvers` and `scripts/rebuild-el8.sh` check them with
node_modules (fetching them first with `scripts/voice/fetch-capi.mjs`), and CI checks them again in the staged folder.

## 7. Packages

```bash
npm run package            # dist/package: the RPMs and the AppImage
```

This section is Linux's. The Windows zip is in §10.5, Ember.app and its dmg in §11.5.

The RPMs carry the build machine's dist tag (`.el8` when built on RHEL 8 or `rockylinux:8`, as CI does).

| Output | What it is |
|---|---|
| `ember-<v>-1.el8.x86_64.rpm` | Ember in `/opt/ember`, `/usr/bin/ember`, menu entry and icon. Library dependencies are listed explicitly (no auto-detection), optional parts are *Recommends* (Ember's desk, the system voice, microphone list, tray icons). It carries the speech models in `/usr/share/ember/voice-models` (a release must: `EMBER_RPM_MODELS=required`; they come from `node scripts/voice/prepare.mjs`), and replaces 0.1.0's separate `ember-voice-models` RPM on upgrade. Native speech's libraries are in `/opt/ember/resources/voice-native` (they neither require nor provide anything: `rpm -qpR` lists only the explicit packages). `chrome-sandbox` is setuid root, so Ember stays sandboxed on STIG hosts where user namespaces are off. Needs `rpm-build` |
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
without it (a command the classifier found dangerous counts too, unless its card was allowed or the user's own words
named it exactly, and never for a secret, download-and-run or anything unclear), and everything risky was asked about. A task with `"hands": ["commands"]` gets run_command on this
computer through the real classifier, decision and local runner, in its own folder, as a user who isn't root. The
simulated user answers a question as soon as it shows (the harness turns off the Confirmer's guard against too-early
clicks, which would drop its answers; a command card, which arms later, takes it once armed), and reads a long
typed text through first, as a user scrolls to its end before **Allow** works. Ember's test
windows need GTK 3 for the sidecar's Python (`python3-gobject`, `gtk3`); without it their tasks are skipped, with
the reason. Each attempt's temporary folder (settings, audit log, files) is deleted when it has been judged; `--keep`
keeps them (`/tmp/ember-eval-<task>-…`) to look into a failure, and `--verbose` prints Ember's warnings. A script
step's optional `result` is a regex its tool result must match before the mock replays the next step (what Ember
told the model, as in `editor-close-window`); anything else stops the script and fails the task.

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
terminal). CI runs the Copilot-runtime integration suite on Linux only, and the voice suite on Linux (WebAssembly, and
on `rockylinux:8` the C API too), Windows and macOS (the native addon, with `test/smoke/voice-backends.mjs`); on Windows it also runs the suites in
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

An Electron child that a suite starts leaves Electron from the main message loop (`setImmediate(() => app.exit(0))`),
never with `app.exit()` straight from `ready` or `app.whenReady()`: "ready" comes before that loop runs, and an exit
there goes through the C runtime's `exit()` while Chromium is still launching its GPU process, which on Windows crashes
with 0xC0000005 now and then, more often during a theme change (electron/electron#55011).

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

Ember keeps its data out of the roaming profile: Chromium's caches, Copilot's session state and speech
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
10 seconds: once it changes, a running Ember stops and stays locked down until the user restarts it (§5). Every key
in §5's table works here too, `features.autonomy` ("Work without asking") and `features.userProvider` (a user's own
model provider) among them.

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
| Task Manager lists a dozen Ember processes | Electron runs each window's page in a renderer of its own, plus the GPU, network and audio services, the voice process ("Ember voice", mostly the speech models) and the accessibility helper. Compare their private bytes (Task Manager's Details tab, **Memory (private working set)**), not the working set, which counts shared pages in every process. Chromium's video capture service runs inside the main process (the mic page's device listing starts it; Ember opens no camera), and the prompt window and the speech-only window close after a minute unused. `EMBER_MEMORY_LOG` (§5) names each renderer in a checkout |
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
Every key in §5's table works here too, `features.autonomy` ("Work without asking") and `features.userProvider` (a
user's own model provider) among them. Ember reads this file
only, not managed preferences, so deploy it as a file (a package or a script from your management tool):

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
- **Command output is not completion status**: remote runs use the child process's exit code and signal. Printed
  `ember-exit` sequences on stdout or stderr cannot override them, including on pipes and Linux/macOS PTYs.
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

### 14.7 Copilot project work

In Home under Projects, choose up to six source files, then send a review, plan or patch request. The
connected model sees only the files you send. For an exact patch to one existing UTF-8 file with a final
newline, Ember shows the diff in **Review changes before applying**. Check it, choose **Apply patch** and
confirm the destination. If the source has changed since you sent it, draft the patch again. Ember keeps
LF or CRLF line endings and any UTF-8 byte-order mark. Drafts with file additions, renames, deletions or
unsupported diff formats remain available as text.

Open **Run a project command** to choose a local starting folder and enter a command. Ember applies the
same settings, classifier and stop controls as its command window. Each run waits for approval of the
exact command and folder. Output stays in the command window. The connected model does not receive it.

**Saved workspaces** keeps up to eight named checkpoints for the verified GitHub account or connected
provider configuration. Saving requires the system keyring and stores encrypted paths and the last
completed request and answer. Opening a workspace restores its file selection and command folder. On
the next explicit Send, Ember reads the selected files again and includes the previous exchange if its
checkbox is selected. Patch approvals, command text, running processes and command output are never
restored. **Forget workspace** removes the checkpoint and leaves the project files in place.

With a build ready, run `EMBER_PROJECT_TEST=1 npm run test:integration -- test/integration/project-live.test.ts`
to exercise the Home workflow through Electron and the Copilot runtime against an offline mock model.

## 15. Publishing a release

The README sends users to the Releases page and tells them to check each file against `SHA256SUMS`, so every release
needs both. CI publishes them when a `v<v>` tag is pushed:

1. On `main`, set `version` in package.json to `<v>` and give CHANGELOG.md a `## <v> (<date>)` section: its text
   becomes the release's notes.
2. Tag that commit and push the tag: `git tag v<v> && git push origin v<v>`.
3. The tag runs every job of `ci.yml`, the Intel Mac's included, and each platform's job uploads its packages
   (`ember-packages`, `ember-windows`, `ember-macos`, `ember-macos-x64`). Once all of them pass, the **release** job,
   the only one with write access, downloads the four artifacts into one folder, and `scripts/package/release.mjs`
   fetches the three `source-*.zip` archives the licence notices name (`scripts/package/gpl-source.mjs`: sherpa-onnx,
   eSpeak NG and piper-phonemize, refused unless their SHA-256 matches; GPL-3.0 section 6 for the voice's eSpeak NG. A
   sherpa-onnx bump means pinning its new sources there), and
   checks that it holds exactly those and the eight files the README downloads: `ember-<v>-1.el8.x86_64.rpm`,
   `Ember-<v>-x86_64.AppImage`, `Ember-voice-models-<v>.zip`, `Ember-<v>-win-x64.zip`,
   `Ember-<v>-mac-arm64.dmg`, `Ember-<v>-mac-arm64.zip`, `Ember-<v>-mac-x64.dmg` and `Ember-<v>-mac-x64.zip`. It
   refuses a tag that isn't package.json's version, and takes the notes from CHANGELOG.md, with relative links made
   absolute at the tag and wrapped lines joined. The job then writes the checksums, one line per file (a hash, two
   spaces and the file name, which is what `sha256sum -c` reads):

   ```bash
   sha256sum ember-*.rpm Ember-*.AppImage Ember-*.zip Ember-*.dmg source-*.zip > SHA256SUMS
   ```

   and creates the release `Ember <v>` for the tag with the eleven files and `SHA256SUMS`.
4. When that ci run has passed, `.github/workflows/npm.yml` publishes the npm launcher, `packages/npm` (the
   `ember-copilot` package, whose `ember` command downloads the release's zip or AppImage, checks it against
   `SHA256SUMS` and starts it), with `npm publish --access public --provenance`. Its version must be the tag's: bump
   `version` in `packages/npm/package.json` with the app's (a unit test checks they match). It refuses a release
   missing `SHA256SUMS` or one of the files it downloads, and does nothing when that version is already on npm. It
   signs in with npm Trusted Publishing (OIDC, no token) and falls back to the `NPM_TOKEN` repository secret (a
   granular npm token that can publish `ember-copilot`); with neither it warns and skips, so a release never fails
   because of npm. The first publish needs `NPM_TOKEN`; after it, add a trusted publisher on npmjs.com
   (**ember-copilot › Settings › Trusted publishing**: GitHub Actions, this repository, workflow `npm.yml`) and the
   token can be deleted. For a release that already exists, run **Actions › npm › Run workflow** with its tag.

When a job fails, nothing is published: fix it on `main`, move the tag to the fixed commit (`git tag -f v<v>` and
`git push -f origin v<v>`) and the run starts again. To publish by hand instead, run **Actions › ci › Run workflow**
with **packages** and **intel** ticked (§13), download the four artifacts into one folder, write `SHA256SUMS` there
with the command above, and create the release with those files.

## Repository layout

```
app/main/           Electron main process (settings, logging, environment checks, windows, agent, perception)
  memory/           long-term memory (docs/MEMORY.md): the temporal graph, recall (BM25 + Personalized PageRank),
                    sleep-time consolidation, the secret guard, memory.json and MemoryService (main's); learning on
                    its own: learn.ts (extraction), refine.ts, questions.ts, intro.ts and MemoryLearning (learning.ts);
                    Better recall: the WordPiece tokenizer, the embedding model and its process, the vector index
  personal/         voice personalisation (docs/ASSISTANT.md §7): the transcript corrected against the user's words
                    (phonetic.ts, correct.ts, words.json), what they might say next (predict.ts), PersonalVoice
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
                    Every new helper process (Python, the host, a WSL distro's, a remote's) is asked `ping` first and
                    must report exactly `SIDECAR_PROTOCOL_VERSION` (app/shared/sidecar-protocol.ts, which the Python
                    VERSION and app/sidecar-host/protocol.ts must equal: a test reads all three). Until it does,
                    nothing else is written to it (the remembered secret fields included); a wrong, missing or
                    errored answer fails every waiting request with a plain "out of date" sentence, ends the helper,
                    logs `sidecar.version_mismatch` and is not retried by that client. A new client tries afresh.
                    A refused or replaced helper's later output is ignored, and before the ping passes only its answer
                    counts (a response to any other id is dropped, so it can't resolve a held request). In a WSL distro the
                    refusal is the row's sentence and stays until the distro stops (then a fresh client may try); the Windows
                    bridge, once refused, stays refused for the run (a late ready line changes nothing).
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

### Action approval freshness

An approval applies to the window, control and contents shown when Ember asked. Before input, Ember checks them again after waiting for a lease or moving the pointer. If the dialog, text being replaced, controls or window change, or the check cannot read them, nothing is entered: use a fresh `perceive_window` and let policy decide again. Window movement and focus changes alone do not invalidate the check. Ember's own focus click may collapse the target text selection before append/replace; it still checks the text itself, and insert-at-caret keeps its original selection binding. If clicking Allow closes a menu, reopening it is a new policy attempt; risky menu actions require another approval. No consent is cached by app and menu label.

**Hear me more clearly** (`voice.clearHearing`, Settings › Voice) fetches `CLEAR_SPEECH` (Parakeet TDT 0.6B v2, 482 MB) on Windows, macOS and Linux's C API, and starts the voice process again with it; the log says `voice.clear_wanted`, `voice.clear_ready`, and `clear: true` on `voice.ready`. An organisation's `features.voice: false` turns it off.

Action-context reads use separate baselines for the quick accessibility tree and the detailed target read. AT-SPI omits empty and object-placeholder text from the tree and limits its text more tightly; the detailed target text is compared exactly against its own pre-approval value, never by prefix. Each action refreshes policy context before approval, preserving original actionable ids only when the tree structure and target identity still match. Repeated role/name targets (such as two dialogs' OK buttons) are ambiguous and are refused before approval; positions are never used to choose between them. A web page lives on its own (a video playing, a hover preview), so a control of one, in no dialog and with no risky word in its name, is the exception (`livingPage()`, worker.ts; owner's report of 2026-11-05: every click on YouTube was refused): a step that asks nothing needs only its window, no modal over it and the object itself to hold (`checkPageTarget()`), and a link or button may share its name with a twin, since the click goes to the object by id (`PAGE_TWIN`). A question still binds its answer to the whole tree, and pressed keys likewise (`focusShell`). This lets a completed form step update its status and contents without carrying its approval into the next step.

AT-SPI 2.60 calls push buttons `button`. The sidecar uses the same role for older and newer servers so click actions and protection around password-reveal controls still apply. A GTK list checkbox with alternate cell actions still requires a pointer click rather than accessibility row selection.

Toggle requests hold the window lease from their fresh context/desired-state read through approval and mutation. A second request for the state already reached succeeds without toggling again. Stop and deadlines also bound waits for worker session creation, tool validation and submission: the task settles within its two-second grace even if a runtime request remains unresolved. Late-created sessions receive no prompt and are aborted, disconnected and deleted.

### Voice request cancellation

`VoiceService` owns the listening generation sent with init, cancel, enrolment and voiceprint changes. The voice process tags engine events and learning samples with that generation; main rejects old generations even when IPC or inference is delayed beyond a second. `VoiceGate.cancel()` separately revokes pending checks and held wakes, without making new requests wait for old inference. Stop always passes through. Explicit owner changes revoke work, while the adaptation-only refresh preserves the generation and each pending request uses one captured owner/anchor/threshold configuration. Run `npx vitest run test/unit/voice-cancellation.test.ts test/unit/voice-service.test.ts test/unit/voice-match.test.ts test/unit/voice-process.test.ts` for the deterministic regressions; these do not establish real-microphone accuracy.

Answer speech belongs to the request that actually starts, including queued typed and spoken requests. An accepted wake or Stop retires old chunks and acknowledgements; a permission question pauses prior speech while allowing the same turn to answer after approval. Playback callbacks carry their hush generation, and follow-up waits for appended synthesis and playback to drain (or the bounded no-voice recovery). A short negative reply to an ordinary clarification is conversation input; formal approval still goes through the existing question-bound gate.

### npm launcher recovery

The npm launcher serialises installs of a version with a cache-adjacent directory lock, keeps the previous install
as a backup until publication succeeds, and restores it after a failed publication rename. If rollback fails too,
both the backup and checked stage are retained and their paths reported. See `packages/npm/README.md` for manual
recovery after an interrupted installer; locks are never automatically stolen. Tests in
`test/unit/npm-install-rollback.test.ts` inject filesystem errors without downloading or running a release.
