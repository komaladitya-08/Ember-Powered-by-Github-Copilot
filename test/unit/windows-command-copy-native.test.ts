/** Native boundary/ownership fault injection only; no Windows API or token is exercised here. */
import path from "node:path/win32";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";
import { createFreshWindowsCommandTree, WindowsCommandCopyCleanupError, windowsCommandCopyNativeFailure, type FreshWindowsCommandTreeInput } from "../../app/main/agent/windows-command-copy-native";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";
import { WindowsRootOnlyCommandCopy } from "../../app/main/agent/windows-command-copy";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative } from "../../app/main/agent/windows-command-stop";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { observeWindowsCommandCopyFactory } from "../fixtures/windows-command-copy-proof";
import { setup, OWNER, SYSTEM, PACKAGE, type ObjectRow } from "../fixtures/windows-command-creator-native-fake";
async function rejected(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (error) { return error; }
  throw new Error("Expected the fixed native fault to refuse.");
}

it("composes the real coordinator/native grant callbacks with a real root-only Stop owner before private review", async () => {
  const s = setup(), events: string[] = []; let assigned = false, exited = false, current = true;
  const root = { process: 50001n, thread: 50002n, pid: 50003 };
  const api = { createJob: () => 50000n, assign() { assigned = true; events.push("assign"); }, resume() { events.push("resume"); },
    terminateProcess() { exited = true; events.push("terminate-root"); }, terminateJob() { exited = true; events.push("terminate-job"); } } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = {
    configure() { events.push("limits"); }, assertLimits() {},
    state: () => ({ total: assigned ? 1 : 0, active: assigned && !exited ? 1 : 0, pids: assigned && !exited ? [root.pid] : [] }),
    processId: () => root.pid, threadProcessId: () => root.pid, member: () => assigned,
    wait: () => exited ? 0 : 258, close() { events.push("close"); },
  };
  for (const folder of ["C:\\scratch\\outer", "C:\\scratch\\outer\\trees", "C:\\scratch\\outer\\fixture", "C:\\build"]) s.add(folder, "directory");
  s.add("C:\\canary.txt", "file", Buffer.from("fixed private canary"));
  const entries: CodingExportEntry[] = [
    ...[["seed.txt", "EMBER_COMMAND_SEED\n"], ["move.txt", "EMBER_COMMAND_MOVE\n"], ["replace.txt", "EMBER_COMMAND_OLD\n"], ["remove.txt", "EMBER_COMMAND_REMOVE\n"]]
      .map(([path, bytes]) => ({ path, kind: "file" as const, bytes: Buffer.from(bytes), executable: false })),
    { path: "staged-folder", kind: "directory" }, { path: "staged-folder/child.txt", kind: "file", bytes: Buffer.from("EMBER_COMMAND_CHILD\n"), executable: false },
  ];
  const failures: unknown[] = [], input = { ...s.input(entries), parent: "C:\\scratch\\outer\\trees", protectedPaths: ["C:\\source", "C:\\canary.txt", "C:\\scratch\\outer\\fixture", "C:\\build"] };
  const copy = await WindowsRootOnlyCommandCopy.create({ ...input, packageSid: PACKAGE,
    current: () => current, packageCurrent: () => true, reviewCurrent: () => true }, {
    api, fence: { retained: [] }, createTree: actual => observeWindowsCommandCopyFactory(actual, selected => s.binding.createFreshWindowsCommandTree(selected), error => { failures.push(error); }),
    createStopOwner: binding => createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, { retained: [] }),
  });
  await copy.files(async snapshot => { expect(snapshot).toHaveLength(6); expect(snapshot.find(entry => entry.path === "seed.txt")).toEqual(entries[0]); });
  expect(await copy.launchRootOnly(() => { events.push("create"); return root; }, () => { events.push("attest"); })).toBe(root.pid);
  expect(events).toEqual(["limits", "create", "assign", "attest", "resume"]); expect(s.root().security.package).toBe(PACKAGE);
  await copy.files(async snapshot => { expect(snapshot).toHaveLength(6); expect(s.root().security.package).toBeUndefined(); events.push("private-read"); });
  expect(events.indexOf("private-read")).toBeGreaterThan(events.lastIndexOf("close"));
  current = false; await copy.stop(); await copy.review(async snapshot => { expect(snapshot).toHaveLength(6); });
  await copy.close(); expect(s.handles.size).toBe(0); expect(failures).toEqual([]);
});

