/**
 * The words of the transcript's rarer SDK events (docs/CODING-APP.md §8 "SDK coverage"): a handoff, a context
 * truncation, a finished task, schedules, workflows, pictures, cited sources, a model call tried again, and the action
 * each remediation names. Pure, sentence case, British spelling; never the SDK's own text for what failed (its words
 * are shown only where they are the session's content: a summary, a schedule's prompt). Pinned in
 * test/unit/code-transcript-events.test.ts.
 */

type Fields = Readonly<Record<string, string | number | boolean | undefined>>;
const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-GB") : "");

/** The note of an event transcript.ts draws as one (copy.ts `noteWords` passes the kinds it doesn't know here). */
export function eventNoteWords(note: string, f: Fields): string {
  switch (note) {
    case "handoff": {
      const from = f.source === "cloud" ? "a cloud session" : f.source === "remote" ? "a remote session" : "another session";
      return `Continued from ${from}${f.repository ? ` of ${f.repository}` : ""}.${f.summary ? ` ${f.summary}` : ""}`;
    }
    case "truncation":
      return typeof f.messages === "number" && f.messages > 0
        ? `To make room, Copilot no longer sends the model the ${n(f.messages)} earliest messages. They stay here.`
        : "To make room, Copilot sends the model less of the earlier conversation. It stays here.";
    case "cleared": return typeof f.messages === "number" ? `Copilot cleared its context (${n(f.messages)} messages) and started afresh.` : "Copilot cleared its context and started afresh.";
    case "task":
      if (f.outcome === "blocked") return `Copilot couldn't finish the task${f.reason ? `: ${f.reason}` : "."}`;
      if (f.outcome === "continue") return "Copilot has more to do on the task.";
      return `Copilot finished the task.${f.summary ? ` ${f.summary}` : ""}`;
    case "tool-search": return typeof f.count === "number" && f.count > 0 ? `Copilot looked up ${n(f.count)} more tools it can use.` : "Copilot looked up more tools it can use.";
    case "tier": return "Copilot couldn't change how it picks a model. It keeps the one it had.";
    case "schedule":
      if (f.op === "cancelled") return "A scheduled message was cancelled.";
      return f.prompt ? `Copilot scheduled a message${f.recurring ? " to repeat" : ""}: “${f.prompt}”` : `Copilot scheduled a message${f.recurring ? " to repeat" : ""}.`;
    case "limits": return typeof f.max === "number" ? `This session may now use up to ${n(f.max)} AI credits.` : "This session's credit limit was removed.";
    case "recovery": return f.status === "succeeded" || f.status === "recovered" ? "Copilot found another way after a refusal." : "Copilot is looking for another way after a refusal.";
    case "reconnect": return `The MCP server “${f.server ?? "server"}” needs to start again. Start it in Customise › MCP servers.`;
    case "deselected": return f.from ? `The model ${f.from} isn't available any more. Choose another.` : "That model isn't available any more. Choose another.";
    case "workflow": {
      const name = f.name ? `“${f.name}”` : "A workflow";
      if (f.state === "running") return f.name ? `Running the workflow ${name}…` : "Running a workflow…";
      if (f.state === "failed" || f.state === "errored") return `The workflow ${f.name ? `${name} ` : ""}didn't finish.`;
      if (f.state === "cancelled") return `The workflow ${f.name ? `${name} ` : ""}was cancelled.`;
      return `The workflow ${f.name ? `${name} ` : ""}finished.`;
    }
    case "asset": return f.image ? "Copilot made a picture that can't be shown here." : `Copilot attached a file${f.description ? `: ${f.description}` : "."}`;
    default: return "";
  }
}

/** What the button under a problem does, by the SDK's remediation; null where the window can't do it. */
export type RemedyAction = "sign-in" | "sandbox" | "rewind";
export function remedyAction(remediation: string | undefined): RemedyAction | null {
  switch (remediation) {
    case "sign_in": case "switch_account": case "show_account": return "sign-in";
    case "review_sandbox_policy": case "allow_sandbox_outbound": return "sandbox";
    case "rewind_conversation": return "rewind";
    default: return null;
  }
}
export function remedyButton(a: RemedyAction): string {
  switch (a) {
    case "sign-in": return "Open sign-in…";
    case "sandbox": return "Show the sandbox";
    case "rewind": return "Show rewind points";
  }
}

/** A tool's or the session's pictures. */
export function pictureLabel(description: string | undefined, n: number, of: number): string {
  return description ? description : of > 1 ? `Picture ${n} of ${of}` : "Picture";
}
export function picturesWithheld(count: number): string {
  return count === 1 ? "One picture isn't shown: it's too large or not a kind Ember shows." : `${count} pictures aren't shown: they're too large or not a kind Ember shows.`;
}

/** A reply's cited sources. */
export const SOURCES = "Sources";
export function sourcesSummary(count: number): string { return count === 1 ? "1 source" : `${count} sources`; }

/** A model call the runtime tries again. */
export function retryingLine(attempt: number): string { return attempt > 1 ? `Copilot is trying the model again (try ${attempt})…` : "Copilot is trying the model again…"; }

/** Where the session is, from `session.context_changed`: its branch. */
export function branchWords(branch: string): string { return `on ${branch}`; }
