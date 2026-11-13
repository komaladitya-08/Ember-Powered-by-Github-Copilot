/**
 * Ember's own parts around a vault fill, wired as main.ts wires them, for the vault's leak tests: the real store,
 * service, redactor, policy engine, Perception, worker, audit log, logger (at debug level) and settings file, all in
 * one data folder, over the pretend app of leaky.ts. Only the keyring, the Secure Form's window, the accessibility
 * helper and the screen are pretend.
 */

import path from "node:path";
import { PolicyEngine } from "../../../app/main/policy/policy";
import { ALL_SCOPES } from "../../../app/main/policy/autonomy";
import { AuditLog } from "../../../app/main/policy/audit";
import { LINUX_WORKER_SYSTEM, Worker, type TaskSpec, type WorkerDeps, type WorkerVault } from "../../../app/main/agent/worker";
import { Presenter } from "../../../app/main/agent/presenter";
import { redactingClient } from "../../../app/main/agent/redacting-client";
import { Perception } from "../../../app/main/perception";
import { SettingsStore } from "../../../app/main/settings";
import { createLogger } from "../../../app/main/logger";
import { VaultRedactor } from "../../../app/main/vault/redact";
import { VaultService, registerVaultHomeIpc } from "../../../app/main/vault/service";
import { VAULT_FILE, VaultStore } from "../../../app/main/vault/store";
import { VAULT_IPC } from "../../../app/shared/vault";
import { KEYS, SHORTCUTS, type OS } from "../../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../../app/shared/words";
import type { Capture } from "../../../app/main/perception/capture";
import { CANARY, ENTRIES, box, leakyApp } from "./leaky";

export type LeakyEmber = Awaited<ReturnType<typeof leakyEmber>>;

/**
 * `client`: the runtime client (a real one, or a recording fake); it is wrapped in the redactor as AgentHost wraps
 * it. `os`: whose keys and words the worker uses. The login is not saved yet: the Secure Form is asked for it once
 * (and "typed" by the pretend person); the card and the contact details are saved already.
 */
export async function leakyEmber(o: { dir: string; client: unknown; os?: OS; spec?: Partial<TaskSpec>; deps?: Partial<WorkerDeps> }) {
  const os = o.os ?? "linux";
  const redactor = new VaultRedactor();
  const log = createLogger({ dir: path.join(o.dir, "logs"), level: "debug", redact: text => redactor.text(text) });
  const audit = new AuditLog(path.join(o.dir, "audit"), undefined, undefined, undefined, entry => redactor.deep(entry));
  const settings = new SettingsStore(path.join(o.dir, "settings.json"));
  settings.load();
  const store = new VaultStore(path.join(o.dir, VAULT_FILE), box);
  const forms: { kind: string; where: string }[] = [];
  const service: VaultService = new VaultService({
    store, allowed: () => true, consented: () => true, autopilot: () => true, appName: k => k, log: log.child("vault"),
    filling: (part, value) => redactor.note(part, value),
    form: {
      ask: async req => {
        forms.push({ kind: req.kind, where: req.where });
        return (await service.keep(req.kind, req.dest, CANARY[req.kind])).ok ? "saved" : "cancelled";
      },
      stop: () => {},
    },
  });
  for (const [kind, dest, values] of ENTRIES.filter(e => e[0] !== "login")) {
    const kept = await service.keep(kind, dest, values);
    if (!kept.ok) throw new Error(`the ${kind} couldn't be kept`);
  }
  // The helper's stderr, as AtspiSidecar logs it.
  const app = leakyApp({ stderr: line => log.child("sidecar").debug("sidecar.stderr", { line }) });
  const real = new Perception({
    sidecar: app.sidecar as never, x11: app.x11 as never, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1000, height: 1000 }), log: log.child("perception"), ownPid: 999,
    holdsVaultValue: text => redactor.holds(text), vaultShown: () => redactor.shown,
  });
  /** Every picture Perception handed out, with the elements it read for it. */
  const pictures: { capture: Capture | null; text: string }[] = [];
  const perception = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop !== "perceive") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return async (q: Parameters<Perception["perceive"]>[0]) => {
        const p = await target.perceive(q);
        if (q.image) pictures.push({ capture: p.capture, text: p.text });
        return p;
      };
    },
  });
  const said: string[] = [];
  const activity: unknown[] = [];
  const progress: string[] = [];
  const presenter = new Presenter(() => undefined);
  presenter.workedWithoutAsking = (text: string) => { said.push(text); };
  const on = () => true;
  const vault: WorkerVault = {
    usable: () => service.usable(), has: (k, d) => service.has(k, d), ask: (k, d, via) => service.ask(k, d, via), use: (k, p, d, fn) => service.use(k, p, d, fn),
    pages: app.pages, put: app.put, mark: app.mark,
  };
  const worker = new Worker({
    client: redactingClient(o.client as object, redactor) as never, log: log.child("task"), model: "mock-model", vision: true, workDir: path.join(o.dir, "empty"),
    system: { ...LINUX_WORKER_SYSTEM, os, keys: KEYS[os], words: PLATFORM_WORDS[os], shortcuts: SHORTCUTS[os] },
    perception: perception as never, sidecar: app.sidecar as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => ({ ...ALL_SCOPES }), trustAskedApps: () => true, autopilot: on, vaultAllowed: on, isTerminalApp: n => /terminal/i.test(n) }),
    autonomy: () => ({ ...ALL_SCOPES }), autopilot: on,
    confirmer: { ask: async () => { throw new Error("a question was asked in Autopilot"); } } as never,
    audit, settings, presenter,
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: (t: string) => { progress.push(t); },
    onActivity: (e: unknown) => { activity.push(e); },
    cursor: app.cursor as never, clipboard: app.clipboard as never,
    vault,
    ...o.deps,
  } as unknown as WorkerDeps, { id: "leak1", goal: "Sign in and check out on shop.example", userWords: "sign me in to the shop and fill in the checkout", target: { title: "Checkout" }, ...o.spec });
  /** Home's own channels, as its page would call them. */
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerVaultHomeIpc({ handle: (channel, fn) => { handlers.set(channel, fn as never); } }, () => true, service);
  const home = () => [handlers.get(VAULT_IPC.list)!({}), service.homeState()];
  return { redactor, log, audit, settings, store, service, app, perception: real, pictures, worker, said, activity, progress, forms, home, handlers };
}
