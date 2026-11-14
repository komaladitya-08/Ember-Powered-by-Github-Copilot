/**
 * Waiting for a window to be the one under a point before a real-runner suite presses there (cifix-2). ember-win32
 * read the window under the middle of the Ask box's field once, 150 ms after the pointer got there; on CI it was some
 * other window that time, and the failure gave only its number. Windows above the box come and go by themselves there
 * (Ember's overlay takes the top back every 2 s and takes the pointer wherever its bubble has something to click; its
 * hello comes up a moment after start), so the suite waits, within a limit, for the window it needs, and says in its
 * output what was over the point meanwhile. It never passes without the wanted window there, and it does not wait out
 * one of Ember's own windows that stays over the point (cifix-x9-1): a press there would go to Ember's bubble or handle
 * instead of where the user meant it, which is a failure of the product and not of the suite's timing. Pure: the suite
 * passes in how a point is read, the clock and the sleep.
 */

/** A top-level window as the window system names it. */
export interface WindowAt { id: number; className: string; title: string; pid: number }

/** Another window seen at the point, and when (ms from the first read). */
export interface OtherWindow { window: WindowAt; name: string; firstMs: number; lastMs: number }

export interface WindowAtResult {
  /** The wanted window was under the point at the last read. */
  reached: boolean;
  /** One of Ember's own windows stayed over the point for `ownLimitMs`: given up at once, whatever the limit. */
  ownOver: boolean;
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
 * "Ember's overlay"); `what` names the point. `own` (required, so that every suite decides it) says whether a window is one of Ember's own other than the wanted
 * one: such a window is waited out only for `ownLimitMs` (default 2000, one period of the overlay taking the top back)
 * in one stretch, then the wait gives up; another program's window, or none, is waited out for the whole limit.
 */
export async function waitForWindowAt(o: {
  what: string; want: number; limitMs: number; everyMs?: number;
  own: (w: WindowAt) => boolean; ownLimitMs?: number;
  read: () => WindowAt | null; name: (w: WindowAt) => string; now: () => number; sleep: (ms: number) => Promise<unknown>;
}): Promise<WindowAtResult> {
  const started = o.now();
  const others: OtherWindow[] = [];
  const told = () => others.map(x => (x.window.id === 0 ? `no window at all (from ${x.firstMs} to ${x.lastMs} ms)`
    : `${x.name} (window ${x.window.id}, class ${x.window.className}, title ${JSON.stringify(x.window.title)}, pid ${x.window.pid}, seen from ${x.firstMs} to ${x.lastMs} ms)`)).join(", ");
  /** When the stretch of Ember's own windows over the point began; null while the last read was not one. */
  let ownSince: number | null = null;
  for (;;) {
    const ms = o.now() - started;
    const w = o.read() ?? NONE;
    if (w.id === o.want && w.id !== 0) {
      return { reached: true, ownOver: false, waitedMs: ms, others, line: others.length ? `${o.what}: the window under the pointer after ${ms} ms; until then ${told()}` : `${o.what}: the window under the pointer at once` };
    }
    const seen = others.find(x => x.window.id === w.id);
    if (seen) seen.lastMs = ms; else others.push({ window: w, name: w.id === 0 ? "no window" : o.name(w), firstMs: ms, lastMs: ms });
    ownSince = w.id !== 0 && o.own(w) ? ownSince ?? ms : null;
    if (ownSince !== null && ms - ownSince >= (o.ownLimitMs ?? 2_000)) {
      return { reached: false, ownOver: true, waitedMs: ms, others, line: `${o.what}: under Ember's own window for ${ms - ownSince} ms, where a press would go to it instead; ${told()}` };
    }
    if (ms >= o.limitMs) return { reached: false, ownOver: false, waitedMs: ms, others, line: `${o.what}: never the window under the pointer in ${o.limitMs} ms; ${told()}` };
    await o.sleep(o.everyMs ?? 50);
  }
}

/** One moment the suite watched while the Ask box was up: the foreground changing, an Ember window's event, a log line. */
export interface TrailEvent { t: number; what: string }

/**
 * What had the keyboard and what Ember's windows did, as one line for a failure (cifix-x9-2): CI found the Ask box
 * shown, then gone by the right-click, with only the window left under the point to go on. The events in time order
 * (a tie keeps the order they were recorded in), each in ms from `t0` (the chord); past `max`, the earliest are left
 * out and counted, since the end is where the box went.
 */
export function focusTrail(what: string, t0: number, events: readonly TrailEvent[], max = 40): string {
  if (!events.length) return `${what}: nothing recorded`;
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(x => x.e);
  const kept = sorted.slice(-max);
  const cut = sorted.length - kept.length;
  return `${what}: ${cut ? `(${cut} earlier left out) ` : ""}${kept.map(e => `${e.t - t0} ms ${e.what}`).join("; ")}`;
}

/**
 * Whether Windows activates the window under the pointer (“Activate a window by hovering over it”), from what
 * `reg query "HKCU\\Control Panel\\Desktop"` printed for UserPreferencesMask (its first byte's bit 0) and
 * ActiveWndTrkTimeout: with it on, a pointer moved over another window takes the keyboard from the Ask box by itself
 * (cifix-x9-3). One phrase for a failure line; what can't be read is said as unknown.
 */
