/**
 * Why Home's composer can't send a message now, in words built from the connection's state (pure, so it is unit-tested:
 * ui-copy.test.ts). A send while Ember is still starting, offline or reconnecting by itself was told to "Connect Ember in
 * Models & connections", where nothing could help (reliability-performance-v2): Ember now says what is going on, as the
 * Ask box does (host.ts noticeTitle, stillConnectingTitle), names the model service in use, and says the message is
 * still there (Home keeps the draft when a send is refused).
 */
import type { AgentStatus } from "./host";
import { onThisComputer } from "../../shared/provider";

/**
 * The refusal for a status whose phase isn't "ready". `detail`: the status' own words; one that ends "Reconnecting…"
 * (host.ts lost, after the runtime stopped) means Ember is reconnecting by itself, whatever the reason.
 */
export function composerRefusal(s: Pick<AgentStatus, "phase" | "reason" | "waitingForTasks" | "service"> & { detail?: string }): string {
  const it = s.service?.kind === "user" ? "your model provider" : s.service ? "the model service" : "Copilot";
  const It = it[0].toUpperCase() + it.slice(1);
  if (s.phase === "starting") return `Ember is still connecting to ${it}. Your message is still here: send it again in a moment.`;
  if (s.phase !== "error") return "Connect Ember in Models & connections, then send again.";
  // (Reconnecting now would stop the tasks at work: it waits for them, as Home's tagline says.)
  if (s.waitingForTasks) return `${It} isn't answering: Ember reconnects once the tasks that are running finish. Your message is still here.`;
  // Copilot stopped and Ember starts it again by itself (reliability-performance-v2); "keeps stopping" waits for Check again.
  if (s.reason === "runtime" && s.detail?.endsWith("Reconnecting…")) return `Ember is reconnecting to ${it}. Your message is still here: send it again in a moment.`;
  switch (s.reason) {
    case "network":
      // The user's own model server on this computer (Ollama, LM Studio) is most likely not running, not offline (integrations-r2-2).
      if (s.service?.kind === "user" && onThisComputer(s.service.host)) return "Ember can't reach the model server on this computer. Is it running? Your message is still here: send it again once it is.";
      return `Ember can't reach ${it} right now. Your message is still here: send it again once you're online.`;
    case "not-answering": return `Ember is reconnecting to ${it}. Your message is still here: send it again in a moment.`;
    case "policy": return "Your organisation's Ember policy has a problem, so Ember can't answer until it's fixed.";
    default: return `Ember can't connect to ${it} yet: Models & connections says why. Your message is still here.`;
  }
}
