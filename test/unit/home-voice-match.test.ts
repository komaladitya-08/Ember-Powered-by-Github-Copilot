/**
 * Voice Match (Voice) and "When Ember asks first" (Apps & privacy) in the settings window: each state's view as
 * match-copy.ts builds it and home/main.ts applies it, what screen readers hear while Ember learns a voice, where focus
 * goes when a button hides itself, and how the organisation's lock reads. Read as text: vitest runs without a DOM.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MANAGED_TEXT, MATCH_SAID, MATCH_TEXT, TRUST_TEXT, matchAnnouncement, matchView, trustView } from "../../app/renderer/home/match-copy";
import { managedKeys } from "../../app/main/admin";
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
    expect(v.teach).toEqual({ hidden: false, label: "Teach Ember my voice" });
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
    expect(matchView(enrolling(0, "failed"), shown).prompt).toBe("Ember couldn't hear that clearly. Say it again: “Ember, what's the weather like”");
    // Said while a screen reader still read the prompt, the two came as one (voice-listening-r4-1).
    expect(matchView(enrolling(1, "over"), shown).prompt).toBe("Your screen reader was still reading. Wait for it to finish, then say: “Ember, what's the weather like”");
  });

  it("without its model: off with a note (a kept voiceprint isn't used, so every voice is heard), nothing to switch on or teach", () => {
    const kept = matchView({ enrolled: true, on: false, model: false, wanted: true, enrolling: null }, { ...shown, speakerBytes: 26_534_365 });
    expect(kept).toMatchObject({ checked: false, disabled: true, forgetHidden: false, focus: ["voice-download", "wake"] });
    expect(kept.teach.hidden).toBe(true);
    expect(kept.text).toMatch(/^Off for now: Voice Match's model is missing or was damaged, so your voice can't answer .*Download it above \(27 MB\)/);
    const fresh = matchView({ enrolled: false, on: false, model: false, enrolling: null }, shown);
    expect(fresh).toMatchObject({ disabled: true, text: "Voice Match needs its own model, which isn't on this computer. Download it above, then teach Ember your voice." });
    // Its model back: as before.
    expect(matchView({ ...onNow, model: true, wanted: true }, shown).text).toBe(MATCH_TEXT.on);
  });

  it("taught and on, or taught and off: Teach again and Forget are offered", () => {
    const on = matchView(onNow, shown);
    expect(on).toMatchObject({ checked: true, disabled: false, text: MATCH_TEXT.on, forgetHidden: false, cancelHidden: true });
    expect(on.teach).toEqual({ hidden: false, label: "Teach Ember my voice again" });
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
    expect(main).toMatch(/matchView\(m, \{ listening: voiceSettings\.wakeWord && voiceSettings\.consent, managed: managed\.has\("wakeWord"\), speakerBytes \}\)/);
  });
});

describe("Voice Match's focus (as after Download speech models and the consent buttons)", () => {
  it("moves to Cancel once learning starts, to Teach once it stops, and to the listening switch when the group goes", () => {
    expect(matchView(enrolling(0), shown).focus).toEqual(["match-cancel"]);
    expect(matchView(onNow, shown).focus[0]).toBe("match-teach");
    expect(matchView(none, shown).focus[0]).toBe("match-teach");
    expect(matchView(onNow, { listening: false, managed: false }).focus).toEqual(["wake"]);
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
    expect(matchAnnouncement(enrolling(3), onNow)).toBe("Your voice is learnt. On: your voice can answer questions out loud, and other voices can't. Everyone is still heard. Your voiceprint stays on this computer.");
    expect(matchAnnouncement(enrolling(1), none, true)).toBe("Stopped teaching your voice. Anyone who talks to it is heard. Teach it your voice, and you can answer its questions out loud; other voices can't.");
    expect(matchAnnouncement(enrolling(1), none)).toBe(MATCH_SAID.none);
    expect(matchAnnouncement(onNow, none)).toBe(`Your voice and the words learnt from it are forgotten. ${MATCH_SAID.none}`);
    expect(matchAnnouncement(enrolling(2), offNow)).toBe(`${MATCH_SAID.learnt} Off: answer questions by clicking. Your voiceprint is kept until you forget it.`);
    // The line shown says the same with the name, and quotes “Ember, stop”, which said into the microphone stops Ember.
    expect(MATCH_TEXT.none).toContain("“Ember, stop”");
    expect(matchAnnouncement(onNow, offNow)).toBeNull();
    expect(matchAnnouncement(undefined, undefined)).toBeNull();
  });

  it("says why teaching stopped when it gave up, timed out or Ember stopped listening, never that it knows the voice (voice-listening-2, voice-listening-5, voice-listening-v1)", () => {
    const gaveUp = "Your voice wasn't learnt: too many phrases didn't sound alike. Try again somewhere quiet, with only you speaking.";
    expect(matchAnnouncement(enrolling(2), { ...none, ended: "gave-up" })).toBe(`${gaveUp} ${MATCH_SAID.none}`);
    // Taught again, and it gave up: the earlier voiceprint is still in use, and nothing says Ember learnt the voice.
    expect(matchAnnouncement({ ...onNow, enrolling: enrolling(2).enrolling }, { ...onNow, ended: "gave-up" })).toBe(`${gaveUp} ${MATCH_SAID.on}`);
    expect(matchAnnouncement(enrolling(0), { ...none, ended: "timeout" })).toBe(`Teaching stopped because no phrase was heard for a while. Try again when you're ready. ${MATCH_SAID.none}`);
    expect(matchAnnouncement(enrolling(1), { ...none, ended: "interrupted" })).toBe(`Teaching stopped because listening stopped. Try again once it's listening again. ${MATCH_SAID.none}`);
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
    expect(main).toMatch(/MATCH_TEXT\.notListening; voiceLive\(MATCH_TEXT\.notListening\)/);
  });
});

describe("Voice Match's markup", () => {
  it("names the group by its switch, describes the switch and Teach by the state line, and labels the bar", () => {
    expect(page).toContain('<div id="match" class="match" role="group" aria-labelledby="match-label" hidden>');
    expect(page).toContain(`<input type="checkbox" id="match-on" role="switch" aria-describedby="match-text"><span id="match-label">${MATCH_TEXT.label}</span>`);
    expect(page).toContain(`<progress id="match-progress" max="4" value="0" aria-label="${MATCH_TEXT.progressLabel}" hidden></progress>`);
    expect(page).toContain(`<button type="button" id="match-teach" class="btn quiet" aria-describedby="match-text">${MATCH_TEXT.teach}</button>`);
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

describe("When Ember asks first", () => {
  it("shows each switch as the settings say, described by its hint", () => {
    expect(trustView({ askedApps: true, reviewCommands: false }, new Set())).toEqual([
      { id: "trust-apps", checked: true, disabled: false, locked: false, title: "", describedBy: "trust-apps-hint" },
      { id: "trust-commands", checked: false, disabled: false, locked: false, title: "", describedBy: "trust-commands-hint" },
    ]);
  });

  it("locks the rows the organisation set, and says so to screen readers as well as in the tooltip", () => {
    // allowGrants false locks askedApps; features.aiReview false locks reviewCommands (admin.ts managedKeys).
    const keys = new Set(managedKeys({ allowGrants: false, features: { aiReview: false }, models: {} } as unknown as Parameters<typeof managedKeys>[0]));
    expect(keys.has("askedApps") && keys.has("reviewCommands")).toBe(true);
    const [apps, commands] = trustView({ askedApps: false, reviewCommands: true }, keys);
    expect(apps).toEqual({ id: "trust-apps", checked: false, disabled: true, locked: true, title: MANAGED_TEXT, describedBy: "trust-apps-hint trust-managed" });
    // Shown off as in force, though the settings still hold it on (a held lockdown; safety-privacy-w5-2).
    expect(commands).toMatchObject({ checked: false, disabled: true, locked: true, describedBy: "trust-commands-hint trust-managed" });
    // Only the managed one is locked.
    expect(trustView({ askedApps: true, reviewCommands: true }, new Set(["reviewCommands"])).map(r => r.locked)).toEqual([false, true]);
    expect(page).toContain(`<span id="trust-managed" hidden>${MANAGED_TEXT}</span>`);
  });

  it("dims a locked row the way the window's other managed rows are dimmed", () => {
    expect(main).toMatch(/\(input\.closest\(MANAGED_ROW\) \?\? input\)\.classList\.toggle\("locked", row\.locked\);/);
    expect(main).toMatch(/input\.setAttribute\("aria-describedby", row\.describedBy\);/);
    expect(css).toMatch(/\.locked \{ opacity: 0\.5; \}/);
  });

  it("has the page's words", () => {
    expect(page).toContain(`<h3 class="sub">${TRUST_TEXT.heading}</h3>`);
    expect(page).toContain(`<input type="checkbox" id="trust-apps" role="switch" aria-describedby="trust-apps-hint"><span>${TRUST_TEXT.apps}</span>`);
    expect(page).toContain(`<p class="row-note" id="trust-apps-hint">${TRUST_TEXT.appsHint}</p>`);
    expect(page).toContain(`<input type="checkbox" id="trust-commands" role="switch" aria-describedby="trust-commands-hint"><span>${TRUST_TEXT.commands}</span>`);
    expect(page).toContain(`<p class="row-note" id="trust-commands-hint">${TRUST_TEXT.commandsHint}</p>`);
    // Both switches sit in one group, each with its note under it (UI audit #11).
    expect(page).toMatch(/<div class="group">\s*<div class="noted-row">\s*<label class="switch-row"><input type="checkbox" id="trust-apps"[^]*?<div class="noted-row">\s*<label class="switch-row"><input type="checkbox" id="trust-commands"/);
  });
});
