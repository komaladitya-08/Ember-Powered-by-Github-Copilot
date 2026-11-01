# Conversational voice: a design plan

Status: proposal (2026-11-02). Nothing here is built. PLAN.md §9 item 9 points here; once a part ships, PLAN.md §10
records it and docs/DEVELOPING.md describes it.

The aim is that talking to Ember feels like talking to a real-time assistant: it answers at once, takes turns
naturally, can be interrupted by just talking, keeps one personality and says how a task is going, all within the
rules in CLAUDE.md "Safety and privacy" and PLAN.md §5. This document measures where the time goes today, ranks the
changes by milliseconds (or turns) saved per unit of work, and recommends a first PR.

## 1. What happens today

1. The voice process (app/voice/engine.ts) spots "Hey Ember", "OK Ember" or "Ember" and opens a listening window.
   Main reads the user's context at once (`captureContext()` on the wake event) and loads Ember's voice
   (`warmVoice()`).
2. Silero VAD ends the request after 0.6 s of silence (`MIN_SILENCE`, app/voice/sherpa.ts). Moonshine v2 transcribes
   it, the engine strips the wake phrase, checks for a stop, a closer or a filler, and emits `utterance`.
3. Main's `askEmber()` (app/main/main.ts) waits for the context (at most 3 s) and asks the conductor.
4. The conductor streams its answer. `SpeechStream` (app/voice/tts.ts) cuts it at sentence ends; each sentence goes
   to the speech process (Piper, or Kokoro where opted in and fast enough) and is played by the mic page.
5. When the turn ends, a request that came with a wake phrase gets one 8 s follow-up window
   (`voice.followUp(8000)`); a follow-up's answer gets none (`afterFollowUp`). "Thanks", "that's all" and the like
   (`isCloser`) end the window.
6. While Ember speaks, only "Hey Ember" cuts in, and only where the speakers' own stream is heard (Linux with parec:
   `rejectsSpeakers`). Elsewhere only "Hey Ember, stop", "Ember, stop" and the stop shortcut stop it.
7. A finished task is spoken (`onTaskFinished`); progress is not.

## 2. Measured latency

From the end of the user's speech to the first sample of Ember's reply. Measured on 2026-11-02 on an Intel Core
i5-10300H (4 cores, 8 threads), Windows 11, Electron 44.9.3, sherpa-onnx 1.13.8, with the shipped models from
`node scripts/voice/prepare.mjs`, after `npm run build`.

### 2.1 Method

- **End of speech → utterance.** Ember's own voice process (`dist/app/voice.cjs`, as a utility process, as
  `test/smoke/voice-backends.mjs` starts it) was fed `wake.wav`, `dnd.wav` and `name_wake.wav` from
  test/fixtures/voice in real time (one 32 ms frame every 32 ms, scheduled against `performance.now()`), three times
  each. The clock starts at the last 32 ms frame above −40 dBFS and stops when `utterance` arrives in main. The
  engine's own `ms` field (transcription and checks only) was recorded alongside.
- **Utterance → conductor.** From 47 real spoken requests in this PC's `%LOCALAPPDATA%\ember\logs\ember.log`
  (`voice.utterance` to `conductor.ask`).
- **Conductor → first sentence.** The real Copilot runtime (`copilot-runtime.exe`) against `test/mock-llm/server.mjs`
  at its default 30 ms a word, through `Conductor` with `onAnswerDelta` fed to `SpeechStream`, as main wires it. Six
  turns each of a direct answer and of `start_task` then an answer; the first turn is a warm-up and is left out.
