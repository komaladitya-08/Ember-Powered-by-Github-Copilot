/** Modeled helper transport failures exercise host authority/custody, independently from real guest proofs. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";
import { WslCodingWorkspace, WslCodingCleanupError } from "../../app/main/agent/wsl-coding-workspace";
import { decodeWslCodingMessage, wslCodingFrame, wslCodingFrameSink, type WslCodingMethod } from "../../app/main/agent/wsl-coding-protocol";
import type { CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
import { npmFixture } from "../fixtures/coding/public-npm";

async function fixture(options: { enabled?: boolean; begin?: unknown; beginCleanup?: boolean; cancelFault?: boolean; commitFault?: boolean; mutable?: { read(): Promise<Buffer> } } = {}) {
  const f = npmFixture(), binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() }, events: WslCodingMethod[] = [];
  const source = { binding, entries: [{ path: "package.json", kind: "file" as const, executable: false, bytes: Buffer.from(f.inputs.packageJson) }, { path: "package-lock.json", kind: "file" as const, executable: false, bytes: Buffer.from(f.inputs.packageLock) }] };
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let permitted = true;
  const { guard, sink } = wslCodingFrameSink(body => {
    const request = decodeWslCodingMessage(body, "request"); events.push(request.method);
    const value = request.method === "hello" ? { protocol: 1, kind: "linux-helper", noNetwork: true, uid: 1000, provisioned: false, opened: false, retired: false }
      : request.method === "provision" ? { typescript: "5.9.3" } : request.method === "open" ? { opened: true }
      : request.method === "stop" ? { stopped: true, witness: { kind: "linux-pid-namespaces", launched: 0, exited: 0, epoch: 1, sealed: true, drained: true } }
      : request.method === "publicBegin" ? options.begin ?? { lease: "a".repeat(32), packageJson: f.inputs.packageJson.toString("base64"), packageLock: f.inputs.packageLock.toString("base64") }
      : request.method === "publicChunk" ? { accepted: true }
      : request.method === "publicCommit" ? { prepared: !options.commitFault }
      : request.method === "publicCancel" ? { cancelled: !options.cancelFault } : { closed: true, cleanup: "complete" };
    child.stdout.write(wslCodingFrame(request.method === "publicBegin" && options.beginCleanup ? { kind: "failure", id: request.id, episode: request.episode, nonce: request.nonce, code: "cleanup" } : { kind: "result", id: request.id, episode: request.episode, nonce: request.nonce, value }));
    if (request.method === "close") setImmediate(() => { child.stdout.end(); child.emit("close", 0, null); });
  });
  void pipeline(child.stdin, guard, sink).catch(() => undefined);
  const connection = new WslCodingConnection(child as unknown as ChildProcessWithoutNullStreams), read = vi.fn(async () => Buffer.from(f.bytes));
  const port = options.mutable ?? { read };
  const workspace = await WslCodingWorkspace.create({ connection, source, typescriptArchive: Buffer.alloc(0), current: () => true, signal: new AbortController().signal,
    ...(options.enabled === false ? {} : { publicDependencies: { current: () => permitted, port } }),
    review: { base: "unused", sourceBoundary: Object.freeze({}) as CodingArtifactSourceRef, current: () => true, captureCurrent: async () => undefined,
      write: async () => { throw new Error("No artifact is minted by this negative fixture."); }, discard: async () => undefined } });
  return { workspace, events, read, retire: () => { permitted = false; } };
}
it("does not fetch or begin a guest lease without the separately captured opt-in", async () => {
  const f = await fixture({ enabled: false });
  await expect(f.workspace.preparePublicDependencies(async () => true, new AbortController().signal)).rejects.toThrow();
  expect(f.events).not.toContain("publicBegin"); expect(f.read).not.toHaveBeenCalled(); await f.workspace.close();
});
it("releases a refused exact set without fetch and captures the downloader callback before approval waits", async () => {
  const read = vi.fn(async () => Buffer.from(npmFixture().bytes)), mutable: { read(): Promise<Buffer> } = { read }, f = await fixture({ mutable });
  await expect(f.workspace.preparePublicDependencies(async () => false, new AbortController().signal)).rejects.toThrow();
  expect(f.events).toContain("publicCancel"); expect(read).not.toHaveBeenCalled();
  mutable.read = async () => { throw new Error("A changed host callback must not run."); };
  expect(await f.workspace.preparePublicDependencies(async request => { expect(Object.isFrozen(request)).toBe(true); expect(request.kind).toBe("baseline"); return true; }, new AbortController().signal)).toMatchObject({ prepared: true, packages: 1 });
  expect(read).toHaveBeenCalledTimes(1); await f.workspace.close();
});
it("rechecks current permission after approval and cancels before host fetching", async () => {
  const f = await fixture();
  await expect(f.workspace.preparePublicDependencies(async () => { f.retire(); return true; }, new AbortController().signal)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled(); expect(f.events).not.toContain("publicChunk"); await f.workspace.close();
});
it.each(["begin", "cancel", "commit"])("latches an unverifiable %s transaction reply and refuses positive host cleanup", async fault => {
  const f = await fixture(fault === "begin" ? { begin: { lease: "invalid" } } : fault === "cancel" ? { cancelFault: true } : { commitFault: true });
  await expect(f.workspace.preparePublicDependencies(async () => fault !== "cancel", new AbortController().signal)).rejects.toThrow();
  expect(f.workspace.nodeAvailable).toBe(false); await expect(f.workspace.close()).rejects.toBeInstanceOf(WslCodingCleanupError);
});

it("preserves an explicit guest cleanup fault before a lease reply as terminal host uncertainty", async () => {
  const f = await fixture({ beginCleanup: true });
  await expect(f.workspace.preparePublicDependencies(async () => true, new AbortController().signal)).rejects.toBeInstanceOf(WslCodingCleanupError);
  expect(f.read).not.toHaveBeenCalled(); expect(f.workspace.nodeAvailable).toBe(false);
  await expect(f.workspace.close()).rejects.toBeInstanceOf(WslCodingCleanupError);
});
