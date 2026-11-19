/** Windows argv/environment boundary, without claiming that a mocked process is a qualified WSL sandbox. */
import { expect, it } from "vitest";
import { wslCodingLaunch } from "../../app/main/agent/wsl-coding-transport";
import type { WslDistro } from "../../app/main/wsl/types";
import { EventEmitter } from "node:events";
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connectWslCodingHelper, resolveWslCodingHelperPath, type WslCodingTransportOptions } from "../../app/main/agent/wsl-coding-transport";
import type { SpawnLike } from "../../app/main/wsl/launch-sidecar";
import { WslCodingCleanupError } from "../../app/main/agent/wsl-coding-workspace";
import { decodeWslCodingMessage, wslCodingFrame, wslCodingFrameSink } from "../../app/main/agent/wsl-coding-protocol";

const distro: WslDistro = { name: "Ubuntu Work", version: 2, isDefault: false, defaultUid: 1000, running: false, needsSetup: false };
/** Genuine ChildProcess event contract, with only its unspawned stdio/kill ports replaced by owned test streams. */
class ProbeChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: ChildProcessWithoutNullStreams["stdio"] = [this.stdin, this.stdout, this.stderr, null, null];
  override kill(): boolean { return true; }
}
const input = () => ({ wslExe: "C:\\Windows\\System32\\wsl.exe", distro: { ...distro }, scriptLinuxPath: "/mnt/c/Program Files/Ember/resources/app/dist/app/wsl-coding.cjs",
  jobHost: { execPath: "C:\\Ember\\Ember.exe", script: "C:\\Ember\\resources\\app\\dist\\app\\job-host.cjs" }, env: {
    SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", WSLENV: "COPILOT_GITHUB_TOKEN/u:NODE_OPTIONS/u", wslEnv: "PRIVATE/u", NODE_OPTIONS: "--require=private",
    COPILOT_GITHUB_TOKEN: "PRIVATE_CREDENTIAL", ELECTRON_RUN_AS_NODE: "PRIVATE", } });
