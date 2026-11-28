/**
 * The Terminal tab's model, as pure functions: a command's output with its ANSI escapes read into plain text runs
 * (colours mapped to the design system's tones, every other escape dropped), the command line's history, bounded
 * scrollback, and the agent's shell commands read from the transcript. No DOM and no IPC: panel-terminal.ts draws it,
 * test/unit/code-terminal.test.ts tests it.
 *
 * The constraint behind it: this is a command runner, not a terminal emulator. Output is text in a page, so a cursor
 * move, a screen clear or a title escape is dropped rather than acted on, and nothing in output can run, link or style
 * anything beyond the few tones below.
 */
import type { ToolItem, Transcript } from "./transcript";

/** The tones output may take: the design system's colours that can be text, and the secondary label. */
export type Tone = "red" | "green" | "yellow" | "blue" | "purple" | "cyan" | "dim";
/** A run of output text in one style. */
export interface Run { text: string; tone?: Tone; bold?: boolean }

const TONES: Readonly<Record<number, Tone>> = { 1: "red", 2: "green", 3: "yellow", 4: "blue", 5: "purple", 6: "cyan", 0: "dim", 7: "dim" };

/** Every escape sequence: CSI (with SGR among them), OSC (to BEL or ST), and the two-byte ones. */
// eslint-disable-next-line no-control-regex -- the escapes are control characters by definition
const ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[PX^_][\s\S]*?\u001b\\|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- other control characters but tab and newline are dropped too
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Output's text with every escape and control character taken out, and carriage returns as a terminal leaves the line. */
export function stripAnsi(text: string): string {
  return overwrite(text.replace(ESCAPE, "")).replace(CONTROL, "");
}

/** A line rewritten with "\r" (a progress bar) shows what was written last, as a terminal would; "\r\n" is a newline. */
function overwrite(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n/g, "\n").split("\n").map(line => {
    const parts = line.split("\r");
    return parts.length > 1 ? parts.filter(Boolean).pop() ?? "" : line;
  }).join("\n");
}

/** Output read into runs: SGR colours and bold kept as tones, every other escape dropped. */
export function ansiRuns(text: string): Run[] {
  const runs: Run[] = [];
  let tone: Tone | undefined;
  let bold = false;
  const push = (t: string) => {
    const clean = t.replace(CONTROL, "");
    if (!clean) return;
    const last = runs[runs.length - 1];
    if (last && last.tone === tone && !!last.bold === bold) last.text += clean;
    else runs.push({ text: clean, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}) });
  };
  const src = overwrite(text);
  let at = 0;
  for (const m of src.matchAll(ESCAPE)) {
    push(src.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    // eslint-disable-next-line no-control-regex -- an SGR escape starts with ESC or CSI by definition
    const sgr = /^(?:\u001b\[|\u009b)([0-9;:]*)m$/.exec(m[0]);
    if (!sgr) continue;
    const codes = sgr[1] === "" ? [0] : sgr[1].split(/[;:]/).map(n => Number(n) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { tone = undefined; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 2) tone = "dim";
      else if (c === 22) bold = false;
      else if (c === 39) tone = undefined;
      else if (c >= 30 && c <= 37) tone = TONES[c - 30];
      else if (c >= 90 && c <= 97) tone = TONES[c - 90];
      // 256-colour and true colour: skipped with their arguments (the tone stays as it was).
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 1;
    }
  }
  push(src.slice(at));
  return runs;
}

// ───── The command line's history ─────

/** The most commands the history keeps. */
export const HISTORY_MAX = 200;

/** A command added to the history: blank ones and a repeat of the last are not added; the oldest go past the limit. */
export function remember(history: readonly string[], command: string, max = HISTORY_MAX): string[] {
  const c = command.trim();
  if (!c || history[history.length - 1] === c) return history.slice();
  const next = [...history, c];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Where the person is in the history: `index` is history.length on the line being written, whose words `draft` keeps. */
export interface HistoryCursor { index: number; draft: string }
export const freshCursor = (history: readonly string[]): HistoryCursor => ({ index: history.length, draft: "" });

/** Up (older) or down (newer) in the history: the line to show and the cursor after; null at either end. */
export function historyStep(history: readonly string[], cursor: HistoryCursor, line: string, dir: "up" | "down"): { line: string; cursor: HistoryCursor } | null {
  const draft = cursor.index === history.length ? line : cursor.draft;
  const index = dir === "up" ? cursor.index - 1 : cursor.index + 1;
  if (index < 0 || index > history.length) return null;
  return { line: index === history.length ? draft : history[index], cursor: { index, draft } };
}

// ───── Scrollback ─────

/** The most characters of the user's shell's scrollback kept (its oldest entries go first). */
export const SCROLLBACK_CHARS = 200_000;
/** The most characters of one command's output kept (its last ones). */
export const OUTPUT_CHARS = 60_000;

/** One command the person ran here. */
export interface UserRun {
  id: string;
  command: string;
  output: string;
  cut: boolean;
  state: "running" | "done" | "failed" | "cancelled";
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  /** The SDK's tool call for it, once known (its row in the transcript). */
  toolCallId?: string;
}

/** Output kept to its last `max` characters. */
export function keepTail(text: string, max = OUTPUT_CHARS): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(text.length - max), cut: true } : { text, cut: false };
}

