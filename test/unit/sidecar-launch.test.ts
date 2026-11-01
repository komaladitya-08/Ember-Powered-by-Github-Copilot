import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AtspiSidecar, ID_BLOCK, type SidecarLaunch } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";
import { fakeFork } from "./utility-fork-fake";

// The real spawn, watched: which command, arguments and options each helper is started with.
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn(real.spawn) };
});

/**
 * A stand-in sidecar run by node: it says how it was started, and (with EMBER_FAKE_COLD_MS) answers nothing until that
 * long after it started, as a cold Windows PowerShell bridge doesn't, but the secret fields handed to it (at once, as
 * the sidecar host does).
 */
const FAKE = `
const readline = require("node:readline");
const cold = Number(process.env.EMBER_FAKE_COLD_MS || 0);
const started = Date.now();
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
let told = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  const ok = result => setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result }), Math.max(0, started + cold - Date.now()));
  switch (req.method) {
    case "whoami": return ok({ argv: process.argv.slice(2), base: process.env.EMBER_ATSPI_ID_BASE, enc: process.env.PYTHONIOENCODING ?? null, mine: process.env.EMBER_FAKE_MINE ?? null, told });
    case "remember_secrets":
      told += req.params.keys.length;
      send({ jsonrpc: "2.0", id: req.id, result: { count: told } });
      if (process.env.EMBER_FAKE_TOLD) require("node:fs").writeFileSync(process.env.EMBER_FAKE_TOLD + "." + process.pid, String(told));
      return;
    case "read_window": return ok({ window: null, nodes: [], secretKeys: [["fake", "1"]] });
    case "slow": return setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: "slow" }), req.params.ms);
    case "status": return ok({ version: 3, python: "fake", toolkitAccessibility: null, apps: 0 });
  }
});
`;

/**
 * The same stand-in as a utility process (macOS, review #177): no stdin; each request comes as a message on Electron's
 * parent port, and answers go to stdout as before.
 */
