# Release notes

## 0.1.1 (2026-11-07)

Ember 0.1.1 is an unsigned beta, as 0.1.0 was: Windows (SmartScreen, Smart App Control) and macOS (Gatekeeper) stop its
first start, and [README.md](README.md) says what to do and how to install it on each computer. Checks by hand with real
microphones, speakers and screen readers, and on a real Mac and a real RHEL 8 desktop, are still to come; the automated
tests don't stand in for them. **Known issues and limits**, at the end, lists what this version doesn't do yet.

### Getting it

- **On RHEL 8, the RPM carries the speech models** (about 220 MB: listening, Ember's voice and Voice Match), so nothing
  is downloaded when voice is turned on. It replaces 0.1.0's separate `ember-voice-models` RPM when you upgrade (`sudo
  dnf upgrade ./ember-0.1.1-1.el8.x86_64.rpm`).
- **The AppImage carries them too**, as the Windows zip and the Mac's dmg and zip do. It needs `fusermount` to start
  (`sudo dnf install fuse`); where you can't install that, `APPIMAGE_EXTRACT_AND_RUN=1` runs it unpacked. It adds no
  apps-menu entry.
- **`Ember-voice-models-0.1.1.zip`** holds the standard speech models, for IT to install once per computer for every
  copy of Ember (README's **Computers without internet access** says where they go, Linux's machine-wide folder
  included, and lists the optional downloads with their sizes and where they come from).
- **The `ember-copilot` npm launcher is new**: with Node.js 18.17 or later, `npm i -g ember-copilot` and then `ember`
  download this version's Windows zip, macOS zip or Linux AppImage, check it against `SHA256SUMS` and start it (see
  Install, updates and docs).
- **The voice's source comes with each release**: `source-*.zip`, the checked source of sherpa-onnx, eSpeak NG and
  piper-phonemize, as GPL-3.0 section 6 asks for eSpeak NG. The Linux packages' native speech libraries
  (`/opt/ember/resources/voice-native`) come with their licences and notices in THIRD_PARTY_NOTICES, and add no RPM
  dependencies.
- **Ember asks you to agree again at its first start**, because “Before Ember starts” now says more: what it keeps when
  you teach it your voice and correct its words, that once you call it, it keeps listening through the conversation and
  sends what it hears there as text, that Listen once can open the microphone for one request while “Hey Ember” is off,
  what Project work sends and a saved workspace keeps, that “Keep my recent conversation” keeps its latest messages on
  this computer, that anyone near the computer can answer a question by voice, what its vault keeps (a login, a card or
  contact details you give its Secure Form) and that the AI model never types or sees passwords, what it asks before
  (anything risky in an app, a dangerous command and code it can't read) and that a command it doesn't know runs and
  it tells you, and that agreeing turns on what you leave switched on in first run.
- **Interactive is offered once after the update**, and your settings stay: until you agree to its card, Ember asks
  before every step that isn't routine, and says so at the first such question. What is new since 0.1.0 (memory,
  routines and lasting reminders, your own model provider, extensions, update notices, Assisted and Autopilot) shows its
  own card or note the first time you turn it on, and no extension runs before you agree to its card.
- **The commands card is asked again** before Ember next runs a command on a computer you turned commands on for,
  since it now says what each approval mode does with a dangerous command and that a command Ember doesn't know runs.

### For administrators

- **Update Ember before you set the new policy keys.** 0.1.1 adds `features.aiReview`, `features.memory`,
  `features.routines`, `features.updates`, `features.extensions`, `features.autonomy` and `features.userProvider` to the
  organisation's policy: each one false turns its feature off (the RPM's `policy.README`, in `/usr/share/doc/ember`,
  lists every key). It also adds `approvals.maxMode` (`"interactive"`, `"assisted"` or `"autopilot"`), the highest
  approval mode users may choose, and `features.vault`: false keeps Ember from keeping or filling in logins, cards and
  contact details. Ember 0.1.0 doesn't know them: it reads a policy with one as broken and locks down, so update Ember
  on every computer first.
- **What the new keys turn off.** `features.aiReview: false` keeps Assisted's check off, for commands and steps in apps
  alike, so what it would check asks. `features.autonomy: false`, `allowGrants: false`, `confirmEveryAction` and a
  lockdown keep Ember below Interactive, asking as it did before the modes, and Home says why. `features.memory: false`
  (and a lockdown) turns memory and Better recall off; Settings still lists what was saved, with Forget and Forget
  everything. `features.routines: false` keeps no routines and ends reminders when Ember quits. `features.updates:
  false` turns update notices off. `features.extensions: false` (and a lockdown) turns extensions off.
  `features.userProvider: false` (and a lockdown) turns the user's own model provider off, shown as managed; the
  organisation's own `provider` always wins, and `models.allowed` still holds.
- **A Voice change made while the policy holds a setting no longer overwrites the user's own choice** of voice or **Hear
  me more clearly**.
- **Other computers keep their own policy.** A computer reached over SSH holds its own policy for what was cleared on
  yours: a step Assisted's check or Interactive cleared asks there where that policy turns them off or caps the mode.
- **`features.screenImages: false`** now also shows the new **Send screenshots for tasks** switch off and managed, as
  well as keeping screenshots from the model. Ember 0.1.0 knows this key, so a policy with it doesn't lock 0.1.0 down.
- **A policy change shows at once in an open settings window.** Ember still stops everything and holds itself locked
  down until it is restarted, and the window now says so straight away: every switch the lockdown turns off shows off
  and greyed, and Apps & privacy and Commands follow the policy in force; **Hear me more clearly** and Ember's voice
  change once Ember restarts. Home offers **Restart Ember**.
- **Under a lockdown,** first run and Home say Ember is locked down and why, with no Connect Copilot button and no raw
  policy error; **Sign in** starts nothing at GitHub, and Apps & privacy says nothing Ember hears is sent anywhere,
  Listen once included. Where your organisation turned off acting in apps, Projects says so, and a refused project
  command says which reason holds.
- **Where AppLocker or Software Restriction Policies block `powershell.exe`,** Ember can't read apps on Windows, and the
  setup check's Screen reading row says “Windows didn't let Ember run Windows PowerShell. Ask your administrator to
  allow it.” instead of showing no row. Ember then tries PowerShell again only after 5 seconds, 30 seconds, 2 minutes
  and every 10 minutes after that, not at every read (each of which the policy logged as a blocked start).
- **The npm launcher downloads through the proxy npm uses:** npm's `https-proxy` or `proxy` setting, else `HTTPS_PROXY`
  (`HTTP_PROXY` for an `http://` mirror), never for the hosts in `NO_PROXY` or npm's `noproxy`; an `http://` or
  `https://` proxy, not a SOCKS one. Behind a proxy that inspects HTTPS, set `NODE_EXTRA_CA_CERTS` to your
  organisation's certificate file; `EMBER_NPM_DOWNLOAD_BASE` points it at your own mirror. When the proxy blocks or
  can't reach a host (403, 451, 502, 504), the launcher names that host, GitHub's storage host after its redirect
  included, and the setting that names the proxy. [Its README](packages/npm/README.md) has the details.
- **New network destinations, each only once the user turns it on:** Better recall's download from `huggingface.co`
  (served from `*.hf.co`), which a firewall must allow; update notices' one request a day to GitHub's public releases
  list, with no sign-in; the user's own model provider at the address they agree to; and the marketplaces and extension
  servers the user adds.

### First run

- **A returning user keeps Assisted or Autopilot** when first run asks them to agree again: there is no Interactive row,
  and “What's new” says their mode stays.

- **You can start with your own model provider.** The GitHub step offers “Use my own provider”: enter its address, API
  key and a model, agree to where your requests go, and Ember checks the service's models before it says it works; a
  model name it doesn't list fails, naming what it does list (“It lists 1 model: llama3.2:3b. Enter that name.”). A
  model server on this computer (Ollama, LM Studio) needs no API key. Where your organisation turned your own provider
  off, first run doesn't offer it.
- **First run names the service in use** in its own voice (“Connected to your own provider”, “Using your own provider”),
  never Copilot while another service is in use or Ember can't yet tell which, and explains a failing provider as the
  provider's problem (“I can't reach the model server on this computer (127.0.0.1:11434). Start it, and I'll connect in
  a moment.”), never a Copilot or GitHub account one.
