/**
 * Home's Extensions channels (EXTENSIONS_IPC) in main, over an injected ExtensionsApi (app/shared/extensions.ts). Only
 * the user installs, so every channel answers only the settings window's own page (`isHomeSender`, checked before
 * anything else), takes its arguments as unknown and checks their type and size, refuses every change while the
 * organisation's policy (or LOCKDOWN) turns extensions off, and answers in one plain sentence (extensionsError), never
 * the runtime's raw text. Connect opens only GitHub's own https pages in the browser (mayOpenConnectUrl). With no
 * runtime (`api` null) the section says extensions aren't available yet. Plain Node: Electron's objects are injected.
 */

import type { ExtensionsApi, MarketplaceEntry } from "../shared/extensions";
import { EXTENSIONS_IPC, type ExtensionsConnect, type ExtensionsDone, type ExtensionsEntries, type ExtensionsState } from "../shared/ipc";
import { extensionsName, marketplaceSource, mayOpenConnectUrl } from "../shared/extensions-input";
import {
  EXTENSIONS_BAD_REQUEST, EXTENSIONS_LOCKDOWN, EXTENSIONS_MANAGED, EXTENSIONS_REFUSED_URL, EXTENSIONS_UNAVAILABLE, MARKETPLACE_INVALID, extensionsError,
} from "../renderer/home/extensions-copy";

