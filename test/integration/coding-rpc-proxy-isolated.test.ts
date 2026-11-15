/** Actual SDK → bounded host proxy → no-network Bubblewrap → host model broker. Synthetic credentials only. */
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { CodingModelBroker } from "../../app/main/agent/coding-model-broker";
import { CodingModelRequestHandler } from "../../app/main/agent/coding-model-request-handler";
import { ExperimentalIsolatedRuntime } from "../../app/main/agent/experimental-isolated-runtime";
import { DEFAULT_CODING_RPC_FRAMING_LIMITS } from "../../app/main/agent/coding-rpc-framing";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
// @ts-expect-error -- plain JavaScript offline fixture
import { startMockLlm } from "../mock-llm/server.mjs";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-bounded-proxy-"));
  fs.chmodSync(root, 0o700);
  const source = path.join(root, "project"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), exportBase = path.join(root, "exports");
  for (const dir of [source, baseDir, privateDir, exportBase]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "project.txt"), "original\n");
  const helperPath = path.join(root, "coding-rpc-proxy.cjs");
  await build({ entryPoints: [path.resolve("app/main/agent/coding-rpc-proxy.ts")], outfile: helperPath, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  fs.chmodSync(helperPath, 0o600);
  const credential = `synthetic_host_only_${crypto.randomUUID()}`;
  const mock = await startMockLlm({ delayMs: 0 });
  const limits = { requests: 20, concurrent: 1, requestBytes: 1024 * 1024, responseBytes: 4 * 1024 * 1024,
    totalBytes: 16 * 1024 * 1024, requestMs: 15_000, lifetimeMs: 90_000 };
  const broker = new CodingModelBroker({ baseUrl: mock.baseUrl, model: "mock-model", apiKey: credential, limits, signal: new AbortController().signal });
  const sessionId = `ember-bounded-proxy-${crypto.randomUUID()}`;
  const handler = new CodingModelRequestHandler({ sessionId, broker, maxBodyBytes: limits.requestBytes });
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  return { root, source, baseDir, privateDir, exportBase, credential, mock, handler,
    input: { source, baseDir, protectedPaths: [privateDir], runtimePath, requestHandler: handler,
      sessionForTest: { sessionId, model: "mock-model" }, privateProcForTest: true,
      proxyForTest: { nodePath: fs.realpathSync(process.execPath), helperPath } },
  };
}

const available = () => {
  const probe = spawnSync("/usr/bin/bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  return !probe.error && probe.status === 0;
};
const receiptOf = (base: string) => JSON.parse(fs.readFileSync(path.join(base,
  fs.readdirSync(base).find(name => name.startsWith("ember-isolation-state-"))!, "namespace-receipt.json"), "utf8"));

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("edits and exports through the real framed proxy, host broker and no-network namespace", async ctx => {
  if (!available()) { ctx.skip(); return; }
  const f = await fixture();
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    instance = await ExperimentalIsolatedRuntime.start(f.input);
    const copy = instance.copyPath;
    const receipt = receiptOf(f.baseDir);
    expect(fs.readlinkSync(`/proc/${receipt["child-pid"]}/ns/net`)).not.toBe(fs.readlinkSync("/proc/self/ns/net"));
    const command = "printf 'proposed\\n' > /work/project.txt; " +
      "cat /proc/1/environ > /work/runtime.env; cat /proc/self/environ > /work/child.env; " +
      "if (: <&3) 2>/dev/null || (: >&3) 2>/dev/null || (: <&4) 2>/dev/null || (: >&4) 2>/dev/null; then printf inherited > /work/host-fds; else printf closed > /work/host-fds; fi";
    await instance.request(`CALLTOOL:bash${JSON.stringify({ command })}`);
    expect(fs.readFileSync(path.join(copy, "project.txt"), "utf8")).toBe("proposed\n");
    expect(fs.readFileSync(path.join(copy, "host-fds"), "utf8")).toBe("closed");
    for (const name of ["runtime.env", "child.env"]) expect(fs.readFileSync(path.join(copy, name)).includes(f.credential)).toBe(false);
    expect(f.mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(f.mock.requests.every((r: { authorization: string | null }) => r.authorization === `Bearer ${f.credential}`)).toBe(true);
    f.handler.retire();
    const exported = await instance.exportReview(f.exportBase);
    expect(exported.cleanup).toBe("complete");
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(f.source, "project.txt"), "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(exported.directory, "review.json"), "utf8")).not.toContain(f.credential);
    const proposal = exported.review.proposed.find(e => e.path === "project.txt");
    expect(proposal?.kind === "file" && Buffer.from(proposal.base64, "base64").toString()).toBe("proposed\n");
    await instance.close();
  } finally { f.handler.retire(); await instance?.close(); await f.mock.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("withholds an oversized declared runtime frame and kills its actual namespace before SDK decoding", async ctx => {
  if (!available()) { ctx.skip(); return; }
  const f = await fixture();
  let instance: ExperimentalIsolatedRuntime | undefined, verifiedExit = false;
  try {
    // A host-created hostile-runtime fixture exercises the outgoing pipe without assuming a native child can open
    // another process's /proc fd. It runs inside the real namespace and only emits a header, never its declared body.
    const runtimeDir = path.join(f.root, "hostile-runtime"); fs.mkdirSync(runtimeDir, { mode: 0o700 });
    const runtimePath = path.join(runtimeDir, "copilot-runtime");
    const advertised = DEFAULT_CODING_RPC_FRAMING_LIMITS.bodyBytes + 1;
    fs.writeFileSync(runtimePath, `#!/usr/bin/bash\nprintf 'Content-Length: ${advertised}\\r\\n\\r\\n'\nsleep 10\nprintf survived > /work/after-frame\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(runtimeDir, "runtime.node"), "not loaded by the fixture", { mode: 0o600 });
    const started = performance.now();
    await expect(ExperimentalIsolatedRuntime.start({ ...f.input, runtimePath }).then(value => { instance = value; return value; })).rejects.toThrow();
    // An unguarded Content-Length reader would wait for the absent body. The proxy must close the pipe and namespace.
    expect(performance.now() - started).toBeLessThan(8000);
    const receipt = receiptOf(f.baseDir);
    await expect.poll(() => {
      try { return fs.readlinkSync(`/proc/${receipt["child-pid"]}/ns/mnt`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "exited"; throw error; }
    }).toBe("exited");
    verifiedExit = true;
    const copy = path.join(f.baseDir, fs.readdirSync(f.baseDir).find(name => name.startsWith("ember-coding-snapshot-"))!);
    // Startup did not establish an accepted receipt, so production cleanup conservatively retained the copy.
    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.existsSync(path.join(copy, "after-frame"))).toBe(false);
    expect(f.mock.requests).toHaveLength(0);
    expect(fs.readFileSync(path.join(f.source, "project.txt"), "utf8")).toBe("original\n");
  } finally {
    f.handler.retire();
    try { await instance?.close(); } catch { /* A broken SDK transport can report unconfirmed cleanup even after this test observed init exit. */ }
    await f.mock.close();
    if (verifiedExit) fs.rmSync(f.root, { recursive: true, force: true });
  }
}, 60_000);