const FAKE_UTILITY = `
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
process.parentPort.on("message", e => {
  for (const line of String(e.data).split("\\n").filter(Boolean)) {
    const req = JSON.parse(line);
    if (req.method === "whoami") send({ jsonrpc: "2.0", id: req.id, result: { argv: process.argv.slice(2), base: process.env.EMBER_ATSPI_ID_BASE, mine: process.env.EMBER_FAKE_MINE ?? null, pid: process.pid } });
    if (req.method === "slow") setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: "slow" }), req.params.ms);
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-launch-test-"));
const fake = path.join(dir, "fake_host.cjs");
fs.writeFileSync(fake, FAKE);
const fakeUtility = path.join(dir, "fake_utility_host.cjs");
fs.writeFileSync(fakeUtility, FAKE_UTILITY);

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as unknown as Logger;
const running: AtspiSidecar[] = [];
function sidecar(launch?: SidecarLaunch, env: NodeJS.ProcessEnv = process.env) {
  const s = new AtspiSidecar(fake, log, process.execPath, env, launch);
  running.push(s);
  return s;
}
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
  vi.mocked(spawn).mockClear();
});

type Who = { argv: string[]; base: string; enc: string | null; mine: string | null; told: number };
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e.message);

describe("AtspiSidecar's launch", () => {
  it("starts the Python sidecar as it always has when no launch is given", async () => {
    const s = sidecar(undefined, { ...process.env, EMBER_FAKE_MINE: "desk" });
    const who = await s.request<Who>("whoami");
    expect(who.argv).toEqual([]);
    expect(who.enc).toBe("utf-8");
    expect(who.mine).toBe("desk");
    expect(Number(who.base) % ID_BLOCK).toBe(0);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect([command, args]).toEqual([process.execPath, [fake]]);
    expect(Object.keys(options).sort()).toEqual(["env", "stdio"]);
  });

  it("starts the given command with its arguments and environment, plus the id block", async () => {
    const s = sidecar({ command: process.execPath, args: [fake, "--host"], env: { ...process.env, EMBER_FAKE_MINE: "host" } });
    const who = await s.request<Who>("whoami");
    expect(who.argv).toEqual(["--host"]);
    expect(who.mine).toBe("host");
    // Python's variables are the Python sidecar's alone.
    expect(who.enc).toBeNull();
    expect(Number(who.base) % ID_BLOCK).toBe(0);
  });

  it("starts it without a console window where asked (windowsHide)", async () => {
    const s = sidecar({ command: process.execPath, args: [fake], env: process.env, windowsHide: true });
    await s.request("whoami");
    const options = vi.mocked(spawn).mock.calls[0][2] as unknown as Record<string, unknown>;
    expect(options.windowsHide).toBe(true);
  });

  it("gives a new process's requests the first-request time until it answers, then their own (a cold start isn't killed)", async () => {
    const s = sidecar({ command: process.execPath, args: [fake], env: { ...process.env, EMBER_FAKE_COLD_MS: "700" }, firstRequestMs: 3000 });
    // Two requests while it starts: both wait out the cold start, on their own short timeouts they would fail.
    const [a, b] = await Promise.all([s.request<Who>("whoami", {}, 200), s.request<Who>("whoami", {}, 200)]);
    expect(a.base).toBe(b.base);
    // Warm now: its own timeout again.
    expect(await failure(s.request("slow", { ms: 600 }, 200))).toMatch(/did not answer slow in 200 ms/);
  });

  it("keeps the first-request time until a request waited on is answered, not the secrets handed over first", async () => {
    const told = path.join(dir, `told-${Date.now()}`);
    const s = sidecar({ command: process.execPath, args: [fake], env: { ...process.env, EMBER_FAKE_COLD_MS: "1500", EMBER_FAKE_TOLD: told }, firstRequestMs: 5000 });
    await s.readWindow({});
    // Too slow once warm: this process is killed, and the next one starts at once, told the secret field first.
    expect(await failure(s.request("slow", { ms: 9000 }, 200))).toMatch(/did not answer slow in 200 ms/);
    for (let i = 0; i < 100 && !fs.readdirSync(dir).some(f => f.startsWith(path.basename(told) + ".")); i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 50));
    // It answered that at once, but nothing else yet (still cold): a request sent now still has the first-request time.
    const who = await s.request<Who>("whoami", {}, 200);
    expect(who.told).toBe(1);
  });

  it("keeps the request's own timeout from the start without a first-request time", async () => {
    const s = sidecar({ command: process.execPath, args: [fake], env: { ...process.env, EMBER_FAKE_COLD_MS: "700" } });
    expect(await failure(s.request("whoami", {}, 200))).toMatch(/did not answer whoami in 200 ms/);
  });

  it("names the longer time in the error when a cold start runs out of it", async () => {
    const s = sidecar({ command: process.execPath, args: [fake], env: { ...process.env, EMBER_FAKE_COLD_MS: "2000" }, firstRequestMs: 400 });
    expect(await failure(s.request("whoami", {}, 100))).toMatch(/did not answer whoami in 400 ms/);
  });
});

describe("AtspiSidecar's launch as a utility process (macOS: no node mode, review #177)", () => {
  /** Waits until `ok` holds (at most 5 s). */
  const until = async (ok: () => boolean) => { for (let i = 0; i < 250 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); return ok(); };
  type UtilityWho = { argv: string[]; base: string; mine: string | null; pid: number };

  it("forks the host script with its environment and the id block, piped output and its name, and talks to it by message", async () => {
    const f = fakeFork();
    const s = sidecar({ command: "/Applications/Ember.app/Contents/MacOS/Ember", args: [fakeUtility], env: { ...process.env, EMBER_FAKE_MINE: "utility" }, utility: { fork: f.fork, serviceName: "Ember accessibility" } });
    const who = await s.request<UtilityWho>("whoami");
    expect(who.mine).toBe("utility");
    expect(who.argv).toEqual([]);
    expect(Number(who.base) % ID_BLOCK).toBe(0);
    // Nothing is spawned: Ember's binary never runs the host as plain Node.
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
    const [{ modulePath, args, options }] = f.calls;
    expect([modulePath, args]).toEqual([fakeUtility, []]);
    expect(options).toEqual({ env: { ...process.env, EMBER_FAKE_MINE: "utility", EMBER_ATSPI_ID_BASE: who.base }, stdio: "pipe", serviceName: "Ember accessibility" });
    expect(s.pid).toBe(who.pid);
  });

  it("ends one that doesn't answer in time and forks a fresh one for the next request", async () => {
    const f = fakeFork();
    const s = sidecar({ command: "ember", args: [fakeUtility], env: process.env, utility: { fork: f.fork, serviceName: "Ember accessibility" } });
    const first = await s.request<UtilityWho>("whoami");
    expect(await failure(s.request("slow", { ms: 5000 }, 200))).toMatch(/did not answer slow in 200 ms/);
    expect(await until(() => f.calls[0].child.exitCode !== null || f.calls[0].child.signalCode !== null)).toBe(true);
    const second = await s.request<UtilityWho>("whoami");
    expect(second.pid).not.toBe(first.pid);
    expect(second.base).not.toBe(first.base);
  });

  it("ends one stopped before it had started (its kill comes once it has)", async () => {
    const f = fakeFork();
    const s = sidecar({ command: "ember", args: [fakeUtility], env: process.env, utility: { fork: f.fork, serviceName: "Ember accessibility" } });
    const asked = failure(s.request("whoami"));
    s.stop();
    expect(await asked).toMatch(/accessibility helper stopped/);
    expect(await until(() => f.calls[0].child.exitCode !== null || f.calls[0].child.signalCode !== null)).toBe(true);
  });

  it("fails the request, saying why, when the utility process can't be started", async () => {
    const f = fakeFork();
    f.fail("utilityProcess.fork can only be called after app is ready");
    const s = sidecar({ command: "ember", args: [fakeUtility], env: process.env, utility: { fork: f.fork, serviceName: "Ember accessibility" } });
    expect(await failure(s.request("whoami"))).toBe("accessibility helper could not run (utilityProcess.fork can only be called after app is ready)");
    // The next request tries again.
    expect((await s.request<UtilityWho>("whoami")).argv).toEqual([]);
  });
});
