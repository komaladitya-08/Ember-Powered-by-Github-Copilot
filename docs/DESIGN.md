# Ember — visual design

Ember is a small, expressive companion that rides beside the cursor. The idea comes
from the living fire spirit (the product is named after Ember from Pixar's *Elemental*),
but every character is an **original design** with no film assets or likeness.

The first direction, a particle flame with no face, was retired because it could not
show expressions.

## Characters

All four ship in the app and are chosen in setup, settings, or by asking Ember (aloud or typed).
They share one emotion rig, so switching never changes behaviour.

| Character | Look | Signature |
|---|---|---|
| **Cinder** (default) | Coal critter with glowing cracks, ember eyes, flame tuft, two floating mitten hands | Hands act: wave, cup an ear, point at targets, type, thumbs-up |
| **Wisp** | Living flame with a face | Flame height and colour carry the mood |
| **Glassling** | Squishy drop of molten glass with bubbles inside | Jiggles; cools from amber to pale blue when sad |
| **Glint** | Two glowing eyes and a spark | Most legible at cursor size; least distracting |

## The rig (`packages/characters/src/rig.ts`)

- **12 emotions**, each a set of face parameters on springs (eyes, lids, pupils, brows,
  mouth, blush, squash, tilt, energy, heat), plus an emote and a gesture.
- **Always alive:** breathing, blinks (sometimes double), saccades and gaze at the pointer,
  hops with landing squash, a talking mouth, idle fidgets (glance, yawn, hop), optional sleep.
- **Life that follows how people look:**
  - blinks close in 60 ms and open in 110 ms, every 2.5–5 s at rest and every 6–10 s while
    thinking or working (people blink less while reading);
  - the eyes jump to a new point (a saccade: a stiff spring for about 60–120 ms) and then follow it
    on the soft spring;
  - a long "got it" blink (250 ms) when the user's request ends (listening gives way);
  - listening starts without the anticipation pop (a wake must feel instant); while a question is up
    (`setQuestion`, whatever emotion it shows) Ember has no pop, hop, fidget or saccade: it holds,
    blinking only;
  - fidgets every 5–10 s in the first minute of idling, then every 8–15 s: rarer, never more insistent;
  - with Ember's own voice (default Kitten Nano or optional Kokoro) the mouth opens with its loudness (the level the
    presence meter uses, ten times a second, smoothed in the rig) and the glow brightens a little
    with it for as long as it plays (past the words: the last sentence is spoken after them). The voice
    sends its level at least every half second, and the rig lets go of one older than 1.5 s, so a voice
    that stops without saying so never leaves the mouth moving; the system's voice gives no level, so
    the mouth keeps its syllable flap;
  - asleep, the eyes stop wandering, and once the face has settled the overlay draws nothing until
    something happens (it drew every 110 ms);
  - while a question is up, the idle float stops and the body's springs settle without wobbling;
  - in Calm every spring settles without overshoot; blinks, gaze and the talking mouth stay.
- **Emotes** are outlined so they read on any background: `…` thinking, `?` confused,
  `!` surprised, `zzz` sleepy, sparkles proud, sweat drop worried.

| Emotion | Shown when |
|---|---|
| Ready (`neutral`) | Resting beside your cursor |
| Happy | "Hey Ember!" |
| Listening | Wake word heard |
| Thinking | Model is reasoning |
| Focused | Working in an app |
| Curious | Showing you where to click |
| Surprised | Something unexpected popped up |
| Confused | Can't find something |
| Needs you (`worried`) | Asking before a risky step |
| Sorry (`sad`) | A step failed |
| Proud | Task done |
| Sleepy | Nothing to do for a while |

## Bubble and motion

