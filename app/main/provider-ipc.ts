/**
 * Home's own model provider channels (PROVIDER_IPC) in main, over an injected ProviderApi. Every channel answers only
 * the settings window's own page (`isHomeSender`, checked before anything else) and takes its arguments as unknown,
 * checked with zod: saveKey one string of at most MAX_API_KEY characters, agree one host, test nothing or one draft of
 * typed details (first-run-r2-1), the others nothing at all. A key goes only from the page to main (saveKey, or a
 * draft's check, which keeps it nowhere) and is never sent back or logged; a raw error from below becomes one plain
 * sentence. Plain Node: Electron's objects are injected.
 */

import { z } from "zod";
import { PROVIDER_IPC, type ProviderDone, type ProviderDraft, type ProviderState, type ProviderTest } from "../shared/ipc";
import { MAX_API_KEY, MAX_ENDPOINT, PROVIDER_TYPES } from "../shared/provider";

/** What main does for the channels (main.ts builds it over ProviderKeyStore, the settings and the host). */
export interface ProviderApi {
  state(): ProviderState | Promise<ProviderState>;
  saveKey(key: string): Promise<ProviderDone>;
  removeKey(): ProviderDone;
  /** Records the card's yes for `host`; main refuses a host other than the one the endpoint in settings names. */
  agree(host: string): ProviderDone;
  /** The endpoint in settings, or `draft`'s typed details without saving or recording any of them (first-run-r2-1). */
  test(draft?: ProviderDraft): Promise<ProviderTest>;
}

/** The part of Electron's ipcMain these channels use. */
export interface ProviderIpcMain {
  handle(channel: string, fn: (event: ProviderIpcEvent, ...args: unknown[]) => unknown): void;
}
/** The part of an invoke event the sender check reads. */
export interface ProviderIpcEvent { sender: unknown; senderFrame?: { url: string } | null }

/** saveKey's arguments: exactly one string, not empty, no longer than a key can be. */
export const SaveKeyArgs = z.tuple([z.string().min(1).max(MAX_API_KEY)]);
/** A host as endpointHost writes it (a name or address, with its port). */
const HostArg = z.string().min(1).max(260).regex(/^[a-z0-9.\-[\]:]+$/);
/** agree's argument: one host. */
export const AgreeArgs = z.tuple([HostArg]);
/** The other channels take nothing. */
export const NoArgs = z.tuple([]);
/**
 * test's arguments: nothing (the endpoint in settings), or one draft of typed details: its kind, address, the host the
 * card was agreed for with the same press, and a key just typed (first-run-r2-1). Nothing else is taken.
 */
export const TestArgs = z.union([
  NoArgs,
  z.tuple([z.object({ type: z.enum(PROVIDER_TYPES), baseUrl: z.string().min(1).max(MAX_ENDPOINT), host: HostArg, key: z.string().min(1).max(MAX_API_KEY).optional() }).strict()]),
]);

/** The sentence for arguments that aren't what a channel takes (only a page that isn't Ember's own would send them). */
export const PROVIDER_BAD_REQUEST = "Ember couldn't do that: the request wasn't one it knows.";
/** The sentence for anything that failed below (the raw error goes to the log, never the key). */
export const PROVIDER_FAILED = "Ember couldn't do that. Try again.";

/**
 * Registers PROVIDER_IPC's handlers. A sender that isn't the settings window is refused with an error (as every Ember
 * handler does); arguments that fail their schema get PROVIDER_BAD_REQUEST, and nothing is done.
 */
export function registerProviderIpc(
  ipcMain: ProviderIpcMain,
  isHomeSender: (event: ProviderIpcEvent) => boolean,
  api: ProviderApi,
  opts: { log?: { warn(event: string, fields?: Record<string, unknown>): void } } = {},
): void {
  const fail = (why: string) => ({ ok: false as const, why });
  const handle = <A extends unknown[]>(channel: string, schema: z.ZodType<A>, fn: (...args: A) => unknown, bad: () => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${channel}`);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return bad();
      try {
        return await fn(...parsed.data);
      } catch (err) {
        // The error's name only: a message could quote what was being saved.
        opts.log?.warn("provider.ipc_failed", { channel, err: err instanceof Error ? err.name : "unknown" });
        return channel === PROVIDER_IPC.state ? null : fail(PROVIDER_FAILED);
      }
    });
  };
  handle(PROVIDER_IPC.state, NoArgs, () => api.state(), () => null);
  handle(PROVIDER_IPC.saveKey, SaveKeyArgs, key => api.saveKey(key), () => fail(PROVIDER_BAD_REQUEST));
  handle(PROVIDER_IPC.removeKey, NoArgs, () => api.removeKey(), () => fail(PROVIDER_BAD_REQUEST));
  handle(PROVIDER_IPC.agree, AgreeArgs, host => api.agree(host), () => fail(PROVIDER_BAD_REQUEST));
  handle(PROVIDER_IPC.test, TestArgs, (...args) => api.test(args[0]), () => fail(PROVIDER_BAD_REQUEST));
}
