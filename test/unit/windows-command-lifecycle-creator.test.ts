/** New lifecycle receipts composed with the real profile, native tree and held-root Stop owners. No DLL is loaded. */
import path from "node:path/win32";
import { expect, it, vi } from "vitest";
import {
  WindowsRootOnlyCommandCopy, WindowsRootOnlyCommandCopyCleanupError, requireWindowsCommandRootOnlyCompleted,
  windowsCommandRootOnlyLaunchDirectory, type WindowsRootOnlyCommandCopyFence,
} from "../../app/main/agent/windows-command-copy";
import {
  createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative, type WindowsCommandRootOnlyStopFence,
} from "../../app/main/agent/windows-command-stop";
import {
  bindWindowsCommandCreatorProfileNative, closeWindowsCommandCreatorProfile, windowsCommandCreatorProfile,
} from "../../app/main/agent/windows-command-creator-profile";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { setup, OWNER } from "../fixtures/windows-command-creator-native-fake";

function profile(text: string) {
  const subs = text.split("-").slice(3).map(Number), bytes = Buffer.alloc(8 + 4 * subs.length), calls: string[] = [];
  bytes[0] = 1; bytes[1] = subs.length; bytes[7] = 15;
  subs.forEach((value, index) => bytes.writeUInt32LE(value, 8 + index * 4));
  const ref = bindWindowsCommandCreatorProfileNative({ sizeof: () => 8, decode: () => Buffer.from(bytes) } as unknown as Parameters<typeof bindWindowsCommandCreatorProfileNative>[0], () => ({
    func(prototype) {
      const name = /\b(\w+)\s*\(/.exec(prototype)![1];
      return (...args: unknown[]) => {
        calls.push(name);
        if (name === "CreateAppContainerProfile") { (args[5] as unknown[])[0] = 0x900000n; return 0; }
        if (name === "IsValidSid") return 1;
        if (name === "GetLengthSid") return bytes.length;
        if (name === "DeleteAppContainerProfile") return 0;
        if (name === "FreeSid") return null;
        throw new Error("Unexpected fixed profile declaration.");
      };
    },
  }), { retained: [] }).create();
  return { ref, calls };
}

async function composed(code = 17) {
  const s = setup(), p = profile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(p.ref).sidText;
  const events: string[] = [], root = { process: 50001n, thread: 50002n, pid: 50003 }, closed = new Set<bigint>();
  const stopFence: WindowsCommandRootOnlyStopFence = { retained: [] }, fence: WindowsRootOnlyCommandCopyFence = { retained: [] };
  let assigned = false, ended = false;
  const api = { createJob() { events.push("job"); return 50000n; }, assign() { assigned = true; events.push("assign"); },
    resume() { events.push("resume"); }, terminateProcess() { ended = true; events.push("terminate-root"); },
    terminateJob() { ended = true; events.push("terminate-job"); } } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = {
    configure() { events.push("configure"); }, assertLimits() {},
    state: () => ({ total: assigned ? 1 : 0, active: assigned && !ended ? 1 : 0, pids: assigned && !ended ? [root.pid] : [] }),
    processId: () => root.pid, threadProcessId: () => root.pid, member: () => assigned,
    wait(owner) { if (closed.has(owner)) throw new Error("A closed fixed owner was queried."); return ended ? 0 : 258; },
    close(owner) { if (closed.has(owner)) throw new Error("A fixed owner was closed twice."); closed.add(owner); events.push("closed-native-owner"); },
  };
  const exitCode = vi.fn((process: bigint) => {
    expect(process).toBe(root.process); expect(ended).toBe(true); expect(closed.has(process)).toBe(false);
    events.push("exit-code"); return code;
  });
  const loadExit = vi.fn(() => ({ exitCode }));
  const copy = await WindowsRootOnlyCommandCopy.create({ ...s.input(), creatorProfile: p.ref, packageSid: pkg,
    packageCurrent: () => true, reviewCurrent: () => true }, {
    api, fence, createTree: input => s.binding.createFreshWindowsCommandTree(input),
    createStopOwner: binding => createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, stopFence, loadExit),
  });
  const run = await copy.launchRootOnlyWithContext(context => {
    expect(windowsCommandRootOnlyLaunchDirectory(context)).toBe(s.root().name); events.push("create"); return root;
  }, () => { events.push("attest"); });
  const created = s.add(path.join(s.root().name, "created.txt"), "file", Buffer.from("fixed created bytes"),
    { owner: s.control.tokenOwner, aclOwner: OWNER, package: pkg, inherited: true, low: true });
  const originalSet = s.handlers.NtSetSecurityObject;
  s.handlers.NtSetSecurityObject = (...args) => {
    if (Number(args[1]) & 1) {
      expect(closed.size).toBe(3); events.push("normalise-owner");
    }
    return originalSet(...args);
  };
  const finish = async () => {
    await copy.close(); closeWindowsCommandCreatorProfile(p.ref);
    expect(s.handles.size).toBe(0); expect(p.calls.filter(name => name === "DeleteAppContainerProfile")).toHaveLength(1);
    expect(p.calls.filter(name => name === "FreeSid")).toHaveLength(1);
  };
  return { s, p, pkg, root, copy, run, fence, stopFence, events, closed, exitCode, loadExit, created, finish,
    end() { ended = true; } };
}