it.each(["created", "replaced"])("the actual coordinator/native/Stop composition refuses a %s file's synthetic creator owner despite its inherited host ACL", async mode => {
  const s = setup(), events: string[] = [], failures: unknown[] = [], root = { process: 50001n, thread: 50002n, pid: 50003 };
  let assigned = false, exited = false;
  const api = { createJob: () => 50000n, assign() { assigned = true; }, resume() {}, terminateProcess() { exited = true; }, terminateJob() { exited = true; } } as unknown as WindowsLpacApi;
  const stop: WindowsCommandRootOnlyStopNative = { configure() {}, assertLimits() {},
    state: () => ({ total: assigned ? 1 : 0, active: assigned && !exited ? 1 : 0, pids: assigned && !exited ? [root.pid] : [] }),
    processId: () => root.pid, threadProcessId: () => root.pid, member: () => assigned, wait: () => exited ? 0 : 258,
    close() { events.push("closed-root-owner"); },
  };
  const copyFence = { retained: [] as unknown[] }, entries: CodingExportEntry[] = [{ path: "replace.txt", kind: "file", bytes: Buffer.from("EMBER_COMMAND_OLD\n"), executable: false }];
  const copy = await WindowsRootOnlyCommandCopy.create({ ...s.input(entries), packageSid: PACKAGE, packageCurrent: () => true, reviewCurrent: () => true }, {
    api, fence: copyFence, createTree: input => observeWindowsCommandCopyFactory(input, actual => s.binding.createFreshWindowsCommandTree(actual), error => { failures.push(error); }),
    createStopOwner: binding => createWindowsCommandRootOnlyStopOwner(binding, api, stop, () => 100, { retained: [] }),
  });
  await copy.launchRootOnly(() => root, () => undefined);
  const name = path.join(s.root().name, mode === "created" ? "created.txt" : "replace.txt");
  if (mode === "replaced") { const old = s.objects.get(name)!; old.removed = true; old.links = 0; old.deletePending = true; }
  const created = s.add(name, "file", Buffer.from(mode === "created" ? "EMBER_COMMAND_CREATED\n" : "EMBER_COMMAND_REPLACED\n"),
    { owner: "S-1-5-21-9876-5432-1002", aclOwner: OWNER, package: PACKAGE, inherited: true, low: true });
  const security = s.handlers.GetSecurityInfo; s.handlers.GetSecurityInfo = (...args) => { events.push("tree-owner-query"); return security(...args); };
  exited = true; const sets = s.sets(); await rejected(copy.stop());
  expect(events.filter(event => event === "closed-root-owner")).toHaveLength(3);
  expect(events.indexOf("tree-owner-query")).toBeGreaterThan(events.lastIndexOf("closed-root-owner"));
  expect(s.sets()).toBe(sets); expect(s.control.dataReads).toBe(0); expect(created.security.owner).toBe("S-1-5-21-9876-5432-1002");
  expect(windowsCommandCopyNativeFailure(failures[0])).toEqual({ stage: 7, operation: 24, predicate: 7, domain: 0, code: 0,
    ownerClass: 5, nodeKind: 1, nodeRoot: 0, nodeAcl: 3, nodeDetached: 0 });
  expect(s.calls.slice(-3).map(call => call.name)).toEqual(["GetSecurityInfo", "ConvertSidToStringSidW", "LocalFree"]);
  expect(s.fence.retained).toHaveLength(1); expect(copyFence.retained).toContain(copy);
  const count = s.calls.length; let reviewed = false;
  await rejected(copy.review(async () => { reviewed = true; })); await rejected(copy.close());
  expect(reviewed).toBe(false); expect(s.calls).toHaveLength(count);
});

const creatorOwnerClasses = [
  { label: "known package", sid: PACKAGE, ownerClass: 2 }, { label: "SYSTEM", sid: SYSTEM, ownerClass: 3 },
  { label: "public builtin Administrators", sid: "S-1-5-32-544", ownerClass: 4 },
  { label: "other creator", sid: "S-1-5-21-9876-5432-1002", ownerClass: 5 },
] as const;
for (const provenance of ["initial granted", "new file", "new directory", "detached initial"] as const) {
  it.each(creatorOwnerClasses)(`records only closed owner/node facts for ${provenance} with $label, retaining the original refusal`, async value => {
    const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
    const inherited = provenance === "new file" || provenance === "new directory";
    let row: ObjectRow;
    if (inherited) row = s.add(path.join(tree.directory, "fixed-created"), provenance === "new directory" ? "directory" : "file", provenance === "new directory" ? Buffer.alloc(0) : Buffer.from("fixed public bytes"),
      { owner: value.sid, aclOwner: OWNER, package: PACKAGE, inherited: true, low: true });
    else {
      row = s.objects.get(path.join(tree.directory, "a.ts"))!; row.security = { ...row.security, owner: value.sid, aclOwner: OWNER };
      if (provenance === "detached initial") { row.removed = true; row.links = 0; row.deletePending = true; }
    }
    const sets = s.sets(), error = await rejected(tree.revoke(PACKAGE)), observation = windowsCommandCopyNativeFailure(error), count = s.calls.length;
    expect(observation).toEqual({ stage: 7, operation: 24, predicate: 7, domain: 0, code: 0, ownerClass: value.ownerClass,
      nodeKind: provenance === "new directory" ? 2 : 1, nodeRoot: 0, nodeAcl: inherited ? 3 : 2, nodeDetached: provenance === "detached initial" ? 1 : 0 });
    expect(s.calls.slice(-3).map(call => call.name)).toEqual(["GetSecurityInfo", "ConvertSidToStringSidW", "LocalFree"]);
    expect(s.sets()).toBe(sets); expect(s.control.dataReads).toBe(0); expect(row.security.owner).toBe(value.sid);
    expect(Object.isFrozen(observation)).toBe(true); expect(Object.values(observation!).every(value => Number.isInteger(value))).toBe(true);
    for (const material of [value.sid, row.name, "fixed public bytes"]) expect(JSON.stringify(observation)).not.toContain(material);
    expect(Object.keys(observation!).sort()).toEqual(["stage", "operation", "predicate", "domain", "code", "ownerClass", "nodeKind", "nodeRoot", "nodeAcl", "nodeDetached"].sort());
    await rejected(tree.close()); expect(s.calls).toHaveLength(count); expect(s.fence.retained).toHaveLength(1);
    expect(windowsCommandCopyNativeFailure(error)).toBe(observation);
    for (const foreign of [{ ...observation }, { ...error as object }, JSON.parse(JSON.stringify(error)),
      new Proxy({}, { get() { throw new Error("private owner getter"); } })]) expect(windowsCommandCopyNativeFailure(foreign)).toBeUndefined();
  });
}
it.each(["root", "initial file"])("does not turn a changed private %s owner into grant or creation authority", async target => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  const row = target === "root" ? s.root() : s.objects.get(path.join(tree.directory, "a.ts"))!;
  row.security = { ...row.security, owner: PACKAGE, aclOwner: OWNER }; const sets = s.sets();
  const error = await rejected(tree.assertPrivate());
  // The package is not known to this native owner before grant, so its SID can only be classified as other.
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 5, operation: 24, predicate: 7, domain: 0, code: 0,
    ownerClass: 5, nodeKind: target === "root" ? 2 : 1, nodeRoot: target === "root" ? 1 : 0, nodeAcl: 1, nodeDetached: 0 });
  expect(s.sets()).toBe(sets); expect(s.control.dataReads).toBe(0);
});
it("keeps the first owner facts across peer quarantine without another decode, mutation or native query", async () => {
  const s = setup(), first = await s.binding.createFreshWindowsCommandTree(s.input()), peer = await s.binding.createFreshWindowsCommandTree(s.input());
  await first.grant(PACKAGE); const row = s.objects.get(path.join(first.directory, "a.ts"))!;
  row.security = { ...row.security, owner: "S-1-5-32-544", aclOwner: OWNER };
  const error = await rejected(first.revoke(PACKAGE)), observation = windowsCommandCopyNativeFailure(error), count = s.calls.length;
  expect(observation?.ownerClass).toBe(4);
  const peerError = await rejected(peer.assertPrivate()); expect(peerError).toBe(error); expect(s.calls).toHaveLength(count);
  expect(windowsCommandCopyNativeFailure(peerError)).toBe(observation); expect(s.fence.retained).toHaveLength(2);
});

