import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { POWERSHELL, UiaBridge, bridgeArgs } from "../integration/uia-client";

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: boundary.spawn }));

const marker = (stage: number) => `EMBER_UIA_STARTUP_V1:${stage}\n`;
const children: EventEmitter[] = [];

/** Only the process boundary is modeled; stderr and stdout use the client's real stream listeners. */
function create(env: NodeJS.ProcessEnv = { EMBER_UIA_STARTUP_OBSERVE: "1" }, ready = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  });
  boundary.spawn.mockReturnValue(child);
  const bridge = new UiaBridge("C:\\Ember\\sidecar\\uia\\ember_uia.ps1", env);
  void bridge.ready.catch(() => undefined);
  children.push(child);
  if (ready) child.stdout.write('{"ready":true,"version":1}\n');
  return { child, bridge };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.emit("exit", 0);
    child.emit("close");
  }
  vi.clearAllMocks();
});

describe("cached UIA startup observations", () => {
  it("accepts every known complete ASCII stage, CRLF and unrelated stderr without exposing text", () => {
    const { bridge, child } = create();
    for (let stage = 1; stage <= 25; stage++) {
      child.stderr.write(`private unrelated diagnostic\nEMBER_UIA_STARTUP_V1:${stage}\r\n`);
      expect(bridge.startupStage).toBe(stage);
    }
    child.stderr.write("private unfinished unrelated diagnostic");
    expect(bridge.startupStage).toBe(25);
    expect(bridge.strayLines).toEqual([]);
  });

  it("uses the last terminated marker and accepts repeated stages without inventing monotonic authority", () => {
    const { bridge, child } = create();
    child.stderr.write(marker(1) + marker(25) + marker(25) + marker(2));
    expect(bridge.startupStage).toBe(2);
    expect(bridge.startupStage).toBe(2);
  });

  it.each([
    "0", "26", "01", "+1", "1.0", "", "NaN", "Infinity", "１", "25 private", "25\r\r", "25\u2028", "25\0",
  ])("refuses a malformed or out-of-range stage %j even after a valid marker", stage => {
    const { bridge, child } = create();
    child.stderr.write(marker(1) + `EMBER_UIA_STARTUP_V1:${stage}\n`);
    expect(bridge.startupStage).toBe(0);
  });

  it.each([
    " EMBER_UIA_STARTUP_V1:2\n", "\tEMBER_UIA_STARTUP_V1:2\n", "private EMBER_UIA_STARTUP_V1:2\n",
    "EMBER_UIA_STARTUP_V2:2\n", "EMBER_UIA_STARTUP_V1:2", "EMBER_UIA_STARTUP_V1:25\r",
    "EMBER_UIA_STARTUP_V1:", "EMBER_UIA_STARTUP", "EMBER_UIA_", "EMB",
  ])("refuses malformed, embedded or incomplete marker lines %j", line => {
    const { bridge, child } = create();
    child.stderr.write(marker(1) + line);
    expect(bridge.startupStage).toBe(0);
  });

  it("joins arbitrary stderr chunks but never mistakes a partial digit or prefix for a complete stage", () => {
    const { bridge, child } = create();
    child.stderr.write("EMBER_UIA_STARTUP_V1:2");
    expect(bridge.startupStage).toBe(0);
    child.stderr.write("5\r");
    expect(bridge.startupStage).toBe(0);
    child.stderr.write("\n");
    expect(bridge.startupStage).toBe(25);
    child.stderr.write("EMBER_UIA_");
    expect(bridge.startupStage).toBe(0);
    child.stderr.write("STARTUP_V1:24\n" + marker(25));
    expect(bridge.startupStage).toBe(25);
  });

  it.each([undefined, "0", "true", " 1", "1 ", "01"])("requires the exact opt-in value, received %j", value => {
    const { bridge, child } = create({ EMBER_UIA_STARTUP_OBSERVE: value });
    child.stderr.write(marker(25));
    expect(bridge.startupStage).toBe(0);
  });

  it("does not accept a differently cased environment key or read cached stderr when disabled", () => {
    const { bridge } = create({ ember_uia_startup_observe: "1" });
    const read = vi.fn(() => { throw new Error("private stderr must not be read"); });
    Object.defineProperty(bridge, "stderr", { get: read });
    expect(bridge.startupStage).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("captures the opt-in once without changing the executable, arguments, environment or listeners", () => {
    const env = { EMBER_UIA_STARTUP_OBSERVE: "1", TEMP: "C:\\private-temp" };
    const { bridge, child } = create(env);
    expect(boundary.spawn).toHaveBeenCalledExactlyOnceWith(POWERSHELL,
      bridgeArgs("C:\\Ember\\sidecar\\uia\\ember_uia.ps1"), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    const listeners = child.stderr.listeners("data");
    env.EMBER_UIA_STARTUP_OBSERVE = "0";
    child.stderr.write(marker(25));
    expect(bridge.startupStage).toBe(25);
    expect(bridge.startupStage).toBe(25);
    expect(child.stderr.listeners("data")).toEqual(listeners);
    expect(listeners).toHaveLength(1);
  });

  it("bounds the whole cached input by UTF-8 bytes, including unrelated stderr", () => {
    const { bridge } = create();
    const suffix = "\n" + marker(25);
    bridge.stderr = "x".repeat(128 * 1024 - suffix.length) + suffix;
    expect(bridge.startupStage).toBe(25);
    bridge.stderr += "x";
    expect(bridge.startupStage).toBe(0);
    bridge.stderr = "é".repeat(64 * 1024) + suffix;
    expect(bridge.startupStage).toBe(0);
  });

  it("contains diagnostic projection failures and never coerces non-string cached values", () => {
    const { bridge } = create();
    const value = { toString: vi.fn(() => { throw new Error("private conversion failure"); }) };
    Object.defineProperty(bridge, "stderr", { configurable: true, value });
    expect(bridge.startupStage).toBe(0);
    expect(value.toString).not.toHaveBeenCalled();
    Object.defineProperty(bridge, "stderr", { get: () => { throw new Error("private cached getter failure"); } });
    expect(bridge.startupStage).toBe(0);
  });

  it("does not settle ready from stderr or change the existing stdout ready and stray-line handling", async () => {
    const { bridge, child } = create(undefined, false);
    let settled = false;
    void bridge.ready.then(() => { settled = true; });
    child.stderr.write(marker(25));
    expect(bridge.startupStage).toBe(25);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.write('existing non-JSON line\n{"ready":true,"version":1}\n');
    await expect(bridge.ready).resolves.toEqual({ ready: true, version: 1 });
    expect(bridge.strayLines).toEqual(["existing non-JSON line"]);
  });

  it("preserves an existing fatal first JSON rejection", async () => {
    const { bridge, child } = create(undefined, false);
    child.stderr.write(marker(7));
    child.stdout.write('{"fatal":"existing fatal"}\n');
    await expect(bridge.ready).rejects.toThrow('the bridge did not start: {"fatal":"existing fatal"}');
    expect(bridge.startupStage).toBe(7);
  });
});