export function hoverActivation(maskQuery: string, timeoutQuery: string): string {
  const mask = /UserPreferencesMask\s+REG_BINARY\s+([0-9A-Fa-f]{2,})/.exec(maskQuery)?.[1];
  const timeout = /ActiveWndTrkTimeout\s+REG_DWORD\s+0x([0-9A-Fa-f]+)/.exec(timeoutQuery)?.[1];
  const on = mask ? (parseInt(mask.slice(0, 2), 16) & 1) === 1 : null;
  return `activate on hover: ${on === null ? "unknown" : on ? "on" : "off"} (UserPreferencesMask ${mask ?? "unreadable"}, ActiveWndTrkTimeout ${timeout ? `${parseInt(timeout, 16)} ms` : "unset"})`;
}

/** A window as the foreground watcher names it (test/fixtures/win_foreground_watch.ps1). */
export interface WatchedWindow { root: number; className: string; title: string; pid: number; image: string }

const WATCH_EVENTS = new Set(["foreground", "focus", "minimize-start", "minimize-end", "process"]);

/** The names of the WinEvents an app's own windows raise that bear on the keyboard (winuser.h). */
const WIN_EVENT_NAMES: Record<string, string> = {
  "0x0003": "foreground", "0x0004": "menu start", "0x0005": "menu end", "0x0006": "popup menu start", "0x0007": "popup menu end",
  "0x0008": "capture start", "0x0009": "capture end", "0x0016": "minimise start", "0x0017": "minimise end",
  "0x8000": "object created", "0x8001": "object destroyed", "0x8002": "object shown", "0x8003": "object hidden",
  "0x8004": "object reordered", "0x8005": "focus", "0x8006": "selection", "0x8007": "selection added",
  "0x8008": "selection removed", "0x8009": "selection within",
};

/**
 * One line of the foreground watcher as a timeline event (cifix-x9-6): what Windows says changed (or, for "process",
 * what the watched app's own windows raised: cifix-x9-8), the window by
 * `name` (the suite's words for the bench and Ember's windows), and whether the Windows and Alt keys were down then.
 * Null for its ready line, a line still being written, or anything else that isn't one of its events.
 */
export function watchEvent(line: string, name: (w: WatchedWindow) => string): TrailEvent | null {
  let e: Record<string, unknown>;
  try { e = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!e || typeof e !== "object" || typeof e.t !== "number" || typeof e.event !== "string" || !WATCH_EVENTS.has(e.event)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const w: WatchedWindow = { root: num(e.root), className: str(e.class), title: str(e.title), pid: num(e.pid), image: str(e.image) };
  const keys = `Win ${e.win === true ? "down" : "up"}, Alt ${e.alt === true ? "down" : "up"}`;
  if (e.event === "process") {
    const code = typeof e.code === "string" && /^0x[0-9a-f]{4,8}$/.test(e.code) ? e.code : "?";
    return { t: e.t, what: `its own event ${WIN_EVENT_NAMES[code] ?? code} (object ${num(e.object)}, child ${num(e.child)}) in ${name(w)} (window ${w.root}); ${keys}` };
  }
  return { t: e.t, what: `Windows says ${e.event}: ${name(w)} (window ${w.root}); ${keys}` };
}

/** What the read probe notes of one opening (cifix-x9-9), each at its time. */
export interface ProbeMark { t: number; kind: "box shown" | "box hidden" | "read started" | "read answered" | "bench foreground" | "box foreground" }

/**
 * The read probe's summary of one opening (cifix-x9-9): when the box showed, when Ember's read of the bench started and
 * answered (by the plan's word for a read that never runs), and each time the bench took the foreground after the box
 * showed, in ms from the box showing and from the read's start; and whether the box was still open at the end.
 * `chord`: when the suite pressed the chord. Plain words only: the probe prints it and never fails on it.
 */
export function readProbeSummary(plan: string, chord: number, marks: readonly ProbeMark[]): string {
  const at = (k: ProbeMark["kind"]) => marks.filter(m => m.kind === k).map(m => m.t).sort((a, b) => a - b);
  const shown = at("box shown")[0];
  if (shown === undefined) return `read probe (${plan}): the box never showed`;
  const started = plan === "off" ? undefined : at("read started").find(t => t >= shown - 50) ?? (plan === "now" ? shown : undefined);
  const answered = at("read answered").find(t => t > shown);
  const returns = at("bench foreground").filter(t => t > shown);
  const hidden = at("box hidden").find(t => t > shown);
  const ms = (t: number | undefined) => (t === undefined ? "never" : `${t - chord} ms`);
  const read = plan === "off" ? "the read was off" : `the read started at ${ms(started)} and answered at ${ms(answered)}`;
  const back = returns.length
    ? returns.map(t => `${t - shown} ms after the box showed${started !== undefined ? `, ${t - started} ms after the read started` : ""}${answered !== undefined ? `, ${t - answered} ms after it answered` : ""}`).join("; ")
    : "never";
  return `read probe (${plan}): the box showed at ${ms(shown)}; ${read}; the bench took the foreground: ${back}; the box ${hidden === undefined ? "was still open at the end" : `closed at ${ms(hidden)}`} (ms from the chord)`;
}
