/**
 * What Home tells a screen reader by itself never calls Ember by name. A screen reader says a status line through the
 * speakers, and where Ember can't tell the speakers from the room (Windows, macOS, Linux without parec) a line said
 * into the wake word's microphone that calls it by name, from any of its words on, wakes Ember and is sent as a request
 * (design-system.md "Screen readers").
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMPOSER_HELD, COMPOSER_OVER, COMPOSER_SAYS, COMPOSER_THINKING, CONVERSATION_NOTHING_TO_STOP, CONVERSATION_STOPPED,
  HEAR_WAITING, LISTEN_CONSENT_NOT_SAVED, composerStillWaiting, hearEmberLine, presenceLine, tagline, updateStatusText,
} from "../../app/renderer/home/copy";
import { MATCH_TEXT, matchAnnouncement, matchView } from "../../app/renderer/home/match-copy";
import { composerRefusal } from "../../app/main/agent/composer-refusal";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import type { UpdateStatus, VoiceMatchStatus } from "../../app/shared/ipc";
import { calledByName } from "../../app/voice/engine";

/** The first word from which `line` calls Ember by name, or null. */
const calledFrom = (line: string): string | null => {
  const words = line.split(/\s+/);
  const at = words.findIndex((_, i) => calledByName(words.slice(i).join(" ")));
  return at < 0 ? null : words.slice(at).join(" ");
};
const named = (lines: Iterable<string>) => [...new Set(lines)].filter(l => l && calledFrom(l) !== null).map(l => `${l} (from “${calledFrom(l)}”)`);

