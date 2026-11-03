// Assertions shared by the Electron voice smoke and its unit tests. A speech-only hush must never pass for Stop,
// and a repeated request must never pass for another conversational turn.

/** The voice stop reached the app-wide kill switch, not only the speech player. Returns its log index. */
export function voiceStop(log, stopAt) {
  const pulled = log.findIndex((e, i) => i > stopAt && e.msg === "killswitch.pulled" && e.source === "voice");
  if (pulled < 0) throw new Error("voice.stop did not reach killswitch.pulled (source voice)");
  return pulled;
}

/** Each request was answered aloud, then listening reopened before the next request, with no extra wakes or turns. */
export function voiceConversation(log, windows) {
  const utterances = log.flatMap((e, i) => e.msg === "voice.utterance" ? [i] : []);
  if (utterances.length !== windows.length) throw new Error(`expected ${windows.length} requests, heard ${utterances.length}`);
  if (log.filter(e => e.msg === "voice.wake").length !== 1) throw new Error("the follow-up requests needed another wake");
  return utterances.map((request, turn) => {
    const end = utterances[turn + 1] ?? log.length;
    const find = (msg, pred = () => true, from = request + 1) => {
      const i = log.findIndex((e, k) => k >= from && k < end && e.msg === msg && pred(e));
      if (i < 0) throw new Error(`turn ${turn + 1}: no ${msg} before the next request`);
      return i;
    };
    if (log[request].window !== windows[turn]) throw new Error(`turn ${turn + 1}: expected ${windows[turn]}, got ${log[request].window}`);
    const on = find("voice.self_speaking", e => e.on === true);
    const audio = find("voice.audio_played", e => e.seconds > 0);
    const off = find("voice.self_speaking", e => e.on === false, Math.max(on, audio) + 1);
    const followUp = find("voice.follow_up", () => true, off + 1);
    // The log for the request's own listening-off event comes earlier. This one must follow the newly opened window.
    find("voice.event", e => e.type === "listening", followUp + 1);
    return { request, on, audio, off, followUp };
  });
}
