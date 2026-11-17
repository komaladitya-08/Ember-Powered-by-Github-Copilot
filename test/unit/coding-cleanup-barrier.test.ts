/** Main's real reset closure and Host's real barrier body, with held disposal receipts and no SDK/native process. */
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { CodingRetirement, unconfirmedCodingCleanupReceipt, type CodingCleanupReceipt } from "../../app/main/agent/coding-retirement";
import { wipeCodingTree } from "../../app/main/agent/coding-seed-snapshot";
import type { CodingExportTree } from "../../app/main/agent/coding-result-export";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
interface HostBarrier { codingRetirement: CodingRetirement; codingWorkspaceChanged(): void }
const hostSource = fs.readFileSync("app/main/agent/host.ts", "utf8");
const methodStart = hostSource.indexOf("  codingCleanupReceipt(): CodingCleanupReceipt {");
const method = hostSource.slice(methodStart, hostSource.indexOf("\n  /** Account-wide erasure", methodStart));
const captureCleanup = new Function(`return function() ${method.slice(method.indexOf("{"))}`)() as (this: HostBarrier) => CodingCleanupReceipt;
afterEach(() => { vi.useRealTimers(); });

it("starts coding Stop synchronously and waits for every trusted-session disposal receipt", async () => {
  const retirement = new CodingRetirement(), first = deferred<boolean>(), second = deferred<boolean>();
  retirement.track(first.promise); retirement.track(second.promise);
  const host: HostBarrier = { codingRetirement: retirement, codingWorkspaceChanged: vi.fn(() => retirement.retire()) };
  let complete = false;
  const receipt = captureCleanup.call(host);
  const pending = receipt.wait().then(() => { complete = true; });
  expect(host.codingWorkspaceChanged).toHaveBeenCalledOnce(); expect(retirement.blocked).toBe(true);
  first.resolve(true); await Promise.resolve(); expect(complete).toBe(false);
  second.resolve(true); await pending; expect(complete).toBe(true); expect(retirement.blocked).toBe(false);
});

it("does not report Forget as clear after the existing five-second retirement timeout", async () => {
  vi.useFakeTimers();
  const retirement = new CodingRetirement(), held = deferred<boolean>(); retirement.track(held.promise);
  const host: HostBarrier = { codingRetirement: retirement, codingWorkspaceChanged: () => retirement.retire() };
  let complete = false;
  const receipt = captureCleanup.call(host);
  const pending = receipt.wait().catch(error => { complete = true; return error; });
  await vi.advanceTimersByTimeAsync(4999); expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(String(await pending)).toBe("Error: Ember couldn't confirm that the coding runtime stopped. Coding remains unavailable.");
  expect(retirement.blocked).toBe(true);
  held.resolve(true); await expect(receipt.wait()).resolves.toBeUndefined();
});

it("keeps rejected or failed controller cleanup blocked and exposes only the fixed diagnostic", async () => {
  for (const receiptFactory of [() => Promise.resolve(false), () => Promise.reject(new Error("private SDK state path and prompt canary"))]) {
    const retirement = new CodingRetirement(); retirement.track(receiptFactory());
    const host: HostBarrier = { codingRetirement: retirement, codingWorkspaceChanged: () => retirement.retire() };
    const receipt = captureCleanup.call(host);
    await expect(receipt.wait()).rejects.toThrow("couldn't confirm that the coding runtime stopped");
    expect(retirement.blocked).toBe(true);
    await expect(receipt.wait()).rejects.not.toThrow("canary");
  }
});

it("never confirms cleanup after a synchronous Stop failure even when no runtime has registered yet", async () => {
  const retirement = new CodingRetirement(), host: HostBarrier = { codingRetirement: retirement,
    codingWorkspaceChanged: () => { throw new Error("private pending intake prompt canary"); } };
  const receipt = captureCleanup.call(host);
  await expect(receipt.wait()).rejects.toThrow("Ember couldn't confirm that the coding runtime stopped. Coding remains unavailable.");
  await expect(receipt.wait()).rejects.not.toThrow("canary");
  host.codingWorkspaceChanged = vi.fn();
  await expect(captureCleanup.call(host).wait()).resolves.toBeUndefined();
});

