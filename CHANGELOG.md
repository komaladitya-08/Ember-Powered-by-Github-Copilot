# Release notes

## 0.1.1 (2026-11-07)

Ember 0.1.1 is an unsigned beta, as 0.1.0 was: Windows (SmartScreen, Smart App Control) and macOS (Gatekeeper) stop
its first start, and [README.md](README.md) says what to do and how to install it on each computer. Checks by hand
with real microphones, speakers and screen readers, and on a real Mac and a real RHEL 8 desktop, are still to come;
the automated tests don't stand in for them.

### Getting it

- **On RHEL 8, the RPM carries the speech models** (about 220 MB: listening, Ember's voice and Voice Match), so
  nothing is downloaded when voice is turned on. It replaces 0.1.0's separate `ember-voice-models` RPM when you upgrade
  (`sudo dnf upgrade ./ember-0.1.1-1.el8.x86_64.rpm`).
- **The AppImage carries them too**, as the Windows zip and the Mac's dmg and zip do. It needs `fusermount` to start
  (`sudo dnf install fuse`); where you can't install that, `APPIMAGE_EXTRACT_AND_RUN=1` runs it unpacked.
- **`Ember-voice-models-0.1.1.zip`** holds the standard speech models, for IT to install once per computer for every
  copy of Ember (README's **Computers without internet access** says where they go).
- **The `ember-copilot` npm launcher is new**: with Node.js 18.17 or later, `npm i -g ember-copilot` and then `ember`
  download this version's Windows zip, macOS zip or Linux AppImage, check it against `SHA256SUMS` and start it.
- **The voice's source comes with each release**: `source-*.zip`, the checked source of sherpa-onnx, eSpeak NG and
  piper-phonemize, sits beside the packages, as GPL-3.0 section 6 asks for the voice's eSpeak NG. The Linux packages'
  native speech libraries (`/opt/ember/resources/voice-native`) come with sherpa-onnx's Apache-2.0 licence, ONNX
  Runtime's MIT licence and notices, and eSpeak NG's, in THIRD_PARTY_NOTICES; they add no RPM dependencies.
- **Ember asks you to agree again at its first start**, because “Before Ember starts” now says more: what it keeps
  when you teach it your voice and correct its words, that once you call it, it keeps listening through the
  conversation and sends what it hears there as text, that Listen once can open the microphone for one request while
  “Hey Ember” is off, what Project work sends and a saved workspace keeps, and that “Keep my recent conversation” keeps
  its latest messages on this computer.

### For administrators

- **Update Ember before you set the new policy keys.** 0.1.1 adds `features.aiReview`, `features.memory`,
  `features.routines`, `features.updates`, `features.extensions`, `features.autonomy` and `features.userProvider` to
  the organisation's policy: each one false turns its feature off (`features.routines: false` keeps no routines and
  ends reminders when Ember quits; the sections below say what the others cover, and the RPM's `policy.README`, in
  `/usr/share/doc/ember`, lists every key). Ember 0.1.0 doesn't know them: it reads a policy with one as broken and
  locks down, so update Ember on every computer first.
- **`features.screenImages: false`** now also shows the new **Send screenshots for tasks** switch off and managed, as
  well as keeping screenshots from the model. Ember 0.1.0 knows this key, so a policy with it doesn't lock 0.1.0 down.
- **A policy change shows at once in an open settings window.** Ember still stops everything and holds itself locked
  down until it is restarted, and the window now says so straight away instead of showing the earlier policy until it is
  reopened: every switch the lockdown turns off shows off rather than on and greyed (**Send screenshots for tasks**,
  **Work without asking**, “Hey Ember”, speaking, Memory, Routines, update notices and “Don't ask before working in an
  app I asked for help with”), and Apps & privacy's “What Ember reads, sends and keeps” and Commands follow the policy
  in force. **Hear me more clearly** and the voice Ember speaks in show what Ember still uses: the lockdown changes
  those once Ember restarts.
- **Where AppLocker or Software Restriction Policies block `powershell.exe`,** Ember can't read apps on Windows, and the
  setup check's Screen reading row now says “Windows didn't let Ember run Windows PowerShell. Ask your administrator to
  allow it.” instead of showing no row. Ember then tries PowerShell again only after 5 seconds, 30 seconds, 2 minutes
  and every 10 minutes after that, not at every read (each of which the policy logged as a blocked start).
- **The npm launcher downloads through the proxy npm uses:** npm's `https-proxy` or `proxy` setting (from npm's
  environment or its `.npmrc` files), else `HTTPS_PROXY` (`HTTP_PROXY` for an `http://` mirror), never for the hosts in
  `NO_PROXY` or npm's `noproxy`. It takes an `http://` or `https://` proxy, not a SOCKS one. Behind a proxy that
  inspects HTTPS, set `NODE_EXTRA_CA_CERTS` to your organisation's certificate file; `EMBER_NPM_DOWNLOAD_BASE` points it
  at your own mirror. When the proxy blocks the download (403 or 451), refuses to connect to a host or can't get an
  answer from one (502 or 504, for a plain `http://` request or for the connection it was asked to open), the launcher
  names that host, GitHub's storage host after its redirect included, and the setting that names the proxy, so you know
  which host to allow. A Bad Gateway or Gateway Timeout from inside an HTTPS tunnel names the host and, since a proxy
  that inspects HTTPS answers from there too, the proxy, and if it keeps happening, says to ask whoever runs the proxy
  whether it can reach that host. [Its README](packages/npm/README.md) has the details.

### First run

- **You can start with your own model provider.** The GitHub step now offers “Use my own provider”: enter its address,
  API key and a model, agree to where your requests go, and Ember checks the service's models before it says it works.
- **No Copilot on the account? Ember says what to do.** It offers your own provider, a different GitHub account, or your
  administrator, instead of asking you to sign in to the same account again.
- **You see which models Ember picked** (and their premium-request cost) before your first request, and can change them.
  With no model that reads images, the tasks selector shows the one in use and says tasks work from text.
- **A permission fix that fails says so in its row,** not only to screen readers.

### Settings, redesigned

- **One pane at a time**, as System Settings: a sidebar with **Search settings** at its top (Enter goes to the first
  setting found), and the window reopens where you left it. **Home** shows what Ember is doing now: its state, what is
  on, today's tasks and approvals, **Ask Ember…** and **Stop everything**; then the conversation and **Task activity**.
- **Task activity**: each task of this session, step by step, with its plan, its questions and how you answered them,
  and what it found. A task waiting for you says where it asks and which keys answer. Kept until you quit (the latest
  20 finished tasks).
- **Ember on screen** (Settings › Your Ember): **Follow my cursor** and **Hide Ember until it needs me** are switches
  now; **Quit Ember** is under them.
- **Starting Ember** once it is set up only greets you, unless the setup check needs you; start it again (or press the
  settings shortcut) to open settings.

### Asking less, and answering by voice

- **No first question in the app you asked about**: Ember no longer asks before its first step in the app you were in
  when you asked, or in one your request names (Settings › **Apps & privacy** › **Don't ask before working in an app I
  asked for help with**, on by default). Sending, deleting, paying and the like still ask every time.
- **Copilot can review a command that would ask**, against your request (Settings › **Apps & privacy** › **Ask only
  about dangerous commands**, off by default for now): a routine one runs in the command window with its **Stop**
  countdown instead; secrets, system changes, root and anything a page or a command's output tried to steer always ask.
- **Work without asking** (Settings › **Apps & privacy**, off by default, with its own card to agree to first): Ember
  uses your apps, borrows your mouse and keyboard, moves text between apps and runs ordinary commands for what you ask
  without asking first each time, and says what it is doing in its bubble and on the task's card. It still asks every
  time before anything risky (sending, posting, submitting, sharing, deleting, overwriting, paying, installing, signing
  out, security settings, dangerous commands), and a task that a page tried to steer goes back to asking. Say “Ember,
  work without asking” (Voice Match must recognise you) or “Ember, ask me first again”.
- **Work without asking covers more everyday steps**: it also presses OK on a message box whose only button is OK,
  with nothing to choose or tick (it says “Answering a message box in …”), types a list or a letter with line breaks
  into Notepad, gedit, TextEdit or another plain text editor with the borrowed keyboard, and fills spreadsheet cells,
  all announced. A dialog with a Cancel, a check box or any other control, or one that asks a question, says what has
  happened or will happen or is long, is cut short, is a web page's, an installer's or a permission prompt, or is in a
  language Ember doesn't know still asks, and so do line breaks in an editor's console or any other app, keys Ember
  can't be sure of (Alt+letter, unknown shortcuts) and dangerous commands. Its card says so, and asks you to agree
  again. While Ember runs as an administrator (or as root) every command asks, and the switch's hint now says so.
  Filling cells after you said no in a task now asks again, as every other step does.
- **Answer questions by voice**: while Ember asks, “allow”, “yes”, “okay”, “go ahead”, “sure” or “I accept” allows,
  and “no”, “not now” or “don't” refuses. With Voice Match off, its default, anyone Ember hears can answer, as first run
  says; with it on, only your recognised voice can allow, and anyone can refuse. For a few seconds after Ember asks you
  needn't say “Ember” first; while a video or other sound plays, or where Ember can't tell whether it does, say “Ember,
  allow”. Never “Always”, never Ember's own voice, and a command card or a long text only once all of it has been shown.
  An answer said over Ember's read-out stops it, and Ember asks you to say it again; one it didn't catch, or a key press
  that didn't count, says why and how to answer. The audit log says the answer was spoken. With Voice Match on, half a
  second of your voice after “Ember” is enough to recognise you, and a shorter yes counts for the questions of a task
  you asked for in your recognised voice, within 10 minutes (never a command card, a consent card or another task's
  question; the audit says `trust: "task-voice"`; not a yes too quiet or clipped to tell, either). A yes asked as a
  question isn't one.
- **Allow works on web pages**: an Allow for a step on a page that changes by itself (a video playing, a preview) goes
  ahead when the page didn't change while you decided, where Ember used to compare it with an outdated copy and ask
  again. A search result whose title merely holds a word like “install” or “share” opens without being called
  something you didn't ask for; a link that says it does one still asks. When Ember asks again because the page changed
  or a menu closed while you decided, it says why, and where it can't use your mouse and keyboard (a Wayland session, a
  secure desktop) it says so instead of asking first.
- For administrators: `features.autonomy: false` turns Work without asking off (managed); so do `allowGrants: false`,
  `confirmEveryAction` and a lockdown. `features.aiReview: false` sends no command to Copilot for review, so every
  command Ember's rules flag asks (**Ask only about dangerous commands** shows off, managed).

### Voice

- **Call Ember by its name**: “Ember, open my calendar” (“Hey Ember” and “OK Ember” work too). The name heard inside
  another word (“remember”, “September”, “the embers”) shows nothing: a wake by the bare name shows once the recogniser
  has heard the name start what was said. While Ember speaks, “Hey Ember” makes it stop and listen, on Windows and
  macOS too.
- **Ember speaks in its own voice**, Kitten Nano 0.8 (its voice files are 63.8 MB), made on this computer sentence by
  sentence while Copilot is still writing. Should it be missing, fail or be too slow, the system's most natural voice
  speaks (a Natural voice on Windows 11, a Premium or Enhanced one on a Mac). On Windows and macOS, **Voice** in
  Settings › **Voice** also offers Kokoro (350 MB), downloaded only once you choose it, which speaks where the computer
  is fast enough for it.
- **Ember speaks out loud by default** now; 0.1.0 spoke only while a screen reader ran. Choose Always, When a screen
  reader runs or Never in **Speak replies, questions and results out loud** (Settings › **Voice**; an organisation
  that turns speaking off shows it as Never, managed).
- **Native speech on every computer**: listening and Ember's voice run on sherpa-onnx's native build, about three times
  faster to hear a request than on WebAssembly. On Windows and macOS that is its native addon; the RPM and the AppImage
  carry its own libraries (sherpa-onnx and ONNX Runtime, 32 MB installed, about 9 MB of each download), on which
  hearing a request takes about a third of the CPU. Nothing more is downloaded. Where they can't run, listening runs on
  WebAssembly and replies use the system's voice; `ember doctor` says which under **Speech**.
- **Voice Match**: Settings › **Voice** › **Answer questions with my voice** teaches Ember your voice from four short
  phrases. It decides only whose voice may answer Ember's questions (above), never who Ember hears. “Ember, stop” still
  works for anyone. Your voiceprint (256 numbers that describe how your voice sounds; it can't be turned back into
  speech) stays on this computer, in `voiceprint.json` in Ember's data folder, readable by you alone; **Forget my
  voice** deletes it.

### Voice that learns you

- **Keep learning my voice** (Settings › **Voice**, on once Voice Match knows you): Voice Match follows your voice
  slowly, from requests it is sure are yours, so a new microphone or a cold doesn't wear it down. It never learns from
  its own voice, a request with another voice in it, or for two minutes after it turned someone away or you stopped
  it, and never from an answer to a question; it takes at most one request a minute, moves a small step at a time
  and stays close to what you taught it, and it asks a little more of a request as it learns, so other voices get in
  less often, not more (measured on 40 LibriSpeech speakers: docs/ASSISTANT.md §7). A spoken “allow” still has to match
  the voice you taught it as closely as before. **Reset to my enrolment** goes back; **Forget my voice** deletes it all,
  the words it learnt too. It keeps numbers, never audio. “Ember, stop” still works for anyone.
