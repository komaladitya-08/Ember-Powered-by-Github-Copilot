/**
 * File trouble during sign-in and start (review #141, #89): a token file that can't be written doesn't throw away a
 * completed sign-in, and a file error that isn't the runtime's isn't reported as "the runtime is missing, reinstall".
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenStore, type SecretBox } from "../../app/main/agent/auth";
import { explainStartError, startErrorReason } from "../../app/main/agent/host";

const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`sealed:${s}`), decryptString: b => b.toString().replace(/^sealed:/, "") };
const TOKEN = "gho_" + "f".repeat(36); // not a real token

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

  it("writes the whole file or nothing (a crash mid-write leaves no truncated token), owner-only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tok-"));
    const file = path.join(dir, "github-token.bin");
    fs.writeFileSync(file, "sealed:gho_old");
    const store = new TokenStore(file, box);
    expect(store.save(TOKEN)).toBe(true);
    expect(store.load()).toBe(TOKEN);
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
