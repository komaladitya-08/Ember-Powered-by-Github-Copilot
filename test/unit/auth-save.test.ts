/** TokenStore.save and the GitHub CLI lookup (design §4.17): a refused keyring means "sign in again next time", not an error. */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

import { TokenStore, ghCliToken, resolveToken, type SecretBox } from "../../app/main/agent/auth";
import { PLATFORM_WORDS } from "../../app/shared/words";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-auth-")), "github-token.bin");
const box = (over: Partial<SecretBox> = {}): SecretBox => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed:${s}`),
  decryptString: b => b.toString().replace(/^sealed:/, ""),
  ...over,
});

describe("TokenStore.save", () => {
  it("keeps the token when the keyring works (as before)", async () => {
    const f = file();
    const store = new TokenStore(f, box());
    expect(store.save("gho_abc")).toBe(true);
    expect(await store.load()).toBe("gho_abc");
  });

  it("answers false, writing nothing, when the keyring refuses (macOS: the Keychain prompt answered Deny)", () => {
    const f = file();
    const store = new TokenStore(f, box({ encryptString: () => { throw new Error("Error while encrypting the text provided to safeStorage.encryptString."); } }));
    expect(store.save("gho_abc")).toBe(false);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("still answers false without a keyring (basic_text)", () => {
    const store = new TokenStore(file(), box({ getSelectedStorageBackend: () => "basic_text" }));
    expect(store.save("gho_abc")).toBe(false);
  });
});

describe("TokenStore.load when the keyring refuses (review #241)", () => {
  it("tells a saved sign-in the keyring wouldn't open apart from none at all", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    // macOS's keychain prompt answered Deny (or Cancel) after an update: decryptString throws.
    const refused = new TokenStore(f, box({ decryptString: () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); } }));
    expect(refused.hasSaved()).toBe(true);
    expect(await refused.load()).toBeNull();
    expect(refused.unreadable).toBe(true);
    // Allowed the next time: readable again.
    const allowed = new TokenStore(f, box());
    expect(await allowed.load()).toBe("gho_abc");
    expect(allowed.unreadable).toBe(false);
    // Nothing saved: not "unreadable".
    const none = new TokenStore(file(), box({ decryptString: () => { throw new Error("never asked"); } }));
    expect(none.hasSaved()).toBe(false);
    expect(await none.load()).toBeNull();
    expect(none.unreadable).toBe(false);
  });

  it("forgets the refusal once the user signs in again or out", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    let deny = true;
    const store = new TokenStore(f, box({ decryptString: b => { if (deny) throw new Error("denied"); return b.toString().replace(/^sealed:/, ""); } }));
    await store.load();
    expect(store.unreadable).toBe(true);
    deny = false;
    expect(store.save("gho_def")).toBe(true);
    expect(store.unreadable).toBe(false);
    deny = true;
    await store.load();
    store.clear();
    expect(store.unreadable).toBe(false);
    expect(store.hasSaved()).toBe(false);
  });

  it("is explained on macOS, where the login keychain asks after every update, and nowhere else yet", () => {
    expect(PLATFORM_WORDS.darwin.savedSignInRefused).toBe(
      "macOS didn't let Ember read its saved sign-in from your login keychain, so it isn't connected. Sign in again below; if macOS asks for your login password, choose Always Allow.");
    expect(PLATFORM_WORDS.linux.savedSignInRefused).toBeUndefined();
    expect(PLATFORM_WORDS.win32.savedSignInRefused).toBeUndefined();
  });

  it("still has the saved sign-in to try again after a refusal (nothing is deleted)", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    const refused = new TokenStore(f, box({ decryptString: () => { throw new Error("denied"); } }));
    expect(await resolveToken(refused, {}, async () => null)).toBeNull();
    expect(refused.unreadable).toBe(true);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe("TokenStore.load on macOS, off the main thread (review #241)", () => {
  /** The keyring's synchronous decryptString may not be asked: it would hold Ember while macOS's keychain prompt is open. */
  const asyncBox = (decryptStringAsync: SecretBox["decryptStringAsync"]) => box({ decryptString: () => { throw new Error("decryptString held the main process"); }, decryptStringAsync });

  it("opens the saved sign-in with decryptStringAsync when asked to (main does on macOS)", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    const seen: string[] = [];
    const store = new TokenStore(f, asyncBox(async b => { seen.push(b.toString()); return { result: b.toString().replace(/^sealed:/, ""), shouldReEncrypt: false }; }), { asyncDecrypt: true, version: "1.0.0" });
    expect(await store.load()).toBe("gho_abc");
    expect(seen).toEqual(["sealed:gho_abc"]);
    expect(store.unreadable).toBe(false);
    expect(store.firstReadSinceUpdate()).toBe(false);
    expect(await resolveToken(store, {}, async () => null)).toEqual({ token: "gho_abc", source: "stored" });
  });

  it("tells a refusal (the keychain prompt answered Deny) apart, and keeps the file", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    const refused = new TokenStore(f, asyncBox(async () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync."); }), { asyncDecrypt: true });
    expect(await refused.load()).toBeNull();
    expect(refused.unreadable).toBe(true);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("reads as before where it isn't asked to (Linux, Windows, the doctor) or the keyring has no asynchronous read", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    const neverAsync = box({ decryptStringAsync: async () => { throw new Error("asked the asynchronous read"); } });
    expect(await new TokenStore(f, neverAsync).load()).toBe("gho_abc");
    expect(await new TokenStore(f, box(), { asyncDecrypt: true }).load()).toBe("gho_abc");
  });
});

describe("TokenStore.firstReadSinceUpdate (review #241)", () => {
  const stamp = (f: string) => path.join(path.dirname(f), "token-read-version");

  it("is true only until this version of Ember has read the saved sign-in: the keychain asks after an update, not every start", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    // Saved by an earlier Ember that kept no stamp: the first read of this version may ask.
    fs.rmSync(stamp(f), { force: true });
    const v1 = new TokenStore(f, box(), { version: "1.0.0" });
    expect(v1.firstReadSinceUpdate()).toBe(true);
    expect(await v1.load()).toBe("gho_abc");
    expect(fs.readFileSync(stamp(f), "utf8")).toBe("1.0.0");
    expect(v1.firstReadSinceUpdate()).toBe(false);
    // The next start of the same version: no pause, no keychain words.
    expect(new TokenStore(f, box(), { version: "1.0.0" }).firstReadSinceUpdate()).toBe(false);
    // An update: once more.
    expect(new TokenStore(f, box(), { version: "1.1.0" }).firstReadSinceUpdate()).toBe(true);
  });

  it("stays true after a refused read, and is false with nothing saved", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    fs.rmSync(stamp(f), { force: true });
    const refused = new TokenStore(f, box({ decryptString: () => { throw new Error("denied"); } }), { version: "1.0.0" });
    expect(await refused.load()).toBeNull();
    expect(refused.firstReadSinceUpdate()).toBe(true);
    expect(fs.existsSync(stamp(f))).toBe(false);
    expect(new TokenStore(file(), box(), { version: "1.0.0" }).firstReadSinceUpdate()).toBe(false);
  });

  it("is stamped by a sign-in this version saved (the keychain let it in), and asks no stamp of a store without a version", async () => {
    const f = file();
    const store = new TokenStore(f, box(), { version: "2.0.0" });
    expect(store.save("gho_abc")).toBe(true);
    expect(store.firstReadSinceUpdate()).toBe(false);
    // The doctor's store has no version: it writes no stamp, and can't tell, so says it may ask.
    const g = file();
    const doctor = new TokenStore(g, box());
    expect(doctor.save("gho_abc")).toBe(true);
    expect(await doctor.load()).toBe("gho_abc");
    expect(fs.existsSync(stamp(g))).toBe(false);
    expect(doctor.firstReadSinceUpdate()).toBe(true);
  });
});

describe("ghCliToken", () => {
  const answer = (stdout: string, err: Error | null = null) => execFile.mockImplementationOnce((_cmd, _args, _opts, cb: (e: Error | null, out: string) => void) => cb(err, stdout));

  it("asks gh on PATH with today's options when nothing is given (Linux)", async () => {
    answer("gho_fromcli\n");
    expect(await ghCliToken()).toBe("gho_fromcli");
    expect(execFile).toHaveBeenLastCalledWith("gh", ["auth", "token"], { timeout: 3000 }, expect.any(Function));
  });

  it("uses the platform's path and spawn options (no console window on Windows)", async () => {
    answer("gho_fromcli\n");
    expect(await ghCliToken({ path: "C:\\Program Files\\GitHub CLI\\gh.exe", spawn: { windowsHide: true } })).toBe("gho_fromcli");
    expect(execFile).toHaveBeenLastCalledWith("C:\\Program Files\\GitHub CLI\\gh.exe", ["auth", "token"], { windowsHide: true, timeout: 3000 }, expect.any(Function));
  });

  it("gives nothing for a failed or unusable answer", async () => {
    answer("", new Error("gh: not found"));
    expect(await ghCliToken()).toBeNull();
    answer("ghp_classic\n");
    expect(await ghCliToken()).toBeNull();
  });

  it("is what resolveToken asks, with the options main passes", async () => {
    answer("gho_viaoptions\n");
    expect(await resolveToken(null, {}, { path: "/opt/homebrew/bin/gh" })).toEqual({ token: "gho_viaoptions", source: "github-cli" });
    expect(execFile).toHaveBeenLastCalledWith("/opt/homebrew/bin/gh", ["auth", "token"], { timeout: 3000 }, expect.any(Function));
    // A function still stands in for the CLI (tests, as before).
    expect(await resolveToken(null, {}, async () => "gho_fake")).toEqual({ token: "gho_fake", source: "github-cli" });
  });
});