- **Ember hears names better**: what it hears is checked against your installed apps and, with Memory on, the names
  you asked it to remember (“Open Spotfy” → “Open Spotify”; “Amber, …” at the start → “Ember, …”). When it still gets
  one wrong, **That's not what I said** under the request in Conversation lets you type what you said, and with
  **Learn my words** on it hears it right from then on (listed in Settings › Voice with Forget). A request about
  sending, deleting or paying, or one to message, call, tell or invite someone, is never changed but for Ember's name,
  and a person's name from Memory is only used in a request that looks something up (“find Sandra”, “who is Sandra”),
  never in “ask Sandra…”, “add Sandra…” or “book lunch with Sandra”. It never learns a swap of numbers.
- **Suggest what I might say next**: two or three likely next requests (“Close it”, “Read it out”, “Do the same for
  the next one”) under Ember's answers and in Ask Ember, marked as Ember's suggestions and made on this computer.
  Choosing one asks Ember as typing it would, but a command it names always asks first; nothing risky is suggested
  unless built from what you just asked.
- **With Keep listening after I call Ember off** (below), you can go on without the name for up to three requests in a
  row, and after a spoken answer that asked you something the window to reply stays open 12 seconds instead of 8.

### Memory that learns as you go

- **Ember can remember you** (Settings › **Memory** › **Remember what I tell you**, off until you turn it on and agree
  to its note): what you tell it about yourself, your work and how you like things done stays on this computer, tied
  to your verified GitHub account, and you can review and forget each fact. It refuses to keep the passwords, PINs,
  lock codes and card numbers it recognises.
- **Ember learns on its own** while memory is on: after you talk and when a task finishes, it picks out what's worth
  keeping (your preferences, your work, the people and apps in it), tidies its memory while you're away, and at most
  once a day asks about a name it keeps finding nothing on (**Ask me questions now and then** turns that off). Only
  what you say yourself counts as yours; what it reads on screen or in a task's result never does, nor speech it can't
  tell from its own speakers, and it never learns an instruction or a one-off order as a preference. A new fact shows
  in the conversation as “Ember learned: …” with **Undo** (which puts back what it replaced); “Ember, forget that”
  works too. The list says where each fact came from.
- **Tell Ember about you**: what to call you, your role and work, the apps you use most, how you like answers, your
  timezone or hours, each optional, in Settings › Memory and as an optional step of first run. Or say “Ember, get to
  know me” for a short spoken version.
- Memory's note says all this. While a changed note waits for you to agree, Ember remembers nothing more (Home says
  “Memory paused”); what it kept stays until you do. Learning uses a few short requests of its own (at most 12 an hour
  and 60 a day, plus 6 a day while you're away).
- For administrators: `features.memory: false` (and a lockdown) turns all of it off.

### Better recall

- **Ember finds what you told it when you ask in other words** (Settings › **Memory** › **Better recall**, shown while
  memory is on): “Who is my manager?” finds “Priya leads the platform team”. **Download (23 MB)** fetches a small
  language model (all-MiniLM-L6-v2) from Hugging Face (`huggingface.co`, served from `*.hf.co`), checked against its
  pinned SHA-256; nothing is fetched until you click it, and turning memory off cancels a download under way. It runs
  only on this computer, in a process of its own that ends after 5 idle minutes. On 80 questions asked in other words
  it found the right fact first 83% of the time, against 9% by words alone; questions in a fact's own words find it as
  before.
- What it makes of each fact is kept beside what Ember remembers, readable by you alone, and goes when you forget the
  fact, **Forget everything**, sign out or click **Remove**. With a request, at most one fact more goes to Copilot by
  meaning alone. Without the model, or if it is slow, memory works as it did.
- For administrators: `features.memory: false` turns it off with memory. A firewall must allow `huggingface.co` and
  `*.hf.co` for the download.

### Your own model provider

- **Use my own model provider** (Settings › **Models & connections**, off by default): Ember can use a model service
  of yours instead of GitHub Copilot: OpenAI-compatible, Azure OpenAI or Anthropic, at an `https://` address, or a
  model server on this computer (Ollama, LM Studio) at `http://localhost`. It first shows a card naming the service's
  address and what goes there, screenshots for tasks included, and uses it only once you agree (and again for another
  address). **Test connection** checks the address and the key in one request. Turning it on or off, or changing it,
  applies from your next message without a restart; tasks already running finish where they started, and a new
  conversation starts on the other service (what Ember remembers stays).
- **The API key** is kept encrypted by the system's keyring, apart from the settings, never shown again, logged or
  recorded, and goes only to that service. Where the keyring would keep it as plain text, Ember refuses and says why.
  **Remove** and **Sign out** delete it. `ember doctor` names the service by its address only.
- For administrators: the organisation's own `provider` always wins, and `features.userProvider: false` (or a lockdown)
  turns the user's off (managed); `models.allowed` still holds.

### Extensions

- **Extensions from marketplaces** (Settings › Extensions): add a marketplace (a GitHub repository or an https
  address), browse it, and add a plugin; its tools join the conversation between turns, with no restart. Only you add,
  turn off or remove one. Ember loads only a plugin's MCP servers, never its hooks, agents, skills or rules.
- **Ember decides every call**: a read-only tool from an extension you agreed to runs and is recorded in What Ember
  did; anything that changes or sends something asks you every time, with no “Always”. After “Not now” Ember doesn't
  try again. Results are treated as information, never instructions, and one that reads as instructions to an AI
  makes every later call ask.
- **Changed tools stop**: Ember remembers each tool as you agreed to it. If an extension's tool changes later, even
  in the middle of a conversation, Ember stops using it until you agree again.
- **Asking more, not less**: tools that reach the wider internet, and every tool of an extension on a server
  elsewhere, ask each time. A failed call's message is treated as information too, and makes every later call ask.
- **Its own environment**: an extension's program on this computer gets only what any app Ember starts gets, never
  your GitHub sign-in or keys. Stop everything ends every extension program too.
- **Administrators**: `features.extensions: false` turns extensions off (lockdown does too).
- **Not yet**: connectors (GitHub-hosted services), Copilot `extension.mjs` extensions, extensions in tasks (only the
  conversation uses them), programs from extensions on macOS, and servers that need you to sign in to them.

### Product audit fixes, 7 to 12 November

#### First run

- **First run names the service Ember uses.** While your own model provider connects or isn't answering, the sign-in
  step is titled “Your own model provider” and offers **Check my provider's details**, and the last step says it isn't
  connected yet instead of “Not signed in yet”; once it answers, first run says “Connected to your own provider” instead
  of “Connected to Copilot”, or, as Home does, “Using your own provider” (and “I'm using” in the step's own words) for
  one at an address elsewhere, or one on this computer that answered without a model list or refused the key. Back from
  the setup check returns to the provider's step, and where your organisation turned your own provider off, first run
  doesn't offer it.
- **A provider of your own that is already in use shows as in use** on its step, and Back leaves it on: **Use GitHub
  Copilot instead** is the way back to Copilot from there. New details typed there are checked before they replace the
  ones in use: a check that fails, or that you leave the step during, changes nothing, and the step says so in first
  run's own voice (“I can't reach new.example.com. Check the address and the network. Nothing has changed: I'm still
  using api.example.com.”), with the keyboard on the field to fix and **Keep using api.example.com**, which puts back
  the details in use so you can continue with them. Details that pass replace the ones in use in one change, so Ember
  never falls back to Copilot in between.
- **“Use GitHub Copilot instead” switches your own provider off.** Copilot's sign-in shows from the moment the keyboard
  lands on its title, and if you then choose your own provider again, a check that fails switches it off instead of
  leaving it on at an address that didn't answer, and Back returns to Copilot's sign-in. Pressed while Ember is still
  answering or doing a task, the step says “I'll switch to Copilot once I've finished what I'm doing.”, lets you go on
  and keeps offering **Use my own provider** meanwhile; once the switch is made, it says “I've switched to Copilot. Sign
  in with GitHub to go on, or skip for now.” and takes the keyboard off the button that has become **Sign in with
  GitHub**, so a press meant for Continue starts nothing.
- **First run speaks in its own voice on every visit.** First run says why a provider check or a connection failed, on
  the sign-in step too, and the rest of what Ember says as it connects, in its own words (“I can't reach the model
  server on this computer (127.0.0.1:11434). Start it, and I'll connect in a moment.”, “the GitHub sign-in I found”, “My
  model connection keeps stopping…”), never a mix of “I” and “Ember's”. The sign-in step no longer says “press Check
  again” where it shows no Check again: it says “press Try again” beside **Try again**, also for a refused token from
  the environment and for your organisation's service, and “Go back and press Try again” on the details of your own
  provider in use.
