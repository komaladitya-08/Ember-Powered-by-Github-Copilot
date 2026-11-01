/**
 * Voice Match (Voice) and "When Ember asks first" (Apps & privacy) in the settings window: each state's view as
 * match-copy.ts builds it and home/main.ts applies it, what screen readers hear while Ember learns a voice, where focus
 * goes when a button hides itself, and how the organisation's lock reads. Read as text: vitest runs without a DOM.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MANAGED_TEXT, MATCH_TEXT, TRUST_TEXT, matchAnnouncement, matchView, trustView } from "../../app/renderer/home/match-copy";
import { managedKeys } from "../../app/main/admin";
import type { VoiceMatchStatus } from "../../app/shared/ipc";

const read = (f: string) => readFileSync(new URL(`../../app/renderer/home/${f}`, import.meta.url), "utf8");
const page = read("index.html");
const main = read("main.ts");
const css = read("styles.css");

const none: VoiceMatchStatus = { enrolled: false, on: false, enrolling: null };
const enrolling = (got: number, again?: "short" | "unlike" | "failed", phrase = "Ember, what's the weather like"): VoiceMatchStatus =>
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
  });

  it("without its model: off with a note (a kept voiceprint isn't used, so every voice is heard), nothing to switch on or teach", () => {
    const kept = matchView({ enrolled: true, on: false, model: false, wanted: true, enrolling: null }, { ...shown, speakerBytes: 26_534_365 });
    expect(kept).toMatchObject({ checked: false, disabled: true, forgetHidden: false, focus: ["voice-download", "wake"] });
    expect(kept.teach.hidden).toBe(true);
    expect(kept.text).toMatch(/^Off for now: Voice Match's model is missing or was damaged, so Ember answers anyone .*Download it above \(27 MB\)/);
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

  it("says how learning ended, and a forgotten voice", () => {
    expect(matchAnnouncement(enrolling(3), onNow)).toBe(`Ember knows your voice now. ${MATCH_TEXT.on}`);
    expect(matchAnnouncement(enrolling(1), none, true)).toBe(`Stopped teaching Ember your voice. ${MATCH_TEXT.none}`);
    expect(matchAnnouncement(enrolling(1), none)).toBe(MATCH_TEXT.none);
    expect(matchAnnouncement(onNow, none)).toBe(`Ember forgot your voice. ${MATCH_TEXT.none}`);
    expect(matchAnnouncement(onNow, offNow)).toBeNull();
    expect(matchAnnouncement(undefined, undefined)).toBeNull();
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
    expect(page).toContain(`<button type="button" id="match-forget" class="btn quiet" hidden>${MATCH_TEXT.forget}</button>`);
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
    expect(commands).toMatchObject({ checked: true, disabled: true, locked: true, describedBy: "trust-commands-hint trust-managed" });
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
    expect(page).toContain(`<p class="hint" id="trust-apps-hint">${TRUST_TEXT.appsHint}</p>`);
    expect(page).toContain(`<input type="checkbox" id="trust-commands" role="switch" aria-describedby="trust-commands-hint"><span>${TRUST_TEXT.commands}</span>`);
    expect(page).toContain(`<p class="hint" id="trust-commands-hint">${TRUST_TEXT.commandsHint}</p>`);
  });
});
