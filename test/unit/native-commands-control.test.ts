/** Real local IPC transport controls; no Electron/native/build or Windows proof. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { createNativeCommandsControl, type NativeCommandsControl } from "../fixtures/native-commands-control";

const folders: string[] = [], owners: NativeCommandsControl[] = [], sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(owners.splice(0).map(owner => owner.close().catch(() => undefined)));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: false });
});
async function fixture(bind = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "enfc-"))); folders.push(root);
  const owner = createNativeCommandsControl(root); owners.push(owner);
  await owner.listening; if (bind) owner.bindChild(process.pid);
  return { root, owner };
}
async function connect(owner: NativeCommandsControl) {
  const socket = net.connect(owner.address); sockets.push(socket); socket.on("error", () => undefined);
  socket.resume(); // Consume even control responses not examined by a malformed/disconnect case.
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, closed };
}
const hello = (owner: NativeCommandsControl, pid = process.pid) => "HELLO " + owner.nonce + " " + pid + "\n";
const bye = (owner: NativeCommandsControl, pid = process.pid) => "BYE " + owner.nonce + " " + pid + "\n";

it("owns one fresh local endpoint and nonce before a PID-bound handshake, explicit quit acknowledgement and observed close", async () => {
  const { owner } = await fixture(), c = await connect(owner);
  expect(owner.nonce).toMatch(/^[a-f0-9]{64}$/);
  if (process.platform === "win32") expect(owner.address).toMatch(/^\\\\\.\\pipe\\ember-native-commands-[a-f0-9]{32}$/);
  let received = "";
  c.socket.on("data", chunk => { received += chunk.toString("ascii"); if (received.includes("QUIT " + owner.nonce + "\n")) c.socket.end(bye(owner)); });
  c.socket.write(hello(owner)); await owner.authenticated;
  await owner.quit(); await c.closed; await expect(owner.close()).resolves.toBeUndefined();
  expect(received).toBe("OK " + owner.nonce + "\nQUIT " + owner.nonce + "\n"); expect(owner.broken()).toBe(false);
  if (process.platform !== "win32") expect(fs.existsSync(owner.address)).toBe(false);
});
it.each(["nonce", "pid", "missing-binding", "duplicate-hello", "unknown", "oversized", "non-ascii", "truncated"])("refuses %s authentication/control bytes and drains the actual local handles", async kind => {
  const { owner } = await fixture(kind !== "missing-binding"), c = await connect(owner);
  let payload: string | Buffer = hello(owner);
  if (kind === "nonce") payload = hello(owner).replace(owner.nonce, "0".repeat(64));
  if (kind === "pid") payload = hello(owner, process.pid + 1);
  if (kind === "duplicate-hello") payload += hello(owner);
  if (kind === "unknown") payload = "sample\n";
  if (kind === "oversized") payload = "X".repeat(2049);
  if (kind === "non-ascii") payload = Buffer.from([255]);
  if (kind === "truncated") payload = "HELLO ";
  c.socket.end(payload); await c.closed;
  expect(owner.broken()).toBe(true); await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});
it.each(["before-auth", "after-auth"])("fails an unexpected actual control disconnect %s instead of ignoring EOF", async kind => {
  const { owner } = await fixture(), c = await connect(owner);
  if (kind === "after-auth") { c.socket.write(hello(owner)); await owner.authenticated; }
  c.socket.end(); await c.closed;
  expect(owner.broken()).toBe(true); await expect(owner.quit()).rejects.toThrow("The synthetic Electron control could not be verified.");
  await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});
it.each(["wrong-nonce", "wrong-pid", "duplicate", "tail", "no-ack"])("requires the exact one quit acknowledgement and complete close (%s)", async kind => {
  const { owner } = await fixture(), c = await connect(owner);
  c.socket.write(hello(owner)); await owner.authenticated;
  c.socket.on("data", chunk => {
    if (!chunk.toString("ascii").includes("QUIT ")) return;
    const message = kind === "wrong-nonce" ? bye(owner).replace(owner.nonce, "f".repeat(64)) : kind === "wrong-pid" ? bye(owner, process.pid + 1) :
      kind === "duplicate" ? bye(owner) + bye(owner) : kind === "tail" ? bye(owner) + "tail" : kind === "no-ack" ? "" : bye(owner);
    c.socket.end(message);
  });
  const request = owner.quit(); void request.catch(() => undefined); await c.closed;
  expect(owner.broken()).toBe(true); await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});
it("retires a listener with no child and refuses invalid or repeated PID binding without leaking a server", async () => {
  for (const pid of [undefined, 0, -1, 1.5]) {
    const { owner } = await fixture(false); owner.bindChild(pid); expect(owner.broken()).toBe(true);
    await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
  }
  const { owner } = await fixture(); owner.bindChild(process.pid); expect(owner.broken()).toBe(true);
  await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});

it("serializes sixteen real sample requests and exact PID/nonce/sequence acknowledgements before normal quit", async () => {
  const { owner } = await fixture(), c = await connect(owner); let input = "", samples = 0;
  c.socket.on("data", chunk => {
    input += chunk.toString("ascii"); let end;
    while ((end = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      if (line.startsWith("SAMPLE ")) { samples++; c.socket.write("SAMPLED " + owner.nonce + " " + process.pid + " " + samples + "\n"); }
      else if (line === "QUIT " + owner.nonce) c.socket.end(bye(owner));
    }
  });
  c.socket.write(hello(owner)); await owner.authenticated;
  for (let sequence = 1; sequence <= 16; sequence++) {
    owner.sample(sequence);
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (owner.broken()) reject(new Error("Fixed sample control refused.")); else if (owner.sampledSequence() === sequence) resolve(); else setImmediate(check); }; check();
    });
  }
  expect(samples).toBe(16); expect(owner.sampledSequence()).toBe(16);
  await owner.quit(); await c.closed; await expect(owner.close()).resolves.toBeUndefined();
});
it.each(["wrong-pid", "wrong-sequence", "wrong-nonce", "duplicate", "no-request"])("refuses %s sample acknowledgement instead of fabricating renderer completion", async kind => {
  const { owner } = await fixture(), c = await connect(owner);
  c.socket.write(hello(owner)); await owner.authenticated;
  if (kind !== "no-request") owner.sample(1);
  const line = "SAMPLED " + (kind === "wrong-nonce" ? "0".repeat(64) : owner.nonce) + " " + (kind === "wrong-pid" ? process.pid + 1 : process.pid) + " " + (kind === "wrong-sequence" ? 2 : 1) + "\n";
  c.socket.end(kind === "duplicate" ? line + line : line); await c.closed;
  expect(owner.broken()).toBe(true); await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});
it.each([0, 2, 17, 1.5])("refuses out-of-order or unsupported request %s without a second control action", async sequence => {
  const { owner } = await fixture(), c = await connect(owner);
  c.socket.write(hello(owner)); await owner.authenticated; owner.sample(sequence);
  expect(owner.broken()).toBe(true); await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});
it("refuses concurrent sample work and does not acknowledge cleanup over a pending sample", async () => {
  const { owner } = await fixture(), c = await connect(owner); c.socket.write(hello(owner)); await owner.authenticated;
  owner.sample(1); owner.sample(2); expect(owner.broken()).toBe(true);
  await expect(owner.quit()).rejects.toThrow("The synthetic Electron control could not be verified.");
  await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
});