- **Real Copilot.** Not timed directly (it would spend the user's quota). The same log has 14 real requests that
  started a task: `conductor.ask` to `task.queued` is one model call's time to a complete tool call.
- **Sentence → first audio.** Ember's speech process (`dist/app/tts.cjs`) with the Piper voice, `say` to the first
  `audio` message, median of five, natively and in WebAssembly (the Linux build).

The probes were scratch scripts and were not committed; the first PR (§5) commits one as a smoke test.

### 2.2 Results

| Stage | Native (Windows, macOS) | WebAssembly (Linux) |
| --- | --- | --- |
| End of speech → `utterance` | **751 ms** p50 (686–832, n = 9) | **823 ms** p50 (796–866, n = 9) |
| … of which the VAD's silence wait | 600 ms, by design | 600 ms |
| … of which transcription and checks | 50 ms p50 | 143 ms p50 |
| … the rest (the VAD's frame and hang-over, IPC) | about 100 ms | about 80 ms |
| `utterance` → `conductor.ask` | 1 ms p50, 2 ms p90, 9 ms max (n = 47, real) | same code path |
| `conductor.ask` → first token (mock) | 14 ms p50 | — |
| `conductor.ask` → first whole sentence (mock, 6 words) | 181 ms p50 direct, 207 ms after a `start_task` | — |
| `conductor.ask` → `start_task` called (real Copilot) | **2.45 s** p50 (1.32–5.16 s, n = 14) | — |
| Sentence → first audio: "On it." | **65 ms** | 194 ms |
| … "Sure, turning on Night Light now." | 218 ms | 588 ms |
| … a 14-word sentence | 446 ms | 1,145 ms |
| Piper's load (first reply after start, hidden by `warmVoice()`) | 3.7 s | 2.2 s |
| Audio message → speakers (mic page, Web Audio, device) | not measured | not measured |

Voice Match (the voiceprint of each request, `VoiceGate`) adds its own time where it is on; it was off here and is
not in these numbers.

### 2.3 Where the time goes

| Request | Today, end of speech → first audio |
| --- | --- |
| Mock model, direct answer | 751 + 1 + 181 + 218 ≈ **1.15 s** (native) |
| Real Copilot, direct answer | 751 + one model call (≈ 1.5–2.5 s, estimated from the 2.45 s above) + 218 ≈ **2.5–3.5 s** |
| Real Copilot, a task ("turn on Night Light") | 751 + 2,450 + a second model call for the words (≈ 1–2 s, estimated) + 218 ≈ **4.4–5.4 s** |

So: the model is 60–80 % of the wait, the silence wait is the largest part Ember controls (600 ms), the first
sentence's length costs 65–450 ms natively and three times that on Linux, and main itself costs nothing worth
optimising. A task request is the worst case: for about five seconds the user hears nothing at all.

## 3. Changes, ranked by impact per effort

| # | Change | What it saves | Effort | Needs |
| --- | --- | --- | --- | --- |
| 1 | Instant spoken acknowledgement | First sound **≈ 0.8 s** after speech instead of 2.5–5.4 s (2–4.6 s perceived) | S | — |
| 2 | Spoken-reply persona | 150–380 ms native, 400–950 ms on Linux per first sentence; shorter replies overall | S | — |
| 3 | Conversation mode | The wake phrase (≈ 1 s of speech) and its check on every turn after the first | M | a setting |
| 4 | Spoken task progress and completion | Silence during a 10–180 s task (14 real tasks: 9–180 s, median 22 s) | M | — |
| 5 | Earlier end of turn | 250–300 ms on complete sentences | M | eval clips |
| 6 | Interrupt by speaking | Saying "Hey Ember" (≈ 1 s) to cut in; makes long answers tolerable | L | Voice Match off Linux |
| 7 | Speculative conductor start | Up to 300 ms more, on top of 5 | L | 5 first |
| 8 | Opt-in memory of preferences | No latency; consistency ("call me Sam", "use Firefox") | M | `CONSENT_VERSION` bump |

### 3.1 Instant spoken acknowledgement (rank 1)

**What.** As soon as `utterance` reaches main, and before the conductor answers, Ember says a short, true
acknowledgement in its own voice: "Mm-hm.", "One moment.", "Let me look." It is a sound of listening, never a claim
about what will happen: not "Done" or "Turning it on", because policy hasn't decided anything yet and the model may
ask a question instead.

**How.**
- At `warmVoice()`, the speech process makes the six or so phrases once and keeps their samples in memory (never on
  disk: the rule for audio covers Ember's own voice too, and it keeps the code simple). Saying one then costs the
  IPC to the mic page only: about 0 ms instead of 65 ms.
- Main plays one on `utterance` when replies are spoken (`maySpeak()`), varied so it doesn't grate, and skips it when
  the transcript is a closer, a stop, a filler, or the answer's first sentence is already due (a cache-warm conductor
  can beat it: if the first sentence arrives within 300 ms, the acknowledgement isn't played).
- The answer's first sentence appends to it (`append: true`) rather than hushing it mid-word.
- On Linux without parec and on Windows and macOS (`rejectsSpeakers` false), the phrases contain neither "Ember" nor
  "stop" (`withoutOwnPhrases` already guarantees it for everything spoken).
- The bubble already shows "Thinking…"; nothing changes there.

**Saves.** First sound 751 + ~10 ms after the end of speech, natively and on Linux alike, for every request.
Perceived wait for a task drops from about 5 s to under 1 s; the real answer still comes when it comes.

**Risks.** Over-use feels robotic: no acknowledgement for a follow-up the conductor answers within 300 ms, and
never two in a row without the user speaking between them.

### 3.2 Spoken-reply persona (rank 2)

**What.** Replies to a spoken request are written for the ear: the first sentence short (at most about eight words,
so Piper starts in under 250 ms natively), no lists, no markdown, no addresses or code read out, one idea per
sentence, and the same warm, first-person Ember as the bubble.

**How.**
- The conductor's prompt is one session, so the voice persona can't be a second system message. Instead the request
  envelope carries a marker, as it carries `<context>` today: `<spoken/>` when the request was heard. A paragraph in
  `TONE` (app/main/agent/persona.ts) says what to do with it: "When the request has <spoken/>, your reply will be
  heard, not read: start with a short sentence of at most eight words, then at most two more short sentences. No
  lists, no symbols, no file paths or web addresses; say 'the file' or 'the link in the bubble' instead."
- `spokenText()` and `plainText()` stay the safety net for what slips through.
- The bubble shows the same words: one answer, two forms would confuse the transcript and the audit log.
- `persona.test.ts` pins the paragraph; the eval adds two tasks that check a spoken answer's first sentence length.

**Saves.** First sentence 6–14 words → ≤ 8 words: 218–446 ms → 65–220 ms natively, 588–1,145 ms → 194–600 ms on Linux.
Answers spoken in full take half as long, which also shortens the time before a follow-up window opens.

### 3.3 Conversation mode (rank 3)

**What.** A setting, "Keep listening after I answer" (off by default), under “Hey Ember”. With it on, every answer
to a spoken request opens a follow-up window, not only the first, so the user can go back and forth without the
wake phrase. The conversation ends on a closer ("thanks, that's all", "that's it", "bye"), on 20 s of silence, on
"Ember, stop" or the stop shortcut, on a typed request, or when the screen locks.

**How.**
- Engine: `followUp()` takes a `chain` flag that skips the `afterFollowUp` refusal; main passes it when the setting
  is on. The window is 20 s while conversation mode is on (8 s otherwise), counted from the end of Ember's speech as
  today.
- `isCloser` already covers the closing phrases; add "that's all for now" and "we're done" with tests.
- The handle and the bubble say "Listening…" the whole time the window is open (no silent listening), and the
  character's listening pose stays up.
- A follow-up's loudness check against the wake's (`this.voice = this.peak`) carries over to the whole conversation,
  so the TV doesn't take a turn. With Voice Match on, every turn is checked against the owner's voice as today.
- A request heard in a follow-up still counts as `voiceUnchecked` where Ember can't tell its own voice from the
  user's (owner decision V1), so it is never the user's own words for a dangerous command.

**Saves.** About 1 s of "Hey Ember" per turn after the first, plus its keyword check, and makes the turn-taking feel
natural. The consent text says the microphone stays off unless “Hey Ember” is on; that stays true, so no consent
bump is needed, but the setting's own description says Ember listens without its name for 20 s after it answers.

### 3.4 Spoken task progress and completion (rank 4)

**What.** For a task started by voice, Ember says how it is going at natural points, and says when it is done.
Completion is spoken today; progress is not.

**How.**
- TaskManager already reports progress (`onProgress` in host.ts) and the presenter already turns it into "Working in
  Settings". A small `ProgressVoice` class in main decides what is said: the first step after 8 s ("Still in
  Settings, nearly there."), then at most one line every 20 s, only when the step changed, only while nobody is
  speaking and no listening window is open, only for a task whose request was spoken, and never the step's raw
  text: a fixed set of templates filled with `friendlyApp` names, because step text can come from the screen
  (untrusted) and must not reach the speakers as instructions or private content.
- A question (approval) always takes priority and hushes progress; its spoken form doesn't change (§4).
- Completion keeps `onTaskFinished` but uses the spoken persona's length rule: the summary's first sentence, then
  "Details are in the bubble." when there is more.
- Two tasks at once: each line names the app ("In Files: …").

**Saves.** No latency; replaces 9–180 s of silence (the 14 real tasks in the log ran 9–180 s, median 22 s) with
two or three short lines.

### 3.5 Earlier end of turn (rank 5)

**What.** End the request after 0.3 s of silence when what was said is plainly finished, and keep 0.6 s otherwise.

**How.**
- Silero's `min_silence_duration` is fixed when the VAD is made, so the engine adds its own check: once the voice
  check (`speaking()`) has heard 0.3 s of silence in a listening window, it transcribes what it has (50 ms natively,
  143 ms in WebAssembly) and ends the request if the transcript is complete: it ends in ".", "?" or "!" from
  Moonshine, has at least three words, and doesn't end in a word that promises more ("and", "to", "the", "with",
  "or", "but", "because", "um"). Otherwise it waits for the VAD's segment as today.
- If speech starts again before the VAD's own 0.6 s, the early transcript is dropped and the whole segment is
  transcribed as today (the request is never cut in two).
- The eval's voice clips gain renderings with a mid-sentence pause ("Turn on… night light") that must not be cut.

**Saves.** 250–300 ms on most requests (751 → about 480 ms natively, 823 → about 600 ms on Linux, where the early
transcription costs more). Less on long requests, which more often end with "and".

**Risk.** Cutting someone off mid-thought is worse than 300 ms. The rule above errs long; the 0.6 s path stays.

### 3.6 Interrupt Ember by speaking (rank 6)

**What.** While Ember speaks, the user just starts talking and Ember stops talking to listen, without "Hey Ember".
The stop phrases and the stop shortcut are unchanged and always come first.

**How.**
- **Where the speakers' stream is heard (`rejectsSpeakers` true, Linux with parec).** Speech in the microphone that
  is not in the speakers' stream (the engine's `segmentStandsOut()` and speaker matching already tell them apart for
  the wake phrase) for 0.4 s hushes Ember and opens a listening window with that audio as its pre-roll, as a "Hey
  Ember" barge-in does today (`bargeIn`).
- **Elsewhere (`rejectsSpeakers` false: Windows, macOS, Linux without parec).** Ember can't tell its own voice from
  the user's by the stream, so it needs Voice Match: only speech whose voiceprint matches the owner's
  (`VOICE_MATCH_THRESHOLD`, 0.75) and not Ember's own voice (a voiceprint of Ember's Piper or Kokoro voice, made
  once from the speech process's own output and kept in memory, must score below the owner's) hushes it. Without
  Voice Match on, speaking doesn't interrupt there; "Hey Ember, stop" and the shortcut do, as today. The mic page's
  `echoCancellation: true` may already remove much of Ember's voice when the same page plays it; this must be
  measured on each OS before it is relied on.
