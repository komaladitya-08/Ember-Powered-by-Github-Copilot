/**
 * The command reviewer and Assisted's check for app steps (commands/review.ts) on Copilot: each review is a session of
 * its own, with no tools and only the reviewer's instructions, deleted once it has answered, so no review hears
 * another's (or the task's) conversation. No answer within REVIEW_MS, or one that isn't the answer asked for, is no
 * review: the command or the step asks.
 */

import crypto from "node:crypto";
import type { CopilotClient, ProviderConfig } from "@github/copilot-sdk";
import { REVIEW_SYSTEM, STEP_CHECK_SYSTEM, parseReview, parseStepCheck, reviewPrompt, stepCheckPrompt, type CommandReviewer, type StepChecker } from "../commands/review";
import type { Logger } from "../logger";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";

/** How long a review may take before the command or the step asks instead (ms). */
export const REVIEW_MS = 20_000;

/** What a reviewer runs on: the client, the model (null: the runtime's default) and where its session's files go. */
export interface ReviewerOptions { client: CopilotClient; model: string | null; provider?: ProviderConfig; workDir: string; log: Logger }

/**
 * One question to a session of its own: `system` alone as its instructions, no tools (checked, fail closed), `prompt`
 * (built once the session is up) sent once, and the answer read by `parse` (null for anything but the answer asked
 * for). Null too when the session can't be made, offers a tool, errs, is stopped (`signal`) or doesn't answer in time.
 * The session is deleted either way.
 */
async function oneReview<T>(o: ReviewerOptions, system: string, prompt: () => string, parse: (text: string | undefined | null) => T | null, signal: AbortSignal, failed: string): Promise<T | null> {
  if (signal.aborted) return null;
  const sessionId = `ember-review-${crypto.randomUUID()}`;
  let made = false;
  try {
    const session = await o.client.createSession(hardenedSessionConfig({
      sessionId, model: o.model ?? undefined, provider: o.provider, tools: [],
      systemMessage: { mode: "replace", content: system },
      workingDirectory: o.workDir,
      onPermissionRequest: () => ({ kind: "reject", feedback: "The reviewer has no tools." }),
    }));
    made = true;
    // No tool at all may be offered (fail closed, as one-shot.ts): this session reads text a page may have shaped.
    await verifySessionTools(session, []);
    if (signal.aborted) return null;
    const abort = () => { void session.abort().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const answer = await session.sendAndWait({ prompt: prompt() }, REVIEW_MS);
      // An answer that came as the task was stopped decides nothing.
      return signal.aborted ? null : parse(answer?.data.content);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  } catch (err) {
    o.log.warn(failed, { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (made) void o.client.deleteSession(sessionId).catch(() => undefined);
  }
}

export function copilotReviewer(o: ReviewerOptions): CommandReviewer {
  return (input, signal) => oneReview(o, REVIEW_SYSTEM, () => reviewPrompt(input), parseReview, signal, "commands.review_failed");
}

/** Assisted's check for one app step (PolicyEngine.assist): the same kind of session, answering with one fixed word. */
export function copilotStepChecker(o: ReviewerOptions): StepChecker {
  return (input, signal) => oneReview(o, STEP_CHECK_SYSTEM, () => stepCheckPrompt(input), parseStepCheck, signal, "policy.check_failed");
}
