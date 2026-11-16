import { describe, expect, it } from "vitest";
import { WindowsNodeSourceOwnership, WindowsNodeSourceOwnershipError } from "../fixtures/windows-node-source-ownership";
import { disposeWindowsLibuvProbe } from "../fixtures/windows-libuv-probe-disposal";

describe("source-Node conservative native ownership", () => {
  it("keeps ordinary successful acquisitions and releases admissible", () => {
    const owner = new WindowsNodeSourceOwnership(), calls: string[] = [];
    expect(owner.guard(() => { calls.push("acquire"); return 41; })).toBe(41);
    owner.guard(() => { calls.push("close"); });
    expect(calls).toEqual(["acquire", "close"]); expect(owner.unsafe).toBe(false);
  });
  it.each(["CreateFileW", "CloseHandle", "OpenProcessToken", "writeNewFile", "createProfile", "pinDirectory"])(
    "an ambiguous %s prevents every later acquisition/profile/ancestry release and omits the native cause", operation => {
      const owner = new WindowsNodeSourceOwnership(), calls: string[] = [];
      let error: unknown;
      try { owner.guard(() => { calls.push(operation); throw new Error("private native path and credential"); }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(WindowsNodeSourceOwnershipError); expect(owner.unsafe).toBe(true);
      expect((error as Error).cause).toBeUndefined(); expect(String(error)).not.toMatch(/private|credential/);
      for (const next of ["create", "close image", "delete profile", "release ancestry"])
        expect(() => owner.guard(() => { calls.push(next); })).toThrow(WindowsNodeSourceOwnershipError);
      expect(calls).toEqual([operation]);
    });
  it("still attempts known LPAC stop while refusing resource disposal after uncertain acquisition", async () => {
    const owner = new WindowsNodeSourceOwnership(), calls: string[] = [];
    try { owner.guard(() => { throw new Error("private acquisition failure"); }); } catch { /* Establish the terminal owner. */ }
    expect(await disposeWindowsLibuvProbe({ unsafe: owner.unsafe, lpacCreated: true,
      async stopLpac() { calls.push("stop known root/job"); },
      async closeFixture() { calls.push("delete profile"); }, releasePins() { calls.push("release pins"); },
    })).toBe(true);
    expect(calls).toEqual(["stop known root/job"]);
  });
});