- Hushing is the safe direction: a false interrupt only stops Ember talking. What is heard after an interrupt is a
  request like any other, with the same `voiceUnchecked` rule where Ember can't tell voices apart.
- **Never weakening the stop phrase.** The stop checks (`ember_stop`, `saidWakeStop`, `heardStopWord`, `isStop`) run
  before any interrupt logic and keep their own thresholds; the interrupt path adds a way to hush, never a way for
  anything to be taken as "not a stop". A test pins that every stop clip still stops with interrupts on.
- The kill switch remains a `StopPart` with its 300 ms bound; interrupting is not the kill switch (a task keeps
  running; only the speech stops) and says so in the bubble ("I'm listening.").

**Saves.** The ≈ 1 s wake phrase per interruption, and makes long answers acceptable because they can be cut short.

### 3.7 Speculative conductor start (rank 7)

**What.** Send the early transcript of §3.5 to the conductor at 0.3 s of silence even when it doesn't look complete,
and throw the turn away if the user goes on.

**Why it is last.** It saves at most the 300 ms that §3.5 doesn't already save, and only on the requests §3.5 leaves
at 0.6 s. Against that: every discarded turn is a Copilot request the user pays for; a speculative turn must not run
any tool (`start_task`, `show_me`, `describe_screen` all act or read the screen), so every tool handler would wait for
a "committed" signal, and an aborted turn must leave no trace in the conversation the model sees. Do it only if
§3.5's measurements show that many requests still wait the full 0.6 s.

