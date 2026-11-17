/** Modeled helper replies isolate the real host workspace's cleanup state; this is not native WSL proof. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";
import { WslCodingWorkspace, WslCodingCleanupError, type WslCodingReviewOwner } from "../../app/main/agent/wsl-coding-workspace";
import { decodeWslCodingMessage, encodeWslCodingTree, wslCodingFrame, wslCodingFrameSink } from "../../app/main/agent/wsl-coding-protocol";
import { CodingArtifactCleanupError, type CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";

async function fixture(fault: "capture" | "write", fail: () => Promise<never>) {
  const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() };
  const source = { binding, entries: [{ path: "app.ts", kind: "file" as const, executable: false, bytes: Buffer.from("export const n=42;\n") }] };
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const { guard, sink } = wslCodingFrameSink(body => {
    const request = decodeWslCodingMessage(body, "request");
    const value = request.method === "hello" ? { protocol: 1, kind: "linux-helper", noNetwork: true, uid: 1000, provisioned: false, opened: false, retired: false }
      : request.method === "provision" ? { typescript: "5.9.3" } : request.method === "open" ? { opened: true }
      : request.method === "stop" ? { stopped: true, witness: { kind: "linux-pid-namespaces", launched: 0, exited: 0, epoch: 1, sealed: true, drained: true } }
      : request.method === "snapshot" ? encodeWslCodingTree(source) : { closed: true, cleanup: "complete" };
    child.stdout.write(wslCodingFrame({ kind: "result", id: request.id, episode: request.episode, nonce: request.nonce, value }));
    if (request.method === "close") setImmediate(() => { child.stdout.end(); child.emit("close", 0, null); });
  });
  void pipeline(child.stdin, guard, sink).catch(() => undefined);
  const connection = new WslCodingConnection(child as unknown as ChildProcessWithoutNullStreams);
  const review: WslCodingReviewOwner = { base: "host-review", sourceBoundary: Object.freeze({}) as CodingArtifactSourceRef, current: () => true,
    captureCurrent: fault === "capture" ? fail : async () => ({ binding: { ...binding }, entries: source.entries.map(entry => ({ ...entry, bytes: Buffer.from(entry.bytes) })) }),
    write: vi.fn(fault === "write" ? fail : async () => { throw new Error("An unknown capture cannot mint an artifact."); }), discard: vi.fn(async () => undefined) };
  const workspace = await WslCodingWorkspace.create({ connection, source, typescriptArchive: Buffer.alloc(0), current: () => true,
    signal: new AbortController().signal, review });
  await workspace.sealForReview(); return { workspace, review };
}
const faults = [WindowsCodingCleanupError, CodingArtifactCleanupError, CodingPrivacyCleanupError] as const;
for (const phase of ["capture", "write"] as const) {
  it.each(faults)(`retains typed %s uncertainty from host ${phase} after export and refuses positive close`, async ErrorType => {
    const { workspace } = await fixture(phase, async () => { throw new ErrorType(); });
    await expect(workspace.exportReview("host-review")).rejects.toBeInstanceOf(WslCodingCleanupError);
    await expect(workspace.close()).rejects.toBeInstanceOf(WslCodingCleanupError);
    expect(workspace.nodeAvailable).toBe(false);
  });
  it(`permits verified close after a known host ${phase} validation refusal`, async () => {
    const { workspace } = await fixture(phase, async () => { throw new ScopedCodingFileError("cancelled"); });
    await expect(workspace.exportReview("host-review")).rejects.toMatchObject({ code: "cancelled" });
    await expect(workspace.close()).resolves.toBeUndefined();
  });
}
it("does not swallow a typed host cleanup fault that arrives while close awaits export", async () => {
  let entered!: () => void, reject!: (error: Error) => void;
  const begun = new Promise<void>(resolve => { entered = resolve; });
  const { workspace } = await fixture("capture", () => { entered(); return new Promise<never>((_resolve, fail) => { reject = fail; }); });
  const exporting = workspace.exportReview("host-review"); void exporting.catch(() => undefined); await begun;
  const closing = workspace.close(); void closing.catch(() => undefined); reject(new WindowsCodingCleanupError());
  await expect(exporting).rejects.toBeInstanceOf(WslCodingCleanupError);
  await expect(closing).rejects.toBeInstanceOf(WslCodingCleanupError);
});
