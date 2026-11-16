/** Canonical capture/lease semantics with actual owner code and a low-level Windows native model. */
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsCodingSealedCopy } from "../fixtures/windows-coding-sealed-copy-fake";

afterEach(() => { vi.doUnmock("../../app/main/platform/os"); vi.doUnmock("../../app/main/agent/windows-coding-native"); vi.restoreAllMocks(); vi.resetModules(); });

it("captures one complete revision and excludes every overlapping ordinary broker lease", async () => {
  const f = await setupWindowsCodingSealedCopy(), copy = await f.create(), broker = await f.WindowsScopedCodingFiles.create({ copy, signal: copy.signal });
  await broker.writeText("app.ts", "export const answer = 42;\n");
  const originalRoot = copy.directory, signal = copy.signal, input = await copy.captureCommandInput();
  expect(input.scope).toBe("canonical-command-input"); expect(Object.isFrozen(input)).toBe(true);
  expect(copy.contentRevision).toBe(1n); expect(copy.directory).toBe(originalRoot); expect(copy.signal).toBe(signal);
  await expect(copy.captureCommandInput()).rejects.toMatchObject({ code: "boundary" });
  await expect(broker.readText("app.ts")).rejects.toMatchObject({ code: "boundary" });
  await expect(broker.writeText("app.ts", "overlap\n")).rejects.toMatchObject({ code: "boundary" });
  expect(copy.contentRevision).toBe(1n);
  await broker.close(); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("rejects forged intake authority without consuming the genuine canonical input", async () => {
  const f = await setupWindowsCodingSealedCopy(), copy = await f.create(), input = await copy.captureCommandInput();
  const { takeWindowsCodingCommandInput } = await import("../../app/main/agent/windows-coding-copy");
  for (const forged of [undefined, {}, { scope: "canonical-command-intake" }, Object.freeze({ scope: "canonical-command-intake" })]) {
    expect(() => takeWindowsCodingCommandInput(input, forged as never)).toThrow();
  }
  // An unmoved input is still owned and positively erased by its canonical close.
  await copy.close();
  expect(() => takeWindowsCodingCommandInput(input, {} as never)).toThrow();
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("scans the complete captured file and erases owned detached bytes when an unused input closes", async () => {
  const f = await setupWindowsCodingSealedCopy(), copy = await f.create();
  const captured: Buffer[] = [], alloc = Buffer.alloc.bind(Buffer), length = Buffer.byteLength("export const answer = 41;\n");
  vi.spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => {
    const bytes = alloc(...args); if (bytes.length === length) captured.push(bytes); return bytes;
  }) as typeof Buffer.alloc);
  await copy.captureCommandInput();
  expect(captured.some(bytes => bytes.includes(Buffer.from("answer")))).toBe(true);
  await copy.close(); expect(captured.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  vi.restoreAllMocks(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("refuses secret content in any working file before issuing or reserving a command input", async () => {
  const f = await setupWindowsCodingSealedCopy(), copy = await f.create();
  const row = f.nodes.get(`${copy.directory}\\app.ts`.toLowerCase())!;
  row.bytes = Buffer.from("ghp_" + "A".repeat(36)); row.info.size = row.bytes.length;
  await expect(copy.captureCommandInput()).rejects.toMatchObject({ code: "secret" });
  expect(copy.contentRevision).toBe(0n);
  expect(await copy.files(async () => "ordinary lease remains available")).toBe("ordinary lease remains available");
  await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("requires the genuine stopped producer and refuses caller-created snapshot claims", async () => {
  const f = await setupWindowsCodingSealedCopy(), copy = await f.create(); await copy.captureCommandInput();
  for (const forged of [{}, { scope: "stopped-command-snapshot", stopped: true, entries: [] }, { outcome: "natural-exit", outputComplete: true }]) {
    expect(() => copy.acceptStoppedCommand(forged as never)).toThrow();
    await expect(copy.applyStoppedCommand(forged as never)).rejects.toMatchObject({ code: "boundary" });
    await expect(copy.applyStoppedCommandForReview(forged as never)).rejects.toMatchObject({ code: "boundary" });
  }
  expect(copy.admitted()).toBe(true); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});
