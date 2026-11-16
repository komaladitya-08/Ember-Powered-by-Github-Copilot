import { expect, it } from "vitest";
import { disposeWindowsLibuvProbe } from "../fixtures/windows-libuv-probe-disposal";

it("does not release shared profiles/IO when the independent host control remains unknown", async () => {
  const calls: string[] = [];
  const unsafe = await disposeWindowsLibuvProbe({ unsafe: true, lpacCreated: false,
    async stopLpac() { calls.push("stop-lpac"); }, async closeFixture() { calls.push("dispose-profile-io"); }, releasePins() { calls.push("release-assets"); } });
  expect(unsafe).toBe(true); expect(calls).toEqual([]);
});

it.each([false, true])("attempts non-disposing shutdown of a known LPAC job and retains every owner despite its result: %s", async failed => {
  const calls: string[] = [];
  const unsafe = await disposeWindowsLibuvProbe({ unsafe: true, lpacCreated: true,
    async stopLpac() { calls.push("stop-lpac"); if (failed) throw new Error("unknown stop"); },
    async closeFixture() { calls.push("dispose-profile-io"); }, releasePins() { calls.push("release-assets"); } });
  expect(unsafe).toBe(true); expect(calls).toEqual(["stop-lpac"]);
});

it("releases assets only after successful ordinary fixture teardown", async () => {
  const calls: string[] = [];
  const unsafe = await disposeWindowsLibuvProbe({ unsafe: false, lpacCreated: true,
    async stopLpac() { calls.push("non-disposing-stop"); }, async closeFixture() { calls.push("complete-fixture-close"); }, releasePins() { calls.push("release-assets"); } });
  expect(unsafe).toBe(false); expect(calls).toEqual(["complete-fixture-close", "release-assets"]);
});

it("retains asset pins when fixture teardown loses its cleanup witness", async () => {
  const calls: string[] = [];
  const unsafe = await disposeWindowsLibuvProbe({ unsafe: false, lpacCreated: true,
    async stopLpac() {}, async closeFixture() { calls.push("fixture-close"); throw new Error("unknown close"); }, releasePins() { calls.push("release-assets"); } });
  expect(unsafe).toBe(true); expect(calls).toEqual(["fixture-close"]);
});

it("does not report success after an asset close becomes uncertain", async () => {
  expect(await disposeWindowsLibuvProbe({ unsafe: false, lpacCreated: false, async stopLpac() {}, async closeFixture() {},
    releasePins() { throw new Error("unknown asset close"); } })).toBe(true);
});
