/** Real Native grants and PreparingStop provenance with synthetic returned metadata; no Windows call runs. */
import path from "node:path/win32";
import { afterEach, expect, it, vi } from "vitest";
import { WindowsCommandCopyCleanupError, windowsCommandCopyNativeFailure } from "../../app/main/agent/windows-command-copy-native";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative } from "../../app/main/agent/windows-command-stop";
import { bindWindowsCommandCreatorProfileNative, closeWindowsCommandCreatorProfile, windowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import * as directory from "../../app/main/agent/windows-coding-native";
import { setup, OWNER, type ObjectRow } from "../fixtures/windows-command-creator-native-fake";

function freshProfile(text: string) {
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

async function prepared() {
  const s = setup(), ref = freshProfile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(ref).sidText;
  const tree = await s.binding.createFreshWindowsCommandTree({ ...s.input(), creatorProfile: ref });
  const api = { createJob: () => 50000n, assign() {}, resume() {}, terminateJob() {}, terminateProcess() {} } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = { configure() {}, assertLimits() {}, state: () => ({ total: 0, active: 0, pids: [] }),
    processId: () => 1, threadProcessId: () => 1, member: () => false, wait: () => 0, close() {} };
  const binding = {}, stop = createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, { retained: [] });
  const grant = tree.prepareCreator!(binding), file = s.objects.get(path.join(s.root().name, "a.ts"))!;
  return { s, ref, pkg, tree, stop, grant, file };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;
const rejected = async (work: Promise<unknown>): Promise<unknown> => {
  try { await work; } catch (error) { return error; }
  throw new Error("The metadata mutation must preserve the original refusal.");
};
function afterSet(v: Prepared, target: ObjectRow, mutate: () => void) {
  const original = v.s.handlers.SetSecurityInfo; let applied = false;
  v.s.handlers.SetSecurityInfo = (...args) => {
    const result = original(...args);
    if (!applied && v.s.handles.get(args[0] as bigint)?.object === target) { applied = true; mutate(); }
    return result;
  };
}
async function refusal(v: Prepared, constraint: number, changed?: number) {
  const error = await rejected(v.tree.grant(v.pkg));
  expect(error).toBeInstanceOf(WindowsCommandCopyCleanupError);
  const facts = windowsCommandCopyNativeFailure(error);
  expect(facts).toMatchObject({ stage: 6, operation: 0, predicate: 5, domain: 0, code: 0, metaConstraint: constraint });
  if (changed === undefined) expect(Object.hasOwn(facts!, "metaChanged")).toBe(false); else expect(facts!.metaChanged).toBe(changed);
  expect(v.s.control.dataReads).toBe(0);
  return { error, facts: facts! };
}
afterEach(() => { vi.restoreAllMocks(); });

it.each(["id", "volume", "kind", "created", "path"] as const)("records only the first actual node-identity difference for %s", async field => {
  const v = await prepared(), bits = { id: 1, volume: 2, kind: 4, created: 8, path: 16 };
  if (field === "volume") {
    const original = v.s.handlers.GetFinalPathNameByHandleW; let armed = false;
    afterSet(v, v.file, () => { armed = true; });
    v.s.handlers.GetFinalPathNameByHandleW = (...args) => {
      const length = original(...args) as number;
      if (armed && v.s.handles.get(args[0] as bigint)?.object === v.file) {
        const bytes = args[1] as Buffer, text = bytes.toString("utf16le", 0, length * 2).replace("12345678-1234", "22345678-1234");
        bytes.write(text, "utf16le"); return text.length;
      }
      return length;
    };
  } else afterSet(v, v.file, () => {
    if (field === "id") v.file.id++;
    if (field === "kind") v.file.attributes |= 16;
    if (field === "created") v.file.created++;
    if (field === "path") v.file.name = path.join(v.s.root().name, "renamed.ts");
  });
  const { facts } = await refusal(v, 1, bits[field]);
  expect(facts).toMatchObject({ nodeKind: 1, nodeRoot: 0, nodeAcl: 2, nodeDetached: 0 });
});

it.each(["size", "write", "attributes", "concurrent"] as const)("keeps pregrant payload refusal distinct from a successful setter readback (%s)", async field => {
  const v = await prepared(); afterSet(v, v.file, () => {
    if (field === "size" || field === "concurrent") v.file.bytes = Buffer.concat([v.file.bytes, Buffer.from("x")]);
    if (field === "write" || field === "concurrent") v.file.written++;
    if (field === "attributes" || field === "concurrent") v.file.attributes ^= 32;
  });
  await refusal(v, 9, field === "write" ? 64 : field === "attributes" ? 256 : 32);
});

it("attributes an actual protected-pin identity drift without inventing node context", async () => {
  const v = await prepared(); v.s.objects.get("C:\\source")!.created++;
  const { facts } = await refusal(v, 4, 8);
  expect(Object.hasOwn(facts, "nodeKind")).toBe(false); expect(v.s.sets()).toBe(0);
});

it("preserves root-before-parent comparison order and reports the first root field", async () => {
  const v = await prepared(); v.s.root().id++; v.s.root().created++;
  // The protected parent pin is deliberately unchanged until the root query, so root is the first rejecting guard.
  const original = v.s.handlers.GetFileInformationByHandle;
  v.s.handlers.GetFileInformationByHandle = (...args) => {
    if (v.s.handles.get(args[0] as bigint)?.object === v.s.root()) v.s.objects.get("C:\\scratch")!.created++;
    return original(...args);
  };
  await refusal(v, 2, 1);
});

it("records parent identity only when the existing root comparison succeeded", async () => {
  const v = await prepared(), original = v.s.handlers.GetFileInformationByHandle; let changed = false;
  v.s.handlers.GetFileInformationByHandle = (...args) => {
    if (!changed && v.s.handles.get(args[0] as bigint)?.object === v.s.root()) { changed = true; v.s.objects.get("C:\\scratch")!.created++; }
    return original(...args);
  };
  const { facts } = await refusal(v, 3, 8); expect(Object.hasOwn(facts, "nodeKind")).toBe(false);
});

it("reports a separately opened directory identity before any later root check", async () => {
  const v = await prepared(), original = v.s.handlers.GetFileInformationByHandle; let changed = false;
  v.s.handlers.GetFileInformationByHandle = (...args) => {
    const held = v.s.handles.get(args[0] as bigint);
    if (!changed && v.s.sets() >= 2 && held?.object === v.s.root() && held.access === 0x1200a9) { changed = true; v.s.root().created++; }
    return original(...args);
  };
  await refusal(v, 5, 8);
});

it("records a directory changing during final enumeration at its actual stability guard", async () => {
  const v = await prepared(), original = v.s.handlers.NtQueryDirectoryFile; let changed = false;
  v.s.handlers.NtQueryDirectoryFile = (...args) => {
    const value = original(...args);
    if (!changed && v.s.sets() >= 2) { changed = true; v.s.root().changed++; }
    return value;
  };
  await refusal(v, 6, 128);
});

it.each(["sealed", "original", "missing-original"] as const)("distinguishes the final %s guard without changing its acceptance", async mode => {
  const v = await prepared(); let armed = false;
  afterSet(v, v.file, () => { armed = true; });
  const original = v.s.handlers.GetFileInformationByHandle; let reads = 0;
  v.s.handlers.GetFileInformationByHandle = (...args) => {
    if (armed && v.s.handles.get(args[0] as bigint)?.object === v.file && ++reads === (mode === "sealed" ? 3 : 2)) {
      if (mode === "missing-original") v.file.id++; else v.file.created++;
    }
    return original(...args);
  };
  await refusal(v, mode === "sealed" ? 7 : mode === "original" ? 8 : 12, mode === "missing-original" ? 0 : 8);
});

it.each(["extra", "replacement"] as const)("keeps final %s count/identity refusal diagnostic-only", async mode => {
  const v = await prepared(); afterSet(v, v.file, () => {
    if (mode === "replacement") v.file.removed = true;
    v.s.add(path.join(v.s.root().name, mode === "extra" ? "extra.ts" : "a.ts"), "file", Buffer.from("fixed"),
      { owner: OWNER, aclOwner: OWNER, package: v.pkg, inherited: true, low: true });
  });
  await refusal(v, mode === "extra" ? 10 : 11, 0);
});

it("does not mistake a still-live retired pin for an unlinked object", async () => {
  const v = await prepared(); v.file.removed = true;
  await refusal(v, 14, 0);
});

it("reports the existing file bound without publishing its returned size", async () => {
  const v = await prepared(); v.file.reportedSize = 8 * 1024 * 1024 + 1;
  const { facts } = await refusal(v, 15, 0); expect(Object.keys(facts)).not.toContain("size");
});

it("keeps the first frozen witness private and performs no more Native calls after its fatal fence", async () => {
  const v = await prepared(); afterSet(v, v.file, () => { v.file.bytes = Buffer.concat([v.file.bytes, Buffer.from("x")]); });
  const { error, facts } = await refusal(v, 9, 32), count = v.s.calls.length;
  expect(Object.isFrozen(facts)).toBe(true); expect(() => Object.assign(facts, { metaConstraint: 1 })).toThrow();
  expect(windowsCommandCopyNativeFailure({ ...facts })).toBeUndefined(); expect(windowsCommandCopyNativeFailure(new WindowsCommandCopyCleanupError())).toBeUndefined();
  let touched = 0; Object.defineProperties(error, { message: { get() { touched++; throw new Error("PRIVATE metadata message"); } },
    stack: { get() { touched++; throw new Error("PRIVATE metadata stack"); } }, code: { get() { touched++; throw new Error("PRIVATE metadata code"); } } });
  const foreign = new Proxy(error as object, { get() { touched++; throw new Error("PRIVATE metadata proxy"); }, getPrototypeOf() { touched++; throw new Error("PRIVATE metadata prototype"); } });
  expect(windowsCommandCopyNativeFailure(foreign)).toBeUndefined();
  expect(windowsCommandCopyNativeFailure(error)).toBe(facts); expect(touched).toBe(0);
  await rejected(v.tree.snapshot()); await rejected(v.tree.grant(v.pkg)); await rejected(v.tree.close());
  expect(v.s.calls).toHaveLength(count); expect(windowsCommandCopyNativeFailure(error)).toBe(facts);
  expect(JSON.stringify(facts)).not.toMatch(/S-1-|C:\\|PRIVATE|pointer|handle|fileId|path/i);
});

it("does not carry a benign setter changeTime into a later different metadata refusal", async () => {
  const v = await prepared(); afterSet(v, v.s.root(), () => { v.s.root().changed++; });
  afterSet(v, v.file, () => { v.file.bytes = Buffer.concat([v.file.bytes, Buffer.from("x")]); });
  const { facts } = await refusal(v, 9, 32); expect(facts.metaChanged).not.toBe(128);
});

it("accepts a setter-only changeTime under the original identity and payload predicates", async () => {
  const v = await prepared(); afterSet(v, v.s.root(), () => { v.s.root().changed++; });
  await v.tree.grant(v.pkg); await v.tree.revokeCreator!(v.grant, await v.stop.stop()); await v.tree.close(); closeWindowsCommandCreatorProfile(v.ref);
  expect(v.s.fence.failure).toBeUndefined();
});

it("omits unknown entry projection while preserving the actual prior rejection and private error", async () => {
  const v = await prepared(), original = directory.decodeWindowsCodingDirectoryBatch; let afterRefusal = -1, privateReads = 0;
  // Negative decoder fault only: the real Native guard must already reject before the projection getter throws.
  vi.spyOn(directory, "decodeWindowsCodingDirectoryBatch").mockImplementation((...args) => original(...args).map(child => {
    if (v.s.sets() < 2) return child;
    let reads = 0;
    return new Proxy(child, { get(target, key, receiver) {
      if (key === "id") {
        if (++reads <= 2) return target.id;
        if (reads === 3) { afterRefusal = v.s.calls.length; return "ffffffffffffffff"; }
        privateReads++; throw new Error("PRIVATE directory projection path and identity");
      }
      return Reflect.get(target, key, receiver);
    } });
  }));
  const { facts } = await refusal(v, 13);
  expect(privateReads).toBe(1); expect(v.s.calls).toHaveLength(afterRefusal); expect(Object.hasOwn(facts, "nodeKind")).toBe(false);
  expect(JSON.stringify(facts)).not.toMatch(/PRIVATE|directory projection|path|identity/i);
});

it("leaves creator metadata failures outside grant admission in their previous diagnostic shape", async () => {
  const v = await prepared(); v.s.root().created++;
  const error = await rejected(v.tree.assertPrivate()), facts = windowsCommandCopyNativeFailure(error);
  expect(facts).toMatchObject({ stage: 5, operation: 0, predicate: 5 });
  expect(Object.hasOwn(facts!, "metaConstraint")).toBe(false); expect(Object.hasOwn(facts!, "metaChanged")).toBe(false);
});

it("leaves the ordinary non-creator grant's refusal unchanged", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()), row = s.objects.get(path.join(s.root().name, "a.ts"))!;
  const original = s.handlers.NtSetSecurityObject;
  s.handlers.NtSetSecurityObject = (...args) => { const value = original(...args); if (s.handles.get(args[0] as bigint)?.object === row) row.created++; return value; };
  const error = await rejected(tree.grant(s.control.tokenPackage)), facts = windowsCommandCopyNativeFailure(error);
  expect(facts).toMatchObject({ stage: 6, operation: 0, predicate: 5 });
  expect(Object.hasOwn(facts!, "metaConstraint")).toBe(false); expect(Object.hasOwn(facts!, "metaChanged")).toBe(false);
});
