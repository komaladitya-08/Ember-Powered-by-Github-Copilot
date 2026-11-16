/** Portable lifecycle/fault model; native Windows CI separately proves NTFS sharing, identities and ACL enforcement. */
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsCodingSealedCopy as setup } from "../fixtures/windows-coding-sealed-copy-fake";

afterEach(() => { vi.doUnmock("../../app/main/platform/os"); vi.doUnmock("../../app/main/agent/windows-coding-native"); vi.restoreAllMocks(); vi.resetModules(); });


it("keeps the full intake baseline and seals actual copied edits after Stop without reopening ordinary files", async () => {
  const f = await setup(), copy = await f.create(), broker = await f.WindowsScopedCodingFiles.create({ copy, signal: new AbortController().signal });
  await broker.writeText("app.ts", "export const answer = 42;\n"); await broker.close(); await copy.stop();
  const producer = await copy.exportReview(), output = producer.transfer();
  expect(output.cleanup).toBe("retained");
  expect(output.review.binding).toEqual(f.binding);
  const before = output.review.baseline.find(entry => entry.path === "app.ts")!, after = output.review.proposed.find(entry => entry.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toBe("export const answer = 41;\n");
  expect(after.kind === "file" && Buffer.from(after.base64, "base64").toString()).toBe("export const answer = 42;\n");
  expect(output.review.current).toEqual(output.review.baseline); expect(output.review.patchComplete).toBe(true);
  expect(output.review.baseline.find(entry => entry.path === "unchanged.bin")).toEqual(output.review.proposed.find(entry => entry.path === "unchanged.bin"));
  expect(f.nodes.get(f.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toBe("export const answer = 41;\n");
  await expect(copy.files(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const receipt = await f.store.claim(output, () => undefined), bytes = await f.store.read(receipt, "review.json", 64 * 1024 * 1024, () => undefined);
  const decoded = f.decodeCodingReviewExport(bytes, f.binding);
  expect(f.createCodingReviewExport(decoded).review).toEqual(output.review); bytes.fill(0);
  for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
  await copy.close(); expect(f.store.size).toBe(1); await f.store.cleanup(new Set()); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("refuses a source rebound between its original provenance receipt and the copy's intake pin", async () => {
  const f = await setup(); f.rebindAfterIntake();
  await expect(f.create()).rejects.toMatchObject({ code: "boundary" });
  expect([...f.nodes.values()].filter(row => row.info.finalPath.startsWith(f.location("C:\\copies") + "\\"))).toEqual([]);
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("refuses a replaced source after a host captures its expected receipt, even with an always-current folder callback", async () => {
  const f = await setup(), expected = await f.store.sourceBoundary("C:\\project", () => undefined);
  expect(expected).not.toBeNull(); f.directory("C:\\project"); f.put("C:\\project\\app.ts", "replacement source\n");
  await expect(f.create(undefined, expected!)).rejects.toMatchObject({ code: "boundary" });
  expect([...f.nodes.values()].some(row => row.info.finalPath.startsWith(f.location("C:\\copies") + "\\"))).toBe(false);
  expect(f.nodes.get(f.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toBe("replacement source\n");
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("clones a complete continuation before the first await and preserves its baseline after caller erasure and predecessor Forget", async () => {
  const f = await setup(), first = await f.create(), firstFiles = await f.WindowsScopedCodingFiles.create({ copy: first, signal: new AbortController().signal });
  await firstFiles.replaceText("app.ts", "41", "42"); await firstFiles.close(); await first.stop();
  const producer = await first.exportReview(), output = producer.transfer(), receipt = await f.store.claim(output, () => undefined);
  const bytes = await f.store.read(receipt, "review.json", 64 * 1024 * 1024, () => undefined), decoded = f.decodeCodingReviewExport(bytes, f.binding);
  bytes.fill(0); await first.close();
  const expected = await f.store.sourceBoundary("C:\\project", () => undefined); let predecessor = true;
  const opening = f.create(undefined, expected!, { baseline: decoded.baseline, proposed: decoded.proposed, scope: decoded.scope, current: () => predecessor });
  for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
  const second = await opening; predecessor = false; await f.store.cleanup(new Set());
  const secondFiles = await f.WindowsScopedCodingFiles.create({ copy: second, signal: new AbortController().signal });
  expect((await secondFiles.readText("app.ts")).text).toBe("export const answer = 42;\n");
  await secondFiles.replaceText("app.ts", "42", "43"); await secondFiles.close(); await second.stop();
  const continued = await second.exportReview(), review = continued.output.review;
  const before = review.baseline.find(entry => entry.path === "app.ts")!, proposed = review.proposed.find(entry => entry.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toBe("export const answer = 41;\n");
  expect(proposed.kind === "file" && Buffer.from(proposed.base64, "base64").toString()).toBe("export const answer = 43;\n");
  expect(review.current).toEqual(review.baseline);
  expect(f.nodes.get(f.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toBe("export const answer = 41;\n");
  await continued.discard(); await second.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("refuses a continuation without its host-captured original source capability before creating any copy", async () => {
  const f = await setup(), tree = { binding: f.binding, entries: [] };
  await expect(f.create(undefined, undefined, { baseline: tree, proposed: tree, current: () => true })).rejects.toMatchObject({ code: "boundary" });
  expect([...f.nodes.values()].some(row => row.info.finalPath.startsWith(f.location("C:\\copies") + "\\"))).toBe(false);
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("requires trusted controller closure before sealed review and never reopens the stopped broker", async () => {
  const f = await setup(), copy = await f.create(); f.closeController(false); await copy.stop();
  await expect(copy.exportReview()).rejects.toMatchObject({ code: "boundary" });
  expect(f.store.size).toBe(0); await expect(copy.withTree(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("releases a newly opened original file when its first metadata query fails during current capture", async () => {
  const f = await setup(), copy = await f.create(); await copy.stop();
  const info = f.api.info.bind(f.api); let refused = false;
  vi.spyOn(f.api, "info").mockImplementation(handle => {
    const result = info(handle);
    if (!refused && result.finalPath === f.location("C:\\project\\app.ts")) { refused = true; throw new Error("synthetic metadata refusal"); }
    return result;
  });
  const producer = await copy.exportReview(); expect(refused).toBe(true); expect(producer.output.review.current).toBeNull();
  await producer.discard(); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("revokes a sealed read after one payload chunk and clears every partially read full-file buffer", async () => {
  const f = await setup(); f.put("C:\\project\\app.ts", "ordinary text\n".repeat(10_000));
  const copy = await f.create(); await copy.stop(); const captured: Buffer[] = [], alloc = Buffer.alloc.bind(Buffer), size = Buffer.byteLength("ordinary text\n".repeat(10_000));
  vi.spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => { const bytes = alloc(...args); if (bytes.length === size) captured.push(bytes); return bytes; }) as typeof Buffer.alloc);
  f.onRead(f.revoke);
  await expect(copy.exportReview()).rejects.toMatchObject({ code: "cancelled" });
  expect(captured.length).toBeGreaterThan(0); expect(captured.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  vi.restoreAllMocks(); expect(f.store.size).toBe(0); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("drains a close during the first artifact write and reclaims only its exact unpublished producer", async () => {
  const f = await setup(), copy = await f.create(); await copy.stop(); let closing: Promise<void> | undefined;
  f.onWrite(row => { if (row.info.finalPath.startsWith(f.location("C:\\reviews") + "\\") && !closing) closing = copy.close(); });
  await expect(copy.exportReview()).rejects.toBeDefined(); await closing;
  expect(f.store.size).toBe(0); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("omits mixed-case roots only under explicit scope and keeps every broker operation within that scope", async () => {
  const f = await setup();
  for (const name of [".GiT", "NODE_MODULES"]) { f.directory(`C:\\project\\${name}`); f.put(`C:\\project\\${name}\\ordinary.txt`, "ghp_" + "A".repeat(36)); }
  for (const name of ["NODE_MODULES_BACKUP", "src", "src\\node_modules"]) f.directory(`C:\\project\\${name}`);
  f.put("C:\\project\\NODE_MODULES_BACKUP\\keep.txt", "ordinary source\n"); f.put("C:\\project\\src\\node_modules\\keep.txt", "nested source\n");
  await expect(f.create()).rejects.toMatchObject({ code: "secret" });
  const copy = await f.create([".git", "node_modules"]), broker = await f.WindowsScopedCodingFiles.create({ copy, signal: new AbortController().signal });
  expect((await broker.list()).excludedRoots).toEqual([".git", "node_modules"]);
  expect((await broker.searchLiteral("source")).excludedRoots).toEqual([".git", "node_modules"]);
  expect((await broker.readText("NODE_MODULES_BACKUP/keep.txt")).text).toBe("ordinary source\n");
  expect((await broker.readText("src/node_modules/keep.txt")).text).toBe("nested source\n");
  await expect(broker.mkdir("NODE_MODULES")).rejects.toMatchObject({ code: "privacy" });
  await expect(broker.writeText("NoDe_MoDuLeS/new.txt", "out of scope\n")).rejects.toMatchObject({ code: "privacy" });
  await expect(broker.readText(".GIT/ordinary.txt")).rejects.toMatchObject({ code: "privacy" });
  expect(await broker.inspect(["NODE_MODULES", ".GiT/ordinary.txt"])).toEqual([{ exists: null, real: null }, { exists: null, real: null }]);
  await broker.close(); await copy.stop(); const producer = await copy.exportReview();
  expect(producer.output.review.scope?.source.omitted).toEqual([{ path: ".git", kind: "directory" }, { path: "node_modules", kind: "directory" }]);
  for (const tree of [producer.output.review.baseline, producer.output.review.proposed, producer.output.review.current!]) {
    expect(tree.some(entry => entry.path === "NODE_MODULES_BACKUP/keep.txt")).toBe(true);
    expect(tree.some(entry => entry.path === "src/node_modules/keep.txt")).toBe(true);
    expect(tree.some(entry => entry.path.startsWith(".GiT") || entry.path.startsWith("NODE_MODULES/"))).toBe(false);
  }
  await producer.discard(); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("refuses duplicate folded native names before omitting either alias from a source capture", async () => {
  const f = await setup(); f.directory("C:\\project\\.GiT"); const list = f.api.list.bind(f.api);
  vi.spyOn(f.api, "list").mockImplementation((handle, maximum) => {
    const entries = list(handle, maximum);
    if (f.api.info(handle).finalPath === f.location("C:\\project")) entries.push({ ...entries.find(entry => entry.name === ".GiT")!, name: ".GIT", id: "ffffffffffffffff" });
    return entries;
  });
  await expect(f.create([".git"])).rejects.toMatchObject({ code: "unsupported" });
  expect([...f.nodes.values()].some(row => row.info.finalPath.startsWith(f.location("C:\\copies") + "\\"))).toBe(false);
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it.each([".GiT", "NODE_MODULES"])("refuses a fresh private %s root recreated in the stopped proposal", async name => {
  const f = await setup(), copy = await f.create([".git", "node_modules"]);
  await copy.withTree(async tree => { const directory = tree.api.create(tree.root, name, "directory"); tree.api.close(directory); });
  await copy.stop(); await expect(copy.exportReview()).rejects.toMatchObject({ code: "boundary" });
  expect(f.store.size).toBe(0); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});


it("tracks content mutations independently of read leases and retains the same copy/broker/signal", async () => {
  const f = await setup(), copy = await f.create(), signal = copy.signal;
  const broker = await f.WindowsScopedCodingFiles.create({ copy, signal: new AbortController().signal });
  try {
    expect(copy.contentRevision).toBe(0n);
    await broker.list(); await broker.readText("app.ts"); expect(copy.contentRevision).toBe(0n);
    await broker.writeText("app.ts", "export const answer = 42;\n"); expect(copy.contentRevision).toBe(1n);
    await expect(broker.writeText("app.ts", "different", { createOnly: true })).rejects.toMatchObject({ code: "exists" }); expect(copy.contentRevision).toBe(1n);
    await broker.mkdir("empty"); expect(copy.contentRevision).toBe(2n);
    await broker.delete("empty"); expect(copy.contentRevision).toBe(3n);
    expect(copy.signal).toBe(signal); expect((await broker.readText("app.ts")).text).toContain("42");
  } finally { await broker.close(); await copy.close(); }
});

it.each(["replace", "remove", "create"] as const)("records positive %s mutations even when native return synchronously cancels execution", async operation => {
  const f = await setup(), copy = await f.create(), broker = await f.WindowsScopedCodingFiles.create({ copy, signal: new AbortController().signal });
  const original = f.api[operation].bind(f.api);
  const stop = () => { void copy.stop().catch(() => undefined); };
  const spy = operation === "replace" ? vi.spyOn(f.api, "replace").mockImplementation((...args) => { const result = (original as typeof f.api.replace)(...args); stop(); return result; })
    : operation === "remove" ? vi.spyOn(f.api, "remove").mockImplementation((...args) => { const result = (original as typeof f.api.remove)(...args); stop(); return result; })
      : vi.spyOn(f.api, "create").mockImplementation((...args) => { const result = (original as typeof f.api.create)(...args); stop(); return result; });
  try {
    const changed = operation === "replace" ? broker.writeText("app.ts", "changed\n") : operation === "remove" ? broker.delete("app.ts") : broker.mkdir("created");
    await expect(changed).rejects.toMatchObject({ code: "cancelled" });
    expect(copy.contentRevision).toBe(1n); expect(copy.signal.aborted).toBe(true);
  } finally { spy.mockRestore(); await broker.close(); await copy.close(); }
});
