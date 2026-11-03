/** Revokes not-yet-started commands when a target's switch is turned off, without stopping running jobs. */
import type { TargetId } from "../../shared/targets";

interface Pending { target: TargetId; revoke(): void }
const pending = new Set<Pending>();

/** WSL's master switch covers every distro; otherwise only the exact target is revoked. */
export function revokePendingCommands(target: TargetId | "wsl"): void {
  for (const p of pending) if (p.target === target || (target === "wsl" && p.target.startsWith("wsl:"))) p.revoke();
}

export function pendingCommand(target: TargetId, taskSignal: AbortSignal) {
  const controller = new AbortController();
  let waiting = true;
  let revoked = false;
  const entry: Pending = { target, revoke: () => {
    revoked = true;
    if (waiting) controller.abort();
  } };
  pending.add(entry);
  return {
    signal: AbortSignal.any([taskSignal, controller.signal]),
    started: () => { waiting = false; },
    waiting: () => { waiting = true; if (revoked) controller.abort(); },
    dispose: () => { pending.delete(entry); },
  };
}