- **Reasoning bubble** (`packages/bubble`): dark glass, always dark so it reads over any
  app; state (a tag: a dot and a word on a tint of the state's colour, set apart from the title
  by its shape), one-line intent, streaming thought (last three lines),
  current step with its reason, and buttons when Ember needs a decision. A finished answer has no
  head at all: it is Ember's bubble, so "Ember" doesn't title it. A question sets its decision (up
  to its "?") in weight 600, what the step does after it, and "Your task: …" under it in the
  secondary label; its title ("May I?") is the quieter lead-in, its keys show as keycaps under the
  buttons, four corner brackets lock onto the bubble once (180 ms) and then hold still, and nothing
  about it pulses. A **risky** question (one policy asks about every time: send, delete, pay,
  install…) adds a "Risky step" tag, caution-yellow brackets and an Allow that is bordered rather
  than filled, so nothing invites a reflex yes; screen readers hear "Risky step." first. The
  no-compositor corner card marks it the same way: the tag beside Ember's name and the bordered
  Allow. A step Ember took **without asking** (Work without asking) shows its announcement with a
  "Without asking" tag in the accent tint, set only by Ember (`BubbleState.autonomous`): a task's
  own note never carries it. When
  "Thinking…" has heard nothing from Copilot for 10 seconds it says "Still waiting for Copilot…"
  (or "Still waiting for your model provider…" or "…for the model service…" when that is the one in use) with **Stop** (that turn only; tasks go on), and so does a turn that goes quiet for 30. Its step names the keyboard's ways to stop,
  which the bubble's Stop can't offer ("Or press Ctrl+Alt+E and use Stop response in Home. Ctrl+Alt+X stops
  everything.", each key only while Ember holds it), and screen readers hear the wait and that step once. A problem
  offers **Open settings** where settings can fix it, otherwise **Try again** where asking again is
  safe (the conversation's own request, whose turn ran no tool). An answer whose turn started a task
  says "Its card in the corner shows how it's going.", so the bubble and the card tell one story. Under a finished
  answer (and only that answer) the bubble may show what you might say next: a caption, "Ember suggests", then up to
  three quiet 24 px capsules (never the accent, never under a question), in its clickable area; the Ask box shows the
  same as a row of 20 px capsules under its hint line while the field is empty (docs/ASSISTANT.md §7). A question's
  answer ("Thanks! Carrying on.", "Okay, I won't.") stays 1.5 s; then what the question covered or held off shows
  again, or the bubble empties and the ring rests, so a task that ends on its card never leaves "Working" behind. A
  turn that only ran steps (it started a task and said nothing) leaves no "Working" bubble either, and one that
  said its answer before its step shows that answer at its end. If a newer request is still waiting for its turn,
  its thinking face and busy ring stay on without a neutral flash or an old answer's hide timer; the slow-wait
  message and **Stop** still work. A question about
  typing more than 160 characters (or a cell value cut short) shows all of the text under its
  sentence, every character as it will be typed, in a flat panel that scrolls (seven lines);
  **Allow** stays dimmed, with "Scroll down to read it all first." above it, until every line
  has been in view, and the allow key shows the next part meanwhile. Ember speaks in
  the first person there ("I'm on build-01"), and a number's unit never wraps away from it
  ("15 seconds" in a sentence). While Ember thinks or listens, an ember-coloured glow
  breathes round its edge. The state says
  "Needs you" only when a button needs a decision (a question, an offer, signing in) or a
  command waits for the user's typing (its **Show** brings the command window up, with
  "Or press Alt+Tab to go there." under it on Linux and Windows); a notice that asks nothing (a stop on another computer, "I'm on build-01") has no
  state word, connecting to a computer is "Working", and a failure is "Problem". With
  **More time to read and answer** (Settings › Comfort & access) every bubble stays ten
  times as long and a question waits 20 minutes instead of 2. The bubble never takes the
  keyboard, so under buttons only the mouse reaches it says where the keyboard finds the same
  thing: an answer cut short (by the lines it takes at the text size) offers **Read all**, and
  under it "Or press Ctrl+Alt+E and go to Conversation." (the settings window keeps the whole
  answer; there is no shortcut of its own for the last answer). A shortcut is named by the chord
  Ember holds: its fallback (Shift added; on a Mac another key, since Option is VoiceOver's)
  while another app holds the default.
  One whose fallback another app holds too is never named: the route is then "Or open Ember's
  settings and go to Conversation.", errors
  and a task's result say "in Ember's settings", and an announced command names no stop
  chord, only its **Stop**. (The command window's line for a run the kill switch ended names
  no chord at all, "Stopped with everything else": the switch has other ways too.)
- **How it moves.** The bubble grows out of Ember (from 0.96, the corner nearest Ember, on the brisk
  spring) and leaves the way it came, faster; a question only fades in and out, so nothing near a
  decision moves. Streamed text is drawn at most 15 times a second. A card's plan dot fills as its
  step starts, and a finished card's tick settles in once on the reward spring; a failure just shows
  its mark (no shake, no flash). The Ask box grows out of Ember beneath it. In Calm, each of them
  fades over 150 ms instead.
- **Follow:** spring to cursor + offset. **Flight:** quadratic-bezier arc, 0.6–1.4 s by
  distance, smoothstep easing (`packages/motion`, ported from clicky, MIT).
- **Mini-Embers** mark tasks running in background windows or on Ember's desk.

## Presence: the Ember HUD

Ember's own vocabulary on the floating layer, on top of the glass (the content windows stay System
Settings): one ring that says what Ember is doing at a glance, in Ember's warm light rather than a
film's cyan. Its job is presence and telemetry; every part of it repeats what the words already say
(`aria-hidden`, outside the clickable areas), and none is the only sign of a state.

| State | By the cursor (the ring round Ember) | On the handle (round its face, still) |
|---|---|---|
| Idle | None | Dim (`--hud-dim`) |
| Listening | 24 ticks lit by the microphone's level, plus a steady microphone mark at Ember's lower left that says it hears you whatever the level | Accent |
| Thinking | All ticks in `--accent-2`, breathing three times, then lit | `--accent-2` |
| Acting (your mouse and keyboard, or showing you) | Dim, with one segment at the top that pulses | Accent |
| Needs you | The full ring, still; the bubble's brackets lock on | Accent, thicker |
| Problem | Red, with a notch at the top | Red, notched |
| Done | Completes once and fades (2.2 s) | Green |

While Ember's own voice plays, a five-bar meter at its upper left follows the voice's level (the
system's voice gives no samples, so it shows none: never a meter moving on nothing).

**What it costs.** The ring is 24 ticks placed once by a static transform inside an unstyled wrapper
that moves with Ember; nothing rotates. Levels come in eight steps (app/shared/level.ts), only when
they change: the microphone's at most 20 times a second and only while it hears a request (main turns
the mic page's level on and off with the listening state), Ember's own voice 10 times a second while
it plays, on their own IPC channel apart from the state; only a level ever leaves the page that hears
or plays, never audio. A level changes only the ticks' opacity (the meter's bars by `scale`).
Measured under Xvfb with software compositing (xcompmgr, 20 s each, two runs), with a level that
changes at every update, the worst case: listening went from 7.7% to 11.5% of a core in the overlay
renderer and from 7.4% to 8.3% in the GPU process; Ember speaking from 12.8% to 14.9% and 8.4% to
9.3%; idle is unchanged within noise (7.6–8.7%, 5.8–6.7%). At 20 voice levels a second the meter cost
twice as much, so the voice is read at 10. Nothing runs while Ember is hidden; in Calm the ring holds
still (listening shows every tick lit, the meter a steady mark).

## Two bodies: the corner and the cursor

Ember is two places at once, each for one kind of work.

- **The corner** (the handle, and the task cards above it) is the orchestrator. Every task that does the work
  autonomously lives there, one card each:
  - in the background, through an app's accessibility, commands, WSL or another computer;
  - on Ember's desk.

  A card shows:
  - its title: the request, up to 72 characters cut at a word, on at most two lines;
  - how the task works now, under its title: "In the background", "On my desk", or "Using your mouse and keyboard"
    in the accent;
  - a **live line** in Ember's own words: what it is doing now and where ("Clicking in Text Editor…", "Thinking…",
    "Waiting for you" while its question is up, "Retrying…", "Still waiting for Copilot…", named for the service in use);
  - the worker's own note under it (`report_progress`'s `intent`, else its `text`), in the secondary label: the
    model's words, never set as Ember's;
  - a **telemetry row** of at most three items in footnote type, weight 500 and tabular figures: the plan's step
    ("Step 3 of 7"), its clock ("Just started", then "42s", "1:42"; written once a second as text by one shared
    tick, so nothing moves or re-lays out), then "Close to my limit" past 80% of its 150 steps or 20 minutes, else
    how many steps the user allowed. Once it ends, the state's word and how long it took ("Didn't finish · Took 1:12");
  - the steps so far in one sentence ("Clicked 3 times and read the window 2 times (1 didn't work)"), what changed
    things named before what only looked;
  - its plan, a dot per step (`report_progress`'s `plan` and `now`): done, under way (the accent, weight 600), to come
    (the step a failed or stopped task was on keeps its weight in red or grey, not the accent);
  - **Details**: up to six rows of what it did (steps of one kind in a row folded together, "Read the window 3 times in
    Settings"; a refusal with policy's reason; a question and how it was answered; the worker's notes, marked as
    its words), each with a static state symbol and when it happened. Closed until the user opens it, kept open by
    task id across updates;
  - when it ends, what it found or made, as a **view**, and on a failure **Try again** (the same request starts again
    as a new task, asking every question again) beside **Close**.

  The words come from `app/shared/activity.ts` (one table of state words: Working, Waiting for you, Waiting its turn,
  Retrying, Done, Didn't finish, Stopped) and `app/main/agent/activity.ts`, which builds a task's activity from its
  worker's tool calls and Ember's own signals: never the model's arguments, its reasoning or screen text. A running
  task's symbol is a ring round a lit dot, which never reads as a spinner. A card with a view or a failure stays a
  minute, and the stack widens from 270 to 320px to hold it; both widths grow with the text size. Without a
  compositor, the corner card's task row has two lines: the title, and the live line under it.
- **The cursor** (the character beside the pointer, and its bubble) is the assistant with you. It holds:
  - the conversation: what you asked, and the answer;
  - guides ("show me");
  - a task while it uses your mouse and keyboard (tier 3). Its work shows in the bubble as well as on its card, and
    the bubble goes once the mouse is yours again.

  A task in the background never writes the cursor's bubble (`PresenterOptions.corner`, turned on by main's
  `cornerTasks`). Its progress and result stay on its card, and the conversation keeps its result as words.
- **What needs you now still comes to the cursor.** Questions and approvals (the Confirmer) and announced commands
  appear in the bubble, which names the task. Moving a background task's questions onto its card, with the same
  arming, the same allow and deny keys and the same one-at-a-time rule, is the next step.
- **Views** (`app/shared/view.ts`, catalog `ember.view/2`): Ember draws a task's view itself by composing blocks from
  a closed catalog; the model chooses structure and words, never HTML, colours, sizes, URLs, icons or controls.
  - **Blocks.** Layout: `stack`, `row` (stacks below 240px), `grid` (2 or 3 columns; a card caps it at 2), `card` (a
    faint inset group), `section`, `divider`. Content: `heading`, `text`, `rich` (bold and code runs, no links),
    `keyvalue`, `badge` (a tag, a rounded rectangle, never a capsule button), `callout`, `quote`. Data: `list`,
    `table`, `steps`, `timeline`, `progress`, `gauge`, `metric` (a tile with an optional change and spark), `chart`
    (`bar`, `hbar`, `line`, `area`, `spark`), `compare`, `code`, `file`. The first catalog's blocks are upgraded on
    arrival (`upgradeView`: `facts` → `keyvalue`, `checklist` → `steps`, `excerpt` → `file`, `status` → `callout`).
  - **Tones and symbols.** Six semantic tones (neutral, info, positive, caution, negative, special) map to the system
    colours, each beside a symbol or words; Ember's accent is never a view's colour. Symbols come from a fixed set of
    outlined masks (view.css), so none reads as a task's filled state symbol.
  - **Limits** (`VIEW_PROFILES`): a window takes depth 5, 120 nodes, 12 children a node, 8,000 characters, 6 charts or
    gauges and 6 × 20 tables; a card draws the first 40 nodes, 2 charts as pictures (the rest as words), 3 × 6 tables,
    8 items and 12 code lines, and says what it left out in Ember's words ("3 more rows"). A card's view is at most
    300px (scaled with the text): blocks past it are left out whole, never cut through, and "More in Home" says so.
  - **Ember's frame.** Above every view Ember writes "Found by this task" (in a window, "Found by “<title>”" and what
    the task did). A `quote` holds words copied from a page, a file, an app or a command, under Ember's caption
    ("From Firefox", "From a command"), with a grey rule, in the secondary label, never toned; the caption names an
    app only if the task read it, and a command only if it ran one.
  - **Checks** (app/main/agent/view-schema.ts, whole document, fail closed): each node against its kind's strict schema;
    references, one parent, no cycles and the limits; no invisible or direction-changing character anywhere; no
    string, label with its value, row or whole view that imitates Ember's controls or voice ("Allow" however it is
    spelt, with look-alike letters folded, a shortcut chord written any way, "Ember: …", "I'm Ember"); no secret
    anywhere (also split across a label and its value), no private key header, and no path into a place where secrets
    live in any string. One failure refuses the whole view. A finished task's view reaches the conductor only as words
    inside its untrusted `<task_results>`.
  - **Drawing** (app/renderer/shared/view-dom.ts, view.css): `textContent` and static SVG only, no inline styles (a
    bar's length and a chart's shapes are SVG geometry), so Home's `style-src 'self'` needs no exception. Charts get an
    Ember-written accessible name and a hidden table of the same numbers; series differ by dash as well as tone.
    Nothing in a view animates except the one 120 ms fade of a node an update replaced, which Calm stops.
  - **Updates.** `show_view` draws a live view while the task works, `update_view` changes it by node id, and
    `finish_task`'s view takes its place (without one, the live view stays as the result). Main sends a page only
    the changed nodes, at most 4 times a second a task, and nothing while Ember is hidden (`ViewHub`); the page
    applies them in one frame on the cards that show. Without a compositor, the corner card shows the task's words
    only, and the conversation always gets the view as words (`viewText`).