- **New details for a provider already in use are checked before they replace it**: a check that fails, or that you
  leave, changes nothing (“Nothing has changed: I'm still using api.example.com.”), so Ember never falls back to Copilot
  in between. **Use GitHub Copilot instead** is the way back; pressed while Ember is busy, it waits until Ember has
  finished.
- **No Copilot on the account? Ember says what to do.** It offers your own provider, a different GitHub account, or your
  administrator, instead of asking you to sign in to the same account again.
- **You see which models Ember picked** (and their premium-request cost) before your first request, and can change them.
  With no model that reads images, the tasks selector shows the one in use and says tasks work from text.
- **One agreement turns on Ember's defaults, each with its own switch.** Under “Before Ember starts”, first run lists
  commands on this computer, memory, “Hey Ember” with spoken replies, screenshots for tasks and Interactive, each with
  its own card's text and a switch that starts on. Agreeing turns on what you leave on; any can be turned off there or
  later in Settings, and nothing is read, heard or sent before you agree. The listening row says that anyone near the
  computer can answer Ember by voice, and stays off where the speech models aren't on the computer; a row your
  organisation turned off shows as managed. The summary also says what Ember's vault keeps and that the AI model never
  types or sees passwords. If you already use Ember, your settings stay and only Interactive is offered.
- **After an update that changes how Ember works,** first run opens at its consent page and lists what changed since you
  last agreed. The page's short form names where your requests go, as its full text does (your own model provider, your
  organisation's model service or GitHub Copilot).
- **First run says when “Hey Ember” is on but can't listen:** the try step names a missing, muted or failing microphone,
  and Ready to start says “On, but the microphone isn't working”, “…is off” or “…not listening right now”, where it read
  “off”. With the speech models gone, the try step and the summary say they need downloading.
- **The API key field says a key is saved only for the address it was saved for**, and without a keyring says “I can't
  keep a key safely on this computer.”
- **Finishing setup no longer wakes Ember.** The last step is “Ready to start” and its button **Start**, so no title or
  button read out as you finish names Ember; Start says “Setup is finished.” and the keyboard lands on Home's status
  line.
- **Keyboard focus stays put, and a held key decides nothing.** A permission fix that fails says so in its row; **Agree
  and continue** and **Quit Ember** take a press only half a second after they appear, so a held Enter or a double click
  neither agrees nor quits, and a second Enter on **Sign in with GitHub** doesn't cancel the sign-in. After **Turn on**
  for screen reading, first run keeps telling you to restart apps that were already open.
- **The setup check says the same everywhere**: a row that keeps Ember from reading apps counts as one to fix in Home,
  its badge, `ember doctor` and first run, and Home's check offers **Copy** for a command and **Check again**, which
  reads the setup afresh.

### Settings and Home

- **One pane at a time**, as System Settings: a sidebar with **Search settings** at its top (Enter goes to the first
  setting found; results show in the page's own words and everyday words find things), and the window reopens where you
  left it. **Home** shows what Ember is doing now: its state, what is on, today's tasks and approvals, **Ask Ember…**
  and **Stop everything**; then the conversation and **Task activity**.
- **Task activity**: each task of this session, step by step, with its plan, its questions and how you answered them,
  and what it found; a task waiting for you says where it asks and which keys answer. Finished tasks stay until you quit
  Ember (the latest 20), through Stop everything and a reconnect; signing out clears them.
- **Ember on screen** (Settings › Your Ember): **Follow my cursor** and **Hide Ember until it needs me** are switches
  now; **Quit Ember** is under them.
- **Starting Ember** once it is set up only greets you, unless the setup check needs you; start it again (or press the
  settings shortcut) to open settings.
- **Light mode.** Home, the command window and Ember's password and consent windows have a light look that follows the
  computer's setting by default (Comfort & access › Appearance); the bubble, task cards, handle and ask box stay dark,
  to read clearly over any app.
- **Home holds the conversation**, with search, Copy, Edit then Send, and **Stop response** apart from Stop everything.
  It shows the latest 6 messages (**Show earlier messages** has the rest), names your send key (Ctrl+Enter, or
  Command+Enter on a Mac), keeps the composer in view while a reply comes, and marks messages kept from before a
  restart. **New conversation** asks first.
- **A long paste is kept whole.** Message Ember, like the Ask box, counts characters from 1,800 and won't send more than
  2,000, saying how many too many, instead of cutting the end off without a word.
- **Home follows Ember's answer, wherever you asked**: “Thinking…” while Ember answers, after 10 seconds a line naming
  **Stop response**, and once the turn ends how it ended (“Reply received.”, “Response stopped. Running tasks
  continue.”). **Read the last answer** opens Home at that answer.
- **A message sent while Ember connects, reconnects or is offline says why** and stays; Stop puts every message that
  hadn't gone back in the composer, and once Ember is back the line under Send says “Connected again. Your message is
  still here: send it now.”
- **Home says what is in force,** not what the switches ask for (“Commands off” where your organisation turned them off,
  “Listening needs its speech models”, “Microphone problem”), offers **Check my provider…** or **Models & connections…**
  for a connection problem instead of **Connect Copilot…**, and tells you when Ember closed unexpectedly last time.
- **Home's words about asking follow the mode.** In Autopilot a root computer's **Ask me before every command** is your
  own switch (in a distro Podman uses it stays on). Where Assisted or Autopilot can't be kept without a keyring, Home
  says it lasts until Ember closes.
- **What Ember did shows its whole record a page at a time** (**Show earlier**), counts all of today's steps, tags an
  “Always in” answer as “Always allowed”, and names password managers properly.
- **Projects has a pane of its own**: remove its files one at a time and see their sizes; a running request keeps the
  files and model service it started with; a reviewed answer is saved only through the system's Save dialog, never over
  Ember's own data. It says why a request failed (a refused API key, a usage limit, files too long), names each file it
  won't send and why, and keeps going when you hide settings. While Ember reconnects, or your own provider waits for
  your yes, it keeps your files and request and sends nothing; signing out or a lockdown clears them, and an answer from
  one model service never goes to another.
- **Projects names the file and the line that look like they hold a password, token or key** (“config.ts appears to
  contain a password, token or key on line 3…”), every such file at once, takes ordinary source and build files
  (`App.vue`, `Makefile`, `tokenizer.ts`), still refuses password managers' exports, won't offer **Apply patch…** where
  the patched file would hold a secret, and refuses an API key pasted with a hidden character. **Run a project command**
  says when commands are off.
- **Routines and reminders** show their words, when they are due in your time and whether they last past a restart, and
  a change that can't be saved leaves the reminder as it was.
- **Keyboard and screen readers in Home.** Focus stays on a running task's Stop task as the task moves on, and on Send
  and Stop response while Ember answers; screen readers hear Home's status lines as they fill; no consent card takes a
  held or doubled key as “I agree”. In Windows contrast themes Ask's eye, a task view's chevron and the Projects tile
  show, and no pane scrolls sideways at 200% zoom with Larger text.

### Asking less, and answering by voice

- **Three approval modes** (Settings › **Apps & privacy**): one choice of **Interactive**, **Assisted** or
  **Autopilot**, each with its own card to agree to first, in place of **Work without asking** and the two narrower
  switches beside it.
- **Interactive**, the default: for ordinary steps Ember says what it is doing instead of asking: a first step in an
  app, borrowing your mouse and keyboard, moving text between apps, OK on a message box whose only button is OK, line
  breaks typed into a plain text editor, filling spreadsheet cells, and in a browser Enter in the address bar or a
  search box, a long address, moving between pages and tabs and closing a tab you asked to close. It asks every time,
  with no “Always”, before anything risky (sending, posting, submitting, sharing, deleting, overwriting, paying,
  installing, signing out, security settings, going past a warning, dangerous commands), before a switch or a choice
  in the system's Settings, for keys it can't be sure of, for a dialog with anything to choose or a question in it,
  for Enter in a chat box, a form or a composer, and through a task that a page tried to steer. Only dangerous
  commands ask (deleting or overwriting, publishing or sending, reading or printing secrets, system changes and
  commands as an administrator, downloading and running code, and what would keep running after Stop), and so does
  code Ember can't read; an ordinary command, and one Ember doesn't know, runs and says so. A dangerous one you asked
  for exactly, that only deletes or overwrites data, publishes something or changes the system, says so and gives you
  4 seconds to stop it.
- **Assisted**: as Interactive, and a step that would ask is first checked by a lighter model against your own words,
  spoken ones too. One it finds in what you asked goes ahead, announced, a risky step or a dangerous command included
  (a command as root or an administrator too, and an extension's tool that changes or sends something): a command it
  clears that reads or prints secrets runs with its output kept from the AI model, and one that would keep
  running after Stop says so. Anything else asks, as does a task with no words of yours. It never clears a step you
  said no to, a command your own words rule out or hold back (“don't push”, “keep it local”, “after the tests pass”), a
  deletion or a write of a place Ember can't name, or what you or your organisation set to ask every time, which ask
  without the check, as does an extension's call after a no or one too long for the check to see whole. Its card says
  what the check is sent and that it can be wrong; the check's words about a command
  reach the system journal only as their size.
- **Autopilot**: Ember doesn't ask before steps or commands, risky and dangerous ones included; it announces and records
  each one, and Stop stops it. It asks only where your organisation's policy or your own **Ask me before every
  command** for a computer says to, in a distro Podman uses and in **Project work**. A command that reads or prints
  secrets runs, and what it prints is kept from the AI model (you see it in the command window), as is every later
  command's output in that task; one that would also save
  them to a file is refused. One that would keep running after Stop runs, and its card and the audit log say Stop won't
  reach it. It refuses, without asking, a command your own words rule out or hold back (“delete the build folder, but
  ask me first”, “…but only the logs”), one that may be something you said no to earlier in the task, and a deletion or
  a write of a place Ember can't name (`rm -rf "$X"`). Its countdown card is headed “About to run this: Autopilot is
  on”; as root or an administrator its commands run without asking, each with a few seconds to stop it, and the card
  says the command runs as the administrator. The never-look list, masked screenshots, the system's own password prompts, consent and the
  audit log hold as before; only Ember fills a password, card or sign-in field, from its vault (below), and the AI model
  never types or sees one.
- **Say a mode's name to change it** (“Ember, switch to Autopilot”, “Ember, ask me first again”). A mode that asks less
  is chosen by voice only once its card is agreed in Settings, from anyone Ember hears (only your recognised voice while
  Voice Match is on), never over Ember's own voice, and never on words Ember can't tell from other sound (on Windows and
  macOS without Voice Match, with Listen once, or said without its name while other sound plays): then, as for typed
  words, Settings opens at the mode instead. A mode above
  Interactive can't be set by editing settings.json.
- **A no holds for the rest of the task, in every mode.** After “Not now”, the same step or command sent again, or the
  same thing done another way (the button pressed with a key, Send in a second compose window, a deletion reworded as
  `find build -delete`), is refused without another question, and Ember takes no step it had lined up behind the refused
  one: it looks again and decides afresh (also after an unanswered question, a refusal or a failed step). Anything else
  that may be what you refused asks, never checked by Assisted and never just announced: `rm -rf dist` or a push to
  another branch after a no to one, a deletion in an app after a refused `rm -rf` (in Autopilot such a step in an app is
  refused). A question nobody answered isn't a no. Once you take your mouse back, Ember asks before borrowing it again
  in that task, and in Autopilot borrows nothing more.
- **Answer questions by voice**: while Ember asks, “allow”, “yes”, “okay”, “go ahead”, “sure” or “I accept” allows, and
  “no”, “not now” or “don't” refuses (so do “absolutely not” and “Just leave it.”, which never allow). With Voice Match
  off, its default, anyone Ember hears can answer, as first run says; with it on, only your recognised voice can allow,
  and anyone can refuse. For a few seconds after Ember asks you needn't say “Ember” first; while a video or other sound
  plays, or where Ember can't tell whether it does, say “Ember, allow”. Never “Always”, never Ember's own voice, and a
  command card or a long text only once all of it has been shown. An answer said over Ember's read-out stops it and is
  asked for again; one it didn't catch, a hedge or a hold (“Wait.”) says why and how to answer. A yes asked as a
  question (“Is that okay?”) isn't one. The audit log says the answer was spoken.
- **Voice Match and short answers**: with Voice Match on, half a second of your voice after “Ember” is enough to
  recognise you, and a shorter yes counts for the questions of a task you asked for in your recognised voice, within 10
  minutes (never a command card, a consent card or another task's question).
- **What your speakers play doesn't say yes.** On Linux (with PulseAudio's parec), a video's or a call's “Okay.” or
  “Ember, allow” from the computer's own speakers no longer answers a question; on Windows the moment after Ember's
  read-out is covered too. A no is taken from anyone, over other sound too. In the few seconds after a question, talk
  without Ember's name is never sent to Copilot.
- **Allow works on web pages**: an Allow for a step on a page that changes by itself (a video playing) goes ahead when
  the page didn't change while you decided, and a step that needs no question checks only the control itself, so Ember
  clicks videos on YouTube again; risky steps and anything in a dialog are bound as tightly as before. A link whose
  title merely holds a risky word (“Post Malone”) no longer asks as a risky step; a link that says it does one still
  asks. When Ember asks again because the page changed while you decided, it says why, and where it can't use your mouse
  and keyboard (a Wayland session, a secure desktop) it says so instead of asking first.
- **Questions you can read and answer.** **Open approval** opens the very question that is waiting, in a card you can
  reach with the keyboard; a click counts when you let go over the same, unchanged button. A question about a step you
  didn't ask for quotes your own words, never the model's rewording. Screen readers hear why an Allow didn't count
  (pressed too soon, or after the question moved on), and every command tagged “Risky step” gets the caution edge and a
  plain Allow.

### The vault

- **Autopilot can fill in a login, a card or contact details without the AI model seeing them.** When a sign-in, a
  payment or an order form needs one, Ember asks you once in its own **Secure Form** window, keeps what you give it
  locked with your computer's keyring, and fills the field itself. The AI model only names the field and the part it
  needs (“the password”): it never types, sees or reads the value, and nothing Ember reads, sends, logs or photographs
  afterwards is meant to hold it (the value is hidden in the forms Ember knows, and a filled field, and a line that
  repeats a filled user name, is blacked out in screenshots). Each entry is for one app or one site and is filled only
  there (the site, a Chrome or Electron page's address included, is checked as Ember fills, and a frame from another
  site refuses). Only Autopilot fills, and never in your computer's own password prompts (the keyring's, `sudo`,
  polkit), in Ember's windows, in your terminals or in a window on the never-look list.
- **You can see and forget everything it keeps.** Settings › **Apps & privacy** lists each login, card and set of
  contact details by app or site and date, never a value, with **Forget** and **Forget all**; **Sign out** and **Forget
  everything** forget them too. Nothing is kept on a computer without a working keyring: the form says so, once for a
  task rather than for each field, and Ember tells you what is left for you to fill in. Closing the form without saving
  is your no, as **Not now** is: Ember won't ask for it again in that task. Once Ember has filled something it calls no
  extension until you start it again, and Home says so.

### Voice

- **The microphone note names who gets your words**: your own model provider or your organisation's model service (by
  host) when that is what answers, not always Copilot.
- **A request said without Ember's name while other sound plays** (a follow-up, or the words after “Hey Ember” and a
  pause) is heard, but never counts as your own words for a dangerous command. Everyday Italian emails that open with a
  greeting are read in the Italian voice.
- **Call Ember by its name**: “Ember, open my calendar” (“Hey Ember” and “OK Ember” work too), heard far more often than
  in 0.1.0. The name inside another word (“remember”, “September”), or talk that only sounds like it, sends nothing.
  While Ember speaks, “Hey Ember” makes it stop and listen.
- **Ember keeps listening.** Once you've called it, just keep talking: no name and no limit on turns, also while it
  speaks and its tasks work, until you say “That's all” or 30 seconds after everything has gone quiet. **Keep listening
  after I call Ember** under Voice turns it off; then you can go on without the name for up to three requests in a row,
  with 12 seconds to reply to a spoken question.
- **Cut in whenever you like.** Ember's voice drops the moment it hears you, stops once it's sure the words aren't its
  own, and answers what you just said with the rest in mind. A running task carries on, and what you said reaches it if
  it changes the task. “Yeah” and “mm-hmm” don't interrupt.
- **Talk over a song.** With a song or a video playing, Ember hears what is said to it by name, and without its name
  once it knows your voice (Voice Match), so it doesn't take the words it plays for requests (Windows, and Linux with
  `parec`).
