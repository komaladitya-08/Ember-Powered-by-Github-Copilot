/**
 * The quick context when Ember is set to work on another computer (§2.8): the remote's own focused window, read through
 * its agent within the same 3 s cap as this screen's, and marked with the target it was read on, so a task starts in
 * that window only on that computer (G14). While a remote is the picker's choice, this screen's focused window (usually
 * the terminal the user reached it from) is never the context (G17): an unconnected or headless remote gives a context
 * with no window. Pure apart from the timer it races.
 */

import type { TargetId } from "../../shared/targets";
import type { QuickContext } from "../perception";
import type { PerceptionPort } from "../perception/ports";
import type { DesktopAccess } from "./types";

/** How long the remote's context may take before the request goes on without a window (main's cap). */
export const QUICK_CONTEXT_MS = 3000;

/** A context with no window, saying in Ember's own words why (it carries the target, so no local window can stand in). */
export function noWindowContext(id: TargetId, label: string, why: string): QuickContext {
  return { target: {}, text: `${label}: ${why}`, targetId: id };
}

/** What the remote's quick context is built from. */
export interface RemoteContextInput {
  id: TargetId;
  label: string;
  /** The link is up (ready); otherwise there is nothing to read. */
  connected: boolean;
  desktop: DesktopAccess;
  perception: PerceptionPort | null;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** The remote's quick context (never rejects; never this screen's). */
export function remoteQuickContext(i: RemoteContextInput): Promise<QuickContext> {
  if (!i.connected || !i.perception) return Promise.resolve(noWindowContext(i.id, i.label, "not connected now."));
  if (i.desktop === "none") return Promise.resolve(noWindowContext(i.id, i.label, "no desktop Ember can see; commands only."));
  const set = i.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = i.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const slow = noWindowContext(i.id, i.label, "its screen didn't answer in time.");
  return new Promise<QuickContext>(resolve => {
    let done = false;
    const finish = (c: QuickContext) => { if (!done) { done = true; clear(timer); resolve(c); } };
    const timer = set(() => finish(slow), i.timeoutMs ?? QUICK_CONTEXT_MS);
    let read: Promise<QuickContext | null>;
    try { read = i.perception!.quickContext(); } catch (err) { read = Promise.reject(err); }
    read.then(
      c => finish(c ? { ...c, targetId: i.id } : noWindowContext(i.id, i.label, "no window in front.")),
      () => finish(noWindowContext(i.id, i.label, "its screen couldn't be read.")),
    );
  });
}
