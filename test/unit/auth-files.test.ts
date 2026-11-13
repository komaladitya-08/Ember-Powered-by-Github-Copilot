/**
 * File trouble during sign-in and start (review #141, #89): a token file that can't be written doesn't throw away a
 * completed sign-in, and a file error that isn't the runtime's isn't reported as "the runtime is missing, reinstall".
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenStore, resolveToken, type SecretBox } from "../../app/main/agent/auth";
import { readAgentState, writeAgentState } from "../../app/main/agent/conductor";
import { explainStartError, startErrorReason } from "../../app/main/agent/host";

const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`sealed:${s}`), decryptString: b => b.toString().replace(/^sealed:/, "") };
const TOKEN = "gho_" + "f".repeat(36); // not a real token

describe("clearing the sign-in (reliability-r9-2)", () => {
  const saved = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tok-"));
    const file = path.join(dir, "github-token.bin");
    const store = new TokenStore(file, box);
    expect(store.save(TOKEN)).toBe(true);
    return { dir, file, store };
  };

  it("says so when the saved sign-in couldn't be removed, and never reads it again in this run", async () => {
    const { file, store } = saved();
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw Object.assign(new Error("EROFS: read-only file system, unlink"), { code: "EROFS" }); });
    try {
      expect(store.clear()).toBe(false);
      expect(store.uncleared).toBe(true);
      expect(fs.existsSync(file)).toBe(true);
      expect(await store.load()).toBeNull();
      expect(await resolveToken(store, {}, async () => null)).toBeNull();
    } finally { rm.mockRestore(); }
    // The disk can be written again: the next read removes it, and still gives nothing.
    expect(await store.load()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.uncleared).toBe(false);
  });

  it("removes it, and says so, on a disk that can be written; none saved is cleared too", () => {
    const { file, store } = saved();
    expect(store.clear()).toBe(true);
    expect(store.uncleared).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.clear()).toBe(true);
  });

  it("a new sign-in after it is read as ever", async () => {
    const { store } = saved();
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("EROFS"); });
    try { expect(store.clear()).toBe(false); } finally { rm.mockRestore(); }
    const other = "gho_" + "e".repeat(36);
    expect(store.save(other)).toBe(true);
    expect(store.uncleared).toBe(false);
    expect(await store.load()).toBe(other);
  });

  // Root ignores file modes, and Windows has no such folder mode: the real thing, where it can be had.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is not removed from a folder that can't be written, for real", async () => {
    const { dir, file, store } = saved();
    fs.chmodSync(dir, 0o500);
    try {
      expect(store.clear()).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
      expect(await store.load()).toBeNull();
    } finally { fs.chmodSync(dir, 0o700); }
    expect(await store.load()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("agent.json (reliability-r9-2)", () => {
  it("is written whole or not at all: through a temporary file renamed over it, owner-only, leaving nothing behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-state-"));
    const file = path.join(dir, "agent.json");
    writeAgentState(file, { conductorSessionId: "ember-conductor-1" });
    const rename = vi.spyOn(fs, "renameSync");
    try {
      writeAgentState(file, { signedOut: true });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(rename.mock.calls[0][1]).toBe(file);
      // A write that fails throws, and the file is as it was.
      rename.mockImplementation(() => { throw new Error("EROFS"); });
      expect(() => writeAgentState(file, { signedOut: false })).toThrow();
    } finally { rename.mockRestore(); }
    expect(readAgentState(file)).toEqual({ conductorSessionId: "ember-conductor-1", signedOut: true });
    expect(fs.readdirSync(dir)).toEqual(["agent.json"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    writeAgentState(file, { conductorSessionId: undefined, signedOut: false });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("saving the sign-in", () => {
  it("answers false instead of throwing when the file can't be written (a missing, full or read-only folder)", () => {
    const store = new TokenStore(path.join(os.tmpdir(), `ember-nope-${process.pid}-${Date.now()}`, "github-token.bin"), box);
    expect(() => store.save(TOKEN)).not.toThrow();
    expect(store.save(TOKEN)).toBe(false);
    expect(store.saveResult(TOKEN)).toBe("write-failed");
  });

  it("says why it wasn't kept: no keyring, or the write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tok-"));
    expect(new TokenStore(path.join(dir, "t.bin"), { ...box, getSelectedStorageBackend: () => "basic_text" }).saveResult(TOKEN)).toBe("no-keyring");
    expect(new TokenStore(path.join(dir, "t.bin"), { ...box, encryptString: () => { throw new Error("denied"); } }).saveResult(TOKEN)).toBe("no-keyring");
    expect(new TokenStore(path.join(dir, "t.bin"), box).saveResult(TOKEN)).toBe("kept");
  });

  it("writes the whole file or nothing (a crash mid-write leaves no truncated token), owner-only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tok-"));
    const file = path.join(dir, "github-token.bin");
    fs.writeFileSync(file, "sealed:gho_old");
    const store = new TokenStore(file, box);
    expect(store.save(TOKEN)).toBe(true);
    expect(await store.load()).toBe(TOKEN);
    expect(fs.readdirSync(dir)).toEqual(["github-token.bin"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("a file error while connecting", () => {
  const fsError = (code: string, text: string, syscall: string, p: string) => Object.assign(new Error(`${code}: ${text}, ${syscall} '${p}'`), { code });

  it("names the file, and isn't the runtime's fault", () => {
    const e = fsError("ENOENT", "no such file or directory", "open", "/home/ana/.config/ember/agent.json");
    expect(explainStartError(e)).not.toMatch(/runtime is missing|Reinstall/);
    expect(explainStartError(e)).toContain("/home/ana/.config/ember/agent.json");
    expect(startErrorReason(e)).toBe("other");
    const denied = fsError("EACCES", "permission denied", "mkdir", "/home/ana/.config/ember/copilot");
    expect(explainStartError(denied)).toMatch(/isn't allowed to use \/home\/ana\/\.config\/ember\/copilot/);
    expect(startErrorReason(denied)).toBe("other");
    expect(explainStartError(fsError("ENOSPC", "no space left on device", "write", "/home/ana/.config/ember/agent.json"))).toMatch(/full/);
    expect(explainStartError(fsError("EROFS", "read-only file system", "open", "/home/ana/.config/ember/agent.json"))).toMatch(/read-only/);
  });

  it("is the runtime's when starting it failed, or the file is the runtime itself", () => {
    expect(explainStartError(new Error("spawn /opt/ember/resources/copilot ENOENT"))).toMatch(/runtime is missing/);
    expect(startErrorReason(new Error("spawn /opt/ember/resources/copilot EACCES"))).toBe("runtime");
    expect(explainStartError(new Error("Copilot CLI not found at /opt/ember/resources/copilot"))).toMatch(/runtime is missing/);
    const inRuntime = fsError("ENOENT", "no such file or directory", "stat", "/opt/ember/resources/copilot/index.js");
    expect(explainStartError(inRuntime, { runtime: "/opt/ember/resources/copilot" })).toMatch(/runtime is missing/);
    expect(startErrorReason(inRuntime, { runtime: "/opt/ember/resources/copilot" })).toBe("runtime");
  });
});