describe("what Home tells a screen reader", () => {
  it("never calls Ember by name in the status panel's line, in any state Ember can listen in (voice-listening-r5-1)", () => {
    // "Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything.", said into an idle wake microphone in the
    // test-only Ryan voice, woke Ember and was sent as a request in 39 of 40 placements, "… Reconnecting to Copilot…"
    // in 40 of 40. (Before Start nothing is heard, and a locked-down Ember doesn't listen: LOCKDOWN turns voice off.)
    const lines: string[] = [];
    for (const overlay of [true, false]) for (const hidden of [false, true]) for (const corner of ["bottom-right", "bottom-left"] as const)
      for (const phase of [null, "starting", "ready", "signed-out", "error"]) for (const service of [undefined, "user", "admin"])
        for (const runtime of [null, "reconnecting", "stopped"] as const) for (const waitingForTasks of [false, true])
          for (const failing of [0, 1, 2]) for (const look of [0, 1, 3]) for (const waitingFor of [null, "127.0.0.1:18409"])
            for (const ask of [SHORTCUTS.linux.ask.label, SHORTCUTS.win32.ask.label, SHORTCUTS.darwin.ask.label, ""])
              lines.push(tagline({ failing, look, onboarded: true, phase, hidden, overlay, corner, waitingForTasks, service, runtime, waitingFor }, ask));
    expect(new Set(lines).size).toBeGreaterThan(40);
    expect(named(lines)).toEqual([]);
  });

  it("never calls Ember by name in Hide's line or where it lives without a compositor (voice-listening-r5-1)", () => {
    // "Ember is hidden. It shows itself again…" woke Ember and was sent in 40 of 40 placements.
    const lines = [true, false].flatMap(overlay => [true, false].flatMap(hidden => (["bottom-right", "bottom-left"] as const).map(corner => presenceLine({ overlay, hidden }, corner))));
    expect(named(lines)).toEqual([]);
  });

  it("never calls Ember by name in the composer's line, whatever became of the request (voice-listening-r5-1)", () => {
    // "Ember couldn't answer this request…" woke Ember and was sent in 38 of 40 placements.
    const lines = [...Object.values(COMPOSER_SAYS), COMPOSER_HELD, COMPOSER_THINKING, COMPOSER_OVER, CONVERSATION_STOPPED, CONVERSATION_NOTHING_TO_STOP,
      composerStillWaiting(), composerStillWaiting("user"), composerStillWaiting("admin")];
    // Why a send was refused, in every state but a policy's problem (LOCKDOWN, which turns listening off).
    const services = [undefined, { kind: "user" as const, host: "localhost:11434" }, { kind: "user" as const, host: "llm.example.com" }, { kind: "admin" as const, host: "llm.example.com" }];
    for (const service of services) for (const phase of ["starting", "signed-out", "error"] as const)
      for (const reason of [undefined, "network", "not-answering", "sign-in", "no-access", "models", "runtime", "other"] as const)
        for (const waitingForTasks of [false, true]) for (const detail of [undefined, "Copilot stopped unexpectedly. Reconnecting…"]) for (const waiting of [null, "127.0.0.1:18308"])
          lines.push(composerRefusal({ phase, reason, waitingForTasks, service, detail }, waiting));
    expect(named(lines)).toEqual([]);
  });

  it("never says Ember's name at all, not even “Ember's”, in the line said on every typed send (voice-listening-r6-1)", () => {
    // "Thinking… Ember's reply will appear above." woke Ember in 2 of 24 real-model placements and was sent as "Thinking
    // numbers reply will appear above."; the wake also stopped the typed request's answer on its way. `calledByName`
    // leaves "Ember's" out, but the recogniser joins the word before it to the name (voice.ts, voice-listening-y6-1).
    // The same line without the name: 0 of 20.
    for (const line of [COMPOSER_THINKING, COMPOSER_HELD, COMPOSER_OVER, composerStillWaiting(), composerStillWaiting("user"), composerStillWaiting("admin")])
      expect(line, line).not.toMatch(/\bEmber/i);
  });

  it("never calls Ember by name, nor says a phrase it answers, as Voice Match's teaching ends or the voice is forgotten (voice-listening-r5-1)", () => {
    // "Ember knows your voice now. On: …" woke Ember in 22 of 40 placements, "Ember forgot your voice…" in 24, and the
    // line shown for no voice quotes “Ember, stop”, which said into the microphone stops Ember.
    const none: VoiceMatchStatus = { enrolled: false, on: false, model: true, wanted: false, enrolling: null, learnt: 0 };
    const on: VoiceMatchStatus = { ...none, enrolled: true, on: true, wanted: true };
    const off: VoiceMatchStatus = { ...on, on: false, wanted: false };
    const teaching = (m: VoiceMatchStatus): VoiceMatchStatus => ({ ...m, enrolling: { got: 2, of: 4, phrase: "Ember, open my calendar" } });
    const lines: string[] = [];
    for (const before of [none, on, off]) for (const after of [none, on, off, { ...none, model: false }, { ...none, model: false, wanted: true }])
      for (const ended of [undefined, "learnt", "cancelled", "stopped", "gave-up", "timeout", "interrupted"] as const) for (const cancelled of [false, true]) {
        const said = matchAnnouncement(teaching(before), { ...after, ...(ended ? { ended } : {}) }, cancelled);
        if (said) lines.push(said);
      }
    for (const after of [none, { ...none, ended: "gave-up" as const }]) lines.push(matchAnnouncement(on, after) ?? "", matchAnnouncement(off, after) ?? "");
    expect(lines.filter(Boolean).length).toBeGreaterThan(20);
    expect(named(lines)).toEqual([]);
    for (const line of lines) expect(line, line).not.toMatch(/\bEmber\b/);
  });

  it("never says Ember's name in the Teach button's name or the description read with it, where focus is moved to it (voice-listening-r6-2, voice-listening-q6-1)", () => {
    // Home moves focus to Teach after Cancel, as teaching ends and after Forget my voice, and a screen reader then reads
    // the button. "Teach Ember my voice, button. Ember hears anyone who talks to it. Teach it your voice…" woke Ember
    // and was sent as a request in 18 of 20 real-model placements, "Teach Ember my voice, button." alone in 14.
    const none: VoiceMatchStatus = { enrolled: false, on: false, model: true, wanted: false, enrolling: null, learnt: 0 };
    const on: VoiceMatchStatus = { ...none, enrolled: true, on: true, wanted: true };
    const lines: string[] = [MATCH_TEXT.teach, MATCH_TEXT.teachAgain];
    for (const m of [none, on, { ...on, on: false }]) for (const ended of [undefined, "learnt", "cancelled", "stopped", "gave-up", "timeout", "interrupted"] as const) {
      const teach = matchView({ ...m, ...(ended ? { ended } : {}) }, { listening: true, managed: false }).teach;
      expect(teach.said, teach.label).toBeTruthy();
      lines.push(`${teach.label}, button. ${teach.said}`);
    }
    expect(new Set(lines).size).toBeGreaterThan(8);
    expect(named(lines)).toEqual([]);
    for (const line of lines) expect(line, line).not.toMatch(/\bEmber/i);
    // The page reads that description with the button, not the line shown (which names Ember and quotes “Ember, stop”).
    const page = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
    expect(page).toMatch(/<button type="button" id="match-teach" class="btn quiet" aria-describedby="match-teach-said">Teach my voice<\/button><span id="match-teach-said" hidden><\/span>/);
    expect(readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8")).toContain('$("match-teach-said").textContent = view.teach.said;');
  });

  it("never says Ember's name where Teach is refused, a phrase is asked for again or listening's consent couldn't be saved (voice-listening-r6-3, voice-listening-c7-1, voice-listening-r7-1)", () => {
    // "Ember isn't listening just now, so it can't learn your voice. Try again once it's listening for “Ember”." is said
    // as Teach is refused, also while listening starts, and said whole into an idle wake microphone it woke Ember and
    // was sent as a request in 3 of 4 real-model placements; the line now said in 0 of 20.
    const lines = [MATCH_TEXT.notListening, LISTEN_CONSENT_NOT_SAVED, ...Object.values(MATCH_TEXT.again)];
    expect(named(lines)).toEqual([]);
    for (const line of lines) expect(line, line).not.toMatch(/\bEmber/i);
    // A refused Teach says where to look: the microphone may be why (voice-listening-r7-1).
    expect(MATCH_TEXT.notListening).toBe("Not listening just now, so your voice can't be learnt. Check the microphone and the voice status above, then try again.");
    expect(LISTEN_CONSENT_NOT_SAVED).toBe("Your choice couldn't be saved, so listening is still off. Press “I agree, start listening” to try again.");
    expect(readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8")).toContain("consentError(LISTEN_CONSENT_NOT_SAVED)");
  });

  it("never calls Ember by name in what Hear Ember found (voice-listening-r5-1)", () => {
    // Said just after the sample, into the wake word's microphone.
    const lines = [HEAR_WAITING, ...(["kitten", "kokoro", "supertonic", "system"] as const).map(voice => hearEmberLine({ spoke: true, voice })),
      ...(["off", "managed", "locked", "silent", "stopped"] as const).map(why => hearEmberLine({ spoke: false, why }))];
    expect(named(lines)).toEqual([]);
  });

  it("never calls Ember by name in where the update check stands, said after Check now or as the daily check ends (voice-listening-x6-1)", () => {
    // "Ember 0.10.0 is out." woke Ember and was sent as a request in 18 of 40 real-model placements, "Couldn't check
    // for updates. Ember will try again tomorrow." in 6.
    const lines: string[] = [];
    for (const phase of ["off", "idle", "checking", "current", "available", "failed"] as const) for (const latest of [null, "0.10.0"])
      for (const checkedAt of [null, "2026-11-05T10:01:00.000Z"]) if (phase !== "available" || latest) lines.push(updateStatusText({ phase, latest, checkedAt } satisfies UpdateStatus));
    expect(new Set(lines.filter(Boolean)).size).toBeGreaterThan(5);
    expect(named(lines)).toEqual([]);
  });
});
