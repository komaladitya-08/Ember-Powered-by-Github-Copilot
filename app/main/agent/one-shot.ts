/**
 * Memory's model calls on Copilot (app/main/memory/learn.ts and refine.ts), built like the command reviewer
 * (reviewer.ts): each call is a session of its own, hardened, with no tools and only memory's instructions, deleted once
 * it has answered, so no call hears the conversation or another call. No answer within its time, or a stop, is no
 * answer (null): memory learns nothing from it. A runtime that hangs while making the session counts too, because
 * Project keeps every control waiting on the call (main.ts `projectJob`).
 */

import crypto from "node:crypto";
import type { CopilotClient, ProviderConfig } from "@github/copilot-sdk";
import type { Logger } from "../logger";
import type { OneShot } from "../memory/learn";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";

/** How long one memory call may take (ms). */
export const ONE_SHOT_MS = 30_000;
/** How long a project request may take (ms): up to 64 KiB of files, which a reasoning model can't read in 30 s. */
export const PROJECT_SHOT_MS = 120_000;
/** How long making the session may take (ms). */
export const SESSION_START_MS = 30_000;

/** `work`, or a rejection once `signal` stops it or `ms` pass; `work` itself may go on, unheard. */
function within<T>(work: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => { end(); reject(new Error("one-shot stopped")); };
    const timer = setTimeout(() => { end(); reject(new Error("one-shot timed out")); }, ms);
    const end = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    work.then(value => { end(); resolve(value); }, err => { end(); reject(err); });
  });
}

/** Why a call failed, as the session said it (`onFailure`): its error's words, type and status code, or that it took too long. */
export interface OneShotFailure { message: string; errorType?: string; statusCode?: number; timedOut?: boolean }

export function copilotOneShot(o: { client: CopilotClient; model: string | null; provider?: ProviderConfig; workDir: string; log: Logger; purpose?: "project"; onFailure?: (f: OneShotFailure) => void }): OneShot {
  return async (system, prompt, signal) => {
    if (signal.aborted) return null;
    const purpose = o.purpose ?? "memory";
    const sessionId = `ember-${purpose}-${crypto.randomUUID()}`;
    let making: Promise<unknown> | null = null;
    let made = false;
    /** The session's own error (sendAndWait keeps only its words): its type and status code say what to do. */
    let said: { errorType?: string; statusCode?: number } = {};
    try {
      const config = hardenedSessionConfig({
        sessionId, model: o.model ?? undefined, provider: o.provider, tools: [],
        systemMessage: { mode: "replace", content: system },
        workingDirectory: o.workDir,
        onPermissionRequest: () => ({ kind: "reject", feedback: "This session has no tools." }),
      });
      const creating = o.client.createSession(purpose === "project" ? { ...config, infiniteSessions: { enabled: false } } : config);
      making = creating;
      const session = await within(creating, signal, SESSION_START_MS);
      made = true;
      // No tool at all may be offered (fail closed: a session that shows one is not asked).
      await verifySessionTools(session, []);
      if (signal.aborted) return null;
      const abort = () => { void session.abort().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      if (o.onFailure && typeof session.on === "function") session.on(e => {
        if (e.type !== "session.error") return;
        const d = e.data as { errorType?: unknown; statusCode?: unknown };
        said = { ...(typeof d.errorType === "string" ? { errorType: d.errorType } : {}), ...(typeof d.statusCode === "number" ? { statusCode: d.statusCode } : {}) };
      });
      try {
        const limit = purpose === "project" ? PROJECT_SHOT_MS : ONE_SHOT_MS;
        const answer = await within(session.sendAndWait({ prompt }, limit), signal, limit);
        return signal.aborted ? null : answer?.data.content ?? null;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } catch (err) {
      if (signal.aborted) return null;
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /^one-shot timed out$|^Timeout after \d+ms/.test(message);
      // A project's log keeps the cause's kind only, never its words: the service may quote the files it was sent.
      if (purpose === "project") o.log.warn("project.model_failed", { errorType: said.errorType, statusCode: said.statusCode, timedOut });
      else o.log.warn("memory.model_failed", { err: message });
      o.onFailure?.({ message, ...said, ...(timedOut ? { timedOut } : {}) });
      return null;
    } finally {
      // Always, even when createSession failed: it may have made the session before it rejected (each session holds an
      // inotify instance). Deleting one that doesn't exist only fails, and that is ignored.
      const drop = () => { void Promise.resolve().then(() => o.client.deleteSession(sessionId)).catch(() => undefined); };
      drop();
      // Given up on while it was being made: it may still arrive, and then it goes too.
      if (making && !made) void making.then(drop, () => undefined);
    }
  };
}