it("exposes only branded frozen first-failure numbers without reading foreign error properties", async () => {
  const foreign = new Proxy({}, { get() { throw new Error("must not inspect foreign properties"); } });
  for (const error of [undefined, null, 1, "private", {}, foreign, new Error("private"), new WindowsCommandCopyCleanupError()]) expect(windowsCommandCopyNativeFailure(error)).toBeUndefined();
  const s = setup(); s.control.fault = "create status";
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input())), count = s.calls.length;
  expect(error).toBeInstanceOf(WindowsCommandCopyCleanupError);
  const observation = windowsCommandCopyNativeFailure(error);
  expect(observation).toEqual({ stage: 3, operation: 1, predicate: 2, domain: 1, code: 0xc0000022 });
  expect(Object.isFrozen(observation)).toBe(true);
  expect(Object.keys(observation!)).toEqual(["stage", "operation", "predicate", "domain", "code"]);
  expect(Object.values(observation!).every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)).toBe(true);
  expect(windowsCommandCopyNativeFailure({ ...error as object })).toBeUndefined();
  expect(windowsCommandCopyNativeFailure(JSON.parse(JSON.stringify(error)))).toBeUndefined();
  expect(windowsCommandCopyNativeFailure(observation)).toBeUndefined();
  expect(windowsCommandCopyNativeFailure(error)).toBe(observation);
  expect(s.calls).toHaveLength(count); expect(s.calls.some(call => call.name === "GetLastError")).toBe(false);
});

it.each([-2147483648, -1073741790, -1, 1, 0x80000000, 0xffffffff])("normalizes only an already returned NTSTATUS %s", async status => {
  const s = setup(); s.handlers.NtCreateFile = () => status;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 2, operation: 1, predicate: 2, domain: 1, code: status >>> 0 });
  expect(s.calls.at(-1)?.name).toBe("NtCreateFile");
  expect(s.calls.map(call => call.name)).toEqual(["GetCurrentProcess", "OpenProcessToken", "GetTokenInformation", "ConvertSidToStringSidW", "LocalFree", "CloseHandle", "GetDriveTypeW", "GetVolumeInformationW", "NtCreateFile"]);
});

it.each([-2147483648, -1, 0, 2, 0xffffffff])("records only a numeric failed BOOL return %s without an error query", async status => {
  const s = setup(); s.handlers.OpenProcessToken = () => status;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 1, operation: 20, predicate: 2, domain: 2, code: status >>> 0 });
  expect(s.calls.map(call => call.name)).toEqual(["GetCurrentProcess", "OpenProcessToken"]);
});

it.each([undefined, null, false, "private", 0n, 0.5, NaN, Infinity, -2147483649, 0x100000000, Buffer.from("private")])("never coerces or publishes malformed return data %#", async value => {
  const s = setup(); s.handlers.NtCreateFile = () => value;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 2, operation: 1, predicate: 2, domain: 0, code: 0 });
  expect(s.calls.at(-1)?.name).toBe("NtCreateFile");
});

it.each(["GetDriveTypeW", "GetFileType", "GetFinalPathNameByHandleW", "GetSecurityInfo"])('omits non-BOOL/non-NT return contents for %s', async name => {
  const s = setup(); s.handlers[name] = () => 0x12345678;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toMatchObject({ predicate: 2, domain: 0, code: 0 });
  expect(s.calls.at(-1)?.name).toBe(name);
});

it("keeps pointer-valued LocalFree uncertainty private and preserves the exact native call suffix", async () => {
  const s = setup(); s.control.fault = "free";
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 1, operation: 10, predicate: 2, domain: 0, code: 0 });
  expect(s.calls.map(call => call.name)).toEqual(["GetCurrentProcess", "OpenProcessToken", "GetTokenInformation", "ConvertSidToStringSidW", "LocalFree"]);
});

it.each([
  ["not fresh", 3, 1, 3], ["create throw", 3, 1, 1], ["extra handle rights", 2, 8, 4],
] as const)("classifies %s without exposing the rejected output", async (fault, stage, operation, predicate) => {
  const s = setup(); s.control.fault = fault;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage, operation, predicate, domain: 0, code: 0 });
});