- **Better speech recognition**: Moonshine v2 base, where 0.1.0 had Moonshine tiny. **Hear me more clearly** (Settings ›
  Voice) downloads a bigger speech model (482 MB) that makes about half as many mistakes, above all with an accent or
  across a room; it takes about 0.2 s longer a request and 550 MB more memory, and runs on your computer like everything
  else Ember hears.
- **Pause to think mid-request.** After a word such as “the” or “and”, Ember waits 0.9 seconds more for the rest: “And
  make the text a… bit bigger” is one request. Quieter talk from someone else that follows isn't joined to it.
- **Listen once hears a long request to its end**: speech must start within 8 seconds, and what you are still saying is
  heard up to 20 seconds from the press. When only a TV or someone else is talking it sends nothing (“No request heard.
  Try again.”, or at 12 seconds “I heard talking but couldn't tell it was a request…”). A screen reader's announcement
  is left out of your request, a muted microphone is named, and a press while Ember talks stops it first. Without the
  speech models Ask offers “Set up voice in Settings…”, where your organisation turned voice off it leaves Listen once
  out, and a question that comes up during it ends it.
- **Ember speaks in its own voice**, Kitten Nano 0.8 (its voice files are 63.8 MB), made on this computer sentence by
  sentence while the model is still writing. Should it be missing, fail or be too slow, the system's most natural voice
  speaks (a Natural voice on Windows 11, a Premium or Enhanced one on a Mac), Settings › Voice says so with **Try
  again**, and after a busy moment Ember tries Kitten Nano again by itself, once, a few minutes later. On Windows and
  macOS, **Voice** also offers **Supertonic** (129 MB), more natural and fast enough where Kokoro isn't, and Kokoro (350
  MB), for a fast enough computer; each is downloaded only once you choose it.
