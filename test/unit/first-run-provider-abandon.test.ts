/**
 * First run's own-provider check, abandoned part-way (PR #191 review): Back, an edit or turning to Copilot while the
 * key is being saved, the card's yes recorded or the service tested must never leave (or re-enable) the abandoned
 * provider. Real settings persistence, the real provider service and AgentHost run behind welcome.ts's own
 * `checkProvider` and `go` (cut out of the source and run with stubbed DOM sinks); only the SDK transport, the keyring
 * and the HTTP answer are fakes, each a deferred promise the test settles in the order it wants.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { latestOnly, endpointHost } from "../../app/shared/provider";
import { providerCheckLine, PROVIDER_STEP } from "../../app/renderer/home/first-run-copy";
import { gated, stepPosition } from "../../app/renderer/home/welcome-copy";
import { SettingsStore, withOwnProvider } from "../../app/main/settings";
import { AdminPolicySchema } from "../../app/main/admin";
import { ProviderKeyStore, createProviderService, activeProvider } from "../../app/main/provider";

vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  class FakeClient {
    async start() {} async stop() { return []; } async forceStop() {}
    async getAuthStatus() { return { isAuthenticated: true, login: "octo" }; }
    async listModels() { return [{ id: "m", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return []; } async deleteSession() {} async ping() { return {}; }
    async createSession(cfg: { sessionId?: string }) { return { sessionId: cfg.sessionId ?? "s", on: () => () => {}, rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: [] }) } }, disconnect: async () => {} }; }
    async resumeSession() { throw new Error("Session not found"); }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});
import { AgentHost } from "../../app/main/agent/host";

const src = fs.readFileSync("app/renderer/home/welcome.ts", "utf8");
const fragment = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = fragment("  const checkProvider = latestOnly", "  function startCheck()") + fragment("  function go(to:", "  // ───── Drawing the step");
const compile = (ctx: object) => new Function("ctx", `with(ctx) { ${ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })}; return ({checkProvider,go}); }`)(ctx) as { checkProvider(): Promise<void>; go(to: string): void };

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
const admin = { policy: AdminPolicySchema.parse({}), source: null };
const FAIL = { ok: false, status: 401, json: async () => ({}) };
const OK = { ok: true, status: 200, json: async () => ({ data: [{ id: "x" }] }) };

async function harness(o: { slowKey?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-abandon-"));
  const settings = new SettingsStore(path.join(dir, "settings.json")); settings.load();
  const sealed = deferred<Buffer>();
  const box = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s: string) => (o.slowKey ? sealed.promise : Buffer.from(s)), decryptStringAsync: async (b: Buffer) => ({ result: b.toString() }) };
  const keys = new ProviderKeyStore(path.join(dir, "provider-key.bin"), box as never, { asyncKeyring: true });
  const http = deferred<typeof OK | typeof FAIL>();
  let tested = false;
  // eslint-disable-next-line prefer-const -- the service's `changed` callback needs it before the host is built
  let host!: AgentHost;
  const service = createProviderService({ settings, admin: () => admin, keys, consented: () => true, log: quiet, changed: () => { if (host) void host.providerChanged(); }, fetch: async () => { tested = true; return http.promise; } } as never);
  const provider = () => activeProvider({ fixed: null, settings: settings.get(), admin, key: service.key() });
  host = new AgentHost({ userData: dir, runtimePath: "/not-used", settings, log: quiet, setState() {}, onStatus() {}, provider } as never);
  await host.start(null);
  settings.onChange(() => { service.settingsChanged(); void host.providerChanged(); });
  // Each agree call waits for its own gate (the test opens them); the other calls go straight to the service.
  const agreeGates: ReturnType<typeof deferred<void>>[] = [];
  let agrees = 0;
  const api = {
    saveKey: (k: string) => service.api.saveKey(k),
    agree: async (h: string) => { const gate = agreeGates[agrees++]; if (gate) await gate.promise; return service.api.agree(h); },
    test: () => service.api.test(),
  };
  const fields = { type: "openai", baseUrl: "https://a.example/v1", conductor: "model-a", worker: "", key: "sk-test-only" };
  const ctx: Record<string, unknown> = {
    active: true, step: "provider", checkEpoch: 0, checkRun: 0, providerCheck: { phase: "checking", line: "Checking" }, navigation: 0, heardBefore: -1,
    get settings() { return settings.get(); },
    latestOnly, endpointHost, providerCheckLine, PROVIDER_STEP, gated, stepPosition,
    root: { dataset: {} }, consented: () => true, render() {}, $: () => ({ focus() {} }), provField: () => ({ focus() {} }), next: { focus() {} },
    readProviderFields: () => ({ ...fields }), window: { emberProvider: api, scrollTo() {} },
    deps: { save: async (patch: never) => { settings.update(withOwnProvider(patch, settings.own().provider)); return true; } },
  };
  const f = compile(ctx);
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).provider.on as boolean;
  return { ctx, f, fields, settings, host, sealed, http, agreeGates, agrees: () => agrees, tested: () => tested, disk, edit: () => { (ctx.checkEpoch as number)++; ctx.providerCheck = { phase: "idle", line: "" }; } };
}
type H = Awaited<ReturnType<typeof harness>>;
/** Nothing points at the abandoned host: the file says off and the runtime is not connected to it. */
const settle = async (h: H) => {
  await vi.waitFor(() => expect(h.host.getStatus().service).toBeUndefined());
  expect(h.disk()).toBe(false);
  expect(h.settings.get().provider.on).toBe(false);
  await h.host.stop();
};

describe("first run's own-provider check, abandoned part-way", () => {
  it("Back while the key is being saved never records the card's yes or tests (PR #191 P2)", async () => {
    const h = await harness({ slowKey: true });
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.agrees()).toBe(0));
    h.f.go("sign-in");
    h.sealed.resolve(Buffer.from("sealed"));
    await done;
    expect(h.agrees()).toBe(0);
    expect(h.tested()).toBe(false);
    await settle(h);
  });

  it("Back while the card's yes is being recorded turns the provider off again (PR #191 P2)", async () => {
    const h = await harness();
    const gate = deferred<void>(); h.agreeGates.push(gate);
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.agrees()).toBe(1));
    h.f.go("sign-in");
    gate.resolve();
    await done;
    await settle(h);
  });

  it("an edit while the service is being tested leaves the provider off when the test fails (PR #191 P2)", async () => {
    const h = await harness();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.edit();
    h.http.resolve(FAIL);
    await done;
    await settle(h);
  });

  it("an edit while the service is being tested leaves the provider off even when the old test passes", async () => {
    const h = await harness();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.edit();
    h.http.resolve(OK);
    await done;
    await settle(h);
  });

  it("an older abandoned check does not turn off the newer check that replaced it", async () => {
    const h = await harness();
    const gate = deferred<void>(); h.agreeGates.push(gate);
    const first = h.f.checkProvider();
    await vi.waitFor(() => expect(h.agrees()).toBe(1));
    h.edit();
    h.http.resolve(OK);
    await h.f.checkProvider();
    expect(h.settings.get().provider.on).toBe(true);
    gate.resolve();
    await first;
    expect(h.settings.get().provider.on).toBe(true);
    expect(h.disk()).toBe(true);
    await h.host.stop();
  });
});
