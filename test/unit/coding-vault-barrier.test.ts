import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../../app/main/agent/host";
import { CodingRetirement } from "../../app/main/agent/coding-retirement";
import { SettingsStore } from "../../app/main/settings";
import type { Logger } from "../../app/main/logger";

/** Construct just the state needed by the barrier, without connecting a model or opening a vault. */
function hostWith(disposed: Promise<boolean>) {
  const host = Object.create(AgentHost.prototype) as AgentHost;
  const state = host as unknown as { codingTasks: Set<string>; codingRetirement: CodingRetirement;
    vaultFillHolds: number; mixedHandoffs: { clear(): void }; mixedCompletionPlans: Map<string, { close(): void; revoke(): void }>;
    tasks: { cancel(id: string): void } };
  const cancel = vi.fn(), clear = vi.fn();
  state.codingTasks = new Set(["coding-1"]);
  state.codingRetirement = new CodingRetirement();
  state.codingRetirement.track(disposed);
  state.vaultFillHolds = 0;
  state.mixedHandoffs = { clear };
  state.mixedCompletionPlans = new Map();
  state.tasks = { cancel };
  return { host, state, cancel, clear };
}

describe("vault fill and native coding", () => {
  it("holds new starts and waits until the cancelled coding worker is disposed", async () => {
    let finish!: (ok: boolean) => void;
    const h = hostWith(new Promise<boolean>(resolve => { finish = resolve; }));
    let settled = false;
    const ready = h.host.prepareForVaultFill().then(ok => { settled = true; return ok; });
    expect(h.state.vaultFillHolds).toBe(1);
    expect(h.cancel).toHaveBeenCalledWith("coding-1");
    expect(h.clear).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(true);
    expect(await ready).toBe(true);
    expect(h.state.vaultFillHolds).toBe(1);
    h.host.finishVaultFill();
    expect(h.state.vaultFillHolds).toBe(0);
  });

  it("refuses the fill and releases the hold if disposal fails", async () => {
    const h = hostWith(Promise.resolve(false));
    expect(await h.host.prepareForVaultFill()).toBe(false);
    expect(h.state.vaultFillHolds).toBe(0);
    expect(h.state.codingRetirement.blocked).toBe(true);
  });

  it("releases the hold when a disposal unexpectedly rejects", async () => {
    const h = hostWith(Promise.reject(new Error("disconnect failed")));
    expect(await h.host.prepareForVaultFill()).toBe(false);
    expect(h.state.vaultFillHolds).toBe(0);
    expect(h.state.codingRetirement.blocked).toBe(true);
  });
});

describe("account and application retirement", () => {
  function hostWithPending() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-coding-retirement-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;
    const host = new AgentHost({ userData: dir, runtimePath: "/unused", settings, log, setState: () => undefined, onStatus: () => undefined });
    const retirement = (host as unknown as { codingRetirement: CodingRetirement }).codingRetirement;
    let finish!: (ok: boolean) => void;
    retirement.track(new Promise<boolean>(resolve => { finish = resolve; }));
    return { host, retirement, finish, dir };
  }

  for (const operation of ["forgetConversation", "stop"] as const) it(`${operation} waits for coding runtime disposal`, async () => {
    const h = hostWithPending();
    try {
      let settled = false;
      const waiting = h.host[operation]().then(() => { settled = true; });
      await vi.waitFor(() => expect(h.retirement.blocked).toBe(true));
      expect(settled).toBe(false);
      h.finish(true);
      await waiting;
      expect(h.retirement.blocked).toBe(false);
    } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
  });

  for (const operation of ["forgetConversation", "stop"] as const) it(`${operation} surfaces an unconfirmed coding stop and never admits new coding`, async () => {
    const h = hostWithPending();
    try {
      const waiting = h.host[operation]();
      await vi.waitFor(() => expect(h.retirement.blocked).toBe(true));
      h.finish(false);
      await expect(waiting).rejects.toThrow("couldn't confirm that the coding runtime stopped");
      expect(h.retirement.blocked).toBe(true);
      if (operation === "forgetConversation") expect(JSON.parse(fs.readFileSync(path.join(h.dir, "agent.json"), "utf8")).signedOut).toBe(true);
    } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("does not treat a timed-out sign-out as a stopped runtime", async () => {
    vi.useFakeTimers();
    const h = hostWithPending();
    try {
      const waiting = h.host.forgetConversation();
      const outcome = waiting.then(() => "done", err => err instanceof Error ? err.message : "unknown");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toContain("couldn't confirm that the coding runtime stopped");
      expect(h.retirement.blocked).toBe(true);
      h.finish(true);
      await vi.waitFor(() => expect(h.retirement.blocked).toBe(false));
    } finally {
      vi.useRealTimers();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