it("keeps the original observation across shared-fence failures and every later owner operation", async () => {
  const s = setup(), first = await s.binding.createFreshWindowsCommandTree(s.input()), second = await s.binding.createFreshWindowsCommandTree(s.input());
  s.control.fault = "close";
  const error = await rejected(first.close()), observation = windowsCommandCopyNativeFailure(error), count = s.calls.length;
  expect(observation).toEqual({ stage: 9, operation: 9, predicate: 2, domain: 2, code: 0 });
  for (const work of [() => second.assertPrivate(), () => second.grant(PACKAGE), () => second.revoke(PACKAGE), () => second.snapshot(), () => second.close(), () => s.binding.createFreshWindowsCommandTree(s.input())]) {
    expect(await rejected(work())).toBe(error); expect(windowsCommandCopyNativeFailure(error)).toBe(observation); expect(s.calls).toHaveLength(count);
  }
  expect(s.fence.retained).toHaveLength(2);
});

it("does not invent a native observation for an already failed foreign shared fence", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()), foreign = new WindowsCommandCopyCleanupError();
  s.fence.failure = foreign; const count = s.calls.length;
  expect(await rejected(tree.snapshot())).toBe(foreign); expect(windowsCommandCopyNativeFailure(foreign)).toBeUndefined(); expect(s.calls).toHaveLength(count);
});

it.each(["assert", "grant", "revoke", "snapshot", "close"] as const)("attributes %s failure to its finite owner stage", async method => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  if (method === "revoke") await tree.grant(PACKAGE);
  s.handlers.GetFileInformationByHandle = () => 0;
  const work = method === "assert" ? tree.assertPrivate() : method === "grant" ? tree.grant(PACKAGE) : method === "revoke" ? tree.revoke(PACKAGE) : method === "snapshot" ? tree.snapshot() : tree.close();
  const error = await rejected(work);
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: ({ assert: 5, grant: 6, revoke: 7, snapshot: 8, close: 9 })[method], operation: 14, predicate: 2, domain: 2, code: 0 });
  expect(s.calls.at(-1)?.name).toBe("GetFileInformationByHandle");
});

it("attributes a staged write failure without forwarding its bytes or issuing another native call", async () => {
  const s = setup(); s.handlers.NtWriteFile = () => -1073741790;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 4, operation: 5, predicate: 2, domain: 1, code: 0xc0000022 });
  expect(s.calls.at(-1)?.name).toBe("NtWriteFile");
});

it.each(["stream", "owner", "metadata"] as const)("classifies %s predicate failure with no native payload", async kind => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  if (kind === "stream") s.objects.get(path.join(tree.directory, "a.ts"))!.streams = true;
  if (kind === "owner") s.control.owner = "S-1-5-21-9999";
  if (kind === "metadata") s.root().id += 1000n;
  const error = await rejected(tree.assertPrivate()), count = s.calls.length;
  expect(windowsCommandCopyNativeFailure(error)).toMatchObject({ stage: 5, predicate: ({ stream: 6, owner: 7, metadata: 5 })[kind], domain: 0, code: 0 });
  expect(await rejected(tree.close())).toBe(error); expect(s.calls).toHaveLength(count);
});

it("preserves a peer's first native observation when an admission callback swallows and rethrows unrelated data", async () => {
  const s = setup(), first = await s.binding.createFreshWindowsCommandTree(s.input()), second = await s.binding.createFreshWindowsCommandTree(s.input());
  let peerError: unknown, stoppedAt = 0;
  const error = await rejected(first.grant(PACKAGE, () => {
    s.handlers.GetFileInformationByHandle = () => 0;
    // The async method performs its first native query synchronously before its first yield.
    const work = second.close(); stoppedAt = s.calls.length;
    void work.catch(error => { peerError = error; });
    throw new Error("private callback detail");
  }));
  await Promise.resolve();
  expect(error).toBe(peerError);
  expect(windowsCommandCopyNativeFailure(error)).toEqual({ stage: 9, operation: 14, predicate: 2, domain: 2, code: 0 });
  expect(s.calls).toHaveLength(stoppedAt);
});

it("stages only fresh owner-private LOW objects and retains metadata-only share7 pins before granting", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  await tree.assertPrivate(); await tree.grant(PACKAGE);
  const root = s.root(); expect(tree.directory).toBe(root.name);
  const liveFresh = s.opened.filter(row => row.object.name.startsWith(root.name) && s.handles.has(row.raw));
  expect(liveFresh.length).toBeGreaterThan(0); for (const row of liveFresh) { expect(row.share).toBe(7); expect(row.access & (0x1f | 0x10000)).toBe(0); }
  expect([...s.handles.values()].every(handle => !(handle.access & (0x1f | 0x10000)))).toBe(true);
  expect(root.security.package).toBe(PACKAGE); expect(root.security.low).toBe(true);
  expect(s.calls.filter(call => call.name === "NtSetSecurityObject").every(call => Number(call.args[1]) === 0x80000014)).toBe(true);
  expect(s.calls.filter(call => call.name === "GetSecurityInfo").every(call => Number(call.args[2]) === 0x15)).toBe(true);
  expect(s.opened.filter(row => row.fresh).every(row => row.object.name.startsWith(root.name))).toBe(true);
  await tree.revoke(PACKAGE); await tree.close(); expect(s.handles.size).toBe(0);
});

it("detaches input before any yield, preserves source, returns private detached snapshots and removes only the fresh tree", async () => {
  const s = setup(), bytes = Buffer.from("baseline"), input = s.input([{ path: "a.ts", kind: "file", bytes, executable: false }]);
  const promised = s.binding.createFreshWindowsCommandTree(input); bytes.fill(0); const tree = await promised;
  const snapshot = await tree.snapshot(); expect(snapshot).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]);
  if (snapshot[0].kind === "file") snapshot[0].bytes.fill(0);
  expect(await tree.snapshot()).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]);
  await tree.close(); await tree.close(); expect(s.objects.get("C:\\source\\input.ts")!.bytes.toString()).toBe("source remains untouched");
  expect(s.calls.filter(call => ["NtWriteFile", "NtSetSecurityObject", "NtSetInformationFile"].includes(call.name)).every(call => s.opened.find(row => row.raw === call.args[0])!.object.name.startsWith(tree.directory))).toBe(true);
});

