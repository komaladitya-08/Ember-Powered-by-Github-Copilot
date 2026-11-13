/**
 * Voice Match (Voice) and "How Ember asks" (Apps & privacy) in the settings window: each state's view as match-copy.ts
 * and copy.ts build it and home/main.ts applies it, what screen readers hear while Ember learns a voice, where focus
 * goes when a button hides itself, and how the organisation's lock reads. Read as text: vitest runs without a DOM.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MANAGED_TEXT, MATCH_SAID, MATCH_TEXT, matchAnnouncement, matchRefusalHolds, matchView } from "../../app/renderer/home/match-copy";
import { APPROVALS_HEADING, MODE_LINE, MODE_NAME, approvalsView, grantsEmptyText, modeCard, modeRefusal } from "../../app/renderer/home/copy";
import { AdminPolicySchema, managedKeys } from "../../app/main/admin";
import { approvalsState } from "../../app/main/policy/autonomy";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { modeCardVersion, type ApprovalsState } from "../../app/shared/approvals";
import type { VoiceMatchStatus } from "../../app/shared/ipc";

const read = (f: string) => readFileSync(new URL(`../../app/renderer/home/${f}`, import.meta.url), "utf8");
const page = read("index.html");
const main = read("main.ts");
const css = read("styles.css");

const none: VoiceMatchStatus = { enrolled: false, on: false, enrolling: null };
const enrolling = (got: number, again?: "short" | "unlike" | "failed" | "over", phrase = "Ember, what's the weather like"): VoiceMatchStatus =>
  ({ enrolled: false, on: false, enrolling: { got, of: 4, phrase, ...(again ? { again } : {}) } });
const onNow: VoiceMatchStatus = { enrolled: true, on: true, enrolling: null };
const offNow: VoiceMatchStatus = { enrolled: true, on: false, enrolling: null };
const shown = { listening: true, managed: false };

describe("Voice Match's states", () => {
  it("not taught: the switch is off, Teach is offered, Forget and Cancel are not", () => {
    const v = matchView(none, shown);
    expect(v).toMatchObject({ hidden: false, busy: false, checked: false, disabled: false, text: MATCH_TEXT.none, prompt: "", progress: null, cancelHidden: true, forgetHidden: true });
    expect(v.teach).toEqual({ hidden: false, label: "Teach my voice", said: "Requests from any voice are heard, and any voice can answer questions out loud. Teach your voice, and only yours can agree to them." });
  });

  it("while learning: the switch shows on but can't be changed, the phrase and the count show, Cancel replaces Teach", () => {
    const v = matchView(enrolling(1), shown);
    expect(v).toMatchObject({ busy: true, checked: true, disabled: true, cancelHidden: false, forgetHidden: true });
    expect(v.teach.hidden).toBe(true);
    expect(v.text).toBe("Say each phrase as you would ask Ember (1 of 4 heard).");
    expect(v.prompt).toBe("Say: “Ember, what's the weather like”");
    expect(v.progress).toEqual({ value: 1, max: 4, text: "1 of 4 heard" });
  });

  it("asks again with the reason when a phrase wasn't kept", () => {
    expect(matchView(enrolling(2, "short"), shown).prompt).toBe("That was too short. Say it again: “Ember, what's the weather like”");
    expect(matchView(enrolling(2, "unlike"), shown).prompt).toBe("That didn't sound like the others (another voice, or noise). Say it again: “Ember, what's the weather like”");
    expect(matchView(enrolling(0, "failed"), shown).prompt).toBe("That wasn't heard clearly. Say it again: “Ember, what's the weather like”");
    // Said while a screen reader still read the prompt, the two came as one (voice-listening-r4-1).
    expect(matchView(enrolling(1, "over"), shown).prompt).toBe("Your screen reader was still reading. Wait for it to finish, then say: “Ember, what's the weather like”");
  });

  it("without its model: a note that no spoken yes is taken till it is back, never that it is merely off, and nothing to switch on or teach (owner's report of 2026-11-12)", () => {
    const kept = matchView({ enrolled: true, on: false, model: false, wanted: true, enrolling: null }, { ...shown, speakerBytes: 26_534_365 });
    expect(kept).toMatchObject({ checked: false, disabled: true, forgetHidden: false, focus: ["voice-download", "voice-listen-once", "wake"] });
    expect(kept.teach.hidden).toBe(true);
    expect(kept.text).toBe("Voice Match can't work for now: its model is missing or was damaged, so Ember takes no spoken yes. Download it above (27 MB) to put that right.");
    const fresh = matchView({ enrolled: false, on: false, model: false, enrolling: null }, shown);
    expect(fresh).toMatchObject({ disabled: true, text: "Voice Match needs its own model, which isn't on this computer. Download it above, then teach Ember your voice." });
    // Its model back: as before.
    expect(matchView({ ...onNow, model: true, wanted: true }, shown).text).toBe(MATCH_TEXT.on);
  });

  it("taught and on, or taught and off: Teach again and Forget are offered", () => {
    const on = matchView(onNow, shown);
    expect(on).toMatchObject({ checked: true, disabled: false, text: MATCH_TEXT.on, forgetHidden: false, cancelHidden: true });
    expect(on.teach).toEqual({ hidden: false, label: "Teach my voice again", said: MATCH_SAID.on });
    // Why the last teaching ended is read with the button too, in the words said as it ended.
    expect(matchView({ ...offNow, ended: "timeout" }, shown).teach.said).toBe(`${MATCH_SAID.ended.timeout} ${MATCH_SAID.off}`);
    const off = matchView(offNow, shown);
    expect(off).toMatchObject({ checked: false, text: MATCH_TEXT.off, forgetHidden: false });
    expect(off.text).toMatch(/keeps your voiceprint until you forget it/);
  });

  it("is hidden while listening is off, while the organisation turned voice off, and before Ember says anything about it", () => {
    for (const m of [none, onNow, enrolling(1)]) {
      expect(matchView(m, { listening: false, managed: false }).hidden).toBe(true);
      expect(matchView(m, { listening: true, managed: true }).hidden).toBe(true);
    }
    expect(matchView(undefined, shown).hidden).toBe(true);
    // main.ts asks with the listening switch's own condition and the organisation's wakeWord key (admin.ts managedKeys).
    expect(main).toMatch(/matchView\(m, \{ listening: voiceSettings\.wakeWord && voiceSettings\.consent, managed: managed\.has\("wakeWord"\), speakerBytes, refused: matchRefused \}\)/);
  });
});

describe("Voice Match's focus (as after Download speech models and the consent buttons)", () => {
  it("moves to Cancel once learning starts, to Teach once it stops, and to the listening switch when the group goes", () => {
    expect(matchView(enrolling(0), shown).focus).toEqual(["match-cancel"]);
    expect(matchView(onNow, shown).focus[0]).toBe("match-teach");
    expect(matchView(none, shown).focus[0]).toBe("match-teach");
    expect(matchView(onNow, { listening: false, managed: false }).focus).toEqual(["wake"]);
  });

  it("goes to Listen once, never to the “Hey Ember” switch, where focus is moved as listening starts or while Ember listens (voice-listening-r7-2)", () => {
    // After "I agree, start listening" and as a download ended with focus on its Cancel, focus went to the switch, and a
    // screen reader read "Listen for “Hey Ember”, switch, on": said into an open wake microphone that woke Ember in 20
    // of 20 real-model placements and sent "Switch on." in 18. "Listen once, button. …" in 0 of 20.
    const agree = main.slice(main.indexOf('$("consent-yes").addEventListener'), main.indexOf('$("consent-no").addEventListener'));
    expect(agree).toContain('$("voice-listen-once").focus();');
    expect(agree).not.toContain('$("wake").focus()');
    expect(main).toContain('if (hadCancel && cancel.hidden) focusFirst(["voice-download", "voice-listen-once", "wake"]);');
    // Voice Match's model gone while Ember listens, and its download under way (so no Download button).
    expect(matchView({ enrolled: true, on: false, model: false, wanted: true, enrolling: null }, shown).focus).toEqual(["voice-download", "voice-listen-once", "wake"]);
    // Not now leaves listening off: back to the switch that opened the note.
    expect(main).toContain('$("consent-no").addEventListener("click", () => { consentClosed(); $("consent").hidden = true; $("wake").focus(); });');
  });

  it("is moved by the draw only when the control that had it was hidden or disabled", () => {
    expect(main).toMatch(/if \(had && \(isHidden\(had\) \|\| \(had as HTMLInputElement\)\.disabled\)\) focusFirst\(view\.focus\);/);
    // Forget hides itself at once: Teach takes focus there and then. Cancel waits for main (Teach is still hidden).
    expect(main).toMatch(/\$\("match-forget"\)\.addEventListener\("click", \(\) => \{ void window\.ember\.forgetVoice\(\); focusFirst\(\["match-teach"/);
    const cancel = main.slice(main.indexOf('$("match-cancel").addEventListener'));
    expect(cancel.slice(0, cancel.indexOf("\n"))).not.toMatch(/\.focus\(/);
    // No focus() on the prompt paragraph: it can't take focus.
    expect(main).not.toMatch(/match-prompt"\)\.focus/);
  });
});

describe("what screen readers hear while Ember learns a voice (#voice-live)", () => {
  it("says each phrase as it is asked for, with how many were heard", () => {
    expect(matchAnnouncement(none, enrolling(0))).toBe("Say: “Ember, what's the weather like”");
    expect(matchAnnouncement(enrolling(0), enrolling(1, undefined, "Ember, open my calendar"))).toBe("Heard 1 of 4. Say: “Ember, open my calendar”");
    expect(matchAnnouncement(enrolling(1), enrolling(1, "unlike"))).toBe("That didn't sound like the others (another voice, or noise). Say it again: “Ember, what's the weather like”");
    // The same status again (a settings change redraws it) says nothing new.
    expect(matchAnnouncement(enrolling(1), enrolling(1))).toBeNull();
  });

  it("says how learning ended, and a forgotten voice, without Ember's name or a phrase it answers (voice-listening-r5-1)", () => {
    expect(matchAnnouncement(enrolling(3), onNow)).toBe("Your voice is learnt. On: only your voice can agree to questions out loud. Everyone is still heard. Your voiceprint stays on this computer.");
    expect(matchAnnouncement(enrolling(1), none, true)).toBe("Stopped teaching your voice. Requests from any voice are heard, and any voice can answer questions out loud. Teach your voice again, and only yours can agree to them.");
    expect(matchAnnouncement(enrolling(1), none)).toBe(MATCH_SAID.none);
    expect(matchAnnouncement(onNow, none)).toBe(`Your voiceprint and the words learnt from what you said are forgotten. ${MATCH_SAID.none}`);
    expect(matchAnnouncement(enrolling(2), offNow)).toBe(`${MATCH_SAID.learnt} Off: any voice can answer questions out loud. Your voiceprint is kept until you forget it.`);
    // The line shown says the same with the name, and quotes “Ember, stop”, which said into the microphone stops Ember.
    expect(MATCH_TEXT.none).toContain("“Ember, stop”");
    expect(matchAnnouncement(onNow, offNow)).toBeNull();
    expect(matchAnnouncement(undefined, undefined)).toBeNull();
  });

  it("says who is heard, and what is forgotten, without an “it” that could mean the person's own voice (voice-listening-x6-4)", () => {
    // Heard alone from a live region, "Your voice and the words learnt from it are forgotten. Anyone who talks to it is
    // heard. Teach it your voice…" read as talking to, and teaching, the person's own voice.
    expect(matchAnnouncement(onNow, none)).toBe("Your voiceprint and the words learnt from what you said are forgotten. Requests from any voice are heard, and any voice can answer questions out loud. Teach your voice again, and only yours can agree to them.");
    for (const line of [MATCH_SAID.none, MATCH_SAID.forgot, MATCH_SAID.stopped, MATCH_SAID.learnt, ...Object.values(MATCH_SAID.ended)]) expect(line, line).not.toMatch(/\bit(?:s|['’]s)?\b/i);
    // "Off: … until you forget it.": the voiceprint, just named.
    expect(MATCH_SAID.off).toMatch(/Your voiceprint is kept until you forget it\.$/);
  });

  it("says requests from any voice are heard, as the line shown does, never all talk, and points to teaching it again (voice-listening-y6-3)", () => {
    // Heard alone, right after Forget my voice, "Everyone who talks is heard." said whatever anyone says near the
    // computer is heard, where the line shown says Ember hears anyone who talks to it; and "Once your voice is taught"
    // lost the shown line's pointer to Teach.
    expect(matchAnnouncement(onNow, none)).toBe("Your voiceprint and the words learnt from what you said are forgotten. Requests from any voice are heard, and any voice can answer questions out loud. Teach your voice again, and only yours can agree to them.");
    expect(MATCH_SAID.none).not.toMatch(/\b(?:every|any)(?:one|body) who talks\b/i);
    expect(MATCH_TEXT.none).toMatch(/^Ember hears anyone who talks to it, and anyone near the computer can answer its questions out loud\. Teach it your voice, and /);
  });

  it("says that with Voice Match off anyone near the computer can answer by voice, and with it on only the owner can say yes (owner's report of 2026-11-12)", () => {
    expect(MATCH_TEXT.label).toBe("Only my voice can say yes (Voice Match)");
    expect(MATCH_TEXT.none).toBe("Ember hears anyone who talks to it, and anyone near the computer can answer its questions out loud. Teach it your voice, and only yours can agree to them. “Ember, stop” works for anyone.");
    expect(MATCH_TEXT.on).toBe("On: only your voice can agree to Ember's questions out loud; anyone can still say “not now”. Ember still hears everyone. Your voiceprint stays on this computer.");
    expect(MATCH_TEXT.off).toBe("Off: anyone near the computer can answer Ember's questions out loud. Ember keeps your voiceprint until you forget it.");
    // Nothing said to a screen reader here reads as an answer, or as a word of one, should Ember be listening for one.
    for (const line of [MATCH_SAID.none, MATCH_SAID.teach, MATCH_SAID.on, MATCH_SAID.off]) expect(line, line).not.toMatch(/\b(?:yes|allow|okay|fine|approve|accept|go ahead|not now|no)\b/i);
  });

  it("says why teaching stopped when it gave up, timed out or Ember stopped listening, never that it knows the voice (voice-listening-2, voice-listening-5, voice-listening-v1)", () => {
    const gaveUp = "Your voice wasn't learnt: too many phrases didn't sound alike. Try again somewhere quiet, with only you speaking.";
    expect(matchAnnouncement(enrolling(2), { ...none, ended: "gave-up" })).toBe(`${gaveUp} ${MATCH_SAID.none}`);
    // Taught again, and it gave up: the earlier voiceprint is still in use, and nothing says Ember learnt the voice.
    expect(matchAnnouncement({ ...onNow, enrolling: enrolling(2).enrolling }, { ...onNow, ended: "gave-up" })).toBe(`${gaveUp} ${MATCH_SAID.on}`);
    expect(matchAnnouncement(enrolling(0), { ...none, ended: "timeout" })).toBe(`Teaching stopped because no phrase was heard for a while. Try again when you're ready. ${MATCH_SAID.none}`);
    expect(matchAnnouncement(enrolling(1), { ...none, ended: "interrupted" })).toBe(`Teaching stopped because listening stopped. Try again once listening starts again. ${MATCH_SAID.none}`);
    // "Ember, stop", Stop everything or settings closing: stopped, as Cancel says.
    expect(matchAnnouncement({ ...onNow, enrolling: enrolling(1).enrolling }, { ...onNow, ended: "stopped" })).toBe(`Stopped teaching your voice. ${MATCH_SAID.on}`);
    expect(matchAnnouncement({ ...onNow, enrolling: enrolling(1).enrolling }, { ...onNow, ended: "cancelled" })).toBe(`Stopped teaching your voice. ${MATCH_SAID.on}`);
    expect(matchAnnouncement({ ...onNow, enrolling: enrolling(3).enrolling }, { ...onNow, ended: "learnt" })).toBe(`Your voice is learnt. ${MATCH_SAID.on}`);
    // The note stays under the switch until Ember is taught again, and Teach takes focus from Cancel.
    const v = matchView({ ...none, ended: "interrupted" }, shown);
    expect(v.text).toMatch(/^Teaching stopped because Ember stopped listening\./);
    expect(v.focus[0]).toBe("match-teach");
    expect(matchView({ ...onNow, ended: "learnt" }, shown).text).toBe(MATCH_TEXT.on);
  });

  it("ends the teaching when settings closes or hides (it shows the phrase to say), and maps each ending (voice-listening-v1)", () => {
    const m = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(m).toContain('const cancelHomeListenOnce = () => { if (manualCall?.source === "home") voice?.cancelListenOnce(); endTeaching(); };');
    expect(m).toMatch(/const hidden = \(\) => \{ shown\(false\)\(\); cancelHomeListenOnce\(\);/);
    expect(m).toMatch(/home\.on\("closed", \(\) => \{\s*cancelHomeListenOnce\(\);/);
    expect(m).toMatch(/const endTeaching = \(\) => \{\s*if \(!enrolling\) return;\s*voice\?\.cancelEnrol\(\);\s*enrolling = null;\s*enrolEnded = "cancelled";/);
    expect(m).toContain('if (enrolling) enrolEnded = p.why === "timeout" || p.why === "stopped" || p.why === "gave-up" || p.why === "interrupted" ? p.why : "cancelled";');
    expect(m).toContain("setState({ mic: state, micLearning: !!voice?.isEnrolling });");
  });

  it("goes through the Voice section's one live region, not a live region that appears with its text", () => {
    expect(page).toMatch(/<p class="sr" id="voice-live" role="status"><\/p>/);
    expect(page).toContain('<p class="match-prompt" id="match-prompt" hidden></p>');
    expect(main).toMatch(/const said = renderMatch\(\);\s*if \(said\) voiceLive\(said\);/);
    // A refused start is said too, not only written under the switch.
    expect(main).toMatch(/matchRefused = true; \$\("match-text"\)\.textContent = MATCH_TEXT\.notListening; voiceLive\(MATCH_TEXT\.notListening, true\)/);
  });

  it("keeps the refused Teach's line while listening still can't start, and says it again at the next press (voice-listening-x7-2)", () => {
    // With no microphone the mic page tries again after 1 s, 5 s, then every 30 s, and each failure sends the voice
    // status again: the line was wiped at the next one, and the row read "…Teach it your voice…" as if Teach could work.
    for (const state of ["error", "muted", "starting", "downloading", "off", undefined] as const) expect(matchRefusalHolds(state, none)).toBe(true);
    for (const m of [none, onNow, offNow]) {
      expect(matchView(m, { ...shown, refused: true }).text).toBe(MATCH_TEXT.notListening);
      // Only the line changes: Teach stays where it was, to press again once the microphone is back.
      expect({ ...matchView(m, { ...shown, refused: true }), text: "" }).toEqual({ ...matchView(m, shown), text: "" });
    }
    // Listening again, or teaching under way: the row says where Voice Match stands, as before.
    for (const state of ["waiting", "active"] as const) expect(matchRefusalHolds(state, none)).toBe(false);
    expect(matchRefusalHolds("error", enrolling(0))).toBe(false);
    expect(matchView(enrolling(0), { ...shown, refused: true }).text).toBe(matchView(enrolling(0), shown).text);
    expect(matchView(none, shown).text).toBe(MATCH_TEXT.none);
    // Home drops the refusal once it no longer holds, and draws the row with it until then.
    expect(main).toMatch(/if \(matchRefused && !matchRefusalHolds\(voice\?\.state, m\)\) matchRefused = false;/);
    expect(main).toContain("speakerBytes, refused: matchRefused });");
    // A second press finds the status line holding the same words: written again all the same, so it is said again.
    expect(main).toMatch(/const voiceLive = \(text: string, again = false\) => \{ const live = \$\("voice-live"\); if \(again \|\| \(live\.textContent \|\| voiceTold\) !== text\) live\.textContent = text; \};/);
  });
});

describe("Voice Match's markup", () => {
  it("names the group by its switch, describes the switch by the state line and Teach in words without Ember's name, and labels the bar (voice-listening-r6-2)", () => {
    expect(page).toContain('<div id="match" class="match" role="group" aria-labelledby="match-label" hidden>');
    expect(page).toContain(`<input type="checkbox" id="match-on" role="switch" aria-describedby="match-text"><span id="match-label">${MATCH_TEXT.label}</span>`);
    expect(page).toContain(`<progress id="match-progress" max="4" value="0" aria-label="${MATCH_TEXT.progressLabel}" hidden></progress>`);
    expect(page).toContain(`<button type="button" id="match-teach" class="btn quiet" aria-describedby="match-teach-said">${MATCH_TEXT.teach}</button><span id="match-teach-said" hidden></span>`);
    expect(page).toContain(`<button type="button" id="match-cancel" class="btn quiet" hidden>${MATCH_TEXT.cancel}</button>`);
    // Forget my voice deletes the words learnt too: the button says so before it is pressed (voice-listening-9).
    expect(page).toContain(`<button type="button" id="match-forget" class="btn quiet" aria-describedby="match-forget-hint" title="${MATCH_TEXT.forgetHint}" hidden>${MATCH_TEXT.forget}</button><span id="match-forget-hint" hidden>${MATCH_TEXT.forgetHint}</span>`);
    // The bar is read as "1 of 4 heard", not a percentage.
    expect(main).toMatch(/bar\.setAttribute\("aria-valuetext", view\.progress\.text\)/);
  });

  it("sizes with Text size: nothing in the group is set in fixed pixels of type", () => {
    const rules = css.split("\n").filter(l => /\.match|#match/.test(l));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r, r).not.toMatch(/font(-size)?:[^;]*\d+px/);
  });
});

describe("How Ember asks (Apps & privacy, modes-A10)", () => {
  const AT = "2026-11-12T10:00:00.000Z";
  const NONE = { version: 0, at: null };
  const agreed = { mode: "interactive" as const, consent: { interactive: { version: modeCardVersion("interactive"), at: AT }, assisted: NONE, autopilot: NONE } };
  /** As main tells Home: the pure state for a setting and a policy. */
  const state = (approvals = DEFAULT_SETTINGS.approvals, policy: Record<string, unknown> | null = null): ApprovalsState => approvalsState(approvals, policy ? AdminPolicySchema.parse(policy) : null);
  const ROW = { mode: "interactive", name: "Interactive", line: MODE_LINE.interactive };
  const ASSISTED = { mode: "assisted", name: "Assisted", line: MODE_LINE.assisted };

  it("shows one row per mode that is built, each with one plain sentence, and marks the one in force", () => {
    expect(approvalsView(state(agreed), false).rows).toEqual([{ ...ROW, checked: true, locked: false, title: "" }, { ...ASSISTED, checked: false, locked: false, title: "" }]);
    expect(approvalsView(state(agreed), false).inForce).toBe("interactive");
    expect(approvalsView(state(), false).rows).toEqual([{ ...ROW, checked: false, locked: false, title: "" }, { ...ASSISTED, checked: false, locked: false, title: "" }]);
    expect(MODE_LINE.interactive).toBe("Ember tells you about ordinary steps as it does them, and asks before anything risky, such as sending, deleting or paying.");
    expect(MODE_LINE.assisted).toBe("As Interactive, but before Ember asks, a lighter AI model checks the step against what you asked. If it matches, Ember goes ahead and tells you.");
    // Assisted in force is the row marked (modes-C5).
    const assisted = { mode: "assisted" as const, consent: { ...agreed.consent, assisted: { version: modeCardVersion("assisted"), at: AT } } };
    expect(approvalsView(state(assisted), false)).toMatchObject({ inForce: "assisted", card: null, rows: [{ mode: "interactive", checked: false }, { mode: "assisted", checked: true }] });
    // A mode with no row yet is never drawn, whatever main offers; before main's state has come, nothing is marked.
    expect(approvalsView({ ...state(agreed), offered: ["interactive", "assisted", "autopilot"] }, false).rows.map(r => r.mode)).toEqual(["interactive", "assisted"]);
    expect(approvalsView(null, false)).toEqual({ rows: [{ ...ROW, checked: false, locked: false, title: "" }], note: "", card: null, inForce: null });
  });

  it("shows Interactive's card ready to agree while its card isn't agreed to, and says that until then Ember asks", () => {
    const v = approvalsView(state(), false);
    expect(v.card).toBe("interactive");
    expect(v.inForce).toBeNull();
    expect(v.note).toBe("Until you agree to Interactive, Ember asks before its first step in an app, before using your mouse and keyboard, before pressing OK on an app's message box and before moving text between apps.");
    // An existing user's agreement to Work without asking's card is none to this one.
    const old = { ...DEFAULT_SETTINGS.approvals, consent: { ...DEFAULT_SETTINGS.approvals.consent, interactive: { version: 2, at: AT } } };
    expect(approvalsView(state(old), false)).toMatchObject({ card: "interactive", inForce: null });
    // Once it is in force nothing is offered to agree to, and the note says how to answer by voice.
    expect(approvalsView(state(agreed), false)).toMatchObject({ card: null, note: "You can answer a question by voice too: say “allow” or “not now” once Ember has asked, or “Ember, allow” later." });
    expect(modeCard("interactive")).toMatchObject({ title: "Before you choose Interactive", yes: "I agree, use Interactive", no: "Not now" });
  });

  it("locks the rows the organisation set, marks none in force, and says why in one sentence, to screen readers as well as in the tooltip", () => {
    for (const policy of [{ features: { autonomy: false } }, { allowGrants: false }, { confirmEveryAction: true }, { features: { actions: false } }]) {
      const keys = new Set(managedKeys(AdminPolicySchema.parse(policy)));
      expect(keys.has("autonomy")).toBe(true);
      for (const v of [approvalsView(state(agreed, policy), keys.has("autonomy")), approvalsView(state(agreed, policy), false), approvalsView(state(agreed), true)]) {
        expect(v.rows).toEqual([{ ...ROW, checked: false, locked: true, title: MANAGED_TEXT }, { ...ASSISTED, checked: false, locked: true, title: MANAGED_TEXT }]);
        expect(v.card).toBeNull();
        expect(v.inForce).toBeNull();
        expect(v.note).toBe("Managed by your organisation: Ember asks before its first step in an app, before using your mouse and keyboard, before pressing OK on an app's message box and before moving text between apps.");
      }
    }
    // The rows are described by the note, so a screen reader hears why they are locked.
    expect(page).toContain(`<div class="modes" id="approvals" role="radiogroup" aria-labelledby="approvals-h" aria-describedby="approvals-note"></div>`);
    expect(main).toMatch(/el\.disabled = r\.locked;\s*el\.classList\.toggle\("locked", r\.locked\);\s*el\.title = r\.title;/);
    expect(css).toMatch(/\.locked \{ opacity: 0\.5; \}/);
  });

  it("locks Assisted's row alone where the organisation turned its check off or caps the mode, and says why in the note and the tooltip (modes-C5)", () => {
    const off = approvalsView(state(agreed, { features: { aiReview: false } }), false);
    expect(off.rows).toEqual([{ ...ROW, checked: true, locked: false, title: "" }, { ...ASSISTED, checked: false, locked: true, title: "Your organisation turned off the check Assisted needs" }]);
    expect(off.note).toBe("You can answer a question by voice too: say “allow” or “not now” once Ember has asked, or “Ember, allow” later. Your organisation turned off the check Assisted needs, so Assisted can't be chosen.");
    const capped = approvalsView(approvalsState(agreed, { ...AdminPolicySchema.parse({}), approvals: { maxMode: "interactive" } }), false);
    expect(capped.rows).toEqual([{ ...ROW, checked: true, locked: false, title: "" }, { ...ASSISTED, checked: false, locked: true, title: MANAGED_TEXT }]);
    expect(capped.note).toBe("You can answer a question by voice too: say “allow” or “not now” once Ember has asked, or “Ember, allow” later. Your organisation allows Interactive at most.");
    // Said once: where Assisted is the mode chosen, the note's own sentence says it already.
    const both = { mode: "assisted" as const, consent: { ...agreed.consent, assisted: { version: modeCardVersion("assisted"), at: AT } } };
    expect(approvalsView(state(both, { features: { aiReview: false } }), false).note.match(/turned off the check/g)).toHaveLength(1);
    // Before Interactive is agreed to, its card still shows ready, and the locked row still says why.
    const fresh = approvalsView(state(DEFAULT_SETTINGS.approvals, { features: { aiReview: false } }), false);
    expect(fresh.card).toBe("interactive");
    expect(fresh.note).toMatch(/^Until you agree to Interactive, .* Your organisation turned off the check Assisted needs, so Assisted can't be chosen\.$/);
    // A cap at Assisted, or none, locks nothing.
    expect(approvalsView(approvalsState(agreed, { ...AdminPolicySchema.parse({}), approvals: { maxMode: "assisted" } }), false).rows.every(r => !r.locked)).toBe(true);
  });

  it("says why the mode in force isn't the one chosen: the organisation's cap, its check turned off, a choice that couldn't be recorded", () => {
    const both = { mode: "assisted" as const, consent: { ...agreed.consent, assisted: { version: modeCardVersion("assisted"), at: AT } } };
    expect(approvalsView(approvalsState(both, { ...AdminPolicySchema.parse({}), approvals: { maxMode: "interactive" } }), false)).toMatchObject({ inForce: "interactive", note: expect.stringMatching(/^Your organisation allows Interactive at most, so Interactive is in use\. /) });
    expect(approvalsView(state(both, { features: { aiReview: false } }), false)).toMatchObject({ inForce: "interactive", note: expect.stringMatching(/^Your organisation turned off the check Assisted needs, so Interactive is in use\. /) });
    const held: ApprovalsState = { ...state(agreed), inForce: "asking", why: "not-recorded" };
    expect(approvalsView(held, false)).toMatchObject({
      inForce: null, card: null,
      note: "Ember couldn't save or record your choice, so it isn't in use: Ember asks before its first step in an app, before using your mouse and keyboard, before pressing OK on an app's message box and before moving text between apps. Choose it again to try once more.",
    });
    expect(approvalsView(held, false).rows[0]).toMatchObject({ checked: false, locked: false });
  });

  it("says in one sentence why a choice wasn't made", () => {
    expect(modeRefusal("organisation")).toBe("Your organisation has Ember ask first, so this can't be chosen.");
    expect(modeRefusal("cap")).toBe("Your organisation doesn't allow this mode.");
    expect(modeRefusal("check-off")).toBe("Your organisation turned off the check this mode needs.");
    expect(modeRefusal("card")).toBe("This card has changed since you opened it. Read it again, then choose.");
    expect(modeRefusal("not-recorded")).toBe("Ember couldn't save or record your choice, so nothing changed.");
    expect(modeRefusal("unavailable")).toBe("Ember can't use this mode yet.");
  });

  it("has the page's words: one choice in place of the three switches, its note, its card and where a refusal is said", () => {
    expect(page).toContain(`<h3 class="sub" id="approvals-h">${APPROVALS_HEADING}</h3>`);
    expect(APPROVALS_HEADING).toBe("How Ember asks");
    expect(MODE_NAME).toEqual({ interactive: "Interactive", assisted: "Assisted", autopilot: "Autopilot" });
    expect(page).toContain(`<p class="row-note" id="approvals-note"></p>`);
    expect(page).toContain(`<div id="approvals-card" class="consent" role="group" aria-labelledby="approvals-card-title" hidden>`);
    expect(page).toContain(`<button type="button" id="approvals-yes" class="btn" aria-describedby="approvals-card-text"></button><button type="button" id="approvals-no" class="btn quiet">Not now</button>`);
    expect(page).toContain(`<p class="hint" id="approvals-msg" role="status"></p>`);
    for (const gone of ["trust-apps", "trust-commands", "trust-managed", "autonomy-on", "autonomy-consent", "When Ember asks first", "Work without asking", "Ask only about dangerous commands", "Don't ask before working in an app"]) expect(page, gone).not.toContain(gone);
  });

  it("is a radio group: one Tab stop, arrow keys that move without choosing, and a press that opens the mode's card", () => {
    // Each row is a radio; the Tab stop is the mode in force, or the first row while none is.
    expect(main).toContain(`el.setAttribute("role", "radio");`);
    expect(main).toContain(`el.setAttribute("aria-checked", String(r.checked));`);
    expect(main).toContain("const stop = view.rows.find(r => r.checked && !r.locked) ?? view.rows.find(r => !r.locked);");
    expect(main).toContain("el.tabIndex = r === stop ? 0 : -1;");
    // The arrow keys only move: no click, so no card opens and nothing is chosen in passing.
    const keys = main.slice(main.indexOf(`$("approvals").addEventListener("keydown"`), main.indexOf(`$("approvals-yes").addEventListener("click"`));
    expect(keys).toContain(`const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };`);
    expect(keys).toContain("rows[next].focus();");
    expect(keys).not.toMatch(/\.click\(\)|openModeCard|chooseMode/);
    // A press on a mode that isn't in force shows its card and moves the keyboard to its agree button, which the card's
    // text describes: a screen reader says the card as it opens. The button takes no press for AGREE_ARM_MS.
    const press = main.slice(main.indexOf(`$("approvals").addEventListener("click"`), main.indexOf(`$("approvals").addEventListener("keydown"`));
    expect(press).toContain(`if (!row || !mode || row.disabled || row.getAttribute("aria-checked") === "true") return;`);
    expect(press).toMatch(/openModeCard\(mode\);\s*\$\("approvals-yes"\)\.focus\(\);/);
    expect(main).toContain(`showConsentCard("approvals-card", "approvals-yes");`);
    expect(main).toContain(`if (!mode || choosing || !agreeArmed("approvals-yes")) return;`);
  });

  it("changes the mode only with “I agree”, through main's one call, and gives the keyboard back to the row when the card closes", () => {
    const yes = main.slice(main.indexOf(`$("approvals-yes").addEventListener("click"`), main.indexOf(`$("approvals-no").addEventListener("click"`));
    expect(yes).toContain("window.ember.chooseMode(mode, modeCardVersion(mode)).then(done => {");
    expect(yes).toContain("closeModeCard(true);");
    expect(yes).toContain("modeRow(mode)?.focus();");
    expect(yes).toContain(`$("approvals-msg").textContent = done.ok ? "" : modeRefusal(done.why);`);
    // Not now leaves the mode as it was: nothing is sent to main.
    expect(main).toContain(`$("approvals-no").addEventListener("click", () => { cardDismissed = true; closeModeCard(true); });`);
    expect(main).toContain(`if (focus || held) (row && !row.disabled ? row : $("approvals-h")).focus();`);
    // What is in force is main's word, never worked out here from the settings.
    expect(main).toContain("window.ember.onApprovals(state => { pushedApprovals = approvalsNow = state; renderApprovals(); });");
    expect(main).toContain("approvalsNow = pushedApprovals ?? status.approvals ?? null;");
    expect(main).not.toMatch(/\bsettings\??\.approvals|\bs\.approvals/);
  });

  it("no longer says under it that Ember asks before its first action in each app once a mode is in force", () => {
    expect(grantsEmptyText({ confirmEvery: false, modeInForce: false })).toBe("None: Ember asks before its first action in each app.");
    expect(grantsEmptyText({ confirmEvery: false, modeInForce: true })).toBe("None.");
    expect(grantsEmptyText({ confirmEvery: true, modeInForce: false })).toBe("None.");
    expect(main).toContain(`const modeInForce = approvalsView(approvalsNow, managed.has("autonomy")).inForce !== null;`);
    expect(main).toContain("textContent: grantsEmptyText({ confirmEvery, modeInForce })");
  });

  it("draws the mode in force by shape as well as colour, in contrast themes too", () => {
    expect(css).toMatch(/\.mode::before \{\s*content: ""; grid-row: 1 \/ span 2; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%;\s*background: var\(--wash-6\); box-shadow: inset 0 0 0 1\.5px var\(--control-edge\);\s*\}/);
    expect(css).toMatch(/\.mode\[aria-checked="true"\]::before \{ background: var\(--on-accent\); box-shadow: inset 0 0 0 5px var\(--accent\); \}/);
    expect(css).toMatch(/\.mode:focus-visible \{ outline: none; box-shadow: var\(--focus-ring\); \}/);
    expect(css).toMatch(/\.mode\[aria-checked="true"\]::before \{ background: HighlightText; box-shadow: inset 0 0 0 5px Highlight; \}/);
    // Sized with Text size: nothing in the rows is set in fixed pixels of type.
    for (const r of css.split("\n").filter(l => /^\.mode\b/.test(l))) expect(r, r).not.toMatch(/font(-size)?:[^;]*\d+px/);
  });
});
