/**
 * Why Home's composer can't send a message now, in words built from the connection's state (pure, so it is unit-tested:
 * ui-copy.test.ts). A send while Ember is still starting, offline or reconnecting by itself was told to "Connect Ember in
 * Models & connections", where nothing could help (reliability-performance-v2): Ember now says what is going on, as the
 * Ask box does (host.ts noticeTitle, stillConnectingTitle), names the model service in use, and says the message is
 * still there (Home keeps the draft when a send is refused). Without Ember's name, as the composer's other lines: a screen
 * reader says it into the wake word's microphone (voice-listening-r5-1). A policy's problem is LOCKDOWN, which listens to
 * nothing.
 */
import type { AgentStatus } from "./host";
import { onThisComputer } from "../../shared/provider";

/**
 * The refusal for a status whose phase isn't "ready". `detail`: the status' own words; one that ends "Reconnecting…"
 * (host.ts lost, after the runtime stopped) means Ember is reconnecting by itself, whatever the reason. `waiting`: the
 * host whose note the user's own provider waits for (provider.ts providerWaitingHost), while signed out: agreeing to it
 * is the way on, as the tagline, the hint and the start hello say (integrations-r4-3).
 */
export function composerRefusal(s: Pick<AgentStatus, "phase" | "reason" | "waitingForTasks" | "service"> & { detail?: string }, waiting: string | null = null): string {
  const it = s.service?.kind === "user" ? "your model provider" : s.service ? "the model service" : "Copilot";
  const It = it[0].toUpperCase() + it.slice(1);
  if (s.phase === "starting") return `Still connecting to ${it}. Your message is still here: send it again in a moment.`;
  if (s.phase === "signed-out" && waiting) return `Agree to use ${waiting} in Models & connections, then send again.`;
  if (s.phase !== "error") return `Connect ${it} in Models & connections, then send again.`;
  // (Reconnecting now would stop the tasks at work: it waits for them, as Home's tagline says.)
  if (s.waitingForTasks) return `${It} isn't answering: reconnecting once the tasks that are running finish. Your message is still here.`;
  // Copilot stopped and Ember starts it again by itself (reliability-performance-v2); "keeps stopping" waits for Check again.
  if (s.reason === "runtime" && s.detail?.endsWith("Reconnecting…")) return `Reconnecting to ${it}. Your message is still here: send it again in a moment.`;
  switch (s.reason) {
    case "network":
      // The user's own model server on this computer (Ollama, LM Studio) is most likely not running, not offline (integrations-r2-2).
      if (s.service?.kind === "user" && onThisComputer(s.service.host)) return "The model server on this computer can't be reached. Is it running? Your message is still here: send it again once it is.";
      return `${It} can't be reached right now. Your message is still here: send it again once you're online.`;
    case "not-answering": return `Reconnecting to ${it}. Your message is still here: send it again in a moment.`;
    case "policy": return "Your organisation's Ember policy has a problem, so Ember can't answer until it's fixed.";
    default: return `Can't connect to ${it} yet: Models & connections says why. Your message is still here.`;
  }
}

/**
 * Why Home's composer can't send now, or null when the message goes. `stops`: it is a typed "stop" that stops everything
 * at once (AgentHost.stopsWith), which goes whatever the connection is doing, as the Ask box's and voice's do (home-c2-1:
 * waiting for the running tasks before it reconnects, Home refused the very stop that would end them).
 */
export function composerSendRefusal(s: Pick<AgentStatus, "phase" | "reason" | "waitingForTasks" | "service"> & { detail?: string }, stops: boolean, waiting: string | null = null): string | null {
  return stops || s.phase === "ready" ? null : composerRefusal(s, waiting);
}