it("revokes current descendants created during execution, including inherited child directories and files", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const sec = { owner: OWNER, package: PACKAGE, inherited: true, low: true };
  s.add(path.join(tree.directory, "new"), "directory", Buffer.alloc(0), sec); s.add(path.join(tree.directory, "new", "out.ts"), "file", Buffer.from("created"), sec);
  await tree.revoke(PACKAGE); expect(s.objects.get(path.join(tree.directory, "new", "out.ts"))!.security.package).toBeUndefined();
  const snapshot = await tree.snapshot(); expect(snapshot.map(entry => entry.path).sort()).toEqual(["a.ts", "new", "new/out.ts"]); await tree.close();
});

it("task cancellation permanently blocks grants but permits known revoke/close and separately guarded stopped review", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE); s.control.current = false;
  await expect(tree.grant(PACKAGE)).rejects.toMatchObject({ code: "cancelled" }); await tree.revoke(PACKAGE);
  await expect(tree.snapshot()).rejects.toMatchObject({ code: "cancelled" });
  expect((await tree.snapshot(() => undefined)).length).toBe(1); s.control.current = true;
  await expect(tree.grant(PACKAGE)).rejects.toMatchObject({ code: "cancelled" }); await tree.close();
});

it.each(["close", "close throw", "free", "free throw", "extra handle rights"])("terminalizes %s uncertainty and never retries or continues cleanup", async fault => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); s.control.fault = fault;
  await expect(fault.startsWith("close") ? tree.close() : tree.assertPrivate()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  const count = s.calls.length; await expect(tree.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls).toHaveLength(count); expect(s.fence.retained).toHaveLength(1);
});

it("retains a possibly acquired raw handle and descriptor after a thrown CREATE_NEW without any continued free/close", async () => {
  const s = setup(); s.control.fault = "create throw";
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtCreateFile"); expect(s.fence.retained).toHaveLength(1); expect(s.handles.size).toBeGreaterThan(0);
});

it.each(["grant", "revoke"])("preserves every remaining owner after a partial %s mutation", async operation => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  if (operation === "revoke") await tree.grant(PACKAGE);
  s.control.failSet = s.sets() + 2;
  await expect(operation === "grant" ? tree.grant(PACKAGE) : tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtSetSecurityObject"); const count = s.calls.length;
  await expect(tree.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
});

it.each(["owner", "label", "ACL", "root", "reparse", "hardlink", "ADS", "case alias", "file limit"])("quarantines changed %s before revocation or private snapshot publication", async fault => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const root = s.root(), child = s.objects.get(path.join(tree.directory, "a.ts"))!;
  if (fault === "owner") s.control.owner = "S-1-5-21-9999";
  if (fault === "label") s.control.label = false;
  if (fault === "ACL") child.security.badMask = true;
  if (fault === "root") root.id += 1000n;
  if (fault === "reparse") child.attributes |= 0x400;
  if (fault === "hardlink") child.links = 2;
  if (fault === "ADS") child.streams = true;
  if (fault === "case alias") s.add(path.join(tree.directory, "A.ts"), "file", Buffer.alloc(0), { owner: OWNER, package: PACKAGE, inherited: true, low: true });
  if (fault === "file limit") child.bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
  await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); const count = s.calls.length;
  await expect(tree.snapshot(() => undefined)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
});

it.each(["S-1-15-2-1", OWNER, "S-1-15-2-1234;grant", ""])("refuses foreign package admission %s without mutating any ACL", async sid => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); const count = s.sets();
  await expect(tree.grant(sid)).rejects.toThrow(); expect(s.sets()).toBe(count); await tree.close();
});

it.each([
  { entries: [{ path: "../source/a.ts", kind: "file", bytes: Buffer.alloc(0), executable: false }] },
  { entries: [{ path: "a.ts:stream", kind: "file", bytes: Buffer.alloc(0), executable: false }] },
  { entries: [{ path: "a.ts", kind: "file", bytes: Buffer.alloc(0), executable: true }] },
  { entries: [{ path: "A.ts", kind: "directory" }, { path: "a.ts", kind: "directory" }] },
] satisfies { entries: CodingExportEntry[] }[])("rejects unsafe detached input before any native acquisition", async ({ entries }) => {
  const s = setup(); await expect(s.binding.createFreshWindowsCommandTree(s.input(entries))).rejects.toThrow(); expect(s.calls).toEqual([]);
});

it("pins a large protected tool by metadata without reading or granting it", async () => {
  const s = setup(); const asset = s.add("C:\\asset.exe", "file"); asset.reportedSize = 120 * 1024 * 1024;
  const input = s.input(); input.protectedPaths = ["C:\\source", "C:\\asset.exe"];
  const tree = await s.binding.createFreshWindowsCommandTree(input); await tree.grant(PACKAGE); await tree.revoke(PACKAGE); await tree.close();
  expect(s.opened.filter(row => row.object === asset).every(row => (row.access & (0x1f | 0x10000 | 0xc0000)) === 0)).toBe(true);
  expect(s.calls.some(call => ["NtReadFile", "NtWriteFile", "NtSetSecurityObject", "NtSetInformationFile"].includes(call.name) && s.opened.find(row => row.raw === call.args[0])?.object === asset)).toBe(false);
});

