/** Evidence-only ACL diagnostics through the real native owner; no Windows call or SID/path disclosure occurs. */
import { expect, it } from "vitest";
import { WindowsCommandCopyCleanupError, windowsCommandCopyNativeFailure } from "../../app/main/agent/windows-command-copy-native";
import { setup, PACKAGE } from "../fixtures/windows-command-creator-native-fake";

type Model = ReturnType<typeof setup>;
type Kind = "dacl" | "label";
type Mutation = (header: Buffer) => Buffer;
const rejected = async (pending: Promise<unknown>): Promise<unknown> => {
  try { await pending; } catch (error) { return error; }
  throw new Error("The fixed ACL fault must refuse.");
};
function instrument(s: Model, target: Kind, mutate: Mutation, options: { armed?(): boolean; replaceSid?: string } = {}) {
  const decode = s.native.decode, call = decode as unknown as (...args: unknown[]) => unknown;
  const string = decode.string16 as unknown as (pointer: unknown) => unknown;
  const aceIndex = new Map<bigint, number>(), sidKind = new Map<bigint, { kind: Kind; index: number }>(), textOverride = new Map<unknown, string>();
  const queries: { kind: Kind; index: number }[] = [];
  const getAce = s.handlers.GetAce, convert = s.handlers.ConvertSidToStringSidW;
  s.handlers.GetAce = (...args) => {
    const result = getAce(...args), pointer = (args[2] as unknown[])[0];
    if (typeof pointer === "bigint") aceIndex.set(pointer, Number(args[1]));
    return result;
  };
  s.handlers.ConvertSidToStringSidW = (...args) => {
    const result = convert(...args), source = sidKind.get(args[0] as bigint);
    if (source) {
      queries.push(source);
      if (source.kind === "dacl" && source.index === 0 && options.replaceSid) textOverride.set((args[1] as unknown[])[0], options.replaceSid);
    }
    return result;
  };
  const wrapped = Object.assign((...args: unknown[]) => {
    const returned = call(...args);
    if (!Buffer.isBuffer(returned)) return returned;
    const header = Buffer.from(returned), kind: Kind = header[0] === 17 ? "label" : "dacl";
    if (typeof args[0] === "bigint") sidKind.set(args[0] + 8n, { kind, index: aceIndex.get(args[0]) ?? 0 });
    return kind === target && (options.armed?.() ?? true) ? mutate(header) : header;
  }, decode, { string16(pointer: unknown) { return textOverride.get(pointer) ?? string(pointer); } });
  Object.defineProperty(s.native, "decode", { value: wrapped, configurable: true, writable: true });
  return { queries };
}
const change = (edit: (header: Buffer) => void): Mutation => header => { edit(header); return header; };
const faults = [
  { name: "DACL length", target: "dacl", constraint: 1, mutate: (header: Buffer) => header.subarray(0, 7) },
  { name: "DACL type", target: "dacl", constraint: 2, mutate: change(header => { header[0] = 1; }) },
  { name: "DACL flags", target: "dacl", constraint: 3, mutate: change(header => { header[1] = 0; }) },
  { name: "DACL size", target: "dacl", constraint: 4, mutate: change(header => { header.writeUInt16LE(11, 2); }) },
  { name: "DACL set", target: "dacl", constraint: 5, mutate: change(header => { header.writeUInt32LE(0xffffffff, 4); }) },
  { name: "label length", target: "label", constraint: 6, mutate: (header: Buffer) => header.subarray(0, 7) },
  { name: "label type", target: "label", constraint: 7, mutate: change(header => { header[0] = 0; }) },
  { name: "label flags", target: "label", constraint: 8, mutate: change(header => { header[1] = 0; }) },
  { name: "label mask", target: "label", constraint: 9, mutate: change(header => { header.writeUInt32LE(0xffffffff, 4); }) },
  { name: "label size", target: "label", constraint: 10, mutate: change(header => { header.writeUInt16LE(77, 2); }) },
  { name: "label SID", target: "label", constraint: 11, mutate: (header: Buffer) => header },
] as const;

