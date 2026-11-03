/** Real-time safety budget, run serially without the parallel unit suite competing for the event loop/disk. */
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KillSwitch } from "../../app/main/agent/killswitch";
import { AuditLog } from "../../app/main/policy/audit";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

it("returns within the real-time stop budget even if one part hangs, including audit I/O", async () => {
  const audit = new AuditLog(fs.mkdtempSync(path.join(os.tmpdir(), "ember-stop-deadline-")));
  const order: string[] = [];
  const ks = new KillSwitch(() => [
    { name: "borrow", stop: () => { order.push("borrow"); } },
    { name: "agent", stop: () => new Promise(() => { order.push("agent"); }) },
    { name: "speech", stop: () => { order.push("speech"); throw new Error("no speaker"); } },
    { name: "motion", stop: async () => { order.push("motion"); } },
  ], quiet, () => audit);
  const started = performance.now();
  const pulled = ks.pull("hotkey");
  expect(order).toEqual(["borrow", "agent", "speech", "motion"]);
  const result = await pulled;
  const elapsed = performance.now() - started;
  // Keep the original 400 ms wall-clock ceiling, and check the separately measured stop wait too.
  expect(elapsed).toBeLessThan(400);
  expect(result.ms).toBeLessThan(400);
  expect(result.late).toEqual(["agent"]);
  expect(audit.recent(1)[0]).toMatchObject({ event: "stop", source: "hotkey", ms: result.ms });
});

it("returns promptly in real time when every part stops", async () => {
  const result = await new KillSwitch(() => [
    { name: "a", stop: () => undefined }, { name: "b", stop: async () => undefined },
  ], quiet).pull("voice");
  expect(result.ms).toBeLessThan(50);
  expect(result.late).toEqual([]);
});