### 3.8 Opt-in memory of preferences (rank 8)

**What.** "Remember that I use Firefox", "call me Sam": Ember keeps a few short preferences across runs and the
conductor sees them, so it feels like the same assistant every day.

**How.**
- Off by default; a setting, "Remember what I tell you to", with a list the user can read, edit and clear in Home.
- Written only when the user's own words ask ("remember that…", "from now on…"), typed or spoken, never from screen
  text, files or task results (untrusted), and never from the model's own initiative. The conductor proposes the
  entry through a `remember` tool; main saves the user's sentence as heard (not the model's paraphrase), at most 40
  entries of at most 200 characters, in the data folder (0700) as a 0600 file.
- Never kept: anything that looks like a password, key, card or ID number (the vocabulary's secret patterns), and
  never anything about approvals: a remembered "always send my emails" changes nothing in `PolicyEngine`, which
  never reads memory.
- The conductor sees the entries as `<preferences untrusted="true">` data at the start of each conversation.
- **Consent.** "Before Ember starts" says the rest of the conversation "is kept only while it runs". Memory changes
  what Ember keeps, so `CONSENT_VERSION` goes from 1 to 2, the page gains a line for it, and docs/DEVELOPING.md's data
  section lists the file.

## 4. What the safety rules rule out

Some of what makes a film assistant feel like one is out of reach on purpose:

- **Approving by voice.** "Yes, send it" can't approve a risky step. Approval comes only from a click or the allow and
  deny shortcuts (CLAUDE.md "Policy decides, not the model"), because a voice can be a call, a video, Ember's own
  speakers or someone else in the room, and Voice Match lets 2–3 % of other people through at its threshold. In
  conversation mode a spoken "yes" to a question is sent to the conductor as ordinary words, which can't touch the
  `Confirmer`; Ember answers with the question's own key hint (`questionKeyHint()`).
- **Cloud speech-to-speech or cloud transcription.** Realtime speech models that take audio in and give audio out
  would cut the model's 2–5 s, but audio stays on the machine and network calls go only to Copilot (or the admin's
  BYOK provider), which takes text. Copilot is also the only model service, and it has no audio endpoint here.