it.each(faults)("records only the existing $name predicate and closed node context", async ({ target, constraint, mutate }) => {
  const s = setup(), tracking = instrument(s, target, mutate);
  if (constraint === 11) s.control.label = false;
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input()));
  expect(error).toBeInstanceOf(WindowsCommandCopyCleanupError);
  const receipt = windowsCommandCopyNativeFailure(error);
  expect(receipt).toMatchObject({ operation: 27, predicate: 7, domain: 0, code: 0, aceConstraint: constraint, nodeKind: 2, nodeRoot: 1, nodeAcl: 1, nodeDetached: 0 });
  expect(Object.isFrozen(receipt)).toBe(true);
  if (constraint === 1 || constraint === 6 || constraint === 5) expect(receipt?.aceHeader).toBeUndefined();
  else { expect(Object.isFrozen(receipt?.aceHeader)).toBe(true); expect(receipt?.aceHeader?.expectedFlags).toBe(3); }
  if (constraint === 5) {
    expect(receipt?.aceRows).toHaveLength(2); expect(Object.isFrozen(receipt?.aceRows)).toBe(true);
    expect(receipt?.aceRows?.every(row => Object.isFrozen(row))).toBe(true);
  } else expect(receipt?.aceRows).toBeUndefined();
  expect(tracking.queries.filter(query => query.kind === "label")).toHaveLength(constraint === 11 ? 1 : 0);
  if (constraint <= 4) expect(tracking.queries.filter(query => query.kind === "dacl")).toHaveLength(0);
  expect(s.calls.some(call => call.name === "GetLastError")).toBe(false);
  expect(s.control.dataReads).toBe(0);
  const count = s.calls.length;
  expect(await rejected(s.binding.createFreshWindowsCommandTree(s.input()))).toBe(error); expect(s.calls).toHaveLength(count);
});

it.each([
  { constraint: 1, target: "dacl", length: 7, type: 1, flags: 0, mask: 0xffffffff, size: 11 },
  { constraint: 2, target: "dacl", length: 8, type: 1, flags: 0, mask: 0xffffffff, size: 11 },
  { constraint: 3, target: "dacl", length: 8, type: 0, flags: 0, mask: 0xffffffff, size: 11 },
  { constraint: 4, target: "dacl", length: 8, type: 0, flags: 3, mask: 0xffffffff, size: 11 },
  { constraint: 6, target: "label", length: 7, type: 0, flags: 0, mask: 0xffffffff, size: 11 },
  { constraint: 7, target: "label", length: 8, type: 0, flags: 0, mask: 0xffffffff, size: 11 },
  { constraint: 8, target: "label", length: 8, type: 17, flags: 0, mask: 0xffffffff, size: 11 },
  { constraint: 9, target: "label", length: 8, type: 17, flags: 3, mask: 0xffffffff, size: 11 },
  { constraint: 10, target: "label", length: 8, type: 17, flags: 3, mask: 1, size: 11 },
] as const)("preserves first-OR precedence for constraint $constraint without another SID query", async item => {
  const s = setup(), tracking = instrument(s, item.target, header => {
    header[0] = item.type; header[1] = item.flags; header.writeUInt16LE(item.size, 2); header.writeUInt32LE(item.mask, 4);
    return header.subarray(0, item.length);
  });
  s.control.label = false;
  const receipt = windowsCommandCopyNativeFailure(await rejected(s.binding.createFreshWindowsCommandTree(s.input())));
  expect(receipt?.aceConstraint).toBe(item.constraint);
  expect(tracking.queries.filter(query => query.kind === "label")).toHaveLength(0);
});

it.each([11, 77, 0xffff])("preserves the DACL/label size refusal bound %i without SID queries", async size => {
  for (const target of ["dacl", "label"] as const) {
    const s = setup(), tracking = instrument(s, target, change(header => { header.writeUInt16LE(size, 2); }));
    const receipt = windowsCommandCopyNativeFailure(await rejected(s.binding.createFreshWindowsCommandTree(s.input())));
    expect(receipt?.aceConstraint).toBe(target === "dacl" ? 4 : 10);
    expect(receipt?.aceHeader?.size).toBe(size); expect(tracking.queries.filter(query => query.kind === target)).toHaveLength(0);
  }
});

it("keeps exact eight-byte header scalars unsigned and deeply frozen without raw buffer or identity fields", async () => {
  const s = setup(); instrument(s, "dacl", change(header => { header[0] = 0xff; header[1] = 0xff; header.writeUInt16LE(0xffff, 2); header.writeUInt32LE(0xffffffff, 4); }));
  const error = await rejected(s.binding.createFreshWindowsCommandTree(s.input())), receipt = windowsCommandCopyNativeFailure(error)!;
  expect(receipt.aceHeader).toEqual({ type: 255, flags: 255, size: 65535, mask: 0xffffffff, expectedFlags: 3 });
  expect(Reflect.set(receipt.aceHeader!, "mask", 0)).toBe(false);
  expect(windowsCommandCopyNativeFailure(error)).toBe(receipt);
  for (const foreign of [{ ...error as object }, { ...receipt }, JSON.parse(JSON.stringify(receipt)), JSON.parse(JSON.stringify(error))]) expect(windowsCommandCopyNativeFailure(foreign)).toBeUndefined();
  const encoded = JSON.stringify(receipt); expect(encoded).not.toMatch(/S-1-|C:|bytes|pointer|path|handle/i);
});

