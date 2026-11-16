import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { build, buildSync, type Plugin } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { memoryRefusal } from "../../app/main/memory/guard";
import { CODING_PRIVACY_MAX_TEXT_BYTES } from "../../app/main/agent/coding-privacy-protocol";
import type { CodingPrivacyScanner } from "../../app/main/agent/coding-privacy-scanner";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const clients: CodingPrivacyScanner[] = [];
const apis = new WeakMap<CodingPrivacyScanner, typeof import("../../app/main/agent/coding-privacy-scanner")>();
let temporary: string, fixedSource: string, count = 0;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const program = (body: string, start = "") => `const {parentPort:p}=require('node:worker_threads');${start}p.postMessage({type:'ready',version:1});p.on('message',m=>{${body}});`;
beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ember-privacy-scanner-test-"));
  fixedSource = buildSync({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-privacy-worker.ts"], bundle: true,
    platform: "node", target: "node22", format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
});
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined))); });
afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function scanner(source = fixedSource, signal?: AbortSignal, workerShim?: string): Promise<CodingPrivacyScanner> {
  const file = path.join(temporary, `client-${++count}.cjs`);
  const plugins: Plugin[] = workerShim ? [{ name: "test-worker-exit-failure", setup(plugin) {
    plugin.onResolve({ filter: /^node:worker_threads$/ }, () => ({ path: "worker-shim", namespace: "test-worker-shim" }));
    plugin.onLoad({ filter: /.*/, namespace: "test-worker-shim" }, () => ({ contents: workerShim, loader: "js" }));
  } }] : [];
  const bundled = (await build({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-privacy-scanner.ts"], bundle: true,
    platform: "node", target: "node22", format: "cjs", write: false, logLevel: "silent", plugins,
    define: { __EMBER_CODING_PRIVACY_WORKER_SOURCE__: JSON.stringify(source) } })).outputFiles[0].text;
  await fs.writeFile(file, bundled, { mode: 0o600 });
  const api = require(file) as typeof import("../../app/main/agent/coding-privacy-scanner");
  const client = new api.CodingPrivacyScanner({ signal }); apis.set(client, api); clients.push(client); return client;
}

