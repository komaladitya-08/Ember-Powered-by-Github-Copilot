# Towards a Jarvis-like Ember: voice, recognition and footprint

Research began on 2026-11-01. The dated phase entries record implementation and measurements; the 4 November
follow-up below covers recognition cleanup and idle release; §9 records the later user-chosen Kitten default.
Companion to docs/MEMORY.md (what Ember knows about you).

The goal: an assistant you talk to like a person. It hears you first time, answers before the silence feels long,
sounds natural, can be interrupted, knows you, and costs almost nothing while it waits. Every choice below has to
hold on Ember's hardest target: a RHEL 8 desktop with no GPU and glibc 2.28. Listening retains its one-thread
WebAssembly fallback; the current native-only neural voices use a local system voice when they cannot run.

## 1. Baseline measurements

**Latency, from the end of your sentence to Ember's first word.** Figures are from docs/DEVELOPING.md "Voice", on a
2.1 GHz Xeon.

| Step | Linux (WebAssembly) | Windows, macOS (native) |
|---|---|---|
| Silence before the request counts as finished (Silero VAD `MIN_SILENCE`) | 600 ms | 600 ms |
| Moonshine v2 tiny transcribes the request | 100–300 ms | ~50–100 ms |
| Copilot: time to the first sentence of the answer | not measured (network and model) | same |
| Piper speaks that sentence: first audio | **1,340 ms** | 330 ms |
| **Total, without Copilot** | **≈ 2.0–2.2 s** | **≈ 1.0 s** |

Answers are already spoken sentence by sentence while Copilot streams them (`SpeechStream`, app/voice/tts.ts). So
Ember waits for one sentence, not the whole answer.

**Footprint at idle.** Measured for this plan in a container: Xvfb with no GPU, 4 vCPUs at 2.1 GHz, a dev build,
voice consent given, listening for "Hey Ember". Chromium's fake microphone fed it silence. The setup page was open
because there was no sign-in. Figures are PSS (shared pages counted fairly) and CPU over 20 s, sampled from
`/proc`; per-page CPU came from DevTools.

| Process | Memory | CPU (of one core) |
|---|---|---|
| Speech recognition (utility; WebAssembly: spotter, two VADs, Moonshine) | 204 MB | 0.9 % (spotting pauses in silence) |
| Renderers (setup page, handle, mic page, hidden ask box) | 172 + 66 + 41 + 27 MB | setup page 9.0 %, handle 3.4 %, mic page 0.6 %, ask box 0 % (main threads) |
| GPU process (software compositing: no GPU) | 89 MB | 6.2 % |
| Main process | 100 MB | 0.2 % |
| Audio service | 28 MB | 3.0 % |
| Network service, zygotes | 45 MB | 0 % |
| **Total** | **≈ 770 MB** | **≈ 33 %** |

With a constant tone instead of silence the speech process rose to 2.5 % and the total stayed about the same. Not
counted:
- the Copilot runtime, a process of its own (not signed in here);
- the speech process for Ember's voice, which starts with the first reply;
- the overlay windows of a desktop with a compositor (this one fell back to the handle card).

**What this says.** At idle, the speech models are not the cost. Drawing windows is: renderers plus software
compositing make up most of the CPU. The biggest single latency on Linux is the voice running in WebAssembly. Both
are fixable without new models.

### 1.1 Every latency, measured (2026-11-02)

`scripts/perf/latency.mjs` times each step over many runs and prints the median and p95 (docs/DEVELOPING.md "Timing
the latencies"). Measured on a 2.8 GHz Xeon with 4 vCPUs in a container that other work kept busy (load average 2–3),
on Linux's WebAssembly speech, `main` and then the branch `ember-improve/20261102-perf`, one after the other. Voice
clips are synthesized with Piper's "Ryan" voice (not Ember's), in a quiet room's noise, and fed frame by frame on a
real-time clock (a frame waits for the one before it, so a slow transcription delays what follows). The answer streams
at the mock model's 30 ms a word.

| Step (median / p95, ms) | n | Before | After |
|---|---|---|---|
| "Hey Ember." ends → listening | 17–18 | 154 / 795 | 155 / 880 |
| End of speech → transcript, request after a pause | 17–18 | 833 / 923 | **721 / 775** |
| … of which the VAD's silence (audio time) | | 700 / 780 | 716 / 768 |
| … of which work after it (Moonshine) | | 125 / 229 | **1 / 20** |
| End of speech → transcript, "Hey Ember, …" in one breath | 13–16 | 902 / 928 | **705 / 873** |
| "Ember, stop" 0.4 s after a request → stop (after: ahead on / off, same audio) | 14 | — | 758 / 872 · 759 / 917 |
| First answer token → first chunk ready to speak | 24 | 180 / 540 | **150 / 300** |
| First chunk → its audio (Piper "Kristin", warm) | 24 | 818 / 1,925 | 865 / **1,218** |
| First answer token → first spoken audio | 24 | 994 / 2,465 | 1,015 / **1,473** |
| Ember's voice cold start (load and warm-up) | 5 | 2,196 / 2,474 | 2,115 / 2,211 |
| Typed question → first answer token (Copilot runtime, mock model) | 24 | 18 / 21 | 18 / 29 |
| Task start → first tool call | 24 | 112 / 146 | 112 / 156 |
| Task start → first action in the app | 24 | 637 / 713 | 642 / 692 |
| A worker tool call (any) | 96 | 112 / 1,941 | 79 / 1,947 |
| … `perceive_window` (AT-SPI read, marks, masking) | 24 | 49 / 80 | 47 / 79 |
| … `click`, `toggle`, `type_text`, `choose_option` | 6–18 | 461–478 / 468–648 | 458–475 / 463–648 |
| … `press_keys` (borrows the cursor) | 6 | 1,958 / 2,013 | 1,950 / 1,974 |
| Kill switch → `pull()` returned (answer streaming, mouse mid-glide) | 24 | 6 / 10 | 8 / 12 |
| Kill switch → everything stopped | 24 | 8 / 20 | 9 / 12 |

