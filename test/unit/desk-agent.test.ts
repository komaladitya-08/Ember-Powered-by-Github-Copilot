/**
 * Ember's side of the desk helper, with a stand-in helper (no X needed):
 * synchronous calls, later answers, and what happens when the helper exits,
 * hangs, can't start or is stopped. Ember itself must always carry on.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESK_STOPPED, DeskAgent, deskInput, deskSnapshot } from "../../app/main/desk/agent";
import { running } from "../../app/main/desk/desk";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-agent-test-"));
const helper = path.join(dir, "helper.cjs");
fs.writeFileSync(helper, `
const calls = { input: ["move", "pointer", "fail", "die", "hang", "releaseAll"], view: ["snapshot"] };
const released = [];
process.on("message", r => {
  const reply = v => process.send({ id: r.id, ...(r.async ? { async: true } : {}), ...v });
  if (r.m === "move") reply({ v: null });
  else if (r.m === "pointer") reply({ v: { x: 1, y: 2, env: process.env.HELPER_TEST, node: !!process.env.ELECTRON_RUN_AS_NODE } });
  else if (r.m === "fail") reply({ e: "no such window" });
  else if (r.m === "die") process.exit(3);
  else if (r.m === "hang") { /* never answers */ }
  else if (r.m === "releaseAll") { released.push(1); reply({ v: released.length }); }
  else if (r.m === "snapshot") setTimeout(() => reply({ v: { jpeg: Buffer.from("jpeg!"), width: 4, height: 3, title: "t" } }), 20);
});
process.on("disconnect", () => process.exit(0));
if (process.env.HELPER_TEST === "refuse") process.send({ ready: false, error: "couldn't open the desk display" }, () => process.exit(1));
else process.send({ ready: true, calls });
`);
const env = { HELPER_TEST: "yes", PATH: process.env.PATH };
const until = async (cond: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10)); return cond(); };

describe("desk helper", () => {
  const agents: DeskAgent[] = [];
  const start = async (o: { timeoutMs?: number } = {}) => { const a = await DeskAgent.start(helper, env, o); agents.push(a); return a; };
  afterAll(() => { for (const a of agents) a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("answers calls before they return, and later ones without Ember waiting", async () => {
    const a = await start();
    expect(a.pid).toBeGreaterThan(0);
    expect(a.calls.input).toContain("move");
    // Only what it was given, and run as plain Node.
    expect(a.call("input", "pointer")).toEqual({ x: 1, y: 2, env: "yes", node: true });
    expect(() => a.call("input", "fail")).toThrow("no such window");
    const shot = await deskSnapshot(a, 320, 60);
    expect(shot && Buffer.isBuffer(shot.jpeg) && shot.jpeg.toString()).toBe("jpeg!");
    // A facade with the helper's methods; close() lets go of what is held there.
    const input = deskInput(a);
    expect(input.pointer()).toMatchObject({ x: 1, y: 2 });
    expect("hang" in input).toBe(true);
    input.close();
    expect(a.call("input", "releaseAll")).toBe(2);
    // About a fraction of a millisecond a call.
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) a.call("input", "move", [i, i]);
    const us = Number(process.hrtime.bigint() - t0) / 200 / 1000;
    expect(us).toBeLessThan(5000);
  });

  it("counts as gone when the helper exits, and tells Ember once (Ember carries on)", async () => {
    const a = await start();
    const why: string[] = [];
    a.onExit(w => why.push(w));
    const later = a.request("view", "snapshot", [1, 1]);
    expect(() => a.call("input", "die")).toThrow(DESK_STOPPED);
    expect(a.alive).toBe(false);
    expect(() => a.call("input", "move", [1, 1])).toThrow(DESK_STOPPED);
    await expect(later).rejects.toThrow(DESK_STOPPED);
    expect(await until(() => why.length > 0)).toBe(true);
    expect(why).toEqual([expect.stringMatching(/helper exited \(3\)/)]);
  });

  it("ends a helper that stops answering instead of hanging Ember", async () => {
    const a = await start({ timeoutMs: 300 });
    const why: string[] = [];
    a.onExit(w => why.push(w));
    const t0 = Date.now();
    expect(() => a.call("input", "hang")).toThrow(DESK_STOPPED);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await until(() => why.length > 0)).toBe(true);
    expect(why[0]).toMatch(/stopped answering/);
    expect(await until(() => !running(a.pid))).toBe(true);
  });

  it("stops quietly: no more calls, no exit report, the helper gone", async () => {
    const a = await start();
    const why: string[] = [];
    a.onExit(w => why.push(w));
    a.stop();
    expect(() => a.call("input", "move", [1, 1])).toThrow(DESK_STOPPED);
    expect(await until(() => !running(a.pid))).toBe(true);
    await new Promise(r => setTimeout(r, 100));
    expect(why).toEqual([]);
  });

  it("fails to start with the helper's reason, or when there is no helper", async () => {
    await expect(DeskAgent.start(helper, { ...env, HELPER_TEST: "refuse" })).rejects.toThrow(/couldn't open the desk display/);
    await expect(DeskAgent.start(path.join(dir, "missing.cjs"), env)).rejects.toThrow(/exited/);
  });
});
