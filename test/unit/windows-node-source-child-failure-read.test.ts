import { expect, it } from "vitest";
import { readStoppedWindowsNodeSourceChildFailure, WindowsNodeSourceChildFailureReadCleanupError } from "../fixtures/windows-node-source-child-failure-read";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";
import { disposeWindowsLibuvProbe } from "../fixtures/windows-libuv-probe-disposal";
const frame = () => {
  const bytes = Buffer.alloc(48); [0x46434e45, 1, 1, 1, 3, 1, 1, 0, 22023005, 0, 0, 0].forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  bytes.writeInt32LE(-4092, 28); return bytes;
};
it("reads only the literal role/mode48B file between positive stopped-owner witnesses and wipes its raw bytes", () => {
  const calls: string[] = [], bytes = frame();
  const result = readStoppedWindowsNodeSourceChildFailure({ role: 1, mode: "spawn", requireStopped() { calls.push("stopped"); },
    readFrame(name, maximum) { calls.push("pinned-read"); expect(name).toBe("lpac-source-child-1-failure.bin"); expect(maximum).toBe(48); return bytes; } });
  expect(calls).toEqual(["stopped", "pinned-read", "stopped"]);
  expect(result).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 3, code: 1, errno: -4092 });
  expect(Object.isFrozen(result)).toBe(true); expect(bytes.equals(Buffer.alloc(48))).toBe(true);
});
it.each(["absent", "short", "magic", "enum", "ordinary-read-refusal"])("keeps content-only %s unknown without inventing cleanup uncertainty", async mode => {
  const bytes = mode === "short" ? Buffer.alloc(47) : frame();
  if (mode === "magic") bytes.writeUInt32LE(0);
  if (mode === "enum") bytes.writeUInt32LE(17, 20);
  const result = readStoppedWindowsNodeSourceChildFailure({ role: 1, mode: "spawn", requireStopped() {}, readFrame() {
    if (mode === "ordinary-read-refusal") throw new Error("fixed ordinary-file refusal after known FD close"); return mode === "absent" ? null : bytes;
  } });
  expect(result).toBeNull();
  const calls: string[] = [];
  expect(await disposeWindowsLibuvProbe({ unsafe: false, lpacCreated: true, async stopLpac() { calls.push("stop"); }, async closeFixture() { calls.push("close"); }, releasePins() { calls.push("pins"); } })).toBe(false);
  expect(calls).toEqual(["close", "pins"]);
});
it.each(["before", "after", "async-witness"])("forbids readout and revokes disposal if the %s stopped-owner proof is unavailable", async mode => {
  const bytes = frame(); let witnesses = 0, reads = 0, error: unknown;
  try { readStoppedWindowsNodeSourceChildFailure({ role: 1, mode: "spawn", requireStopped() {
    witnesses++; if (mode === "before" || mode === "after" && witnesses === 2) throw new Error("private stopped owner");
    return mode === "async-witness" ? Promise.resolve() : undefined;
  }, readFrame() { reads++; return bytes; } }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WindowsNodeSourceChildFailureReadCleanupError); expect(reads).toBe(mode === "after" ? 1 : 0);
  if (mode === "after") expect(bytes.equals(Buffer.alloc(48))).toBe(true);
  const calls: string[] = [];
  expect(await disposeWindowsLibuvProbe({ unsafe: error instanceof WindowsNodeHostCleanupError, lpacCreated: true,
    async stopLpac() { calls.push("non-disposing-stop"); }, async closeFixture() { calls.push("close"); }, releasePins() { calls.push("pins"); } })).toBe(true);
  expect(calls).toEqual(["non-disposing-stop"]);
});
it.each(["pin", "read-close"])("preserves authoritative %s uncertainty and never upgrades it to a malformed-content refusal", fault => {
  const error = new WindowsNodeHostCleanupError(); let caught: unknown;
  try { readStoppedWindowsNodeSourceChildFailure({ role: 1, mode: "spawn", requireStopped() {}, readFrame() { throw error; } }); } catch (value) { caught = value; }
  expect(caught, fault).toBe(error);
});
it("preserves an existing terminal stopped-owner error before any file acquisition", () => {
  const error = new WindowsNodeHostCleanupError(); let caught: unknown, reads = 0;
  try { readStoppedWindowsNodeSourceChildFailure({ role: 1, mode: "spawn", requireStopped() { throw error; }, readFrame() { reads++; return frame(); } }); } catch (value) { caught = value; }
  expect(caught).toBe(error); expect(reads).toBe(0);
});
