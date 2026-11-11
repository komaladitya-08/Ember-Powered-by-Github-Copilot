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
import { providerCheckLine, providerFailField, providerKeptLine, providerModelMissing, PROVIDER_STEP } from "../../app/renderer/home/first-run-copy";
import { gated, stepPosition } from "../../app/renderer/home/welcome-copy";
import { SettingsStore, withOwnProvider } from "../../app/main/settings";
import { AdminPolicySchema } from "../../app/main/admin";
import { noteProviderChoice, providerChoice } from "../../app/renderer/home/provider-choice";
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
const compile = (ctx: object) => new Function("ctx", `with(ctx) { ${ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })}; return ({checkProvider,go,turnOwnOff}); }`)(ctx) as { checkProvider(): Promise<void>; go(to: string): void; turnOwnOff(force?: boolean): Promise<void> };

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
const admin = { policy: AdminPolicySchema.parse({}), source: null };
const FAIL = { ok: false, status: 401, json: async () => ({}) };
// It lists the model the fields name: one it does not list fails the check (first-run-c7-1).
const OK = { ok: true, status: 200, json: async () => ({ data: [{ id: "model-a" }] }) };

async function harness(o: { slowKey?: boolean; failOff?: "false" | "throw" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-abandon-"));
  const settings = new SettingsStore(path.join(dir, "settings.json")); settings.load();
  const sealed = deferred<Buffer>();
  const box = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s: string) => (o.slowKey ? sealed.promise : Buffer.from(s)), decryptStringAsync: async (b: Buffer) => ({ result: b.toString() }) };
  const keys = new ProviderKeyStore(path.join(dir, "provider-key.bin"), box as never, { asyncKeyring: true });
  const http = deferred<typeof OK | typeof FAIL>();
  let tested = false;
  const requests: { url: string; headers: Record<string, string> }[] = [];
  // eslint-disable-next-line prefer-const -- the service's `changed` callback needs it before the host is built
  let host!: AgentHost;
  const service = createProviderService({ settings, admin: () => admin, keys, consented: () => true, log: quiet, changed: () => { if (host) void host.providerChanged(); }, fetch: async (url: string, init: { headers: Record<string, string> }) => { tested = true; requests.push({ url, headers: init.headers }); return http.promise; } } as never);
  const provider = () => activeProvider({ fixed: null, settings: settings.get(), admin, key: service.key() });
  host = new AgentHost({ userData: dir, runtimePath: "/not-used", settings, log: quiet, setState() {}, onStatus() {}, provider } as never);
  await host.start(null);
  settings.onChange(() => { service.settingsChanged(); void host.providerChanged(); });
  // Each agree call waits for its own gate (the test opens them); the other calls go straight to the service.
  const agreeGates: ReturnType<typeof deferred<void>>[] = [];
  let agrees = 0;
  const api = {
    saveKey: (k: string) => service.api.saveKey(k),
    agree: async (h: string, move?: never) => { const gate = agreeGates[agrees++]; if (gate) await gate.promise; return service.api.agree(h, move); },
    test: (draft?: never) => service.api.test(draft),
  };
  const nodes: Record<string, { hidden: boolean; textContent: string; focus(): void }> = {};
  let failOff = o.failOff;
  const fields = { type: "openai", baseUrl: "https://a.example/v1", conductor: "model-a", worker: "", key: "sk-test-only" };
  const ctx: Record<string, unknown> = {
    active: true, step: "provider", checkEpoch: 0, checkRun: 0, providerCheck: { phase: "checking", line: "Checking" }, navigation: 0, heardBefore: -1,
    // The visit set the provider up (it wasn't in use as the step opened): Back to Copilot puts it away (first-run-c1-2).
    visitInUse: false, checkSaves: true, edited: false, ownInForce: () => false, inUseHost: () => null, offPending: 0, see() {}, switchMade: false, switchedSaid: false,
    get settings() { return settings.get(); },
    latestOnly, endpointHost, providerChoice, showOffFailureText: "", providerCheckLine, providerFailField, providerModelMissing, providerKeptLine, PROVIDER_STEP, gated, stepPosition,
    root: { dataset: {} }, consented: () => true, render() {}, $: (id: string) => (nodes[id] ??= { hidden: true, textContent: "", focus() {} }), provField: () => ({ focus() {} }), next: { focus() {} },
    readProviderFields: () => ({ ...fields }), window: { emberProvider: api, scrollTo() {} },
    deps: {
      save: async (patch: never) => {
        if ((patch as { provider?: { on?: boolean } }).provider?.on === false && failOff) { if (failOff === "throw") throw new Error("boom"); return false; }
        settings.update(withOwnProvider(patch, settings.own().provider)); return true;
      },
    },
  };
  const f = compile(ctx);
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).provider.on as boolean;
  return { ctx, f, fields, nodes, service, requests, mend: () => { failOff = undefined; },
    /** What Home does when the switch is turned on: a deliberate choice, then the write. */
    homeTurnsOn: () => { noteProviderChoice(); settings.update(withOwnProvider({ provider: { on: true } } as never, settings.own().provider)); }, settings, host, sealed, http, agreeGates, agrees: () => agrees, tested: () => tested, disk, edit: () => { (ctx.checkEpoch as number)++; ctx.providerCheck = { phase: "idle", line: "" }; } };
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

  for (const how of ["false", "throw"] as const) {
    it(`an abandoned check whose switch-off cannot be saved (${how}) says the provider is still on, and a retry switches it off (PR #191 re-review)`, async () => {
      const h = await harness({ failOff: how });
      const gate = deferred<void>(); h.agreeGates.push(gate);
      const done = h.f.checkProvider();
      await vi.waitFor(() => expect(h.agrees()).toBe(1));
      h.f.go("sign-in");
      gate.resolve();
      await done;
      await vi.waitFor(() => expect(h.nodes["provider-off"]?.hidden).toBe(false));
      // Honest: still on, on disk and in the runtime's view, and the page says so with a way to retry.
      expect(h.disk()).toBe(true);
      expect(h.settings.get().provider.on).toBe(true);
      expect(h.nodes["provider-off-text"]!.textContent).toMatch(/still on/);
      expect(h.nodes["provider-off-retry"]!.textContent).not.toBe("");
      h.mend();
      await h.f.turnOwnOff(true);
      expect(h.nodes["provider-off"]!.hidden).toBe(true);
      await settle(h);
    });
  }

  it("a late compensation does not switch off the provider Home turned on deliberately since (PR #191 re-review)", async () => {
    const h = await harness();
    const gate = deferred<void>(); h.agreeGates.push(gate);
    const first = h.f.checkProvider();
    await vi.waitFor(() => expect(h.agrees()).toBe(1));
    h.f.go("sign-in");
    h.homeTurnsOn();
    gate.resolve();
    await first;
    // Home's choice survives on disk and in the runtime, and nothing was reported as failed.
    expect(h.settings.get().provider.on).toBe(true);
    expect(h.disk()).toBe(true);
    await vi.waitFor(() => expect(h.host.getStatus().service).toBeDefined());
    expect(h.nodes["provider-off"]?.hidden ?? true).toBe(true);
    await h.host.stop();
  });

  it("a late test result does not switch off the provider Home turned on since", async () => {
    const h = await harness();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.edit();
    h.homeTurnsOn();
    h.http.resolve(OK);
    await done;
    expect(h.settings.get().provider.on).toBe(true);
    expect(h.disk()).toBe(true);
    await h.host.stop();
  });
});

