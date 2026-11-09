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
  - awake and Ready with nothing passing, only the breath and the idle float move, under a third of a pixel a
    step: between blinks and fidgets the overlay, the handle and Home's hero draw it about 6 times a second
    (`restingGap`, `RESTING_FRAME_MS`), waking in time for the next one, where they drew 15–24 times a second. With
    the blinks and the first minute's fidgets drawn at their own rate, the overlay and the handle still draw 11–16
    times a second awake at rest (the pointer moves often enough to keep Ember there). The eyes count as still once
    less than a tenth of a pixel of their travel is left (`LOOK_STILL`), which saves the handle, whose eyes wander
    because the pointer isn't over it, about a tenth of its drawings (14.7 to 13.6 a second). An idle glance holds its
    look once the eyes are there, so the rest of its 1.2 s is drawn at the resting rate too, waking as it ends for the
    eyes to come back (39 drawings a glance to 21; the overlay 13.2–14.1 a second to 10.6–11.5, the whole tree 7.6–8.3 %
    of a core to 6.0–6.8 %); while Home sits behind the window you are working in, its still faces aren't drawn at all
    until it takes the focus, the pointer comes over it or something changes (`homeFrameGap`; a glance held there is
    drawn on, so its eyes come back);
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
  secondary label (the task's goal; under a step or command the user didn't ask for, or once text
  on screen or a command's output tried to steer the task, their own words in curly quotes, never
  the goal passed off as theirs);
  its title ("May I?") is the quieter lead-in, its keys show as keycaps under the buttons (under a
  note's line when a spoken answer wasn't taken, never replaced by it: `stepParts`; on the
  no-compositor corner card too, above its buttons; on both each chord kept on one line with its word, broken under
  its keycaps only where it alone is wider than the row, and on the bubble with the " · " between two only where
  they share a line, and none before the first, which a screen reader read though it was clipped from sight), four corner
  brackets lock onto the bubble once (180 ms) and then hold still, and nothing about it pulses. A **risky** question (one policy asks about every time: send, delete, pay,
  install…) adds a "Risky step" tag, caution-yellow brackets and an Allow that is bordered rather
  than filled, so nothing invites a reflex yes; screen readers hear "Risky step." first. The
  no-compositor corner card marks it the same way: the tag beside Ember's name and the bordered
  Allow; in its narrow column each chord is a line of its own, with no " · " left at a line's end, its
  keycaps together and its words wrapping under them where the column can't hold both (the Shift chords'
  "shows the next part" at Large and Larger).
  The card grows for any question (up to 640 px, inside the work area) so its sentence shows
  whole at Large and Larger text too, and where even that can't hold it, its answers but Not now
  take no press until the sentence shows. A step Ember took **without asking** (Work without asking) shows its announcement with a
  "Without asking" tag in the accent tint, set only by Ember (`BubbleState.autonomous`): a task's
  own note never carries it. When
  "Thinking…" has heard nothing from Copilot for 10 seconds it says "Still waiting for Copilot…"
  (or "Still waiting for your model provider…" or "…for the model service…" when that is the one in use) with **Stop** (that turn only; tasks go on), and so does a turn that goes quiet for 30. Its step names the keyboard's ways to stop,
  which the bubble's Stop can't offer ("Or press Ctrl+Alt+E and use Stop response in Home. Ctrl+Alt+X stops
  everything.", each key only while Ember holds it), and screen readers hear the wait and that step once. Meanwhile the
  settings key opens Home at **Stop response**, whatever pane it was left on, so Enter stops the reply. A problem
  offers **Open settings** where settings can fix it, otherwise **Try again** where asking again is
  safe (the conversation's own request, whose turn ran no tool). A request the runtime stopped under
  before it reached the model keeps its Try again while Ember reconnects, and once Copilot is back
  the bubble says "I'm connected again. Try again?" (and Home's conversation line for it, "I'm connected again: send
  it again."). An answer whose turn started a task
  says "Its card in the corner shows how it's going.", so the bubble and the card tell one story. Under a finished
  answer (and only that answer) the bubble may show what you might say next: a caption, "Ember suggests", then up to
  three quiet 24 px capsules (never the accent, never under a question), in its clickable area; the Ask box shows the
  same as a row of 20 px capsules under its hint line while the field is empty (docs/ASSISTANT.md §7); a typed letter
  puts them out of sight but keeps their room, so the box and its field don't move. Neither shows any while a question
  is up, and the box shows the ones that follow the answer ("Close it", "Read it out") only while that answer shows,
  and the ones that answer its last words, usually an offer ("Yes, please", "No, thanks"), only while those show too:
  not while the bubble cuts it short under **Read all**, and opened in full only once its last line has been in view,
  all of it at once or scrolled to (the overlay says so: `endShown`; without a compositor the corner card does, for
  the words it shows), as one cut short to the room or longer than
  its sixteen lines isn't at first (`askSuggestions`; a change while a reply is typed waits until the field is
  cleared). While
  the box is open its row keeps the room it opened with, rows and all: none to offer puts the row out of sight, fewer
  keep its height, ones that would need more rows than it opened with wait for its next opening (those it shows that are
  still offered stay), and ones that come into a box that opened with none wait too, so a question coming or going never
  moves the field. A box that opens beside an answer still coming in, with none to offer yet, keeps their row's room,
  empty and out of sight, so the answer's follow-ups land in it, where the keyboard reaches them (the bubble takes no
  keyboard), and the field doesn't move (`askSuggestionsComing`), but only while **Suggest what I might say next** is
  on (off, none can come, and the row would stay blank) and where the tallest finished answer still has
  a place by Ember clear of the box with that row (`answerRoom`, `ANSWER_MAX_HEIGHT`): elsewhere the row would take the
  room the answer needs once it finishes, so there they wait for the next opening. A question's
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
  its mark (no shake, no flash). The Ask box grows out of Ember beneath it, and opens beside the
  bubble, or over or under it where it fits beside neither (larger text, a 1024-wide screen), never
  on it nor on Ember (the bubble never moves for it, but for an answer opened in full with **Read
  all**, below). A bubble that comes up while the box is open
  keeps off it where it can (never hiding for it); a question, or its own Listen once's
  "Listening…" (never a wake's), that finds no room moves the box aside once (again only once it
  has grown under the field: a spoken yes that wasn't taken adds its note), and a bubble already
  shown, a question or an answer being read, never moves for the box (but for an answer opened in
  full, below): where the box can't keep clear of it whole (a small screen at Larger text), the box
  may come against it. An answer that
  grows into the box on its own, as its words come in or as it finishes (its Read all, its hint
  and Ember's suggestions come only then), keeps off it from there, going above or below the box
  where nothing by Ember is clear of it, so the field never covers its last lines or its Read all;
  so does one that started while the box was open (Ask opened during "Thinking…"), and anything
  else still coming in that asks nothing (a step, "Listening…") and finds no room by Ember, and an
  answer opened in full with **Read all** while the box is open. An answer opened in full that fits
  nowhere clear whole (a 1024 x 768 screen at Larger text) is cut short a line at a time to the
  tallest place clear of the box, the handle, the cards and the settings window, never under three
  lines, and its text scrolls inside it; with no such place it goes where it always went. Once
  the box closes, one whose text didn't all show for it (cut short, or narrowed into a side strip
  with its text running on) keeps off the box's place no more and shows whole where it can (it may
  move to do so); one that showed whole stays where it is. When the box opens on an answer opened in
  full that doesn't keep off it where it is now (the one that moved; one opened with **Read all**
  while the box was closed; one opened while it was open that showed whole, so stayed put once it
  closed), or grows into it as it opens or as Ember's suggestions come, the answer keeps off the box
  there from then on as it does with Read all, so the field never lies over its lines; a box that
  opens or grows clear of it never moves it.
  While the box is
  open no bubble goes on its timer, so the answer being replied to stays beside it; once the box
  closes, each goes after what was left of its time, never sooner than 4 s (`ASK_AFTER_MS`, times
  More time to read). Without a
  compositor the box moves off the corner card as it grows for a question. What the box shows keeps off the task cards
  too, as it opens, grows, shows a new row and as a card comes up or grows under it: by the least sideways move (else
  up) that keeps it clear of the answer or question, the handle and Ember, which come first (on a 1024-wide screen at
  Larger text there may be none). On Linux it takes clicks only on what it
  shows (an X input shape the page reports), so a click in its clear margins reaches the app
  beneath and closes it. The line under its field is as wide as the field while the quick look
  runs; when it finds nothing to show, it narrows to its keys at the trailing edge. A long paste is kept
  whole there as in Home's composer: from 1,800 characters a line under the field counts them, and over
  2,000 says how many too many while Enter sends nothing. In Calm, each of them fades over 150 ms instead.
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
    tick, so nothing moves or re-lays out), then "Close to my limit" past 80% of its 150 steps or 20 minutes (the
    worker is told then too, so it can finish and say what's left; a task a limit stops says what it had done by then,
    from Ember's own count, and its Try again is told an earlier try stopped part-way), else how many steps the user
    allowed. Once it ends, the state's word and how long it took ("Didn't finish · Took 1:12");
  - the steps so far in one sentence ("Clicked 3 times and read the window 2 times (1 didn't work)"), a picture of
    the window sent to the model named first ("Sent the model 2 pictures of the window, …"), then what changed things
    before what only looked;
  - its plan, a dot per step (`report_progress`'s `plan` and `now`): done, under way (the accent, weight 600), to come
    (the step a failed or stopped task was on keeps its weight in red or grey, not the accent);
  - **Details**: up to six rows of what it did (steps of one kind in a row folded together, "Read the window 3 times in
    Settings", and a read that sent a picture of it apart, "Sent the model a picture of the window in Firefox"; a refusal with policy's reason, or Ember's own (a password prompt open, the accessibility helper not working), refusals for one reason in a row folded together too ("Not allowed 6 times: …"), and one that came once the user had answered its question after that answer; a question and how it was answered; the worker's notes, marked as
    its words), each with a static state symbol and when it happened. Closed until the user opens it, kept open by
    task id across updates;
  - when it ends, what it found or made, as a **view**, and on a failure, or a question that ran out of time while the
    user was away, **Try again** (the same request starts again as a new task, asking every question again) beside
    **Close**. Never after "Not now", a Stop or the mouse taken back: those were the user's own choice.

  The words come from `app/shared/activity.ts` (one table of state words: Working, Waiting for you, Waiting its turn,
  Retrying, Done, Didn't finish, Stopped, and No answer in time for a task whose question ran out of time, which the
  user didn't stop: so its card, the handle's task row, the conversation's line and What Ember did say so, and its last
  row and its question's row read "Ended: No answer in time" and "Ended: Asked you: no answer" to a screen reader) and `app/main/agent/activity.ts`, which builds a task's activity from its
  worker's tool calls and Ember's own signals: never the model's arguments, its reasoning or screen text. A running
  task's symbol is a ring round a lit dot, which never reads as a spinner. A card with a view or a failure stays a
  minute (and waits while the user is away), and the stack widens from 270 to 320px to hold it; both widths grow with the text size. Without a
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
  when none does. A result says the words as the page shows them (`shownText`: no hidden alternative for a key
  another app took, no pop-up's options, which still find their setting, no words for screen readers only), one
  sentence of a longer footnote: the one with the words typed. Selectable labelled results show in batches of 12. ArrowDown/Tab reaches a chosen result, Enter selects it and marks its row, with its control focused (a group's header
  or footnote stands for the group: a one-row group's row, else the whole group). The sidebar grows with the text size,
  so its labels stay on one line, but never past what leaves a pane 460 px (no sideways scroll at 640–720 px). Below
  that, a pane never scrolls sideways either, down to 304 px at Larger text (200% zoom): its one column may shrink, and
  a pop-up's row puts the pop-up under its words. The links, most
  used first: Home, Projects, Models & connections, Voice, Your Ember, Memory, Apps & privacy, Comfort & access, Computers and Commands (once
  available), Extensions, Setup & about. The current pane's link carries `aria-current`, a fill that glides between
  rows on a click (`--spring-smooth-0`), and in a contrast theme an outline. The window reopens on the last pane. Below
  640 px the links are one row of capsules, the search field first.
- **General consent** holds Agree with “Checking where your requests go… Wait a moment.” until the recipient is
  known. Any change to the recipient or the shown agreement re-arms its half-second stray-press guard (first-run-c7-1).
- **Voice focus** uses “Set up Voice Match” and a separate name-free state description when focus returns after
  teaching or forgetting a voice. The full visible explanation remains available to read. Ask's focused field says
  “Ask or tell me”, with a short visible “Ask…” prompt so an empty field stays one line at narrow widths and Larger
  text (companion-v7-2). Its window and page title are “Companion request”, so opening it does not read the wake name
  into the microphone (voice-listening-r6-2, voice-listening-q6-1). Voice Match failure lines use the first person and
  also update that focused description (voice-listening-r6-3).
- **Composer progress** says “Thinking… The reply will appear above.” to avoid reading the wake name, including its
  possessive, into an idle microphone (voice-listening-r6-1).
- **Setup focus** uses name-free accessible headings, while visible headings keep Ember's name. The Start result
  says “Started. Ready when you are.” so automatic screen-reader speech does not read the wake name into the microphone (first-run-r6-1).
- **Closing Home** hides its page for this running session, preserving unsent drafts and waiting-message recovery;
  it still ends Home's Listen once, teaching and Project work. Hidden Home draws no characters. Privacy erasure on
  sign-out or account change reaches the hidden page too; a policy lockdown clears the draft, and actual quit destroys
  the page (home-r7-1).
- **Home's status panel** is the window's one HUD part, on `--surface-1` and still: the presence ring round the
  character (dim, the accent, heavier when a task needs you, red with a notch for a problem; never animated), Ember's
  state in a few words ("Ready", "Working on 2 tasks", "Thinking…" while it answers what you sent from Home, "A task
  needs you" with **Open approval**, "Not connected", "Reconnecting…" while Ember's own model connection starts again
  by itself, as the handle and Ask say,
  "Needs setting up", "Locked by your organisation"), where Ember is and how to ask as a quiet caption, a link to the setup check when a row needs
  you, then two facts (which of listening, memory and commands are on; today's tasks by outcome, in their rows' words (a task
  whose question went unanswered "got no answer in time", never "stopped": tasks-approvals-r3-1), and the steps you
  allowed, from the same tasks Task activity lists) and **Ask Ember…** (the one prominent button; **Connect Copilot…**
  takes that place while Ember isn't connected, **Check my provider…** for the user's own provider and **Models &
  connections…** for the organisation's service (first-run-r1) or whenever Ember's own model connection stopped, which
  is never the provider's or Copilot's sign-in (accessibility-visual-c1-2), and nothing does while the organisation's
  policy locks Ember down)
  beside a quiet **Stop everything** and the stop chord. Under them two quiet links, **Write to Ember** (the
  composer, focused) and **Task activity**, keep both a step away however long the conversation grows.
  Home's Features line uses the targets runtime's current capabilities, including remote policy and agreements;
  saved or restricted SSH hosts are never counted as working connections. Listening
  shows on only with ready speech models and a waiting or active microphone; a missing or failed microphone shows off.
  A held lockdown immediately removes commands and other computers from that line (home-r6-1).
- **Home's setup check** says each row's state in first run's words beside its tint ("Ready", "Worth a look",
  "Needs fixing", never a code such as OK), in one column as wide as the widest word (a subgrid, so the labels line
  up), offers **Copy** for a command the row tells the user to run, and **Check again** under the rows, which shows
  what it found (“I checked again. Nothing has changed yet.”) beside it as well as reading it out, in first run's
  checks step too; a fix's failure is only read out, as its row shows it (first-run-r2).
- **The conversation** is part of the page, not a box that scrolls inside it: its latest 6 messages (so the composer
  and Task activity below stay within reach), then **Show earlier messages**. Home searches all 60 retained session entries (a search left typed in is cleared when you send, so your message and
  its reply show; the composer's line, right under its buttons, says "Thinking…" until the reply, "Still waiting for
  Copilot… Stop response ends this reply." while the bubble says so (for a request from the Ask box or by voice too,
  where the settings key lands on Stop response, until the wait ends: home-r2-3, but never over a note about the draft
  being written, such as Edit's caution that sending again may repeat actions or the over-limit note: home-c3-1), "This
  goes to the new model service once what's under way now has finished. Stop response cancels it." while it
  is held for a switch of model service (main's "held" turn, with the status word "Switching model service…":
  home-r4-4), and, when main says the turn ended with nothing
  written (it only started a task or ran a step), "No reply was written. Task activity shows any task this request
  started."; main sends a turn's lines (its reply, its Problem line) before its end, so a model error says "This reply
  couldn't be finished…" (home-r2-1), never counts a request waiting for a reconnect as over (home-r2-2), and says
  with the end when a Stop ended it: "Response stopped. Running tasks continue." for the bubble's Stop too, "Stopped
  everything, running tasks included." for Stop everything (home-c2-2); a Stop ends a request still waiting for a
  reconnect at once, and every message of the composer's that it ended before it went (its own line never came) comes
  back in the composer, oldest first, never over anything typed since (above it, the caret kept where it was), with
  "Your message wasn't sent, so it's back here to edit or send again." ("Your 2 messages weren't sent…", "…back here,
  above what you were writing, …": home-r3-1, home-v4-2), said once however main tells the Stop (home-r4-3); a typed
  "stop" still on its way to main is never taken for something being written (home-r4-2); above a request being
  edited the line keeps Edit's caution (and says it again once what is there fits after being over: home-v5-2), and
  Cancel edit keeps the words as the person left them (corrected, none once deleted: home-v5-1), followed through each
  change in the field, so a word typed into the request being edited, or a fresh request under an emptied one, is
  never kept with them, a deleted message never comes back and only those left are counted (home-w5-1, home-w5-2), and
  that request never stays (home-w5-4), above the draft from before Edit (home-r4-1); Edit on another request keeps
  them above it, as left and still words given back ("…The message that wasn't sent stays above it…"), so Cancel edit
  still names them and says when they're over 2,000 characters with that draft (home-w5-3);
  after an edited request is sent, the draft Edit set aside comes back, above any new words typed while Send waited;
  an acknowledgement of an earlier send never closes a newer Edit (home-c5-1);
  together over 2,000 characters, the line says to send them one at a time, never to send again (home-c4-2), but to
  shorten what was being written or edited where that alone is over (home-v5-3); one whose line came (Ember answered it itself, or it went to
  the model) never does, however far the conversation has moved past it (home-v4-1); a typed "stop" that stopped everything says so (sent also while Ember waits for the running tasks to reconnect, when other messages are refused: home-c2-1), and is kept in the conversation with Ember's
  "Okay, I've stopped everything."; the status panel says "Thinking…" while Ember answers any request, from the Ask
  box and by voice too: main's `conversationTurn`, never a guess, home-c1-1), shows explicit per-answer truncation beyond
  131,072 characters, and offers Copy and Edit. A Problem line that settings can help with names Models & connections
  (once) where the bubble says "Ember's settings (Ctrl+Alt+E)" (Home is them), and offers **Models & connections…**, which
  goes there (home-7; Try again stays the bubble's): only where the line sends the person there (a setting, a sign-in,
  Check again), never on one that sends them to their administrator, whoever manages their plan, IT or GitHub
  (home-r3-2, accessibility-visual-c3-2). A long paste is kept whole: from 1,800 characters the composer counts
  them, and over 2,000 it says how many too many and Send refuses until it fits. Its hint names the send key as the OS
  does (Ctrl+Enter; Command+Enter on a Mac), and a message's Copy says Copied on itself for 2 s. Messages kept from before a restart
  (**Keep my recent conversation**) show their day beside their time, and a quiet line under the last of them says
  they are for reading and Ember starts afresh below. Edit only fills the composer; a fresh Send is required. Home sends
  no foreground-window capture. While you write in the composer, a reply growing above it keeps the composer, its
  buttons and the line under them in view (also as a search cleared by Send brings the hidden messages back, and as
  the line itself says why a send was refused, that it is sending or thinking, or how a Stop ended it: home-c3-2); nothing
  scrolls for someone reading elsewhere, or who scrolled away from it. A message whose Copy or Edit has the keyboard
  focus stays on the page, with those after it, while newer ones come, and Send, Stop response and Copy keep the focus
  while main answers them (`aria-disabled`, never `disabled`, which drops it to the page). **Read the last
  answer** and a long answer's **Open conversation** open it at the newest answer, focused, from its top (once the
  messages have come, when Home opens for it). Stop response cancels
  the current answer (or says there was nothing to stop, and the bubble keeps what it showed); Stop everything also
  stops tasks. New conversation asks first while there are messages to clear ("Start a new conversation? This clears
  the 12 messages here", and "deletes the copy saved on this computer" when one is kept), with the focus on **Keep
  this conversation**; Escape keeps it too. Drafts
  remain in memory while switching panes and clear on account reset, independently of ordinary empty-list updates.
- **Task activity**: one group per task, the one that needs you first, then those at work, then the rest, newest first.
  Its head is the state symbol, the title, a line of state, clock (none for a task that never began: one in line, or
  stopped there), hand and place, and its steps in one sentence; then
  the plan as a checklist (done ticks, the accent dot for now, rings to come), then the timeline: rows of at least
  44 px with the time after the task began in tabular figures, a state symbol and Ember's words, steps of one kind
  folded behind a chevron (and refusals for one reason, each listed as the step it refused), a question with what it asked under it in Ember's words (the kind of step and the app, never the typed text or names from the screen) and how it was answered, the worker's notes tagged
  **Note** in the secondary label. Then how it ended: the worker's summary in the secondary label and its view, drawn
  by the cards' catalog code. A finished task folds to its head. Home offers exact-task Stop, retained safe retry (Try again
  wherever its card has it: a failure, and a task whose question went unanswered; none once the card has gone, never a
  greyed one nothing explains: tasks-approvals-r3-5), verified Show app and
  focusable View result. Capability hints never authorise an action: main revalidates the exact task and native window
  identity, while stale/remote/desk/locked/borrowing cases cannot raise another window. While a task waits for an answer, a callout in its
  group says where it is asked (the bubble, with the keys that answer it; the command window; or a consent card's window); Open approval opens the exact live question in a focusable card or its existing panel; Home never answers from
  transcript text. From five tasks, **All**,
  **Needs you**, **Working** and **Ended** filter it. A working task's clock is text written once a second. A task's
  group is drawn again when it changes (every step), and keyboard focus stays on the control it was on (Stop task, a
  steps row, Open approval), or on the task's own heading when that control is gone.
- **Settings panes** keep System Settings' grouped rows: switches at the trailing edge, a switch's note inside its
  row (Apps & privacy's **When Ember asks first**), pop-up buttons styled as one (Handle position too), and states
  shown as switches (**Follow my cursor**, **Hide Ember until it needs me**) rather than buttons. Voice shows its
  status row only while it says something the switch doesn't. About sets paths in the mono face and the issue
  address as words with **Copy**.
- **Labelled fields** (Models & connections' **Model provider**): a label, then its filled text field (`.field-row`, the never-look
  field's look and height), the field under the label below 480 px. A secret goes in a password field and is never
  shown again: once saved the row says **Key saved** with **Replace** (quiet) and **Remove** (a `--red-text` text
  button). Rows a switch governs show only while it is on, and rarely needed ones fold under **Advanced**. An edit of
  the provider in force to another host waits in the fields until its card is agreed and it answers: the hint says the
  host in force still answers, the card's quiet button is “Keep using <host>”, and a failed check says “Nothing has
  changed” (integrations-c3-1); a host that answers with no model list there is adopted and says it is asked for the
  model as typed (integrations-r4-2). A
  disclosure inside a group (Projects' patch, command and saved workspaces) has the folds' chevron (`details.disclose`),
  a lone button (Refresh list, Choose command folder…) keeps its own size in a row of actions, and an empty status line
  takes no row: every status line in Home stays on the page while it says nothing, as a box of nothing out of the flow,
  never hidden, so a screen reader announces it when it speaks (an alert may hide: it is announced as it shows). The
  command and prompt windows' status lines (a refused press's line, the hints, "Starting Ubuntu…") do the same. Home and
  Ask announce nothing as the microphone opens for a request, or while it is open, since a screen reader says it
  through the speakers into what Ember hears: the voice line is said once it has held for a second and never while a
  window is open, and Listen once's line is said through a status line of its own, which never says "Ember is already
  listening.", nor "Answer Ember's question first." while a conversation waits for that answer (shown under the button,
  as its description). While they say nothing new, both of those status lines are emptied, so reading the page never
  finds a line beside the one shown that no longer holds. Hear me more clearly's line, the voice row's line and the note
  that no voice spoke a reply are said the same way, each through a status line of its own: once it has held, only when
  its words change, and never while the microphone opens or is open for a request. The voice row's says only where
  the voice stands, never that it is checking or downloading, nor a line that the checking overtook before it was
  said, and the voice loading again after two quiet minutes changes nothing it says; Try again's outcome is said even
  when it ends as it did before. Task activity says a task's new state only once the
  microphone has closed (each task's state as it is by then, once), the connection line is written only when its words
  change, and Ask says what it will see, or that it can't answer, once the microphone has closed, while it is still
  open. These lines, and Listen once's, are worded without Ember's name: said into the wake word's microphone,
  “Ember will see: …” and “Ember couldn't speak: …” woke Ember and were sent as requests. So are the lines Home says
  by itself or after a press, outside those windows: the status panel's (“Beside your cursor. Press Ctrl+Alt+Space to
  ask anything.”, “… Reconnecting to Copilot…”), Hide's (“Hidden. It shows itself again…”), the composer's outcome
  and refusal (“This request got no answer. …”, “Reconnecting to Copilot. …”), what Hear Ember found (“Spoken in
  Kitten Nano.”), and how Voice Match's teaching ended or the voice was forgotten (“Your voice is learnt. …”), which
  also leaves out the “Ember, stop” the shown line quotes: said into the microphone, it stops Ember. Listen once's lines
  (“Stops speaking first, then listens for one request.”, “Stops the answer on its way, …”, “Checking what was said…”)
  and where the update check stands (“Version 0.10.0 is out.”, “Couldn't check for updates. The next check is
  tomorrow.”) are worded the same way, without even “Ember's”, but for “Answer Ember's question first.”, said while a
  question holds Listen once back outside a conversation (read into the wake word's microphone, it woke Ember in none
  of 120 placements): “Stops Ember's answer, …” was heard as “Stop Timbers' answer, …” and woke Ember. Ask speaks
  in the first person (“I'll see: …”).
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
  a model server on this computer, also where there is no keyring, when the button waits with “I can't keep a key
  safely on this computer.” beside it; its field says a key is saved only while the address typed is the one it was
  saved for) and model names,
  the consent note for that exact host, and one prominent button, “Agree and check the models”, which saves, keeps the
  key, records the yes and asks the service for its model list. Nothing says the provider works until that answers; a
  failure is written in the step (status line, red words) and a provider that didn't answer is switched off again.
  An unsaved key belongs to the host where it was entered: a different valid host or port clears the field, including
  a saved-address prefill when reopening it. Path-only edits and unfinished URL typing retain it (first-run-v7-1).
  Main's words for a check or a connection (written for Models & connections, which speaks of Ember) are said in first
  run's own voice on every visit, on the sign-in step too: “I can't reach <host>…”, “…and I'll connect in a moment.”
  (`inMyVoice`, first-run-r4-2), and what they call Ember's comes along: “…the GitHub sign-in I found (my saved
  sign-in)”, “I couldn't find one of my files”, “My model connection keeps stopping…” (first-run-v5-1, v5-2). Their
  “press Check again” is Home's button: the sign-in step says its own, “…then press Try again.”, and shows Try again
  wherever nothing else on it does that check (a refused token, the organisation's service), keeping Check again only
  where the GitHub CLI's button is shown; the in-use provider step, which has neither, says “Go back and press Try
  again” (`signInWays`, `pressOnStep`, first-run-w5-2).
  A failed connection offers what its reason calls for (`failureView`): an entitlement failure leads with the user's own
  provider or a different GitHub account, never the same sign-in. A failure of the user's own provider leads with
  “Check my provider's details” (or Try again for the network), with no GitHub account, sign-in or Copilot words, in
  first run, Home and the bubble's title alike (integrations-3). Once connected, “Models I'll use” names both models
  with the premium-request multiplier where Copilot gives one, and says so when tasks work from text only; Change is
  optional. A setup fix that fails says so in its own row. Once Ember uses the user's own provider, connected, still
  connecting or failing, the sign-in step, its status line and **Your Ember**'s “Model service” row name that provider,
  with no GitHub, Copilot or sign-in words and no “Use my own provider”, and Back from the setup check returns to the
  provider's step (first-run-1). A provider already in use as that step opens is shown as in use (“Your own model
  provider's details”, its connection's status, the card without a last sentence about going back, and Continue with
  no new check); Back leaves it on, an edit is checked as typed before it replaces anything (one that fails, or is left
  while it is checked, changes nothing: “Nothing has changed: I'm still using <host>.”, in first run's voice throughout, with the focus on
  the field the failure names and “Keep using <host>” under it to put back the details in use and go on: first-run-c3-1), and only “Use GitHub Copilot instead” switches it off (first-run-r2-1). Back puts away only a provider the visit itself set up, as its card says (first-run-c1-2). It is in use only while it is on: after “Use GitHub Copilot instead” its step opens again as one to set up, and a check there that fails switches it off again (first-run-r3-1). That press draws Copilot's sign-in at once, connecting, so the title the focus lands on is Copilot's before main's status follows; a switch-off that couldn't be saved shows the provider still in use, under the notice that says so (first-run-c3-2). While Ember is busy (a turn or a task under way) the step says “I'll switch to Copilot once I've finished what I'm doing.” with Continue open, “Use my own provider” still offered (first-run-r4-1) and no sign-in yet, and the try step's Ask “Once I'm connected, you can ask me something.”; main switches as soon as it is done, and the step then offers “Sign in with GitHub” (first-run-v4-1): a focus on Continue as it turns into the sign-in goes to the title, and the line says “I've switched to Copilot. Sign in with GitHub to go on, or skip for now.”, so a press meant for Continue starts nothing (first-run-c4-1). A service with nothing to sign in to that isn't connected yet (the user's own, the
  organisation's) is named on **Your Ember** as “…, not connected yet”, never “Not signed in yet” (first-run-c1-3).
- **First run** (settings' `#welcome`, until Start): only its steps show, in a 640 px column (720 px in a window
  1,000 px wide or more), centred in the window's height in a box of one size (560 px), so the indicator and title stay
  put from step to step and a short step no longer leaves the window's lower half empty. A still step indicator
  (seven 4 px capsules, lit up to the current step, `--accent` and `--hud-dim`), "Step n of 7" in the footnote style,
  Ember's character on its tile beside its line as the step's large title (148 px on the first step, 76 px after),
  and the step's own part. The buttons follow the step, never stuck to the window's foot: Back leading, the step's
  quiet choice (Not now, Skip for now, Cancel), then its one prominent button, with the reason beside it whenever it
  waits (`aria-describedby`). Not now leaves focus on the note that says what it did, and Agree and Quit Ember drop a
  press for half a second after they appear, so a double click or a held Enter can't agree or quit (first-run-c1-1). Sign in
  keeps focus on its own button while it waits, and a cancelled sign-in moves it to the title, so a second Enter
  neither cancels nor skips (first-run-r3). Rows that need the user, the tries and **Your Ember** are grouped rows on `--surface-1`;
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

Memory has query/source filters, counts and pages of 50 (no count over an empty list). Each row ends with Forget,
a `--red-text` text button, and Correct… in the words' colour, side by side on one line however long the fact,
and apart, inside the group, when forced colours give them an edge. Surviving memory and learned-word controls
keep their DOM identity and keyboard focus through background updates. Undo acknowledges only successful deletion and stays
retryable on failure. An unavailable account hides facts and parks focus on Memory's heading, never the memory
switch, where a typed space would turn memory off; it goes back to the search, the draft or the Forgotten line when
the same account's list returns (memory-c2-1). A request opens Memory at its search ("forget…") or at its note's
words ("get to know me", Open Memory), never at "I agree, remember", and the note's agree button, like Work without
asking's, takes no press for `AGREE_ARM_MS` after the card comes up (memory-r7). Correct… opens
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