- **Ember speaks out loud by default** now; 0.1.0 spoke only while a screen reader ran. Choose Always, When a screen
  reader runs or Never in **Speak replies, questions and results out loud** (Settings › **Voice**; an organisation that
  turns speaking off shows it as Never, managed); Never stops Ember mid-sentence. **Stop speaking** in the handle's menu
  silences Ember without stopping its tasks or its answer. Settings › Voice sets how fast Ember speaks, and **Hear
  Ember** plays a sample and says which voice spoke.
- **Native speech on every computer**: listening and Ember's voice run on sherpa-onnx's native build, about three times
  faster to hear a request than on WebAssembly: its native addon on Windows and macOS, and in the RPM and the AppImage
  its own libraries (sherpa-onnx and ONNX Runtime, 32 MB installed). Nothing more is downloaded. Where they can't run,
  listening runs on WebAssembly and replies use the system's voice; `ember doctor` says which under **Speech**.
- **Ember starts talking sooner**: a long first sentence starts in about half a second instead of two, at a natural
  break; its voice loads as you open the Ask box or send a request; and a reply you cut off doesn't start again from
  late pieces of it.
- **Ember reads as people speak.** Numbered steps and lists are said one by one, and money, times, ranges, paths and
  arrows as people say them (“$12.50” is “12 dollars 50”, a file is “report.pdf in Documents”, “Win+←” is “Windows key
  left arrow”); emoji aren't read out by their names. “Read it out” and “say that again” say the last thing Ember said,
  once.
- **Replies in other languages** are said by a system voice for that language, or not at all, instead of with English
  sounds, while an English answer that names a film or a place from another language (“La La Land”) stays in Ember's
  voice; an email read out in another language keeps its From, To and Subject lines in Ember's voice.
- **Voice Match**: Settings › **Voice** › **Only my voice can say yes (Voice Match)** teaches Ember your voice from four
  short phrases. It decides only whose voice may answer Ember's questions, never who Ember hears, and “Ember, stop”
  works for anyone, also while you teach it; teaching ends on Stop everything, 45 seconds with no phrase, 3 minutes in
  all or a microphone that stops working, Settings says how it ended, and it is refused while the microphone isn't
  working. With a screen reader on speakers, Ember learns your voice, not the screen reader's. Your voiceprint (256
  numbers that can't be turned back into speech) stays on this computer, in `voiceprint.json` in Ember's data folder,
  readable by you alone; **Forget my voice** deletes it, the words Ember learnt too.
- **Keep learning my voice** (Settings › **Voice**, on once Voice Match knows you): Voice Match follows your voice
  slowly, from requests it is sure are yours, so a new microphone or a cold doesn't wear it down. It never learns from
  its own voice, a request with another voice in it, an answer to a question, or for two minutes after it turned someone
  away; it takes at most one request a minute, stays close to what you taught it, and asks a little more of a request as
  it learns, so other voices get in less often, not more ([docs/ASSISTANT.md](docs/ASSISTANT.md) §7). A spoken “allow”
  still has to match the voice you taught it. **Reset to my enrolment** goes back. It keeps numbers, never audio.
- **Ember hears names better**: what it hears is checked against your installed apps and, with Memory on, the names you
  asked it to remember (“Open Spotfy” → “Open Spotify”). **That's not what I said** under a request lets you type what
  you said, and with **Learn my words** on it hears it right from then on (listed in Settings › Voice with Forget). A
  request about sending, deleting, paying or contacting someone is never changed but for Ember's name, a person's name
  from Memory is only used in a request that looks something up (“find Sandra”), and a swap of numbers is never learnt.
- **Suggest what I might say next**: two or three likely next requests (“Close it”, “Read it out”) under Ember's answers
  and in Ask Ember, marked as Ember's suggestions, made on this computer, and offered only while what they answer shows.
  Choosing one asks Ember as typing it would, but a command it names always asks first; nothing risky is suggested
  unless built from what you just asked.
- **Listening lines don't talk over you.** While Ember's microphone is open for a request, its listening lines change
  without telling a screen reader, and use no “Ember”, so said through your speakers they neither wake Ember nor become
  your request. Settings names the microphone Ember hears through.
- **Speech-model downloads** have **Cancel download**, and one that fails says why in plain words, never as the raw
  error.

### Memory

- **Ember can remember you** (Settings › **Memory** › **Remember what I tell you**, off until you turn it on and agree
  to its note): what you tell it about yourself, your work and how you like things done stays on this computer, tied to
  your verified GitHub account, and you can review and forget each fact.
- **Ember learns on its own** while memory is on: after you talk and when a task finishes, it picks out what's worth
  keeping (your preferences, your work, the people and apps in it), tidies its memory while you're away, and at most
  once a day asks about a name it keeps finding nothing on (**Ask me questions now and then** turns that off; it
  doesn't ask who an app, a site or a place is). Only what you say yourself counts as yours; what it reads on screen
  or in a task's result never does, nor speech it can't tell from its own speakers, and it never learns an instruction
  or a one-off order as a preference, nor a password said as what an account is or a wallet's seed words. A new fact
  shows in the conversation as “Ember learned: …” with **Undo** (which puts back what it replaced); “Ember, forget
  that” works too. The list says where each fact came from.
- **What memory sends, and when it pauses.** Memory's note says what goes to Copilot with every request (what you asked
  Ember to call you, how you like answers and a few facts that bear on the request), and that while you're away its
  tidying sends up to 40 saved facts to Copilot up to 6 times a day. Learning uses at most 12 short requests of its own
  an hour and 60 a day, plus 6 a day while you're away. While a changed note waits for your yes, Ember remembers nothing
  more (Home says “Memory paused”). Settings › Memory says why memory is paused, and when your saved memory couldn't be
  read (a locked file is tried again and never saved over; a broken one is set aside as `memory.json.broken`) or
  couldn't be saved, and meanwhile nothing new is kept.
