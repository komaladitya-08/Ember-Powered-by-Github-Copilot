/**
 * Waiting for a window to be the one under a point before a real-runner suite presses there (cifix-2). ember-win32
 * read the window under the middle of the Ask box's field once, 150 ms after the pointer got there; on CI it was some
 * other window that time, and the failure gave only its number. Windows above the box come and go by themselves there
 * (Ember's overlay takes the top back every 2 s and takes the pointer wherever its bubble has something to click; its
 * hello comes up a moment after start), so the suite waits, within a limit, for the window it needs, and says in its
 * output what was over the point meanwhile. It never passes without the wanted window there. Pure: the suite passes in
 * how a point is read, the clock and the sleep.
 */

/** A top-level window as the window system names it. */
export interface WindowAt { id: number; className: string; title: string; pid: number }

/** Another window seen at the point, and when (ms from the first read). */
export interface OtherWindow { window: WindowAt; name: string; firstMs: number; lastMs: number }

export interface WindowAtResult {
  /** The wanted window was under the point at the last read. */
  reached: boolean;
  /** From the first read to the read that found it (or to giving up). */
  waitedMs: number;
  /** Every other window seen there meanwhile, in the order they first appeared (id 0: no window at all). */
  others: OtherWindow[];
  /** One line for the suite's output, and its failure. */
  line: string;
}

const NONE: WindowAt = { id: 0, className: "", title: "", pid: 0 };

/**
 * Reads the point every `everyMs` (default 50) until the window `want` is under it, for at most `limitMs`. `read`
 * answers the top-level window there now (null: none); `name` says what a window is in the suite's words ("the bench",
 * "Ember's overlay"); `what` names the point.
 */
export async function waitForWindowAt(o: {
  what: string; want: number; limitMs: number; everyMs?: number;
  read: () => WindowAt | null; name: (w: WindowAt) => string; now: () => number; sleep: (ms: number) => Promise<unknown>;
}): Promise<WindowAtResult> {
  const started = o.now();
  const others: OtherWindow[] = [];
  const told = () => others.map(x => (x.window.id === 0 ? `no window at all (from ${x.firstMs} to ${x.lastMs} ms)`
    : `${x.name} (window ${x.window.id}, class ${x.window.className}, title ${JSON.stringify(x.window.title)}, pid ${x.window.pid}, seen from ${x.firstMs} to ${x.lastMs} ms)`)).join(", ");
  for (;;) {
    const ms = o.now() - started;
    const w = o.read() ?? NONE;
    if (w.id === o.want && w.id !== 0) {
      return { reached: true, waitedMs: ms, others, line: others.length ? `${o.what}: the window under the pointer after ${ms} ms; until then ${told()}` : `${o.what}: the window under the pointer at once` };
    }
    const seen = others.find(x => x.window.id === w.id);
    if (seen) seen.lastMs = ms; else others.push({ window: w, name: w.id === 0 ? "no window" : o.name(w), firstMs: ms, lastMs: ms });
    if (ms >= o.limitMs) return { reached: false, waitedMs: ms, others, line: `${o.what}: never the window under the pointer in ${o.limitMs} ms; ${told()}` };
    await o.sleep(o.everyMs ?? 50);
  }
}
