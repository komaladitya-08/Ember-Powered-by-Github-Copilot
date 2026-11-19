import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExperimentalNamespaceReceipt } from "../../app/main/agent/experimental-stop-receipt";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-stop-receipt-")); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });
const pid = 987654;
const stat = (start = "1234", phase = "S") => `${pid} (bwrap) ${phase} ${Array.from({ length: 18 }, () => "0").join(" ")} ${start} 0`;

async function fixture(extra: Record<string, unknown> = {}) {
  const file = path.join(dir, "receipt.json");
  await fs.writeFile(file, JSON.stringify({ "child-pid": pid, "pid-namespace": 123, "mnt-namespace": 456, ...extra }), { mode: 0o600 });
  const realRead = fs.readFile.bind(fs), realLink = fs.readlink.bind(fs);
  const state = { start: "1234", nspid: `${pid}\t1`, namespace: "pid:[123]", exited: false, denied: false, phase: "S", detached: false, statUnavailable: false };
  const statReads: string[] = [], readRaces: (() => void)[] = [];
  const noTask = () => Object.assign(new Error("task vanished after the proc stat file was opened"), { code: "ESRCH", syscall: "read" });
  vi.spyOn(fs, "readFile").mockImplementation(((name: unknown, ...args: unknown[]) => {
    if (typeof name === "string" && name.startsWith(`/proc/${pid}/`)) {
      if (name.endsWith("/stat")) {
        statReads.push(name);
        const afterOpen = readRaces.shift();
        if (afterOpen) return Promise.resolve().then(afterOpen).then(() => { throw noTask(); });
        if (state.statUnavailable) return Promise.reject(noTask());
      }
      if (state.denied) return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      if (state.exited) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
      return Promise.resolve(name.endsWith("/stat") ? stat(state.start, state.phase) : `NSpid:\t${state.nspid}\n`);
    }
    return Reflect.apply(realRead, fs, [name, ...args]);
  }) as typeof fs.readFile);
  vi.spyOn(fs, "readlink").mockImplementation(((name: unknown, ...args: unknown[]) => {
    if (typeof name === "string" && name.startsWith(`/proc/${pid}/ns/`)) {
      if (state.detached && name.endsWith("/mnt")) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
      return Promise.resolve(name.endsWith("/pid") ? state.namespace : "mnt:[456]");
    }
    return Reflect.apply(realLink, fs, [name, ...args]);
  }) as typeof fs.readlink);
  return { file, state, statReads, raceNextStatRead: (afterOpen: () => void) => { readRaces.push(afterOpen); } };
}

describe.skipIf(process.platform !== "linux")("experimental namespace shutdown receipts", () => {
  it("requires a verified namespace PID1 then accepts only its confirmed disappearance", async () => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file);
    await expect(receipt.requireExited(0)).rejects.toThrow("has not exited");
    f.state.exited = true;
    await expect(receipt.requireExited()).resolves.toBeUndefined();
  });

  it("rejects reused PIDs, changed namespaces and unreadable process state", async () => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file);
    f.state.start = "9999";
    await expect(receipt.requireExited()).rejects.toThrow("reused");
    f.state.start = "1234"; f.state.namespace = "pid:[999]";
    await expect(receipt.requireExited()).rejects.toThrow("identity changed");
    f.state.namespace = "pid:[123]"; f.state.denied = true;
    await expect(receipt.requireExited()).rejects.toThrow("could not be verified");
  });

  it("accepts an exited unreaped namespace init only with its original starttime and detached namespace", async () => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file);
    f.state.phase = "Z";
    await expect(receipt.requireExited(0)).rejects.toThrow("has not exited");
    f.state.detached = true;
    await expect(receipt.requireExited()).resolves.toBeUndefined();
    f.state.start = "9999";
    await expect(receipt.requireExited()).rejects.toThrow("reused");
  });

  it("reopens a proc stat lost during read and requires fresh confirmed disappearance", async () => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file), captured = f.statReads.length;
    f.raceNextStatRead(() => { f.state.exited = true; });
    await expect(receipt.requireExited()).resolves.toBeUndefined();
    expect(f.statReads.slice(captured)).toEqual([`/proc/${pid}/stat`, `/proc/${pid}/stat`]);
  });

  it("accepts a read race only after fresh original-identity zombie and detached-mount evidence", async () => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file);
    f.raceNextStatRead(() => { f.state.phase = "Z"; f.state.detached = true; });
    await expect(receipt.requireExited()).resolves.toBeUndefined();
    vi.useFakeTimers();
    f.raceNextStatRead(() => { f.state.phase = "S"; });
    const pending = expect(receipt.requireExited(40)).rejects.toThrow("has not exited");
    await vi.advanceTimersByTimeAsync(40); await pending;
  });

  it.each(["reused", "namespace", "permission"] as const)("preserves the %s fence after a proc stat open/read race", async changed => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file);
    f.raceNextStatRead(() => {
      if (changed === "reused") f.state.start = "9999";
      if (changed === "namespace") f.state.namespace = "pid:[999]";
      if (changed === "permission") f.state.denied = true;
    });
    await expect(receipt.requireExited()).rejects.toThrow(changed === "reused" ? "reused" : changed === "namespace" ? "identity changed" : "could not be verified");
  });

  it("fails persistent ESRCH inside the original budget instead of treating it as exit proof", async () => {
    const f = await fixture(), receipt = await ExperimentalNamespaceReceipt.capture(f.file), captured = f.statReads.length;
    vi.useFakeTimers(); f.state.statUnavailable = true;
    let settled = false;
    const pending = receipt.requireExited(40).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(39); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(String(await pending)).toContain("shutdown could not be verified");
    expect(f.statReads.slice(captured)).toEqual([`/proc/${pid}/stat`, `/proc/${pid}/stat`]);
  });

  it("never mints an accepted receipt from ESRCH while capturing the initial process identity", async () => {
    const f = await fixture(); f.raceNextStatRead(() => { f.state.exited = true; });
    await expect(ExperimentalNamespaceReceipt.capture(f.file)).rejects.toMatchObject({ code: "ESRCH", syscall: "read" });
  });

  it("rejects malformed receipt schemas and processes that are not namespace init", async () => {
    const f = await fixture();
    f.state.nspid = `${pid}\t2`;
    await expect(ExperimentalNamespaceReceipt.capture(f.file)).rejects.toThrow("init process");
    await fs.writeFile(f.file, JSON.stringify({ "child-pid": pid, "pid-namespace": 123, "mnt-namespace": 456, untrusted: true }));
    await expect(ExperimentalNamespaceReceipt.capture(f.file)).rejects.toThrow();
    await fs.writeFile(f.file, "not JSON");
    await expect(ExperimentalNamespaceReceipt.capture(f.file)).rejects.toThrow();
  });
});