it("can revoke a known partially granted tree after task cancellation without renewing grant authority", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); s.control.retireOnSet = 1;
  await expect(tree.grant(PACKAGE)).rejects.toMatchObject({ code: "cancelled" }); expect(s.root().security.package).toBe(PACKAGE);
  expect(s.fence.failure).toBeUndefined(); await tree.revoke(PACKAGE); expect(s.root().security.package).toBeUndefined();
  await expect(tree.grant(PACKAGE, () => undefined)).rejects.toMatchObject({ code: "cancelled" }); await tree.close(); expect(s.handles.size).toBe(0);
});

it("cancellation while staging yields rolls back only the known fresh private tree", async () => {
  const s = setup(), entries = Array.from({ length: 40 }, (_, i): CodingExportEntry => ({ path: `f${i}.ts`, kind: "file", bytes: Buffer.from("bounded"), executable: false }));
  const promise = s.binding.createFreshWindowsCommandTree(s.input(entries)); setImmediate(() => { s.control.current = false; });
  await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  expect(s.fence.failure).toBeUndefined(); expect(s.handles.size).toBe(0);
  expect([...s.objects.values()].filter(row => row.name.includes("ember-command-")).every(row => row.removed)).toBe(true);
  expect(s.objects.get("C:\\source\\input.ts")!.removed).not.toBe(true);
});

it("a rejected explicit review guard publishes no bytes and never revives retired work authority", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); s.control.current = false;
  await expect(tree.snapshot()).rejects.toMatchObject({ code: "cancelled" }); const before = s.control.dataReads;
  await expect(tree.snapshot(() => { throw new Error("retired account"); })).rejects.toMatchObject({ code: "cancelled" }); expect(s.control.dataReads).toBe(before);
  await expect(tree.snapshot((() => Promise.resolve()) as unknown as () => void)).rejects.toMatchObject({ code: "cancelled" });
  await expect(tree.snapshot((() => true) as unknown as () => void)).rejects.toMatchObject({ code: "cancelled" });
  expect((await tree.snapshot(() => undefined)).length).toBe(1); await tree.close();
});

it("zeroes a partially read snapshot and closes its data handle after a known review revocation", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input([{ path: "large.ts", kind: "file", bytes: Buffer.alloc(2 * 1024 * 1024, 7), executable: false }]));
  await expect(tree.snapshot(() => { if (s.control.dataReads > 0) throw new Error("retired review"); })).rejects.toMatchObject({ code: "cancelled" });
  const reads = s.calls.filter(call => call.name === "NtReadFile"); expect(reads.length).toBeGreaterThan(0);
  for (const call of reads) expect((call.args[5] as Buffer).every(byte => byte === 0)).toBe(true);
  expect([...s.handles.values()].filter(handle => handle.object?.kind === "file").every(handle => !(handle.access & 1))).toBe(true);
  await tree.close(); expect(s.handles.size).toBe(0);
});

it("uses only relative component opens after the drive and refuses parent/protected overlap before creating anything", async () => {
  const s = setup(), input = s.input(); input.protectedPaths = ["C:\\scratch"];
  await expect(s.binding.createFreshWindowsCommandTree(input)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.opened.some(row => row.fresh)).toBe(false);
  expect(s.opened.filter(row => row.parent === 0n).every(row => row.object.name === "C:\\")).toBe(true);
});

it("cooperatively yields a bounded long grant, refuses concurrent calls and then safely revokes", async () => {
  const s = setup(), entries = Array.from({ length: 40 }, (_, i): CodingExportEntry => ({ path: `f${i}.ts`, kind: "file", bytes: Buffer.alloc(0), executable: false }));
  const tree = await s.binding.createFreshWindowsCommandTree(s.input(entries));
  let ran = false; const turn = new Promise<void>(resolve => setImmediate(() => { ran = true; resolve(); }));
  const granting = tree.grant(PACKAGE); await expect(tree.snapshot()).rejects.toThrow(); await turn; expect(ran).toBe(true); await granting;
  await tree.revoke(PACKAGE); await tree.close(); expect(s.handles.size).toBe(0);
});


it("does not trust a purported successful CREATE_NEW that reports an existing object", async () => {
  const s = setup(); s.control.fault = "not fresh";
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtCreateFile");
  expect(s.calls.some(call => ["NtWriteFile", "NtSetSecurityObject", "NtSetInformationFile"].includes(call.name))).toBe(false);
});


it("retains all peer native owners immediately when one owner loses cleanup certainty", async () => {
  const s = setup(), first = await s.binding.createFreshWindowsCommandTree(s.input()), second = await s.binding.createFreshWindowsCommandTree(s.input());
  s.control.fault = "close"; await expect(first.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.fence.retained).toHaveLength(2); const count = s.calls.length;
  await expect(second.snapshot()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); await expect(second.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
});

it.each(["depth", "total bytes"])("rejects current project-created descendants above the %s bound before reading data or restoring partial ACLs", async limit => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input([])); await tree.grant(PACKAGE);
  const sec = { owner: OWNER, package: PACKAGE, inherited: true, low: true };
  if (limit === "depth") { let directory = tree.directory; for (let i = 0; i < 33; i++) { directory = path.join(directory, "d"); s.add(directory, "directory", Buffer.alloc(0), sec); } }
  else for (let i = 0; i < 13; i++) s.add(path.join(tree.directory, `f${i}.ts`), "file", Buffer.alloc(0), sec).reportedSize = 8 * 1024 * 1024;
  const before = s.sets(); await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(before); expect(s.control.dataReads).toBe(0);
});

