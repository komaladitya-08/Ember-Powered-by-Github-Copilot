import type { SessionEvent } from "@github/copilot-sdk";

/**
 * Records an explicit coding result for a mixed task. An idle event and free-form answer are not a completion.
 * The model's claim is still a claim, not proof that tests or changes were correct. Refuse a handoff if a tool
 * failed, any tool is still in flight, the finish call shared a reply with another call, or work continued after it.
 */
export class CodingCompletion {
  private requests: readonly string[] = [];
  private readonly pending = new Map<string, string>();
  private readonly terminal = new Set<string>();
  private failed = false;
  private proposal: { success: boolean; summary: string } | null = null;

  /** A refused or unobservable operation cannot authorize a follow-up on its own. */
  deny(): void { this.failed = true; }

  event(event: SessionEvent): void {
    // Subagents are not correlated to the parent tool lifecycle here. Do not authorize a handoff on partial evidence.
    if (event.agentId) {
      if (event.type === "tool.execution_start" || event.type === "tool.execution_complete" || event.type === "subagent.started" ||
          event.type === "subagent.failed" || event.type === "model.call_failure" || event.type === "session.error") this.failed = true;
      return;
    }
    if (event.type === "assistant.message") {
      this.requests = (event.data.toolRequests ?? []).map(r => r.toolCallId);
    } else if (event.type === "tool.execution_start") {
      const { toolCallId, toolName } = event.data;
      const name = toolName.replace(/^(?:builtin:|custom:)/, "");
      if (name !== "finish_coding" && name !== "task_complete") {
        if (this.proposal) this.failed = true;
        this.pending.set(toolCallId, name);
      } else this.terminal.add(toolCallId);
    } else if (event.type === "tool.execution_complete") {
      const { toolCallId, success, shellExecution, result } = event.data;
      if (this.terminal.delete(toolCallId)) { if (!success) this.failed = true; return; }
      const name = this.pending.get(toolCallId);
      if (!name) { this.failed = true; return; }
      this.pending.delete(toolCallId);
      if (!success) this.failed = true;
      if (name === "bash" || name === "powershell") {
        const exit = shellExecution?.exitCode ?? result?.contents?.find(c => c.type === "shell_exit")?.exitCode;
        if (exit !== 0) this.failed = true;
      }
    } else if (event.type === "session.error" || event.type === "model.call_failure" || event.type === "subagent.started" || event.type === "subagent.failed") {
      this.failed = true;
    }
  }

  /** The tool call must be alone in the model's reply and identify that exact request. */
  finish(callId: string | undefined, success: unknown, summary: unknown): boolean {
    if (!callId || !this.terminal.has(callId) || this.requests.length !== 1 || this.requests[0] !== callId || this.pending.size || this.proposal ||
        typeof success !== "boolean" || typeof summary !== "string" || !summary.trim() || summary.length > 2000) return false;
    this.proposal = { success, summary: summary.trim() };
    return true;
  }

  result(): { success: boolean; summary: string } | null {
    if (!this.proposal) return null;
    return { ...this.proposal, success: this.proposal.success && !this.failed && this.pending.size === 0 && this.terminal.size === 0 };
  }
}