- **The API key field says a key is saved only while the address typed is the one it was saved for**, and catches up
  when Ember's key state arrives late. With no keyring, **Agree and check the models** waits with a short reason beside
  it (“I can't keep a key safely on this computer.”) instead of the status line's whole sentence again.
- **Ember's hello names the service it can't reach**, your own model provider or your organisation's, with “Start it,
  and I'll connect in a moment.” for a model server on this computer, and Home's button reads **Check my provider…**
  or **Models & connections…** instead of **Connect Copilot…**.
- **Under your organisation's lockdown,** first run and Home say Ember is locked down and why, with no Connect Copilot
  button and no raw policy error.
- **A model server on this computer (Ollama, LM Studio) works in first run without an API key,** also where there is
  no keyring.
- **A failing own provider is explained as the provider's problem,** never as a Copilot or GitHub account problem.
- **After an update that changes how Ember works,** first run opens at its consent page and lists what changed since
  you last agreed. The page's short form names where your requests go, as its full text does (your own model
  provider, your organisation's model service or GitHub Copilot), and never names Copilot while another service is in
  use or Ember can't yet tell which.
- **Finishing setup no longer wakes Ember.** Start says “Setup is finished.” and the keyboard lands on Home's status
  line; the last step is “Ready to start” and its button **Start**, so no title or button read out as you finish names
  Ember, and the step first run opens on takes the keyboard on its title. **Agree and check the models** fails on a
  model name the service doesn't list, names what it lists (“It lists 1 model: llama3.2:3b. Enter that name.”) and puts
  the keyboard on the field; a name the service takes but lists differently, Azure and a list longer than one page pass.
  With the speech models gone, the try step and the summary say they need downloading.
- **Keyboard focus stays put:** first run's quiet buttons (Skip for now, Cancel, Personalise memory…) keep it when
  Ember's status changes. After Not now it moves to the note saying Ember stays off, and **Agree and continue** and
  **Quit Ember** take a press only half a second after they appear, so a second or held Enter, or a double click,
  neither agrees nor quits. A second Enter on **Sign in with GitHub** doesn't cancel the sign-in, nor does one after
  Cancel skip the step. After **Turn on** for screen reading, first run keeps telling you to restart the apps that
  were already open.
- **The setup check says the same everywhere.** A row that keeps Ember from reading apps counts as one to fix in
  Home, its badge and `ember doctor`, as it does in first run. Home's setup check uses first run's words for each
  row's state and offers **Copy** for a command to run, and **Check again** reads the setup afresh after you run a
  command or change a setting yourself, then shows what it found beside the button, not only to screen readers.

#### Home

- **The composer stays in view while a reply comes.** After you send from Message Ember, the reply growing above it no
  longer pushes the box and its Send below the window; nothing moves if you scrolled away to read. The line under Send
  that says how your message is going stays in view with it, and while you're in the composer it scrolls into view
  when it says why a send was refused, that your message is being sent or how a Stop ended it.
- **The composer and Task activity are within reach.** Home shows the latest 6 messages (**Show earlier messages**
  has the rest), keeping one whose Copy or Edit has your keyboard focus, and its status panel has **Write to Ember**
  and **Task activity** links.
- **Read the last answer opens Home at that answer,** focused and from its top, not at the oldest message. So does a
  long answer's **Open conversation**.
- **Sending clears a search left typed in,** so your message and Ember's reply show, and keeps the composer in view.
- **A long paste is kept whole.** Message Ember counts characters from 1,800 and won't send more than 2,000, saying
  how many too many, instead of cutting the end off without a word.
- **Messages kept from before a restart are marked.** A line under them says they are for reading and Ember starts
  afresh below, and they show their day.
- **Home follows Ember's answer, wherever you asked.** Its status panel says “Thinking…” while Ember answers a request
  from Home, the Ask box or your voice, also while a spoken request cuts in. While the bubble says Ember is still
  waiting (10 seconds with nothing written), the line under Send says so too and names **Stop response**, also for a
  request from the Ask box or your voice, though never in place of Edit's caution that sending again may repeat actions
  or the count that says your message is too long; and the settings shortcut opens Home at Stop response, so Enter stops
  that reply. Home's wait ends with Ember's turn, also for the first message after Stop everything or a reconnect, and
  says once how it ended: “Reply received.”, “This reply couldn't be finished…” after a model error cut a reply short,
  “This request got no answer…” when it failed before any reply began, “Response stopped. Running tasks
  continue.” after **Stop response** or the bubble's Stop, “Stopped everything, running tasks included.” after Stop
  everything, or, when no reply was written, that Task activity shows any task the request started. **Stop response**
  with nothing under way says so instead of showing “Okay, I've stopped.” in the bubble.
- **New conversation asks first** while there are messages to clear, and says when it will also delete the copy saved
  on this computer.
- **A message sent while Ember connects, reconnects or is offline says why,** and that it is still there, instead of
  sending you to Models & connections. **Stop response** or Stop everything while it waits ends it at once, so Home's
  status panel stops saying “Thinking…”, and puts every message that hadn't gone back in the composer, oldest first and
  above anything typed since, saying once how many came back; one Ember had already answered never comes back, and a
  typed “stop” isn't kept with them to go with your next Send. While you edit an earlier request, the messages a Stop
  gave back stay as you left them (a correction stays, a message you deleted stays deleted): a second **Edit** keeps
  them above the request it opens, **Cancel edit** puts them back above the draft you had before, and the line under
  Send keeps Edit's caution that sending again may repeat actions. Messages a Stop gave back that together pass 2,000
  characters are said to go one at a time, or, where your draft is too long by itself, that it needs shortening.
- **A Problem line in Home that sends you to Ember's settings names Models & connections** instead, and offers
  **Models & connections…**, which goes there, also when it says Ember has stopped reconnecting and to press Check
  again. A line that sends you to your administrator or to a setting on GitHub doesn't offer it.
- **Home's Features line says what is in force,** not what the switches ask for: “Commands off” where your organisation
  turned them off, “Listening needs its speech models”, “Microphone problem”, and “Checking…” until Ember answers, with
  **Try again** if it doesn't. Offline while signed in, Home says Copilot can't be reached instead of offering **Connect
  Copilot…**; while a changed policy holds Ember locked it offers **Restart Ember**, and a message sent then is told to
  restart Ember, not to wait for a fix. Sending an edited request puts back the draft Edit set aside, a narrow window's
  row of section links keeps the open pane's link in view, and after a send refused for want of a connection the line
  under Send says “Connected again. Your message is still here: send it now.” Where your organisation turned off acting
  in apps, Projects says so instead of failing at every press, and a refused project command says which reason holds.
- **Home names your computer's send key** (Ctrl+Enter, or Command+Enter on a Mac), and a message's **Copy** says
  Copied.
- **Keyboard focus stays on a running task's Stop task** (and Show app, a steps row, Open approval) as the task takes
  its next step, instead of dropping to the top of Home, and on Send, Stop response and a message's Copy while Ember
  answers them. A control that a key or your voice takes you to, such as Stop response while Ember is still waiting,
  shows its focus ring even if you last used the mouse in Home.
- **Screen readers hear Home's status lines as they fill,** such as Hear Ember's result, What Ember did's read problem
  and Never look at's “Removed …”.
- **Search settings shows each result in the page's own words,** one sentence of a long footnote, names Setup & about
  plainly, and finds the conversation's history, deleting, starting at log-in, the shortcuts and the log file by
  everyday words.
- **What Ember did shows its whole record a page at a time** (**Show earlier**), counts all of today's steps, and
  keeps what it showed, with a note, when the record can't be read. It tags an “Always in” answer as “Always allowed”
  and says what that changes, shows “Without asking” whole, and names password managers properly (KeePassXC,
  1Password, Passwords and Keys). In a narrow window or at a large text size, each entry's words get their own row.
- **Projects says why a request failed** (a refused API key, a usage limit, files too long for the model) instead of
  always “Try again”. Minimising or hiding settings no longer cancels a project request or a project command: the answer
  is there when you come back. While Ember reconnects, and while your own provider is off or waits for you to agree to a
  new address, Projects keeps your files, the request you're typing, the answer and its unapplied changes, and sends
  nothing until Ember is connected again (**Export answer…**, **Export diff…**, **Apply patch…** and a file's Remove
  still work, as they send nothing, and Apply patch's confirmation stays up while Ember tries to reconnect); signing
  out, another account or your organisation's lockdown clear them, and an answer from one model service never goes to
  another. **Run a project command** says commands are off before you type one, with **Open Commands**, or that your
  organisation turned them off.
- **Projects names the file and the line that look like they hold a password, token or key** (“config.ts appears to
  contain a password, token or key on line 3. Remove that file or the value, then send again.”), every such file at
  once, so you remove only those; ordinary code that names a token or a password is sent (see Memory). Where the patched
  file would look like it holds one, Projects says so, with the line, instead of offering **Apply patch…**, and it says
  when an answer won't go with your next send.
- **Projects and reminders look like the rest of Home:** one prominent button per group, Home's chevrons on their
  disclosures, buttons that keep their size and no blank bands. The question before deleting all routines and
  reminders reads properly (“Delete your routine?”, never “1 routines and 0 waiting reminders”).
- **In Windows contrast themes,** Ask's eye, a task view's section chevron and the Projects tile show as the others
  do, and Apps & privacy and Comfort & access no longer scroll sideways at 200% zoom with Larger text.

#### Ask and the companion

- **The Ask box opens beside the answer or question Ember is showing** instead of covering it, or over or under it where
  it fits beside neither (Large and Larger text, a 1024-wide screen), never on Ember, and it keeps off the task cards,
  so at Larger text it no longer covers a card's title and status (on a 1024-wide screen at Larger text there may be no
  room). A question that comes up while you type shows beside the box; where there is no room, the box
  moves aside, and aside again if the question grows under its field (as the note after a spoken yes Ember didn't take
  does), and the question never moves. An answer already on screen stays where it is as the box opens or grows, and
  stays up while the box is open and for a few seconds after you close it, so you can read it as you reply. One opened
  in full with **Read all** keeps clear of the box instead, whether the box or **Read all** came first, and also as the
  box grows a row for Ember's suggestions: above or below the box, or, where it fits nowhere clear whole (1024×768 at
  Larger text, 800×600), cut short to the room with its text scrolling inside and Close in view, and shown whole again
  once the box closes. One still being written, also one that starts while the box is open, moves clear of the box
  once it grows into it, and so does one whose **Read all**, hint or suggestions arrive as it finishes: above or below
  the box where there is no room beside Ember, so its last lines and **Read all** stay readable. Of
  Ember's listening, only the box's own Listen once moves it aside, never “Hey Ember” said nearby while you type. The
  field no longer jumps when your first letter puts Ember's suggestions away, nor when a question or its answer takes
  them away or brings back fewer or more: their row keeps the room the box opened with. On Linux, a click beside the box
  reaches the app underneath and closes it.
- **Ask's suggestions follow what is on screen:** none while a task's question is up, “Close it” or “Read it out” only
  while the answer they reply to shows, and “Yes, please” or “No, thanks” only while the offer they answer shows: not
  while the bubble cuts it off under **Read all**, and for an answer opened in full only once its last line has been in
  view (in the corner card too, without a compositor). A suggestion no longer offered can't be sent. An answer's
  suggestions come into a box you opened while it was still being written, where there is room for both, reachable with
  Tab and without moving the field; on smaller screens at larger text, and wherever they need more room than the open
  box began with, they show under their answer, and in the box the next time it opens. With **Suggest what I might say
  next** off, the box opens with no empty row for them.
- **The Ask box says when Ember can't answer yet** (“Not connected: I can't answer yet”) before you type, not after you
  send, and keeps it true while the box is open, telling screen readers “I can answer again.” once it can. It names the
  service in use (“Provider problem”, “Service problem”), as the handle does, and a crowded line shortens to just why.
  While Ember reconnects by itself, the handle and Home's status panel say “Reconnecting…” and the box “Reconnecting: I
  can't answer yet”, and once Ember stops trying, “Connection problem” (“Copilot problem” with Copilot), never blaming
  your provider; Home's panel then offers **Models & connections…**, not your provider's details or Copilot's sign-in.
  When Ember will see nothing, the line under the field shrinks to its keys.
- **A long paste in the Ask box is kept whole**, as in Home: from 1,800 characters it counts what would be sent (blank
  lines after it don't count), and over 2,000 it says how many too many and sends nothing until it fits.
- **Esc while an input method is composing a word** cancels the word, not the whole Ask box.
- **Listen once shows as unavailable when Ember can't listen.** Without the speech models, Ask offers “Set up voice in
  Settings…” instead, and where your organisation turned voice off, Ask leaves Listen once out. A question that comes
  up during a Listen once ends it, and until you answer, its control says “I stopped listening to ask you something.
  Answer it, then ask again.”
- **While a slow answer is on its way,** the bubble names the service in use (“Still waiting for your model
  provider…”), not always Copilot. Screen readers hear it, with the keyboard's ways to stop, which the bubble now
  shows under it too.
- **A failed reply's problem and its Try again stay up for their full 12 seconds,** and “Okay, I've stopped.” goes
  after 4 seconds instead of up to 30. When Copilot stops in the middle of a request, the bubble offers Try again and
  says “I'm connected again” once Ember has reconnected, and Home's conversation says “Copilot stopped unexpectedly.
  I'm connected again: send it again.” Under your own provider or your organisation's service, these say “My model
  connection stopped…”, never Copilot. If the connection keeps stopping, Ember stops reconnecting and says so in the
  conversation and the bubble, with how to try once more; once **Check again** brings it back, the bubble says “I'm
  connected again. Ask me again.” and the conversation's line says to send it again.
- **Without a compositor, the corner card grows** for any question at Large and Larger text, so you can read the whole
  sentence, and its Allow waits until you can. It shows a question's keys as keycaps, as the bubble does, each key with
  its answer on a line of its own, and the Ask box moves off it as it grows; a long text's key hint for its next part
  wraps its words under their keycaps and stays inside the card. On a narrowed bubble, a question's key hint stays
  inside it, a Mac's four keys at Larger text included: a shortcut wraps under its own keycaps only where it alone is
  wider than the line, no line starts or ends with a “·”, and screen readers hear no “·” before the first key.
- **Until first run is finished, the handle says “Finish setting up”,** and its menu starts with a way back to setup.
- **Without a compositor, screen readers hear every question on the corner card,** one in the same words as the last
  too, and what comes back after “Listening…” only once. The card also says when a task ends (“Print two lines: Done”),
  with Home closed too, holding it while the microphone or Listen once is open.

#### Voice

- **“Ember, stop” and “Hey Ember, stop” stop everything while you teach Ember your voice.** Stop everything ends the
  teaching too, and so do 45 seconds with no phrase heard, 3 minutes in all, and closing Settings; the handle and
  Settings' voice line say “Learning your voice” meanwhile, also when you start teaching during a conversation.
  Settings then says how it ended (Ember stopped listening, the phrases didn't sound alike, the time ran out) and what
  to try, instead of asking for phrases that would run as real requests.
- **Listen once hears a long request to its end.** Speech must start within 8 seconds (a request begun just before then
  counts); what you are still saying then is heard to the end, up to 20 seconds from the press, instead of being thrown
  away as “No request heard”. When only a TV or someone else is talking as it starts, it sends nothing: talk already
  going as you press ends it at 8 seconds with “No request heard. Try again.”, and talk that starts in its first second
  and is still going at 12 seconds, which it can't tell from a request begun then, ends it there with “I heard talking
  but couldn't tell it was a request. Wait a moment after pressing Listen once, then speak.” (in Settings, “There was
  talking, but it wasn't clear it was a request…”), so a request begun in that first second must end within 12. While it
  waits for you, Settings' voice line says “Listening…” and the handle's microphone badge “Listening”, and with “Hey
  Ember” off the line goes from “Starting…” to “Listening…” to off, never saying Ember is listening for its name. With a
  screen reader running, what it announces as Listen once opens is left out of your request, and when that is heard,
  your 8 seconds start after it. On a muted microphone it says “The microphone is sending only silence…”, and pressed
  while Ember talks or answers, it stops that first and listens, as “Hey Ember” does.
- **A screen reader doesn't read Ember's listening lines over your request.** While Ember's microphone is open for a
  request (after “Hey Ember”, in a conversation or during Listen once), Settings' voice line and Listen once's line in
  Settings and in Ask still show what changed but don't tell a screen reader, so “Hearing you…” and “Ember is already
  listening.” aren't read out over what you say, nor is “Answer Ember's question first.” while a conversation stays open
  for your spoken answer. “Ember is already listening.” stays under Listen once as its description, and browse mode
  doesn't find an out-of-date line beside the one shown (“Checking the microphone…” beside “Ember is already
  listening.”). After an answer, while Ember waits for your follow-up or the conversation's next words, the voice line
  says “Listening…”, as the handle's badge does, instead of “Hearing you…”. Hear me more clearly's line, the Speak note,
  Task activity's “Waiting for you” and “Done”, and Ask's “I'll see: …” or that Ember can't answer aren't said while the
  microphone is open for a request either: they wait until it closes, and then only what is still news is said, once,
  each as a full sentence; Settings says “Connected.” only when that changes, not at every request. These lines are
  worded for a screen reader without Ember's name, so said through your speakers they neither wake Ember nor become your
  request: Settings' line for talk Listen once couldn't tell was a request, Hear me more clearly's line, the Speak note,
  the line about Ember's voice and **Hear Ember**'s result, Listen once's lines (“Press Listen once, then just say your
  request.”, “Stops the answer on its way, then listens for one request.”, “Checking what was said…”), Ask's “I'll see:
  …”, Home's status line, Hide's line and what the composer says of a message, Voice Match's lines as teaching ends or
  your voice is forgotten (with no “Ember, stop” in them), and the update check's (“Version 0.1.2 is out.”). After
  **Forget my voice** the keyboard moves to **Teach my voice**, as the button is now called, and neither its name nor
  its description names Ember; the composer's line is “Thinking… The reply will appear above.”, “Request heard.” is said
  once, and as listening starts the keyboard goes to Listen once, not the “Hey Ember” switch, whose reading woke Ember.
  The line about Ember's voice is said only once it has held: never that the voice is being checked, nothing when
  Ember's voice only loads again after a quiet spell, and **Try again**'s outcome even when it ends as before.