function fakeHost(wait: () => Promise<void>) { return { codingCleanupReceipt: vi.fn(() => Object.freeze({ wait })) }; }
function resetHarness(firstHost: { codingCleanupReceipt(): CodingCleanupReceipt }) {
  const main = fs.readFileSync("app/main/main.ts", "utf8"), start = main.indexOf("  const resetProjectCoding = (): Promise<void> => {");
  const reset = main.slice(start, main.indexOf("\n  let projectCodingOwner", start)).replace("const resetProjectCoding = (): Promise<void> =>", "const resetProjectCoding = () =>");
  const ipc = deferred<void>(), resources = deferred<void>();
  const codingExecution = { reset: vi.fn() }, projectCodingFolders = { ownerReset: vi.fn() }, projectCoding = { reset: vi.fn(() => ipc.promise) }, resource = { invalidate: vi.fn(() => resources.promise) }, changed = vi.fn();
  const install = new Function("initialHost", "codingExecution", "projectCodingFolders", "projectCoding", "codingResourcesReady", "projectCodingChanged", "unconfirmedCodingCleanupReceipt", `
    let agent = initialHost, codingCleanupPending = 0, codingCleanupFailed = false, codingCleanupAttempt = 0;
    const codingCleanupReceipts = new Set(), codingCleanupReceiptsByHost = new WeakMap();
    ${reset}
    return { resetProjectCoding, setHost(next) { agent = next; }, state() { return { codingCleanupPending, codingCleanupFailed }; } };
  `) as (...args: unknown[]) => { resetProjectCoding(): Promise<void>; setHost(host: unknown): void; state(): { codingCleanupPending: number; codingCleanupFailed: boolean } };
  return { ...install(firstHost, codingExecution, projectCodingFolders, projectCoding, Promise.resolve(resource), changed, unconfirmedCodingCleanupReceipt), ipc, resources, codingExecution, projectCodingFolders, projectCoding, resource };
}

it("main captures the exact host at erasure intake and waits for its held controller after copies and IPC finish", async () => {
  const controller = deferred<void>(), old = fakeHost(() => controller.promise), replacement = fakeHost(async () => undefined);
  const main = resetHarness(old); let complete = false;
  const pending = main.resetProjectCoding().then(() => { complete = true; }); main.setHost(replacement);
  expect(main.codingExecution.reset).toHaveBeenCalledOnce();
  expect(main.codingExecution.reset.mock.invocationCallOrder[0]).toBeLessThan(old.codingCleanupReceipt.mock.invocationCallOrder[0]);
  expect(old.codingCleanupReceipt).toHaveBeenCalledOnce(); expect(replacement.codingCleanupReceipt).not.toHaveBeenCalled();
  main.ipc.resolve(); main.resources.resolve(); await Promise.resolve(); expect(complete).toBe(false);
  expect(main.state().codingCleanupPending).toBe(1);
  controller.resolve(); await pending; expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: false });
});

it("main attempts and awaits every erasure barrier even when controller shutdown fails", async () => {
  const controller = deferred<void>(), main = resetHarness(fakeHost(() => controller.promise));
  let complete = false;
  const pending = main.resetProjectCoding().catch(error => { complete = true; return error; });
  controller.reject(new Error("private model prompt path canary")); await Promise.resolve(); expect(complete).toBe(false);
  main.ipc.resolve(); main.resources.resolve();
  expect(String(await pending)).toBe("Error: Ember couldn't finish clearing its private coding work. Try Forget everything again.");
  expect(main.resource.invalidate).toHaveBeenCalledOnce(); expect(main.projectCodingFolders.ownerReset).toHaveBeenCalledOnce();
  expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: true });
});

it.each(["capture", "folder", "ipc"] as const)("awaits all remaining barriers and sanitizes a synchronous %s failure", async part => {
  const host = fakeHost(async () => undefined), main = resetHarness(host);
  const fail = () => { throw new Error("private pending prompt path canary"); };
  if (part === "capture") host.codingCleanupReceipt.mockImplementation(fail);
  if (part === "folder") main.projectCodingFolders.ownerReset.mockImplementation(fail);
  if (part === "ipc") main.projectCoding.reset.mockImplementation(fail);
  let complete = false;
  const pending = main.resetProjectCoding().catch(error => { complete = true; return error; });
  main.ipc.resolve(); await Promise.resolve();
  expect(complete).toBe(false); expect(main.resource.invalidate).toHaveBeenCalledOnce();
  main.resources.resolve();
  expect(String(await pending)).toBe("Error: Ember couldn't finish clearing its private coding work. Try Forget everything again.");
  expect(main.projectCoding.reset).toHaveBeenCalledOnce();
  expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: true });
});

