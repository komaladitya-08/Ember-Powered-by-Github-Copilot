/**
 * Hear me more clearly: the clearer recognizer stays optional, pinned and off, and Home says how it stands.
 */
import { describe, expect, it, vi } from "vitest";
import { CLEAR_SPEECH, LISTENING_MODELS, VOICE_MODELS } from "../../app/voice/models";
import { CLEAR_HINT, clearHearingLine } from "../../app/renderer/home/copy";
import { calledByName } from "../../app/voice/engine";

// app/main/voice.ts (for downloadHelp, the words a failed download shows) imports Electron, which isn't loaded here.
vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, MessageChannelMain: class {}, ipcMain: {}, net: {}, session: {}, utilityProcess: {} }));

describe("the clearer recognizer", () => {
  it("is pinned, and not part of the standard download or of what listening needs", () => {
    expect(CLEAR_SPEECH.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CLEAR_SPEECH.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\//);
    expect(VOICE_MODELS.map(m => m.id)).not.toContain("clear");
    expect(LISTENING_MODELS).not.toContain("clear");
  });

  it("says its size where it is offered, from the pinned download", () => {
    expect(CLEAR_HINT).toContain(`${Math.round(CLEAR_SPEECH.bytes / 1e6)} MB`);
  });

  it("says how it stands under its switch, and nothing while off", () => {
    expect(clearHearingLine(undefined)).toBe("");
    expect(clearHearingLine({ state: "off" })).toBe("");
    expect(clearHearingLine({ state: "downloading", percent: 40 })).toBe("Downloading… 40%");
    expect(clearHearingLine({ state: "starting" })).toBe("Starting…");
    expect(clearHearingLine({ state: "failed", detail: "The network dropped." })).toBe("The network dropped. Turn this off and on to try again.");
    expect(clearHearingLine({ state: "wont-load" })).toMatch(/usual speech model/);
  });

  it("never names Ember in a way a screen reader saying the line into the wake word's microphone wakes it (voice-listening-c4-1)", () => {
    // "On. Ember writes what you say with the clearer model.", read into an idle wake microphone in the test-only Ryan
    // voice, woke Ember and sent "Writes what you say with the clearer model." as a request in 5 of 20 placements.
    expect(clearHearingLine({ state: "on" })).toBe("On. The clearer model writes what you say.");
    expect(clearHearingLine({ state: "needs-native" })).toBe("This computer can't run it, so the usual speech model writes what you say.");
    expect(clearHearingLine({ state: "wont-load" })).toBe("It wouldn't start on this computer, so the usual speech model writes what you say.");
    for (const s of [{ state: "on" }, { state: "needs-native" }, { state: "wont-load" }, { state: "starting" }, { state: "downloading", percent: 40 }, { state: "failed", detail: "The network dropped." }] as const) {
      const words = clearHearingLine(s).split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(calledByName(words.slice(i).join(" ")), `${s.state} from “${words[i]}”`).toBe(false);
    }
  });

  it("never names Ember when its download fails, in any of the words a failed download is told in (voice-listening-v5-1)", async () => {
    // "Ember can't reach the download site (github.com) right now…", said by a screen reader into an idle wake
    // microphone in the test-only Ryan voice, woke Ember and was sent as a request in 37 of 40 placements (the
    // certificate line in 38, the permission line in 36). Without the name, the network, certificate, permission and
    // proxy lines woke it in 0 of 12 each, where the old network line did in 10 of 12.
    const { downloadHelp } = await import("../../app/main/voice");
    const raw = [
      "net::ERR_INTERNET_DISCONNECTED", "fetch failed", "getaddrinfo ENOTFOUND github.com", "download failed: HTTP 503",
      "nothing arrived for 30 seconds (check the network or proxy)", "net::ERR_CERT_AUTHORITY_INVALID",
      "self signed certificate in certificate chain", "download failed: HTTP 407", "net::ERR_PROXY_AUTH_UNSUPPORTED",
      "download failed: HTTP 403", "ENOSPC: no space left on device, write", "EACCES: permission denied, open '/x'",
      "EROFS: read-only file system, mkdir '/x'", `${CLEAR_SPEECH.name}: checksum mismatch (got 0123456789ab…). The download was not used.`,
      `${CLEAR_SPEECH.name}: the downloaded tar archive couldn't be unpacked: bzip2 data is truncated`,
      "download failed: too many redirects",
    ];
    for (const message of raw) {
      const line = clearHearingLine({ state: "failed", detail: downloadHelp(message, CLEAR_SPEECH.bytes) });
      expect(line, message).not.toMatch(/\bEmber\b/i);
      const words = line.split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(calledByName(words.slice(i).join(" ")), `${message} from “${words[i]}”`).toBe(false);
    }
  });

  it("never reads out a raw error, whose data folder path names Ember, when its download can't be saved (voice-listening-w5-2)", async () => {
    // downloadHelp handed back word for word any error it didn't know, and a file error carries the data folder's path
    // (…/ember/models): said into an idle wake microphone, the ENOENT line woke Ember and was sent as a request in 1
    // of 40 real-model placements.
    const { downloadHelp } = await import("../../app/main/voice");
    const raw = [
      "EBUSY: resource busy or locked, rename 'C:\\Users\\me\\AppData\\Local\\ember\\models\\.unpack-parakeet\\parakeet' -> 'C:\\Users\\me\\AppData\\Local\\ember\\models\\parakeet'",
      "ENOENT: no such file or directory, open '/home/me/.config/ember/models/.download-parakeet.tar.bz2'",
      "ENOTEMPTY: directory not empty, rename '/home/me/.config/ember/models/.unpack-parakeet/parakeet' -> '/home/me/.config/ember/models/parakeet'",
      "EEXIST: file already exists, mkdir '/home/me/.config/ember/models/.unpack-parakeet'",
      "EDQUOT: disk quota exceeded, write",
      "Unexpected end of stream in /home/me/.config/ember/models",
    ];
    for (const message of raw) {
      const line = clearHearingLine({ state: "failed", detail: downloadHelp(message, CLEAR_SPEECH.bytes) });
      expect(line, message).not.toMatch(/\bEmber\b/i);
      expect(line, message).not.toMatch(/\bE[A-Z]{3,}\b|[\\/]/); // (no error code, no path)
      const words = line.split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(calledByName(words.slice(i).join(" ")), `${message} from “${words[i]}”`).toBe(false);
    }
    expect(downloadHelp(raw[0])).toBe("The download couldn't be saved in the data folder. Try again; if it keeps happening, restart this computer.");
    expect(downloadHelp(raw[1])).toBe(downloadHelp(raw[0]));
    expect(downloadHelp(raw[4], CLEAR_SPEECH.bytes)).toBe(`There isn't enough free disk space for the speech models (about ${Math.round(CLEAR_SPEECH.bytes / 1e6)} MB).`);
    expect(downloadHelp(raw[5])).toBe("Something went wrong with the download. Try again.");
  });
});