describe("first run's check of an edit to the provider in use (first-run-r2-1)", () => {
  const OLD = "sk-old-" + "o".repeat(30); // not a real key
  const NEW = "sk-new-" + "n".repeat(30); // not a real key
  /** In use as the step opens: a.example, agreed, its key saved and connected; the user has typed b.example and a new key. */
  async function inUse() {
    const h = await harness();
    h.settings.update(withOwnProvider({ provider: { type: "openai", baseUrl: "https://a.example/v1", conductor: "model-a" } } as never, h.settings.own().provider));
    expect(h.service.api.agree("a.example")).toEqual({ ok: true });
    expect(await h.service.api.saveKey(OLD)).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.host.getStatus().service?.host).toBe("a.example"));
    Object.assign(h.ctx, { visitInUse: true, checkSaves: false, ownInForce: () => true, inUseHost: () => "a.example", providerCheck: { phase: "checking", line: "Checking" } });
    Object.assign(h.fields, { baseUrl: "https://b.example/v1", key: NEW });
    return h;
  }
  /** The details that worked are still the ones in use: the file, the agreement, the key and the runtime. */
  const unchanged = async (h: H) => {
    const p = h.settings.get().provider;
    expect([p.on, p.baseUrl, p.consent.host]).toEqual([true, "https://a.example/v1", "a.example"]);
    expect(h.disk()).toBe(true);
    expect(h.service.key()?.key).toBe(OLD);
    await vi.waitFor(() => expect(h.host.getStatus().service?.host).toBe("a.example"));
    expect(h.agrees()).toBe(0);
    await h.host.stop();
  };

  it("asks the typed host with the typed key, and a failure leaves the details in use as they were and says so", async () => {
    const h = await inUse();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    expect(h.requests).toEqual([{ url: "https://b.example/v1/models", headers: { authorization: `Bearer ${NEW}` } }]);
    h.http.resolve(FAIL);
    await done;
    expect((h.ctx.providerCheck as { phase: string; line: string })).toEqual({ phase: "failed", line: "b.example didn't accept the API key. Check it, or replace it. Nothing has changed: I'm still using a.example.", kept: "a.example" });
    await unchanged(h);
  });

  it("an edit that answers but doesn't list the model named changes nothing, and says what the service lists (first-run-c7-1)", async () => {
    const h = await inUse();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.http.resolve({ ok: true, status: 200, json: async () => ({ data: [{ id: "x" }] }) });
    await done;
    expect((h.ctx.providerCheck as { phase: string; line: string })).toEqual({
      phase: "failed", kept: "a.example",
      line: "b.example answered, but it doesn't list model-a. It lists 1 model: x. Enter that name. Nothing has changed: I'm still using a.example.",
    });
    await unchanged(h);
  });

  it("a check that had to save first (the provider was switched off since the step opened) puts it away again when it fails (first-run-r3-1)", async () => {
    const h = await inUse();
    h.settings.update(withOwnProvider({ provider: { on: false } } as never, h.settings.own().provider));
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    // Saved, agreed and switched on before it asked: nothing was checked as typed.
    expect(h.agrees()).toBe(1);
    expect(h.settings.get().provider.on).toBe(true);
    h.http.resolve(FAIL);
    await done;
    expect((h.ctx.providerCheck as { phase: string; line: string })).toEqual({ phase: "failed", line: "b.example didn't accept the API key. Check it, or replace it." });
    await settle(h);
  });

  it("Back while the edit is checked leaves the details in use, even when the check then answers", async () => {
    const h = await inUse();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.f.go("sign-in");
    h.http.resolve(OK);
    await done;
    await unchanged(h);
  });

  it("an edit that answers is written with its yes in one change, so Copilot is never in force between, and its key saved after (first-run-r4-3)", async () => {
    const h = await inUse();
    const kinds: (string | null)[] = [];
    h.settings.onChange(() => kinds.push(activeProvider({ fixed: null, settings: h.settings.get(), admin, key: h.service.key() })?.kind ?? null));
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.http.resolve(OK);
    await done;
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain(null);
    expect(h.agrees()).toBe(1);
    expect(h.service.key()).toMatchObject({ key: NEW, host: "b.example" });
    await vi.waitFor(() => expect(h.host.getStatus().service?.host).toBe("b.example"));
    await h.host.stop();
  });

  it("an edit that answers replaces the details, the key and the agreement, and stays on", async () => {
    const h = await inUse();
    const done = h.f.checkProvider();
    await vi.waitFor(() => expect(h.tested()).toBe(true));
    h.http.resolve(OK);
    await done;
    const p = h.settings.get().provider;
    expect([p.on, p.baseUrl, p.consent.host]).toEqual([true, "https://b.example/v1", "b.example"]);
    expect(h.service.key()).toMatchObject({ key: NEW, host: "b.example" });
    await vi.waitFor(() => expect(h.host.getStatus().service?.host).toBe("b.example"));
    await h.host.stop();
  });
});