it.each([
  { replacement: undefined, classes: [1, 3] },
  { replacement: "S-1-5-32-544", classes: [4, 3] },
  { replacement: "S-1-5-21-900-901-902-1002", classes: [5, 3] },
])("projects exact DACL-set rows into bounded known SID classes $classes", async ({ replacement, classes }) => {
  const s = setup(); instrument(s, "dacl", change(header => { header.writeUInt32LE(0xffffffff, 4); }), { replaceSid: replacement });
  const receipt = windowsCommandCopyNativeFailure(await rejected(s.binding.createFreshWindowsCommandTree(s.input())))!;
  expect(receipt.aceConstraint).toBe(5); expect(receipt.aceRows).toEqual(classes.map(sidClass => ({ sidClass, mask: 0xffffffff })));
  expect(receipt.aceRows).toHaveLength(2); expect(receipt.aceHeader).toBeUndefined();
  expect(Object.isFrozen(receipt.aceRows)).toBe(true); for (const row of receipt.aceRows!) { expect(Object.isFrozen(row)).toBe(true); expect(Reflect.set(row, "sidClass", 5)).toBe(false); }
  expect(JSON.stringify(receipt)).not.toMatch(/S-1-|C:|pointer|path|handle/i);
});

it("records exactly three granted DACL rows in original order, including the package class", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  instrument(s, "dacl", change(header => { header.writeUInt32LE(0xffffffff, 4); }), { armed: () => s.root().security.package === PACKAGE });
  const receipt = windowsCommandCopyNativeFailure(await rejected(tree.grant(PACKAGE)))!;
  expect(receipt).toMatchObject({ aceConstraint: 5, nodeKind: 2, nodeRoot: 1, nodeAcl: 2, nodeDetached: 0 });
  expect(receipt.aceRows).toEqual([1, 3, 2].map(sidClass => ({ sidClass, mask: 0xffffffff })));
  expect(receipt.aceRows?.length).toBeLessThanOrEqual(3); expect(Object.isFrozen(receipt.aceRows)).toBe(true);
});

it.each(["private", "inherited", "detached"] as const)("records the actual %s file context rather than a root-directory placeholder", async mode => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  let current: { kind: string; security: { inherited: boolean }; removed?: boolean } | undefined;
  const security = s.handlers.GetSecurityInfo;
  s.handlers.GetSecurityInfo = (...args) => { current = s.handles.get(args[0] as bigint)?.object; return security(...args); };
  if (mode !== "private") await tree.grant(PACKAGE);
  if (mode === "inherited") s.add(`${s.root().name}\\new.txt`, "file", Buffer.from("fixed"), { owner: s.control.owner, aclOwner: s.control.owner, package: PACKAGE, inherited: true, low: true });
  if (mode === "detached") { const file = s.objects.get(`${s.root().name}\\a.ts`)!; file.removed = true; file.links = 0; file.deletePending = true; }
  instrument(s, "dacl", change(header => { header[0] = 1; }), { armed: () => current?.kind === "file" &&
    (mode === "private" || mode === "inherited" ? mode === "private" || current.security.inherited : current.removed === true) });
  const error = await rejected(mode === "private" ? tree.assertPrivate() : tree.revoke(PACKAGE)), receipt = windowsCommandCopyNativeFailure(error)!;
  expect(receipt).toMatchObject({ aceConstraint: 2, nodeKind: 1, nodeRoot: 0, nodeAcl: mode === "private" ? 1 : mode === "inherited" ? 3 : 2,
    nodeDetached: mode === "detached" ? 1 : 0 });
  expect(receipt.aceHeader?.expectedFlags).toBe(mode === "inherited" ? 16 : 0);
});

it.each(["dacl", "label"] as const)("does not publish a header from oversized %s bytes", async target => {
  const s = setup(); instrument(s, target, header => Buffer.concat([header, Buffer.from([0xab])]));
  const receipt = windowsCommandCopyNativeFailure(await rejected(s.binding.createFreshWindowsCommandTree(s.input())))!;
  expect(receipt.aceConstraint).toBe(target === "dacl" ? 1 : 6); expect(receipt.aceHeader).toBeUndefined();
});

it("retains the same first ACE failure and suppresses every later close, read and grant call", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); instrument(s, "label", change(header => { header.writeUInt32LE(0xffffffff, 4); }));
  const error = await rejected(tree.assertPrivate()), receipt = windowsCommandCopyNativeFailure(error), count = s.calls.length;
  expect(receipt?.aceConstraint).toBe(9);
  for (const work of [() => tree.close(), () => tree.snapshot(), () => tree.grant(PACKAGE), () => tree.assertPrivate(), () => s.binding.createFreshWindowsCommandTree(s.input())]) {
    expect(await rejected(work())).toBe(error); expect(windowsCommandCopyNativeFailure(error)).toBe(receipt);
  }
  expect(s.calls).toHaveLength(count); expect(s.control.dataReads).toBe(0); expect(s.fence.retained.length).toBeGreaterThan(0);
});