it("issues a genuine nonzero natural completion only after held-root query, creator capture, Stop and owner-normalising revoke", async () => {
  const v = await composed(); v.end();
  const completed = await v.copy.completeRootOnly(v.run, new AbortController().signal);
  const facts = requireWindowsCommandRootOnlyCompleted(completed, v.run);
  expect(facts).toEqual({ outcome: "natural-exit", exitCode: 17 }); expect(Object.isFrozen(facts)).toBe(true);
  expect(v.loadExit).toHaveBeenCalledTimes(1); expect(v.exitCode).toHaveBeenCalledTimes(1);
  expect(v.events.indexOf("exit-code")).toBeLessThan(v.events.indexOf("closed-native-owner"));
  expect(v.events.filter(event => event === "closed-native-owner")).toHaveLength(3);
  expect(v.events.filter(event => event === "normalise-owner")).toHaveLength(1); expect(v.events).not.toContain("terminate-root");
  expect(v.created.security.owner).toBe(OWNER); expect(v.created.security.package).toBeUndefined();
  expect(v.s.calls.filter(call => call.name === "GetTokenInformation" && call.args[1] !== 1).map(call => call.args[1])).toEqual([31, 4]);
  await v.copy.files(async entries => {
    expect(entries.find(entry => entry.path === "created.txt")).toMatchObject({ kind: "file", bytes: Buffer.from("fixed created bytes") });
  });
  expect(v.s.objects.get("C:\\source\\input.ts")?.bytes.toString()).toBe("source remains untouched");
  await v.finish();
});

it("cancellation wakes the observer and yields null exit only after the same captured creator grant is revoked", async () => {
  const v = await composed(), abort = new AbortController(), pending = v.copy.completeRootOnly(v.run, abort.signal);
  await new Promise<void>(resolve => setImmediate(resolve)); abort.abort();
  const completed = await pending;
  expect(requireWindowsCommandRootOnlyCompleted(completed, v.run)).toEqual({ outcome: "cancelled", exitCode: null });
  expect(v.loadExit).not.toHaveBeenCalled(); expect(v.exitCode).not.toHaveBeenCalled();
  expect(v.events).toContain("terminate-root"); expect(v.closed.size).toBe(3); expect(v.events).toContain("normalise-owner");
  expect(v.created.security.owner).toBe(OWNER); expect(v.created.security.package).toBeUndefined();
  let observed = false; await v.copy.review(async entries => { observed = true; expect(entries.some(entry => entry.path === "created.txt")).toBe(true); });
  expect(observed).toBe(true); await v.finish();
});

it("never issues completion after uncertain owner normalisation and retains the private first-failure barrier", async () => {
  const v = await composed(), set = v.s.handlers.NtSetSecurityObject; v.end();
  v.s.handlers.NtSetSecurityObject = (...args) => { if (Number(args[1]) & 1) throw new Error("PRIVATE normalisation uncertainty"); return set(...args); };
  const pending = v.copy.completeRootOnly(v.run, new AbortController().signal);
  const error: unknown = await pending.catch(error => error as unknown);
  expect(error).toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError); expect(String(error)).not.toContain("PRIVATE");
  expect(() => requireWindowsCommandRootOnlyCompleted(error, v.run)).toThrow(); expect(v.exitCode).toHaveBeenCalledTimes(1); expect(v.closed.size).toBe(3);
  expect(v.s.control.dataReads).toBe(0); expect(v.s.fence.retained.length).toBeGreaterThan(0); expect(v.fence.retained.length).toBeGreaterThan(0);
  const calls = v.s.calls.length, events = [...v.events]; v.fence.failure = undefined; v.s.fence.failure = undefined; v.stopFence.failure = undefined;
  for (const work of [() => v.copy.completeRootOnly(v.run, new AbortController().signal), () => v.copy.files(async () => { throw new Error("Must not read"); }),
    () => v.copy.stop(), () => v.copy.close()]) {
    expect(await work().catch(error => error as unknown)).toBe(error);
  }
  expect(v.s.calls).toHaveLength(calls); expect(v.events).toEqual(events);
  expect(v.p.calls).not.toContain("DeleteAppContainerProfile"); expect(v.p.calls).not.toContain("FreeSid");
});