it("bounds the detached entry count before native ownership or allocation", async () => {
  const s = setup(), entries = Array.from({ length: 4001 }, (_, i): CodingExportEntry => ({ path: `f${i}.ts`, kind: "file", bytes: Buffer.alloc(0), executable: false }));
  await expect(s.binding.createFreshWindowsCommandTree(s.input(entries))).rejects.toThrow(); expect(s.calls).toEqual([]);
});


it.each(["descriptor false", "create status"])("retains allocator/acquisition outputs after %s without continued native cleanup", async fault => {
  const s = setup(); s.control.fault = fault;
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe(fault === "descriptor false" ? "ConvertStringSecurityDescriptorToSecurityDescriptorW" : "NtCreateFile");
  expect(s.fence.retained).toHaveLength(1);
});

it("verifies the whole tree is private before granting the first object", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  s.objects.get(path.join(tree.directory, "a.ts"))!.security.package = PACKAGE;
  await expect(tree.grant(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(0); expect(s.root().security.package).toBeUndefined();
});

it("accepts legitimate removal of an initially staged file using only positive held-object deletion evidence", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const removed = s.objects.get(path.join(tree.directory, "a.ts"))!;
  removed.removed = true; removed.links = 0; removed.deletePending = true;
  const before = s.calls.length; await tree.revoke(PACKAGE);
  expect(s.calls.slice(before).some(call => call.name === "GetFinalPathNameByHandleW" && s.opened.find(row => row.raw === call.args[0])?.object === removed)).toBe(false);
  expect(await tree.snapshot()).toEqual([]); expect([...s.handles.values()].some(handle => handle.object === removed)).toBe(false);
  await tree.close(); expect(s.handles.size).toBe(0);
});

it("accounts for removed initially staged directory descendants before enumerating the current tree", async () => {
  const s = setup(), entries: CodingExportEntry[] = [{ path: "src", kind: "directory" }, { path: "src/a.ts", kind: "file", bytes: Buffer.from("staged"), executable: false }];
  const tree = await s.binding.createFreshWindowsCommandTree(s.input(entries)); await tree.grant(PACKAGE);
  for (const row of s.objects.values()) if (row.name.startsWith(path.join(tree.directory, "src"))) { row.removed = true; row.links = 0; row.deletePending = true; }
  await tree.revoke(PACKAGE); expect(await tree.snapshot()).toEqual([]); await tree.close(); expect(s.handles.size).toBe(0);
});

it("follows current in-root names by held identity after a legitimate staged-file rename", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = path.join(tree.directory, "a.ts"), moved = s.objects.get(old)!; s.objects.delete(old); moved.name = path.join(tree.directory, "renamed.ts"); moved.changed++; s.objects.set(moved.name, moved);
  await tree.revoke(PACKAGE);
  expect(await tree.snapshot()).toEqual([{ path: "renamed.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]);
  await tree.close(); expect(s.handles.size).toBe(0); expect(s.objects.get("C:\\source\\input.ts")!.bytes.toString()).toBe("source remains untouched");
});

it("accepts a same-name replacement with a new inherited object while releasing the positively removed old object", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const name = path.join(tree.directory, "a.ts"), old = s.objects.get(name)!; old.removed = true; old.links = 0; old.deletePending = true;
  const replacement = s.add(name, "file", Buffer.from("replacement"), { owner: OWNER, package: PACKAGE, inherited: true, low: true });
  expect(replacement.id).not.toBe(old.id); await tree.revoke(PACKAGE);
  expect(await tree.snapshot()).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("replacement"), executable: false }]);
  expect([...s.handles.values()].some(handle => handle.object === old)).toBe(false); expect(replacement.security.package).toBeUndefined();
  await tree.close(); expect(s.handles.size).toBe(0);
});

it("accepts an in-place data edit without insisting on the staged bytes or old mutable timestamps", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const row = s.objects.get(path.join(tree.directory, "a.ts"))!; row.bytes = Buffer.from("edited"); row.written++; row.changed++;
  await tree.revoke(PACKAGE); expect(await tree.snapshot()).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("edited"), executable: false }]); await tree.close();
});

it.each(["moved outside", "pending outside", "unlinked without pending", "hardlinked pending"])("retains rather than misclassifies an old held object that is %s", async fault => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const name = path.join(tree.directory, "a.ts"), old = s.objects.get(name)!;
  if (fault === "moved outside" || fault === "pending outside") { s.objects.delete(name); old.name = "C:\\outside-profile\\a.ts"; s.objects.set(old.name, old); old.deletePending = fault === "pending outside"; }
  else { old.removed = true; old.links = fault === "hardlinked pending" ? 2 : 0; old.deletePending = fault === "hardlinked pending"; }
  const before = s.sets(); await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(before);
  expect([...s.handles.values()].some(handle => handle.object === old)).toBe(true);
});


it("accepts a positively delete-pending staged object only when its remaining name is still inside the fresh root", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = s.objects.get(path.join(tree.directory, "a.ts"))!; old.removed = true; old.deletePending = true;
  await tree.revoke(PACKAGE); expect(await tree.snapshot()).toEqual([]); await tree.close(); expect(s.handles.size).toBe(0);
});

it("does not guess that a failed pending-object name query means safe deletion", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = s.objects.get(path.join(tree.directory, "a.ts"))!; old.removed = true; old.deletePending = true; s.control.fault = "pending name failed";
  await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("GetFinalPathNameByHandleW"); expect([...s.handles.values()].some(handle => handle.object === old)).toBe(true);
});