describe("fixed off-thread full-content coding privacy checks", () => {
  it("bundles only the exact guard, its redactor, protocol and worker port", () => {
    const built = buildSync({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-privacy-worker.ts"], bundle: true,
      platform: "node", target: "node22", format: "cjs", write: false, logLevel: "silent", metafile: true });
    expect(Object.keys(built.metafile!.inputs).sort()).toEqual([
      "app/main/agent/coding-privacy-protocol.ts", "app/main/agent/coding-privacy-worker.ts",
      "app/main/commands/redact.ts", "app/main/memory/guard.ts",
    ]);
    const imports = Object.values(built.metafile!.outputs).flatMap(output => output.imports.map(item => item.path));
    expect(imports).toEqual(["node:worker_threads"]);
  });

  it("returns the exact existing memoryRefusal result for complete text, rather than redacted or reflected text", async () => {
    const client = await scanner();
    const token = `ghp_${"a1B2".repeat(9)}`;
    const texts = ["", "export const greeting = 'hello';\n", "PASSWORD=placeholder", "password=hunter2", token,
      "-----BEGIN RSA PRIVATE KEY-----\nprivate\n", "my login is jsmith42", "my PIN is 4821", "4111 1111 1111 1111",
      "123-45-6789", "My mother's maiden name is Lark.", "const token: string = process.env.TOKEN;",
      "Passwords are hashed.", "Password: never Summer2024!", "\ufeffpassword=hunter2", "line one\npassword\nline three",
      'test: ["CMD", "mysqladmin", "ping", "-phunter2"]', '"--no-password", "ordinary"',
      '{"value":"Zq8vP2mXw4","id":"https://v.vault.azure.net/secrets/a/4387e"}',
      "No password is printed here.\nNothing to hide."];
    for (const text of texts) expect(await client.refusal(text), text).toBe(memoryRefusal(text));
  });

  it("scans a late secret and a token crossing a possible chunk boundary as complete text", async () => {
    const client = await scanner(), prefix = "ordinary source line\n".repeat(13_100);
    const token = `ghp_${"a1B2".repeat(9)}`;
    for (const text of [prefix + "password=hunter2", "a".repeat(256 * 1024 - 12) + " " + token + "\n",
      prefix + "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n"]) {
      expect(await client.refusal(text)).toBe(memoryRefusal(text));
      expect(await client.refusal(text)).not.toBeNull();
    }
  });

  it("accepts source as data without running text that looks like JavaScript or a process command", async () => {
    const client = await scanner(), destination = path.join(temporary, "never-written");
    const text = `require('node:fs').writeFileSync(${JSON.stringify(destination)},'data'); process.exit(7); throw new Error('sample');`;
    expect(await client.refusal(text)).toBe(memoryRefusal(text));
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.refusal("ordinary next file")).toBeNull();
  });

  it("rejects an already-aborted job and stale authority before starting any worker", async () => {
    const client = await scanner("this is deliberately not a worker program"), aborted = new AbortController(); aborted.abort();
    await expect(client.refusal("text", { signal: aborted.signal })).rejects.toMatchObject({ code: "cancelled" });
    await expect(client.refusal("text", { current: () => false })).rejects.toMatchObject({ code: "stale" });
    await expect(client.refusal("text", { current: () => { throw new Error("do not expose this"); } })).rejects.toMatchObject({ code: "stale" });
  });

  it("checks authority again after worker delivery before returning an allowed result", async () => {
    const client = await scanner(program("p.postMessage({type:'result',id:m.id,reason:null});"));
    vi.useFakeTimers();
    try {
      let checks = 0;
      await expect(client.refusal("ordinary text", { current: () => ++checks < 5 })).rejects.toMatchObject({ code: "stale" });
      expect(checks).toBe(5);
      await client.close();
    } finally { vi.useRealTimers(); }
  });

  it("does not deliver source when an authority callback synchronously revokes the handle", async () => {
    const client = await scanner("this program must never start");
    await expect(client.refusal("private source", { current: () => { void client.close(); return true; } })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("preserves neighboring queued jobs when authority revokes only at pump admission", async () => {
    const blocker = await scanner(program("setTimeout(()=>p.postMessage({type:'result',id:m.id,reason:null}),10);"));
    const api = apis.get(blocker)!, revoked = new api.CodingPrivacyScanner(), surviving = new api.CodingPrivacyScanner();
    clients.push(revoked, surviving);
    vi.useFakeTimers();
    try {
      const running = blocker.refusal("blocker");
      let checks = 0;
      const cancelled = revoked.refusal("revoked owner A", { current: () => {
        if (++checks === 3) void revoked.close(); return true;
      } }).catch(error => error);
      const first = surviving.refusal("surviving owner B"), second = surviving.refusal("next surviving job");
      expect(await running).toBeNull();
      expect(await cancelled).toMatchObject({ code: "cancelled" }); expect(checks).toBe(3);
      expect(await first).toBeNull(); expect(await second).toBeNull();
      await blocker.close(); await surviving.close();
    } finally { vi.useRealTimers(); }
  });

  it("closes a lifetime synchronously, aborts queued work and waits for active worker termination", async () => {
    const lifetime = new AbortController(), client = await scanner(program("for(;;){}"), lifetime.signal);
    const active = client.refusal("ordinary text").catch(error => error), queued = client.refusal("next text").catch(error => error);
    lifetime.abort();
    await expect(client.refusal("later text")).rejects.toMatchObject({ code: "cancelled" });
    await client.close(); expect(await active).toMatchObject({ code: "cancelled" }); expect(await queued).toMatchObject({ code: "cancelled" });
  });

  it("cancels a single queued request without authorizing its text or retiring another request", async () => {
    const client = await scanner(program("setTimeout(()=>p.postMessage({type:'result',id:m.id,reason:null}),30);")), aborted = new AbortController();
    const active = client.refusal("first"), queued = client.refusal("second", { signal: aborted.signal });
    aborted.abort(); await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    expect(await active).toBeNull(); expect(await client.refusal("third")).toBeNull();
  });

  it("revokes active project authority without closing another scanner handle", async () => {
    const client = await scanner(program("if(m.text==='project A private text'){for(;;){}}else{p.postMessage({type:'result',id:m.id,reason:null});}"));
    const Client = client.constructor as new () => CodingPrivacyScanner, other = new Client(); clients.push(other);
    let current = true, checks = 0, sent!: () => void;
    const posted = new Promise<void>(resolve => { sent = resolve; });
    vi.useFakeTimers();
    try {
      const pending = client.refusal("project A private text", { current: () => { if (++checks === 4) sent(); return current; } }).catch(error => error);
      await posted; current = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ code: "stale" });
      expect(await other.refusal("project B source")).toBeNull();
      await client.close(); await other.close();
    } finally { vi.useRealTimers(); }
  });

  it("bounds pending job count and per-file bytes without silent truncation", async () => {
    const client = await scanner(program("for(;;){}"));
    await expect(client.refusal("x".repeat(CODING_PRIVACY_MAX_TEXT_BYTES + 1))).rejects.toMatchObject({ code: "limit" });
    const accepted = Array.from({ length: 9 }, () => client.refusal("ordinary queued text").catch(error => error));
    await expect(client.refusal("one too many")).rejects.toMatchObject({ code: "limit" });
    await client.close(); for (const result of await Promise.all(accepted)) expect(result).toMatchObject({ code: "cancelled" });
  });

  it("bounds cumulative pending text independently of the request count", async () => {
    const client = await scanner(program("for(;;){}")), text = "x".repeat(CODING_PRIVACY_MAX_TEXT_BYTES);
    const accepted = Array.from({ length: 3 }, () => client.refusal(text).catch(error => error));
    await expect(client.refusal("x")).rejects.toMatchObject({ code: "limit" });
    await client.close(); for (const result of await Promise.all(accepted)) expect(result).toMatchObject({ code: "cancelled" });
  });

  it.each([
    ["bad ready", "require('node:worker_threads').parentPort.postMessage({type:'ready',version:2});"],
    ["wrong id", program("p.postMessage({type:'result',id:m.id+1,reason:null});")],
    ["unknown reason", program("p.postMessage({type:'result',id:m.id,reason:'password=do-not-reflect'});")],
    ["unexpected stdout", program("process.stdout.write('password=do-not-reflect');for(;;){}")],
    ["unexpected stderr", program("process.stderr.write('password=do-not-reflect');for(;;){}")],
    ["uncaught error", program("throw new Error('password=do-not-reflect');")],
    ["unexpected exit", program("process.exit(2);")],
    ["broken source", "this is deliberately not JavaScript"],
  ])("fails closed on %s without returning raw worker data", async (_name, source) => {
    const client = await scanner(source);
    const result = await client.refusal("original private source").catch(error => error);
    expect(result).toMatchObject({ code: "failed" });
    expect(String(result)).not.toContain("do-not-reflect"); expect(String(result)).not.toContain("original private source");
    await client.close();
  });

  it("preserves an unverified thread-exit error and permanently fences the affected queue", async () => {
    const client = await scanner(fixedSource, undefined, `const {EventEmitter}=require('node:events');
      exports.Worker=class extends EventEmitter { stdout=null;stderr=null;postMessage(){}
        terminate(){return Promise.reject(new Error('private source must not escape'));} };`);
    const pending = client.refusal("private project text").catch(error => error);
    await expect(client.close()).rejects.toMatchObject({ name: "CodingPrivacyCleanupError", code: "failed" });
    expect(await pending).toMatchObject({ name: "CodingPrivacyCleanupError", code: "failed" });
    const Client = client.constructor as new () => CodingPrivacyScanner;
    expect(() => new Client()).toThrow("could not be verified as stopped");
    expect(apis.get(client)!.codingPrivacyCleanupFailure()).toMatchObject({ name: "CodingPrivacyCleanupError", code: "failed" });
  });

  it("keeps a post-Stop export scope valid but permanently refuses old or forged scopes after global Forget", async () => {
    const initial = await scanner(), api = apis.get(initial)!, scope = api.captureCodingPrivacyScope(), lifetime = new AbortController();
    const ordinary = new api.CodingPrivacyScanner({ scope, signal: lifetime.signal }); clients.push(ordinary);
    expect(await ordinary.refusal("ordinary source")).toBeNull(); lifetime.abort(); await ordinary.close();
    const partial = new api.CodingPrivacyScanner({ scope }); clients.push(partial);
    expect(await partial.refusal("inert partial result")).toBeNull();
    expect(() => Reflect.construct(api.CodingPrivacyScanner, [{ scope: JSON.parse(JSON.stringify(scope)) }])).toThrow("no longer belongs");
    await api.retireCodingPrivacyScanners();
    await expect(partial.refusal("after Forget")).rejects.toMatchObject({ code: "cancelled" });
    expect(() => new api.CodingPrivacyScanner({ scope })).toThrow("no longer belongs");
    expect(() => api.assertCodingPrivacyScope(scope)).toThrow("no longer belongs");
    const next = api.captureCodingPrivacyScope(), restored = new api.CodingPrivacyScanner({ scope: next }); clients.push(restored);
    expect(await restored.refusal("new request after account restore")).toBeNull();
    await api.retireCodingPrivacyScanners();
    expect(() => new api.CodingPrivacyScanner({ scope: next })).toThrow("no longer belongs");
    expect(() => new api.CodingPrivacyScanner({ scope })).toThrow("no longer belongs");
  });

  it("destroys the old worker heap on handle handoff and does not revoke another handle", async () => {
    const first = await scanner(program("p.postMessage({type:'result',id:m.id,reason:++n===1?null:'it holds a private key'});", "let n=0;"));
    const Client = first.constructor as new (options?: { signal?: AbortSignal }) => CodingPrivacyScanner;
    const second = new Client(); clients.push(second);
    expect(await first.refusal("first private source")).toBeNull();
    expect(await second.refusal("second private source")).toBeNull();
    await first.close();
    expect(await second.refusal("same second heap")).toBe("it holds a private key");
  });

  it("times out admitted work and clears queued source without a worker response", async () => {
    const client = await scanner(program("for(;;){}"));
    vi.useFakeTimers();
    try {
      const result = client.refusal("private source").catch(error => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ code: "timeout" });
      await client.close();
    } finally { vi.useRealTimers(); }
  });

  it("expires the idle worker heap instead of retaining a scanned source indefinitely", async () => {
    const client = await scanner(program("p.postMessage({type:'result',id:m.id,reason:++n===1?null:'it holds a private key'});", "let n=0;"));
    expect(await client.refusal("first")).toBeNull();
    expect(await client.refusal("second")).toBe("it holds a private key");
    await pause(180);
    expect(await client.refusal("fresh heap")).toBeNull();
  });

  it("keeps the main event loop available and cancels actual complete-file regex work", async () => {
    const client = await scanner(), aborted = new AbortController();
    // The adverse sk- corpus is existing guard semantics. It is never evaluated as worker source.
    const text = "sk-".repeat(Math.floor(CODING_PRIVACY_MAX_TEXT_BYTES / 3));
    // Admit the adverse text to an already-ready worker, so cancellation cannot pass by only stopping startup.
    expect(await client.refusal("ordinary warm-up source")).toBeNull();
    const started = performance.now(), pending = client.refusal(text, { signal: aborted.signal }).catch(error => error);
    let tick = Infinity;
    await new Promise<void>(resolve => setTimeout(() => { tick = performance.now() - started; aborted.abort(); resolve(); }, 100));
    expect(tick).toBeLessThan(300);
    expect(await pending).toMatchObject({ code: "cancelled" });
    await client.close();
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