- **Tell Ember about you**: what to call you, your role and work, the apps you use most, how you like answers, your
  timezone or hours, each optional, in Settings › Memory and in first run, or say “Ember, get to know me”. Your name and
  answer style go with every request, and **Spoken replies** there changes whether Ember speaks.
- **Memory refuses passwords, PINs and lock codes in the ways people say them,** in any word order: a clause that names
  a password, passcode, PIN, `pw` or “pass word” (in French, Spanish, German and Portuguese too) is refused when it
  holds a word that isn't grammar, a service's name or a number (“The password I use is sunshine”, “I changed my PIN to
  4821”), so “Works at Globex and forgot their password” is refused too. So are a login said as one, a phone, house,
  alarm or storage code, a Wi-Fi password under any of its names, a security answer, a CVV, a recovery, seed, one-time
  or verification code, a social security or National Insurance number, an IBAN, a sort code with its account number, a
  mother's maiden name, a password written as a value in code (`PASSWORD=hunter2`) or after its state (“Password:
  hashed, SHA-256, Summer2024!”), card numbers, and a secret said with a verb or shaped like a password. A user name
  with a digit said as a login is refused, as it may be the password. Kept: codes that lock nothing (“backup exit code
  255”, a ZIP code), how a token is made, a password's or key's state or where to find it, a user at a host
  (“pi@192.168.1.20”), a sort key, a primary key and code that names a token with code for its value (`max_tokens=256`).
  Still kept, so don't tell them to Ember: see Known issues and limits.
- **Passwords in code, settings and forms are held back in more of the ways a file holds them,** in memory, Projects and
  task views: a value under a key named for a secret (in YAML, JSON, a Ruby, PHP or Python hash, a dotted setting,
  `define('DB_PASSWORD', '…')` or `<password>…</password>`), a password a form or table puts below its label, and one
  given to a program on its command line. Projects still sends login forms, UI text (“Forgot your password?”) and locale
  files.
- **Forgetting holds.** The list offers Undo for a minute after a Forget, also while memory is off. A Forget, a
  correction and Forget everything drop what was said before them and not yet read, and for the rest of that
  conversation Ember's own replies, a task's result or the remember tool can't bring the fact back; your own words can.
  Forgetting a fact forgets Ember's summaries and guesses made from it, and forgetting what holds now doesn't bring back
  the old value. Signing out or Forget everything also clears the suggestions drawn from earlier requests and the Ask
  box's ↑ history; after another GitHub account signs in, the new conversation says Ember forgot the previous account's
  memory.
- **A change of mind replaces the old memory**: “Doesn't like Teams any more” replaces “Likes Teams”, and “I go by Raj”
  or “Keep it brief” what Ember knew; “Prefers dark chocolate” leaves “Prefers dark mode” alone, and “Shorter, please”
  beside a request doesn't change the answer length you set. **Settings › Memory lists what is no longer true** after
  what holds now, each with its own Forget.
- **Requests that start with “forget”, “remember” or “keep in mind” reach Ember while memory is off**, and Ember says
  memory is off (or why it is paused), with **Open Memory**. “What do you remember about me?” says how many facts there
  are beside the six it gives, and “I agree, remember” ignores a press in its first half second. In conversation Ember
  forgets only when you ask, names what went (“Ember forgot: …”) and offers Undo.
- **Settings › Memory** has search, a filter by where each fact came from and pages; only Forget is red. With 5,000
  memories, Ember finds what bears on a request in about 20 ms instead of 100 to 135 ms, and a reconnect keeps a
  correction you were typing.
- **Better recall** (Settings › **Memory**, shown while memory is on): Ember finds what you told it when you ask in
  other words (“Who is my manager?” finds “Priya leads the platform team”). **Download (23 MB)** fetches a small
  language model (all-MiniLM-L6-v2) from Hugging Face, checked against its pinned SHA-256; nothing is fetched until you
  click it, and turning memory off cancels a download under way. It runs only on this computer, in a process of its own
  that ends after 5 idle minutes. With a request, at most one fact more goes to Copilot by meaning alone. On 80
  questions asked in other words it found the right fact first 83% of the time, against 9% by words alone. What it makes
  of each fact is kept beside what Ember remembers, readable by you alone, and goes when you forget the fact, **Forget
  everything**, sign out or click **Remove**. Without the model, or if it is slow, memory works as it did.

### Your own model provider

- **Use my own model provider** (Settings › **Models & connections**, off by default): Ember can use a model service of
  yours instead of GitHub Copilot: OpenAI-compatible, Azure OpenAI or Anthropic, at an `https://` address, or a model
  server on this computer (Ollama, LM Studio) at `http://localhost`. It first shows a card naming the service's address
  and what goes there, screenshots for tasks included, and uses it only once you agree (and again for another address);
  while its switch is on and its card isn't agreed, Ember connects to nothing, Copilot included. Until you agree, Models
  & connections, the Ask box and Home's composer point to the card. Your yes is sealed with the keyring (without one it
  lasts until Ember quits), so editing settings.json can't give it, and a provider coming into force is recorded in What
  Ember did.
- **Test connection** checks the address and the key in one request and names the models it lists (“It lists 1 model:
  llama3.2:3b.”), which both model fields then suggest; it doesn't say “Connected” to a web page, and a 404 that names
  no model says the address may be wrong. A provider at a remote address reads “Using” and its address, and says when no
  API key is saved for it.
- **Changing the address keeps the provider you use until you agree to the new one** (“Ember still uses api.example.com.
  Agree to use new.example.com to switch.”); **I agree, use this provider** checks the new address first, and if it
  can't be reached or refuses the key nothing changes. A gateway that answers 404, or with something that isn't a model
  list, changes nothing either, unless you choose **Use it as typed**. Requests never go to Copilot in between.
- **A switch of model service waits for what Ember is doing, then happens at once**: when the answer ends, you press
  Stop or the last task finishes (“Switching model service…”); a new conversation starts on the other service, and what
  Ember remembers stays. A finished task's **Try again** on the new service starts from your own words, never screen
  text from before; where it can't, the card says “The model service has changed: ask me again and I'll try it on the
  new one.”
- **Your own model server not running? Ember says so** (“Is it running? Start it, then ask again.”), the handle says
  “Can't connect”, and Ember connects once you start it. **Check again** connects to your own provider or your
  organisation's again, never telling you to sign in to GitHub, and messages about a service that isn't answering name
  the one in use, never Copilot.
- **The API key** is kept encrypted by the system's keyring, apart from the settings, never shown again, logged or
  recorded, and goes only to that service. Where the keyring would keep it as plain text, Ember refuses and says why,
  and the key row says how to get a keyring (GNOME Keyring or KWallet). **Remove** and **Sign out** delete it. `ember
  doctor` names the service by its address only.

### Extensions

- **Extensions from marketplaces** (Settings › Extensions): add a marketplace (a GitHub repository or an https address),
  browse it, and add a plugin; its tools join the conversation between turns, with no restart. Only you add, turn off or
  remove one, and only an extension's own card agrees to it. Ember loads only a plugin's MCP servers, never its hooks,
  agents, skills or rules. A marketplace Ember couldn't fetch says so, with **Browse again**.
- **Ember decides every call**: a read-only tool from an extension you agreed to runs and is recorded in What Ember did;
  anything that changes or sends something asks you every time, with no “Always” (Autopilot goes ahead and says so, as
  the cards say). After “Not now” Ember doesn't try again. Tools that reach the wider internet, and every tool of an
  extension on a server elsewhere, ask each time. The review card shows each tool's input words (hidden characters
  written out), and a call's arguments over 200 characters are shown whole before Allow works.
- **Results are information, never instructions**: a result, or a failed call's message, that reads as instructions to
  an AI, hides characters or looks like Ember's own markup makes every later call ask; an ordinary failure (a 404, a
  timeout) doesn't. A failed call's text reaches the model only inside Ember's untrusted tag. In Assisted, a call that
  would ask goes to its check first (above). A question nobody answered isn't a no.
