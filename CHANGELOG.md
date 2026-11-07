# Release notes

## 0.1.1 (2026-11-03)

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
  and what it found. A task waiting for you says where it asks and which keys answer. Kept until you quit.
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
  with nothing to choose or tick (it says "Answering a message box in …"), types a list or a letter with line breaks
  into Notepad, gedit, TextEdit or another plain text editor with the borrowed keyboard, and fills spreadsheet cells,
  all announced. A dialog with a Cancel, a check box or any other control, or one that asks a question, says what has
  happened or will happen or is long, is cut short, is a web page's, an installer's or a permission prompt, or is in a
  language Ember doesn't know still asks, and so do line breaks in an editor's console or any other app, keys Ember
  can't be sure of (Alt+letter, unknown shortcuts) and dangerous commands. Its card says so, and asks you to agree
  again. While Ember runs as an administrator (or as root) every command asks, and the switch's hint now says so.
  Filling cells after you said no in a task now asks again, as every other step does.
- **Answer questions by voice**: while Ember asks, “Ember, allow” (with Voice Match on and recognising you) or “Ember,
  not now” (anyone) answers it. Never “Always”, never Ember's own voice, and a command card or a long text only once
  all of it has been shown. The audit log says the answer was spoken. Half a second of your voice after “Ember” is
  enough to recognise you, and a shorter yes counts for the questions of a task you asked for in your recognised voice,
  within 10 minutes (never a command card, a consent card or another task's question; the audit says
  `trust: "task-voice"`; not a yes too quiet or clipped to tell, either). A yes asked as a question, or a bare
  “okay”, isn't one.
- For administrators: `features.autonomy: false` turns Work without asking off (managed); so do `allowGrants: false`,
  `confirmEveryAction` and a lockdown. `features.aiReview: false` sends no command to Copilot for review, so every
  command Ember's rules flag asks (**Ask only about dangerous commands** shows off, managed).

### Voice

- **Call Ember by its name**: “Ember, open the terminal” (“Hey Ember” and “OK Ember” work too). The name heard inside
  another word (“remember”, “September”, “the embers”) shows nothing: a wake by the bare name shows once the recogniser
  has heard the name start what was said. While Ember speaks, “Hey Ember” makes it stop and listen, on Windows and
  macOS too.
- **Ember speaks in its own voice**, Kitten Nano 0.8 (its voice files are 63.8 MB), made on this computer sentence by
  sentence while Copilot is still writing. Should it be missing, fail or be too slow, the system's most natural voice
  speaks (a Natural voice on Windows 11, a Premium or Enhanced one on a Mac). **Voice** in Settings › **Voice** also
  offers Kokoro (350 MB), downloaded only once you choose it, which speaks where the computer is fast enough for it.
- **Ember speaks out loud by default** now; 0.1.0 spoke only while a screen reader ran. Choose Always, When a screen
  reader runs or Never in **Speak replies, questions and results out loud** (Settings › **Voice**; an organisation
  that turns speaking off shows it as Never, managed).
- **Native speech on every computer**: listening and Ember's voice run on sherpa-onnx's native build, about three times
  faster to hear a request than on WebAssembly. On Windows and macOS that is its native addon; the RPM and the AppImage
  carry its own libraries (sherpa-onnx and ONNX Runtime, 32 MB installed, about 9 MB of each download), on which
  hearing a request takes about a third of the CPU. Nothing more is downloaded. Where they can't run, listening runs on
  WebAssembly and replies use the system's voice; `ember doctor` says which under **Speech**.
- **Voice Match**: Settings › **Voice** › **Answer questions with my voice** teaches Ember your voice from four short
  phrases. It decides only whose voice may answer Ember's questions (above), never who Ember hears. "Ember, stop" still
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
  to your verified GitHub account, and you can review and forget each fact. It never keeps passwords, codes or card
  numbers.
- **Ember learns on its own** while memory is on: after you talk and when a task finishes, it picks out what's worth
  keeping (your preferences, your work, the people and apps in it), tidies its memory while you're away, and at most
  once a day asks about a name it keeps finding nothing on (**Ask me questions now and then** turns that off). Only
  what you say yourself counts as yours; what it reads on screen or in a task's result never does, nor speech it can't
  tell from its own speakers, and it never learns an instruction or a one-off order as a preference. A new fact shows
  in the conversation as "Ember learned: …" with **Undo** (which puts back what it replaced); "Ember, forget that"
  works too. The list says where each fact came from.
