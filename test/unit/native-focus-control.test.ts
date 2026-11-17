/** Real local IPC plus the actual CJS client in an Electron VM; no Electron/native/build or Windows proof. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createNativeFocusControl, type NativeFocusControl } from "../fixtures/native-focus-control";

const source = fs.readFileSync("test/fixtures/uia-focus-app/main.cjs", "utf8");
const native = fs.readFileSync("test/integration/uia-electron-focus-native.test.ts", "utf8");
const folders: string[] = [], owners: NativeFocusControl[] = [], sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(owners.splice(0).map(owner => owner.close().catch(() => undefined)));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: false });
});
async function fixture(bind = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "enfc-"))); folders.push(root);
  const owner = createNativeFocusControl(root); owners.push(owner);
  await owner.listening; if (bind) owner.bindChild(process.pid);
  return { root, owner };
}
async function connect(owner: NativeFocusControl) {
  const socket = net.connect(owner.address); sockets.push(socket); socket.on("error", () => undefined);
  socket.resume(); // Consume even control responses not examined by a malformed/disconnect case.
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, closed };
}
const hello = (owner: NativeFocusControl, pid = process.pid) => "HELLO " + owner.nonce + " " + pid + "\n";
const bye = (owner: NativeFocusControl, pid = process.pid) => "BYE " + owner.nonce + " " + pid + "\n";

it("owns one fresh local endpoint and nonce before a PID-bound handshake, explicit quit acknowledgement and observed close", async () => {
  const { owner } = await fixture(), c = await connect(owner);
  expect(owner.nonce).toMatch(/^[a-f0-9]{64}$/);
  if (process.platform === "win32") expect(owner.address).toMatch(/^\\\\\.\\pipe\\ember-native-focus-[a-f0-9]{32}$/);
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
  if (kind === "oversized") payload = "X".repeat(257);
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

/** The CJS validates the same Windows pipe name; only its net.connect endpoint is mapped to the real owned local IPC on other OSes. */
function actor(owner: NativeFocusControl, mode: "normal" | "load-fault" | "metrics-fault" = "normal") {
  const events = new Map<string, () => void>(), calls: string[] = [], stdout: string[] = [], stderr: string[] = [];
  let socket: net.Socket | undefined, resolveReady!: (value: boolean) => void, resolveQuit!: () => void, completed = Promise.resolve();
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; }), quit = new Promise<void>(resolve => { resolveQuit = resolve; });
  let next = 0;
  class Window {
    pid = ++next; webContents = { getOSProcessId: () => this.pid, on() {} };
    constructor() { calls.push("create"); }
    async loadFile() { calls.push("load"); if (mode === "load-fault") throw new Error("PRIVATE load"); }
    setTitle() { calls.push("title"); } show() { calls.push("show"); }
  }
  const app = { setPath() { calls.push("profile"); }, on: (name: string, fn: () => void) => events.set(name, fn),
    quit() { calls.push("quit"); resolveQuit(); if (!stdout.some(line => line === "EMBER_UIA_FOCUS_READY_V1:1\n")) socket?.destroy(); },
    whenReady() { return { then(fn: () => Promise<void>) { completed = Promise.resolve().then(fn); return completed; } }; },
    getAppMetrics() { calls.push("metrics"); if (mode === "metrics-fault") throw new Error("PRIVATE metrics"); return [{ pid: 1, sandboxed: true }, { pid: 2, sandboxed: true }]; } };
  const processStub = { pid: process.pid, exitCode: 0, env: { EMBER_UIA_FOCUS_PROFILE: "/fixed-profile", EMBER_UIA_FOCUS_CONTROL: "\\\\.\\pipe\\ember-native-focus-" + "a".repeat(32), EMBER_UIA_FOCUS_NONCE: owner.nonce },
    get stdin(): never { throw new Error("GUI stdin must never be the fixture controller."); }, exit() { throw new Error("Invalid fixture configuration."); },
    stdout: { write(value: string) { stdout.push(value); if (value.includes("EMBER_UIA_FOCUS_READY_V1:")) resolveReady(value === "EMBER_UIA_FOCUS_READY_V1:1\n"); } }, stderr: { write(value: string) { stderr.push(value); } } };
  runInNewContext(source, { Buffer, __dirname: "/fixed-bench", process: processStub,
    require(name: string) {
      if (name === "node:util") return { types };
      if (name === "node:path") return { isAbsolute: () => true, join: (...parts: string[]) => parts.join("/") };
      if (name === "node:net") return { connect(address: string) {
        expect(address).toBe(processStub.env.EMBER_UIA_FOCUS_CONTROL); socket = net.connect(owner.address); sockets.push(socket); return socket;
      } };
      if (name !== "electron") throw new Error("Unexpected synthetic module.");
      return { app, BrowserWindow: Window, Menu: { setApplicationMenu() { calls.push("menu"); } }, screen: { getPrimaryDisplay() { calls.push("screen"); return { workArea: { x: 0, y: 0, width: 1200 } }; } } };
    },
  });
  return { ready, quit, calls, stdout, stderr, processStub, complete: () => completed, windowClosed: () => events.get("window-all-closed")!() };
}
it("the actual CJS performs both original loads and sandbox checks only after real authenticated local control, then acknowledges explicit quit", async () => {
  const { owner } = await fixture(), child = actor(owner);
  expect(child.calls).toEqual(["profile"]); expect(child.stdout).toEqual([]);
  await expect(child.ready).resolves.toBe(true); await owner.authenticated;
  expect(child.calls).toEqual(["profile", "menu", "screen", "create", "create", "load", "load", "title", "show", "title", "show", "metrics"]);
  await owner.quit(); await child.quit; await expect(owner.close()).resolves.toBeUndefined();
  expect(child.calls.filter(x => x === "quit")).toHaveLength(1); expect(owner.broken()).toBe(false);
  expect(child.processStub.exitCode).toBe(0); expect(child.stdout).toEqual(["EMBER_UIA_FOCUS_READY_V1:1\n"]);
});
it.each(["load-fault", "metrics-fault"] as const)("the controlled actual CJS preserves its original %s refusal and cannot turn unknown teardown into success", async mode => {
  const { owner } = await fixture(), child = actor(owner, mode);
  await expect(child.ready).resolves.toBe(false); await child.quit; await child.complete().catch(() => undefined);
  await expect(owner.close()).rejects.toThrow("The synthetic Electron control could not be verified.");
  expect(child.stdout.join("")).not.toContain("PRIVATE"); expect(child.calls.filter(x => x === "load")).toHaveLength(2);
});
it("the actual CJS treats an owned control retirement before authentication as failure, not a reason to ignore EOF or claim ready", async () => {
  const { owner } = await fixture(), child = actor(owner), closing = owner.close(); void closing.catch(() => undefined);
  await child.quit; await expect(child.ready).resolves.toBe(false); await expect(closing).rejects.toThrow("The synthetic Electron control could not be verified.");
  expect(child.processStub.exitCode).toBe(1); expect(child.calls).not.toContain("load"); expect(child.stdout.join("")).not.toContain("PRIVATE");
});
it("the required native caller binds the captured child immediately, keeps secrets out of bridge env, and requires all control/stdio owners before deleting", () => {
  expect(native).toContain('control = createNativeFocusControl(root); ownership.control = control;\n    await bounded(control.listening, 5000);');
  expect(native).toContain('control.bindChild(process.pid);');
  expect(native).toContain('stdio: ["ignore", "pipe", "pipe"]');
  expect(native).toContain('ready: Promise.all([ready, control.authenticated]).then(([value]) => value, () => false)');
  expect(native).toContain('Promise.all([control.quit(), owned.closed]), 10_000');
  expect(native).toContain('await bounded(control.close(), 10_000); controlClean = true;');
  expect(native).toContain('cleanup = appClean && bridgeClean && controlClean && !bridgeBroken && !control?.broken();');
  expect(native).toContain('retainedFocusOwners.add(ownership);'); expect(native).toContain('retainedFocusOwners.delete(ownership);');
  expect(native).toContain('bridgeEnv(env, { EMBER_UIA_CACHE:');
  expect(source).not.toMatch(/process\.stdin|readline|--no-sandbox|executeJavaScript|net\.createServer|127\.0\.0\.1/);
});
