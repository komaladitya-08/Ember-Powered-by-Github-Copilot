/** Saved extension cards never substitute for the current global agreement, including late probe replies. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPolicySchema } from "../../app/main/admin";
import { ExtensionsService, type ExtensionsDeps } from "../../app/main/extensions/service";
import { ExtensionStore } from "../../app/main/extensions/store";
import { pinAll } from "../../app/main/extensions/pin";
import { probeHttp, probeStdio, type ProbeResult } from "../../app/main/extensions/probe";
import { DEFAULT_SETTINGS, SettingsSchema, SettingsStore } from "../../app/main/settings";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import type { ServerSpec } from "../../app/main/extensions/manifest";
import type { Logger } from "../../app/main/logger";
import { hardenedSessionConfig } from "../../app/main/agent/session-config";

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error("No process may start in this test."); }) }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: processBoundary.spawn }));

const AT = "2026-11-09T00:00:00Z";
const TOOL = { name: "lookup", description: "Looks something up.", inputSchema: {}, annotations: { readOnlyHint: true } };
const HTTP: ServerSpec = { type: "http", url: "https://fixture.example/mcp", headers: { authorization: "Bearer fixture-only" } };
const STDIO: ServerSpec = { type: "stdio", command: "fixture-only", args: [], env: {} };
const quiet: Logger = { file: "fixture.log", info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(current = false, specs = [HTTP], overrides: Partial<ExtensionsDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-ext-consent-"));
  dirs.push(dir);
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify(SettingsSchema.parse({ ...DEFAULT_SETTINGS, onboarded: true,
    consent: { version: current ? CONSENT_VERSION : CONSENT_VERSION - 1, at: AT },
    extensions: { on: true, consent: { version: FEATURE_CONSENT_VERSION.extensions, at: AT } },
  })));
  const settings = new SettingsStore(settingsFile);
  settings.load();
  const store = new ExtensionStore(path.join(dir, "extensions"));
  store.write([{ id: "fixture", name: "Fixture", kind: "plugin", marketplace: "fixture", source: "fixture@fixture", enabled: true, consentedAt: AT,
    servers: specs.map((spec, i) => ({ key: `fixture${i}`, name: `Fixture ${i}`, spec, status: "ready", tools: pinAll([TOOL]) })),
  }]);
  const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: true, tools: [TOOL] }));
  const service = new ExtensionsService({ dir: store.dir, copilotHome: path.join(dir, "copilot"), settings,
    admin: () => AdminPolicySchema.parse({}), client: () => null, confirmer: () => null, audit: () => null, log: quiet,
    os: "linux", launcher: { execPath: "fixture-only", script: "fixture-only" }, probe, ...overrides });
  const consent = (on: boolean) => settings.update({ onboarded: false, consent: { version: on ? CONSENT_VERSION : CONSENT_VERSION - 1, at: AT } });
  return { settings, store, probe, service, consent };
}

describe("extensions require the current global agreement", () => {
  it.each([HTTP, STDIO])("does not probe saved $type servers before global agreement (integrations-refresh-c1, extensions-refresh-consent-1)", async spec => {
    const f = fixture(false, [spec]);
    expect(f.settings.get().onboarded).toBe(false);
    await f.service.refresh();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.service.active()).toBe(false);
    expect(f.service.forSession()).toBeUndefined();
    f.consent(true);
    await f.service.refresh();
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.service.forSession()?.tools).toHaveLength(1);
  });

  it("keeps cached tools and direct enable/install/reagreement off before global agreement (extensions-refresh-consent-1)", async () => {
    const f = fixture();
    expect(f.service.forSession()).toBeUndefined();
    expect((await f.service.install("fixture", "new-plugin")).ok).toBe(false);
    await f.service.setEnabled("fixture", false);
    await f.service.setEnabled("fixture", true);
    const [item] = await f.service.list();
    await f.service.reagree(item.id, item.reviewToken!);
    expect(f.probe).not.toHaveBeenCalled();
    expect((await f.service.list())[0].enabled).toBe(false);
  });

  it("revokes bound tools and ignores a probe that completes after agreement is revoked (extensions-refresh-consent-1)", async () => {
    let finish!: (result: ProbeResult) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const probe = vi.fn(() => new Promise<ProbeResult>(resolve => { finish = resolve; began(); }));
    const f = fixture(true, [HTTP, STDIO], { probe });
    const session = f.service.forSession()!;
    const stopped = vi.fn(async () => undefined);
    session.bind?.(async () => [], stopped);
    const before = f.store.read();
    const pending = f.service.refresh();
    await started;
    f.consent(false);
    expect(f.service.forSession()).toBeUndefined();
    expect(stopped).toHaveBeenCalled();
    finish({ ok: true, tools: [{ ...TOOL, name: "later" }] });
    await pending;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(f.store.read()).toEqual(before);
  });

  it("does not dispatch marketplace RPCs before global agreement, while retaining Browse before its feature card (extensions-refresh-consent-1)", async () => {
    const list = vi.fn(async () => ({ marketplaces: [] }));
    const add = vi.fn(async () => ({ name: "fixture" }));
    const browse = vi.fn(async () => ({}));
    const plugins = vi.fn(async () => ({ plugins: [] }));
    const f = fixture(false, [HTTP], { client: () => ({ rpc: { plugins: { marketplaces: { list, add, browse }, list: plugins } } }) as never });
    await f.service.marketplaces();
    await f.service.browse("fixture");
    await f.service.addMarketplace("fixture/plugins");
    expect(list).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();
    expect(plugins).not.toHaveBeenCalled();
    f.consent(true);
    f.settings.update({ extensions: { on: false, consent: { version: 0, at: "" } } });
    await f.service.marketplaces();
    expect(list).toHaveBeenCalledTimes(1);
    await f.service.browse("fixture");
    expect(browse).toHaveBeenCalledTimes(1);
  });

  it("removes the runtime's downloaded copy when global agreement is revoked during installation (extensions-consent-review-1)", async () => {
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let root = "", copy = "";
    const uninstall = vi.fn(async () => { fs.rmSync(copy, { recursive: true, force: true }); });
    const client = { rpc: { plugins: {
      marketplaces: { list: async () => ({ marketplaces: [{ name: "remote", source: `Local: ${root}` }] }) },
      install: () => new Promise<void>(resolve => { finish = resolve; began(); }), uninstall,
    } } };
    const f = fixture(true, [HTTP], { client: () => client as never });
    const dir = path.dirname(f.store.dir);
    root = path.join(dir, "market");
    copy = path.join(dir, "copilot", "installed-plugins", "remote", "downloaded");
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "remote", owner: { name: "Fixture" },
      plugins: [{ name: "downloaded", source: { source: "github", repo: "fixture/downloaded" } }],
    }));
    fs.mkdirSync(path.join(copy, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(copy, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "downloaded", mcpServers: { fixture: HTTP } }));
    const pending = f.service.install("remote", "downloaded");
    await started;
    f.consent(false);
    finish();
    expect((await pending).ok).toBe(false);
    expect(uninstall).toHaveBeenCalledExactlyOnceWith({ name: "downloaded@remote" });
    expect(fs.existsSync(copy)).toBe(false);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.store.read()).toHaveLength(1);
  });
});

describe("stopped extension probes", () => {
  it("does not start a stdio process when already stopped (extensions-refresh-consent-1)", async () => {
    const stop = new AbortController();
    stop.abort();
    processBoundary.spawn.mockClear();
    expect((await probeStdio({ command: "fixture-only", args: [], env: {}, cwd: ".", signal: stop.signal })).ok).toBe(false);
    expect(processBoundary.spawn).not.toHaveBeenCalled();
  });

  it("does not send headers when already stopped (extensions-refresh-consent-1)", async () => {
    const stop = new AbortController();
    stop.abort();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
    expect((await probeHttp({ url: "https://fixture.example/mcp", headers: HTTP.type === "http" ? HTTP.headers : {}, fetch, signal: stop.signal })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not continue initialization after a late fetch reply despite its aborted signal (extensions-refresh-consent-1)", async () => {
    const stop = new AbortController();
    let finish!: (response: Response) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let calls = 0;
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      if (calls++ === 0) return new Promise<Response>(resolve => { finish = resolve; began(); });
      const message = JSON.parse(String(init?.body)) as { id?: number };
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })));
    });
    const pending = probeHttp({ url: "https://fixture.example/mcp", headers: {}, fetch, signal: stop.signal });
    await started;
    stop.abort();
    finish(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
    expect((await pending).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("extension results keep the permission of their own session", () => {
  const bound = (retire: () => Promise<void> = vi.fn(async () => undefined)) => {
    const f = fixture(true, [HTTP], { audit: () => ({ write() {} }) as never, confirmer: () => ({ ask: async () => "once" }) as never });
    const session = f.service.forSession()!;
    const name = session.tools[0];
    const shown = [{ name, description: TOOL.description, input_schema: TOOL.inputSchema }];
    session.verify(shown);
    session.bind!(async () => shown, async () => undefined, retire);
    const config = hardenedSessionConfig({ tools: [], systemMessage: { mode: "append", content: "" },
      workingDirectory: path.dirname(f.store.dir), onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }), extensions: session });
    const input = { toolName: name, toolArgs: {}, sessionId: "fixture", timestamp: new Date(), workingDirectory: path.dirname(f.store.dir) };
    return { ...f, session, config, input, retire };
  };

  it("withholds a late success through the actual hardened hook after revoke and re-agree (extensions-consent-review-2)", async () => {
    const f = bound();
    const invoke = { sessionId: "fixture" };
    expect(await f.config.hooks!.onPreToolUse!(f.input, invoke)).toMatchObject({ permissionDecision: "allow" });
    const normal = await f.config.hooks!.onPostToolUse!({ ...f.input, toolResult: { resultType: "success", textResultForLlm: "NORMAL_CONTROL" } }, invoke);
    expect(normal?.modifiedResult?.textResultForLlm).toContain("NORMAL_CONTROL");
    f.consent(false);
    f.consent(true);
    const late = await f.config.hooks!.onPostToolUse!({ ...f.input, toolResult: { resultType: "success", textResultForLlm: "REVOKED_RESULT" } }, invoke);
    expect(late?.modifiedResult?.textResultForLlm).not.toContain("REVOKED_RESULT");
    expect(late?.modifiedResult?.binaryResultsForLlm).toEqual([]);
  });

  it("holds an unrewritable late failure until the bound runtime retirement finishes (extensions-consent-review-2)", async () => {
    let close!: () => void;
    const retired = new Promise<void>(resolve => { close = resolve; });
    const retire = vi.fn(() => retired);
    const f = bound(retire);
    f.consent(false);
    let returned = false;
    const pending = Promise.resolve(f.config.hooks!.onPostToolUseFailure!({ ...f.input, error: "REVOKED_FAILURE" }, { sessionId: "fixture" }))
      .then(value => { returned = true; return value; });
    await Promise.resolve();
    expect(retire).toHaveBeenCalledTimes(1);
    expect(returned).toBe(false);
    close();
    await pending;
    expect(returned).toBe(true);
  });

  it("denies a tool without the runtime retirement binding (extensions-consent-review-2)", async () => {
    const f = fixture(true, [HTTP], { audit: () => ({ write() {} }) as never, confirmer: () => ({ ask: async () => "once" }) as never });
    const session = f.service.forSession()!;
    const name = session.tools[0];
    const shown = [{ name, description: TOOL.description, input_schema: TOOL.inputSchema }];
    session.verify(shown);
    session.bind!(async () => shown);
    expect(await session.preToolUse({ toolName: name, toolArgs: {}, sessionId: "fixture", timestamp: new Date(), workingDirectory: "." }))
      .toMatchObject({ permissionDecision: "deny" });
  });
});