- **Tell Ember about you**: what to call you, your role and work, the apps you use most, how you like answers, your
  timezone or hours, each optional, in Settings › Memory and as an optional step of first run. Or say “Ember, get to
  know me” for a short spoken version.
- Memory's note says all this. While a changed note waits for you to agree, Ember remembers nothing more (Home says
  "Memory paused"); what it kept stays until you do. Learning uses a few short requests of its own (at most 12 an hour
  and 60 a day, plus 6 a day while you're away).
- For administrators: `features.memory: false` (and a lockdown) turns all of it off.

### Better recall

- **Ember finds what you told it when you ask in other words** (Settings › **Memory** › **Better recall**, shown while
  memory is on): "Who is my manager?" finds "Priya leads the platform team". **Download (23 MB)** fetches a small
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
  did; anything that changes or sends something asks you every time, with no "Always". After "Not now" Ember doesn't
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

### Product audit fixes on 7 November

#### First run

- **First run names the service Ember uses.** Once your own model provider answers, it says so instead of “Connected
  to Copilot”, and Back from the setup check returns to the provider's step. Where your organisation turned your own
  provider off, first run no longer offers it.
- **Under your organisation's lockdown,** first run and Home say Ember is locked down and why, with no Connect Copilot
  button and no raw policy error.
- **A model server on this computer (Ollama, LM Studio) works in first run without an API key,** also where there is
  no keyring.
- **A failing own provider is explained as the provider's problem,** with **Check my provider's details**, never as a
  Copilot or GitHub account problem.
- **After an update that changes how Ember works,** first run opens at its consent page and lists what changed since
  you last agreed.
- **Keyboard focus stays put:** first run's quiet buttons (Skip for now, Cancel, Personalise memory…) keep it when
  Ember's status changes, and after Not now it moves to Agree. After **Turn on** for screen reading, first run keeps
  telling you to restart the apps that were already open.
- **The setup check says the same everywhere.** A row that keeps Ember from reading apps counts as one to fix in
  Home, its badge and `ember doctor`, as it does in first run. Home's setup check uses first run's words for each
  row's state and offers **Copy** for a command to run, and **Check again** reads the setup afresh after you run a
  command or change a setting yourself.

#### Home

- **The composer stays in view while a reply comes.** After you send from Message Ember, the reply growing above it
  no longer pushes the box and its Send below the window; nothing moves if you scrolled away to read.
- **The composer and Task activity are within reach.** Home shows the latest 6 messages (**Show earlier messages**
  has the rest), and its status panel has **Write to Ember** and **Task activity** links.
- **Read the last answer opens Home at that answer,** focused and from its top, not at the oldest message. So does a
  long answer's **Open conversation**.
- **Sending clears a search left typed in,** so your message and Ember's reply show.
- **A long paste is kept whole.** Message Ember counts characters from 1,800 and won't send more than 2,000, saying
  how many too many, instead of cutting the end off without a word.
- **Messages kept from before a restart are marked.** A line under them says they are for reading and Ember starts
  afresh below, and they show their day.
- **Home says Ember is thinking, then still waiting,** while it answers what you sent there, and names **Stop
  response** after 10 seconds with nothing written. **Stop response** with nothing under way says so instead of
  showing “Okay, I've stopped.” in the bubble.
- **New conversation asks first** while there are messages to clear, and says when it will also delete the copy saved
  on this computer.
- **A message sent while Ember connects, reconnects or is offline says why,** and that it is still there, instead of
  sending you to Models & connections.
- **Home names your computer's send key** (Ctrl+Enter, or Command+Enter on a Mac), and a message's **Copy** says
  Copied.
- **Keyboard focus stays on a running task's Stop task** (and Show app, a steps row, Open approval) as the task takes
  its next step, instead of dropping to the top of Home.
- **Search settings shows each result in the page's own words,** one sentence of a long footnote, and finds the
  conversation's history, deleting, starting at log-in and the shortcuts by everyday words.
- **What Ember did shows its whole record a page at a time** (**Show earlier**), counts all of today's steps, and
  keeps what it showed, with a note, when the record can't be read. It tags an “Always in” answer as “Always allowed”
  and says what that changes, shows “Without asking” whole, and names password managers properly (KeePassXC,
  1Password, Passwords and Keys).
- **Projects says why a request failed** (a refused API key, a usage limit, files too long for the model) instead of
  always “Try again”. Minimising or hiding settings no longer cancels a project request or a project command: the
  answer is there when you come back. **Run a project command** says commands are off before you type one, with
  **Open Commands**.
- **Projects and reminders look like the rest of Home:** one prominent button per group, Home's chevrons on their
  disclosures, buttons that keep their size and no blank bands. The question before deleting all routines and
  reminders reads properly (“Delete your routine?”, never “1 routines and 0 waiting reminders”).
- **In Windows contrast themes,** Ask's eye, a task view's section chevron and the Projects tile show as the others
  do, and Apps & privacy and Comfort & access no longer scroll sideways at 200% zoom with Larger text.

#### Ask and the companion

- **The Ask box opens beside the answer or question Ember is showing** instead of covering it, and its field no
  longer jumps when your first letter puts Ember's suggestions away. On Linux, a click beside it reaches the app
  underneath and closes it.
- **The Ask box says when Ember can't answer yet** (“Not connected: I can't answer yet”) before you type, not after
  you send. When Ember will see nothing, the line under the field shrinks to its keys.