- **Only the extensions you agreed to start.** Ember seals its list of extensions with your computer's keyring, and one
  it didn't write there (a list pasted into its folder) stays off until you review and agree to it again. **When you
  first start this version, each extension you added before asks you to agree once more.**
- **Changed tools stop**: Ember remembers each tool as you agreed to it, and compares it as a conversation loads and
  when its server says its list changed; a changed one never reaches the model, is marked “Changed since you agreed”
  with **Review tools**, and a server that says so twice sits out the rest of the conversation.
- **Ember's own files stay out of reach**: an agreed extension's call that reaches Ember's data folder, or changes the
  folder that holds it, is refused in every mode; one that may reach Ember's files asks, saying why, and Autopilot
  refuses it.
- **Its own environment**: an extension's program on this computer gets only what any app Ember starts gets, never your
  GitHub sign-in or keys. Remote extension servers go through Ember's launcher, which follows no redirect, so a plugin's
  key never goes to another address. Stop everything ends every extension program too. A plugin whose server can't start
  isn't added, and says why.

### Tasks

- **A question that ran out of time while you were away** keeps its task's card, marked “No answer in time”, with **Try
  again** there and in Task activity, and notifies you; it is called “no answer in time”, never “stopped”. A card that
  didn't finish waits while you're away and gets its whole time once you're back.
- **Saying or typing “try again” after a task that didn't finish** does what its card's Try again does, within ten
  minutes or while the card offers it, asking for the same request in your words. A task near its step or time limit is
  told to wrap up, and says what it had done if a limit stops it.
