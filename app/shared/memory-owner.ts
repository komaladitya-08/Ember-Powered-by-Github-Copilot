/**
 * What Ember says about saved memory it can't open now, by why (memory-2, integrations-2): Settings › Memory's line,
 * and Ember's own reply in the conversation when memory is on but paused. Shared by Home (copy.ts re-exports it) and
 * main (memory/learning.ts), so both say the same. Only memory that really isn't this account's (`other-account`,
 * `unowned`), is left on the computer after signing out, or is out of reach under the organisation's lockdown is
 * offered Forget everything: every other reason passes on its own, and erasing then would lose the user's own memory.
 */

import type { MemoryOwnerReason } from "../main/memory/owner";

/** Settings › Memory's line while memory isn't open. `saved`: memory is saved on this computer (the owner is "locked"). */
export function memoryOwnerText(reason: MemoryOwnerReason | null | undefined, saved: boolean): string {
  switch (reason) {
    case "checking": return "Checking your GitHub account…";
    case "own-provider": return "Memory works only with GitHub Copilot, so it's paused while Ember uses your own model provider. What Ember remembers stays on this computer. Turn off “Use my own model provider” in Models & connections to use it again.";
    case "org-provider": return "Memory works only with GitHub Copilot, so it's paused while Ember uses your organisation's model service. What Ember remembers stays on this computer.";
    case "unverified": return "Ember couldn't check your GitHub account, so memory is paused. It comes back when Ember reconnects.";
    // The organisation's policy can't be used, or changed while Ember ran: nothing connects, so no account is checked.
    // Never "it comes back when Ember reconnects" (memory-r9-3).
    case "lockdown": return saved
      ? "Your organisation's policy has stopped Ember for now, so it can't check whose saved memory this is. It stays hidden on this computer, and Forget everything clears it."
      : "Your organisation's policy has stopped Ember for now, so memory is off.";
    case "other-account": return "This saved memory belongs to another GitHub account, so Ember keeps it hidden. Use Forget everything to clear it.";
    case "unowned": return "Ember can't tell which GitHub account this saved memory belongs to, so it stays hidden. Use Forget everything to clear it.";
    default:
      // Signed out, or an older main that names no reason: what Ember said before, for memory left behind too.
      if (reason === undefined && saved) return memoryOwnerText("unowned", true);
      return saved ? "Sign in with GitHub to use saved memory. Until then it stays hidden on this computer, and Forget everything clears it." : "Sign in with GitHub to use saved memory.";
  }
}

/**
 * Whether Settings › Memory offers Forget everything for memory it can't open: never for memory that only waits. Under
 * a lockdown it may wait until an administrator mends the policy, so what is saved can be cleared (memory-r9-3).
 */
export function memoryOwnerOffersErase(reason: MemoryOwnerReason | null | undefined, saved: boolean): boolean {
  return saved && (reason === undefined || reason === "signed-out" || reason === "lockdown" || reason === "other-account" || reason === "unowned");
}

/** Ember's reply when asked to remember or get to know the user while memory is on but paused; `open`: show Memory. */
export function memoryPausedReply(reason: MemoryOwnerReason): { text: string; open: boolean } {
  switch (reason) {
    case "checking": return { text: "I'm still checking your GitHub account, so memory isn't ready yet. Ask me again in a moment.", open: false };
    case "own-provider": return { text: "Memory works only with GitHub Copilot, so it's paused while I use your own model provider, and I can't keep what you tell me.", open: false };
    case "org-provider": return { text: "Memory works only with GitHub Copilot, so it's paused while I use your organisation's model service, and I can't keep what you tell me.", open: false };
    case "unverified": return { text: "I couldn't check your GitHub account, so memory is paused. It comes back when I reconnect.", open: false };
    case "signed-out": return { text: "Memory needs you signed in with GitHub, so I can't keep what you tell me yet.", open: false };
    case "lockdown": return { text: "Your organisation's policy has stopped me for now, so memory is off and I can't keep what you tell me.", open: false };
    case "other-account":
    case "unowned":
      return { text: "The memory saved on this computer isn't matched to your GitHub account, so memory is paused. I've opened Memory in Settings.", open: true };
  }
}