/** The part of Electron's ipcMain these channels use. */
export interface ExtensionsIpcMain {
  handle(channel: string, fn: (event: ExtensionsIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
}
/** The part of an invoke event the sender check reads. */
export interface ExtensionsIpcEvent { sender: unknown; senderFrame?: { url: string } | null }

export interface ExtensionsIpcOptions {
  /** Tells the settings window something changed (EXTENSIONS_IPC.changed). */
  send?: (channel: string, value: unknown) => void;
  /** Where raw errors go (never to the page). */
  log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

/** Longest list main passes to the page (a marketplace may list thousands; the page shows a list a person reads). */
export const ENTRIES_MAX = 500;

/**
 * Registers EXTENSIONS_IPC's handlers. Returns a function that removes them and stops following the runtime's changes.
 * `openExternal` is the system browser (shell.openExternal); it is only ever given a URL mayOpenConnectUrl allows.
 */
export function registerExtensionsIpc(
  ipcMain: ExtensionsIpcMain,
  isHomeSender: (event: ExtensionsIpcEvent) => boolean,
  api: ExtensionsApi | null,
  openExternal: (url: string) => unknown,
  opts: ExtensionsIpcOptions = {},
): () => void {
  const fail = (why: string) => ({ ok: false as const, why });
  const raw = (where: string, err: unknown) => {
    opts.log?.warn("extensions.ipc_failed", { where, err: err instanceof Error ? err.message : String(err) });
    return fail(extensionsError(err));
  };
  /** Why no change may be made now, or null. */
  const blocked = (): string | null => {
    if (!api) return EXTENSIONS_UNAVAILABLE;
    try { return api.allowed() ? null : EXTENSIONS_MANAGED; } catch { return EXTENSIONS_LOCKDOWN; /* a policy that can't be read is a lockdown */ }
  };
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${channel}`);
      return fn(...args);
    });
  };
  /** A change: the sender is checked, then the policy, then the arguments, then the runtime does it. */
  const change = <A extends unknown[]>(channel: string, check: (...args: unknown[]) => A | null, run: (...args: A) => Promise<ExtensionsDone>) => {
    handle(channel, async (...args) => {
      const why = blocked();
      if (why) return fail(why);
      const ok = check(...args);
      if (!ok) return fail(EXTENSIONS_BAD_REQUEST);
      try { return await run(...ok); } catch (err) { return raw(channel, err); }
    });
  };
  const one = (a: unknown): [string] | null => { const s = extensionsName(a); return s ? [s] : null; };
  const done = async (p: Promise<unknown>): Promise<ExtensionsDone> => { await p; return { ok: true }; };
  /** A runtime's own refusal, in plain words. */
  const outcome = (r: { ok: true } | { ok: false; why: string }): ExtensionsDone => (r.ok ? { ok: true } : fail(extensionsError(r.why)));
  const entries = (list: MarketplaceEntry[]): ExtensionsEntries => ({ ok: true, entries: Array.isArray(list) ? list.slice(0, ENTRIES_MAX) : [] });

  handle(EXTENSIONS_IPC.state, async (): Promise<ExtensionsState> => {
    if (!api) return { available: false, allowed: false, installed: [], marketplaces: [] };
    const allowed = blocked() === null;
    try {
      const [installed, marketplaces] = await Promise.all([api.list(), api.marketplaces()]);
      let consented = false;
      try { consented = api.consented() === true; } catch { /* unknown: the card is shown again */ }
      // Not connected: an empty list is why, not "no marketplaces" (integrations-v2).
      let connected = true;
      try { connected = api.connected?.() !== false; } catch { /* unknown: taken as connected, as before */ }
      return { available: true, allowed, consented, ...(connected ? {} : { connected: false }), installed: Array.isArray(installed) ? installed : [], marketplaces: Array.isArray(marketplaces) ? marketplaces : [] };
    } catch (err) {
      return { available: true, allowed, installed: [], marketplaces: [], error: raw(EXTENSIONS_IPC.state, err).why };
    }
  });

  handle(EXTENSIONS_IPC.browse, async (m: unknown): Promise<ExtensionsEntries> => {
    const why = blocked();
    if (why) return fail(why);
    const name = extensionsName(m);
    if (!name) return fail(EXTENSIONS_BAD_REQUEST);
    try { return entries(await api!.browse(name)); } catch (err) { return raw(EXTENSIONS_IPC.browse, err); }
  });

  handle(EXTENSIONS_IPC.connectors, async (): Promise<ExtensionsEntries> => {
    const why = blocked();
    if (why) return fail(why);
    try { return entries(await api!.connectors()); } catch (err) { return raw(EXTENSIONS_IPC.connectors, err); }
  });

  handle(EXTENSIONS_IPC.addMarketplace, async (s: unknown): Promise<ExtensionsDone> => {
    const why = blocked();
    if (why) return fail(why);
    const source = marketplaceSource(s);
    if (!source) return fail(MARKETPLACE_INVALID);
    try { return outcome(await api!.addMarketplace(source)); } catch (err) { return raw(EXTENSIONS_IPC.addMarketplace, err); }
  });

  change(EXTENSIONS_IPC.removeMarketplace, one, async name => outcome(await api!.removeMarketplace(name)));
  change(EXTENSIONS_IPC.install, (m, n) => { const a = extensionsName(m), b = extensionsName(n); return a && b ? [a, b] as [string, string] : null; },
    async (m, n) => outcome(await api!.install(m, n)));
  change(EXTENSIONS_IPC.uninstall, one, id => done(api!.uninstall(id)));
  change(EXTENSIONS_IPC.setEnabled, (i, on) => { const id = extensionsName(i); return id && typeof on === "boolean" ? [id, on] as [string, boolean] : null; },
    (id, on) => done(api!.setEnabled(id, on)));
  change(EXTENSIONS_IPC.disconnect, one, id => done(api!.disconnect(id)));
  change(EXTENSIONS_IPC.reagree, (i, token) => {
    const id = extensionsName(i);
    return id && typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? [id, token] as [string, string] : null;
  }, (id, token) => done(api!.reagree(id, token)));
  change(EXTENSIONS_IPC.agree, () => [] as [], () => done(api!.agree()));

  handle(EXTENSIONS_IPC.connect, async (n: unknown): Promise<ExtensionsConnect> => {
    const why = blocked();
    if (why) return fail(why);
    const name = extensionsName(n);
    if (!name) return fail(EXTENSIONS_BAD_REQUEST);
    try {
      const r = await api!.connect(name);
      if ("ok" in r) return fail(extensionsError(r.why));
      if (r.state !== "consent") return { ok: true, state: r.state === "connected" ? "connected" : "pending" };
      if (!mayOpenConnectUrl(r.url)) {
        opts.log?.warn("extensions.connect_url_refused", { connector: name });
        return fail(EXTENSIONS_REFUSED_URL);
      }
      await openExternal(r.url);
      return { ok: true, state: "consent" };
    } catch (err) {
      return raw(EXTENSIONS_IPC.connect, err);
    }
  });

  const stop = api?.onChange(() => opts.send?.(EXTENSIONS_IPC.changed, null));
  return () => {
    stop?.();
    for (const channel of Object.values(EXTENSIONS_IPC)) if (channel !== EXTENSIONS_IPC.changed) ipcMain.removeHandler?.(channel);
  };
}
