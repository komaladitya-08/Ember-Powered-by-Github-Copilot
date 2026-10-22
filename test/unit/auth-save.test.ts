/** TokenStore.save and the GitHub CLI lookup (design §4.17): a refused keyring means "sign in again next time", not an error. */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

import { TokenStore, ghCliToken, resolveToken, type SecretBox } from "../../app/main/agent/auth";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-auth-")), "github-token.bin");
const box = (over: Partial<SecretBox> = {}): SecretBox => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed:${s}`),
  decryptString: b => b.toString().replace(/^sealed:/, ""),
  ...over,
});

describe("TokenStore.save", () => {
  it("keeps the token when the keyring works (as before)", () => {
    const f = file();
    const store = new TokenStore(f, box());
    expect(store.save("gho_abc")).toBe(true);
    expect(store.load()).toBe("gho_abc");
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
