import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AtspiSidecar, ID_BLOCK, type SidecarLaunch } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";

// The real spawn, watched: which command, arguments and options each helper is started with.
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn(real.spawn) };
});

/**
 * A stand-in sidecar run by node: it says how it was started, and (with EMBER_FAKE_COLD_MS) answers nothing until that
 * long after it started, as a cold Windows PowerShell bridge doesn't.
 */
const FAKE = `
const readline = require("node:readline");
const cold = Number(process.env.EMBER_FAKE_COLD_MS || 0);
const started = Date.now();
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  const ok = result => setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result }), Math.max(0, started + cold - Date.now()));
  switch (req.method) {
    case "whoami": return ok({ argv: process.argv.slice(2), base: process.env.EMBER_ATSPI_ID_BASE, enc: process.env.PYTHONIOENCODING ?? null, mine: process.env.EMBER_FAKE_MINE ?? null });
    case "slow": return setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: "slow" }), req.params.ms);
    case "status": return ok({ version: 3, python: "fake", toolkitAccessibility: null, apps: 0 });
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-launch-test-"));
const fake = path.join(dir, "fake_host.cjs");
fs.writeFileSync(fake, FAKE);

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

type Who = { argv: string[]; base: string; enc: string | null; mine: string | null };
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

  it("keeps the request's own timeout from the start without a first-request time", async () => {
    const s = sidecar({ command: process.execPath, args: [fake], env: { ...process.env, EMBER_FAKE_COLD_MS: "700" } });
    expect(await failure(s.request("whoami", {}, 200))).toMatch(/did not answer whoami in 200 ms/);
  });

  it("names the longer time in the error when a cold start runs out of it", async () => {
    const s = sidecar({ command: process.execPath, args: [fake], env: { ...process.env, EMBER_FAKE_COLD_MS: "2000" }, firstRequestMs: 400 });
    expect(await failure(s.request("whoami", {}, 100))).toMatch(/did not answer whoami in 400 ms/);
  });
});
