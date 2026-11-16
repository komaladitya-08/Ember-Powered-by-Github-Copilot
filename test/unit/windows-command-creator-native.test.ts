/** Real coordinator, native tree and Stop-owner composition through fixed fake DLL boundaries; no Windows API runs. */
import path from "node:path/win32";
import { expect, it } from "vitest";
import { WindowsRootOnlyCommandCopy } from "../../app/main/agent/windows-command-copy";
import { WindowsCommandCopyCleanupError, type WindowsCommandCreatorGrantRef } from "../../app/main/agent/windows-command-copy-native";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative } from "../../app/main/agent/windows-command-stop";
import { bindWindowsCommandCreatorProfileNative, closeWindowsCommandCreatorProfile, windowsCommandCreatorProfile, type WindowsCommandCreatorProfileRef } from "../../app/main/agent/windows-command-creator-profile";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { setup, OWNER, SYSTEM } from "../fixtures/windows-command-creator-native-fake";

const rejected = async (work: Promise<unknown>): Promise<unknown> => {
  try { await work; } catch (error) { return error; }
  throw new Error("The composed creator-owner fault must refuse.");
};
function profile(text: string) {
  const parts = text.split("-"), subs = parts.slice(3).map(Number), bytes = Buffer.alloc(8 + 4 * subs.length);
  bytes[0] = 1; bytes[1] = subs.length; bytes[7] = 15;
  subs.forEach((value, index) => bytes.writeUInt32LE(value, 8 + index * 4));
  return bindWindowsCommandCreatorProfileNative({ sizeof: () => 8, decode: () => Buffer.from(bytes) } as unknown as Parameters<typeof bindWindowsCommandCreatorProfileNative>[0], () => ({
    func(prototype) {
      const name = /\b(\w+)\s*\(/.exec(prototype)![1];
      return (...args: unknown[]) => {
        if (name === "CreateAppContainerProfile") { (args[5] as unknown[])[0] = 0x900000n; return 0; }
        if (name === "IsValidSid") return 1;
        if (name === "GetLengthSid") return bytes.length;
        if (name === "DeleteAppContainerProfile") return 0;
        if (name === "FreeSid") return null;
        throw new Error("Unexpected fixed profile declaration.");
      };
    },
  }), { retained: [] }).create();
}
function stopHarness() {
  const root = { process: 50001n, thread: 50002n, pid: 50003 }, events: string[] = [];
  let assigned = false, ended = false;
  const api = { createJob() { assigned = false; ended = false; events.push("job"); return 50000n; },
    assign() { assigned = true; events.push("assign"); }, resume() { events.push("resume"); },
    terminateProcess() { ended = true; events.push("terminate-root"); }, terminateJob() { ended = true; events.push("terminate-job"); } } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = { configure() { events.push("configure"); }, assertLimits() {},
    state: () => ({ total: assigned ? 1 : 0, active: assigned && !ended ? 1 : 0, pids: assigned && !ended ? [root.pid] : [] }),
    processId: () => root.pid, threadProcessId: () => root.pid, member: () => assigned,
    wait: () => ended ? 0 : 258, close() { events.push("closed-native-owner"); } };
  const owner = (binding: object) => createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, { retained: [] });
  return { root, events, api, native, owner, ended() { ended = true; } };
}
async function direct() {
  const s = setup(), ref = profile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(ref).sidText;
  const tree = await s.binding.createFreshWindowsCommandTree({ ...s.input(), creatorProfile: ref });
  const h = stopHarness(), binding = {}, stop = h.owner(binding), grant = tree.prepareCreator!(binding);
  await tree.grant(pkg);
  return { s, ref, pkg, tree, h, binding, stop, grant,
    launch: () => stop.launch(() => h.root, () => undefined, () => s.control.current, witness => tree.captureCreator!(grant, witness)),
    async finish() { await tree.close(); closeWindowsCommandCreatorProfile(ref); },
  };
}
function newFile(s: ReturnType<typeof setup>, pkg: string, name: string, owner: string) {
  return s.add(path.join(s.root().name, name), "file", Buffer.from("fixed creator bytes"), { owner, aclOwner: OWNER, package: pkg, inherited: true, low: true });
}
const ownerWrites = (s: ReturnType<typeof setup>) => s.calls.filter(call => call.name === "NtSetSecurityObject" && (Number(call.args[1]) & 1) !== 0);