it.each(["identity", "volume serial", "creation", "owner", "label", "ACL"])("does not release an unlinked old object with changed %s attestation", async field => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = s.objects.get(path.join(tree.directory, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true;
  if (field === "identity") old.id++;
  if (field === "volume serial") old.serial = 2;
  if (field === "creation") old.created++;
  if (field === "owner") old.security.owner = "S-1-5-21-9999";
  if (field === "label") old.security.low = false;
  if (field === "ACL") old.security.extra = true;
  const before = s.sets(); await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(before);
  expect([...s.handles.values()].some(handle => handle.object === old)).toBe(true);
});

it.each(["true", "false", "throw"])("rechecks peer uncertainty immediately after task-current callback returns %s before constructor admission", async outcome => {
  const s = setup(), peer = await s.binding.createFreshWindowsCommandTree(s.input());
  const old = s.objects.get(path.join(peer.directory, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true;
  let afterPeerFailure = -1;
  const input = s.input(); input.current = () => {
    s.control.fault = "close"; void peer.close().catch(() => undefined); afterPeerFailure = s.calls.length;
    if (outcome === "throw") throw new Error("retired task callback"); return outcome === "true";
  };
  await expect(s.binding.createFreshWindowsCommandTree(input)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.fence.failure).toBeInstanceOf(WindowsCommandCopyCleanupError); expect(afterPeerFailure).toBeGreaterThan(0);
  expect(s.calls).toHaveLength(afterPeerFailure); expect(s.calls.at(-1)!.name).toBe("CloseHandle");
});

it.each(["grant", "snapshot"])("does not query, acquire or mutate after a %s guard reentrantly poisons another live owner", async operation => {
  const s = setup(), owner = await s.binding.createFreshWindowsCommandTree(s.input()), peer = await s.binding.createFreshWindowsCommandTree(s.input());
  const old = s.objects.get(path.join(peer.directory, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true;
  let afterPeerFailure = -1;
  const check = () => { s.control.fault = "close"; void peer.close().catch(() => undefined); afterPeerFailure = s.calls.length; };
  await expect(operation === "grant" ? owner.grant(PACKAGE, check) : owner.snapshot(check)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls).toHaveLength(afterPeerFailure); const count = s.calls.length;
  await expect(owner.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
  expect(s.fence.retained).toHaveLength(2);
});

it("preserves an explicit typed cleanup error from an admission callback rather than reshaping it as cancellation", async () => {
  const s = setup(), owner = await s.binding.createFreshWindowsCommandTree(s.input()); const count = s.calls.length;
  await expect(owner.grant(PACKAGE, () => { throw new WindowsCommandCopyCleanupError(); })).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls).toHaveLength(count); expect(s.fence.retained).toHaveLength(1);
});


it.each([24, 37])("does not consume valid trailing stream-name bytes beyond declared information length %s", async length => {
  const s = setup(); s.control.streamBytes = length;
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtQueryInformationFile"); expect(s.calls.some(call => call.name === "NtWriteFile")).toBe(false);
});

it("rejects a successful stream-query return with a contradictory IO_STATUS_BLOCK status", async () => {
  const s = setup(); s.control.streamStatus = 0xc0000022;
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtQueryInformationFile");
});

it.each(["status", "zero length", "oversized length"])("rejects contradictory directory IO information: %s", async contradiction => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  if (contradiction === "status") s.control.directoryStatus = 0xc0000022;
  else s.control.directoryBytes = contradiction === "zero length" ? 0 : 1025;
  await expect(tree.grant(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtQueryDirectoryFile"); expect(s.sets()).toBe(0);
});


it("the emitted CommonJS default factory roots its trusted Koffi require at __filename before input refusal", async () => {
  const s = setup(), filename = "/trusted/ember/windows-command-copy-native.cjs", loads: string[] = [], requires: unknown[] = [];
  const source = readFileSync(new URL("../../app/main/agent/windows-command-copy-native.ts", import.meta.url), "utf8");
  const emitted = transformSync(source, { loader: "ts", format: "cjs", platform: "node", target: "node22" }).code;
  const module = { exports: {} as { createFreshWindowsCommandTree(input: FreshWindowsCommandTreeInput): Promise<unknown> } };
  const fake = setup();
  const native = { sizeof: () => 8, address: () => 1n, decode: Object.assign(() => Buffer.alloc(0), { string16: () => "" }), load(name: string) { loads.push(name); return { func: () => () => { throw new Error("No real native function belongs to the CJS loading test."); } }; } };
  const require = (name: string): unknown => {
    if (name === "node:path/win32") return path;
    if (name === "node:crypto") return { randomUUID };
    if (name === "node:module") return { createRequire(location: unknown) { requires.push(location); return (requested: string) => { expect(requested).toBe("koffi"); return native; }; } };
    if (name === "../platform/os") return { HOST_PLATFORM: "win32", HOST_ARCH: "x64" };
    if (name === "./coding-platform") return { ScopedCodingFileError };
    if (["./windows-coding-native", "./windows-coding-policy", "./windows-command-stop", "./windows-command-creator-token", "./windows-command-creator-profile"].includes(name)) return {};
    throw new Error("The fixed CJS module requested an unexpected import.");
  };
  runInNewContext(emitted, { module, exports: module.exports, require, __filename: filename, Buffer, setImmediate });
  const input = fake.input(); input.protectedPaths = [];
  await expect(module.exports.createFreshWindowsCommandTree(input)).rejects.toBeInstanceOf(ScopedCodingFileError);
  expect(requires).toEqual([filename]); expect(loads).toEqual(["ntdll.dll", "kernel32.dll", "advapi32.dll"]); expect(s.calls).toEqual([]); expect(fake.calls).toEqual([]);
});

it.skipIf(process.platform === "win32" && process.arch === "x64")("the default native factory refuses this unsupported host before loading a DLL", async () => {
  const s = setup(); await expect(createFreshWindowsCommandTree(s.input())).rejects.toMatchObject({ code: "unavailable" }); expect(s.calls).toEqual([]);
});
