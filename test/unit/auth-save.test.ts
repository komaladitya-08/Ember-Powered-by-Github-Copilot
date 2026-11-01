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

  it("keeps a sign-in it couldn't write for this run, until one is written or it is cleared (cross-review X13)", async () => {
    const f = file();
    const store = new TokenStore(f, box());
    expect(store.save("gho_old")).toBe(true);
    // A full or read-only disk: the file can't be replaced, and still holds the old one.
    fs.mkdirSync(`${f}.${process.pid}.tmp`);
    expect(store.saveResult("gho_new")).toBe("write-failed");
    expect(await store.load()).toBe("gho_new");
    expect(box().decryptString(fs.readFileSync(f))).toBe("gho_old");
    // Written once the disk has room again: from the file from then on.
    fs.rmdirSync(`${f}.${process.pid}.tmp`);
    expect(store.saveResult("gho_newer")).toBe("kept");
    expect(await store.load()).toBe("gho_newer");
    // No keyring: for this run too; signing out forgets it.
    const none = new TokenStore(file(), box({ getSelectedStorageBackend: () => "basic_text" }));
    expect(none.saveResult("gho_abc")).toBe("no-keyring");
    expect(await none.load()).toBe("gho_abc");
    none.clear();
    expect(await none.load()).toBeNull();
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
    const store = new TokenStore(f, asyncBox(async b => { seen.push(b.toString()); return { result: b.toString().replace(/^sealed:/, ""), shouldReEncrypt: false }; }), { asyncKeyring: true, version: "1.0.0" });
    expect(await store.load()).toBe("gho_abc");
    expect(seen).toEqual(["sealed:gho_abc"]);
    expect(store.unreadable).toBe(false);
    expect(store.firstReadSinceUpdate()).toBe(false);
    expect(await resolveToken(store, {}, async () => null)).toEqual({ token: "gho_abc", source: "stored" });
  });

  it("tells a refusal (the keychain prompt answered Deny) apart, and keeps the file", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    const refused = new TokenStore(f, asyncBox(async () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync."); }), { asyncKeyring: true });
    expect(await refused.load()).toBeNull();
    expect(refused.unreadable).toBe(true);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("reads as before where it isn't asked to (Linux, Windows, the doctor) or the keyring has no asynchronous read", async () => {
    const f = file();
    expect(new TokenStore(f, box()).save("gho_abc")).toBe(true);
    const neverAsync = box({ decryptStringAsync: async () => { throw new Error("asked the asynchronous read"); } });
    expect(await new TokenStore(f, neverAsync).load()).toBe("gho_abc");
    expect(await new TokenStore(f, box(), { asyncKeyring: true }).load()).toBe("gho_abc");
  });
});

describe("TokenStore.saveAsync on macOS, off the main thread (follow-up to review #241)", () => {
  /** The keyring's synchronous encryptString may not be asked: it would hold Ember while macOS's keychain prompt is open. */
  const asyncBox = (encryptStringAsync: SecretBox["encryptStringAsync"]) => box({ encryptString: () => { throw new Error("encryptString held the main process"); }, encryptStringAsync });
  const sealing = async (s: string) => Buffer.from(`sealed:${s}`);
  /** An encryptStringAsync that answers only when told to (the keychain prompt still open). */
  function slowKeyring() {
    const waiting: { text: string; answer: () => void }[] = [];
    const encryptStringAsync = (text: string) => new Promise<Buffer>(r => waiting.push({ text, answer: () => r(Buffer.from(`sealed:${text}`)) }));
    return { encryptStringAsync, waiting };
  }

  it("seals the sign-in with encryptStringAsync when asked to (main does on macOS), and it reads back either way", async () => {
    const f = file();
    const store = new TokenStore(f, asyncBox(sealing), { asyncKeyring: true });
    expect(await store.saveAsync("gho_abc")).toBe("kept");
    expect(await new TokenStore(f, box()).load()).toBe("gho_abc");
    const grant = { token: "ghu_abc", refreshToken: "ghr_abc", expiresAt: 5, clientId: "Iv23liTEST" };
    expect(await store.saveAsync(grant)).toBe("kept");
    expect(await new TokenStore(f, box()).loadGrant()).toEqual(grant);
  });

  it("gives the sign-in being saved to every read meanwhile, and saves in the order asked", async () => {
    const f = file();
    const slow = slowKeyring();
    const store = new TokenStore(f, box({ encryptString: () => { throw new Error("encryptString held the main process"); }, encryptStringAsync: slow.encryptStringAsync }), { asyncKeyring: true });
    const first = store.saveAsync("gho_first");
    const second = store.saveAsync("gho_second");
    expect(await store.load()).toBe("gho_second");
    await new Promise(r => setTimeout(r, 0));
    // One at a time: the second is sealed once the first is written.
    expect(slow.waiting.map(w => w.text)).toEqual(["gho_first"]);
    slow.waiting[0].answer();
    expect(await first).toBe("kept");
    expect(await store.load()).toBe("gho_second");
    await new Promise(r => setTimeout(r, 0));
    slow.waiting[1].answer();
    expect(await second).toBe("kept");
    expect(await new TokenStore(f, box()).load()).toBe("gho_second");
  });

  it("writes nothing when the user signs out while the keyring is asked", async () => {
    const f = file();
    const slow = slowKeyring();
    const store = new TokenStore(f, box({ encryptStringAsync: slow.encryptStringAsync }), { asyncKeyring: true });
    const saving = store.saveAsync("gho_abc");
    await new Promise(r => setTimeout(r, 0));
    store.clear();
    slow.waiting[0].answer();
    expect(await saving).toBe("write-failed");
    expect(fs.existsSync(f)).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("keeps the sign-in for this run when the keyring refuses (the keychain prompt answered Deny)", async () => {
    const f = file();
    const store = new TokenStore(f, asyncBox(async () => { throw new Error("Error while encrypting the text provided to safeStorage.encryptStringAsync."); }), { asyncKeyring: true });
    expect(await store.saveAsync("gho_abc")).toBe("no-keyring");
    expect(fs.existsSync(f)).toBe(false);
    expect(await store.load()).toBe("gho_abc");
  });

  it("asks the keyring nothing on the main thread, not even whether it is there (isEncryptionAvailable fetches the keychain's key)", async () => {
    const f = file();
    const onMainThread = vi.fn((): never => { throw new Error("asked the keyring on the main thread"); });
    const mac = box({
      isEncryptionAvailable: onMainThread, encryptString: onMainThread, decryptString: onMainThread,
      isAsyncEncryptionAvailable: async () => true, encryptStringAsync: sealing,
      decryptStringAsync: async b => ({ result: b.toString().replace(/^sealed:/, ""), shouldReEncrypt: false }),
    });
    expect(await new TokenStore(f, mac, { asyncKeyring: true }).saveAsync("gho_abc")).toBe("kept");
    // Read back from the file itself (a new store holds nothing in memory).
    expect(await new TokenStore(f, mac, { asyncKeyring: true }).load()).toBe("gho_abc");
    expect(onMainThread).not.toHaveBeenCalled();
  });

  it("writes nothing, and keeps the sign-in for this run, when the keyring can't seal off the main thread or there is none (basic_text)", async () => {
    const encryptStringAsync = vi.fn(sealing);
    const f = file();
    const store = new TokenStore(f, box({ isAsyncEncryptionAvailable: async () => false, encryptStringAsync }), { asyncKeyring: true });
    expect(await store.saveAsync("gho_abc")).toBe("no-keyring");
    expect(fs.existsSync(f)).toBe(false);
    expect(await store.load()).toBe("gho_abc");
    const asked = new TokenStore(file(), box({ isAsyncEncryptionAvailable: async () => { throw new Error("no keychain"); }, encryptStringAsync }), { asyncKeyring: true });
    expect(await asked.saveAsync("gho_abc")).toBe("no-keyring");
    const plain = new TokenStore(file(), box({ getSelectedStorageBackend: () => "basic_text", isAsyncEncryptionAvailable: async () => true, encryptStringAsync }), { asyncKeyring: true });
    expect(await plain.saveAsync("gho_abc")).toBe("no-keyring");
    expect(encryptStringAsync).not.toHaveBeenCalled();
  });

  it("saves as before where it isn't asked to (Linux, Windows) or the keyring has no asynchronous write", async () => {
    const f = file();
    const neverAsync = box({ encryptStringAsync: async () => { throw new Error("asked the asynchronous write"); } });
    expect(await new TokenStore(f, neverAsync).saveAsync("gho_abc")).toBe("kept");
    expect(await new TokenStore(f, box()).load()).toBe("gho_abc");
    expect(await new TokenStore(f, box(), { asyncKeyring: true }).saveAsync("gho_def")).toBe("kept");
    expect(await new TokenStore(f, box()).load()).toBe("gho_def");
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
    expect(execFile).toHaveBeenLastCalledWith("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 3000 }, expect.any(Function));
  });

  it("uses the platform's path and spawn options (no console window on Windows)", async () => {
    answer("gho_fromcli\n");
    expect(await ghCliToken({ path: "C:\\Program Files\\GitHub CLI\\gh.exe", spawn: { windowsHide: true } })).toBe("gho_fromcli");
    expect(execFile).toHaveBeenLastCalledWith("C:\\Program Files\\GitHub CLI\\gh.exe", ["auth", "token", "--hostname", "github.com"], { windowsHide: true, timeout: 3000 }, expect.any(Function));
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
    expect(execFile).toHaveBeenLastCalledWith("/opt/homebrew/bin/gh", ["auth", "token", "--hostname", "github.com"], { timeout: 3000 }, expect.any(Function));
    // A function still stands in for the CLI (tests, as before).
    expect(await resolveToken(null, {}, async () => "gho_fake")).toEqual({ token: "gho_fake", source: "github-cli" });
  });
});