it("launches the fixed credential-free helper under the real job-host contract without shell interpolation", () => {
  const found = wslCodingLaunch(input());
  expect(found.command).toBe("C:\\Ember\\Ember.exe");
  expect(found.args).toEqual(["C:\\Ember\\resources\\app\\dist\\app\\job-host.cjs", "--interactive", "--", "C:\\Windows\\System32\\wsl.exe",
    "-d", "Ubuntu Work", "--cd", "/", "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "LC_ALL=C", "/usr/bin/node", "--", "/mnt/c/Program Files/Ember/resources/app/dist/app/wsl-coding.cjs"]);
  expect(Object.keys(found.env).filter(k => k.toLowerCase() === "wslenv")).toEqual(["WSLENV"]);
  expect(found.env.WSLENV).toBe(""); expect(found.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(JSON.stringify(found)).not.toContain("PRIVATE_CREDENTIAL"); expect(found.env.NODE_OPTIONS).toBeUndefined();
});
it.each(["version1", "root", "unknown-user", "tool", "setup", "name", "script", "exe", "job"])("refuses %s without starting a distro or relaxing selection", kind => {
  const value = input();
  if (kind === "version1") value.distro.version = 1;
  if (kind === "root") value.distro.defaultUid = 0;
  if (kind === "unknown-user") value.distro.defaultUid = null;
  if (kind === "tool") value.distro.tool = "podman";
  if (kind === "setup") value.distro.needsSetup = true;
  if (kind === "name") value.distro.name = "Ubuntu\nInjected";
  if (kind === "script") value.scriptLinuxPath = "/mnt/c/../private/wsl-coding.cjs";
  if (kind === "exe") value.wslExe = "project\\wsl.exe";
  if (kind === "job") value.jobHost.execPath = "Ember.exe";
  expect(() => wslCodingLaunch(value)).toThrow("unavailable");
});
it("translates an installed Windows path as literal fixed-script input and accepts a custom mount root", async () => {
  let body = "";
  const spawn: SpawnLike = (_command, args, options) => {
    expect(args).toContain("--interactive"); expect(args).toContain("/bin/sh");
    expect(options.env?.WSLENV).not.toContain("PRIVATE");
    const child = new ProbeChild();
    child.stdin.on("data", bytes => { body += bytes.toString(); queueMicrotask(() => { child.stdout.write("/drives/x/Ember/wsl-coding.cjs\n"); child.emit("close", 0); }); }); return child;
  };
  const found = await resolveWslCodingHelperPath({ ...input(), scriptWindowsPath: "X:\\Ember\\wsl-coding.cjs", current: () => true, spawn });
  expect(found).toBe("/drives/x/Ember/wsl-coding.cjs");
  expect(body).toContain("/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/wslpath -a -u");
  expect(body).toContain("<<'EMBER_INPUT_END'\nX:\\Ember\\wsl-coding.cjs\nEMBER_INPUT_END");
});
it("does not probe a retired capability or interpolate malformed Windows path lines", async () => {
  const spawn: SpawnLike = () => { throw new Error("No process may start."); };
  await expect(resolveWslCodingHelperPath({ ...input(), scriptWindowsPath: "X:\\Ember\\wsl-coding.cjs", current: () => false, spawn })).rejects.toThrow("unavailable");
  await expect(resolveWslCodingHelperPath({ ...input(), scriptWindowsPath: "X:\\Ember\n\\wsl-coding.cjs", current: () => true, spawn })).rejects.toThrow("unavailable");
});
it("retains a typed unknown cleanup when the fixed probe reports an error before process close", async () => {
  const spawn: SpawnLike = () => {
    const child = new ProbeChild();
    queueMicrotask(() => child.emit("error", new Error("Private process diagnostics."))); return child;
  };
  await expect(resolveWslCodingHelperPath({ ...input(), scriptWindowsPath: "X:\\Ember\\wsl-coding.cjs", current: () => true, spawn })).rejects.toBeInstanceOf(WslCodingCleanupError);
});
it("retains a typed unknown helper owner when handshake failure cannot positively close the helper", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const spawn = (() => { queueMicrotask(() => child.stdout.end("unframed private diagnostic")); return child; }) as unknown as WslCodingTransportOptions["spawn"];
  try { await expect(connectWslCodingHelper({ ...input(), current: () => true, spawn })).rejects.toBeInstanceOf(WslCodingCleanupError); }
  finally { child.emit("close", 1, null); }
});
it.each([0, -1, 1001, 1.5, "1000", null, undefined])("refuses actual guest uid %s before provisioning and positively closes the clean helper", async uid => {
  const methods: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const { guard, sink } = wslCodingFrameSink(body => {
    const request = decodeWslCodingMessage(body, "request"); methods.push(request.method);
    const value = request.method === "hello" ? { protocol: 1, kind: "linux-helper", noNetwork: true, uid, provisioned: false, opened: false, retired: false } : { closed: true, cleanup: "complete" };
    child.stdout.write(wslCodingFrame({ kind: "result", id: request.id, episode: request.episode, nonce: request.nonce, value }));
    if (request.method === "close") setImmediate(() => { child.stdout.end(); child.emit("close", 0, null); });
  });
  void pipeline(child.stdin, guard, sink).catch(() => undefined);
  const spawn = (() => child) as unknown as WslCodingTransportOptions["spawn"];
  await expect(connectWslCodingHelper({ ...input(), current: () => true, spawn })).rejects.toMatchObject({ code: "unavailable" });
  expect(methods).toEqual(["hello", "close"]);
});
it.each([1000, 1001])("compares held hello uid %s with the captured user even when the caller mutates discovery", async uid => {
  const child = new ProbeChild(), methods: string[] = [];
  let started!: () => void, release!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  const { guard, sink } = wslCodingFrameSink(body => {
    const request = decodeWslCodingMessage(body, "request"); methods.push(request.method);
    const reply = (value: unknown) => child.stdout.write(wslCodingFrame({ kind: "result", id: request.id, episode: request.episode, nonce: request.nonce, value }));
    if (request.method === "hello") { release = () => reply({ protocol: 1, kind: "linux-helper", noNetwork: true, uid, provisioned: false, opened: false, retired: false }); started(); }
    else { reply({ closed: true, cleanup: "complete" }); setImmediate(() => { child.stdout.end(); child.emit("close", 0, null); }); }
  });
  void pipeline(child.stdin, guard, sink).catch(() => undefined);
  const options = { ...input(), current: () => true, spawn: (() => child) as unknown as WslCodingTransportOptions["spawn"] };
  const opening = connectWslCodingHelper(options); void opening.catch(() => undefined); await begun;
  options.distro.defaultUid = 1001; options.distro.name = "Changed distro"; options.distro.version = 1; release();
  if (uid === 1000) await (await opening).close();
  else await expect(opening).rejects.toMatchObject({ code: "unavailable" });
  expect(methods).toEqual(["hello", "close"]);
});
it("keeps the path probe bound to its original distro/install inputs across an awaited result", async () => {
  const child = new ProbeChild(); let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const spawn: SpawnLike = (_command, args) => { expect(args).toContain("Ubuntu Work"); child.stdin.once("data", started); return child; };
  const options = { ...input(), scriptWindowsPath: "X:\\Ember\\wsl-coding.cjs", current: () => true, spawn };
  const resolving = resolveWslCodingHelperPath(options); await begun;
  options.distro.version = 1; options.distro.defaultUid = 0; options.distro.name = "Changed distro";
  options.jobHost.execPath = "changed-relative.exe"; options.wslExe = "changed-relative.exe";
  child.stdout.write("/drives/x/Ember/wsl-coding.cjs\n"); child.emit("close", 0, null);
  await expect(resolving).resolves.toBe("/drives/x/Ember/wsl-coding.cjs");
});
