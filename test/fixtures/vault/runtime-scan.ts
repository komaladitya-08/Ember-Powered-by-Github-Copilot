/** Runtime event identifiers are random UUIDs, not payload text. Never exempt UUID-looking user or tool content. */
import { canariesIn } from "./leaky";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identities: Record<string, readonly string[]> = {
  "session.start": [], "session.shutdown": [], "session.usage_record": [],
  "user.message": ["messageId", "interactionId", "parentAgentTaskId"],
  "system.message": ["interactionId"],
  "assistant.message": ["messageId", "originatingMessageId", "interactionId"],
  "assistant.turn_start": ["interactionId"], "assistant.turn_end": [],
  "tool.execution_start": ["interactionId"], "tool.execution_complete": ["interactionId"],
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Only the pinned SDK's known event envelope/identity fields are excluded; unknown formats stay fully scanned. */
export function runtimeEventPayloads(text: string): string {
  return text.split("\n").map(line => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return line; }
    if (!object(event) || typeof event.type !== "string" || !Object.hasOwn(identities, event.type) ||
        !object(event.data) || typeof event.id !== "string" || !uuid.test(event.id) ||
        typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)) ||
        (event.parentId !== null && (typeof event.parentId !== "string" || !uuid.test(event.parentId))) ||
        Object.keys(event).some(key => !["type", "data", "id", "timestamp", "parentId"].includes(key))) return line;
    delete event.id;
    delete event.parentId;
    for (const key of identities[event.type]) if (typeof event.data[key] === "string" && uuid.test(event.data[key])) delete event.data[key];
    return JSON.stringify(event);
  }).join("\n");
}

/** Every other file remains a raw-text scan, including malformed or non-runtime events.jsonl files. */
export function canariesInRuntimeFile(file: string, text: string): string[] {
  const runtimeEvents = /^copilot[\\/]session-state[\\/][^\\/]+[\\/]events\.jsonl$/.test(file);
  return canariesIn(runtimeEvents ? runtimeEventPayloads(text) : text);
}