it.each(["created", "replaced"])("composes actual coordinator/native/Stop normalization of an exact captured %s owner", async mode => {
  const s = setup(), ref = profile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(ref).sidText, h = stopHarness();
  const copy = await WindowsRootOnlyCommandCopy.create({ ...s.input(), creatorProfile: ref, packageSid: pkg, packageCurrent: () => true, reviewCurrent: () => true }, {
    api: h.api, fence: { retained: [] }, createTree: input => s.binding.createFreshWindowsCommandTree(input), createStopOwner: binding => h.owner(binding),
  });
  expect(await copy.launchRootOnly(() => h.root, () => { h.events.push("attested"); })).toBe(h.root.pid);
  if (mode === "replaced") { const old = s.objects.get(path.join(s.root().name, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true; }
  const row = newFile(s, pkg, mode === "created" ? "created.txt" : "a.ts", s.control.tokenOwner);
  h.ended(); let called = false;
  await copy.files(async entries => {
    called = true; expect(row.security.owner).toBe(OWNER); expect(row.security.package).toBeUndefined();
    expect(entries.some(entry => entry.kind === "file" && entry.bytes.toString() === "fixed creator bytes")).toBe(true);
    expect(h.events.filter(event => event === "closed-native-owner")).toHaveLength(3);
  });
  expect(called).toBe(true); expect(ownerWrites(s)).toHaveLength(1);
  expect(s.calls.filter(call => call.name === "GetTokenInformation" && call.args[1] !== 1).map(call => call.args[1])).toEqual([31, 4]);
  await copy.close(); closeWindowsCommandCreatorProfile(ref); expect(s.handles.size).toBe(0);
});

it("accepts a new host-owned node only when the actual captured creator owner was host, without OWNER transfer", async () => {
  const v = await direct(); v.s.control.tokenOwner = OWNER; await v.launch(); newFile(v.s, v.pkg, "host-created.txt", OWNER);
  await v.tree.revokeCreator!(v.grant, await v.stop.stop()); expect(ownerWrites(v.s)).toHaveLength(0);
  await v.finish();
});

it.each(["created", "replaced"])("rejects a host-owned %s new identity when the captured creator owner was distinct", async mode => {
  const v = await direct(); await v.launch();
  if (mode === "replaced") { const old = v.s.objects.get(path.join(v.s.root().name, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true; }
  const row = newFile(v.s, v.pkg, mode === "created" ? "foreign-host.txt" : "a.ts", OWNER);
  const receipt = await v.stop.stop(), before = v.s.sets();
  expect(await rejected(v.tree.revokeCreator!(v.grant, receipt))).toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(v.s.sets()).toBe(before); expect(v.s.control.dataReads).toBe(0); expect(row.security.owner).toBe(OWNER);
});

it("normalizes a newly created directory and its file only under the exact captured creator identity", async () => {
  const v = await direct(); await v.launch();
  const directory = v.s.add(path.join(v.s.root().name, "created-folder"), "directory", Buffer.alloc(0),
    { owner: v.s.control.tokenOwner, aclOwner: OWNER, package: v.pkg, inherited: true, low: true });
  const file = newFile(v.s, v.pkg, "created-folder/child.txt", v.s.control.tokenOwner);
  await v.tree.revokeCreator!(v.grant, await v.stop.stop());
  expect(ownerWrites(v.s)).toHaveLength(2); expect(directory.security.owner).toBe(OWNER); expect(file.security.owner).toBe(OWNER);
  expect(directory.security.package).toBeUndefined(); expect(file.security.package).toBeUndefined();
  const entries = await v.tree.snapshot();
  expect(entries.find(entry => entry.path === "created-folder")).toEqual({ path: "created-folder", kind: "directory" });
  for (const entry of entries) if (entry.kind === "file") entry.bytes.fill(0);
  await v.finish();
});

it.each([SYSTEM, "S-1-5-21-900-901-902-1002"])("preflights an unobserved creator owner without any security mutation (%s)", async owner => {
  const v = await direct(); await v.launch(); newFile(v.s, v.pkg, "wrong.txt", owner);
  const receipt = await v.stop.stop(), before = v.s.sets();
  expect(await rejected(v.tree.revokeCreator!(v.grant, receipt))).toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(v.s.sets()).toBe(before); expect(v.s.control.dataReads).toBe(0);
});

it.each(["root", "known", "renamed-known", "detached-known"])("keeps the original owner strict for %s identities", async kind => {
  const v = await direct(); await v.launch();
  const row = kind === "root" ? v.s.root() : v.s.objects.get(path.join(v.s.root().name, "a.ts"))!;
  if (kind === "renamed-known") { v.s.objects.delete(row.name); row.name = path.join(v.s.root().name, "renamed.ts"); v.s.objects.set(row.name, row); }
  if (kind === "detached-known") { row.removed = true; row.links = 0; row.deletePending = true; }
  row.security.owner = v.s.control.tokenOwner;
  const receipt = await v.stop.stop(), before = v.s.sets(); await rejected(v.tree.revokeCreator!(v.grant, receipt));
  expect(v.s.sets()).toBe(before); expect(ownerWrites(v.s)).toHaveLength(0); expect(v.s.control.dataReads).toBe(0);
});

it.each(["open missing", "open alias", "open Stop job alias", "open throw", "open false", "short returned", "outside pointer", "bad revision", "query throw 1", "query false 1", "query throw 31", "query false 31", "query throw 4", "query false 4", "close throw", "close false"])("retains capture uncertainty and never resumes or permits bytes after %s", async fault => {
  const v = await direct(); v.s.control.tokenFault = fault;
  const before = v.s.calls.length;
  await rejected(v.launch()); expect(v.h.events).not.toContain("resume"); expect(v.s.control.dataReads).toBe(0);
  if (fault === "open Stop job alias") expect(v.s.calls.slice(before).map(call => call.name)).toEqual(["OpenProcessToken"]);
  const count = v.s.calls.length; await rejected(v.tree.snapshot()); await rejected(v.tree.grant(v.pkg));
  expect(v.s.calls).toHaveLength(count); expect(v.s.fence.retained.length).toBeGreaterThan(0);
});

it("cancels between package and owner queries without querying Owner, closing the token or resuming", async () => {
  const v = await direct(); v.s.control.tokenHook = kind => { if (kind === 31) v.s.control.current = false; };
  const before = v.s.calls.length; await rejected(v.launch()); const calls = v.s.calls.slice(before);
  expect(calls.filter(call => call.name === "GetTokenInformation").map(call => call.args[1])).toEqual([1, 31]);
  expect(calls.some(call => call.name === "CloseHandle")).toBe(false); expect(v.h.events).not.toContain("resume");
});

it.each(["user", "package"])("does not capture Owner after the live root %s identity changed", async kind => {
  const v = await direct(); if (kind === "user") v.s.control.tokenUser = "S-1-5-21-900"; else v.s.control.tokenPackage = "S-1-15-2-111";
  const before = v.s.calls.length; await rejected(v.launch());
  expect(v.s.calls.slice(before).filter(call => call.name === "GetTokenInformation").map(call => call.args[1])).toEqual(kind === "user" ? [1] : [1, 31]);
  expect(v.h.events).not.toContain("resume");
});

it("requires a configured genuine Stop owner before preparing a creator grant", async () => {
  const s = setup(), ref = profile(s.control.tokenPackage), tree = await s.binding.createFreshWindowsCommandTree({ ...s.input(), creatorProfile: ref });
  const before = s.calls.length; expect(() => tree.prepareCreator!({})).toThrow(); expect(s.calls).toHaveLength(before);
  await tree.close(); closeWindowsCommandCreatorProfile(ref);
});

it.each(["foreign", "wrong-binding"])("does not revoke under a %s Stop receipt", async kind => {
  const v = await direct(); await v.launch();
  const receipt = kind === "foreign" ? { scope: "root-only" } : await stopHarness().owner({}).stop();
  const before = v.s.sets(); await rejected(v.tree.revokeCreator!(v.grant, receipt)); expect(v.s.sets()).toBe(before);
});

it("does not read getters on a structural completion claim or mistake it for an empty-job receipt", async () => {
  const v = await direct(); let reads = 0;
  const fake = new Proxy({ scope: "root-only", rootPresent: 0 }, { get() { reads++; throw new Error("private getter content"); } });
  const before = v.s.calls.length; await rejected(v.tree.revokeCreator!(v.grant, fake));
  expect(reads).toBe(0); expect(v.s.calls).toHaveLength(before);
});

it("cannot replay a consumed creator generation even with its genuine stopped receipt", async () => {
  const v = await direct(); await v.launch(); const receipt = await v.stop.stop(); await v.tree.revokeCreator!(v.grant, receipt);
  const before = v.s.calls.length, sets = v.s.sets(); await rejected(v.tree.revokeCreator!(v.grant, receipt)); expect(v.s.sets()).toBe(sets); expect(v.s.calls).toHaveLength(before);
});

it.each(["forged", "wrong-profile", "closed-profile"])("rejects %s creator-profile authority before preparing any native filesystem owner", async kind => {
  const s = setup(), ref = kind === "forged" ? {} as WindowsCommandCreatorProfileRef : profile(kind === "wrong-profile" ? "S-1-15-2-99-98-97-96-95-94-93" : s.control.tokenPackage);
  if (kind === "closed-profile") closeWindowsCommandCreatorProfile(ref);
  const before = s.calls.length;
  await rejected(WindowsRootOnlyCommandCopy.create({ ...s.input(), creatorProfile: ref, packageSid: s.control.tokenPackage,
    packageCurrent: () => true, reviewCurrent: () => true }, { api: stopHarness().api, fence: { retained: [] }, createTree: input => s.binding.createFreshWindowsCommandTree(input) }));
  expect(s.calls).toHaveLength(before);
  if (kind === "wrong-profile") closeWindowsCommandCreatorProfile(ref);
});

it.each(["forged", "other-tree"])("refuses a %s creator-grant reference before opening a root token or Resume", async kind => {
  const v = await direct(), other = kind === "other-tree" ? await direct() : undefined;
  const foreign = other?.grant ?? { scope: "root-only-creator-grant" } as WindowsCommandCreatorGrantRef;
  const before = v.s.calls.length;
  await rejected(v.stop.launch(() => v.h.root, () => undefined, () => true, witness => v.tree.captureCreator!(foreign, witness)));
  expect(v.s.calls.slice(before).some(call => call.name === "OpenProcessToken")).toBe(false); expect(v.h.events).not.toContain("resume");
  if (other) { await other.tree.revokeCreator!(other.grant, await other.stop.stop()); await other.finish(); }
});

it("uses a genuine empty-job receipt to unwind a known cancelled partial grant without inventing creator evidence", async () => {
  const s = setup(), ref = profile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(ref).sidText;
  const tree = await s.binding.createFreshWindowsCommandTree({ ...s.input(), creatorProfile: ref });
  const h = stopHarness(), binding = {}, stop = h.owner(binding), grant = tree.prepareCreator!(binding);
  s.control.retireOnSet = 1; await rejected(tree.grant(pkg));
  expect(s.control.current).toBe(false); expect(h.events).not.toContain("resume");
  await tree.revokeCreator!(grant, await stop.stop());
  expect(ownerWrites(s)).toHaveLength(0); expect(s.root().security.package).toBeUndefined();
  await tree.close(); closeWindowsCommandCreatorProfile(ref);
});

it("distinguishes a launched root missing capture from a genuine never-launched job", async () => {
  const v = await direct(); await v.stop.launch(() => v.h.root, () => undefined, () => true);
  const receipt = await v.stop.stop(), before = v.s.sets(); await rejected(v.tree.revokeCreator!(v.grant, receipt)); expect(v.s.sets()).toBe(before);
});

it("revokes a genuine empty prepared grant without inventing a creator owner", async () => {
  const v = await direct(); await v.tree.revokeCreator!(v.grant, await v.stop.stop()); expect(ownerWrites(v.s)).toHaveLength(0); await v.finish();
});

it.each(["new", "replacement", "detached"])("refuses %s objects when no root ever supplied creator evidence", async kind => {
  const v = await direct();
  if (kind !== "new") { const old = v.s.objects.get(path.join(v.s.root().name, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true; }
  if (kind !== "detached") newFile(v.s, v.pkg, kind === "replacement" ? "a.ts" : "new.txt", OWNER);
  const receipt = await v.stop.stop(), before = v.s.sets(); await rejected(v.tree.revokeCreator!(v.grant, receipt)); expect(v.s.sets()).toBe(before); expect(v.s.control.dataReads).toBe(0);
});

it.each(["throw", "readback"])("suppresses bytes and every next grant after an owner-transfer %s failure", async fault => {
  const v = await direct(); await v.launch(); const row = newFile(v.s, v.pkg, "new.txt", v.s.control.tokenOwner);
  const set = v.s.handlers.NtSetSecurityObject;
  v.s.handlers.NtSetSecurityObject = (...args) => { if (Number(args[1]) & 1) { if (fault === "throw") throw new Error("fixed transfer uncertainty"); const value = set(...args); row.security.owner = v.s.control.tokenOwner; return value; } return set(...args); };
  await rejected(v.tree.revokeCreator!(v.grant, await v.stop.stop())); const count = v.s.calls.length;
  await rejected(v.tree.snapshot()); await rejected(v.tree.grant(v.pkg)); expect(v.s.calls).toHaveLength(count); expect(v.s.control.dataReads).toBe(0);
});