- **Listening all the time.** A conversation ends on a closer or after 20 s of silence, and the microphone stays off
  unless the user turned on “Hey Ember”. No always-on transcript, and audio is never written to disk.
- **Saying anything about a question's command or secret aloud.** A command is never read out (R7), and nothing from a
  password or secret field reaches the model or the speakers.
- **Reading screen text aloud as progress.** Step text can come from untrusted screen content, so spoken progress uses
  fixed templates (§3.4).
- **Voice as a way around a deny.** After "Not now" or a deny, a spoken "do it anyway" is a new request that asks
  again; it never retries the denied step silently.
- **Remembering on the model's say-so.** Memory is written only from the user's own words (§3.8), so a web page can't
  plant a preference.

## 5. Recommended first PR

**Instant acknowledgement plus the spoken persona (§3.1 and §3.2)**, with a committed latency probe.

- `test/smoke/voice-latency.mjs`: the §2.1 probe (voice process end-of-speech → utterance, speech process first audio,
  native and WebAssembly) printing one JSON line, so every later change is measured the same way.
- Speech process: a `prepare` message that makes the acknowledgement phrases once and keeps them in memory; main plays
  one on `utterance` under the rules in §3.1.
- `persona.ts`: the `<spoken/>` paragraph in `TONE`; the request envelope marks spoken requests.
- Tests: the acknowledgement decision as a pure function (closer, stop, filler, a fast first sentence, two in a row,
  `maySpeak()` false), the persona text pinned in persona.test.ts, the phrases free of "Ember" and "stop".
- Expected result: first sound ≈ 0.8 s after speech for every spoken request (from 2.5–5.4 s with real Copilot), and
  a first sentence 150–380 ms quicker to voice natively (400–950 ms on Linux).

Then, in order: conversation mode (§3.3), spoken progress (§3.4), earlier end of turn (§3.5), interrupt by speaking
(§3.6), memory (§3.8) and, only if the numbers justify it, the speculative start (§3.7).