- **Teaching Ember your voice with a screen reader on speakers learns your voice, not the screen reader's.** Ember
  leaves out what the screen reader reads of each prompt, and when you speak before it has finished, Settings says “Your
  screen reader was still reading. Wait for it to finish, then say:” and the phrase again. On headphones, where the
  screen reader isn't heard, a phrase said as soon as its prompt shows is asked for again after 5 seconds instead of
  being dropped without a word.
- **Teach my voice is refused while the microphone isn't working** (“Not listening just now, so your voice can't be
  learnt. Check the microphone and the voice status above, then try again.”), the line staying until Ember listens
  again, and a microphone lost mid-teaching ends it at once instead of 45 seconds later.
- **A speech-model download that fails says why in plain words**, as what went wrong with the download or at the site
  (“The download couldn't reach github.com right now. Check the network or proxy, then try again.”, “The download site
  (github.com) had a problem. Try again later.”) or with saving it in the data folder, never as the raw error with the
  folder's path in it.
- **Pause to think mid-request.** After a word such as “the” or “and”, Ember waits 0.9 seconds more for the rest: “And
  make the text a… bit bigger” is now one request, also when the pause falls as Listen once's 8 seconds run out.
  Quieter talk from someone else that follows isn't joined to it, and when only that talk follows, what you said
  before the pause is sent.
- **Cancel the speech models' download** with **Cancel download** beside its progress; turning listening off stops it
  too, and where the models aren't installed yet the microphone note says that agreeing downloads them (about
  220 MB).
- **Settings names the microphone Ember hears through** (“Listening for “Ember” through …”), and the handle says
  “Listening for “Ember”” as Settings does. Listen once points to the download right below it, **Forget my voice**
  says it also forgets the words Ember learnt, and in a conversation with music playing Ember says to start with
  “Ember” when it didn't hear you.
- **Numbered steps and lists are said one by one.** Each step keeps its own number (“2. Choose Privacy”, not “Open
  Settings, two”), list items get a pause, and a list on its way is said as each item arrives. A list written as short
  lines without bullets, or a bold heading line, gets a pause after each line too, and so does each step of a plan
  written as two or more plain lines after a colon, however long, also as it streams in after a line such as “Here's
  what I'll do:”. Labelled steps (“**Step 1:** Open Settings”) are said one at a time, each label at the start of its
  step, and each as it arrives, not once the whole answer is in; a short label on a line of its own (“Cons:”, “Step 2:”,
  “On a Mac:”) is said with its step, and a line ending with a colon (“To fix the sound:”) at once. The line before a
  heading or a labelled option (“Option B: …”) ends with a pause, so the two aren't said as one.
- **Money, times and paths are said as people say them.** “$12.50” is “12 dollars 50”, “14:00” is “14 hundred”, “~75%”
  is “about 75%”, “2h 15m” is “2 hours 15 minutes”, a file is “report.pdf in Documents”, “github.com/foo/bar” is
  “github.com”, “I ❤️ Paris” is “I love Paris”, and other emoji aren't read out as “party popper”. “Press the → key” is
  “the right arrow key”, “the ↑ arrow key” is “the up arrow key”, “Press ← or → to move” names both arrows, “from right
  → left” and “top right → Settings” are said with “to”, and an arrow key in a shortcut is said as a key (“Win+←” is
  “Windows key left arrow”); “$5-$10”, “$50 - $100”, “$5-10”, “9am–5pm” and “10:30–11:00” are said with “to”, and
  “$2,000 - $1,500 = $500” with “minus”, while “$1,500 - $200 for fees” is said as written, and a sum or a range is
  never cut into two pieces at its dash.
- **Ember starts talking sooner.** A long first sentence with no comma starts in about half a second instead of two, at
  a natural break where a phrase starts (“…the room is free” and then “from two until four”): never between “is going”
  and “to”, never inside a link or a piece of code, and with no star or underscore said where it falls inside bold or
  italic words. An answer that starts with a line break or a short line such as “OK” starts at its first comma too, and
  a long menu path is never cut just after an arrow as it streams in. An English answer that names Café Nero, Beyoncé or
  São Paulo, or mentions your résumé, starts as soon as its first sentence arrives, and a long table or code block
  doesn't keep Ember busy as it streams in. Its voice loads as soon as you open the Ask box or send a request, and a new
  request that cuts Ember off is heard sooner.
- **Never under Speak stops Ember mid-sentence,** instead of letting it finish the answer. **Stop speaking** in the
  handle's menu silences Ember without stopping its tasks or its answer: the rest of the reply still appears in the
  bubble and Home, and **Read the last answer** stays in the menu.
