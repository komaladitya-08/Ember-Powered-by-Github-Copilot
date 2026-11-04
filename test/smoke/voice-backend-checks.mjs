// The backend smoke distinguishes native default speech from an explicit native-only refusal; cached optional voices
// and zero-audio successes cannot stand in for the default Kitten model.

/** Verify either the exact native default voice or a native-only refusal with no ready/audio messages. */
export function defaultSpeechBackend(run, native) {
  if (!native) {
    if (run.unavailable !== "native" || run.readyCount !== 0 || run.audioChunks !== 0 || run.audioSeconds !== 0) {
      throw new Error("unsupported neural speech must report native unavailability with no ready or audio messages");
    }
    return;
  }
  if (run.unavailable || run.voice?.voice !== "kitten" || run.voice?.backend !== "native") {
    throw new Error("native default speech must use Kitten, independently of optional voice caches");
  }
  if (run.readyCount !== 1 || !(run.audioChunks > 0 && run.audioSeconds > 0) || !(run.rtf > 0 && run.rtf < 1)) {
    throw new Error("native Kitten must become ready and generate usable audio faster than real time");
  }
}
