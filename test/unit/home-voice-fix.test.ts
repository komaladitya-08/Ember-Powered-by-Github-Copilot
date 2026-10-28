/**
 * The settings window's Voice line offers the setup check's microphone fix while listening has failed (review #100):
 * Windows' "Let desktop apps access your microphone" off, or macOS's microphone permission, opens from right there.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { voiceFix, voiceFixFailed } from "../../app/renderer/home/copy";

const mic = { id: "microphone", label: "Microphone", status: "warn", detail: "…", fix: "open-microphone-settings" };

describe("voiceFix", () => {
  it("is the microphone check's fix while the voice line shows an error", () => {
    const checks = [{ id: "os", label: "Operating system", status: "ok", detail: "Windows 11" }, mic];
    expect(voiceFix("error", checks)).toBe("open-microphone-settings");
  });

  it("is nothing while listening works, or without a microphone check that has a fix", () => {
    for (const state of ["off", "waiting", "active", "muted", "downloading"]) expect(voiceFix(state, [mic])).toBeNull();
    expect(voiceFix("error", [])).toBeNull();
    expect(voiceFix("error", [{ ...mic, fix: undefined }])).toBeNull();
    expect(voiceFix("error", [{ ...mic, id: "microphone-privacy" }])).toBeNull();
  });

  it("says why when the fix fails, in main's words without Electron's IPC prefix, as the setup check's own button does", () => {
    expect(voiceFixFailed(new Error("Error invoking remote method 'ember:apply-fix': Error: Settings didn't open"))).toBe("Couldn't open it: Settings didn't open");
    // The button's click shows it on the voice line (and to screen readers) instead of swallowing the refusal.
    const src = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    const click = src.slice(src.indexOf('$("voice-fix").addEventListener("click"'));
    expect(click.slice(0, click.indexOf("\n});"))).toMatch(/applyFix\(fix\)\.then\(renderChecks, err => \{[^}]*voiceFixFailed\(err\)/);
  });

  it("has its button beside the voice line, hidden until it applies", () => {
    const html = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
    expect(html).toMatch(/<button type="button" id="voice-fix" class="btn quiet" hidden>[^<]+<\/button>/);
  });
});