## Home: conversation, projects and settings

Home is an opaque content window in the manner of macOS System Settings: a sidebar of panes with coloured symbol
tiles, and one pane at a time beside it (UI audit #1: it was one 5,100 px page that opened on the character picker).
- **The sidebar.** **Search settings** sits at its top: typing narrows the links to the panes that hold the words
  (headings, switch labels, footnotes, buttons, and a few other words people use for a pane, so "mic" finds Voice:
  `SEARCH_ALIASES`, ranked after the settings named by their own words), and says "Nothing found" in the sidebar
  when none does. Selectable labelled results show in batches of 12. ArrowDown/Tab reaches a chosen result, Enter selects it and marks its row, with its control focused (a group's header
  or footnote stands for the group: a one-row group's row, else the whole group). The sidebar grows with the text size,
  so its labels stay on one line, but never past what leaves a pane 460 px (no sideways scroll at 640–720 px). The links, most
  used first: Home, Projects, Models & connections, Voice, Your Ember, Memory, Apps & privacy, Comfort & access, Computers and Commands (once
  available), Extensions, Setup & about. The current pane's link carries `aria-current`, a fill that glides between
  rows on a click (`--spring-smooth-0`), and in a contrast theme an outline. The window reopens on the last pane. Below
  640 px the links are one row of capsules, the search field first.
- **Home's status panel** is the window's one HUD part, on `--surface-1` and still: the presence ring round the
  character (dim, the accent, heavier when a task needs you, red with a notch for a problem; never animated), Ember's
  state in a few words ("Ready", "Working on 2 tasks", "Thinking…" while it answers what you sent from Home, "A task
  needs you" with **Open approval**, "Not connected",
  "Needs setting up", "Locked by your organisation"), where Ember is and how to ask as a quiet caption, a link to the setup check when a row needs
  you, then two facts (which of listening, memory and commands are on; today's tasks by outcome and the steps you
  allowed, from the same tasks Task activity lists) and **Ask Ember…** (the one prominent button; **Connect Copilot…**
  takes that place while Copilot isn't connected, and nothing does while the organisation's policy locks Ember down)
  beside a quiet **Stop everything** and the stop chord. Under them two quiet links, **Write to Ember** (the
  composer, focused) and **Task activity**, keep both a step away however long the conversation grows.
- **Home's setup check** says each row's state in first run's words beside its tint ("Ready", "Worth a look",
  "Needs fixing", never a code such as OK), in one column as wide as the widest word (a subgrid, so the labels line
  up), offers **Copy** for a command the row tells the user to run, and **Check again** under the rows.
- **The conversation** is part of the page, not a box that scrolls inside it: its latest 6 messages (so the composer
  and Task activity below stay within reach), then **Show earlier messages**. Home searches all 60 retained session entries (a search left typed in is cleared when you send, so your message and
  its reply show; the composer's line says "Thinking…" until the reply, and "Still waiting for Copilot… Stop response
  ends this reply." after the bubble's own 10 s with nothing written), shows explicit per-answer truncation beyond
  131,072 characters, and offers Copy and Edit. A long paste is kept whole: from 1,800 characters the composer counts
  them, and over 2,000 it says how many too many and Send refuses until it fits. Messages kept from before a restart
  (**Keep my recent conversation**) show their day beside their time, and a quiet line under the last of them says
  they are for reading and Ember starts afresh below. Edit only fills the composer; a fresh Send is required. Home sends
  no foreground-window capture. While you write in the composer, a reply growing above it keeps the composer and its
  buttons in view; nothing scrolls for someone reading elsewhere, or who scrolled away from it. **Read the last
  answer** and a long answer's **Open conversation** open it at the newest answer, focused, from its top (once the
  messages have come, when Home opens for it). Stop response cancels
  the current answer; Stop everything also stops tasks. Drafts
  remain in memory while switching panes and clear on account reset, independently of ordinary empty-list updates.
- **Task activity**: one group per task, the one that needs you first, then those at work, then the rest, newest first.
  Its head is the state symbol, the title, a line of state, clock, hand and place, and its steps in one sentence; then
  the plan as a checklist (done ticks, the accent dot for now, rings to come), then the timeline: rows of at least
  44 px with the time after the task began in tabular figures, a state symbol and Ember's words, steps of one kind
  folded behind a chevron, a question with what it asked under it in Ember's words (the kind of step and the app, never the typed text or names from the screen) and how it was answered, the worker's notes tagged
  **Note** in the secondary label. Then how it ended: the worker's summary in the secondary label and its view, drawn
  by the cards' catalog code. A finished task folds to its head. Home offers exact-task Stop, retained safe retry, verified Show app and
  focusable View result. Capability hints never authorise an action: main revalidates the exact task and native window
  identity, while stale/remote/desk/locked/borrowing cases cannot raise another window. While a task waits for an answer, a callout in its
  group says where it is asked (the bubble, with the keys that answer it; the command window; or a consent card's window); Open approval opens the exact live question in a focusable card or its existing panel; Home never answers from
  transcript text. From five tasks, **All**,
  **Needs you**, **Working** and **Ended** filter it. A working task's clock is text written once a second.
- **Settings panes** keep System Settings' grouped rows: switches at the trailing edge, a switch's note inside its
  row (Apps & privacy's **When Ember asks first**), pop-up buttons styled as one (Handle position too), and states
  shown as switches (**Follow my cursor**, **Hide Ember until it needs me**) rather than buttons. Voice shows its
  status row only while it says something the switch doesn't. About sets paths in the mono face and the issue
  address as words with **Copy**.
- **Labelled fields** (Models & connections' **Model provider**): a label, then its filled text field (`.field-row`, the never-look
  field's look and height), the field under the label below 480 px. A secret goes in a password field and is never
  shown again: once saved the row says **Key saved** with **Replace** (quiet) and **Remove** (a `--red-text` text
  button). Rows a switch governs show only while it is on, and rarely needed ones fold under **Advanced**.
- **Motion** (the `--spring-smooth-0`, `--spring-brisk` and `--t-*` tokens): a pane coming into view fades and rises 6 px; a fold's content fades in
  from 4 px above, its height never animating; the sidebar's fill glides. Calm makes all of it instant.

## Design system (`app/renderer/shared/ember.css`)

Every window loads one stylesheet of tokens and controls, following Apple's Human Interface
Guidelines and its current design language (Liquid Glass, macOS 26/27), adapted to a Linux desktop.
Pages use the tokens rather than literals, so Increase Contrast and Reduce Transparency reach every surface.

- **Type:** Inter (bundled, SIL OFL 1.1) stands in for SF Pro, with optical sizes and Inter's own
  tracking. Apple's text styles at a Linux desktop's size (body 14 px) on a 4 px line grid, line heights rounded to whole pixels at every text size; hierarchy
  comes from size, weight and label colour, never italics. Sentence case; no tracked capitals or
  monospace labels. The text size (Settings > Comfort & access: Default, Large 115 %, Larger 130 %)
  scales the type tokens, each page's own px sizes and the heights of its buttons, pop-up buttons and
  text fields (`html[data-text-size]`, set by main's `page-prefs.ts`) in Settings, the bubble, task
  cards, the handle, the ask box, the desk view's bar and the command and prompt windows. The
  handle's pill, the ask box, the desk view and the command and prompt windows grow by the same scale
  (the pill wider; the ask box as it opens, its field and the line under it, not its insets: 560 × 92,
  644 × 101 or 728 × 111 px, then a line of 24 px times the scale for each further row; the desk view
  by its bar, 30, 35 or 39 px, at once, its picture keeping its size; Ask initially reserves three rows for its
  composer, explicit Send and 28px scaled voice controls (140, 156 or 173px high), then measures wrapping
  suggestions/notes. In a capped work area its content scrolls. The windows size as they open, and at
  once when they are already open; inside the work area).
  The command window's terminal draws its type at 13, 15 or 17 px, at once when it changes: a run
  keeps its columns and rows, its cells grow, and new runs start at what fits the window.
- **Colour:** Apple's dark system palette (2025) with its increased-contrast variants. The accent is
  system orange (#FF9230), kept for the one prominent action, status and Ember's presence; it is
  Ember's identity, not a caution colour (a problem is red, a risky question caution yellow, done
  green). Two HUD tokens are Ember's light as hairline ink: `--hud-line` (scales, tracks, bracket
  edges) and `--hud-dim` (a segment not lit), decorative only, each with an Increase Contrast value
  and a contrast-theme colour. Text on filled buttons
  is dark (white on orange fails contrast). Labels are a warm white at 100 / 66 / 52 %. Ember is
  by default the computer's light or dark setting (Settings › Comfort & access › Appearance) for Home, the command
  window and the prompt window, and always dark for the floating layer: title bars follow on Windows, macOS and GNOME,
  native menus and dialogs on macOS, and menus on Windows. On Linux, menus and dialogs follow the
  GTK theme, and Windows' message boxes (the quit question) stay light.
  `test/unit/design-system.test.ts` checks the token pairs: labels and system colours on every
  surface, dark text on filled buttons, control edges.
- **Contrast themes** (Windows' forced colours, where the system paints with its own few colours and
  drops shadows and gradients): the tokens become system colours, the accent the system's highlight
  (the prominent button, on-switches, the chosen character, the selected tab). Control edges become
  real borders and outlines, focus is a 2 px highlight outline set 2 px off the control, and every
  symbol and status dot keeps its shape in a system colour. Each page's `@media (forced-colors:
  active)` block adds what only it draws; `BUBBLE_CSS` has its own.
- **Layers:** the settings window and the desk are the content layer: opaque grouped sections, a
  sidebar with coloured symbol tiles (as System Settings), rounded-rectangle buttons, switches, pop-up
  menus, headers above each group and footnotes below it. What floats over other apps (bubble, task
  cards, handle, ask box, status line) is Liquid Glass without a blur (with software compositing a
  blur costs a core, and a transparent window can't see other apps): the screen shows through a dense
  tint, with a static sheen, a 1 px rim lit from the top left, a lit top and darker bottom edge, a
  dark hairline of one device pixel and tight shadows, and capsule buttons in two sizes (28 and 24 px
  at the default text size). Two densities, never mixed on one surface: **regular** (0.88) under
  sentences, where a white page's own text shows through at under 1.5:1, and **clear** (0.55) only
  at the handle's face end, its words on a plate. Labels on glass are a step firmer (74 % and 66 %),
  and every label, tag and control edge is tested against a white page behind the glass.
- **Glass setting** (Settings › Comfort & access › Glass, `settings.glass`, as macOS 27's Liquid
  Glass control): **Clear**, an even smoky tint (0.68) with no plates or halos behind the words,
  just dense enough that near-white labels pass 4.5:1 over a white page; tags' words in the label's
  colour, Ember's accent as words in a light tint of it (#FFE4CC) and the marks in light tints (a view's toned words
  take the label too: the reddest red that passes 4.5:1 there is about #FFDCDC, which read as white with a blush, so
  the tone is carried by its mark, tint and rule); a risky question's tag is filled with Clear's yellow under dark
  words, so it stays unmistakably the caution colour (not in a contrast theme, where it is the text colour on the
  window's, edged);
  **Regular** (the default, 0.88); or **Solid**. Reduce Transparency and Calm make it solid,
  Increase Contrast solid with a 1 px light border. Three Clear designs were rendered for the owner
  (a 0.30 body with a dark text halo, the same with heavier weights and an accent-tinted halo, and
  this even tint): the halos measured 2.7–3.1:1 against the brightest pixels round the letters over
  a white page and let the app's own text collide with Ember's, so the even tint was chosen.
  Without a compositor the floating windows are opaque panels, as before.
- **Crisp at every scale:** what moves is placed on device pixels (not whole CSS px, half a device
  pixel apart at 150 %), canvases are sized in whole device pixels and redrawn when the scale
  changes, hairlines are one device pixel, line heights are whole pixels at every text size, and the
  status line is centred by layout rather than `translateX(-50%)`. Nested corners are
  `max(outer − padding, 6 px)`: the bubble's whole-text panel is 6.
- **First run's connection** (FE #2–#6; first-run-copy.ts, welcome.ts). The sign-in step offers “Use my own provider”
  beside GitHub's sign-in (hidden, with its reason, when the organisation fixes or forbids a provider of the user's own),
  which opens an optional detour (same position, “Step 3 of 6”): the provider's type, address, API key (not needed for
  a model server on this computer, also where there is no keyring) and model names,
  the consent note for that exact host, and one prominent button, “Agree and check the models”, which saves, keeps the
  key, records the yes and asks the service for its model list. Nothing says the provider works until that answers; a
  failure is written in the step (status line, red words) and a provider that didn't answer is switched off again.
  A failed connection offers what its reason calls for (`failureView`): an entitlement failure leads with the user's own
  provider or a different GitHub account, never the same sign-in. A failure of the user's own provider leads with
  “Check my provider's details” (or Try again for the network), with no GitHub account, sign-in or Copilot words, in
  first run, Home and the bubble's title alike (integrations-3). Once connected, “Models I'll use” names both models
  with the premium-request multiplier where Copilot gives one, and says so when tasks work from text only; Change is
  optional. A setup fix that fails says so in its own row. Once Ember is connected to the user's own provider, the
  sign-in step, its status line and **Your Ember**'s “Model service” row name that provider, never Copilot, and Back
  from the setup check returns to the provider's step (first-run-1).
- **First run** (settings' `#welcome`, until Start): only its steps show, in a 640 px column (720 px in a window
  1,000 px wide or more), centred in the window's height in a box of one size (560 px), so the indicator and title stay
  put from step to step and a short step no longer leaves the window's lower half empty. A still step indicator
  (seven 4 px capsules, lit up to the current step, `--accent` and `--hud-dim`), "Step n of 7" in the footnote style,
  Ember's character on its tile beside its line as the step's large title (148 px on the first step, 76 px after),
  and the step's own part. The buttons follow the step, never stuck to the window's foot: Back leading, the step's
  quiet choice (Not now, Skip for now, Cancel), then its one prominent button, with the reason beside it whenever it
  waits (`aria-describedby`). Rows that need the user, the tries and **Your Ember** are grouped rows on `--surface-1`;
  the full consent text and the setup rows' details are disclosures (an accent chevron and words) over a
  `--surface-2` callout. Every state is a symbol and words. Motion: Ember arrives once (0.6 to 1 over 600 ms on the
  brisk spring, then a happy hop), each step's part comes in from the side it lies on (16 px over 420 ms, Back from the
  other side) and then holds still, a try's check lands on the reward spring, and the summary's lines arrive 30 ms
  apart; Calm shows it all at rest.
- **Catalog cards** (settings › Extensions › Browse): a marketplace's entries as cards on
  `--surface-2` inside their group, in columns of at least 240 px; the name with its kind as a
  neutral tag, the publisher's description (cut to whole words), who and where it comes from in the
  tertiary label, and a quiet **Add** or **Connect** (**Added** with a check once added). The consent
  card opens in the card pressed, across the whole row, with the one prominent button. Each tool of
  an added item carries a tint tag in words: **Read-only** (green), **Can change things** (yellow)
  or **Changed** (red).
- **State:** one symbol family (working, waiting its turn, waiting for you, done, failed, stopped)
  beside the words on every surface, with the state in words for screen readers; never colour alone.
- **Shape:** radii 6 / 8 / 10 / 14 / 18 and capsules; nested corners are concentric.
- **Motion:** Apple's springs (`Spring(duration, bounce)`) as CSS `linear()` curves: smooth (bounce 0)
  for what glides, brisk (0.15) for entrances from their source, reward (0.3) for a completion
  flourish once and never on a question or an error; durations from 220 ms (a press) to 600 ms (a
  rare large move), fades of 180 ms in and 130 ms out. Endless animations (pulses and the focus ring's glow)
  change only opacity, each on a layer of its own, so they never repaint; the thinking glow breathes
  three times and stops, and so do the presence ring's glow, its done and the bubble's lock-on. The
  handle's microphone halo is steady. The script-driven motion is the presence meters (20 changes a
  second at most, only while there is sound) and the character. Calm mode and the desktop's reduced
  motion stop all of them, in every window, but for one fade of 150 ms where a surface comes and goes:
  main puts `html.calm` on each of Ember's pages as it loads and when the setting changes
  (`app/main/page-prefs.ts`).
- **Icon** (`assets/ember.svg`): Apple's icon grid (a 104 px continuous-corner tile on a 128 px
  canvas, with its shadow) in the app's warm graphite, lit from above, Cinder silhouetted against its
  own glow. At 32 px and below (`assets/ember-small.svg`) the tile fills the canvas (on Apple's grid in
  the macOS icon), with a lighter graphite and rim that hold on a dark taskbar, and Cinder keeps only
  the flame tufts, the coal's lit rim and the eyes. On Linux every window carries the icon too.

