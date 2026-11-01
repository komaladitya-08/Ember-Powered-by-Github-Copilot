# Towards a Jarvis-like Ember: voice, recognition and footprint

Status: research and decisions (2026-11-01). Nothing here is built yet. Each phase below ships as its own PR, with
its measurements. Companion to docs/MEMORY.md (what Ember knows about you).

The goal: an assistant you talk to like a person. It hears you first time, answers before the silence feels long,
sounds natural, can be interrupted, knows you, and costs almost nothing while it waits. Every choice below has to
hold on Ember's hardest target: a RHEL 8 desktop with no GPU, glibc 2.28, and speech on one WebAssembly thread.

## 1. Where Ember is today (measured)

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
- **Natural voices on a CPU.** Kokoro (82M) sounds best of the small models but costs about 3.5 times Piper.
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
  fed in. It prints PSS and CPU per process, and per page through DevTools, as this plan's numbers were taken. It
  also writes JSON for CI's `el8` job to keep as an artifact. It fails only on a large regression, never on noise.
- A latency trace: `EMBER_LATENCY_LOG=1` logs, for each spoken request, the time from end of speech to transcript,
  to the request being sent, to the first answer token, to the first sentence, to first audio. Times only, never
  words (CLAUDE.md privacy).
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
2. **Speak the first clause, not the first sentence.** `SpeechStream` lets the first chunk end at a comma or dash
   once it has at least about 4 words, and keeps whole sentences after that. This saves the time Copilot spends
   writing the rest of a long first sentence.
3. **Acknowledge at once.** When the request ends, Ember reacts within about 150 ms, before Copilot answers: a short
   sound from the bubble and the character's "listening → thinking" motion. Optionally a spoken "Mm-hm" or "One
   moment", only when Copilot hasn't started answering after about 700 ms. It is never spoken over the start of an
   answer.
4. **Warm what's needed.** Load Ember's voice when listening starts, not at the first reply (its memory cost is
   measured in phase 0 first). Keep the Copilot session warm. Ask Copilot for a fast conductor model by default for voice
   turns: the model choice already exists, and the default becomes latency-aware.
5. **Shorter silence, safely.** Lower `MIN_SILENCE` to 450 ms only when the transcript so far ends like a finished
   request ("?", a verb's object, a known command shape). Keep 600–900 ms when it trails off ("and…", "the…").
   This is a rule-based first step, and it needs streaming partials (phase 2). Measured against the false cut-off
   rate on the clip set.

### Phase 2: listen like a person

1. **Streaming Moonshine v2** (if sherpa-onnx ships its streaming export; otherwise run the
   chunked encoder through the same C API). It gives partial transcripts while you speak, so the bubble shows your
   words live. The 2024 streaming zipformer dropped the first 0.5–1.5 s in WebAssembly (PLAN.md M5). Re-measure
   under native before switching, and keep the offline pass as a final check while it's cheap.
2. **Semantic end of turn.** A small text classifier (evaluate Namo's per-language model; licence and size decide)
   reads the partial transcript and ends the turn early when you're clearly done. It waits longer when you pause
   mid-thought. Silero VAD stays the hard limit.
3. **Barge-in without the wake word.** While Ember speaks, your voice (VAD, after Chromium's echo cancellation, with
   speaker rejection where `parec` exists) stops it within about 200 ms, and what you say becomes the next request.
   Where Ember can't tell its own voice from yours (`rejectsSpeakers` false), keep needing "Hey Ember", as today.
   Safety is unchanged: no voice ever approves an action.
4. **Longer conversation.** The follow-up window grows from 8 s to "until a natural pause of about 20 s", with the
   mic dot showing it. You can turn it off.

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
4. **A bigger model only where it pays.** Moonshine v2 base had 8.4 % of words wrong against tiny's 10.5 %, for
   twice the CPU and 225 MB more (docs/DEVELOPING.md). Offer it as a setting on machines with spare cores, decided by
   the bench, never by default on the reference machine.
5. **Voice Match stays the gate** for "only my voice". Its threshold is tuned on the phrase set.

### Phase 4: sound natural

1. **Kokoro on Linux** once native (phase 1.1), behind the existing "Use a more natural voice" setting and its
   real-time check (`NATURAL_MAX_RTF`). Piper stays the default on slow machines.
2. **Evaluate Supertonic and Kitten** in `scripts/voice/bench.mjs` (speed, memory, clicks, a blind listening pass).
   Adopt one only with a reviewed licence, a SHA-256 pin and a clear win.
3. **Speech-shaped answers.** For voice turns the persona already asks for 1–3 short sentences. Add spoken-style
   rules: contractions, numbers said as words, no lists. Pick the voice's speed and pauses per sentence type
   (questions rise, lists get pauses).

### Phase 5: cost almost nothing at idle

1. **Draw less.**
   - The handle already drops to about 15 fps when still. It will stop drawing entirely after about 10 s still, and
     wake on any state change. Same for each overlay.
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
- approvals come only from a click or the allow and deny shortcuts, never from voice;
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
