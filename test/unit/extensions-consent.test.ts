/**
 * Extensions and "Before Ember starts": an extension agreed to under an earlier global agreement is neither probed,
 * started nor offered, and no marketplace request goes out, until the current one is agreed (CONSENT_VERSION), and a
 * probe or an install under way when it is lost does nothing more, but for cleaning up the copy it had downloaded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPolicySchema } from "../../app/main/admin";
import { ExtensionsService, type ExtensionsDeps } from "../../app/main/extensions/service";
import { ExtensionStore } from "../../app/main/extensions/store";
import { itemDigest } from "../../app/main/extensions/seal";
import { pinAll } from "../../app/main/extensions/pin";
import { probeHttp, probeStdio, type ProbeResult } from "../../app/main/extensions/probe";
import { DEFAULT_SETTINGS, SettingsSchema, SettingsStore } from "../../app/main/settings";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import type { ServerSpec } from "../../app/main/extensions/manifest";
import type { Logger } from "../../app/main/logger";

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error("No process may start in this test."); }) }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: processBoundary.spawn }));

const AT = "2026-11-09T00:00:00Z";
const TOOL = { name: "lookup", description: "Looks something up.", inputSchema: {}, annotations: { readOnlyHint: true } };
const HTTP: ServerSpec = { type: "http", url: "https://fixture.example/mcp", headers: { authorization: "Bearer fixture-only" } };
const STDIO: ServerSpec = { type: "stdio", command: "fixture-only", args: [], env: {} };
const quiet: Logger = { file: "fixture.log", info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as Logger;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** An agreed, enabled extension Ember wrote (its seal holds it), under a global agreement that is current or not. */
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
  let digests: string[] | null = store.read().map(itemDigest);
  const seal = { read: async () => digests, write: async (d: string[]) => { digests = [...d]; return true; } };
  const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: true, tools: [TOOL] }));
  const service = new ExtensionsService({ dir: store.dir, copilotHome: path.join(dir, "copilot"), settings,
    admin: () => AdminPolicySchema.parse({}), client: () => null, confirmer: () => null, audit: () => ({ write: () => undefined }) as never, log: quiet,
    os: "linux", launcher: { execPath: "fixture-only", script: "fixture-only" }, probe, seal, ...overrides });
  // Out of date, Ember is back at first run (settings refuse onboarded without the current agreement).
  const consent = (on: boolean) => settings.update({ onboarded: on, consent: { version: on ? CONSENT_VERSION : CONSENT_VERSION - 1, at: AT } });
  /** The seal has been read: only then is an item Ember wrote trusted. */
  const sealed = () => new Promise(resolve => setImmediate(resolve));
  return { settings, store, probe, service, consent, sealed };
}

describe("extensions before the current “Before Ember starts” agreement", () => {
  it.each([HTTP, STDIO])("never probes a saved $type server at start until the current agreement is given (extensions-refresh-consent-1)", async spec => {
    const f = fixture(false, [spec]);
    await f.service.refresh();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.service.active()).toBe(false);
    expect(f.service.consented()).toBe(false);
    expect(f.service.forSession()).toBeUndefined();
    f.consent(true);
    await f.service.refresh();
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.service.forSession()?.tools).toHaveLength(1);
  });

  it("offers no tools and takes no enable, install, reagreement or card's yes until it is given (extensions-refresh-consent-1)", async () => {
    const f = fixture();
    expect(f.service.forSession()).toBeUndefined();
    expect((await f.service.install("fixture", "new-plugin")).ok).toBe(false);
    await f.service.setEnabled("fixture", false);
    await f.service.setEnabled("fixture", true);
    const [item] = await f.service.list();
    await f.service.reagree(item.id, item.reviewToken ?? "");
    await f.service.agree();
    expect(f.probe).not.toHaveBeenCalled();
    expect((await f.service.list())[0].enabled).toBe(false);
    expect(f.settings.get().extensions.consent.at).toBe(AT);
  });

  it("takes the tools away and ignores a probe that answers after the agreement went out of date (extensions-refresh-consent-1)", async () => {
    let finish!: (result: ProbeResult) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const probe = vi.fn(() => new Promise<ProbeResult>(resolve => { finish = resolve; began(); }));
    const f = fixture(true, [HTTP, STDIO], { probe });
    await f.sealed();
    const session = f.service.forSession()!;
    const stopped = vi.fn(async () => undefined);
    session.bind?.(async () => [], stopped);
    const before = f.store.read();
    const pending = f.service.refresh();
    await started;
    f.consent(false);
    expect(f.service.forSession()).toBeUndefined();
    finish({ ok: true, tools: [{ ...TOOL, name: "later" }] });
    await pending;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(f.store.read()).toEqual(before);
  });

  it("sends no marketplace request until it is given, and then lists and browses before extensions' own card (extensions-refresh-consent-1)", async () => {
    const list = vi.fn(async () => ({ marketplaces: [] }));
    const add = vi.fn(async () => ({ name: "fixture" }));
    const remove = vi.fn(async () => ({}));
    const browse = vi.fn(async () => ({}));
    const f = fixture(false, [HTTP], { client: () => ({ rpc: { plugins: { marketplaces: { list, add, remove, browse } } } }) as never });
    expect(await f.service.marketplaces()).toEqual([]);
    expect(await f.service.browse("fixture")).toMatchObject({ ok: false });
    expect((await f.service.addMarketplace("fixture/plugins")).ok).toBe(false);
    expect((await f.service.removeMarketplace("fixture")).ok).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();
    f.consent(true);
    f.settings.update({ extensions: { on: false, consent: { version: 0, at: null } } });
    await f.service.marketplaces();
    expect(list).toHaveBeenCalledTimes(1);
    await f.service.browse("fixture");
    expect(browse).toHaveBeenCalledTimes(1);
  });

  it("still removes an installed extension and its files, starting nothing (extensions-consent-review-1)", async () => {
    const f = fixture();
    const dir = f.store.pluginDir("fixture");
    fs.mkdirSync(dir, { recursive: true });
    await f.service.uninstall("fixture");
    expect(await f.service.list()).toEqual([]);
    expect(f.store.read()).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("removes the runtime's downloaded copy when the agreement goes out of date during an install, and probes nothing (extensions-consent-review-1)", async () => {
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

describe("a probe stopped before it starts", () => {
  it("starts no stdio program (extensions-refresh-consent-1)", async () => {
    const stop = new AbortController();
    stop.abort();
    processBoundary.spawn.mockClear();
    expect((await probeStdio({ command: "fixture-only", args: [], env: {}, cwd: ".", signal: stop.signal })).ok).toBe(false);
    expect(processBoundary.spawn).not.toHaveBeenCalled();
  });

  it("sends a remote server nothing, its headers included (extensions-refresh-consent-1)", async () => {
    const stop = new AbortController();
    stop.abort();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
    expect((await probeHttp({ url: "https://fixture.example/mcp", headers: HTTP.type === "http" ? HTTP.headers : {}, fetch, signal: stop.signal })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends nothing more after a reply that comes in once it was stopped (extensions-refresh-consent-1)", async () => {
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