## Code

`packages/characters` (rig, renderers), `packages/bubble`, `packages/motion`.
The interactive prototype is `demo/character-lab` (`npm run build:lab`).


## Reviewable work and local inventories

Projects has its own pane. Selected files show count/size and individual Remove, without clearing the request.
The currently running request/provider snapshot is immutable; failed work retains previous readable output.
Answers and fenced code are inert text with Copy controls; native export writes only the main-owned displayed
answer/diff to a chosen destination, with overwrite/freshness checks. It cannot overwrite a selected source file
or Ember's private data, and never substitutes for Apply patch approval.

Memory has query/source filters, counts and pages of 50. Surviving memory and learned-word controls keep their
DOM identity and keyboard focus through background updates. Undo acknowledges only successful deletion and stays
retryable on failure. An unavailable account hides facts and returns focus to the memory switch. Correct… opens
one local draft (up to 400 characters); Save correction is explicit, checks the exact account/revision and saves
durably before publication. Correction preserves original source/authority and adds Corrected by you. It invalidates
stale recall/learning/vector work; failures keep the draft and account reset clears it.

Upcoming reminders show local due time, words and actual persistence state, with explicit Edit and Cancel.
Edits bind the exact original record and persist before changing its timer; text-only edits preserve seconds.
Delete all names both routines and reminders and requires an explicit second choice. Failed writes retain the
original, authored edits survive background updates, and older reads cannot overwrite a pushed list or account reset.

The desk's Read desk contents panel performs an explicit local accessibility read without taking over. It lists
bounded inert app roles/names/text, omits private fields, secret descendants and leaked values, and marks partial
snapshots. It does not expose interactive app controls or replace a remote accessibility tree. Consent and a known
unlocked screen are required before and after reading, and a hidden/replaced desk invalidates the reply. Refresh
uses keep:false so the worker's action/approval identifiers are unchanged.
