/**
 * Memory's model calls on Copilot (app/main/memory/learn.ts and refine.ts), built like the command reviewer
 * (reviewer.ts): each call is a session of its own, hardened, with no tools and only memory's instructions, deleted once
 * it has answered, so no call hears the conversation or another call. No answer within ONE_SHOT_MS, or a stop, is no
 * answer (null): memory learns nothing from it.
 */

import crypto from "node:crypto";
import type { CopilotClient, ProviderConfig } from "@github/copilot-sdk";
import type { Logger } from "../logger";
import type { OneShot } from "../memory/learn";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";

/** How long one memory call may take (ms). */
export const ONE_SHOT_MS = 30_000;

export function copilotOneShot(o: { client: CopilotClient; model: string | null; provider?: ProviderConfig; workDir: string; log: Logger; purpose?: "project" }): OneShot {
  return async (system, prompt, signal) => {
    if (signal.aborted) return null;
    const purpose = o.purpose ?? "memory";
    const sessionId = `ember-${purpose}-${crypto.randomUUID()}`;
    try {
      const config = hardenedSessionConfig({
        sessionId, model: o.model ?? undefined, provider: o.provider, tools: [],
        systemMessage: { mode: "replace", content: system },
        workingDirectory: o.workDir,
        onPermissionRequest: () => ({ kind: "reject", feedback: "This session has no tools." }),
      });
      const session = await o.client.createSession(purpose === "project" ? { ...config, infiniteSessions: { enabled: false } } : config);
      // No tool at all may be offered (fail closed: a session that shows one is not asked).
      await verifySessionTools(session, []);
      if (signal.aborted) return null;
      const abort = () => { void session.abort().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const answer = await session.sendAndWait({ prompt }, ONE_SHOT_MS);
        return signal.aborted ? null : answer?.data.content ?? null;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } catch (err) {
      if (purpose === "project") o.log.warn("project.model_failed");
      else o.log.warn("memory.model_failed", { err: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      // Always, even when createSession failed: it may have made the session before it rejected (each session holds an
      // inotify instance). Deleting one that doesn't exist only fails, and that is ignored.
      void Promise.resolve().then(() => o.client.deleteSession(sessionId)).catch(() => undefined);
    }
  };
}
