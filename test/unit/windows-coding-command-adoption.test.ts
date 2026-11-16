/** Full owner composition over low-level DLL/file models. No native Windows execution is asserted. */
import path from "node:path/win32";
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsCommandTransfer as setup } from "../fixtures/windows-command-transfer-fake";

afterEach(() => {
  for (const name of ["node:module", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});
async function ready() {
  const f = await setup(), v = await f.launch();
  f.s.source.objects.get(path.join(f.s.source.root().name, "app.ts"))!.bytes = Buffer.from("export const answer = 99;\n");
  const { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  return { ...f, v, snapshot };
}

it("a foreign canonical receiver cannot consume a genuine snapshot, and used snapshot/adoption refs reject", async () => {
  const f = await ready(), other = await f.canonical.create(); await other.captureCommandInput();
  expect(() => other.acceptStoppedCommand(f.snapshot)).toThrow();
  expect(f.producer.readWindowsCommandStoppedSnapshot(f.snapshot).input).toBe(f.input);
  const adoption = f.copy.acceptStoppedCommand(f.snapshot); expect(Object.keys(adoption)).toEqual(["scope"]);
  expect(() => f.copy.acceptStoppedCommand(f.snapshot)).toThrow();
  expect(() => f.producer.readWindowsCommandStoppedSnapshot(f.snapshot)).toThrow();
  await expect(other.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "boundary" });
  await f.copy.applyStoppedCommand(adoption);
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "boundary" });
  await expect(f.copy.applyStoppedCommandForReview(adoption)).rejects.toMatchObject({ code: "boundary" });
  await other.close(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it("wrong-order canonical close requests Stop but performs no native canonical cleanup until the producer closes", async () => {
  const f = await setup(), v = await f.launch(), root = f.copy.directory, remove = vi.spyOn(f.canonical.api, "remove");
  await expect(f.copy.close()).rejects.toMatchObject({ code: "boundary" });
  expect(f.copy.signal.aborted).toBe(true); expect(f.copy.directory).toBe(root); expect(remove).not.toHaveBeenCalled();
  await f.finish(v); await v.command.close();
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).not.toThrow();
  await f.close(); expect(remove).toHaveBeenCalled(); expect(f.canonical.handles.size).toBe(0);
});

it("cancellation before old retirement retains one consumed adoption for controller-gated review only", async () => {
  const f = await ready(), root = f.copy.directory, signal = f.copy.signal, adoption = f.copy.acceptStoppedCommand(f.snapshot);
  let stopping: Promise<void> | undefined;
  f.canonical.onWrite(row => { if (!stopping && row.info.finalPath.includes("ember-command-adoption-")) stopping = f.copy.stop(); });
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "cancelled" }); await stopping;
  expect(f.copy.directory).toBe(root); expect(f.copy.contentRevision).toBe(0n); expect(signal.aborted).toBe(true);
  expect(() => f.producer.readWindowsCommandStoppedSnapshot(f.snapshot)).toThrow();
  f.canonical.closeController(false);
  await expect(f.copy.applyStoppedCommandForReview(adoption)).rejects.toMatchObject({ code: "boundary" });
  expect(f.copy.directory).toBe(root);
  f.canonical.closeController(true); await f.copy.applyStoppedCommandForReview(adoption);
  expect(f.copy.directory).not.toBe(root); expect(f.copy.signal).toBe(signal); expect(f.copy.contentRevision).toBe(1n);
  await expect(f.copy.files(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const producer = await f.copy.exportReview(), review = producer.output.review;
  const before = review.baseline.find(row => row.path === "app.ts")!, after = review.proposed.find(row => row.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toContain("41");
  expect(after.kind === "file" && Buffer.from(after.base64, "base64").toString()).toContain("99");
  expect(review.current).toEqual(review.baseline); await producer.discard(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it("Stop during irreversible old retirement completes private ownership commit without reviving execution", async () => {
  const f = await ready(), root = f.copy.directory, adoption = f.copy.acceptStoppedCommand(f.snapshot), remove = f.canonical.api.remove.bind(f.canonical.api);
  let stopping: Promise<void> | undefined;
  vi.spyOn(f.canonical.api, "remove").mockImplementation(handle => {
    const location = f.canonical.api.info(handle).finalPath; remove(handle);
    if (!stopping && location.startsWith(root + "\\")) stopping = f.copy.stop();
  });
  await f.copy.applyStoppedCommand(adoption); await stopping;
  expect(stopping).toBeDefined(); expect(f.copy.directory).not.toBe(root); expect(f.copy.contentRevision).toBe(1n);
  expect(f.copy.signal.aborted).toBe(true); expect(f.copy.admitted()).toBe(false);
  await expect(f.copy.files(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const producer = await f.copy.exportReview(); expect(producer.output.review.proposed.some(row => row.path === "app.ts")).toBe(true);
  await producer.discard(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it.each(["stage-file", "old-root"] as const)("retains and fences unknown %s close without retrying or issuing later native queries", async fault => {
  const f = await ready(), root = f.copy.directory, adoption = f.copy.acceptStoppedCommand(f.snapshot), close = f.canonical.api.close.bind(f.canonical.api);
  let refused = false;
  vi.spyOn(f.canonical.api, "close").mockImplementation(handle => {
    const location = f.canonical.api.info(handle).finalPath;
    if (!refused && (fault === "old-root" ? location === root : location.includes("ember-command-adoption-") && location.endsWith("app.ts"))) {
      refused = true; throw Error("PRIVATE close uncertainty at a private path");
    }
    close(handle);
  });
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(refused).toBe(true); expect(f.copy.directory).toBe(root); expect(f.copy.contentRevision).toBe(0n); expect(f.copy.signal.aborted).toBe(true);
  const native = vi.spyOn(f.canonical.api, "info"), count = native.mock.calls.length;
  await expect(f.copy.applyStoppedCommandForReview(adoption)).rejects.toMatchObject({ code: "boundary" });
  await expect(f.copy.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(f.copy.exportReview()).rejects.toBeDefined(); expect(native).toHaveBeenCalledTimes(count);
  expect(f.canonical.handles.size).toBeGreaterThan(0);
  // Unknown handles intentionally remain owned by the process fence; no false cleanup or close retry.
});

it("staged full-tree readback mismatch preserves the original root and blocks publication", async () => {
  const f = await ready(), root = f.copy.directory, adoption = f.copy.acceptStoppedCommand(f.snapshot), open = f.canonical.api.open.bind(f.canonical.api);
  let changed = false;
  vi.spyOn(f.canonical.api, "open").mockImplementation((parent, name, kind, mode) => {
    const handle = open(parent, name, kind, mode), location = f.canonical.api.info(handle).finalPath;
    if (!changed && location.includes("ember-command-adoption-") && name === "app.ts") {
      changed = true; const row = f.canonical.nodes.get(location.toLowerCase())!; row.bytes = Buffer.alloc(row.bytes.length, 0x78);
    }
    return handle;
  });
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(changed).toBe(true); expect(f.copy.directory).toBe(root); expect(f.copy.contentRevision).toBe(0n);
  await expect(f.copy.exportReview()).rejects.toBeDefined(); expect(f.canonical.store.size).toBe(0);
});


it("a complete empty snapshot removes every old entry and concurrent application cannot reuse its claim", async () => {
  const f = await setup(), original = f.copy.directory, v = await f.launch();
  for (const name of ["app.ts", "unchanged.bin"]) {
    const row = f.s.source.objects.get(path.join(f.s.source.root().name, name))!;
    row.removed = true; row.links = 0; row.deletePending = true;
  }
  const { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed), adoption = f.copy.acceptStoppedCommand(snapshot);
  const first = f.copy.applyStoppedCommand(adoption);
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "boundary" }); await first;
  expect(f.copy.directory).not.toBe(original); expect(f.copy.contentRevision).toBe(1n);
  expect((await f.broker.list()).entries).toEqual([]);
  await f.broker.close(); await f.copy.stop(); const producer = await f.copy.exportReview();
  expect(producer.output.review.proposed).toEqual([]); expect(producer.output.review.baseline).toHaveLength(2);
  expect(producer.output.review.current).toEqual(producer.output.review.baseline);
  await producer.discard(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});


it.each(["host-current", "native-preflight"] as const)("Stop from the last %s before the first delete preserves the old canonical root", async mode => {
  const f = await ready(), original = f.copy.directory, adoption = f.copy.acceptStoppedCommand(f.snapshot);
  const assertPrivate = f.canonical.api.assertPrivate.bind(f.canonical.api), assertions = new Map<bigint, number>();
  let armed = false, stopping: Promise<void> | undefined;
  f.canonical.onCurrent(() => { if (mode === "host-current" && armed && !stopping) stopping = f.copy.stop(); return true; });
  const preflight = vi.spyOn(f.canonical.api, "assertPrivate").mockImplementation(handle => {
    assertPrivate(handle); const info = f.canonical.api.info(handle);
    if (info.finalPath === original + "\\app.ts") {
      const count = (assertions.get(handle) ?? 0) + 1; assertions.set(handle, count);
      // The same held entry is checked once by the old-tree walk and again by retirement preflight.
      if (count === 2) {
        armed = true;
        if (mode === "native-preflight" && !stopping) stopping = f.copy.stop();
      }
    }
  });
  const remove = vi.spyOn(f.canonical.api, "remove");
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "cancelled" }); await stopping;
  expect(stopping).toBeDefined(); expect(remove).not.toHaveBeenCalled();
  expect(f.copy.directory).toBe(original); expect(f.copy.contentRevision).toBe(0n); expect(f.copy.signal.aborted).toBe(true);
  preflight.mockRestore(); f.canonical.onCurrent(() => true);
  await f.copy.applyStoppedCommandForReview(adoption); expect(f.copy.directory).not.toBe(original);
  const producer = await f.copy.exportReview(); await producer.discard(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it("unknown first staging-root creation fences even before a root handle can enter the adoption ledger", async () => {
  const f = await ready(), original = f.copy.directory, adoption = f.copy.acceptStoppedCommand(f.snapshot), create = f.canonical.api.create.bind(f.canonical.api);
  let hidden: bigint | undefined;
  vi.spyOn(f.canonical.api, "create").mockImplementation((parent, name, kind) => {
    const handle = create(parent, name, kind);
    if (name.startsWith("ember-command-adoption-")) { hidden = handle; throw Error("PRIVATE native creation result unknown"); }
    return handle;
  });
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(hidden).toBeDefined(); expect(f.canonical.handles.has(hidden!)).toBe(true);
  expect(f.copy.directory).toBe(original); expect(f.copy.contentRevision).toBe(0n);
  const query = vi.spyOn(f.canonical.api, "info"), remove = vi.spyOn(f.canonical.api, "remove");
  await expect(f.copy.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(f.copy.applyStoppedCommandForReview(adoption)).rejects.toMatchObject({ code: "boundary" });
  expect(query).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

it("preflight privacy cleanup uncertainty fences before native or scanner admission and forbids later cleanup", async () => {
  const f = await ready(), adoption = f.copy.acceptStoppedCommand(f.snapshot), privacy = await import("../../app/main/agent/coding-privacy-scanner");
  const query = vi.spyOn(f.canonical.api, "info"), create = vi.spyOn(f.canonical.api, "create"), scanner = vi.spyOn(privacy, "CodingPrivacyScanner");
  vi.spyOn(privacy, "assertCodingPrivacyScope").mockImplementation(() => { throw new privacy.CodingPrivacyCleanupError(); });
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(query).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  vi.restoreAllMocks(); const later = vi.spyOn(f.canonical.api, "info"), remove = vi.spyOn(f.canonical.api, "remove");
  await expect(f.copy.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(later).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});


it("positive privacy-scope retirement cancels the old adoption without poisoning native cleanup or a fresh workspace", async () => {
  const f = await ready(), adoption = f.copy.acceptStoppedCommand(f.snapshot), privacy = await import("../../app/main/agent/coding-privacy-scanner");
  await privacy.retireCodingPrivacyScanners();
  const create = vi.spyOn(f.canonical.api, "create"), scanner = vi.spyOn(privacy, "CodingPrivacyScanner");
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "cancelled" });
  expect(create).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled(); vi.restoreAllMocks();
  await f.broker.close(); await f.copy.close();
  const fresh = await f.canonical.create(); expect(fresh.admitted()).toBe(true);
  await fresh.close(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});
