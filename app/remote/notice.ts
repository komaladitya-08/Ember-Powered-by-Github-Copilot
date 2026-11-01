/**
 * The visible notice on a remote's screen (§5.3.9): sidecar/notice/ember_notice.py, run with the remote's own Python
 * in the desktop session, as a window titled "Ember" with Stop (on X11 or Xwayland) or a resident notification with a
 * Stop action (Wayland without Xwayland). It also asks the console's consent where the administrator requires it. If
 * it can't be shown, or is dismissed, the desktop is not used: nobody there could see that Ember is. Its stdin is a
 * pipe from the desktop child, so it closes when the child goes. Plain Node; spawn comes in as a parameter.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import readline from "node:readline";
import { z } from "zod";
import type { Logger } from "../main/logger";

/** What the notice says (§5.3.9's words, sentence case; `pc` is the PC's name as it reported it). */
export function noticeText(pc: string): { using: string; asking: string; paused: string } {
  const who = `Ember on ${pc || "another computer"}`;
  return {
    using: `${who} is using this screen.`,
    asking: `${who} wants to use this screen.`,
    paused: `${who} lost its connection and isn't using this screen now.`,
  };
}

const EventSchema = z.union([
  z.object({ ev: z.literal("shown"), form: z.enum(["window", "notification"]) }).strict(),
  z.object({ ev: z.literal("failed"), why: z.string().max(100) }).strict(),
  z.object({ ev: z.literal("stop") }).strict(),
  z.object({ ev: z.literal("answer"), allow: z.boolean() }).strict(),
]);

/** How long the notice gets to come up, and the console's answer to be given (§5.3.9: two minutes). */
export const SHOW_MS = 10_000;
export const ASK_MS = 120_000;

/** A running notice. */
export interface Notice {
  /** Shows "… is using this screen." with Stop; true once it is on screen, false when it can't be shown. */
  show(text: string): Promise<boolean>;
  /** Asks the console; true only for Allow within `ms` (Don't allow, a timeout or a failure: false). */
  ask(text: string, ms?: number): Promise<boolean>;
  /** Shows that Ember stopped using the screen for now (no Stop). */
  paused(text: string): void;
  /** Someone at the screen pressed Stop. */
  onStop(fn: () => void): void;
  /** The notice went away (failed, dismissed, or its process ended) while it was meant to show. */
  onGone(fn: (why: string) => void): void;
  close(): void;
}

/** Starts the notice: `--notification` form when the session has no X display to put a window on. */
export function startNotice(o: {
  python: string; script: string; env: NodeJS.ProcessEnv; notification: boolean; log: Logger;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}): Notice {
  const args = ["-B", o.script, ...(o.notification ? ["--notification"] : [])];
  const child = o.spawn(o.python, args, { stdio: ["pipe", "pipe", "pipe"], env: o.env });
  let waiting: ((ev: z.infer<typeof EventSchema> | { ev: "gone" }) => void) | null = null;
  const stops: (() => void)[] = [];
  const gones: ((why: string) => void)[] = [];
  let closed = false;
  let gone = false;
  const lost = (why: string) => {
    if (gone || closed) return;
    gone = true;
    waiting?.({ ev: "gone" });
    for (const fn of gones) fn(why);
  };
  child.on("error", err => { o.log.warn("remote.notice_failed", { err }); lost("it couldn't start"); });
  child.on("exit", () => lost("it closed"));
  child.stdin?.on("error", () => lost("it closed"));
  if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", l => o.log.debug("remote.notice_stderr", { line: l.slice(0, 200) }));
  if (child.stdout) {
    readline.createInterface({ input: child.stdout }).on("line", line => {
      let ev: z.infer<typeof EventSchema>;
      try {
        ev = EventSchema.parse(JSON.parse(line));
      } catch {
        o.log.warn("remote.notice_bad_line", {});
        return;
      }
      if (ev.ev === "stop") { for (const fn of stops) fn(); return; }
      if (ev.ev === "failed") { o.log.warn("remote.notice_not_shown", { why: ev.why }); waiting?.(ev); lost(ev.why); return; }
      waiting?.(ev);
    });
  }
  const send = (cmd: string, text: string) => {
    if (closed || gone || !child.stdin?.writable) return;
    child.stdin.write(`${JSON.stringify({ cmd, text })}\n`);
  };
  /** Sends `cmd` and waits for the first event `accept` takes (or `ms`). */
  const exchange = <T>(cmd: string, text: string, ms: number, accept: (ev: z.infer<typeof EventSchema>) => T | undefined, fallback: T): Promise<T> =>
    new Promise<T>(resolve => {
      if (gone || closed) { resolve(fallback); return; }
      const timer = setTimeout(() => { waiting = null; resolve(fallback); }, ms);
      waiting = ev => {
        if (ev.ev === "gone") { clearTimeout(timer); waiting = null; resolve(fallback); return; }
        const v = accept(ev);
        if (v === undefined) return;
        clearTimeout(timer);
        waiting = null;
        resolve(v);
      };
      send(cmd, text);
    });
  return {
    show: text => exchange("show", text, SHOW_MS, ev => (ev.ev === "shown" ? true : ev.ev === "failed" ? false : undefined), false),
    ask: (text, ms = ASK_MS) => exchange("ask", text, ms, ev => (ev.ev === "answer" ? ev.allow : ev.ev === "failed" ? false : undefined), false),
    paused: text => send("paused", text),
    onStop: fn => { stops.push(fn); },
    onGone: fn => { gones.push(fn); },
    close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* gone already */ }
      // Its stdin's end stops it; a notice that hangs is ended.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1000).unref();
    },
  };
}