- **Esc while an input method is composing a word** cancels the word, not the whole Ask box.
- **Listen once shows as unavailable when Ember can't listen.** Without the speech models, Ask offers “Set up voice
  in Settings…” instead, and where your organisation turned voice off, Ask leaves Listen once out.
- **While a slow answer is on its way,** the bubble names the service in use (“Still waiting for your model
  provider…”), not always Copilot. Screen readers hear it, with the keyboard's ways to stop, which the bubble now
  shows under it too.
- **A failed reply's problem and its Try again stay up for their full 12 seconds,** and “Okay, I've stopped.” goes
  after 4 seconds instead of up to 30. When Copilot stops in the middle of a request, the bubble offers Try again and
  says “I'm connected again” once Ember has reconnected.
- **Without a compositor, the corner card grows** for any question at Large and Larger text, so you can read the
  whole sentence, and its Allow waits until you can.
- **Until first run is finished, the handle says “Finish setting up”,** and its menu starts with a way back to setup.

#### Voice

- **“Ember, stop” works while you teach Ember your voice.** Stop everything ends the teaching too, and so do 45
  seconds with no phrase heard, 3 minutes in all, and closing Settings; the handle says “Learning your voice”
  meanwhile. Settings then says how it ended (Ember stopped listening, the phrases didn't sound alike, the time ran
  out) and what to try, instead of asking for phrases that would run as real requests.
- **Listen once hears a long request to its end.** Speech must start within 8 seconds; what you are still saying then
  is heard to the end (up to 20 seconds from the press), instead of being thrown away as “No request heard”. On a
  muted microphone it says “The microphone is sending only silence…”, and pressed while Ember talks or answers, it
  stops that first and listens, as “Hey Ember” does.
- **Pause to think mid-request.** After a word such as “the” or “and”, Ember waits 0.9 seconds more for the rest:
  “And make the text a… bit bigger” is now one request.
- **Cancel the speech models' download** with **Cancel download** beside its progress; turning listening off stops it
  too, and the microphone note says that agreeing downloads the models (220 MB).
- **Settings names the microphone Ember hears through** (“Listening for “Ember” through …”), and the handle says
  “Listening for “Ember”” as Settings does. Listen once points to the download right below it, **Forget my voice**
  says it also forgets the words Ember learnt, and in a conversation with music playing Ember says to start with
  “Ember” when it didn't hear you.
- **Numbered steps and lists are said one by one.** Each step keeps its own number (“2. Choose Privacy”, not “Open
  Settings, two”), list items get a pause, and a list on its way is said as each item arrives.
- **Money, times and paths are said as people say them.** “$12.50” is “12 dollars 50”, “14:00” is “14 hundred”,
  “~75%” is “about 75%”, a file is “report.pdf in Documents”, and emoji aren't read out as “party popper”.
- **Ember starts talking sooner.** A long first sentence with no comma starts in about half a second instead of two,
  its voice loads as soon as you open the Ask box or send a request, and a new request that cuts Ember off is heard
  sooner.
- **Never under Speak stops Ember mid-sentence,** instead of letting it finish the answer, and **Stop speaking** in
  the handle's menu stops Ember talking without stopping its tasks.
- **Speaking speed and Hear Ember:** Settings › Voice lets you make Ember speak slower or faster, and **Hear Ember**
  plays a sample and says which voice spoke. If Kitten Nano stops working, or was too slow while the computer was
  busy, Settings › Voice says so and offers **Try again** instead of using the system voice until a restart.