Requests said with a pause in the middle (four requests, two speeds, the same audio both ways) were cut short exactly
as often before and after: none at pauses of 0.3, 0.45 and 0.6 s, and 2–3 of 8 at 0.7 s, where the VAD's 0.6 s ends
them. Idle, after 35 s, over 20 s (`scripts/perf/footprint.mjs`, Xvfb, no sign-in so the setup page is open): 648 MB
and 29 % of one core before, 647 MB and 28.3 % after. Main 104 MB at 0.5 %; the speech process 202 MB at 1 %; the
renderers' main threads: setup page 5.3 %, handle 6.3 %, mic page 0.9 %, ask box 0 %; the GPU process 65 MB at 4.3 %
and the audio service 28 MB at 4.5 %. Xvfb has no compositor, so there are no overlay windows to measure (the handle
card stands in for them).

**What the numbers say.**
- After review (PR #137), a transcript made ahead is used only when the VAD's own speech ended by the time it was
  made: soft words after the pause, under the engine's silence test but speech to Silero ("Turn on night light … in
  the bedroom"), are in the VAD's segment, which is then transcribed. And only a request of up to 6 s so far is
  transcribed ahead (`AHEAD_MAX`), so a long dictation costs one extra transcription at most and no frame waits on a
  long one: "Ember, stop" said 0.4 s after a request came as fast with it as without (758 against 759 ms), and the
  slowest frame was 364 against 268 ms. The rows above are from after that fix.
- The request's end was the VAD's 0.6 s (0.7 s after the voice, with Silero's own lag) plus Moonshine's 0.13 s. The
  transcription is now made at the pause, ahead of the VAD (`SPECULATE_FRAMES`, app/voice/engine.ts): when the VAD
  ends the request with no sound since, that transcript is sent at once. When a request ends is unchanged. A first
  try that ended requests at a 0.45–0.51 s pause when they read as finished saved another 0.2 s, but cut "Turn on do
  not… disturb" at a 0.5 s pause (the voice tests) and most requests at 0.6–0.7 s pauses: it isn't in.
- Ember's voice in WebAssembly takes about 18 ms a character plus 0.2 s, so the first chunk's length is its first
  sound's delay. A first clause now counts from 18 characters (it was 25: "I can't do that one," was held for the whole
  94-character sentence, 1.7 s), and a first sentence said whole is cut at its first clause from 48 characters (it
  was 90). The median is unchanged (most first clauses were short already); the p95 fell by a second.
- A typed question reaches the runtime in 2 ms and its first token in 18 ms: Ember adds nothing worth cutting.
- A worker tool call is mostly deliberate waiting: 350 ms for Ember to fly to the control before acting (so the user
  sees where it acts), and the 1.5 s stillness before Ember borrows the cursor (a §10 departure). Perception itself
  is 47 ms. Neither wait changed.
- The kill switch returns in under 15 ms, far inside its 300 ms.
- One synthesized "Hey Ember." in 18 woke Ember about 0.8 s late in every run, before and after (the spotter heard
  it only with the request): a wake-word question, not a compute one.

## 2. What the research says

- **Cascaded beats speech-to-speech here.** Full-duplex speech models (Kyutai's Moshi: about 200 ms on an L4 GPU)
  sound the most natural. But they need a GPU with about 8–12 GB, often have non-commercial licences, and would
  replace Copilot as the brain, and with it Ember's tool policy. Sesame's CSM is a context-aware TTS, not a duplex
  model. Ember keeps the cascade (wake → VAD → ASR → Copilot → TTS) and makes each step stream and overlap.
  ([Moshi](https://arxiv.org/abs/2410.00037), [overview](https://learn.traeai.com/t/ai-engineering/phases/06-speech-and-audio/15-streaming-speech-to-speech-moshi-hibiki))
- **Streaming ASR is now cheap.** Moonshine v2 uses a sliding-window streaming encoder. Its authors report about
  50 ms to the first token for Tiny on an Apple M3, and that time doesn't grow with the length of what you say.
  Partial transcripts while you speak are what make the next item possible.
  ([arXiv 2602.12241](https://arxiv.org/abs/2602.12241))
- **Semantic turn detection.** A small classifier reads the partial transcript and decides whether you've finished.
  It replaces a fixed silence. Vendors report response time falling from 800–1,500 ms to about 300 ms. Namo Turn
  Detector claims under 29 ms per decision (about 295 MB multilingual; a smaller one per language). These are
  self-reported, and TEN's detector has a custom licence.
  ([Namo](https://blogs.videosdk.live/namo-turn-detection-v1-semantic-turn-detection-for-ai-voice-agents), [CallSphere](https://callsphere.ai/blog/vw7d-voice-agent-barge-in-turn-taking-2026))
- **Recognising *your* words.** sherpa-onnx's contextual biasing ("hotwords", an Aho-Corasick boost) works only with
  transducer models and beam search, not with Moonshine. For an encoder-decoder like Moonshine, the practical routes
  are: correcting the transcript against a vocabulary you own; giving the language model that vocabulary; and Voice
  Match, which is already built, to answer only you.
  ([sherpa-onnx hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html))
- **Natural voices on a CPU.** Earlier comparisons favoured Kokoro (82M), at about 3.5 times Piper's compute cost;
  perceived naturalness still requires listening tests.
  Supertonic reports a real-time factor of 0.015 on an M4 Pro (66M parameters, OpenRAIL licence: needs review).
  Kitten TTS nano is 24 MB, with audible clicks. Piper stays the safe choice for slow machines. All the numbers are
  vendors' or bloggers', so Ember's own bench (`scripts/voice/bench.mjs`) decides.
  ([Supertonic](https://huggingface.co/Supertone/supertonic/blob/main/README.md), [comparison](https://offlinetts.com/blog/browser-tts-showdown-kokoro-piper-kitten/), [CPU tests](https://localaimaster.com/blog/best-tts-without-gpu))
- **Electron's footprint** comes mostly from the number of processes. The levers are fewer live renderers, less
  drawing, and loading work only when it's needed ([Electron performance](https://electronjs.org/docs/latest/tutorial/performance)).
  PR #100 already started down this path on Windows: the camera service is gone, and idle windows close (about 50 MB).

## 3. Targets

Each target is measured by a repeatable script (phase 0) on the reference machine (2.1 GHz, 4 cores, no GPU) and
reported in every PR that touches it.

| | Today (Linux) | Target |
|---|---|---|
| End of speech → a sign Ember heard (sound or motion) | after Copilot answers | **≤ 150 ms** |
| End of speech → first word, without Copilot's time | ≈ 2.0 s | **≤ 600 ms** |
| Interrupting Ember by speaking → it stops talking | needs "Hey Ember" | **≤ 200 ms, no wake word** |
| Idle CPU (listening, silence, no window open) | ≈ 15–20 % (estimated without the setup page) | **≤ 3 %** |
| Idle memory (Ember's processes, PSS) | ≈ 600 MB (estimated without the setup page) | **≤ 400 MB** |
| Words wrong on your names, apps and projects | not measured | **halved** against the phase-0 baseline |

## 4. Decisions and phases

### Phase 0: measure it every time

- `scripts/perf/footprint.mjs` launches the built app headless with a temporary data folder, voice on and silence
  fed in. It prints PSS and CPU per process, and per page through DevTools, as this plan's numbers were taken, then the
  same as JSON. With `--max-cpu` and `--max-pss` (docs/DEVELOPING.md records the figures) it fails only on a large
  regression, never on noise. CI doesn't run it yet.
- `voice.latency` logs transcription time and the steps from transcript arrival to the first speaking report. `voice.hush_ack`
  logs how long the speaking renderer took to acknowledge cancellation. The logs contain no words (CLAUDE.md privacy).
  See the [timing fields in the development guide](DEVELOPING.md#how-speech-runs-native-synthesis-native-or-webassembly-listening).
- A recognition set: the user can record 20 of their own phrases, kept only on their machine, to measure word error
  rate before and after each change. CI keeps using the synthesized clips.

### Phase 1: answer faster (no new models)

1. **Native speech on Linux.** Build sherpa-onnx's C API (`libsherpa-onnx-c-api.so` and onnxruntime) for glibc
   2.28 in CI's `rockylinux:8` image, ship it in the RPM and AppImage, and call it through **koffi**. That fits the
   rule "koffi or WASM over native addons": no Node addon, no ABI coupling to Electron. `npm run check:symvers`
   guards glibc 2.28, and WebAssembly stays the fallback. This is the largest single gain: Piper's first audio drops
   from 1.34 s to about 0.33 s, listening costs 3.5 times less CPU, and Kokoro becomes possible on Linux. It needs a
   departure entry in PLAN.md §10 (`ember.nativeModules` stays `[]`, since it is a library, not an addon) and the
   packaging rules updated.
   **Built for development (2026-11-02):** no build is needed. sherpa-onnx 1.13.8's own prebuilt
   `linux-x64-shared` release needs only GLIBC_2.17, GLIBCXX_3.4.19 and CXXABI_1.3.7. app/voice/capi.ts binds it
   through koffi with struct layouts generated from its header (scripts/voice/capi-structs.mjs), and
   `EMBER_SHERPA_CAPI` (development builds, filled by scripts/voice/fetch-capi.mjs) turns it on. On a 2.8 GHz Xeon
   with 4 threads (bench.mjs), Piper's first audio was 137 ms against WebAssembly's 551, listening ran at a real-time
   factor of 0.075 against 0.136, and Kokoro ran at 0.565 on 4 threads (just over the 0.5 Ember needs).
   **Done (2026-11-03):** the RPM and the AppImage carry the two libraries in `resources/voice-native` (pinned by
   SHA-256, checked by check-symvers, 32 MB installed, about 9 MB of each package) and use them by default, with
   WebAssembly as the fallback (`capiChoice` in app/voice/runtime.ts; PLAN.md §10 "Native speech on Linux"). On a
   busy 2.1 GHz Xeon (4 vCPUs), `scripts/perf/latency.mjs` measured first token → first audio at 352 ms median, 626
   ms p95 (WebAssembly: 733 and 1,280), and bench.mjs listening at 0.077 of real time (0.220). Kokoro stays off on
   Linux for now (no setting there; 0.5 of real time needs about 4 free cores).
2. **Speak the first clause, not the first sentence.** (Built; from 18 characters since 2026-11-02, §1.1.)
   `SpeechStream` lets the first chunk end at a comma or dash once it has at least about 4 words, and keeps whole
   sentences after that. This saves the time Copilot spends writing the rest of a long first sentence.
3. **Acknowledge at once.** When the request ends, Ember reacts within about 150 ms, before Copilot answers: a short
   sound from the bubble and the character's "listening → thinking" motion. Optionally a spoken "Mm-hm" or "One
   moment", only when Copilot hasn't started answering after about 700 ms. It is never spoken over the start of an
   answer.
4. **Warm what's needed.** Load Ember's voice when listening starts, not at the first reply (its memory cost is
   measured in phase 0 first). Keep the Copilot session warm. Ask Copilot for a fast conductor model by default for voice
   turns: the model choice already exists, and the default becomes latency-aware.
5. **Shorter silence, safely.** (2026-11-02, §1.1: tried, and not built. Ending a request that reads as finished at a
   0.45–0.51 s pause cut requests the voice tests keep whole; the transcript is made at the pause instead, which takes
   Moonshine's 0.13 s off the wait without changing when a request ends.) Lower `MIN_SILENCE` to 450 ms only when the
   transcript so far ends like a finished request ("?", a verb's object, a known command shape). Keep 600–900 ms when
   it trails off ("and…", "the…"). This is a rule-based first step, and it needs streaming partials (phase 2).
   Measured against the false cut-off rate on the clip set. (2026-11-07: the trailing half is built. A request the VAD
   ends on a word no request ends on, "a", "the", "to", "and", "my", "um" and the like, with no "?" or "!"
   (engine.ts `trailsOff`), is held for 0.9 s (`TRAIL_HOLD_MS`) and joined to what follows: "And make the text a" …
   0.7 or 0.9 s … "bit bigger." is now one request where it was "And make the text a." (voice-listening-3). Nothing
   else waits longer, a stop after the pause still stops, and a cancel drops what was held. 2026-11-08: only what comes
   within 6 dB of the held part's loudness is joined, as a follow-up must come near the wake's: others' talk 12–19 dB
   under it was joined in 12 of 18 real-model cases and now in none; the half goes as it was (voice-listening-c1-2).)

### Phase 2: listen like a person

1. **Streaming Moonshine v2** (if sherpa-onnx ships its streaming export; otherwise run the
   chunked encoder through the same C API). It gives partial transcripts while you speak, so the bubble shows your
   words live. The 2024 streaming zipformer dropped the first 0.5–1.5 s in WebAssembly (PLAN.md M5). Re-measure
   under native before switching, and keep the offline pass as a final check while it's cheap.
2. **Semantic end of turn.** A small text classifier (evaluate Namo's per-language model; licence and size decide)
   reads the partial transcript and ends the turn early when you're clearly done. It waits longer when you pause
   mid-thought. Silero VAD stays the hard limit.
3. **Barge-in without the wake word.** **Built 2026-11-05** (conversations; §10 of PLAN.md has the measurements). While Ember speaks, your voice (VAD, after Chromium's echo cancellation, with
   speaker rejection where `parec` exists) stops it within about 200 ms, and what you say becomes the next request.
   Where Ember can't tell its own voice from yours (`rejectsSpeakers` false), keep needing "Hey Ember": since
   2026-11-03 "Hey Ember" cuts in there too (Ember never says the phrase there, the bare name doesn't cut in, and
   nothing said over Ember's voice is sent; PLAN.md §10 "Voice on Windows"). Spoken approvals retain the existing
   question-bound Voice Match and task-voice rules in PLAN.md §2 and CLAUDE.md; interruption never grants approval.
4. **Longer conversation.** **Built 2026-11-05**: a conversation stays open until “That's all” or 30 s of quiet. The plan was: the follow-up window grows from 8 s to "until a natural pause of about 20 s", with the
   mic dot showing it. You can turn it off. Done so far (2026-11-03): up to three follow-ups in a row, each in the
   voice that woke Ember, and "Hey Ember" said in a follow-up window starts a wake's; the window is still 8 s.

### Phase 3: understand *you*

1. **Your vocabulary from memory.** The names, apps, projects and places in Ember's memory graph (docs/MEMORY.md)
   become a personal lexicon.
   - A cheap phonetic match (Double Metaphone plus edit distance) corrects the transcript ("Pria" → "Priya", "Jura"
     → "Jira") when the match is strong. Ember also asks Copilot to read it as possibly misheard, with the lexicon
     given as untrusted context.
   - No audio is kept, only words you already taught Ember.
2. **Learn from corrections.** When you retype or repeat a request Ember misheard, the pair (heard → meant) is
   remembered as a `user` fact and used by step 1.
3. **Hotwords where the model allows.** If a transducer model beats Moonshine on your phrase set (phase 0), sherpa's
   hotword biasing with your lexicon becomes available. Otherwise Moonshine stays.
4. **A bigger model only where it pays.** (Taken 2026-11-05 everywhere: on a real microphone it heard 8 of 8 requests where tiny lost 4.) Moonshine v2 base had 8.4 % of words wrong against tiny's 10.5 %, for
   twice the CPU and 225 MB more (docs/DEVELOPING.md). Offer it as a setting on machines with spare cores, decided by
   the bench, never by default on the reference machine.
5. **Voice Match stays the gate** for "only my voice". Its threshold is tuned on the phrase set.

### Phase 4: sound natural (original proposal, superseded by §9)

1. **Kokoro on Linux** once native (phase 1.1), behind the existing "Use a more natural voice" setting and its
   real-time check (`NATURAL_MAX_RTF`). Piper stays the default on slow machines.
2. **Evaluate Supertonic and Kitten** in `scripts/voice/bench.mjs` (speed, memory, clicks, a blind listening pass).
   Adopt one only with a reviewed licence, a SHA-256 pin and a clear win.
3. **Speech-shaped answers.** For voice turns the persona already asks for 1–3 short sentences. Add spoken-style
   rules: contractions, numbers said as words, no lists. Pick the voice's speed and pauses per sentence type
   (questions rise, lists get pauses). (Partly built 2026-11-07: money, clock times, paths, "~" and "#N" are said as
   words, emoji aren't said, and a list's items end with a pause: `spokenText`, app/voice/spoken.ts.)

### Phase 5: cost almost nothing at idle

1. **Draw less.**
   - The overlay, the handle and Home's hero draw an awake Ready face at rest about 6 times a second (`restingGap`;
     measured on Xvfb with xcompmgr, Home closed: the overlay's canvas 14–17 drawings a second against 23–24, the
     handle's 15 against 21, the whole tree 8.7–10.1 % of a core against 11.4–15.2 %; Home's hero 11.5 against 18.4).
     Fidgets and the handle's idle saccades are most of what is left. They will stop drawing entirely after about 10 s
     still, and wake on any state change (the resting rate is the owner's decision). Home behind other windows draws
     its still faces no more (`homeFrameGap`; measured with Home open: Home's renderer 0.3 % of a core against
     2.5–3 %, its hero 0.1 drawings a second against 12, the whole tree 9.2 % against 11.6–12.9 %).
   - The main process moves Ember 60 times a second only while it or the pointer moves, and about 10 once both have
     been still for 2 s (`tickGap`): main at rest 1.0–1.15 % of a core against 1.8–2.2 %.
   - Software compositing (no GPU) gets a cheaper still frame.
   - Target: renderers plus GPU process under 2 % at idle.
2. **Fewer live windows.** Follow PR #100's pattern on every OS:
   - the setup page, the prompt window and the speak-only page close when unused;
   - the ask box stays (it must catch the first keys), but as one small page;
   - check whether the mic page can live in the handle's renderer process, saving one renderer.
3. **No GPU process where there's no GPU.** Measure `app.disableHardwareAcceleration()` and Chromium's software
   compositing switches on no-GPU machines. Keep whichever uses less memory and CPU with the same look.
4. **Load models only when used.**
   - Moonshine loads after the first wake, not at start. With native it loads in about 0.3 s, which is hidden behind
     the spoken request.
   - Ember's voice unloads after about 10 minutes without speaking.
   - Voice Match loads only while it's on.
   - WebAssembly memory never shrinks, which is another reason native comes first.
5. **The Copilot runtime.** Measure it, then cap it:
   - one conductor and at most 2 workers stay the limit;
   - finished sessions are already deleted;
   - add Node's `--max-old-space-size` for the runtime if its heap grows without bound.

### Phase 6: feel like Jarvis

Built on docs/MEMORY.md:
- Ember greets you by name and remembers the thread of yesterday's work.
- With proactive questions on, it can offer something when you're idle ("Want me to file those Jira notes from
  this morning?"). That's at most once an hour, never during a task, never by voice in a meeting (mic busy or screen
  shared), and silenced by "not now".
- Personality stays in the persona, with a switch between brief and chatty.

## 5. What does not change

Every phase keeps CLAUDE.md's hard limits:
- audio stays on the machine and is never written to disk;
- no new network destinations beyond pinned model downloads the user agrees to;
- approvals use the existing click, shortcut and question-bound spoken-answer rules in PLAN.md §2; neither a model
  reply nor an interruption grants approval, and “Always” and click-only cards remain unavailable by voice;
- the kill switch stops speech, listening and every task within 300 ms;
- Ember's own speech never triggers it.

New models are pinned by SHA-256, downloaded only after the user agrees, and must pass the bench on the reference
machine before they can become a default.

## 6. Order and expected effect

| Phase | Effect | Size |
|---|---|---|
| 0 Measure | every later claim is checked | small |
| 1 Native on Linux, first clause, instant acknowledgement | first word ≈ 2.0 s → ≈ 0.7 s plus Copilot; feels instant | large (packaging) |
| 5.1–5.2 Draw less, fewer windows | idle CPU about ⅓ → a few %; −100 MB or more | medium |
| 2 Streaming, semantic end of turn, barge-in | turns feel conversational; −200–400 ms more | large |
| 3 Your vocabulary | fewer misheard names | medium |
| 4 Natural voice | Kokoro-quality voice on Linux too | medium |
| 5.3–5.5 Lazy models, GPU process, runtime cap | towards ≤ 400 MB | medium |
| 6 Proactive companion | the Jarvis feel | after memory step 2 |

## 7. Personalisation: a voice that keeps learning you (built 2026-11-03)

The owner asked for voice that "keeps improving, recognizing my voice, and … predict[s] what I'm going to say next".
Three parts, all on this computer, measured with scripts/voice/match-bench.mjs and scripts/voice/words-bench.mjs.
What Ember keeps for them is in "Before Ember starts" and the microphone's card (added in `CONSENT_VERSION` 2).

### 7.1 Voice Match that adapts (app/voice/adapt.ts, adapt-sample.ts; main: app/main/personal/service.ts)

- **What it learns from.** Only a request (never a spoken answer to a question: main drops it before `voiceAnswer`
  answers) that the gate `verified`, with at least 2 s of voice after its wake phrase (`ADAPT.minVoicedSeconds`,
  whatever an answer may need; the voice process measures it and main checks it again), named by its utterance's
  number so a sample is only ever paired with its own request, that matched the print by `ADAPT.margin` (0.08) more than the threshold and the enrolment by the threshold, one
  voice throughout (a request with 3 s of voice or more is printed half by half and both halves must pass the gate's own
  test), and that main lets through `adaptGuard`: Keep learning on, Voice Match in force, not Ember's own voice since
  the wake (`selfSpokeSince`), no other voice turned away, no question it locked up (`Confirmer.voiceLocked`) and no
  stop in the last two minutes, not cut at the length limit, at most one a minute. Logs say only whether it learnt and
  why not.
- **How.** A running weighted mean: the enrolment counts as four samples, plus the last 24 samples (numbers only,
  in voiceprint.json, 0600). The print moves at most 0.02 (cosine) a sample and stays within 0.95 of the enrolment.
- **The gate asks more of a learnt print.** An average of more clips matches every voice a little more: learning
  without that let more strangers in (FAR 3.0 % → 4.1 %). So a print that learnt from `n` samples needs
  0.75 + 0.03 × min(1, n / 8), and a request must also match the enrolment itself: by 0.74 to be heard, and by 0.75,
  the enrolment's own threshold, to be `verified` (what may answer a question by voice or turn Work without asking
  on: `gateMatches`, `ADAPT.verifiedFloor`). What was learnt never lowers the bar for a spoken yes.
- **Reset to my enrolment** keeps the anchor and drops the rest; **Forget my voice** deletes voiceprint.json and
  words.json. "Ember, stop" is never checked.

Measured on LibriSpeech dev-clean, 40 speakers (4 enrolment phrases of 3 s each; then 12 requests of 2.5 s that go
through the gate and may be learnt from when verified, and 8 more tested per speaker against everyone else's 8: 320
owner trials, 12,480 impostor trials):

| | FRR before | FAR before | Heard: FRR after | FAR after | Verified: FRR after | FAR after | learnt from |
|---|---|---|---|---|---|---|---|
| The enrolment's room | 8.4 % | 3.0 % | 7.8 % | 1.8 % | 8.8 % | 1.7 % | 76 % of requests |
| Another microphone (200 Hz–5 kHz, 30 dB SNR) | 52.2 % | 1.6 % | 50.9 % | 1.5 % | 52.2 % | 1.3 % | 27 % of requests |
| No limits (learn from anything let in), same room | | | 1.6 % | 4.7 % | | | 96 % |
| No limits, another microphone | | | 17.2 % | 7.0 % | | | 37 % |

On another microphone the guarded learning recovers slowly by design (1.3 points of FRR in 12 requests, about 3 of
them learnt from): learning from anything let in recovers far more (17 %) but lets 7 % of other voices in, which is
the trade this design refuses. Re-enrolling on the new microphone is still the quick fix. Only 0.1 % of other speakers'
requests (32 of 31,200) matched any owner by the margin at all. (A telephone-band microphone, 300 Hz–3.4 kHz at 25 dB
SNR, turned the owner away 81 % of the time before and after: too little got through to learn from.)

**The drift attack.** For each of the 1,560 owner–other pairs, the other speaker feeds 200 samples crafted to sit
between the print in use and their own voice at a set score above the print's threshold, each taken as a verified
request (every guard in main assumed passed), then their own 8 real requests are tried:

| Crafted samples score | Heard, with the limits | Verified, with the limits | With no limits |
|---|---|---|---|
| Just under the threshold (−0.01) | 3.1 % | 3.0 % | 12.0 % |
| Just over the threshold (+0.005) | 3.1 % | 3.0 % | 98.3 % |
| Just over the margin (+0.085: an attacker who already sounds 0.83 like the owner) | 4.0 % | 3.0 % | 98.3 % |

Baseline: 3.0 %. A spoken yes is never easier for another voice than before Voice Match learnt (the verified floor);
being heard at all is bounded by the 0.74 floor (6.3 % at 0.72; a floor of 0.75 there too gave up the owner's gain:
FRR 8.8 %). Review of #145 (S4) asked for at least the threshold on the verified path; this is it.

### 7.2 Personal vocabulary (app/main/personal/phonetic.ts, correct.ts)

Moonshine has no hotword biasing, so the transcript is corrected after it, against: Ember's name at the start of a
request ("Amber," / "Emma," → "Ember,"), the platform's app catalog (installed apps), the names in memory's `user`
facts while memory is in force, the corrections the user taught ("That's not what I said": words.json, 0600), and,
with a 0.03 bonus, the words of the suggestions shown now. A near-miss is corrected when its sound key (Metaphone's
main rules, voiced and unvoiced pairs merged) and letters together score 0.85 or more and 0.05 ahead of the next entry;
never a common word on its own, never digits. A person's name from memory (or from a suggestion) is only ever corrected
into in a request that just looks something up (what, who, when, where, find, search, show, look up, read): "ask
Sandro to come", "add Sandro to the meeting", "book lunch with Sandro" stay as heard, whatever the verb. Nothing but Ember's name is changed in a request policy's `isRiskyLabel`
calls risky, or one that addresses someone (`ADDRESSES`: message, mail, text, tell, DM, write to, call, invite, reply,
send, share…: a corrected name there would change who gets it), and a correction that would make a request risky is
undone, so policy (`spokenWords` included) gets the raw words. A spoken answer to a question is judged on the raw words.
A taught correction is kept only when it isn't all common words and no request verb changes ("open" for "close",
"allow" for "deny"; never a number word or digit: "fifteen" for "fifty": `learnable`), and entries kept before that rule are held to it too. The log counts corrections by
source, never the words. sherpa-onnx's keyword spotter could take more keywords, but adding the user's own would change
wake behaviour, so it was left alone.

Word error rate (words-bench.mjs; requests with app and people's names synthesised in two voices, two takes each:
the corrections the user would teach come from the first take, the second is measured):

| Clips | Raw | Lexicon | + taught | Words a correction made wrong |
|---|---|---|---|---|
| The voice tests' 22 clips (amy and ryan) | 12.3 % | 11.6 % | 11.6 % | 1 (the "Hey Amber" clip, whose wake the engine turns away before it is a request) |
| 40 name requests (ryan, kristin) | 34.4 % | 31.1 % | 27.8 % | 0 |
| ryan | 36.7 % | 34.4 % | 30.0 % | 0 |
| kristin | 32.2 % | 27.8 % | 25.6 % | 0 |

The synthetic voices vary between runs (±5 points: the raw column moved from 29.4 to 34.4 % between two runs of the same
code). People's names in requests that aren't lookups ("Remind me to call Priya", "Set up a call with Kofi") are left as
heard on purpose, which is most of the gap to the first measurement. Requests that address someone ("Message Anjali…", "Set up a call
with Kofi") are left as heard on purpose. Names Moonshine hears as other words ("Nautilus" → "not a", "Mehmet" → "name
it") are beyond a sound match; teaching them once fixes them when they come out the same way again.

### 7.3 What comes next (app/main/personal/predict.ts)

Local rules only, no model and nothing sent: from the last request and reply, whether the reply was spoken, the task
the request started, the time of day, this session's requests (never one heard where Ember can't tell the user from
its speakers, a chosen suggestion, or a risky one) and (memory in force) people's names: "Yes, please" and "No,
thanks" after a question, "Close it" after opening something, "Turn … off" after turning it on, "Do the same for the
next one" after a task on one item, "Read it out" after an unspoken answer, "What went wrong?" after a failure, a
request said twice this session, and by time of day otherwise. Nothing risky, but one built from the user's own risky
request just now ("Send it to Priya" after a request to send). Shown under the answer in the bubble (only under the
answer they were made for, never with a question or buttons up) and in the Ask box (only while the field is empty,
never while a question is up, and those that answer or follow the answer only while it shows: `askSuggestions`),
captioned "Ember suggests". A click sends them as the user's choice of Ember's words (`suggested`): the usual policy
applies, and they never count as the user's own words for a command (no announce-with-Stop: host.ts
`UserRequest.suggested`). After a spoken reply that asked something the follow-up window is 12 s instead of 8 (no
change to wake detection).


## 8. Recognition and lightweight speech follow-up on 4 November

[The speech review](voice-review-2026-11-04.md) records current primary model sources, verified Kitten archive,
targeted recognition comparisons and resource interpretation. The current Tiny recogniser stays the default.
Cleanup preserves literal dictated repeats and entirely numeric repeated spans without disabling whole-sentence
loop recovery. A synthetic repeat/number subset improved from 64 to 35 edits over 146 reference words; three
additional model insertion tokens remain. Names on that subset were unchanged. This is not a general microphone
accuracy claim, and wake/Stop/Voice Match/action thresholds are unchanged.

At this research checkpoint, Piper Kristin remained the default voice. Kitten Nano 0.8 FP32 was an explicit native
alternative to Kokoro, with a 63.8 MB verified complete download, one CPU thread, measured speed gate and Piper
fallback. The later decision in §9 supersedes that model selection; these measurements remain historical evidence.
The INT8 candidate used more CPU here despite its smaller weights and was not selected. Native capability, saved choice and current
readiness are distinct in Home; saving a model while off never enables it. A lost native backend leaves the saved
preference inspectable and switchable off. Speech utilities release after two minutes without pending synthesis.
Queued audio and model benchmarks do not establish actual silence, naturalness or real-device recognition quality.


## 9. Kitten becomes the default on 4 November

After reviewing the comparisons, the owner explicitly chose Kitten Nano 0.8 FP32 as Ember's default voice and removed
Piper from the production model manifest and synthesis/fallback paths. This is a user-directed product choice, not a
new claim that the measurements prove Kitten sounds better. Earlier Piper timing, footprint and ASR-fixture results
above remain intact and should not be read as the current runtime policy.

`DEFAULT_VOICE` is the verified Kitten archive with model id `tts`, Apache-2.0 licensing and a complete 63,815,222-byte
download (about 63.8 MB). The standard model downloads then totalled 138,478,723 bytes (about 138.5 MB), including the
unchanged listening and Voice Match models; since Moonshine v2 base became the recognizer they total 219,886,389 bytes
(about 220 MB, 130 MB of it for listening). Preparation and bundled-model staging use this standard manifest.
Kitten runs on one native CPU thread and must meet the measured real-time factor cap of 0.5. Unsupported, missing,
slow or failed Kitten uses an installed local system voice; there is no production Piper or neural WebAssembly
fallback. WebAssembly ASR remains available. Kokoro remains an explicit optional native choice, with its own download
confirmation and the same speed gate; it falls back to Kitten, then the system voice if necessary.

The two-minute idle release, local audio boundary, Stop semantics, consent and policy gates are unchanged. Separate
pinned Piper Amy/Ryan models may still synthesise ASR/evaluation fixtures; they are test-only and never production
speech models. Their use does not justify deleting bundled sherpa/eSpeak NG/phonemiser licence notices. Real-device
recognition, audible Stop timing and blinded voice listening remain separate acceptance work.

## 10. A clearer recognizer on 5 November

The owner's report: the words shown weren't the words said. Their accent is Indian English on a laptop's array microphone.
Measured on 240 requests (30 everyday ones in eight of Kokoro's voices: US, UK and four Hindi-accented), on this laptop,
two threads, words wrong:

| | Clean | As a laptop hears it (room, fan noise at 12 dB, quiet) | Hindi-accented, as a laptop hears it | A request | Memory |
|---|---|---|---|---|---|
| Moonshine v2 base | 3.7 % | 6.0 % | 8.4 % | 87 ms | 245 MB |
| Parakeet TDT 0.6B v2 (int8) | 2.5 % | 2.8 % | 3.8 % | 296 ms | 800 MB |

Moonshine also wrote the name as "Remember", "Amber" and "Investop" where Parakeet wrote "Ember". Four threads gained nothing
(342 ms). These voices are synthesized: no real accent has been measured, and no audio of the owner was kept.

Parakeet is a 482 MB download and 550 MB of memory, too much to force on the weakest target, so it is **Hear me more
clearly** in Settings › Voice, off by default, native builds only. It writes the requests; Moonshine goes on doing the quick
checks, so the name and a cut-in cost what they did. It is a transducer, so hotword biasing (§ above) is now open to it.