/** The runs kept within `max` characters of output and commands, oldest dropped first; a running one is always kept. */
export function boundScrollback(runs: readonly UserRun[], max = SCROLLBACK_CHARS): UserRun[] {
  let total = runs.reduce((n, r) => n + r.output.length + r.command.length, 0);
  const out = runs.slice();
  while (total > max && out.length > 1 && out[0].state !== "running") {
    const gone = out.shift()!;
    total -= gone.output.length + gone.command.length;
  }
  return out;
}

// ───── The agent's commands ─────

/** A shell command a tool ran, as the Terminal tab lists it. */
export interface ShellRun {
  key: string;
  toolCallId: string;
  command: string;
  output: string;
  cut: boolean;
  state: ToolItem["state"];
  exitCode?: number;
  sandboxed?: boolean;
  startedAt?: string;
  endedAt?: string;
  /** A sub-agent's command (the tool call that started the sub-agent). */
  owner?: string;
  userRequested: boolean;
}

/** Whether a tool row is a shell command's (its command, or a shell's exit code). */
export const isShell = (i: ToolItem): boolean => i.tool !== "task" && !i.agent && (i.command !== undefined || i.exitCode !== undefined);

/** Every shell command of the session, in the order they started. */
export function shellRuns(t: Transcript | undefined): ShellRun[] {
  if (!t) return [];
  return t.items.flatMap(i => (i.kind === "tool" && isShell(i) ? [{
    key: i.key, toolCallId: i.toolCallId, command: i.command ?? i.tool, output: i.output || i.partial || "", cut: i.outputCut,
    state: i.state, ...(i.exitCode !== undefined ? { exitCode: i.exitCode } : {}), ...(i.sandboxed !== undefined ? { sandboxed: i.sandboxed } : {}),
    ...(i.startedAt ? { startedAt: i.startedAt } : {}), ...(i.endedAt ? { endedAt: i.endedAt } : {}), ...(i.owner ? { owner: i.owner } : {}),
    userRequested: !!i.userRequested,
  }] : []));
}

/** How long a command ran (or has been running, at `now`), in milliseconds; undefined when its start isn't known. */
export function runMs(run: { startedAt?: string; endedAt?: string; state: string }, now: number): number | undefined {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const end = run.endedAt ? Date.parse(run.endedAt) : run.state === "running" ? now : NaN;
  return Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

/**
 * The transcript's row for a command the person ran while it runs: a shell row, not there when it was sent, running the
 * same command. The SDK names its tool call only in its result, so until then this is how its live output is found.
 */
export function liveRowFor(t: Transcript | undefined, command: string, before: ReadonlySet<string>): ShellRun | null {
  const want = command.trim();
  return shellRuns(t).find(r => !before.has(r.toolCallId) && r.command.trim() === want) ?? null;
}