- **Replies in other languages** are said by a system voice for that language, or not at all, instead of with
  English sounds.
- **`ember doctor` no longer says Ember can't speak** when it speaks in its own Kitten voice and only
  speech-dispatcher, its fallback, is missing.

#### Tasks and approvals

- **A question that ran out of time while you were away** keeps its task's card with **Try again**, notifies you, and
  “What did I miss?” says the question wasn't answered, not that you stopped it.
- **Saying or typing “try again” right after a task that didn't finish** asks for that same request in your words, so
  the step you asked for isn't flagged as one you didn't. A task near its step or time limit is told to wrap up, says
  what it had done if a limit stops it, and a try again knows the earlier try stopped part-way.
- **At the actions-a-minute limit a task pauses** (“Pausing to keep to 40 steps a minute…”) instead of ending with a
  refusal.
- **A question about a step you didn't ask for quotes your own words** as the task, never the model's rewording.
- **When a spoken yes isn't taken,** the question keeps its answer keys under the note, and Ember says them aloud.
- **A third task says it waits its turn** instead of “On it”, and every outcome is worded as its card says it
  (“didn't finish”, not “failed”). A task whose accessibility helper fails says so plainly and points to the setup
  check.
- **Typing “stop” in the Ask box while a task is at work stops everything at once.**

#### Safety and privacy

- **While GNOME Shell's own password prompt is open,** Ember reads nothing, sends no window text or titles, and takes
  no step in any app.
- **Send screenshots for tasks** (Settings › Apps & privacy, on by default) keeps tasks to the accessibility text when
  you turn it off. Every screenshot a task sends is now recorded, by app and size, and listed in What Ember did.
- **Apps & privacy shows “What Ember reads, sends and keeps”,** the text you agreed to before Ember started, and
  Search finds it by words such as data, screenshot and audit. Removing an app from Never look at or from the Always
  list says what changed.
- **More keys are hidden** from command output and logs: OpenAI, Anthropic, Stripe, Hugging Face and GitLab keys.
- **With Ask only about dangerous commands on,** Copilot's words about a command no longer reach the system journal
  (`journalctl -t ember-audit`), only their size.

#### Commands and other computers

- **The first command after Ember starts fits the command window** (90 columns by 12 rows at the default text size)
  instead of drawing 100 by 30, with lines cut off and the end of the output out of view.
- **An ordinary bash loop or if runs without a “Risky step” question** (`for i in 1 2 3; do echo $i; done`, `if [ -f
  package.json ]; then npm test; fi`). A dangerous command inside one still asks for itself alone, and a loop that
  sets PATH, or zsh's short forms run from a bash script, now ask.
- **A command's question says “the current folder”** (“Deletes what it finds under the current folder.”) instead of
  “.”, “..” or “{}”.
- **A command you asked for in so many words no longer says “You didn't ask for this.”** When your words ask for that
  kind of step but not exactly this one, it says “Your words don't name exactly this, so Ember checks first.”
- **Every command the bubble tags “Risky step” gets the caution edge and a plain Allow** on its card, not only
  deleting ones.
- **Closing the command window while a command runs** makes **Keep it open** the highlighted choice and **Stop and
  close** the plain one. A finished command's terminal hides its cursor, very short runs say “less than 0.1 s”
  instead of “0 s”, command headers write your home folder as ~, and the empty command window says what it is for.
- **On RHEL 8's OpenSSH, an SSH sign-in question** reads “A question while connecting to build-01”, says to read it
  before you answer, and says that Ember never keeps the answer. The SSH install hint ends “then try again.” and no
  longer breaks inside openssh-clients.
- **Settings says “Ember asks first: answer in the window that opens.”** while a first-use card waits, and after Not
  now it says what stayed off (“Commands stay off on this computer.”).
- **Adding a computer whose name Ember can't find** no longer leaves the mistyped name in Computers.

#### Models and extensions

- **Your own model server not running? Ember says so.** With Ollama or LM Studio stopped, Models & connections says
  Ember can't reach the model server on this computer instead of Connected, the handle says “Can't connect”, and Ember
  connects once you start it, without waiting 24 seconds on your first request.
- **Test connection names your provider's models** (“It lists 1 model: llama3.2:3b.”), and both model fields suggest
  them, so you pick the exact name instead of typing it blind.
- **The provider's note is announced when you enter its address,** and a line under Test connection says why it
  waits. Without a keyring, the API key row says how to get one (GNOME Keyring or KWallet).
- **Your extensions ask you to agree again, once.** A plugin from Copilot's built-in marketplace shows that
  marketplace as “Built into Copilot”, with no Remove that did nothing, and its card no longer says you added the
  marketplace. Because the card changed, no extension runs until you agree again.
- **Use extensions turns extensions off as a whole,** and a plugin you haven't agreed to no longer shows its switch
  on. After you agree to an extension's tools, focus stays on it and Ember says it can use it now, not “again”. While
  Ember isn't connected, Extensions says marketplaces appear once it is, instead of an empty list that refuses Add.

#### Memory

- **Memory asks you to agree to its note again** if you had it on. The note now says what goes to Copilot with every
  request (what you asked Ember to call you, how you like answers and a few facts that bear on the request), and that
  while you're away its tidying sends up to 40 saved facts to Copilot up to 6 times a day. Ember now uses your name
  and answer style on every request, and **Spoken replies** in Tell Ember about you changes whether Ember speaks.
- **Memory refuses passwords, PINs and codes however you say them.** It never keeps “The password for the HR portal
  is…”, “VPN password hunter2”, a door or alarm code, a social security number or an IBAN.
- **Memory says why it is paused.** While Ember connects, uses your own model provider or can't reach GitHub,
  Settings › Memory says so instead of suggesting Forget everything, Home says “Memory paused”, and Tell Ember about
  you no longer fails with “Try again”.
- **“Remember that…” with memory off gets a straight answer:** Ember says memory is off, or why it is paused, instead
  of promising to remember.
- **Undo after Forget.** The list says what went and offers Undo for a minute, pressing Enter a second time no longer
  forgets the next memory, and Forget all words asks first. Ember forgets a memory in conversation only when you ask,
  then names it (“Ember forgot: …”) and offers Undo.
- **Forgetting a fact forgets Ember's summaries and guesses made from it,** which the list now labels “Ember's
  summary” and “Ember's guess” instead of “From our conversation”.
- **Forgetting what holds now doesn't bring back the old value.** Forget “Works at Initech” and Ember no longer takes
  “Works at Globex” as current again. Undoing something Ember kept in the last ten minutes still puts the old value
  back, and now says so.
- **A change of mind replaces the old memory:** “Doesn't like Teams any more” replaces “Likes Teams”, and “Prefers
  light mode” replaces “Prefers dark mode”.
- **“Call me Ram” keeps Ram.** In the spoken “get to know me”, Ember keeps just your name from “Call me Ram”, “My
  name is Ram” or “It's Ram, please”, and “Call me Ram” no longer ends the interview.
- **Sign out says which memory stays,** and when another GitHub account signs in, the new conversation says Ember
  forgot the previous account's memory.
- **Only Forget is red in Settings › Memory.** Correct… is in the words' colour, a long memory's two buttons stay
  side by side (and apart in a contrast theme), and an empty list no longer says “0 of 0 memories”.
- **Faster with a large memory:** with 5,000 memories, Ember finds what bears on a request in about 20 ms instead of
  over 100 ms, with the same results.
- **A reconnect no longer wipes what you were doing in Memory.** A correction you were typing, your search and where
  focus was come back once Ember has checked your GitHub account again, and a Better recall download carries on.

#### Reliability

- **Ember notices at once when Copilot stops mid-answer.** It used to show a half answer as “Answering” for up to 20
  seconds; now it says Copilot stopped within about 3 seconds and reconnects, and a running task's card says so as
  fast.
- **A Copilot that never answers no longer leaves Ember “Connecting…” for good.** Each step of connecting has a time
  limit; Ember then says “Copilot isn't answering. Ember will try again in a moment.” and tries again.
- **A crashing accessibility helper no longer spins a processor core.** One that crashed on every request was started
  again about 29 times a second; Ember now waits longer between tries, up to a minute, and still starts one at once
  when you ask for something.
- **Ember uses less of the processor while it rests beside your cursor.** Its face is drawn about 6 times a second at
  rest, not 18 to 24, and it moves 10 times a second instead of 60 once it and the pointer are still. On a computer
  without a GPU, idle use went from about 11–15 % of a core to 9–10 %.
- **Opening Home or the stop shortcut no longer waits 5 seconds each time** when Linux's accessibility bindings hang:
  after its first look, Ember looks for them in the background.
- **Home tells you when Ember closed unexpectedly last time,** and the log records it, so a crash can be told apart
  from a quit.
- **The log file can be copied or shown in Files** from Setup & about › About this build, and the troubleshooting
  guide says what to do when Ember is slow or busy and what to share in a report.

#### Install and docs

- **The README says what Ember needs before you download it, and what its first start asks:** a Copilot account (or
  your own provider), GNOME on Xorg, about 1 GB of disk and 600 MB of memory, then the welcome's six steps and the ask
  and stop shortcuts. Its sign-in and own-provider steps match first run and Settings › Models & connections.
- **Computers without internet access lists the optional downloads,** each with its size and where it comes from:
  Hear me more clearly, the Kokoro and Supertonic voices and Better recall. It also gives Linux's machine-wide speech
  models folder, and the README says how to update the AppImage.
- **The npm launcher says so when its version's release isn't out yet,** instead of an HTTP error. `ember doctor`
  through it shows the setup check's report and exits with its code, and an Ember that stops as it starts (no display,
  for example) says why instead of being reported as started. After an update it removes the older version from its
  cache, and its README gives update steps, and uninstall steps in an order that works. The AppImage takes `--doctor`
  as well as `doctor`.
