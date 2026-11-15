import { describe, expect, it, vi } from "vitest";
import { recordVaultFill, type VaultFillBarrier } from "../../app/main/vault/fill-barrier";

describe("the vault fill barrier", () => {
  it("waits for native coding to stop and holds new starts until redaction and extension revocation", async () => {
    let finish!: (ok: boolean) => void;
    const sequence: string[] = [];
    const host: VaultFillBarrier = { prepareForVaultFill: () => new Promise(resolve => { finish = resolve; }),
      finishVaultFill: () => { sequence.push("release"); } };
    const note = vi.fn(() => { sequence.push("note"); });
    const pending = recordVaultFill("password", "secret", () => host, note, () => { sequence.push("extensions"); });
    expect(note).not.toHaveBeenCalled();
    finish(true);
    await pending;
    expect(note).toHaveBeenCalledWith("password", "secret");
    expect(sequence).toEqual(["note", "extensions", "release"]);
  });

  it("refuses a failed barrier and releases an acquired hold after a host switch or redactor failure", async () => {
    const note = vi.fn();
    const failed = { prepareForVaultFill: async () => false, finishVaultFill: vi.fn() };
    await expect(recordVaultFill("password", "secret", () => failed, note, () => undefined)).rejects.toThrow();
    expect(note).not.toHaveBeenCalled();
    expect(failed.finishVaultFill).not.toHaveBeenCalled();
    const host = { prepareForVaultFill: async () => true, finishVaultFill: vi.fn() };
    const current = vi.fn().mockReturnValueOnce(host).mockReturnValueOnce(null);
    await expect(recordVaultFill("password", "secret", current, note, () => undefined)).rejects.toThrow();
    expect(host.finishVaultFill).toHaveBeenCalledOnce();
    expect(note).not.toHaveBeenCalled();
    await expect(recordVaultFill("password", "secret", () => host, () => { throw new Error("redactor failed"); }, () => undefined)).rejects.toThrow();
    expect(host.finishVaultFill).toHaveBeenCalledTimes(2);
  });
});
