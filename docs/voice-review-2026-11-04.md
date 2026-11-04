# Speech recognition and lightweight voice follow-up

> Superseding owner decision, 4 November 2026: Kitten Nano 0.8 FP32 is now the default production voice, with optional
> Kokoro and local system-voice fallback when default neural speech is unavailable. Piper is removed from the app's
> production voice path. The earlier recommendation and measurements below are preserved as historical evidence;
> statements there that Piper remains the default describe that earlier review, not the current implementation.
> See PLAN.md §10 and docs/ASSISTANT.md §9. This user override does not establish a new listening-quality result.

4 November 2026. Keep Moonshine v2 Tiny and Piper Kristin as Ember's defaults. Preserve intended words during
transcript cleanup, release idle synthesis, and offer Kitten Nano 0.8 FP32 as an explicitly chosen native voice.
Kokoro remains the existing optional default. The actual native speed probe must pass a real-time factor of 0.5
or better; otherwise Piper speaks. Perceived naturalness still requires listening and real-device testing.

## Recognition accuracy

The previous cleanup removed deliberately repeated words and numeric sequences along with decoder loops. The
new boundary preserves explicit dictation and entirely numeric repeated spans, while recovering repeated whole
sentences. Wake/Stop handling, Voice Match thresholds, risky-action checks and transcript provenance are unchanged.

A targeted comparison used the same raw recogniser outputs from 64 synthetic clips generated with Ryan and
Kristin voices: 40 name requests (182 reference words) and 24 repeat/number requests (146 words). This set probes
the cleanup regression; it is not general microphone, accent or noisy-room accuracy.

| Model and subset | Errors before | Errors after | WER before and after |
| --- | ---: | ---: | --- |
| Current Tiny, repeats/numbers | 64 | 35 | 43.8% to 24.0% |
| Current Tiny, names | 67 | 67 | 36.8% unchanged |
| Candidate Base, repeats/numbers | 70 | 48 | 47.9% to 32.9% |
| Candidate Base, names | 49 | 49 | 26.9% unchanged |

Tiny restored 32 reference words and lost no formerly correct reference words, while retaining three additional
model insertion tokens. Thus 32 restored words means 29 fewer total edits, not zero possible harm. The recogniser
can still get quantities or repetition counts wrong. Base's name result alone does not justify changing the
default: it needs broader held-out recordings, resource measurements and compatible runtime validation.

Moonshine's newer streaming models have a different frontend/decoder contract. Its published floating-point
multi-dataset scores and quantised LibriSpeech results do not describe Ember's pinned non-streaming export.
[Model catalogue](https://moonshine-voice.readthedocs.io/en/latest/models/available-models/) ·
[Accuracy definitions](https://moonshine-voice.readthedocs.io/en/latest/models/accuracy/) ·
[Sherpa-compatible exports](https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html)

## Voice choice and resource use

Kitten Nano 0.8 FP32 uses Ember's existing sherpa-onnx 1.13.8 native adapter, one CPU thread and the same measured
speed/fallback rules. Its complete archive is 63,815,222 bytes, SHA-256
`16092117bfe591ddcd58d078e1454603b8e1caea46f85653b2c2efae76bd883e`.
It includes matching style tables, eight fixed voices, 24 kHz output, phonemiser data and Apache-2.0 licensing.
Production model verification and actual synthesis are integration-tested. The advertised roughly 25 MB INT8
weights are not the complete download, and INT8 used substantially more CPU in this comparison, so FP32 was selected.
[Sherpa Kitten documentation](https://k2-fsa.github.io/sherpa/onnx/tts/kitten.html) ·
[Official model card](https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8) ·
[Pinned style conversion](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/scripts/kitten-tts/v0_8/generate_voices_bin.py)

The initial production-adapter comparison used three fixed sentences on Linux x64, a Xeon Platinum 8573C with four
allocated CPUs. Each engine ran in a fresh process; loaded/peak RSS includes Node, runtime and model. Other work
contended for CPU, so those wall-time figures must not be treated as idle latency targets. Initial loaded process
RSS was about 160 MiB for Kitten FP32, 158 MiB for Piper and 480 MiB for Kokoro. Kitten's CPU work was substantially
below Kokoro's, while Piper remained cheaper. This establishes a resource candidate, not a perceptual preference.

The benchmark now isolates engines in fresh processes rather than accumulating WASM allocations, measures CPU
work and RSS, and uses Kokoro speaker 3 as production does. Repeat on the target machine without parallel builds:

```sh
EMBER_SHERPA_CAPI=<verified-native-library-directory> node scripts/voice/bench.mjs --kokoro --kitten <models-directory>
```

The final fresh-process run started at load averages 0.6/0.9/2.2 with no active compilers, using Node 24.22.1 and
the same pinned runtime and fixed sentences. A small headless UI test overlapped the later Kokoro cases; these
are single observations, not p50/p95 latency or device guarantees. Kokoro used production speaker 3, Kitten style 0.

| Native engine | Threads | Generation RTF | Generation CPU | Loaded / peak process RSS |
| --- | ---: | ---: | ---: | --- |
| Piper Kristin | 1 | 0.222 | 1.51 s | 155 / 227 MiB |
| Kitten Nano FP32 | 1 | 0.284 | 2.23 s | 161 / 182 MiB |
| Kokoro FP32 | 2 | 0.682 | 7.80 s | 480 / 541 MiB |

Kitten's first whole-clause chunk took 696 ms excluding loading/playback; its load took about 1.05 seconds.
It passed the 0.5 runtime gate on this run. Piper remained cheaper and remains the default. Process RSS includes
the runtime, Node and model and is not total application PSS. No listening-based preference follows from this table.

The neural synthesis utility releases after two minutes without pending generation and rewarms on the next wake.
Stopping it releases that process's allocations; do not claim an equivalent total-application PSS reduction.
Captured audio remains local and is never written to disk.

## Further model research

Kokoro's official card identifies 82M parameters and Apache-2.0 weights. Kitten is offered as a smaller alternative,
not a universal quality winner. [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M)

Pocket TTS's newer small models are promising, but a compatible verified export for Ember's pinned runtime was
not established; the older 100M sherpa architecture is not interchangeable with them. Supertonic uses a different
multi-graph frontend and did not establish an advantage in this investigation. No extra runtime or unverified
model was added. [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) ·
[Supertonic](https://github.com/supertone-oss-archive/supertonic)

Release acceptance still needs held-out microphone recordings, wake misses/false wakes, independent helped/harmed
recognition counts, actual audible interruption timing and blinded listening comparisons for pronunciation,
prosody and fatigue. Synthetic regression scores and native waveform generation do not close those checks.
