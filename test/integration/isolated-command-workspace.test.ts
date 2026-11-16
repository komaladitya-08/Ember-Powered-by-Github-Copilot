/** Real Linux command-only namespaces. The SDK/controller and credentials never enter these processes. */
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { codingTestIsolationSupported, trustedCodingTestNodeOrSkip } from "../fixtures/coding/trusted-node";
import { IsolatedCommandWorkspace, type IsolatedCommandWorkspaceInput } from "../../app/main/agent/isolated-command-workspace";
import { ExperimentalNamespaceReceipt } from "../../app/main/agent/experimental-stop-receipt";
import { linuxKeyringProbe } from "../fixtures/coding/linux-keyring-probe";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const supported = codingTestIsolationSupported;
async function fixture(extra: Partial<IsolatedCommandWorkspaceInput> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-command-workspace-")); roots.push(root);
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), exports = path.join(root, "exports");
  for (const dir of [source, baseDir, privateDir, exports]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(privateDir, "private.txt"), "PRIVATE_HOST_CANARY");
  const input: IsolatedCommandWorkspaceInput = { source, baseDir, protectedPaths: [privateDir],
    binding: { owner: "a".repeat(64), session: crypto.randomUUID(), snapshot: crypto.randomUUID() }, ...extra };
  return { root, source, baseDir, privateDir, exports, input };
}
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("denies direct kernel key APIs in a real command while copied Node and Bash remain usable", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath }), probe = linuxKeyringProbe();
  fs.writeFileSync(path.join(f.source, "keyring-probe"), probe, { mode: 0o700 });
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    const chunks: Uint8Array[] = [];
    const result = await workspace.run("./keyring-probe", "/work", bytes => chunks.push(Uint8Array.from(bytes)), signal());
    expect(result).toMatchObject({ exitCode: 0, observed: true, stopped: false, outputLimited: false });
    const values = Buffer.concat(chunks); expect(values.length).toBe(24);
    expect([0, 8, 16].map(offset => values.readBigInt64LE(offset))).toEqual([-1n, -1n, -1n]); // EPERM
    // The ambient container may already refuse these APIs. Independent BPF semantics prove Ember's own denial.
    expect(await workspace.run("test 2 -gt 1 && node -p '6 * 7'", "/work", () => undefined, signal())).toMatchObject({ exitCode: 0, output: "42\n", observed: true });
    expect(fs.readFileSync(path.join(f.source, "keyring-probe"))).toEqual(probe);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("runs useful copied Node tests without a host environment, network, source mount or SDK process", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath });
  fs.writeFileSync(path.join(f.source, "test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(1+1,2));\n");
  const previous = process.env.EMBER_COMMAND_CANARY; process.env.EMBER_COMMAND_CANARY = "HOST_ENV_CANARY";
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    expect(workspace.executionRoot).toBe("/work"); expect(workspace.nodeAvailable).toBe(true);
    const chunks: Uint8Array[] = [];
    const tested = await workspace.run("node --test test.cjs", "/work", bytes => chunks.push(Uint8Array.from(bytes)), signal());
    expect(tested).toMatchObject({ exitCode: 0, observed: true, stopped: false });
    expect(Buffer.concat(chunks).toString()).toContain("sum");
    const command = "if (: <&3) 2>/dev/null || (: >&3) 2>/dev/null || (: <&4) 2>/dev/null || (: >&4) 2>/dev/null; then printf inherited > host-fds; else printf closed > host-fds; fi; " +
      "node -e \"const f=require('fs');f.writeFileSync('probe.json',JSON.stringify({env:process.env.EMBER_COMMAND_CANARY,private:f.existsSync('" + path.join(f.privateDir, "private.txt") + "'),source:f.existsSync('" + f.source + "')}));f.writeFileSync('project.txt','proposed');\"";
    expect((await workspace.run(command, "/work", () => undefined, signal())).exitCode).toBe(0);
    const probe = await workspace.files(async root => JSON.parse(fs.readFileSync(path.join(root, "probe.json"), "utf8")));
    expect(probe).toEqual({ private: false, source: false });
    expect(await workspace.files(async root => fs.readFileSync(path.join(root, "host-fds"), "utf8"))).toBe("closed");
    const net = await workspace.run("if (: > /dev/tcp/127.0.0.1/9) 2>/dev/null; then printf bad; else printf blocked; fi", "/work", () => undefined, signal());
    expect(net.output).toBe("blocked");
    expect(fs.existsSync(path.join(f.source, "project.txt"))).toBe(false);
    const exported = await workspace.exportReview(f.exports);
    expect(exported.cleanup).toBe("complete");
    expect(exported.review.proposed.find(e => e.path === "project.txt")).toMatchObject({ base64: Buffer.from("proposed").toString("base64") });
    expect(fs.readFileSync(path.join(exported.directory, "review.json"), "utf8")).not.toContain("HOST_ENV_CANARY");
    await workspace.close();
    await expect(workspace.exportReview(f.exports)).rejects.toThrow("closing or already exporting");
    expect(exported.review.proposed.find(e => e.path === "project.txt")).toMatchObject({ base64: Buffer.from("proposed").toString("base64") });
    expect(fs.readFileSync(path.join(exported.directory, "review.json"), "utf8")).toContain("project.txt");
  } finally { await workspace.close(); if (previous === undefined) delete process.env.EMBER_COMMAND_CANARY; else process.env.EMBER_COMMAND_CANARY = previous; }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("serialises file callbacks with whole commands and kills background writers before the next lease", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input);
  const entered = deferred<void>(), release = deferred<void>();
  try {
    const first = workspace.files(async root => { entered.resolve(); await release.promise; fs.writeFileSync(path.join(root, "first"), "done"); });
    await entered.promise;
    let began = false;
    const command = workspace.run("printf started; (while :; do printf x >> /work/heartbeat; sleep 0.02; done) >/dev/null 2>&1 & sleep 0.1; printf last > /work/last", "/work", () => { began = true; }, signal());
    let fileRan = false;
    const after = workspace.files(async root => {
      fileRan = true; expect(fs.readFileSync(path.join(root, "last"), "utf8")).toBe("last");
      const before = fs.readFileSync(path.join(root, "heartbeat"), "utf8");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(fs.readFileSync(path.join(root, "heartbeat"), "utf8")).toBe(before);
    });
    await Promise.resolve(); expect(began).toBe(false); expect(fileRan).toBe(false);
    release.resolve(); await first;
    expect(await command).toMatchObject({ exitCode: 0, observed: true }); await after;
    expect(fileRan).toBe(true);
  } finally { release.resolve(); await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("Stop cancels a running namespace and queued file callbacks, then permits an inert review", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input), begun = deferred<void>();
  const running = workspace.run("printf started; sleep 10; printf forbidden > /work/late", "/work", () => begun.resolve(), signal());
  try {
    await begun.promise;
    let read = false;
    const queued = workspace.files(async () => { read = true; }).catch(error => error);
    await workspace.stop();
    expect(await running).toMatchObject({ stopped: true, observed: true });
    expect(await queued).toBeInstanceOf(Error); expect(read).toBe(false);
    await expect(workspace.run("printf later", "/work", () => undefined, signal())).rejects.toThrow("stopped or closed");
    const exported = await workspace.exportReview(f.exports);
    expect(exported.review.proposed.some(e => e.path === "late")).toBe(false);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("cancels one command without revoking diagnostic file leases after verified writer shutdown", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input), begun = deferred<void>(), command = new AbortController();
  try {
    const running = workspace.run("(while :; do printf x >> /work/heartbeat; sleep 0.02; done) >/dev/null 2>&1 & while test ! -s /work/heartbeat; do sleep 0.01; done; printf started; sleep 10; printf forbidden > /work/late", "/work", () => begun.resolve(), command.signal);
    await begun.promise;
    const diagnostics = workspace.files(async root => {
      expect(fs.existsSync(path.join(root, "late"))).toBe(false);
      const before = fs.readFileSync(path.join(root, "heartbeat"), "utf8"); expect(before.length).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = fs.readFileSync(path.join(root, "heartbeat"), "utf8");
      expect(after).toBe(before); fs.writeFileSync(path.join(root, "diagnostic.txt"), "writers stopped");
      return "available";
    });
    command.abort();
    expect(await running).toMatchObject({ stopped: true, observed: true });
    expect(await diagnostics).toBe("available");
    expect(await workspace.files(async root => fs.readFileSync(path.join(root, "diagnostic.txt"), "utf8"))).toBe("writers stopped");
    const review = await workspace.exportReview(f.exports);
    expect(review.review.proposed.some(file => file.path === "diagnostic.txt")).toBe(true);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("checks host admission immediately before releasing the command barrier and permanently fences stale work", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  let admitted = true;
  const f = await fixture({ admit: () => admitted }), workspace = await IsolatedCommandWorkspace.create(f.input);
  const capture = ExperimentalNamespaceReceipt.capture.bind(ExperimentalNamespaceReceipt);
  vi.spyOn(ExperimentalNamespaceReceipt, "capture").mockImplementation(async file => {
    const receipt = await capture(file); admitted = false; return receipt;
  });
  try {
    expect(await workspace.run("printf forbidden > /work/command-marker", "/work", () => undefined, signal())).toMatchObject({ stopped: true, observed: true });
    await expect(workspace.files(async () => "forbidden")).rejects.toThrow("stopped or closed");
    admitted = true;
    await expect(workspace.run("printf forbidden", "/work", () => undefined, signal())).rejects.toThrow("stopped or closed");
    const result = await workspace.exportReview(f.exports);
    expect(result.review.proposed.some(file => file.path === "command-marker")).toBe(false);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("rejects stale creation and queued file leases, and withholds an active callback after admission changes", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  let admitted = false;
  const f = await fixture({ admit: () => admitted });
  await expect(IsolatedCommandWorkspace.create(f.input)).rejects.toThrow("no longer current");
  expect(fs.readdirSync(f.baseDir)).toEqual([]);
  admitted = true;
  const workspace = await IsolatedCommandWorkspace.create(f.input), entered = deferred<void>(), release = deferred<void>();
  try {
    const active = workspace.files(async () => { entered.resolve(); await release.promise; return "revoked data"; }).catch(error => error);
    await entered.promise;
    let accessed = false;
    const queued = workspace.files(async () => { accessed = true; }).catch(error => error);
    admitted = false; release.resolve();
    expect(await active).toBeInstanceOf(Error); expect(await queued).toBeInstanceOf(Error); expect(accessed).toBe(false);
    admitted = true;
    await expect(workspace.files(async () => "forbidden")).rejects.toThrow("stopped or closed");
  } finally { release.resolve(); await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("bounds output and time while preserving raw binary callback bytes", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ limits: { outputBytes: 128, maxMs: 250 }, nodePath: asset.nodePath });
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    const raw: Uint8Array[] = [];
    expect(await workspace.run("printf '\\000\\377A'", "/work", bytes => raw.push(Uint8Array.from(bytes)), signal())).toMatchObject({ exitCode: 0, observed: true });
    expect(Buffer.concat(raw)).toEqual(Buffer.from([0, 255, 65]));
    const noisy = await workspace.run("while :; do printf abcdefghijklmnopqrstuvwxyz; done", "/work", () => undefined, signal());
    expect(noisy.outputLimited).toBe(true); expect(noisy.observed).toBe(true); expect(Buffer.byteLength(noisy.output)).toBeLessThanOrEqual(128);
    const slow = await workspace.run("sleep 10", "/work", () => undefined, signal());
    expect(slow).toMatchObject({ timedOut: true, observed: true });
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses known credential-bearing copies before commands can encode them", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(); fs.writeFileSync(path.join(f.source, ".env"), "ordinary=value");
  await expect(IsolatedCommandWorkspace.create(f.input)).rejects.toThrow("credential");
  expect(fs.readdirSync(f.baseDir)).toEqual([]);
  fs.unlinkSync(path.join(f.source, ".env")); fs.writeFileSync(path.join(f.source, "notes.txt"), "the password is hunter2");
  await expect(IsolatedCommandWorkspace.create(f.input)).rejects.toThrow("credential");
  fs.unlinkSync(path.join(f.source, "notes.txt"));
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    await workspace.files(async root => { fs.writeFileSync(path.join(root, ".env"), "ordinary=value"); });
    await expect(workspace.run("cat .env > encoded", "/work", () => undefined, signal())).rejects.toThrow("credential");
    await expect(workspace.exportReview(f.exports)).rejects.toThrow("credential");
    expect(fs.readdirSync(f.exports)).toEqual([]);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses private coding copies and the private base itself as a new project source", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    const ownedCopy = await workspace.files(async root => root), before = fs.readdirSync(f.baseDir).sort();
    await expect(IsolatedCommandWorkspace.create({ ...f.input, source: ownedCopy })).rejects.toThrow("outside Ember's private coding folder");
    await expect(IsolatedCommandWorkspace.create({ ...f.input, source: f.baseDir })).rejects.toThrow("outside Ember's private coding folder");
    const alias = path.join(f.root, "coding-alias"); fs.symlinkSync(f.baseDir, alias, "dir");
    await expect(IsolatedCommandWorkspace.create({ ...f.input, source: path.join(alias, path.basename(ownedCopy)) })).rejects.toThrow("outside Ember's private coding folder");
    expect(fs.readdirSync(f.baseDir).sort()).toEqual(before);
    expect(await workspace.files(async root => root)).toBe(ownedCopy);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("exports conflicts without reading an ungranted replacement at the selected source path", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(); fs.writeFileSync(path.join(f.source, "project.txt"), "baseline");
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    await workspace.files(async root => { fs.writeFileSync(path.join(root, "project.txt"), "proposed"); });
    const original = f.source + "-moved"; fs.renameSync(f.source, original); fs.mkdirSync(f.source, { mode: 0o700 });
    fs.writeFileSync(path.join(f.source, "project.txt"), "UNGRANTED_SOURCE_CANARY");
    const result = await workspace.exportReview(f.exports);
    expect(result.review.current).toBeNull(); expect(result.review.patchComplete).toBe(false);
    expect(result.review.changes[0]?.conflicts).toContain("The original project was not captured; concurrent changes are unknown.");
    expect(JSON.stringify(result.review)).not.toContain(Buffer.from("UNGRANTED_SOURCE_CANARY").toString("base64"));
    expect(result.review.baseline[0]).toMatchObject({ base64: Buffer.from("baseline").toString("base64") });
    expect(result.review.proposed[0]).toMatchObject({ base64: Buffer.from("proposed").toString("base64") });
    expect(fs.readFileSync(path.join(original, "project.txt"), "utf8")).toBe("baseline");
    expect(fs.readFileSync(path.join(f.source, "project.txt"), "utf8")).toBe("UNGRANTED_SOURCE_CANARY");
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("fences all further access and retains copies when namespace shutdown cannot be verified", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input);
  const realProof = ExperimentalNamespaceReceipt.prototype.requireExited;
  const failure = vi.spyOn(ExperimentalNamespaceReceipt.prototype, "requireExited").mockRejectedValue(new Error("Unavailable stop witness"));
  try {
    await expect(workspace.run("printf done", "/work", () => undefined, signal())).rejects.toThrow("retained");
    const receipt = failure.mock.contexts[0] as ExperimentalNamespaceReceipt;
    failure.mockRestore(); await realProof.call(receipt);
    await expect(workspace.files(async () => true)).rejects.toThrow("retained");
    await expect(workspace.exportReview(f.exports)).rejects.toThrow("retained");
    await expect(workspace.close()).rejects.toThrow("retained");
    expect(fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-coding-snapshot-"))).toBe(true);
    expect(fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-command-state-"))).toBe(true);
  } finally { failure.mockRestore(); }
}, 30_000);