- **Speaking speed and Hear Ember:** Settings › Voice lets you make Ember speak slower or faster, and **Hear Ember**
  plays a sample and, once you hear it, says which voice spoke (“Getting Ember's voice ready…” until then, and that
  Ember couldn't speak if no voice could). If Kitten Nano stops working, or was too slow while the computer was busy,
  Settings › Voice says so and offers **Try again** instead of using the system voice until a restart, and after a
  busy moment Ember tries Kitten Nano again by itself, once, a few minutes later.
- **Replies in other languages** are said by a system voice for that language, or not at all, instead of with English
  sounds, and one that opens with words such as “Bien sûr !” is said in that language from the start. An English answer
  that names a film, a song or a place from another language (“La La Land”, “Los Angeles”) stays in Ember's voice, and
  so does a short English reply to a request that names a French or Spanish song, film or saying in lower case (“play la
  vie en rose”, “what does c'est la vie mean?”). What a short reply quotes doesn't decide its language: after a French
  request, “Ça veut dire « I don't know ».” is said by the French voice, and an English reply that quotes English by
  Ember's own, while a short French or Spanish reply that names a file (“Voilà « Ventes.xlsx ».”) is said in that
  language after a request in it. A “One moment.” said before Ember gets to work doesn't decide the language of what
  follows it. Settings › Voice and the setup check don't say Ember couldn't speak when only another language's words
  went unsaid.
- **“Read it out”, “say that again” and “tell me again” say the last thing Ember said, once,** instead of switching on
  Read finished tasks out loud: never over a question, with nothing added to the conversation, and the suggestion is
  offered only where Ember speaks replies. A Spanish reply no longer goes to a French voice (5 of 15 sample replies
  did), more whole French, Italian and German sentences get their own voice, and an English answer's closing question
  after a passage read out in another language is said in Ember's voice. A second **Hear Ember** with no working voice
  answers in 3 to 8 seconds, not 12, and a path through a dot folder, a task list's boxes and inline tags are said
  sensibly.
- **`ember doctor` no longer says Ember can't speak** when it speaks in its own Kitten voice and only
  speech-dispatcher, its fallback, is missing.

#### Tasks and approvals

- **A question that ran out of time while you were away** keeps its task's card, marked “No answer in time”, with **Try
  again** there and in Home's Task activity, and notifies you; “What did I miss?” opens with how many tasks ended (“One
  task ended.”), not finished, and says the question wasn't answered, not that you stopped it. Ember's own line in the
  conversation, what it says aloud, Home's Today count (“2 got no answer in time”) and the state the card, the handle
  and Home give screen readers call it “no answer in time”, not “stopped”; What Ember did tags it “No answer”, its
  question's row reads “Ended” to screen readers, and what Ember tells itself of the task at its next turn doesn't say
  you stopped it. The bubble's note says Try again is on the task's card if Ember can't finish without your answer, and
  otherwise to ask again, and Stop everything clears the card.
- **A task's card that didn't finish, or whose question went unanswered, waits while you're away** from the computer,
  with its Try again, and gets its whole time once you're back. Home's Task activity offers Try again only while it
  can be pressed: once the card has gone, there is none, rather than a greyed-out one.
- **Saying or typing “try again” after a task that didn't finish** does what its card's Try again does, within ten
  minutes or for as long as that card offers it: it asks for that same request in your words, so the step you asked for
  isn't flagged as one you didn't, and the new try replaces the old card. It also hears “can you try again?”, a yes when
  Ember offers to try again, and a “try again” after you asked why it didn't work. A task near its step or time limit is
  told to wrap up, says what it had done if a limit stops it, and a new try is told when the earlier one did part of the
  work, never when it only looked at its window, a picture of it included.
- **A refused step says why on its task's card and in Task activity**, in Ember's own words (“Not allowed: Ember's
  accessibility helper isn't working”, “Not allowed: this is a Wayland session”), for a password prompt, a check Ember
  couldn't make, the helper, secure keyboard entry or a Wayland session, as a whole sentence rather than one cut off
  with “…” (only a Mac app with a very long name can still make the secure keyboard one too long for the card). It shows
  in the order it happened, after your Allow when it came after it, and refusals for one reason fold into one row (“Not
  allowed 6 times: …”), which in Home opens to list each step it refused, so what the task did before stays on the card.
- **At the actions-a-minute limit a task pauses** (“Pausing to keep to 40 steps a minute…”) instead of ending with a
  refusal.
- **A question about a step or a command you didn't ask for quotes your own words** on its “Your task:” line, never
  the model's rewording, and so does every question in a task that something on screen or a command's output tried to
  steer.
- **When a spoken yes isn't taken,** the question keeps its answer keys under the note, and Ember says them aloud.
- **After “Not now”, Ember takes no step it had lined up behind that one in the same reply** (it used to click the
  next), nor after an unanswered question, a refusal or a step that failed: it looks again and decides afresh. The card
  shows the turned-down step on its own row, its live line names the step at work, and the approval window's “Risky
  step” tag is readable in light windows (5.85:1, from 2.9:1).
- **A third task says it waits its turn** instead of “On it”, and Home shows it as “Waiting its turn”, with no clock, as
  it does for a task stopped before it began (never “Stopped · Took 3s”). Every outcome is worded as its card says it
  (“didn't finish”, not “failed”). When the accessibility helper can't read apps at all (Linux's accessibility bindings
  missing, no session bus, no Accessibility permission on a Mac, or the helper unable to start, as when Windows'
  accessibility bridge stops before it is ready twice in a row), Ember and its tasks say the helper isn't working and
  that the setup check says why, never to try again in a moment. After a read that only took too long, or a helper
  started again after another task's slow request, the task is told to try the step again.
- **Typing “stop” while a task is at work stops everything at once,** in the Ask box or in Home (also while Ember
  waits for running tasks before it reconnects), and so do “stop typing”, “abort” and “no, stop”. Home's conversation
  keeps your “stop” with Ember's “Okay, I've stopped everything.”
- **Task activity keeps finished tasks until you quit Ember,** also after Stop everything and your next request, and
  through a reconnect; signing out or another account clears it.
- **Screen readers hear why an Allow didn't count** (pressed too soon, or after the question moved on), and the
  approval card's key hints as they appear.

#### Safety and privacy

- **While a password prompt is open,** GNOME Shell's own or, on Linux, the window of a program that is only a prompt
  (GnuPG's pinentry, SSH's askpass, a polkit agent, GNOME's keyring prompter), focused or not, Ember reads nothing,
  sends no window text or titles, and takes no step in any app until it closes. It does the same while it can't tell
  whether one is open (the check fails or takes too long, the desktop lists an app it can't hand over, or the list of
  windows can't be read), and says so: that it couldn't tell, or, when its accessibility helper can't work at all, that
  the helper isn't working. It refuses a step then before asking you about it, a batch of spreadsheet cells included,
  or, with Work without asking on, before saying it is going ahead, so it never asks about or announces one it would
  refuse: a step done without asking is said and recorded only once the check right before it has passed, and What Ember
  did records only the refusal, never the refused step as done “Without asking”, whatever the task does next. While
  another window that asks for a password has the keyboard, such as one Ember knows only by its title, Ember neither
  asks to borrow your mouse and keyboard nor says it is borrowing them: it refuses the step, and steps it takes through
  accessibility, without the keyboard, go on.
- **A request carries only the window you're in.** The titles of your other windows go only when Ember looks over
  your screen for you, as when you ask what's open.
- **Send screenshots for tasks** (Settings › Apps & privacy, on by default) keeps tasks to the accessibility text when
  you turn it off, from the next look of a task already at work. Every screenshot a task sends is now recorded, by app
  and size, and listed in What Ember did, and the task's card says so (“Sent the model a picture of the window in
  Firefox”), its summary naming those pictures first.
- **Apps & privacy shows “What Ember reads, sends and keeps”,** the text you agreed to before Ember started, and Search
  finds it by words such as data, screenshot and audit. It says the never-look list is below, says so when screenshots
  are off, and under your organisation's lockdown says nothing Ember hears is sent anywhere, Listen once included. It
  follows your settings and your organisation's policy: with Work without asking on, it says Ember tells you what it's
  doing for ordinary steps instead of asking, it says when you let apps in without asking, and its line on other
  computers and commands says which you turned on and what your organisation turned off (other computers, WSL or
  commands on each kind of computer), also straight after a policy change (see For administrators). It keeps naming
  where your requests go after you change a setting with it open, and isn't redrawn under a screen reader for a setting
  that doesn't change it. Removing an app from Never look at or from the Always list says what changed.
- **More keys are hidden** from command output and logs: OpenAI, Anthropic, Stripe, Hugging Face and GitLab keys, and a
  password given to a program on its command line (`mysql -p…`, `curl -u user:…`, `docker login -p …`, `sshpass -p …`,
  `redis-cli -a …`, `htpasswd -nb user …`), SendGrid, DigitalOcean and Twilio keys, a Docker config's `auth`, a .netrc entry's password beside its login, a password that is its own element in a list of a program's arguments (a compose healthcheck, a
  subprocess list), a MySQL client's also in a Makefile recipe or a unit file, after a prompt such as
  `C:\xampp\mysql\bin>` or a comment mark, or run from a quoted `mysql.exe` path. A bare `-p` that prompts, and a
  variable, are left alone; Projects, task views and memory hold back a line that holds one.
- **With Ask only about dangerous commands on,** Copilot's words about a command no longer reach the system journal
  (`journalctl -t ember-audit`), only their size.
- **More steps ask.** With Work without asking on, Enter in a page's own address, URL or location field asks (it
  submitted the form), as does a search box on a payment page. Controls that grant access, bid, book, bet, sell, refund,
  change who can see something, add a member or turn a protection off ask every time; so do a button with no name inside
  a form or panel named for a risky act, a page's button with no name at all (as Ember's doubt), and any button of a
  payment page, which a real click used to miss. Ember never types into card-detail, cardholder or pass-phrase fields,
  and under a lockdown **Sign in** starts nothing at GitHub. In places this asks more than it should: a headline link
  such as “Reserve Bank raises interest rates again” or a tab named “Email” (though no longer as something you didn't
  ask for that keeps the rest of the task asking), any control on a page whose title only mentions a payment (the
  question now says why: “The window's title mentions billing, so this may pay for something.”), and “Disable Line
  Numbers” in a window titled for security.
- **Going past a warning asks every time.** “Enable Macros”, “Enable Content”, “Keep anyway”, “Open Anyway”, “Proceed to
  example.com (unsafe)”, “Turn off Safe Browsing”, “Load Remote Content” and their like ask by a click or by Enter,
  never with Always and never only announced, and the question says it goes past a warning or turns off a protection;
  “Go to page 2” and “Disable spell check” don't. In a dialog whose words ask (“Are you sure…?”), or a message box on
  Linux, an answer that doesn't back off asks every time, quoting the dialog: a browser's “Leave page”, “Reload”, “Close
  tabs” and “Resend” (on every system) and “No” to saving your changes; Cancel, Stay, “Not now” and “Remind Me Later”
  don't. In a window Ember could read only in part, a question written in it, as in a mail you're composing, makes its
  buttons ask too. With Work without asking on, Enter in a search box that also types a message or picks people (“Search
  or type a message”, “Search people to add”), or in a window for sending money or sharing, asks.

#### Commands and other computers

- **The first command after Ember starts fits the command window** (90 columns by 12 rows at the default text size)
  instead of drawing 100 by 30, with lines cut off and the end of the output out of view. After you enlarge the
  command window and close it, the next command starts at the size of the window it opens in.
- **A bash or sh loop on a command line (`for`, `while`, `until`) always asks first, however plain its body,** as in
  0.1.0 (“Ember can't tell exactly what this does.”): Ember judges the commands in a loop only once, so `for f in
  --hard; do git reset $f; done`, which runs `git reset --hard`, never runs without a question. Ember's own folder named
  in a loop is still refused first, and the card says what a dangerous command in it does. **An ordinary `if` runs
  without a question** when Ember has nothing to say about any command in it, and it has no `!`, sets no variable and
  changes no folder (`if [ -f package.json ]; then npm test; fi`). Any other `if` asks as a whole: one with a command
  that asks or writes over a file, even one that isn't there yet (`if true; then echo hi > out.txt; fi`); one with a
  `cd`, `pushd` or `popd`; one that sets a variable or has a `[[ … ]]` test; one that reads text Ember can't see; and
  one with a command run with PATH changed or a library preloaded (`if true; then LD_PRELOAD=./x.so ls; fi`), on this
  computer and on an SSH computer alike. Neither a loop nor an `if` starts with only the 4-second Stop, even when your
  words asked for the command in it, and a download made inside either is remembered, so running it later asks. A
  `read`, `mapfile` or `getopts` of text Ember can't see asks outside them too (`read -r l < notes.txt`), and so do
  zsh's short forms run from a bash script. A simple `[[ … ]]` test outside an `if` or a loop is judged as `[ … ]`, so
  `[[ -f package.json ]] && echo yes` runs.
- **Running a file the task downloaded still asks once it is renamed or copied:** after `mv`, `cp`, `ln`, `rsync` (with
  `-R` or `--files-from` too), `tee`, `dd`, `cat x.py > y.py`, `dos2unix -n`, `sort -o`, `split`, a `tar` or `zip` of it
  unpacked again, a copy through `xargs` or one named by a cut of its address (`cp "${url##*/}" run.py`), after
  PowerShell's `Copy-Item`, `Move-Item` and `Rename-Item` (also in a pipeline) and `New-Item` links or cmd's `copy`,
  `move`, `ren`, `xcopy`, `robocopy` and `mklink` on Windows, and when `make`, `pytest`, `npm`, `python3 -m` or `node
  -r` picks up a downloaded Makefile, test file, `package.json` or module, the card says “Runs a file downloaded in this
  task.” A downloaded data file copied, moved, rsynced or robocopied into a folder, in WSL too, marks only that file, so
  `npm test` or `make` in that folder doesn't ask because of it where Ember can tell which folder it is. After files
  Ember can't name are copied into a folder, running or reading a file from there asks, while the folder's own tools ask
  only when a download could be one of their files.
- **A download whose saved name Ember can't tell asks** (“Downloads to a file Ember can't name.”): one the server or a
  list names (`curl -OJ`, `wget -r`, `wget -i`, `aria2c -i`), one saved under a name or folder held in a variable (`curl
  -o "$f"`, and the same with wget, aria2c, axel, fetch, lwp-download or PowerShell's `-OutFile`) a WebClient's
  `DownloadFile`, and one fetched from an address held in a variable or fed through xargs (`curl -LO "$BASE/run.sh"`,
  `wget $URL`, `xargs curl -O < urls.txt`). `wget -x` marks the folder it makes, `http -d` asks, text fetched into a
  variable and written to a file marks that file, and a file handed over by `gh run download`, a bucket, `docker cp`,
  `kubectl cp`, `scp` or `ssh host cat x > x` counts as a download. Afterwards running a file from the folder it saved
  into, or that folder's build tools and test runners, asks too (anywhere, when Ember can't tell the folder). A variable
  attached to curl's short option (`curl -o"$f"`) still gets past this: that download runs without a question, and
  running it later asks nothing, as before. Where the file that runs has no name Ember knows, the card says “May run a
  file downloaded in this task: …”. A file fetched through `env -C` or `sudo -D` with the shell's `>` counts as
  downloaded where the shell put it, and a downloaded patch applied (`patch`, `git apply`, `git am`, also with `-d` or
  `-C`) or code pulled from an address (`git pull https://…`) marks the files it changes, so the next `make`, `npm test`
  or build script there asks.
- **What a download brings in asks in more ways.** Once a task has downloaded anything, a build tool, test runner or
  `python3 -m` in a folder Ember can't name asks (“May run a file downloaded in this task”), so `git clone …; cd app;
  npm test` asks as `cd app && npm test` did, and so does `cd src; npm test` after an unrelated download. Java (`-jar`,
  `-cp`, a source file), mono, wine, `node x`, `awk -f`, `sed -f` and `psql -f` given a downloaded file, and `go run .`
  or `cargo run` over downloaded code ask; a compiler's output, a decompressed file and `dpkg -x`'s folder keep the
  mark; svn, hg, rclone, `pip download -d`, sponge, `gh gist clone` and `git submodule add` mark where they save; and
  curl's `-K`, wget's `--config` and an sftp, ftp, lftp, tftp or smbclient session count as a download Ember can't name,
  unless Ember can see that all it does is send. Fetched text given to a program that writes a file it reads (`curl -s
  URL | make x > x`) asks.
- **A variable that names the program a build tool runs is read:** `CC='sh -c "curl …|sh"' make` asks as `make CC='…'`
  does, and so do `GOFLAGS=-toolexec=…`, `TAR_OPTIONS=--to-command=…` (and tar's own `--to-command`, `-I` or
  `--use-compress-program` given a variable, or GNU's `-F`), `PYTEST_ADDOPTS='-p …'`, cmake's compiler and npm's
  script shell holding a command, while `CC=clang`, `CFLAGS=-O2`, a connection string, a filter such as
  `TEST_FILTER='unit|integration'` and a linker's name run. An rclone copy with more words than it takes asks (“Ember
  can't tell where it copies files to.”).
- **rimraf, del-cli and other deleters ask or are refused as rm is:** `rimraf ~` and `yarn run rimraf ~` are refused,
  `rimraf src` asks, and so do grm, scrub, gvfs-rm, trash-rm, fdupes or jdupes with `-d`, bfg and git-filter-repo. A
  pattern they expand themselves is judged as one, and one whose braces, read as the shell reads them, reach Ember's
  folder or your home folder is refused. A program Ember doesn't know, given your home folder, a folder that holds it
  or one holding Ember's files, asks (`mytool ~`, `stow -t ~ dotfiles`); `cd build && qmake ..` and `./configure
  --prefix ~/.local` run.
- **Where every command asks because commands run as root or an administrator,** Settings shows **Ask me before every
  command** on, with “Commands here run as the administrator, so Ember asks before every one.” under it, and it can't
  be turned off there.
- **Command questions say what really happens:** “the current folder” (“Deletes what it finds under the current
  folder.”) instead of “.”, “..” or “{}”; “Deletes everything in the current folder.” for `rm -rf *`, and after a cd the
  folder it works in (“Deletes everything in ~/Documents.”), as for an unpack; folders in your home folder from ~, as
  the command's header and its 4-second announcement write them (“Deleting ~/proj/build, as you asked.”); “each file the
  loop names” instead of “$f”, or the folders a short loop names (“Deletes ~/Documents and ~/Pictures and everything in
  them.”); “Removes packages.” for an uninstall and “Removes packages the project doesn't list.” for `npm prune`;
  “Deletes files in node_modules that .yarnclean lists.” for `yarn autoclean --force`, which always asks; “Deletes your
  scheduled jobs.” for `crontab -r` and “Replaces your scheduled jobs with the ones in jobs.txt.” for `crontab
  jobs.txt`; that a hard reset to another commit moves the branch; and what `git reset --keep` and `--merge` keep. Words
  that ask to install don't count for an uninstall.
- **Copying or moving a file into a folder** on this computer, in WSL or on an SSH computer asks only when a file of
  that name is already in it, and names that file. A copy that doesn't land at that name (`cp --parents src/a.txt
  ~/backup`, `rsync -R`, or a Mac's `cp -R build/ ~/Documents`, which copies what is in build straight into the
  folder) says “Replaces files in ~/Documents if they exist.” and asks whenever the folder is there.
- **A command you asked for in so many words no longer says “You didn't ask for this.”** When your words ask for that
  kind of step but not exactly this one, it says “Your words don't name exactly this, so Ember checks first.” Words that
  say not to (“don't git push yet”, “never force push”) or rule out the step's force or kind (“push without force”,
  “prepare the release (don't publish)”), and a step on what your words leave out (“delete everything except build/” for
  `rm -r build`), keep “You didn't ask for this.”; a step you asked for with a condition, an exception or a reminder
  (“push my changes if the tests don't fail”, “delete everything in build except .gitkeep”, “don't forget to push”)
  doesn't. A step your words name not to do keeps it (`rm -rf src` after “delete build/ but don't delete src/”), and the
  step you asked for doesn't (“delete build/ and don't delete anything else”); after “… and nothing else”, a step that
  does more than you named keeps it (`kill 1234 5678` after “kill 5678 and nothing else”, `crontab -r` after “show my
  crontab and nothing else”, or a force push you didn't ask for).
- **Only what the verb you used acts on can start a command with the 4-second Stop.** One whose object your words keep,
  leave out, place or only describe asks with the command's card instead: “delete everything but build/”, “delete dist/
  and keep build/”, “other than” and “instead of”, “kill 5678, 1234 is my editor” for `kill 1234`, “stop apache and
  check nginx” for `systemctl stop nginx`, “delete my old branches, main and develop stay” for `git branch -D main`, and
  “delete the build folder in dist” or “delete dist's build folder” for `rm -rf build`, since a folder named after “in”
  or “from”, after “of”, “for” or “at” following a folder word (“the build folder of the frontend app”), or before “'s”,
  is where the path must be. So does one your words name only to place or describe something else (“delete node_modules
  in the frontend folder” for `rm -rf frontend`, “kill whatever is blocking 1234” and “kill the parent process for pid
  1234” for `kill 1234`, “stop the services that depend on nginx”, “delete the branches based on main”), a copy over the
  file your words read from (“overwrite config.yml with the contents of config.yml.bak” for `cp config.yml
  config.yml.bak`), and a dangerous step your words hold back: one they make conditional or put off (“delete src/ only
  after I confirm”, “if the build fails, delete src/”, “tomorrow”, “in 5 minutes”, “in case the tests fail”), ask to be
  asked about or shown first (“ask me first”, “show me the command first”, “run it by me”, “on my go”, “I'll say when”)
  or only ask how to do (“explain how to delete build/ and delete src/”). Everyday words don't hold it back: “as soon as
  possible”, “if it exists”, a leading “wait,”, a later time for another step of yours (“delete build/ now, I'll rebuild
  later”), “let me see the output” and “say if it worked”, and “stop apache, then nginx”, “stop apache. nginx too.” and
  “1234 is hung, kill it” are announced. Saying the verb again or listing after a colon still counts (“delete build/ and
  delete dist/”, “kill these processes: 1234 and 5678”), and a bare `gh pr merge`, which merges the current branch's
  pull request, asks when your words number one. A place said anywhere in your words that isn't where the command works
  asks too (“at the root of frontend/”, “on the server, delete the build folder”, “the frontend one”), as does a `cd` to
  another folder before the step. So do words that describe another folder than the one deleted (“delete the
  production build folder” for `rm -rf build`), a deadline, a day or each time something happens (“before Friday”,
  “each time the tests pass”) and a copy asked for first (“back up then delete the build folder”), while an order of
  steps (“before npm install”, “before we start”) is announced.
- **Ember refuses a command that reaches its own settings and records through a variable**, as it does when they are
  named. In bash and other POSIX shells that is through a loop's list (`for f in ~/.config/ember/*; do rm -f "$f";
  done`), an assignment (`d=~/.config/ember; rm -rf "$d"`), a pattern after a variable, `set --`, `printf -v`, a
  here-string given to `read`, `xargs` (`xargs rm -rf <<< ~/.config/ember`) or `mapfile`, a cut or a default of a
  variable (`rm -rf ~/.config/"${d%x}"`), a default's own text (`rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/ember"`),
  `${HOME:?}` (`rm -rf "${HOME:?}/.config/ember"`), a wrapper's option, its value apart or attached (`xargs
  --arg-file="$d/settings.json" echo`, `uv run --cache-dir="$d"`), the program's own name (`"$d/bin/ember"`), an
  `export` (or a `set -a` before it) that hands the variable to a program, or echo or printf printing it into another
  program or a file (`echo "$d" | xargs rm -rf`, as `echo ~/.config/ember | xargs rm -rf` is; only the shell's own echo
  and printf are read this way, so what `./echo` prints into a command asks); on Windows, through a PowerShell variable
  (`$d = "$env:LOCALAPPDATA\ember"; Remove-Item -Recurse $d`, `Join-Path`, or a pipe: `$d | Remove-Item -Recurse`). It
  refuses the same when the folder a command works in is its own, named after `cd --` or `pushd --` (`cd --
  ~/.config/ember && …`) or given to `patch -d` or `--directory`, however shortened. A command that only tests such a
  variable or prints it on the terminal (`p=~/.config/ember; [ -d "$p" ] && echo yes`), or gives it to a text filter
  that only reads it (`grep -q ember <<< "$d"`; never an awk or sed program that runs or writes what it reads), runs,
  and a refusal says whether Ember's files would be read or changed. A value it can't see at all, such as what `read`
  takes from a file or what printf spells in escapes (`printf '\056\056\057\056netrc' | xargs cat`), asks.
- **A flag doesn't hide what a command does.** Ember reads the options of the tools it knows as their manuals give them,
  so a switch doesn't take the file or the command after it for its own: `rsync --mkpath`, `shred -u`, `xargs -l`,
  `docker` and `podman run -P`, `cp --update`, `--reflink` and `--backup`, `install -b`, `redis-cli -c`, `make -j
  install`, `mvn -X deploy`, `grep --color` on a key file and many more ask, or are refused on Ember's own files, as
  they are without the flag, and `cp`, `mv` or `install` with no destination, or a container run with no image, asks. A
  file or folder an option names is judged as that file (`zstd -o`, `brotli -o`, node's `--redirect-warnings` and
  `--report-dir`, uv's and poetry's `--cache-dir`, `file -f`, `tar --listed-incremental`, `parallel --wd`, `sudo -R`). A
  job count runs as a number, a processor count or arithmetic of numbers, attached or apart (`make -j4`, `make
  -j$(nproc)`, `make -j $(nproc)`, `cmake --build build -j $(nproc)`, `ctest -j$(nproc)`, `pytest -n $(nproc)`, gradle's
  `--max-workers=$(nproc)`), and so does a variable given to make's `-j` apart (`make -j "$JOBS"`, `N=4; make -j $N`),
  while one attached to its option asks, whatever the command set it to (`make -j$N`, `N=4; make -j$N`, `./gradlew
  --max-workers=$N`), as do a variable given apart to most other tools (`mvn --threads $N`, `cmake --build build -j $N`)
  and a count the command read from a file (`X=$(cat jobs.txt); make -j $X`); `T=deploy; make -j "$T"` and `T='4
  deploy'; make -j $T` ask as `make deploy` does.
- **xargs is judged batch by batch.** `printf 'status\npush --force\n' | xargs -L1 git` asks about the force push, which the second batch used to run unjudged, and input of more than 32 batches asks.
- **A database change given on a client's input asks,** as one on its command line does: `redis-cli <<< FLUSHALL`, `echo
  'db.dropDatabase()' | mongosh`, one Ember can't see on redis-cli's line (`redis-cli "$CMD"`), and an SQL file fed with
  `<` whose name says it deletes (`psql app < drop_users.sql`), as with `-f`. A file redis-cli's options name is judged
  as that file: `redis-cli --rdb ~/.bashrc`, which writes a dump over it, asks, and onto Ember's own settings it is
  refused. With its options held in a variable, redis-cli asks as a change even for a read (`O='-h db'; redis-cli $O
  INFO`). Text another command prints into psql, mysql, sqlite3 or duckdb always asks (“It runs the text another command prints into it.”), SQL after `psql -Atc` or `mysql -Ne` is read as after `-c` or `-e`, and so do sqlite3's dot-commands that do more than show
  (`.sh`, `.o`), psql's `-o`, `-L` and backslash commands that write or run, and mysql's `--tee`, `--pager` and
  `--init-command`; onto Ember's own files they are refused.
- **Ember runs a Python virtual environment's programs by path** (`.venv/bin/python -m pytest`) instead of sourcing
  `activate`, which asked every time.
- **Every command the bubble tags “Risky step” gets the caution edge and a plain Allow** on its card, not only
  deleting ones.
- **Closing the command window while a command runs** makes **Keep it open** the highlighted choice and **Stop and
  close** the plain one. A finished command's terminal hides its cursor, very short runs say “less than 0.1 s” instead
  of “0 s”, command headers write your home folder as ~, and the empty command window says what it is for. Screen
  readers hear its “Starting Ubuntu…” line and a command card's hint as they appear.
- **On RHEL 8's OpenSSH, an SSH sign-in question** reads “A question while connecting to build-01”, says to read it
  before you answer, and says that Ember never keeps the answer. A long one, such as a two-factor menu, opens in a
  card that grows to fit it. The SSH install hint ends “then try again.” and no longer breaks inside openssh-clients.
- **Settings says “Ember asks first: answer in the window that opens.”** while a first-use card waits, and after Not
  now it says what stayed off (“Commands stay off on this computer.”).
- **Adding a computer whose name Ember can't find** no longer leaves the mistyped name in Computers; one whose name
  can't be looked up only because the network is down is kept. A long host name in Computers and Commands wraps
  instead of making Home scroll sideways at Larger text.

#### Models and extensions

- **Your own model server not running? Ember says so.** With Ollama or LM Studio stopped, Models & connections says
  Ember can't reach the model server on this computer instead of Connected, and its status stays still while the
  server is off instead of flipping to “Connecting…” every minute. A request asks whether it is running (“Is it
  running? Start it, then ask again.”), and so does Home's composer, keeping your message; the handle says “Can't
  connect”, and Ember connects once you start it, without waiting 24 seconds on your first request. A project request
  that finds your model server stopped takes Ember off Ready too, and Projects keeps that request's own reason.
- **Check again connects to your own model provider or your organisation's again** while one is in use, never telling
  you to sign in to GitHub, and says so while Ember still can't: that it can't connect when nothing answered, and that
  it still can't use it when the provider answered but a model name or a key is missing.
- **Your own model provider at a remote address reads “Using” and its address,** not “Connected”, says when no API
  key is saved for it, and the setup check warns about that. A model server on this computer that answered without a
  model list (Ollama's address without /v1) reads “Using” too, with “It answered, but without a model list: Test
  connection under Model provider says more.” With no model named, the status line points to the “Conversation model”
  field below.
- **Messages about a model service that isn't answering name the one in use,** your own model provider or your
  organisation's, when Ember reconnects and when it stops a task, not Copilot. One behind a proxy that refuses it, or
  whose name doesn't resolve, is said to be out of reach (“Check the network, then ask again.”). Under either, a task
  Ember's own connection cut off ends with “My model connection stopped unexpectedly; the task didn't finish.”, as the
  bubble's title says it, and the status lines say “Ember's model connection stopped…”, never Copilot, as do the status
  line about the computer's file-watcher limit and `ember doctor`'s row for it, “Ember's file watchers”.
- **Test connection names your provider's models** (“It lists 1 model: llama3.2:3b.”), and both model fields suggest
  them, so you pick the exact name instead of typing it blind.
- **The provider's note is announced when you enter its address,** a line under Test connection says why it waits, and
  once you agree it says where your requests now go and, after one check of that address, which models it lists or why
  it isn't answering as a model service. While it waits for you to agree to a new address with nothing else
  connected, Models & connections says so (“Not connected: Ember is waiting for you to agree to use …”) and points to
  the note or the switch, not to a GitHub sign-in. With no GitHub sign-in, a request from the Ask box or your voice gets
  “Your provider needs your OK…”, Home's composer names it (“Agree to use new.example.com in Models & connections, then
  send again.”), and Ember's hello at start, Home's tagline and its status button (**Check my provider…**) point to that
  note too, instead of asking you to connect Copilot. Without a keyring, the API key row says how to get one (GNOME
  Keyring or KWallet).
- **Changing the address of the provider you use keeps it in use until you agree to the new one.** Models & connections
  says “Ember still uses api.example.com. Agree to use new.example.com to switch.”, and **I agree, use this provider**
  checks the new address first: if it can't be reached or refuses the key, nothing has changed, and **Keep using
  api.example.com** puts the old details back. A gateway that answers 404, or with something that isn't a model list,
  changes nothing either: the line says so, and only a third button, **Use it as typed**, adopts it, the provider in use
  keeping its saved key until then. **Test connection** no longer says “Connected” to a web page (“… answered, but not
  as a model service does. Check the endpoint.”), and a 404 from your own provider that names no model says the
  endpoint's address may be wrong. Requests never go to Copilot in between, and turning “Use my own model provider” off
  meanwhile keeps the provider you were using, with its address and saved key, for when you turn it on again.
- **A switch of model service waits for what Ember is doing, then happens at once:** made while Ember answers or a task
  runs, it takes effect as soon as the answer ends, you press Stop or the last task finishes, so Ember's status names
  the service in force from then on, and a request you make meanwhile waits for it: Home says so under Send (“This goes
  to the new model service once what's under way now has finished. Stop response cancels it.”), with “Switching
  model service…” in its status panel, never “Thinking…”. A finished task's card stays through the switch it waited for,
  with its result, **Try again** and **Close** (unless the new connection fails or you sign out first), and its Try
  again waits for the switch. On the new service, Try again starts from your own words, never the goal or the screen
  text from the conversation before, and only for a task your request asked for alone; for one that came from a request
  split into several tasks, a routine or a reply such as “yes do that”, the card offers Close and says “The model
  service has changed: ask me again and I'll try it on the new one.”, so finished work isn't done twice.
- **Your extensions ask you to agree again, once.** A plugin from Copilot's built-in marketplace shows that
  marketplace as “Built into Copilot”, with no Remove that did nothing, and its card no longer says you added the
  marketplace. Because the card changed, no extension runs until you agree again.
- **Use extensions turns extensions off as a whole,** and a plugin you haven't agreed to no longer shows its switch
  on; only an extension's own card agrees to it, never another settings change. After you agree to an extension's
  tools, focus stays on it and Ember says it can use it now, not “again”. While Ember isn't connected, Extensions says
  marketplaces appear once it is, instead of an empty list that refuses Add, and a marketplace whose list Ember
  couldn't fetch or read says so, with **Browse again**, instead of “This marketplace lists nothing yet.” When the
  network or a proxy is in the way, Browse says to check the network, and Add names the address and says whether to
  check the address and the network or that it isn't a marketplace you can open.

#### Memory

- **Memory asks you to agree to its note again** if you had it on. The note now says what goes to Copilot with every
  request (what you asked Ember to call you, how you like answers and a few facts that bear on the request), and that
  while you're away its tidying sends up to 40 saved facts to Copilot up to 6 times a day. Ember now uses your name
  and answer style on every request, and **Spoken replies** in Tell Ember about you changes whether Ember speaks.
- **Memory refuses passwords, PINs and lock codes in the ways people say them.** It never keeps “The password for the HR
  portal is…”, “My password's…”, “VPN password hunter2”, shorthand such as “HR portal pw Summer2024!” or “hunter2 is my
  password”, “use … as the password”, a login with its password or said as one (“The user's Netflix login is hunter2”,
  “Netflix credentials: hunter2”), a PIN (“My PIN number is 1234”, “PIN code is 1234”, “Garage, PIN code: 482193”), a
  phone code (“My phone code is 4821”), a house, office, door or alarm code (“my house code is 4821”, “the code for the
  front door is…”), a vault, safe or key box code, an Airbnb, gym, shed or storage unit code, a Wi-Fi password said as
  its network security key, WPA2 key, pre-shared key or PSK, the answer to a security question, a CVV, a recovery or
  seed phrase, a social security number or an IBAN, nor a password written as a value in code or a script (`password =
  "Summer2024!"`, `PASSWORD=hunter2`, `export DB_PASSWORD=changeme`), nor one said as changed or current (“My Wi-Fi
  password is now BlueSky99”, “I changed my PIN to 4821”, “The password was reset to …”), given with its service
  (“Netflix: hunter2”) or under a router's label (“WLAN key: …”), after a network's settings (“Wi-Fi: HomeNet / WPA2-PSK
  / 5GHz / BlueSky99!”), as a recovery or one-time code with no “is” (“GitHub recovery code abcde-12345”, “verification
  code 482193”), as a Wi-Fi key labelled “Key:” under its network's name, as a UK sort code with its account number, a
  National Insurance number or a mother's maiden name, or after its state or how it is stored (“PIN: entered, 4821”,
  “PSK: rotated. It's BlueSky99!”, “Password: hashed, SHA-256, 12 characters, Summer2024!”). Codes that lock nothing are
  kept (“the access control code 401”, “backup exit code 255”, “our office ZIP code is 90210”, “Branch office code:
  4410”), and so are an Indian address's PIN code (“Bengaluru, PIN code: 560001”), how a token is made (“The access
  token is HS256-signed”), a password's state (“Passwords are hashed.”), a Wi-Fi key's state or where to find it (“PSK
  is enabled on the router”, “Network key: see sticker”), a change that holds no password (“The password is now
  required”, “I changed my password manager to 1Password”), a version, an issue number or a setting said as a login
  (“The login is v2.0”, “Credentials: AWS_PROFILE=dev2”), a disk's use (“Root: 45G / 100G”), a login that names a user
  at an IP address or localhost, a user at a computer both named in words or given with its port, a handle or a host
  with its port (“pi@192.168.1.20”, “jsmith@corp”, “@octocat”, “localhost:8080”) and code that names a token, a password
  or credentials with code for its value (`verify(token: string)`, `max_tokens=256`, `const token =
  process.env.GITHUB_TOKEN;`, `credentials = boto3.Session().get_credentials()`), so Projects requests and files, a
  reviewed patch and task views that hold them aren't refused. A user name with a digit said as a login (“my login is
  jsmith42”), or a user at a computer whose name has a digit (“admin@nas1”), is refused, as it may be the password, and
  so is a network note where a DHCP range, a subnet, a date or a router model follows another field (“Office network:
  CorpNet / VLAN 20 / 10.0.20.0/24”). Some shorthand (“The Wi-Fi is BlueSky99”), a code said with “'s” (“The gym's code
  is 4821”), and a password after “salted” in a note on how it is stored (“Password: hashed, SHA-256, salted,
  Summer2024!”) still get past it, so keep passwords out of what you tell Ember and the files you give Projects.
- **Passwords in code, settings and forms are held back in more of the ways a file holds them,** in memory, Projects and
  task views: a value under a key named for a secret in a Ruby or PHP hash (`:password => '…'`), a YAML mapping or list
  (`passwords:` with `db: …` under it), a pretty-printed JSON section (`"Secrets": {…}`), a Python dict or list or a
  dotted setting (`secrets.db: …`), `define('DB_PASSWORD', '…')` and `<password>…</password>`, a quoted passphrase
  (`ADMIN_PASSWORD="Key Lime Pie 2024!"`), a password a pretty-printed form or table puts on the line below its label or
  an empty field, beside an empty field, in a field's value or in a list's option, one in a password prompt's comment,
  and one given to a program on its command line (see Safety and privacy). Projects still sends login forms and password
  prompts (`getpass.getpass("Password: ")`, `<label for="password">Password:</label>`), OAuth clients (`TOKEN_URL =
  "https://…/token"`), UI text (`"forgotPassword": "Forgot your password?"`), locale files, a “Remember password” check
  box and build files that link MySQL, and takes requests such as “Add a token: string field to the Session interface”
  and “Set the API key to process.env.API_KEY”, but holds back a sign-up form whose line under its password field is a
  hint such as “Use 12 or more characters and a symbol (!@#$%^&*)”.
- **Memory says why it is paused.** While Ember connects, uses your own model provider or can't reach GitHub,
  Settings › Memory says so instead of suggesting Forget everything, Home says “Memory paused”, and Tell Ember about
  you no longer fails with “Try again”. While your own provider can't connect, memory says it waits for that, not for
  your GitHub account; under an earlier note, Ember says memory is paused until you review it; and first run's “Tell
  me about you” says why memory is paused and offers Continue.
- **Requests that start with “forget”, “remember” or “keep in mind” reach Ember while memory is off** (“Forget what I
  said, open Firefox instead”, “Forget my last message”, “Forget I mentioned it”). After answering a request to keep
  something it states, however it is said (“Remember my wife likes tulips”, “Make a note that Bob owes me £20”,
  “Remember my birthday: 12 March”, “Remember my kids love pizza”, “Remember that I'm vegetarian and book a table”, “I'm
  vegetarian, remember that”, “In future, remember I take my coffee black”, “Just remember…”, “Make sure you remember…”,
  “Bear in mind…”), or a request to keep what was just said (“Add that to your memory”, “Keep that in mind”), but never
  after “Remember the file I mentioned”, “Remember the file attached”, “Don't forget my car keys on the table” or a “…,
  remember” that recalls something you both know (“We talked about this yesterday, remember”), Ember adds that memory is
  off, so it won't keep this after Ember closes, with **Open Memory**. Asked to forget something about you (“Forget my
  address”, “Forget what you know about me”, “Delete my memories”), everything (“Forget everything”, “Clear your
  memory”) or someone (“Forget Priya”, “Forget Priya's birthday”, “Forget June's birthday”, “Delete your memories about
  Priya from Acme”) or something only its memory holds (“Delete everything from memory”, “Remove that from memory”,
  “Delete my email from memory”, “Remove what I do for a living from memory”), it says memory is off (and opens Settings
  › Memory at its search) or why memory is paused. Other forgets and clears reach the conversation, with nothing opened:
  “Clear all”, “Delete everything”, an app, a day, a device or a network (“Forget Outlook”, “Forget Monday”, “Forget May
  Day”, “Forget my AirPods”, “Forget my home Wi-Fi network”), what an app keeps (“Clear everything saved about me in
  Firefox”, “Delete my memories of Paris in Photos”) and the computer's memory or a program's (“Remove this tab from
  memory”, “Delete what my Python process allocated from memory”). Asked to forget something about you with more after
  it (“Forget my address and open Firefox”), Ember does the rest and then says memory can't change what's saved, and its
  **Open Memory** opens Memory's list, where Forget is. Neither promises what memory can't do.
- **No request lands on “I agree, remember”.** While memory is off, “Ember, get to know me” and the **Open Memory**
  after a request to remember open Settings › Memory at its note's words, and “I agree, remember”, like **I agree,
  work without asking**, ignores a press in the first half second after its card appears.
- **Undo after Forget.** The list says what went and offers Undo for a minute, also while memory is switched off.
  Pressing Enter a second time no longer forgets the next memory or learnt word, Forget all words asks first, and
  forgetting a learnt word in Settings › Voice says which went. Ember forgets a memory in conversation only when you
  ask, then names it (“Ember forgot: …”) with any notes of its own that went with it and what it remembers again, and
  offers Undo. Undo beside “Ember learned” or “Ember forgot” changes that line in place and keeps focus on it.
- **A fact you forget or correct stays forgotten** however the turn that said it is worded: a Forget, a correction and
  Forget everything drop what was said before them and not yet read, and a task you started in the conversation is never
  learned from after a later Forget (Ember learns those turns' other facts only when you say them again). **Settings ›
  Memory lists what is no longer true** (“No longer true since …”) after what holds now, each with its own Forget and
  counted with the rest, so a replaced fact is never kept out of sight.
- **What you ask Ember to remember is kept once:** reading that turn later no longer adds it again (one kept in quite
  other words, or a part of it, still may), and the turn's other facts are still learned, except one that only adds to
  the kept fact's own sentence.
- **Forgetting a fact forgets Ember's summaries and guesses made from it,** which the list now labels “Ember's
  summary” and “Ember's guess” instead of “From our conversation”, as a summary's Correct… form does.
- **Forgetting what holds now doesn't bring back the old value.** Forget “Works at Initech” and Ember no longer takes
  “Works at Globex” as current again. Undoing something Ember kept in the last ten minutes still puts the old value
  back, and now says so.
- **A change of mind replaces the old memory:** “Doesn't like Teams any more” replaces “Likes Teams”, and “Prefers
  light mode” replaces “Prefers dark mode”. A preference about another thing or place leaves it alone: “Prefers dark
  chocolate” doesn't replace “Prefers dark mode”. So does one of another kind: liking bulleted, spoken or casual
  answers keeps the answer length you gave in Tell Ember about you, which only another length (short to detailed)
  replaces, and the new length then goes with every request in its place.
- **“Call me Ram” keeps Ram.** In the spoken “get to know me”, Ember keeps just your name from “Call me Ram”, “My
  name is Ram” or “It's Ram, please”, and “Call me Ram” no longer ends the interview.
- **Sign out says which memory stays,** and when another GitHub account signs in, the new conversation says Ember
  forgot the previous account's memory.
- **Settings › Memory says when your saved memory couldn't be read,** was set aside (as `memory.json.broken`) or
  couldn't be saved. While it can't be read, Home's status line says “Memory paused”, Settings › Memory says what to
  check, and nothing new is kept: Ember says so instead of saying it remembered. A second broken file is set aside as
  `memory.json.broken.2`, so the first copy stays.
- **Only Forget is red in Settings › Memory.** Correct… is in the words' colour, a long memory's two buttons stay
  side by side (and apart in a contrast theme), and an empty list no longer says “0 of 0 memories”.
- **Faster with a large memory:** with 5,000 memories, Ember finds what bears on a request in about 20 ms instead of
  100 to 135 ms, with the same results.
- **A reconnect no longer wipes what you were doing in Memory.** A correction you were typing, your search, where
  focus was and a “Forgotten: …” line with its Undo come back once Ember has checked your GitHub account again, and a
  Better recall download carries on. Meanwhile, and after Forget everything, keyboard focus waits on the Memory
  heading, never on the memory switch, so typing on can't turn memory off.

#### Reliability

- **Ember notices at once when Copilot stops mid-answer.** It used to show a half answer as “Answering” for up to 20
  seconds; now it says the connection stopped within about 3 seconds and reconnects, and a running task's card says so
  as fast.
- **Ember no longer holds a processor core when whatever reads its printed log goes away** (`| head` or a closed
  terminal, with `EMBER_LOG_STDOUT=1`): it stops printing there, instead of rotating its own log away within seconds
  and ignoring a request to quit.
- **A Copilot that never answers no longer leaves Ember “Connecting…” for good.** Each step of connecting has a time
  limit; Ember then says “Copilot isn't answering. Ember will try again in a moment.” and tries again.
- **A crashing accessibility helper no longer spins a processor core.** One that crashed on every request was started
  again about 29 times a second; Ember now waits longer between tries, up to a minute, and still starts one at once
  when you ask for something.
- **Ember uses less of the processor while it rests beside your cursor.** Between its blinks, glances and fidgets its
  face is drawn about 6 times a second, not 18 to 24, and so is the rest of a glance once its eyes are where it looks
  (not 30 to 45), and it moves 10 times a second instead of 60 once it and the pointer are still. On a computer without
  a GPU, with listening off, idle use went from about 11–15 % of a core to about 6–7 % (listening for “Ember” adds to
  that). Home doesn't draw its resting characters while you're working in another window, which saves about 3 % of a
  core more while it is open. Listening for “Ember” in silence with Home open, as the Linux packages listen, it measured
  about 11–15 % of a core awake and about 6 % once dozing, and about 700–790 MB in all (about 900–950 MB with the
  WebAssembly listening used where the native one can't run), not counting the Copilot runtime, about 100 MB more.
- **Opening Home or the stop shortcut no longer waits 5 seconds each time** when Linux's accessibility bindings hang:
  after its first look, Ember looks for them in the background, and so does **Check again** in the setup check, so
  Ember and its stop shortcut keep working meanwhile. Bindings installed while Ember runs (`sudo dnf install
  python3-pyatspi`) are found at a request soon after (Ember looks again at most every 2 seconds), without restarting
  Ember, and then work as they do after a restart, so a dialog that one of Ember's clicks opens in a GTK app can't
  leave that app hanging.
- **On a Mac, Ember checks for a password prompt before you give it the Accessibility permission,** so a task can
  still open an app; reading apps still needs the permission, and Ember points to the setup check for it.
- **Home tells you when Ember closed unexpectedly last time,** and the log records it, so a crash can be told apart
  from a quit. Logging out of GNOME on Xorg counts as a quit.
- **A settings.json that can't be read at all is said as such** (“…every setting went back to its default…”, with where
  your version is saved), and a conversation the disk had no room to save says “I couldn't save this conversation: the
  disk (or your storage quota) is full. Free some space, then ask again.” instead of blaming the model service.
- **When something in Ember's data folder keeps it from starting**, such as a file where its audit folder goes, the
  dialog names what is in the way and says to move it away, then start Ember again, instead of showing a raw `EEXIST`
  error; a full or read-only disk, or a data folder you can't write to, is said as such (on Windows, with a check that
  security software isn't keeping Ember out, never the advice about sudo), anything else in plain words that say to
  reinstall Ember or report it if starting again doesn't help, and the dialog names the log that has the details when it
  could be written.
- **On Windows, the setup check's Screen reading row keeps up with the accessibility helper.** **Check again** asks the
  helper afresh, and so does reading starting to fail or working again, instead of showing what it said 10 seconds after
  start. When the helper didn't start, the row says why in plain words (Windows PowerShell stopped before it was ready,
  couldn't set it up, couldn't be found, wasn't allowed to run (a policy such as AppLocker included: see For
  administrators) or is restricted on this computer, or the helper is out of date), never .NET exception names, error
  codes or paths in your user folder; `ember doctor` still shows PowerShell's own words.
- **About this build shows where the log file is** (Setup & about), with **Copy** for its path and **Show in Files**
  (Finder on a Mac, File Explorer on Windows), and the troubleshooting guide says what to do when Ember is slow or busy
  and what to share in a report.

#### Install and docs

- **The README says what Ember needs before you download it, and what its first start asks:** a Copilot account (or your
  own provider), GNOME on Xorg, about 1 GB of disk and about 900 MB of memory (about 1.1 GB where listening runs on
  WebAssembly), then the welcome's six steps and the ask, stop and settings keys on each kind of computer. It says how
  to start the AppImage, which adds no apps-menu entry, that Kokoro and Supertonic are Windows and macOS voices (on
  RHEL, Ember's own voice is Kitten Nano), and where Ember's log is when you report a problem. Its sign-in and
  own-provider steps match first run and Settings › Models & connections.
- **Computers without internet access lists the optional downloads,** each with its size and where it comes from:
  Hear me more clearly, the Kokoro and Supertonic voices and Better recall. It also gives Linux's machine-wide speech
  models folder, and the README says how to update the AppImage.
- **The npm launcher says so when its version's release isn't out yet,** instead of an HTTP error. It downloads through
  the proxy npm uses (see For administrators), and when it can't reach the download it says why in one sentence and what
  to do (the proxy setting, the browser download or a mirror): an error answer names the host that gave it, a server's
  own failure says to run `ember` again later, and a full disk or quota says there isn't room in its cache folder,
  naming the folder, and to free some space or set `EMBER_NPM_CACHE`. Pressing Ctrl+C or closing the terminal during its
  first download, while it unpacks Ember or while it clears a Mac's quarantine flag removes what it had made and starts
  nothing (“Stopped before Ember 0.1.1 was installed, and nothing was kept.”), so the next `ember` downloads again; a
  stopped `ember --npm-reinstall` keeps the copy you had, and `ember` starts it. After a crash the next `ember` takes
  over the stopped download. `ember doctor` through it shows the setup check's report and exits with its code, and an
  Ember that stops as it starts (no display, for example) says why instead of being reported as started; on Linux
  without a display it says to run `ember` inside your desktop session, before it downloads anything. `ember --help`
  says what Ember and the launcher take, and the launcher names the mirror it downloads from when one is set. After an
  update it removes older versions from its cache once the new one has started, so an `ember doctor` run first doesn't
  leave **Start Ember when I log in** pointing at a removed copy; when an older Ember still running takes the start
  instead, it says so (“Ember 0.1.1 is already running…”) and keeps them; on Windows, with no other version in its
  cache, it says “Ember was already running, so it took this.” and what to do if that is an older Ember you installed
  from the zip. Its README gives update steps, and uninstall steps in an order that works. The AppImage takes `--doctor`
  as well as `doctor`, and `--help`. The RPM's `ember --help` says to run `ember` again for its settings instead of
  naming Ctrl+Alt+E, which another app may hold.
- **The npm launcher says in plain words what stopped it, with a next step.** A cache folder it can't write in (another
  user's, after a run with sudo, or on a read-only disk) is said as such, not as “EACCES: permission denied” (only
  `ember doctor` on a Mac still shows Node's own words there), and the copy already there still starts. A web page, such
  as a Wi-Fi or proxy sign-in, sent in place of the release's `SHA256SUMS` is said to be one, without repeating it, and
  a download that doesn't match `SHA256SUMS`, or that it has no line for, comes with what to do. A failed
  `ember --npm-reinstall` says the copy you had is kept and that `ember` starts it. When this computer won't let Ember
  start (a security policy such as fapolicyd, antivirus, or a disk that doesn't let programs run), `ember` and
  `ember doctor` say so and what to do, not “spawn EACCES”. On a disk that has filled since Ember was installed, `ember`
  still starts Ember and gives the terminal back, and if Ember stops as it starts, what it said is printed even where its
  old start log belongs to another user (after `sudo -E ember`); where `ember` can't keep even a private copy of that, it
  says to run `ember doctor` to see it.
- **Clicking the notice that a new version is out opens Updates** in Ember's settings, and the update check keeps to
  once a day, also when you restart Ember; a newer version it found still shows after a restart and after a later look
  fails, with **See what's new…**. Under “Version X is out.”, Updates says how to update your kind of install (the RPM,
  the AppImage, the Windows zip, the Mac's dmg or the npm launcher), with the new version's file named in each
  command, set as code: for the RPM, `sudo dnf upgrade ./ember-0.1.2-1.el8.x86_64.rpm` in the folder you saved it to,
  never a bare `sudo dnf upgrade`. Screen readers hear it once as it appears, not again each time a check brings the
  same words.

### A real conversation on 5 November

- **The microphone note names who gets your words.** It always said Copilot; it now names your own model provider or your
  organisation's model service (host only) when that is what answers, and follows a change while it is open.
- **Ember hears you over its own voice again.** The tail of its own voice counted as other sound playing, and from then on
  it threw away everything said without its name, right through its next sentence.
- **Talk over a song.** With a song or video on, Ember now also hears you without its name once it knows your voice.
- **A more natural voice.** Choose **Supertonic** under Settings › Voice (129 MB). It sounds more natural than Kitten Nano
  and is fast enough where Kokoro isn't. Windows and macOS only.
- **Hear me more clearly.** A new switch under Settings › Voice downloads a bigger speech model (482 MB) that makes about
  half as many mistakes, above all with an accent or across a room. It takes about 0.2 s longer a request and 550 MB more
  memory, and it runs on your computer like everything else Ember hears.
- **Close, Try again and Stop work on a task's card.** A click that lasted longer than a moment was thrown away, because
  the button shrinks a little as it's pressed and Ember took that for the button having moved.
- **Ember clicks videos on YouTube again.** It refused any page that changed while it worked (a hover preview playing) and
  any link with the same name as another (a video's thumbnail and title). A step that needs no question now only checks
  the control itself. Risky steps and anything in a dialog are bound as tightly as before.
- **Ember keeps listening.** Once you've called it, just keep talking: no name, no eight seconds, no limit on turns. It goes
  on hearing you while it speaks and while its tasks work, until you say “That's all” or 30 seconds after everything has gone
  quiet. **Keep listening after I call Ember** under Voice turns it off.
- **Cut in whenever you like.** Ember's voice drops the moment it hears you, stops once it's sure the words aren't its own,
  and answers what you just said with the rest in mind. A running task carries on, and what you said reaches it if it
  changes the task. “Yeah” and “mm-hmm” don't interrupt.
- “Hey Ember” and “Ember” are heard far more often: speech recognition's “Hey, number.” and “A number.” were being taken for
  other words, and a name said on its own needed spelling right.
- Better speech recognition: Moonshine v2 base, where 0.1.0 had Moonshine tiny.
- With a song or a video playing, Ember hears only what is said to it by name, so it doesn't take the words for requests
  (Windows, and Linux with `parec`; on macOS a conversation can't tell yet).

### Fewer questions while browsing on 5 November

- With **Work without asking** on, Enter in a browser's address bar or a page's search box, a long address, moving between
  pages and tabs, and closing a tab you asked to close no longer ask. Chat boxes, forms and composers still do, and so
  does a search box that also types a message or picks people, or one on a payment page or in a window for sending
  money or sharing.
- A link whose title has a risky word in it (“Post Malone”) no longer asks, or holds the whole task to asking.
- Every button on a checkout, payment or billing page now asks, as do “Activate now”, “Start free trial” and “Upgrade now”.
  “Activate now” on a checkout page had gone through unconfirmed.
- Store apps such as ChatGPT and WhatsApp can be opened: Ember used to say they weren't installed.
- A key you had just allowed no longer fails with “can't tell which window” when the page's title changed meanwhile.

### Light mode on 5 November

- Home, the command window and Ember's password and consent windows now have a light look, and by default match the
  computer's light or dark setting. Choose Light or Dark under Comfort & access › Appearance. Ember's bubble, task cards,
  handle and ask box stay dark, so they read clearly over any app.

### Update notices on 5 November

- New, off by default: **Tell me when a new version is out** under Updates. With its note agreed to, Ember asks GitHub
  once a day and tells you once per version. It sends no sign-in and never downloads or installs anything. An
  administrator can turn it off with `features.updates`.

### Review fixes on 4 November

- Memory: a `memory.json` that exists but can't be read (a virus scan's lock, a permission) is tried again and is never
  saved over; the next start finds it whole. Memory is flushed to disk before it replaces the old file.
- Reconnecting: a failed GitHub account lookup is tried three times before the conversation is ended, so waking from
  sleep on a network that is still settling no longer loses the conversation or the selected project.
- Projects: a workspace library that can't be read is set aside as `.broken`, with a message, so new workspaces can be
  saved. Making a model session has a time limit, Cancel ends it at once, and a project request may take 2 minutes.
- Safety: the Copilot session that reviews commands is checked, like every other, to hold no tool Ember didn't give it.
  At most 40 actions a minute now counts all tasks together. `tailscale` is classified: `funnel`, `serve` and
  `file cp` ask as publishing, `up`, `down`, `set`, `login`, `logout` and `ssh` as system changes.
- Idle cost: the handle's face stops drawing once it has dozed off and settled, and a question no longer works through
  every remembered fact again unless one changed.
- Wording: sign-in says a GitHub account needs Copilot before the browser opens, and common refusals say who can fix
  them, without “seat” or `gh auth login`.

### UI and speech follow-up on 4 November

- The Ask box has a Send button, controls that grow with the text size, suggestions that wrap, and scrolls where there
  is little room.
- Home holds the conversation, with search, Copy for a whole answer, Edit then Send, and Stop response apart from Stop
  everything. A late update can't bring back another account's draft or conversation.
- Projects has a pane of its own: you can remove its files one at a time and see their sizes, a running request keeps
  the files and model service it started with, code and changes show as text to read, and a reviewed answer is saved
  only through the system's Save dialog, never over a file you chose or Ember's own data.
- **Open approval** opens the very question that is waiting, in a card you can reach with the keyboard. A click counts
  when you let go over the same, unchanged button; moving away first cancels it. Reading a task's details, or More
  time, keeps its card up longer.
- Settings › Memory keeps keyboard focus where it was, says whether a Forget really worked, and has search, a filter
  by where each fact came from and pages. A correction is saved before it shows, keeps where the fact came from, and
  stops recall and learning from using the old words. Search settings lists its matches with their labels, to choose
  from.
- Upcoming reminders show their words, when they are due in your time and whether they last past a restart. A change
  that can't be saved leaves the reminder as it was, changing only its words keeps its time to the second, and
  deleting them all says what goes before you confirm.
- Ember's desk can show you the text of an app on it when you ask, to read only, with private fields left out, and
  only while you have agreed, the screen is unlocked and it is the same desk.
- Speech recognition keeps words and numbers you repeat on purpose and still drops a sentence it repeated by mistake.
  Ember's voice lets go of its memory after two minutes unused.

### Reliability fixes on 3 November

- A command on another computer can't hide its real exit code or signal behind what it prints.
- Two requests to turn the same check box on no longer turn it off again: each looks at the box again once it has the
  window to itself.
- Stop and a task's time limit work even when a task hangs while it starts or sends its request, and nothing left over
  starts after a stop.
- A reply you cut off doesn't start speaking again from late pieces of it. Requests waiting their turn, typed or
  spoken, each keep their own way of being answered (out loud or not, listened after or not); a short “No” still
  answers when Ember asks what you meant.
- On Windows, a window brought up while Ember lists the windows is no longer missed.
- On Windows, Ember knows the saved-credentials dialog by both its spellings, and won't type a program into Explorer's
  address bar.
- On Linux, Ember knows the buttons of newer accessibility releases, those that show a password included, and a click
  on a check box in a list goes to the box instead of selecting its row.
- When Kokoro is too slow on a computer, Ember remembers that for a week instead of timing it at every start, and
  times it again when the model or how it runs changes.
- Extensions take tools with dots in their names, remember each tool's whole description, and give sign-in advice that
  fits the service. Settings says plainly that hosted connectors aren't available yet, and how to add plugins with MCP
  servers.

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