- **Clicking the notice that a new version is out opens Updates** in Ember's settings, and the update check keeps to
  once a day, also when you restart Ember.

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
  pages and tabs, and closing a tab you asked to close no longer ask. Chat boxes, forms and composers still do.
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
- Safety: the command reviewer's session is checked for tools like every other session. At most 40 actions a minute now
  counts all tasks together. `tailscale` is classified: `funnel`, `serve` and `file cp` ask as publishing, `up`, `down`,
  `set`, `login`, `logout` and `ssh` as system changes.
- Idle cost: the handle's face stops drawing once it has dozed off and settled, and a question no longer hashes every
  remembered fact again unless something changed.
- Wording: sign-in says a GitHub account needs Copilot before the browser opens, and common refusals say who can fix
  them, without "seat" or `gh auth login`.

### UI and speech follow-up on 4 November

- Ask provides a visible Send action, comfortable scaled controls, wrapping suggestions and scrolling in small work areas.
- Home supports an inline transient conversation, search, full-answer Copy, explicit Edit then Send, and Stop response separately from Stop everything. Delayed updates cannot restore another account's draft or transcript.
- Projects has its own destination, per-file removal and size feedback, an immutable running-request snapshot, readable code/diffs and native exports of reviewed output. Exports cannot overwrite selected source files or Ember's private data.
- Open approval reaches the exact live question in a keyboard-focusable card. Pointer approvals commit on release inside the unchanged target; moving away cancels. Reading task details and More time postpone card dismissal.
- Memory controls retain focus, deletion reports actual success, and local query/source filters and pages make retained facts easier to find. Explicit corrections save durably, retain source authority and invalidate stale recall/learning work. Settings search offers selectable labelled matches.
- Upcoming reminders show their words, local due time and persistence state. Edits preserve timers on failed saves, text-only changes preserve seconds, and bulk deletion names its scope before confirmation.
- The desk offers explicit read-only app text with private fields omitted. It retains consent, lock and action-identity protection.
- Recognition preserves intended dictated repeats and numeric sequences while retaining whole-sentence loop recovery. Neural voices release after two idle minutes.

### Reliability fixes on 3 November

- Remote command output cannot replace the real process's exit code or signal.
- Concurrent checkbox requests recheck their desired state under the window lease, so two requests to turn one on do not toggle it off again.
- Stop and task deadlines return control when task startup or request submission stalls; late work cannot start after cancellation.
- Interrupted replies cannot resume from delayed old speech chunks. Queued typed and spoken requests keep their own speech and follow-up ownership; a short “No” still answers an ordinary clarification.
- Windows window discovery retries a changing window order instead of missing a window raised during enumeration.
- Windows recognises both spellings of the stored-credentials dialog and refuses program text in Explorer's Address Bar.
- Linux recognises buttons on newer AT-SPI releases, including controls that reveal passwords. A click on a GTK list checkbox uses the checkbox rather than selecting its row.
- A Kokoro voice that is too slow is remembered for a week, avoiding repeated startup benchmarks. Changes to the model, providers or thread configuration trigger a fresh check.
- Extensions consistently admit dotted tool names, pin complete tool descriptions, and give provider-appropriate sign-in advice. Settings accurately describe unavailable hosted connectors and the supported MCP plugin path.

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
