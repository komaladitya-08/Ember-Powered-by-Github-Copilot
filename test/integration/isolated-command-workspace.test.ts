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
import type { ShellId } from "../../app/main/commands/types";

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

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses unsupported or missing grammars before they can write and retains valid bash admission", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    for (const shell of ["sh", "zsh", "powershell", "cmd", undefined] as const) {
      await expect(workspace.run("printf forbidden > /work/grammar-marker", "/work", () => undefined, signal(), shell as ShellId)).rejects.toThrow("advertised bash shell");
    }
    expect(await workspace.files(async root => fs.existsSync(path.join(root, "grammar-marker")))).toBe(false);
    expect(await workspace.run("printf admitted > /work/grammar-marker", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 0, observed: true });
    expect(await workspace.files(async root => fs.readFileSync(path.join(root, "grammar-marker"), "utf8"))).toBe("admitted");
    expect(fs.existsSync(path.join(f.source, "grammar-marker"))).toBe(false);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("denies direct kernel key APIs in a real command while copied Node and Bash remain usable", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath }), probe = linuxKeyringProbe();
  fs.writeFileSync(path.join(f.source, "keyring-probe"), probe, { mode: 0o700 });
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    const chunks: Uint8Array[] = [];
    const result = await workspace.run("./keyring-probe", "/work", bytes => chunks.push(Uint8Array.from(bytes)), signal(), "bash");
    expect(result).toMatchObject({ exitCode: 0, observed: true, stopped: false, outputLimited: false });
    const values = Buffer.concat(chunks); expect(values.length).toBe(24);
    expect([0, 8, 16].map(offset => values.readBigInt64LE(offset))).toEqual([-1n, -1n, -1n]); // EPERM
    // The ambient container may already refuse these APIs. Independent BPF semantics prove Ember's own denial.
    expect(await workspace.run("test 2 -gt 1 && node -p '6 * 7'", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 0, output: "42\n", observed: true });
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
    const tested = await workspace.run("node --test test.cjs", "/work", bytes => chunks.push(Uint8Array.from(bytes)), signal(), "bash");
    expect(tested).toMatchObject({ exitCode: 0, observed: true, stopped: false });
    expect(Buffer.concat(chunks).toString()).toContain("sum");
    const command = "if (: <&3) 2>/dev/null || (: >&3) 2>/dev/null || (: <&4) 2>/dev/null || (: >&4) 2>/dev/null; then printf inherited > host-fds; else printf closed > host-fds; fi; " +
      "node -e \"const f=require('fs');f.writeFileSync('probe.json',JSON.stringify({env:process.env.EMBER_COMMAND_CANARY,private:f.existsSync('" + path.join(f.privateDir, "private.txt") + "'),source:f.existsSync('" + f.source + "')}));f.writeFileSync('project.txt','proposed');\"";
    expect((await workspace.run(command, "/work", () => undefined, signal(), "bash")).exitCode).toBe(0);
    const probe = await workspace.files(async root => JSON.parse(fs.readFileSync(path.join(root, "probe.json"), "utf8")));
    expect(probe).toEqual({ private: false, source: false });
    expect(await workspace.files(async root => fs.readFileSync(path.join(root, "host-fds"), "utf8"))).toBe("closed");
    const net = await workspace.run("if (: > /dev/tcp/127.0.0.1/9) 2>/dev/null; then printf bad; else printf blocked; fi", "/work", () => undefined, signal(), "bash");
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
    const command = workspace.run("printf started; (while :; do printf x >> /work/heartbeat; sleep 0.02; done) >/dev/null 2>&1 & sleep 0.1; printf last > /work/last", "/work", () => { began = true; }, signal(), "bash");
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
  const running = workspace.run("printf started; sleep 10; printf forbidden > /work/late", "/work", () => begun.resolve(), signal(), "bash");
  try {
    await begun.promise;
    let read = false;
    const queued = workspace.files(async () => { read = true; }).catch(error => error);
    await workspace.stop();
    expect(await running).toMatchObject({ stopped: true, observed: true });
    expect(await queued).toBeInstanceOf(Error); expect(read).toBe(false);
    await expect(workspace.run("printf later", "/work", () => undefined, signal(), "bash")).rejects.toThrow("stopped or closed");
    const exported = await workspace.exportReview(f.exports);
    expect(exported.review.proposed.some(e => e.path === "late")).toBe(false);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("cancels one command without revoking diagnostic file leases after verified writer shutdown", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const f = await fixture(), workspace = await IsolatedCommandWorkspace.create(f.input), begun = deferred<void>(), command = new AbortController();
  try {
    const running = workspace.run("(while :; do printf x >> /work/heartbeat; sleep 0.02; done) >/dev/null 2>&1 & while test ! -s /work/heartbeat; do sleep 0.01; done; printf started; sleep 10; printf forbidden > /work/late", "/work", () => begun.resolve(), command.signal, "bash");
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
    expect(await workspace.run("printf forbidden > /work/command-marker", "/work", () => undefined, signal(), "bash")).toMatchObject({ stopped: true, observed: true });
    await expect(workspace.files(async () => "forbidden")).rejects.toThrow("stopped or closed");
    admitted = true;
    await expect(workspace.run("printf forbidden", "/work", () => undefined, signal(), "bash")).rejects.toThrow("stopped or closed");
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
    expect(await workspace.run("printf '\\000\\377A'", "/work", bytes => raw.push(Uint8Array.from(bytes)), signal(), "bash")).toMatchObject({ exitCode: 0, observed: true });
    expect(Buffer.concat(raw)).toEqual(Buffer.from([0, 255, 65]));
    const noisy = await workspace.run("while :; do printf abcdefghijklmnopqrstuvwxyz; done", "/work", () => undefined, signal(), "bash");
    expect(noisy.outputLimited).toBe(true); expect(noisy.observed).toBe(true); expect(Buffer.byteLength(noisy.output)).toBeLessThanOrEqual(128);
    const slow = await workspace.run("sleep 10", "/work", () => undefined, signal(), "bash");
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
    await expect(workspace.run("cat .env > encoded", "/work", () => undefined, signal(), "bash")).rejects.toThrow("credential");
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
    await expect(workspace.run("printf done", "/work", () => undefined, signal(), "bash")).rejects.toThrow("retained");
    const receipt = failure.mock.contexts[0] as ExperimentalNamespaceReceipt;
    failure.mockRestore(); await realProof.call(receipt);
    await expect(workspace.files(async () => true)).rejects.toThrow("retained");
    await expect(workspace.exportReview(f.exports)).rejects.toThrow("retained");
    await expect(workspace.close()).rejects.toThrow("retained");
    expect(fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-coding-snapshot-"))).toBe(true);
    expect(fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-command-state-"))).toBe(true);
  } finally { failure.mockRestore(); }
}, 30_000);


it.skipIf(process.platform !== "linux" || process.arch !== "x64")("runs fixed Node with literal argument boundaries captured before a queued file lease", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath });
  const workspace = await IsolatedCommandWorkspace.create(f.input), entered = deferred<void>(), release = deferred<void>();
  try {
    const lease = workspace.files(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const literals = ["", "two words", "'single' and \"double\"", "$HOME", "$(touch /work/forbidden)", "`touch /work/forbidden`", "*", "; touch /work/forbidden", "é\nline"];
    const argv = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...literals];
    const chunks: Uint8Array[] = [];
    const pending = workspace.runNode(argv, "/work", bytes => chunks.push(Uint8Array.from(bytes)), signal());
    argv.splice(0, argv.length, "-e", "require('fs').writeFileSync('/work/forbidden','mutated')");
    expect(chunks).toEqual([]); release.resolve(); await lease;
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 0, observed: true, stopped: false, timedOut: false, outputLimited: false });
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(literals);
    expect(await workspace.files(async root => fs.existsSync(path.join(root, "forbidden")))).toBe(false);
    expect(fs.readdirSync(f.source)).toEqual([]);
  } finally { release.resolve(); await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses absent Node, invalid argv and invalid cwd before acquiring a busy workspace lease", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture(), noNode = await IsolatedCommandWorkspace.create(f.input);
  const entered = deferred<void>(), release = deferred<void>();
  const lease = noNode.files(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  try {
    expect(noNode.nodeAvailable).toBe(false);
    await expect(noNode.runNode(["-e", "throw Error('forbidden')"], "/work", () => undefined, signal())).rejects.toThrow("host-selected Node");
  } finally { release.resolve(); await lease; await noNode.close(); }
  const enabled = await fixture({ nodePath: asset.nodePath }), workspace = await IsolatedCommandWorkspace.create(enabled.input);
  const entered2 = deferred<void>(), release2 = deferred<void>(), output = vi.fn();
  const lease2 = workspace.files(async () => { entered2.resolve(); await release2.promise; }); await entered2.promise;
  try {
    for (const argv of [["nul\0argument"], ["\ud800"], Array(257).fill(""), ["é".repeat(4000)]]) {
      await expect(workspace.runNode(argv, "/work", output, signal())).rejects.toThrow("arguments");
    }
    for (const cwd of ["/", "/work/../private", "/work/./sub", "/work\\sub", "/work/\nsub"]) {
      await expect(workspace.runNode(["--version"], cwd, output, signal())).rejects.toThrow("inside the isolated workspace");
    }
    expect(output).not.toHaveBeenCalled();
  } finally { release2.resolve(); await lease2; await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("direct Node retains isolated tests, environment, network and source boundaries", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath });
  fs.writeFileSync(path.join(f.source, "direct.test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('direct sum',()=>assert.equal(20+22,42));\n");
  const previous = process.env.EMBER_DIRECT_NODE_CANARY; process.env.EMBER_DIRECT_NODE_CANARY = "PRIVATE_ENV_CANARY";
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    const tested = await workspace.runNode(["--test", "direct.test.cjs"], "/work", () => undefined, signal());
    expect(tested).toMatchObject({ exitCode: 0, observed: true, stopped: false }); expect(tested.output).toContain("direct sum");
    const code = `const f=require('node:fs');const net=require('node:net');const result={env:process.env.EMBER_DIRECT_NODE_CANARY,private:f.existsSync(${JSON.stringify(path.join(f.privateDir, "private.txt"))}),source:f.existsSync(${JSON.stringify(f.source)})};const s=net.connect({host:'127.0.0.1',port:9});s.once('error',()=>{result.network='blocked';f.writeFileSync('/work/probe.json',JSON.stringify(result));});s.once('connect',()=>{s.destroy();process.exitCode=9;});`;
    expect(await workspace.runNode(["-e", code], "/work", () => undefined, signal())).toMatchObject({ exitCode: 0, observed: true });
    expect(await workspace.files(async root => JSON.parse(fs.readFileSync(path.join(root, "probe.json"), "utf8")))).toEqual({ private: false, source: false, network: "blocked" });
    expect(fs.existsSync(path.join(f.source, "probe.json"))).toBe(false);
    const exported = await workspace.exportReview(f.exports);
    expect(exported.cleanup).toBe("complete"); expect(JSON.stringify(exported.review)).not.toContain("PRIVATE_ENV_CANARY");
  } finally { await workspace.close(); if (previous === undefined) delete process.env.EMBER_DIRECT_NODE_CANARY; else process.env.EMBER_DIRECT_NODE_CANARY = previous; }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("direct Node Stop waits for descendant writers before diagnostic files become accessible", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath });
  const workspace = await IsolatedCommandWorkspace.create(f.input), begun = deferred<void>(), command = new AbortController();
  try {
    const writer = "const f=require('node:fs');setInterval(()=>f.appendFileSync('/work/heartbeat','x'),10)";
    const code = `const f=require('node:fs');require('node:child_process').spawn('/usr/bin/node',['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'});const ready=setInterval(()=>{if(f.existsSync('/work/heartbeat')){clearInterval(ready);process.stdout.write('started');}},5);setTimeout(()=>f.writeFileSync('/work/late','forbidden'),10000);`;
    const running = workspace.runNode(["-e", code], "/work", () => begun.resolve(), command.signal);
    await begun.promise;
    const diagnostics = workspace.files(async root => {
      expect(fs.existsSync(path.join(root, "late"))).toBe(false);
      const before = fs.readFileSync(path.join(root, "heartbeat"), "utf8"); expect(before.length).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(fs.readFileSync(path.join(root, "heartbeat"), "utf8")).toBe(before);
      fs.writeFileSync(path.join(root, "diagnostic.txt"), "writers stopped");
    });
    command.abort(); expect(await running).toMatchObject({ stopped: true, observed: true }); await diagnostics;
    expect(await workspace.run("test -s /work/diagnostic.txt", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 0, observed: true });
    expect(fs.existsSync(path.join(f.source, "heartbeat"))).toBe(false);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("direct Node uses the same final host admission barrier and fences stale mixed work", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx); let admitted = true;
  const f = await fixture({ nodePath: asset.nodePath, admit: () => admitted }), workspace = await IsolatedCommandWorkspace.create(f.input);
  const capture = ExperimentalNamespaceReceipt.capture.bind(ExperimentalNamespaceReceipt);
  vi.spyOn(ExperimentalNamespaceReceipt, "capture").mockImplementation(async file => { const receipt = await capture(file); admitted = false; return receipt; });
  try {
    expect(await workspace.runNode(["-e", "require('node:fs').writeFileSync('/work/node-marker','forbidden')"], "/work", () => undefined, signal())).toMatchObject({ stopped: true, observed: true });
    admitted = true;
    await expect(workspace.runNode(["--version"], "/work", () => undefined, signal())).rejects.toThrow("stopped or closed");
    await expect(workspace.run("printf forbidden", "/work", () => undefined, signal(), "bash")).rejects.toThrow("stopped or closed");
    await expect(workspace.files(async () => true)).rejects.toThrow("stopped or closed");
    const exported = await workspace.exportReview(f.exports);
    expect(exported.review.proposed.some(entry => entry.path === "node-marker")).toBe(false);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("direct Node preserves binary output, output bounds and real timeout shutdown proofs", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath, limits: { outputBytes: 128, maxMs: 250 } });
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    const chunks: Uint8Array[] = [];
    expect(await workspace.runNode(["-e", "process.stdout.write(Buffer.from([0,255,65]))"], "/work", bytes => chunks.push(Uint8Array.from(bytes)), signal())).toMatchObject({ exitCode: 0, observed: true });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 65]));
    const noisy = await workspace.runNode(["-e", "process.stdout.write(Buffer.alloc(1024,65));setInterval(()=>{},1000)"], "/work", () => undefined, signal());
    expect(noisy).toMatchObject({ observed: true, outputLimited: true }); expect(Buffer.byteLength(noisy.output)).toBeLessThanOrEqual(128);
    expect(await workspace.runNode(["-e", "setInterval(()=>{},1000)"], "/work", () => undefined, signal())).toMatchObject({ timedOut: true, observed: true });
    expect(await workspace.files(async root => fs.readdirSync(root))).toEqual([]);
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("direct Node rechecks copied credentials before any script can encode them", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath }), workspace = await IsolatedCommandWorkspace.create(f.input), output = vi.fn();
  try {
    await workspace.files(async root => fs.writeFileSync(path.join(root, ".env"), "ordinary=value"));
    await expect(workspace.runNode(["-e", "const f=require('node:fs');f.writeFileSync('/work/encoded',f.readFileSync('/work/.env').toString('base64'))"], "/work", output, signal())).rejects.toThrow("credential");
    expect(output).not.toHaveBeenCalled();
    expect(await workspace.files(async root => fs.existsSync(path.join(root, "encoded")))).toBe(false);
    await expect(workspace.exportReview(f.exports)).rejects.toThrow("credential");
  } finally { await workspace.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("an uncertain direct Node writer proof retains the copy and fences both execution paths", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = await fixture({ nodePath: asset.nodePath }), workspace = await IsolatedCommandWorkspace.create(f.input);
  const realProof = ExperimentalNamespaceReceipt.prototype.requireExited;
  const failure = vi.spyOn(ExperimentalNamespaceReceipt.prototype, "requireExited").mockRejectedValue(new Error("Unavailable stop witness"));
  try {
    await expect(workspace.runNode(["-e", "process.stdout.write('done')"], "/work", () => undefined, signal())).rejects.toThrow("retained");
    const receipt = failure.mock.contexts[0] as ExperimentalNamespaceReceipt;
    failure.mockRestore(); await realProof.call(receipt);
    await expect(workspace.runNode(["--version"], "/work", () => undefined, signal())).rejects.toThrow("retained");
    await expect(workspace.run("printf later", "/work", () => undefined, signal(), "bash")).rejects.toThrow("retained");
    await expect(workspace.files(async () => true)).rejects.toThrow("retained");
    await expect(workspace.exportReview(f.exports)).rejects.toThrow("retained");
    await expect(workspace.close()).rejects.toThrow("retained");
    expect(fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-coding-snapshot-"))).toBe(true);
  } finally { failure.mockRestore(); }
}, 30_000);
