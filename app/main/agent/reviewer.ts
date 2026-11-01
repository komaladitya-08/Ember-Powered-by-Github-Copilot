/**
 * The command reviewer (commands/review.ts) on Copilot: each review is a session of its own, with no tools and only the
 * reviewer's instructions, deleted once it has answered, so no review hears another's (or the task's) conversation.
 * No answer within REVIEW_MS, or one that isn't the JSON asked for, is no review: the command asks.
 */

import crypto from "node:crypto";
import type { CopilotClient, ProviderConfig } from "@github/copilot-sdk";
import { REVIEW_SYSTEM, parseReview, reviewPrompt, type CommandReviewer } from "../commands/review";
import type { Logger } from "../logger";
import { hardenedSessionConfig } from "./session-config";

/** How long a review may take before the command asks instead (ms). */
export const REVIEW_MS = 20_000;

export function copilotReviewer(o: { client: CopilotClient; model: string | null; provider?: ProviderConfig; workDir: string; log: Logger }): CommandReviewer {
  return async (input, signal) => {
    if (signal.aborted) return null;
    const sessionId = `ember-review-${crypto.randomUUID()}`;
    let made = false;
    try {
      const session = await o.client.createSession(hardenedSessionConfig({
        sessionId, model: o.model ?? undefined, provider: o.provider, tools: [],
        systemMessage: { mode: "replace", content: REVIEW_SYSTEM },
        workingDirectory: o.workDir,
        onPermissionRequest: () => ({ kind: "reject", feedback: "The reviewer has no tools." }),
      }));
      made = true;
      const abort = () => { void session.abort().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const answer = await session.sendAndWait({ prompt: reviewPrompt(input) }, REVIEW_MS);
        return parseReview(answer?.data.content);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } catch (err) {
      o.log.warn("commands.review_failed", { err: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      if (made) void o.client.deleteSession(sessionId).catch(() => undefined);
    }
  };
}
