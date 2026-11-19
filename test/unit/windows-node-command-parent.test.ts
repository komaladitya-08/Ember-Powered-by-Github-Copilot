/** Genuine resource/canonical/Copy issuers over DLL models. Authenticators are observed, never replaced with authority. */
import win from "node:path/win32";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsNodeResources } from "../fixtures/windows-node-resources-fake";

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ["node:module", "node:crypto", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.resetModules();
});
const argv = ["--preserve-symlinks", "--preserve-symlinks-main", "app.ts"];
async function open(admit?: (f: Awaited<ReturnType<typeof setupWindowsNodeResources>>) => boolean) {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner);
  const workspace = await owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => admit ? admit(f) : true);
  return { ...f, owner, workspace };
}
type Fixture = Awaited<ReturnType<typeof open>>;
function role(f: Fixture, name: string) {
  return [...f.canonical.nodes.values()].find(row => row.info.finalPath.includes("\\process-") &&
    (name === "process" ? !row.info.finalPath.slice(row.info.finalPath.indexOf("\\process-") + 1).includes("\\") : row.info.finalPath.endsWith("\\" + name)))!;
}
function common(f: Fixture) { return f.canonical.nodes.get(f.canonical.location(f.common).toLowerCase())!; }
function assertNoCommand(f: Fixture) {
  expect(f.io.state.creates).toBe(0); expect(f.io.events).not.toContain("resume");
  expect([...f.io.source.objects.values()].some(row => /\\ember-command-/.test(row.name))).toBe(false);
}
async function retained(f: Fixture) {
  await expect(f.workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  assertNoCommand(f);
  const info = vi.spyOn(f.canonical.api, "info"), counts = [f.asset.calls.length, f.nativeCalls.length];
  await expect(f.owner.close()).rejects.toThrow(); expect(info).not.toHaveBeenCalled();
  expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(counts); expect(f.profileState.deleted).toHaveLength(0);
}

it.each(["common", "process", "copies", "reviews", "assets"])("a changed %s identity after workspace creation cannot authorize a command", async name => {
  const f = await open(), row = name === "common" ? common(f) : role(f, name);
  row.info.id = String(BigInt(row.info.id) + 10000n); await retained(f);
});
it.each(["common", "process", "copies", "reviews", "assets"])("a changed %s ACL after workspace creation is typed retained uncertainty", async name => {
  const f = await open(); (name === "common" ? common(f) : role(f, name)).private = false; await retained(f);
});
it("an extra process namespace member fails before command creation and cannot be hidden by valid role names", async () => {
  const f = await open(), process = role(f, "process"), volume = f.canonical.location("C:\\");
  f.canonical.directory("C:\\" + process.info.finalPath.slice(volume.length) + "\\foreign"); await retained(f);
});
it("duplicate directory records cannot stand in for a missing expected resource role", async () => {
  const f = await open(), process = role(f, "process"), list = f.canonical.api.list;
  vi.spyOn(f.canonical.api, "list").mockImplementation((handle, maximum) => {
    const rows = list(handle, maximum);
    return f.canonical.api.info(handle).finalPath === process.info.finalPath && rows.length === 3 ? [rows[0], rows[0], rows[2]] : rows;
  });
  // Retention observation starts after the injected query seam: no retry is allowed behind this fence.
  await expect(f.workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  assertNoCommand(f); expect(f.profileState.deleted).toHaveLength(0);
});

it.each(["common", "ancestor", "process", "copies", "reviews", "assets"])("source selection cannot name the protected %s namespace", async name => {
  const f = await open(), volume = f.canonical.location("C:\\"), selected = name === "common" ? f.common : name === "ancestor" ? win.dirname(f.common)
    : "C:\\" + role(f, name).info.finalPath.slice(volume.length);
  const created = f.profileState.created.length;
  await expect(f.owner.validateSource({ path: selected, current: () => true })).rejects.toThrow("grant changed");
  expect(f.profileState.created).toHaveLength(created); assertNoCommand(f); await f.owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it.each(["hardlink", "reparse", "junction"])("the original canonical Native %s denial still prevents any Node profile or execution", async kind => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner);
  if (kind === "hardlink") f.canonical.nodes.get(f.canonical.location("C:\\project\\app.ts").toLowerCase())!.info.links = 2;
  else {
    const absolute = "C:\\project\\alias", row = kind === "junction" ? f.canonical.directory(absolute) : f.canonical.put(absolute, "untrusted"); row.info.attributes |= 0x400;
    const info = f.canonical.api.info, { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
    // Native's reparse refusal is a low-level boundary fault seam; no canonical/command issuer is replaced.
    vi.spyOn(f.canonical.api, "info").mockImplementation(handle => { const result = info(handle); if (result.attributes & 0x400) throw new ScopedCodingFileError("unsupported"); return result; });
  }
  await expect(owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true)).rejects.toThrow();
  expect(f.profileState.created).toHaveLength(0); expect(f.io.state.creates).toBe(0); await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("rejects serialized/proxy parent claims, inspect-only consumption and post-run replay without another native query", async () => {
  const f = await open(), canonical = await import("../../app/main/agent/windows-coding-copy"), original = canonical.inspectWindowsCodingCommandParent;
  const copy = await import("../../app/main/agent/windows-command-copy"), take = canonical.takeWindowsCodingCommandInput;
  let captured: Parameters<typeof original>[0] | undefined, input: Parameters<typeof take>[0] | undefined, intake: Parameters<typeof take>[1] | undefined, inspected = 0;
  vi.spyOn(canonical, "takeWindowsCodingCommandInput").mockImplementation(function (this: unknown, ...args) { const data = take.apply(this, args); input = args[0]; intake = args[1]; return data; });
  vi.spyOn(canonical, "inspectWindowsCodingCommandParent").mockImplementation(function (this: unknown, ref, parent, paths, actualIntake) {
    for (const candidate of [{ scope: ref.scope }, new Proxy(ref, { get() { throw new Error("PRIVATE proxy trap"); } })]) {
      expect(() => original.call(this, candidate as typeof ref, parent, paths, actualIntake)).toThrow(expect.objectContaining({ code: "boundary" }));
    }
    captured = ref; const result = original.call(this, ref, parent, paths, actualIntake); inspected++;
    expect(() => canonical.consumeWindowsCodingCommandParent(ref)).toThrow(expect.objectContaining({ code: "boundary" })); return result;
  });
  expect(await f.workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).toMatchObject({ observed: true, exitCode: 0 });
  expect(inspected).toBe(1); const info = vi.spyOn(f.canonical.api, "info"), counts = [f.asset.calls.length, f.nativeCalls.length];
  expect(() => canonical.inspectWindowsCodingCommandParent(captured!, "C:\\foreign", [], intake!)).toThrow(expect.objectContaining({ code: "boundary" }));
  expect(() => canonical.refreshWindowsCodingCommandParent(captured!, intake!)).toThrow(expect.objectContaining({ code: "boundary" }));
  expect(() => canonical.consumeWindowsCodingCommandParent(captured!)).toThrow(expect.objectContaining({ code: "boundary" }));
  expect(() => copy.requireWindowsCommandInputProducerPreparing(input!, intake!)).toThrow(expect.objectContaining({ code: "cancelled" }));
  for (const ref of [{ scope: input!.scope }, new Proxy(input!, {})]) expect(() => copy.requireWindowsCommandInputProducerPreparing(ref as NonNullable<typeof input>, intake!))
    .toThrow(expect.objectContaining({ code: "boundary" }));
  expect(info).not.toHaveBeenCalled(); expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(counts);
  await f.owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("serialized and Proxy resource receipts never query native state or grant canonical parent authority", async () => {
  const f = await open(), resource = await import("../../app/main/agent/windows-coding-resources"), original = resource.requireWindowsOwnedCommandParent;
  let seen = 0, traps = 0;
  vi.spyOn(resource, "requireWindowsOwnedCommandParent").mockImplementation(function (this: unknown, ref) {
    const info = vi.spyOn(f.canonical.api, "info"), calls = info.mock.calls.length;
    for (const candidate of [{ scope: ref.scope }, new Proxy(ref, { get() { traps++; throw new Error("PRIVATE resource trap"); } })]) {
      expect(() => original.call(this, candidate as typeof ref)).toThrow(expect.objectContaining({ code: "boundary" }));
    }
    expect(info).toHaveBeenCalledTimes(calls); seen++; return original.call(this, ref);
  });
  expect(await f.workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).toMatchObject({ observed: true, exitCode: 0 });
  expect(seen).toBeGreaterThan(0); expect(traps).toBe(0); await f.owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("retirement from the last admission callback cannot revive a checked input or reach a fresh command child", async () => {
  let armed = false, retired = false;
  const f = await open(base => { if (armed && !retired) { retired = true; base.task.abort(); } return true; }),
    canonical = await import("../../app/main/agent/windows-coding-copy"), original = canonical.inspectWindowsCodingCommandParent;
  let captured: Parameters<typeof original>[0] | undefined, intake: Parameters<typeof original>[3] | undefined;
  vi.spyOn(canonical, "inspectWindowsCodingCommandParent").mockImplementation(function (this: unknown, ...args) {
    const result = original.apply(this, args); captured = args[0]; intake = args[3]; armed = true; return result;
  });
  await expect(f.workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).rejects.toMatchObject({ code: "cancelled" });
  assertNoCommand(f); expect(retired).toBe(true); expect((Reflect.get(f.workspace, "signal") as AbortSignal).aborted).toBe(true);
  await f.workspace.sealForReview!(); const output = await f.workspace.exportReview(f.owner.reviewBase);
  expect(output.review.proposed).toEqual(output.review.baseline); expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
  const info = vi.spyOn(f.canonical.api, "info"), counts = [f.asset.calls.length, f.nativeCalls.length];
  expect(() => canonical.refreshWindowsCodingCommandParent(captured!, intake!)).toThrow();
  expect(() => canonical.consumeWindowsCodingCommandParent(captured!)).toThrow();
  expect(info).not.toHaveBeenCalled(); expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(counts);
  await f.owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it.each(["parent-common", "parent-ancestor", "parent-sibling", "parent-external", "protected-drop", "protected-add", "protected-duplicate"])("a genuine input's exception cannot authorize a substituted %s", async field => {
  const f = await open(), canonical = await import("../../app/main/agent/windows-coding-copy"), original = canonical.inspectWindowsCodingCommandParent;
  vi.spyOn(canonical, "inspectWindowsCodingCommandParent").mockImplementation(function (this: unknown, ref, parent, paths, actualIntake) {
    const wrongParent = field === "parent-common" ? f.common : field === "parent-ancestor" ? win.dirname(f.common)
      : field === "parent-sibling" ? win.join(win.dirname(parent), "reviews") : field === "parent-external" ? "C:\\copies" : parent;
    const wrongPaths = field === "protected-drop" ? paths.filter(path => path !== f.common) : field === "protected-add" ? [...paths, win.dirname(f.common)]
      : field === "protected-duplicate" ? [...paths, f.common] : paths;
    expect(() => original.call(this, ref, wrongParent, wrongPaths, actualIntake))
      .toThrow(expect.objectContaining({ code: "boundary" }));
    return original.call(this, ref, parent, paths, actualIntake);
  });
  await retained(f);
});

it.each(["copies-id", "copies-created", "copies-path", "common-id", "common-created", "common-path"])("the actual Native %s must match the canonical/resource receipt", async change => {
  const f = await open(), selected = change.startsWith("copies") ? role(f, "copies") : common(f), volume = f.canonical.location("C:\\"),
    row = f.io.source.objects.get("C:\\" + selected.info.finalPath.slice(volume.length))!;
  if (change.endsWith("-id")) row.id += 100000n;
  else if (change.endsWith("-created")) row.created++;
  else row.name += "-moved";
  await retained(f);
});

it("a genuine taken input cannot authorize a parent before its exact preparing producer is attached", async () => {
  const f = await open(), canonical = await import("../../app/main/agent/windows-coding-copy"), original = canonical.takeWindowsCodingCommandInput;
  let reached = false;
  // Observe the genuine consumer and forward its exact result. The adversarial read occurs before
  // Copy has attached its private producer; no issuer, bytes, profile or positive result is substituted.
  vi.spyOn(canonical, "takeWindowsCodingCommandInput").mockImplementation(function (this: unknown, ...args) {
    const data = original.apply(this, args); reached = true;
    expect(() => canonical.inspectWindowsCodingCommandParent(data.commandParent!, data.parent, data.protectedPaths, args[1]))
      .toThrow(expect.objectContaining({ code: "boundary" }));
    return data;
  });
  await retained(f); expect(reached).toBe(true);
});

it("the historical native factory retains its strict protected-ancestor refusal without a genuine input exception", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(), native = await import("../../app/main/agent/windows-command-copy-native"),
    volume = f.canonical.location("C:\\"), copies = [...f.canonical.nodes.values()].find(row => row.info.finalPath.includes("\\process-") && row.info.finalPath.endsWith("\\copies"))!;
  const input = { parent: "C:\\" + copies.info.finalPath.slice(volume.length), protectedPaths: [f.common],
    entries: [{ path: "safe.txt", kind: "file" as const, bytes: Buffer.from("safe"), executable: false }], current: () => true };
  await expect(native.createFreshWindowsCommandTree(input)).rejects.toMatchObject({ code: "windows-command-copy-cleanup-unverified" });
  expect([...f.io.source.objects.values()].some(row => /\\ember-command-/.test(row.name))).toBe(false);
  const calls = f.nativeCalls.length; await expect(native.createFreshWindowsCommandTree(input)).rejects.toMatchObject({ code: "windows-command-copy-cleanup-unverified" });
  expect(f.nativeCalls).toHaveLength(calls); expect(f.profileState.created).toHaveLength(0);
  expect(owner.availability().mode).toBe("commands"); // Owners remain retained; this test never certifies their disposal.
});

it("a last admission callback's ACL mutation is caught by ownership-only refresh before the first fresh command child", async () => {
  let armed = false, changed = 0;
  const f = await open(base => {
    if (armed && !changed) { changed++; [...base.canonical.nodes.values()].find(row => row.info.finalPath.includes("\\process-") && row.info.finalPath.endsWith("\\reviews"))!.private = false; }
    return true;
  });
  const canonical = await import("../../app/main/agent/windows-coding-copy"), original = canonical.inspectWindowsCodingCommandParent;
  vi.spyOn(canonical, "inspectWindowsCodingCommandParent").mockImplementation(function (this: unknown, ...args) {
    const result = original.apply(this, args); armed = true; return result;
  });
  await retained(f); expect(armed).toBe(true); expect(changed).toBe(1);
});

it("two genuine simultaneously preparing inputs cannot swap parent authority across their exact intake pair", async () => {
  const f = await setupWindowsNodeResources();
  let extra = "C:\\external"; f.canonical.directory(extra);
  for (const part of ["a", "b", "c", "d", "e", "f", "g", "h"]) { extra = win.join(extra, part); f.canonical.directory(extra); }
  // The extra genuine protected root makes both native pin walks reach their existing asynchronous yield.
  f.options.protectedPaths.push(extra); const owner = await f.open(); await f.bind(owner);
  const a = await owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true), b = await owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true),
    canonical = await import("../../app/main/agent/windows-coding-copy"), copy = await import("../../app/main/agent/windows-command-copy"), originalTake = canonical.takeWindowsCodingCommandInput;
  const context = new AsyncLocalStorage<"a" | "b">(), inputs = new Map<"a" | "b", { ref: Parameters<typeof originalTake>[0]; intake: Parameters<typeof originalTake>[1]; data: ReturnType<typeof originalTake> }>();
  vi.spyOn(canonical, "takeWindowsCodingCommandInput").mockImplementation(function (this: unknown, ...args) {
    const data = originalTake.apply(this, args), selected = context.getStore(); if (selected) inputs.set(selected, { ref: args[0], intake: args[1], data }); return data;
  });
  let reachedA!: () => void, reachedB!: () => void;
  const waitA = new Promise<void>(resolve => { reachedA = resolve; }), waitB = new Promise<void>(resolve => { reachedB = resolve; }), held = new Map<"a" | "b", () => void>();
  const immediate = globalThis.setImmediate;
  const schedule = vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    const selected = context.getStore();
    if (selected && inputs.has(selected) && !held.has(selected)) {
      let called = false;
      held.set(selected, () => { if (!called) { called = true; callback(...args); } }); if (selected === "a") reachedA(); else reachedB(); return immediate(() => undefined);
    }
    return immediate(callback, ...args);
  }) as typeof setImmediate);
  const runA = context.run("a", () => a.runNode!(argv, "\\work", () => undefined, f.task.signal)).catch(error => error);
  let runB: Promise<unknown> | undefined;
  try {
    await waitA; runB = context.run("b", () => b.runNode!(argv, "\\work", () => undefined, f.task.signal)).catch(error => error); await waitB;
    const first = inputs.get("a")!, second = inputs.get("b")!;
    expect(() => copy.requireWindowsCommandInputProducerPreparing(first.ref, first.intake)).not.toThrow();
    expect(() => copy.requireWindowsCommandInputProducerPreparing(second.ref, second.intake)).not.toThrow();
    expect(first.intake).not.toBe(second.intake); expect(first.data.parent).toBe(second.data.parent); expect(first.data.protectedPaths).toEqual(second.data.protectedPaths);
    const info = vi.spyOn(f.canonical.api, "info"), calls = info.mock.calls.length, native = [f.asset.calls.length, f.nativeCalls.length];
    expect(() => canonical.inspectWindowsCodingCommandParent(first.data.commandParent!, second.data.parent, second.data.protectedPaths, second.intake))
      .toThrow(expect.objectContaining({ code: "boundary" }));
    expect(info).toHaveBeenCalledTimes(calls); expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(native);
    held.get("a")!(); expect(await runA).toMatchObject({ code: "windows-coding-cleanup-unverified" });
    held.get("b")!(); expect(await runB).toMatchObject({ code: "windows-coding-cleanup-unverified" });
    expect(f.io.state.creates).toBe(0); expect([...f.io.source.objects.values()].some(row => /\\ember-command-/.test(row.name))).toBe(false);
    expect(f.profileState.created).toHaveLength(2); expect(f.profileState.deleted).toHaveLength(0);
  } finally { schedule.mockRestore(); held.get("a")?.(); held.get("b")?.(); await Promise.all([runA, runB]); }
});
