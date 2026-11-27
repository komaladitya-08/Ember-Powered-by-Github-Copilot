/**
 * What the SDK's list methods return, read for the coding window's pickers and queue strip: client `models.list`
 * (`ModelList`), `agents.discover` or session `agent.list` (`AgentList`), and session `queue.pendingItems`
 * (`QueuePendingItemsResult`). Pure; a shape the window doesn't know reads as nothing, never as an error.
 */
import type { AgentChoice, ModelChoice, QueueEntry } from "./store";
import { arr, rec, str, strs, sub } from "./sdk";

/** The models a person may pick: each with the reasoning efforts it takes (a model the policy turned off is marked). */
export function modelsFrom(result: unknown): ModelChoice[] {
  const list = arr(result, "models").length ? arr(result, "models") : arr(result, "list");
  return list.map(m => {
    const supports = sub(sub(m, "capabilities"), "supports");
    const efforts = strs(m, "supportedReasoningEfforts");
    return {
      id: str(m, "id") ?? "", name: str(m, "name") ?? str(m, "id") ?? "",
      efforts: efforts.length ? efforts : supports?.reasoningEffort === true ? ["low", "medium", "high"] : [],
      ...(str(m, "defaultReasoningEffort") ? { defaultEffort: str(m, "defaultReasoningEffort") } : {}),
      enabled: str(sub(m, "policy"), "state") !== "disabled",
    };
  }).filter(m => m.id);
}

/** Agents a session can start as (only those a person may pick: `userInvocable` isn't false). */
export function agentsFrom(result: unknown): AgentChoice[] {
  const list = Array.isArray(result) ? result : arr(result, "agents");
  return list.filter(a => rec(a)?.userInvocable !== false).map(a => ({
    id: str(a, "id") ?? str(a, "name") ?? "", name: str(a, "displayName") ?? str(a, "name") ?? "",
    ...(str(a, "description") ? { description: str(a, "description") } : {}),
  })).filter(a => a.id);
}

/** The queue as the strip shows it: queued items (removable and editable by id) and the steering messages. */
export function queueFrom(result: unknown): { items: QueueEntry[]; steering: string[] } {
  return {
    items: arr(result, "items").map(i => ({ id: str(i, "id") ?? "", text: str(i, "displayText", true) ?? "", kind: str(i, "kind") ?? "message" })).filter(i => i.id),
    steering: strs(result, "steeringMessages"),
  };
}
