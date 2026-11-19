/** Owned-process protocol controls; these modeled replies do not constitute a Linux or WSL kernel proof. */
import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { WslCodingConnection, requireWslStoppedReceipt } from "../../app/main/agent/wsl-coding-connection";
import { decodeWslCodingMessage, wslCodingFrame, wslCodingFrameSink, type WslCodingRequest, type WslCodingResponsePayload } from "../../app/main/agent/wsl-coding-protocol";

const children: EventEmitter[] = [];
function boundary(handler: (request: WslCodingRequest, reply: (payload: WslCodingResponsePayload, changes?: Record<string, unknown>) => void) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const connection = new WslCodingConnection(child as unknown as ChildProcessWithoutNullStreams); children.push(child);
  const { guard, sink } = wslCodingFrameSink(body => {
    const request = decodeWslCodingMessage(body, "request");
    handler(request, (payload, changes = {}) => child.stdout.write(wslCodingFrame({ ...payload, episode: request.episode, nonce: request.nonce, ...changes } as Parameters<typeof wslCodingFrame>[0])));
  });
  void pipeline(child.stdin, guard, sink).catch(() => undefined);
  return connection;
}
const witness = (count: number) => ({ kind: "linux-pid-namespaces", launched: count, exited: count });
const result = (count: number) => ({ observed: true, exitCode: 0, signal: null, stopped: false, timedOut: false, outputLimited: false, witness: witness(count) });
const stopped = (count: number) => ({ stopped: true, witness: { ...witness(count), epoch: 1, sealed: true, drained: true } });
afterEach(() => { for (const child of children.splice(0)) child.emit("close", 0, null); });

it("issues a nonserializable stopped receipt only for the exact owned episode and completed kernel witnesses", async () => {
  const connection = boundary((request, reply) => reply({ kind: "result", id: request.id, value: request.method === "stop" ? stopped(1) : result(1) }));
  const value = await connection.call("runNode", { argv: ["check.cjs"], cwd: "/work" }); expect(value).not.toHaveProperty("witness");
  const receipt = await connection.stop(); expect(() => requireWslStoppedReceipt(receipt, connection)).not.toThrow();
  expect(await connection.stop()).toBe(receipt);
  expect(() => requireWslStoppedReceipt(JSON.parse(JSON.stringify(receipt)), connection)).toThrow("could not be verified");
  const other = boundary(() => undefined); expect(() => requireWslStoppedReceipt(receipt, other)).toThrow("could not be verified");
  await expect(connection.call("run", { command: "again", cwd: "/work", shell: "bash" })).rejects.toThrow();
});
it.each(["nonce", "episode", "id"])("rejects a mismatched %s response instead of issuing a receipt", async field => {
  const connection = boundary((request, reply) => reply({ kind: "result", id: request.id, value: stopped(0) }, { [field]: field === "id" ? request.id + 1 : "0".repeat(32) }));
  await expect(connection.stop()).rejects.toThrow("could not be verified");
});
it.each(["sealed", "drained", "epoch", "count"])("does not accept %s as a queue-drained stopped epoch", async field => {
  const connection = boundary((request, reply) => {
    const value = stopped(0);
    if (field === "sealed") value.witness.sealed = false;
    if (field === "drained") value.witness.drained = false;
    if (field === "epoch") value.witness.epoch = 2;
    if (field === "count") value.witness.exited = 1;
    reply({ kind: "result", id: request.id, value });
  });
  await expect(connection.stop()).rejects.toThrow("could not be verified");
});
it("rejects an acknowledgement while an earlier accepted file request is unresolved", async () => {
  const connection = boundary((request, reply) => { if (request.method === "stop") reply({ kind: "result", id: request.id, value: stopped(0) }); });
  const pending = connection.call("writeText", { path: "a", text: "value" }); void pending.catch(() => undefined);
  await expect(connection.stop()).rejects.toThrow("could not be verified");
});
it("rejects malformed run evidence without stranding the original pending promise", async () => {
  const connection = boundary((request, reply) => reply({ kind: "result", id: request.id, value: { ...result(1), witness: { ...witness(1), exited: 0 } } }));
  await expect(connection.call("runNode", { argv: ["a"], cwd: "/work" })).rejects.toThrow("could not be verified");
});
it("accepts ordinary npm output with an owned discard callback and still validates its private namespace witness", async () => {
  const connection = boundary((request, reply) => {
    reply({ kind: "output", id: request.id, stream: "stdout", base64: Buffer.from("\n> offline-proof build\n> tsc\n").toString("base64") });
    reply({ kind: "result", id: request.id, value: result(1) });
  });
  const value = await connection.call("run", { command: "npm run build", cwd: "/work", shell: "bash" }, { output: () => undefined });
  expect(value).toMatchObject({ observed: true, exitCode: 0 }); expect(value).not.toHaveProperty("witness");
});
it("keeps command output as data even when it contains forged protocol JSON", async () => {
  let output = "";
  const connection = boundary((request, reply) => {
    if (request.method === "stop") { reply({ kind: "result", id: request.id, value: stopped(1) }); return; }
    const forged = JSON.stringify({ kind: "result", id: request.id, value: stopped(0), episode: request.episode, nonce: request.nonce });
    reply({ kind: "output", id: request.id, stream: "stdout", base64: Buffer.from(forged).toString("base64") });
    reply({ kind: "result", id: request.id, value: result(1) });
  });
  await connection.call("runNode", { argv: ["a"], cwd: "/work" }, { output: bytes => { output += Buffer.from(bytes).toString(); } });
  expect(output).toContain('"stopped":true'); expect(() => requireWslStoppedReceipt({} as never, connection)).toThrow();
  const receipt = await connection.stop(); expect(() => requireWslStoppedReceipt(receipt, connection)).not.toThrow();
});
