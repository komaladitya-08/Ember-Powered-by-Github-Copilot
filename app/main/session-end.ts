/**
 * What is saved when the desktop session ends (log-off, shutdown, the display going away). There may be no will-quit
 * then, and no time to wait for anything: the X server can take Ember with it at the next call. So, in this order and
 * synchronously: the agent stops as quitting stops it (an answer being shown is kept as it stands, the conversation's
 * save queued), the saved conversation is written at once, and memory stops learning and writes what it keeps. Each
 * part is on its own: one that throws is logged and the rest still save. Plain Node, no Electron (main.ts wires it).
 */

/** The parts endOfSession saves, each null when it never started. */
export interface SessionEndParts {
  /** AgentHost: its stop() keeps the answer under way and queues the save before it returns; the rest is not awaited. */
  agent: { stop(): Promise<void> } | null;
  /** The saved conversation (HistoryStore). */
  history: { flushNow(): void } | null;
  /** Memory that learns on its own (MemoryLearning). */
  learning: { stop(): void } | null;
  /** MemoryService: writes what is pending. */
  memory: { stop(): void } | null;
  log: { info(e: string, f?: object): void; warn(e: string, f?: object): void };
}

/** Stops the agent and writes the conversation and memory before it returns (main's endSession). Never throws. */
export function endOfSession(p: SessionEndParts): void {
  const step = (event: string, f: () => void) => {
    try { f(); } catch (err) { p.log.warn(event, { err: err instanceof Error ? err.message : String(err) }); }
  };
  // Not awaited: the session may end before it settles, and its rejection is only logged.
  step("session_end.agent_not_stopped", () => { p.agent?.stop().catch(err => p.log.warn("session_end.agent_not_stopped", { err: err instanceof Error ? err.message : String(err) })); });
  step("session_end.history_not_saved", () => p.history?.flushNow());
  step("session_end.learning_not_stopped", () => p.learning?.stop());
  step("session_end.memory_not_saved", () => p.memory?.stop());
}