- **A refused step says why on its task's card and in Task activity**, in Ember's own words (“Not allowed: Ember's
  accessibility helper isn't working”, “Not allowed: this is a Wayland session”), with refusals for one reason folded
  into one row (“Not allowed 6 times: …”). A task whose only step you turned down no longer ends “Done”, and one stopped
  by a policy change or a screen lock isn't told as stopped by you.
- **At the actions-a-minute limit a task pauses** (“Pausing to keep to 40 steps a minute…”) instead of ending with a
  refusal. The limit counts all tasks together.
- **A third task says it waits its turn** (“Waiting its turn”) instead of “On it”, outcomes are worded as the card says
  them (“didn't finish”, not “failed”), and when the accessibility helper can't read apps at all Ember says it isn't
  working and that the setup check says why.
- **Typing “stop” while a task is at work stops everything at once,** in the Ask box or in Home, and so do “stop
  typing”, “abort” and “no, stop”; Home keeps your “stop” with Ember's “Okay, I've stopped everything.” Stop and a
  task's time limit work even when a task hangs as it starts, and nothing left over starts after a stop.
- **A task's question no longer cuts off an answer Ember was giving**: it goes on in the bubble and Home, unspoken while
  the question is up.
- **Task cards' buttons work** on a click that lasted longer than a moment, and reading a task's details, or More time,
  keeps the card up longer.
- **Ember opens and uses more apps properly**: store apps such as ChatGPT and WhatsApp open; two requests to turn the
  same check box on no longer turn it off again; on Linux Ember knows newer accessibility releases' buttons, and on
  Windows it no longer misses a window brought up while it lists them.

### Safety and privacy

- **While a password prompt is open,** GNOME Shell's own or, on Linux, a program that is only a prompt (pinentry, SSH's
  askpass, a polkit agent, GNOME's keyring prompter), focused or not, Ember reads nothing, sends no window text or
  titles, and takes no step in any app until it closes; it does the same, and says so, while it can't tell whether one
  is open, and a step done without asking is said and recorded only once the check right before it has passed. On a Mac
  this check works before you give Ember the Accessibility permission. While another window that asks for a password has
  the keyboard, Ember doesn't borrow your mouse and keyboard.
- **A request carries only the window you're in.** The titles of your other windows go only when Ember looks over your
  screen for you, as when you ask what's open.
- **Send screenshots for tasks** (Settings › Apps & privacy, on by default) keeps tasks to the accessibility text when
  you turn it off, from a running task's next look. Every screenshot a task sends is recorded, by app and size, in What
  Ember did and on the task's card.
- **Apps & privacy shows “What Ember reads, sends and keeps”,** the text you agreed to, following your settings, your
  mode and your organisation's policy; Search finds it by words such as data, screenshot and audit.
- **More steps ask.** Controls that grant access, bid, book, bet, sell, refund, change who can see something, add a
  member or turn a protection off ask every time, as do “Activate now”, “Start free trial” and “Upgrade now”, a page's
  button with no name at all, and any button of a checkout, payment or billing page. In Interactive, Enter in a page's
  own address field, or in a search box on a payment page, asks. Ember never types into card-detail, cardholder or
  pass-phrase fields.
- **Going past a warning is a risky step.** “Enable Macros”, “Keep anyway”, “Proceed to example.com (unsafe)”, “Turn off
  Safe Browsing” and their like ask by a click or by Enter, never with Always and in Interactive never only announced.
  In a dialog whose words ask (“Are you sure…?”), or a message box on Linux, an answer that doesn't back off is a risky
  step too (a browser's “Leave page”, “No” to saving your changes); Cancel, Stay and “Not now” don't. Enter in such a
  dialog asks while none of its buttons has the keyboard.
- **Ember's own files are guarded from other apps.** Typing the path of Ember's data or policy folder in one step, or a
  pattern that reaches it, is refused in every mode. Where Ember can't tell that a file isn't its own (settings.json,
  the audit log, the policy, the seals or the vault named in an editor's title with no folder, a folder titled “ember”
  or “audit”, a key that deletes, cuts or renames in the folder that holds Ember's), each step asks every time, never
  announced or checked, and Autopilot refuses it, so any project's settings.json in an editor asks at every step. The
  same holds in any app's list of files (an Open or Save dialog, a file manager Ember has no row for) for deleting,
  moving or renaming the folder that holds Ember's data (.config, AppData, Local, Library), and in Ember's own
  extensions and logs folders, known by what they show; a row named Local or Library in a spreadsheet or a music app
  goes as before.
- **KDE's, LXQt's and GTK's own sudo prompts** (kdesu, lxqt-sudo, gksu and their kin) count as password prompts.
- **A vault file Ember can't read is never written over.** One it can't make sense of is kept aside beside it; one it
  only failed to read is left where it is, and Ember keeps nothing new until it can. Settings says which, and **Forget
  all** removes the kept copies.
- **More keys are hidden** from command output and logs: OpenAI, Anthropic, Stripe, Hugging Face, GitLab, SendGrid,
  DigitalOcean and Twilio keys, webhook addresses, a Docker config's `auth`, a .netrc password, and a password given to
  a program on its command line (`mysql -p…`, `curl -u user:…`, `sshpass -p …`); a bare `-p` that prompts is left alone.
  Logs hide the value after any `Authorization:` scheme, and the audit log records a typed key as a count.
- **Linux's default never-look list gains KeePass, LastPass, Dashlane, Enpass, Proton Pass, KDE Wallet and GNOME
  Secrets**, and the Mac's Proton Pass, NordPass and RoboForm (new installs, and **Restore defaults**). On Windows,
  Ember knows the saved-credentials dialog by both its spellings, and won't type a program into Explorer's address
  bar.

### Commands, WSL and other computers

- **A program Ember doesn't know runs, and Ember tells you its name** with a few seconds to stop it, in every mode, as
  does a tool's command or option it doesn't know (`cargo watch`), unless your words for the task say not to run it.
  Not knowing a program isn't danger: what its own name and words say it does (`dropdb`, `deploy`, `--daemon`, a
  password manager) is judged as that danger, and a dangerous command it hands on (`mytool mkfs /dev/sdb`) asks as that
  command does.
- **Commands that would type or run commands in your own terminal or editor are refused** (tmux's `send-keys`, `screen
  -X`, kitty's and wezterm's `send-text`, an editor's `--remote-send`, Terminal's `do script` and their like, however
  the verb is shortened or wrapped); what only prints what a terminal shows asks as a secret.
- **What a helper runs is judged as the command it runs**: a command handed on to a program (as a quoted word, after
  `--exec`, `-x` or `--`), what `npm`, `yarn`, `pnpm` or `bun` runs by a script's name, what `node`, `npx`, `python3
  -m`, `xargs` (batch by batch), `kubectl exec` or `gcloud compute ssh --command` runs, and a variable that names the
  program a build tool runs (`CC='sh -c "curl …|sh"' make`). What `cross-env`, `dotenv` and their like run is judged as
  that command (`cross-env FOO=1 printenv` reads secrets), and `brew services start` and `npm config set` count as
  outliving Stop.
- **Passwords in config files are kept from the AI model**: mail, WordPress and PHP, XML, Redis, LDAP, Wi-Fi,
  NetworkManager, Subversion, SMB, sbt, Ivy, getmail and neomutt settings and their like are secret files, and the
  passwords they hold are hidden from command output.
- **Commands that read or print secrets ask** in Interactive (in Autopilot they run with their output kept from the AI
  model): a variable named like a secret handed to a program (`curl
  -H "Authorization: Bearer $GITHUB_TOKEN"`) and commands that print an environment or a secret (`ps` with environment
  output, `docker inspect`, `git show :.env`, `grep -r token .`, `heroku config`, `vercel env pull`, `gcloud secrets
  versions access`).
- **A database change given on a client's input asks** as one on its command line does (`redis-cli <<< FLUSHALL`, `psql
  app < drop_users.sql`); a SQL file a client runs is read before it runs, so a `psql -f schema.sql` with a `CREATE`
  asks as `psql -c` does, and text another command prints into psql, mysql, sqlite3 or duckdb always asks.
- **What a download brings in asks.** Running a file the task downloaded asks, also once it is renamed, copied, unpacked
  or compiled, or picked up as a Makefile, test file or `package.json` (“Runs a file downloaded in this task.”), as do a
  download whose saved name Ember can't tell and, afterwards, a build tool or test runner in the folder it saved into
  (anywhere, when Ember can't tell the folder). A downloaded patch, or code pulled from an address, marks the files it
  changes.
- **A download or a conversion over a file that is already there asks** (`aws s3 cp`, `rclone copyto`, `gh release
  download --clobber`, `pandoc -o`, `magick`, `qpdf` and more), as does one written over its own input; a fresh output
  runs.
- **A file's contents sent inside a name ask**: an image, registry or package name, or an address in an option, that
  carries a file's text (`docker pull x.io/$(cat notes.txt)`), also through a variable.
- **Opening your files to other accounts asks** (`chmod o+w`, any group or other bits on your home folder, `setfacl`,
  `icacls /grant`, `cacls`, `net usershare add`).
- **Read-only and add-on commands run, announced**: Cloud Run reads, Kubernetes and Helm dry runs, `kubectl set env
  --list`, a bare `mount`, `swapon --show`, `losetup -a`, and docker add-ons and kubectl plug-ins whose words are
  ordinary; a plug-in's or add-on's dangerous words ask. A countdown for a command you didn't ask for is headed “About
  to run this”.
- **rimraf, del-cli and other deleters ask or are refused as rm is** (`rimraf ~` is refused, `rimraf src` asks).
- **Ember refuses a command that reaches its own settings and records through a variable**, as it does when they are
  named (`d=~/.config/ember; rm -rf "$d"`, `${XDG_CONFIG_HOME:-$HOME/.config}/ember`, PowerShell's
  `$env:LOCALAPPDATA\ember`), or works in its folder; one that only tests or prints such a variable runs, and a value
  Ember can't see at all asks.
- **A flag doesn't hide what a command does.** Ember reads the options of the tools it knows as their manuals give them,
  so `rsync --mkpath`, `shred -u`, `mvn -X deploy` and many more ask, or are refused on Ember's own files, as they are
  without the flag; where the manual and Ember's earlier reading disagree, the stricter verdict stands (`sudo -h host rm
  -rf ~` is refused).
- **Loops and `if`.** A bash or sh loop (`for`, `while`, `until`) is code Ember can't read: it asks first in
  Interactive, goes to Assisted's check, and runs announced in Autopilot. An ordinary `if` runs without a
  question when Ember has nothing to say about any command in it and it has no `!`, sets no variable and changes no
  folder (`if [ -f package.json ]; then npm test; fi`); any other `if` asks as a whole, here and on an SSH computer.
  Below Autopilot neither starts with only the 4-second Stop.
- **Your no is read as you say it**: “don't push”, “you mustn't publish”, “pushing is not allowed”, “leave the remote
  alone” and a no split from its verb by commas rule a command out (Autopilot refuses it), while “no problem, just push
  it” stays a request.
- **Only what you asked for in so many words starts with the 4-second Stop.** One whose object your words keep, leave
  out, place elsewhere or only describe (“delete everything but build/”) asks with its card, as does a dangerous step
  your words make conditional or put off (“only after I confirm”, “tomorrow”) or ask to be asked about first. A command
  you asked for exactly no longer says “You didn't ask for this.”; one your words name but not exactly says “Your words
  don't name exactly this, so Ember checks first.”
- **Command questions say what really happens**: “the current folder” instead of “.”, “Deletes everything in the current
  folder.” for `rm -rf *`, folders in your home folder from ~, “Deletes your scheduled jobs.” for `crontab -r`. Copying
  or moving a file into a folder asks only when a file of that name is already there, and names it; a copy that doesn't
  land at that name (`rsync -R`) says “Replaces files in ~/Documents if they exist.” and asks whenever the folder is
  there.
- **`tailscale` is classified**: `funnel`, `serve` and `file cp` ask as publishing; `up`, `down`, `set`, `login`,
  `logout` and `ssh` as system changes. Ember runs a Python virtual environment's programs by path (`.venv/bin/python -m
  pytest`) instead of sourcing `activate`, which asked every time.
- **Where commands run as root or an administrator,** every command is dangerous: it asks in Interactive, where
  Settings shows **Ask me before every command** on and locked, saying so; in Assisted the check may clear one your
  request was about (the commands card says so and is agreed again), also on a computer reached over SSH, and in
  Autopilot each command runs after a few seconds to stop it; in both the switch is yours, and turning it on makes every
  command ask.
- **A WSL command's output is never taken as whole without its end.** Each WSL run now ends with a mark of its own. When
  that mark doesn't come back (wsl.exe can lose the last of a long output), Ember ends whatever it finds the run left
  running, as Stop does, and the command window and the AI model are told that the command may not have finished and
  the output is incomplete (“Ran for 3.2 s, but Ember didn't get its end…”), with WSL's own exit code where it gave one.
  Where nothing was left running, the command did end: Ember says so, and that the end of its output was lost, so the
  model doesn't run it again only to see the rest.
- **A command on another computer can't hide its real exit code or signal** behind what it prints.
- **Stop answers at the end of a run that kept much output**: hiding secrets in up to 4 MiB of output runs in small
  steps, so Stop is answered within about 220 ms where it waited 1.2 to 1.9 s, and a stopped run hands the model
  nothing.
- **The command window**: the first command after Ember starts fits it (90 columns by 12 rows at the default text size),
  closing it while a command runs makes **Keep it open** the highlighted choice, very short runs say “less than 0.1 s”,
  and screen readers hear its “Starting Ubuntu…” line and a command card's hint.
- **SSH computers**: on RHEL 8's OpenSSH a sign-in question reads “A question while connecting to build-01” and says
  Ember never keeps the answer, and a long one (a two-factor menu) opens in a card that grows to fit. A computer whose
  name Ember can't find isn't left in Computers, unless only the network is down. While a first-use card waits, Settings
  says “Ember asks first: answer in the window that opens.”
- [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md) lists what asks, what is refused and why, with spellings that
  work.

### Ask and the companion

- **The Ask box opens beside the answer or question Ember is showing** instead of covering it, never on Ember or the
  task cards, and an answer on screen stays where it is. It has a Send button and controls that grow with the text size.
  On Linux a click beside the box reaches the app underneath and closes it.
- **On Windows the Ask box stays open while Ember reads the app it opened over.** Reading a plain text box (one line or
  several, as in Notepad) handed that app the foreground about a second after the box opened, and the box closed by
  itself; Ember now reads such a box's caret and selection from the control.
- **The Ask box says when Ember can't answer yet** (“Not connected: I can't answer yet”) before you type, naming the
  service in use (“Provider problem”), and while Ember reconnects the handle and Home say “Reconnecting…”. **Esc** while
  an input method is composing a word cancels the word, not the box.
- **A screen reader hears what Ember did without asking** (“Ember says: …”, once), a borrowed mouse included. A
  background task's announcements and its waiting line reach the bubble too, behind everything else, and its countdown
  and Stop leave the bubble once its command starts.
- **While a slow answer is on its way,** the bubble names the service in use (“Still waiting for your model provider…”),
  and screen readers hear it with the keyboard's ways to stop. A failed reply's Try again stays up for its full 12
  seconds, and after the connection stops mid-request the bubble says “I'm connected again” once it is back.
- **Without a compositor, the corner card grows** for any question at Large and Larger text, and its Allow waits until
  you can read it all; it shows keys as keycaps, and screen readers hear every question on it and when a task ends.
- **Until first run is finished, the handle says “Finish setting up”,** and its menu starts with a way back to setup.
- **Ember's desk can show you the text of an app on it** when you ask (Linux), to read only, with private fields left
  out, and only while you have agreed, the screen is unlocked and it is the same desk.

### Reliability

- **Ember notices at once when Copilot stops mid-answer** (within about 3 seconds instead of up to 20) and reconnects; a
  Copilot that never answers no longer leaves Ember “Connecting…” for good, and a failed GitHub account lookup is tried
  three times before the conversation is ended.
- **Ember uses less of the processor while it rests beside your cursor**: on a computer without a GPU, with listening
  off, about 6–7 % of a core where it used 11–15 %. Listening for “Ember” in silence with Home open, as the Linux
  packages listen, it measured about 11–15 % of a core awake and about 6 % once dozing, and about 700–790 MB in all
  (900–950 MB with WebAssembly listening), not counting the Copilot runtime, about 100 MB more.
- **A crashing accessibility helper no longer spins a processor core** (Ember waits up to a minute between tries), and
  on Linux hanging accessibility bindings no longer make Home or the stop shortcut wait; bindings installed while Ember
  runs (`sudo dnf install python3-pyatspi`) are found without a restart.
- **Ember no longer holds a processor core when whatever reads its printed log goes away** (`| head` or a closed
  terminal, with `EMBER_LOG_STDOUT=1`).
- **On Windows, the setup check's Screen reading row keeps up with the accessibility helper**, and says in plain words
  why it didn't start, never .NET exception names or paths.
- **Your work survives a quit.** Quitting keeps an answer you had read, and ending the desktop session (log-off,
  shutdown) keeps it and the conversation's save; logging out of GNOME on Xorg counts as a quit, and the log records an
  unexpected close.
- **Problems with Ember's files are said plainly**: an unreadable settings.json (every setting back to its default, with
  where your version is saved), a full disk (“I couldn't save this conversation: the disk (or your storage quota) is
  full…”), something in Ember's data folder that keeps it from starting, and used-up watched files and folders
  (`fs.inotify.max_user_watches`, with a setup check row).
- **About this build shows where the log file is** (Setup & about), with **Copy** and **Show in Files**, and the
  troubleshooting guide says what to do when Ember is slow and what to share in a report.

### Install, updates and docs

- **Tell me when a new version is out** (Updates, off by default): with its note agreed to, Ember asks GitHub once a
  day, also across restarts, and tells you once per version. It sends no sign-in and never downloads or installs
  anything. Clicking the notice opens Updates, which says how to update your kind of install (the RPM, the AppImage, the
  Windows zip, the Mac's dmg or the npm launcher), with the new version's file named in each command (for the RPM, `sudo
  dnf upgrade ./ember-0.1.2-1.el8.x86_64.rpm`), and **See what's new…**.
- **The npm launcher says in plain words what stopped it, with a next step**: a version not on GitHub Releases yet, a
  proxy or host it can't reach, a full disk (free space or set `EMBER_NPM_CACHE`), a cache folder it can't write in, a
  web page sent in place of `SHA256SUMS` (a Wi-Fi or proxy sign-in), a download that doesn't match it, or a computer
  that won't let Ember start (fapolicyd, antivirus). Ctrl+C during the first download leaves nothing behind, and a
  stopped `ember --npm-reinstall` keeps the copy you had. `ember doctor` through it exits with the setup check's code.
  After an update it removes older versions from its cache once the new one has started, so **Start Ember when I log
  in** never points at a removed copy. Its README gives update and uninstall steps.
- **The README says what Ember needs before you download it** (a Copilot account or your own provider, GNOME on Xorg,
  about 1 GB of disk and 900 MB of memory, 1.1 GB where listening runs on WebAssembly), what its first start asks, the
  keys on each kind of computer, how to start and update the AppImage, that Kokoro and Supertonic are Windows and macOS
  voices, where Ember's log is, and, in “How Ember asks”, each approval mode, what every mode keeps and what your
  organisation can change.

### Known issues and limits

- **Memory still keeps some secrets said without a password's name**: “My Netflix is sunshine”, “HomeNet's key is
  BlueSky99”, a password alone in the next sentence (“Netflix password. sunshine”), a recovery phrase with no name Ember
  knows, a date of birth, and in a file or a task's view some shorthand (“The Wi-Fi is BlueSky99”, “The gym's code is
  4821”) and a password after “salted”, so keep passwords out of what you tell Ember and the files you give Projects. A
  few ordinary facts are refused (“The Wi-Fi is HomeNet5G”). Something you asked it to remember can still be learnt
  again from quite other words, or in part.
- **Memory's daily question** doesn't ask about a name from a request about health, money, law or faith, but a clinic's
  or a medicine's name put where a person's goes (“Email Planned Parenthood…”) can still be asked about, aloud.
- **Ember's own files**: the path of its data folder typed in parts over several steps isn't caught yet, nor a context
  menu's Move to Trash there, which Autopilot announces.
- **Steps that ask more than they should**: a headline link such as “Reserve Bank raises interest rates again”, a tab
  named “Email”, any control on a page whose title only mentions a payment (the question says why) and “Disable Line
  Numbers” in a window titled for security.
- **The vault**: a card's security code, and any secret under six characters, is kept by its field alone, so a page that
  repeats it elsewhere isn't hidden; a few rare forms of a saved detail (reversed, base64, a very long output's cut)
  aren't yet found.
- **A yes said as a question**: a one-word yes said as a question (“Okay?”) can still be taken as a yes, since what
  Ember hears rarely keeps the question mark; say “no” or “wait” if you aren't sure.
- **Spoken answers on Windows and macOS**: Ember can't tell who said its name over what the speakers play, and on macOS
  a conversation can't tell a song from you yet. A short Italian or Portuguese message after an English lead-in may not
  get its own voice.
- **The Windows Ask box**: fields with their own text providers (web pages, WPF, Word) are untested and may still take
  the foreground.
- **Commands**: `kubectl get deploy -o yaml` runs without asking (the secret-named values it prints are hidden), and
  output full of Azure Key Vault secret ids with a `"value"` among them can still hold Stop 1.6 to 2 s.
  `pkill -n server` and options Ember once read differently are refused or ask;
  [docs/COMMANDS-WSL-SSH.md](docs/COMMANDS-WSL-SSH.md) lists spellings that work.
- **Refusal reasons**: a Mac app with a very long name can make a task's “Not allowed” line too long to show whole.
- **Extensions, not yet**: connectors (GitHub-hosted services), Copilot `extension.mjs` extensions, extensions in tasks
  (only the conversation uses them), extension servers on macOS (an item added there says “Didn't start” and offers only
  Remove), and servers that need you to sign in to them.

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
- **Voice**: "Hey Ember", with speech recognition on this computer (the models download once, 126 MB, or come with
  the `ember-voice-models` RPM); only the text of a request goes to Copilot. Ember can speak its replies, questions
  and results with the system's voices: when a screen reader runs (the default), always or never (**Speak replies,
  questions and results out loud** in Settings › **Voice**; an organisation that turns speaking off shows it as Never,
  managed).
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