it("a failed fresh capture preserves and awaits that host's earlier outstanding disposal receipt", async () => {
  const held = deferred<void>(), host = fakeHost(() => held.promise), main = resetHarness(host);
  const first = main.resetProjectCoding().catch(error => error);
  host.codingCleanupReceipt.mockImplementationOnce(() => { throw new Error("private pending intake canary"); });
  let complete = false;
  const second = main.resetProjectCoding().catch(error => { complete = true; return error; });
  main.ipc.resolve(); main.resources.resolve(); await Promise.resolve(); expect(complete).toBe(false);
  held.resolve(); expect(await first).toBeInstanceOf(Error);
  expect(await second).toBeInstanceOf(Error); expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: true });
});

it("a replacement host cannot erase an old host's failed first cleanup capture", async () => {
  const old = fakeHost(async () => undefined), main = resetHarness(old);
  old.codingCleanupReceipt.mockImplementation(() => { throw new Error("private intake canary"); });
  const first = main.resetProjectCoding().catch(error => error);
  main.ipc.resolve(); main.resources.resolve(); expect(await first).toBeInstanceOf(Error);
  main.setHost(fakeHost(async () => undefined));
  await expect(main.resetProjectCoding()).rejects.toThrow("couldn't finish clearing its private coding work");
  expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: true });
});

it("a fresh successful Stop for the same host replaces its failed capture sentinel", async () => {
  const host = fakeHost(async () => undefined), main = resetHarness(host);
  host.codingCleanupReceipt.mockImplementationOnce(() => { throw new Error("private intake canary"); });
  const first = main.resetProjectCoding().catch(error => error);
  main.ipc.resolve(); main.resources.resolve(); expect(await first).toBeInstanceOf(Error);
  await expect(main.resetProjectCoding()).resolves.toBeUndefined();
  expect(host.codingCleanupReceipt).toHaveBeenCalledTimes(2);
  expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: false });
});

it("a replacement host's successful cleanup cannot clear an older host's unconfirmed shutdown", async () => {
  const old = deferred<void>(), replacement = deferred<void>(), main = resetHarness(fakeHost(() => old.promise));
  const first = main.resetProjectCoding().catch(error => error);
  main.setHost(fakeHost(() => replacement.promise));
  const second = main.resetProjectCoding().catch(error => error);
  main.ipc.resolve(); main.resources.resolve(); old.reject(new Error("old SDK state remains"));
  expect(await first).toBeInstanceOf(Error); replacement.resolve();
  expect(await second).toBeInstanceOf(Error); expect(main.state().codingCleanupFailed).toBe(true);
});

it("a late timeout from an older attempt cannot override a newer verified erasure of that same old receipt", async () => {
  const timedOut = deferred<void>(), verified = deferred<void>(), replacement = deferred<void>();
  const wait = vi.fn<() => Promise<void>>().mockImplementationOnce(() => timedOut.promise).mockImplementationOnce(() => verified.promise);
  const old = fakeHost(wait), main = resetHarness(old);
  const first = main.resetProjectCoding().catch(error => error);
  main.setHost(fakeHost(() => replacement.promise));
  const second = main.resetProjectCoding();
  main.ipc.resolve(); main.resources.resolve(); verified.resolve(); replacement.resolve();
  await second; expect(main.state().codingCleanupFailed).toBe(false); expect(wait).toHaveBeenCalledTimes(2);
  timedOut.reject(new Error("earlier attempt timed out"));
  expect(await first).toBeInstanceOf(Error); expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: false });
});

