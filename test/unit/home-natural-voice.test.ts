/** Voice selection defaults to the included Kitten voice and discloses optional Kokoro downloads and actual fallback. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveVoiceModel, NATURAL_CHOICES, naturalModelHint, naturalUseLabel } from "../../app/renderer/home/natural-copy";
import { NATURAL_HINT, naturalVoiceView } from "../../app/renderer/home/copy";

describe("the default voice choice", () => {
  it("uses Kitten for new and former baseline preferences and preserves only explicitly enabled Kokoro", () => {
    expect(effectiveVoiceModel()).toBe("kitten");
    expect(effectiveVoiceModel({ natural: false, naturalModel: "kokoro" })).toBe("kitten");
    expect(effectiveVoiceModel({ natural: false, naturalModel: "kitten" })).toBe("kitten");
    expect(effectiveVoiceModel({ natural: true, naturalModel: "kitten" })).toBe("kitten");
    expect(effectiveVoiceModel({ natural: true, naturalModel: "kokoro" })).toBe("kokoro");
  });

  it("includes Kitten in the base speech models and names the optional Kokoro download before use", () => {
    expect(NATURAL_CHOICES.kitten.size).toBe("63.8 MB");
    expect(naturalModelHint("kitten")).toContain("default voice, included in Ember's speech models");
    expect(naturalModelHint("kitten")).not.toContain("when enabled");
    expect(naturalModelHint("kokoro")).toContain("downloads 350 MB when you choose Use Kokoro");
    expect(naturalModelHint("kokoro")).toContain("Kitten Nano, or the system voice");
    expect(NATURAL_HINT).toBe(naturalModelHint("kitten"));
    expect(naturalUseLabel("kitten")).toBe("Use Kitten Nano");
    expect(naturalUseLabel("kokoro")).toBe("Use Kokoro (350 MB download)");
    const html = fs.readFileSync(path.resolve("app/renderer/home/index.html"), "utf8");
    expect(html).toContain('<div id="natural-row">');
    expect(html).toContain('<option value="kitten">Kitten Nano (default)</option>');
    expect(html).toContain(`<p class="hint" id="natural-model-hint">${NATURAL_HINT}</p>`);
    expect(html).not.toContain('id="natural"');
    expect(html).not.toContain("Use a more natural voice");
  });
});

describe("effective voice status", () => {
  it("shows the selected/default voice even when the legacy optional switch is false", () => {
    expect(naturalVoiceView(undefined).text).toContain("Kitten Nano is selected");
    expect(naturalVoiceView({ state: "on", model: "kitten", voice: "kitten" }).text).toBe("Ember speaks in Kitten Nano.");
    expect(naturalVoiceView({ state: "ready", model: "kitten" }).text).toContain("Kitten Nano is ready");
    expect(naturalVoiceView({ state: "checking", model: "kitten" })).toEqual({ text: "Checking Kitten Nano on this computer…", retry: false, busy: true });
    expect(naturalVoiceView({ state: "later", model: "kitten" }).text).toContain("next time Ember speaks");
    expect(naturalVoiceView({ state: "off", model: "kitten", voice: "system" }).text).toContain("system voice");
  });

  it("reports the actual fallback for missing, unsupported, slow and broken voices", () => {
    for (const state of ["too-slow", "wont-load", "needs-native"] as const) {
      const kitten = naturalVoiceView({ state, model: "kitten", voice: "system" });
      expect(kitten.text).toContain("Kitten Nano");
      expect(kitten.text).toContain("this computer's system voice");
      const kokoro = naturalVoiceView({ state, model: "kokoro", voice: "kitten" }, "kokoro");
      expect(kokoro.text).toContain("Kokoro");
      expect(kokoro.text).toContain("Ember uses Kitten Nano.");
      expect(naturalVoiceView({ state, model: "kokoro", voice: "system" }, "kokoro").text).toContain("this computer's system voice");
    }
    const missing = naturalVoiceView({ state: "needs-voice", model: "kitten", voice: "system" });
    expect(missing.text).toContain("Show speech model download");
    expect(missing.text).toContain("Kitten Nano is included");
    expect(missing.retry).toBe(false);
    expect(naturalVoiceView({ state: "on", model: "kokoro", voice: "kitten" }, "kokoro").text).toContain("Ember uses Kitten Nano.");
  });

  it("offers Try again when Kitten stopped working or was too slow just now, and says what happened (voice-speaking-6)", () => {
    expect(naturalVoiceView({ state: "wont-load", model: "kitten", voice: "system", stopped: true })).toEqual({
      text: "Kitten Nano stopped working, so Ember uses this computer's system voice when available. Try again, or restart Ember.", retry: true, busy: false,
    });
    expect(naturalVoiceView({ state: "wont-load", model: "kitten", voice: "system" })).toEqual({
      text: "Kitten Nano couldn't load, so Ember uses this computer's system voice when available. Try again, or restart Ember.", retry: true, busy: false,
    });
    expect(naturalVoiceView({ state: "too-slow", model: "kitten", voice: "system" })).toEqual({
      text: "Kitten Nano was too slow just now, perhaps because this computer was busy, so Ember uses this computer's system voice when available. Try again when it's less busy.", retry: true, busy: false,
    });
    // Kitten that can't run here at all, and an optional voice timed too slow (kept for a week), offer none.
    expect(naturalVoiceView({ state: "needs-native", model: "kitten", voice: "system" }).retry).toBe(false);
    expect(naturalVoiceView({ state: "too-slow", model: "kokoro", voice: "kitten" }, "kokoro").retry).toBe(false);
    const ui = fs.readFileSync(path.resolve("app/renderer/home/natural-voice.ts"), "utf8");
    expect(ui).toContain("retry.hidden = !view.retry || !allowed(current);");
    expect(fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")).toContain("ipcMain.handle(IPC.voiceNaturalRetry, guard(() => voice?.retryNaturalVoice()));");
  });

  it("offers download retry for the optional voices, not Kitten, and never displays more than 99% while downloading", () => {
    expect(naturalVoiceView({ state: "failed", model: "supertonic", detail: "Check the network." }, "supertonic").retry).toBe(true);
    const failed = naturalVoiceView({ state: "failed", model: "kokoro", voice: "kitten", detail: "Check the network." }, "kokoro");
    expect(failed).toEqual({ text: "Couldn't download Kokoro. Check the network. Ember uses Kitten Nano.", retry: true, busy: false });
    expect(naturalVoiceView({ state: "failed", model: "kitten", voice: "system", detail: "Missing files." }).retry).toBe(false);
    expect(naturalVoiceView({ state: "downloading", model: "kokoro", percent: 100 }, "kokoro").text).toBe("Downloading Kokoro… 99%");
  });

  it("never relabels a stale previous model's status as the new selection", () => {
    expect(naturalVoiceView({ state: "on", model: "kitten", voice: "kitten" }, "kokoro")).toEqual({ text: "Kokoro is selected. Checking voice availability…", retry: false, busy: true });
  });
});