it("each reset takes a fresh Stop receipt and an older success cannot clear the newer shutdown failure", async () => {
  const earlier = deferred<void>(), newer = deferred<void>();
  const host = { codingCleanupReceipt: vi.fn<() => CodingCleanupReceipt>()
    .mockReturnValueOnce({ wait: () => earlier.promise }).mockReturnValueOnce({ wait: () => newer.promise }) };
  const main = resetHarness(host), first = main.resetProjectCoding().catch(error => error);
  const second = main.resetProjectCoding().catch(error => error);
  expect(host.codingCleanupReceipt).toHaveBeenCalledTimes(2);
  main.ipc.resolve(); main.resources.resolve(); newer.reject(new Error("latest trusted session remains"));
  expect(await second).toBeInstanceOf(Error); expect(main.state().codingCleanupFailed).toBe(true);
  earlier.resolve(); expect(await first).toBeInstanceOf(Error);
  expect(main.state()).toEqual({ codingCleanupPending: 0, codingCleanupFailed: true });
});

interface ReferenceBackend {
  lease: { getStore(): boolean }; retired: boolean; epoch: number; active: null; tail: Promise<void>; closing: Promise<void> | null;
  baseline: CodingExportTree; exporting: Promise<unknown> | null; closeTaskPrivacy(): Promise<void>; cleanupFiles(): Promise<void>;
}
const backendSource = fs.readFileSync("app/main/agent/isolated-command-workspace.ts", "utf8");
const closeStart = backendSource.lastIndexOf("  close(): Promise<void> {");
const closeMethod = backendSource.slice(closeStart, backendSource.lastIndexOf("\n}"));
const closeBackend = new Function("wipeCodingTree", `return function() ${closeMethod.slice(closeMethod.indexOf("{"))}`)(wipeCodingTree) as (this: ReferenceBackend) => Promise<void>;

it("keeps baseline bytes until in-flight work drains, then drops owned references without altering external bytes", async () => {
  const drained = deferred<void>(), cleanup = deferred<void>(), original = Buffer.from("owned baseline source");
  const externalReview = { bytes: original };
  const owned = Buffer.from(original), entry = { path: "source.txt", kind: "file" as const, bytes: owned, executable: false };
  const backend: ReferenceBackend = { lease: { getStore: () => false }, retired: false, epoch: 0, active: null, tail: drained.promise, closing: null,
    baseline: { binding: { owner: "fixture", session: "fixture", snapshot: "fixture" }, entries: [entry] }, exporting: Promise.resolve(externalReview), closeTaskPrivacy: async () => undefined, cleanupFiles: vi.fn(() => cleanup.promise) };
  const closed = closeBackend.call(backend); expect(closeBackend.call(backend)).toBe(closed);
  expect(backend.baseline.entries).toEqual([entry]); expect(owned.equals(original)).toBe(true); expect(backend.cleanupFiles).not.toHaveBeenCalled();
  drained.resolve(); await Promise.resolve(); expect(backend.baseline.entries).toEqual([entry]); expect(owned.equals(original)).toBe(true);
  cleanup.resolve(); await closed;
  expect(backend.baseline.entries).toEqual([]); expect(backend.exporting).toBeNull(); expect(owned).toEqual(Buffer.alloc(owned.length));
  expect(externalReview.bytes.toString()).toBe("owned baseline source");
});

it("drops terminal baseline references even when cleanup fails while retaining the shared failed-close receipt", async () => {
  const failure = new Error("private-copy cleanup failed");
  const owned = Buffer.from("owned source"), externalReview = { bytes: Buffer.from("owned review") };
  const backend: ReferenceBackend = { lease: { getStore: () => false }, retired: false, epoch: 0, active: null, tail: Promise.resolve(), closing: null,
    baseline: { binding: { owner: "fixture", session: "fixture", snapshot: "fixture" }, entries: [{ path: "source.txt", kind: "file", bytes: owned, executable: false }] },
    exporting: Promise.resolve(externalReview), closeTaskPrivacy: async () => undefined,
    cleanupFiles: async () => { throw failure; } };
  const closed = closeBackend.call(backend); await expect(closed).rejects.toBe(failure);
  expect(backend.baseline.entries).toEqual([]); expect(backend.exporting).toBeNull(); expect(closeBackend.call(backend)).toBe(closed);
  expect(owned).toEqual(Buffer.alloc(owned.length)); expect(externalReview.bytes.toString()).toBe("owned review");
});
