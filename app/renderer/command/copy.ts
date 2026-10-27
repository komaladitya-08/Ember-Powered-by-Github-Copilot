/**
 * Every word of Ember's command window ("Ember commands", §8.5) and of the command card's lines (§3.8.4), as pure
 * functions: the page shows them, main's controller (app/main/commands/window.ts) builds each tab's header and status
 * line with the same functions, and ui-copy.test.ts pins them. Sentence case, British spelling. Renderer-safe.
 */

import { SHORTCUTS, type OS } from "../../shared/shortcuts";
import { parseTargetId } from "../../shared/targets";
import type { CommandCard, RunExit, ShellId } from "../../main/commands/types";
import { segmentLabel, visibleText } from "./visible";

/** The window's title (it matches EMBER_WINDOW's "ember commands", so no task reads or acts in it). */
export const WINDOW_TITLE = "Ember commands";
export const EMPTY_TEXT = "No commands yet.";

export const ASK_HEADING = "Ember wants to run this command";
export const ANNOUNCE_HEADING = "Running this, as you asked";
export const ALLOW_LABEL = "Allow";
export const NOT_NOW_LABEL = "Not now";
export const STOP_LABEL = "Stop";
export const CLOSE_LABEL = "Close";
/** Under a disarmed Allow when the command must be scrolled through first. */
export const READ_ALL_HINT = "Read the whole command to allow it.";
export const UNASKED_LINE = "You didn't ask for this.";
export const LEGEND_TOKENS = "Characters you wouldn't see are shown in ⟨ ⟩.";
export const LEGEND_MIXED = "Letters from another alphabet are underlined.";
export const TYPING_HINT = "Type here to answer the command. Ember never sees what you type.";
export const NO_TYPING_HINT = "This command can't take typing here.";
export const RUNNING_STATUS = "Running…";

/** How a shell is named in the header. */
const SHELL_NAME: Readonly<Record<ShellId, string>> = { bash: "bash", zsh: "zsh", sh: "sh", powershell: "PowerShell", cmd: "cmd" };

/** A duration as the window says it: "3.2 s" under 10 s, "12 s" under a minute, then "2 min" or "2 min 5 s". */
export function durationText(ms: number): string {
  const s = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
  if (s < 9.95) {
    const t = Math.round(s * 10) / 10;
    return `${Number.isInteger(t) ? t.toFixed(0) : t.toFixed(1)} s`;
  }
  if (s < 59.5) return `${Math.round(s)} s`;
  let m = Math.floor(s / 60);
  let r = Math.round(s - m * 60);
  if (r === 60) { m += 1; r = 0; }
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

/**
 * Where a command runs, as the header says it: "On build-01 as deploy · bash · in ~/src/app", "On this computer ·
 * PowerShell · in C:\Users\ana\project", "In Ubuntu (WSL) · bash · in ~/project".
 */
export function headerLine(card: Pick<CommandCard, "target" | "targetLabel" | "login" | "shell" | "cwd">): string {
  const kind = parseTargetId(card.target)?.kind;
  const place = kind === "local" ? "On this computer"
    : kind === "wsl" ? `In ${card.targetLabel}`
    : `On ${card.targetLabel}${kind === "ssh" && card.login ? ` as ${card.login}` : ""}`;
  return `${place} · ${SHELL_NAME[card.shell] ?? card.shell} · in ${card.cwd}`;
}

/** A tab's label: the first 40 characters of its command (one line: line breaks read as spaces), "…" when cut. */
export function tabLabel(command: string): string {
  const chars = [...command.replace(/\s+/g, " ").trim()];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
}

/**
 * Text from outside Ember's own words (a remote's reason for refusing, a program name a remote reported) as one short
 * line: every control, bidi and invisible character shown as its token (§7.2: remote strings are shown with them made
 * visible and length-capped), cut at `max` characters.
 */
export function outsideText(s: unknown, max: number): string {
  const one = (typeof s === "string" ? s : "").replace(/[ \t\r\n]+/g, " ").trim();
  const shown = visibleText(one).map(segmentLabel).join("");
  const chars = [...shown];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : shown;
}

/** A reason in a sentence (shown as outsideText), without the full stop it may already end with. */
/** One clause of outside text, its own closing full stop dropped (also inside a closing quote: "…Ember." becomes "…Ember"). */
const clause = (s: string | undefined) => outsideText(s, 300).replace(/[.!]+(["'”’)\]]*)$/, "$1");

/** "1 program it started is still running: make." / "2 programs it started are still running: a, b." */
export function stragglerText(names: readonly string[]): string {
  if (!names.length) return "";
  const list = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
  return names.length === 1 ? `1 program it started is still running: ${list}.` : `${names.length} programs it started are still running: ${list}.`;
}

/**
 * A finished run's status line (§8.5): "Finished in 3.2 s.", "Ended with exit code 2 after 1.1 s.", "You stopped it
 * after 12 s. What it already changed stays.", "Stopped by Ctrl+Alt+X after 2 s. …", "Stopped after 2 min: it took too
 * long.", the lost connection, "Couldn't start: …", "build-01 refused it: …", plus any program still running.
 * `exit.stragglers` is read when the runner reports it (not in RunExit yet).
 */
export function statusLine(exit: RunExit & { stragglers?: string[] }, o: { label: string; os: OS }): string {
  const d = durationText(exit.ms);
  const stays = "What it already changed stays.";
  let line: string;
  switch (exit.ended) {
    case "exit":
      line = exit.code === 0 ? `Finished in ${d}.`
        : exit.code !== null ? `Ended with exit code ${exit.code} after ${d}.`
        : exit.signal ? `Ended by ${exit.signal} after ${d}.`
        : `Ended after ${d}.`;
      break;
    case "stopped-user": line = `You stopped it after ${d}. ${stays}`; break;
    case "stopped-task": line = `Stopped with its task after ${d}. ${stays}`; break;
    case "killswitch": line = `Stopped by ${SHORTCUTS[o.os].stop.label} after ${d}. ${stays}`; break;
    case "timeout": line = `Stopped after ${d}: it took too long.`; break;
    case "lost": line = `The connection to ${o.label} dropped; the command was stopped there.`; break;
    case "failed-to-start": line = `Couldn't start: ${clause(exit.error) || "Ember doesn't know why"}.`; break;
    case "refused-remote": line = `${o.label} refused it: ${clause(exit.error) || "it gave no reason"}.`; break;
    default: line = `Ended after ${d}.`;
  }
  const more = stragglerText(Array.isArray(exit.stragglers) ? exit.stragglers.filter(n => typeof n === "string").map(n => outsideText(n, 64)) : []);
  return more ? `${line} ${more}` : line;
}

/** The approve keys' hint under the card (§8.5), in the PC's own labels: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now". */
export function keyHintText(os: OS): string {
  return `${SHORTCUTS[os].allow.label} allow · ${SHORTCUTS[os].deny.label} not now`;
}

/** The hint under a run's terminal: typing goes to the command, or it can't take any; nothing once it has ended. */
export function typingHint(t: { interactive: boolean; ended: boolean }): string {
  if (t.ended) return "";
  return t.interactive ? TYPING_HINT : NO_TYPING_HINT;
}

/** While a WSL distro boots for its first command (the status line). */
export const startingText = (distro: string) => `Starting ${distro}…`;
/** A silent SSH link (the status line, counting down). */
export const stalledText = (label: string, seconds: number) =>
  `${label} isn't answering. This command stops in ${Math.max(0, Math.ceil(seconds))} s unless the link comes back.`;

/** The announcement's countdown: "Starts in 4 s." */
export function countdownText(endsAt: number, now: number): string {
  return `Starts in ${Math.max(0, Math.ceil((endsAt - now) / 1000))} s.`;
}

/**
 * The card's lines under the command (§3.8.4): the decision's own lines in their order, with "You didn't ask for
 * this." where the table puts it (before the Windows-reach line and the model's "Why:") when the decision says so.
 * The last line that starts "Why: " is the model's reason (untrusted): `why` gives it apart, to show small and grey.
 */
export function cardLines(card: Pick<CommandCard, "says" | "unasked">): { lines: string[]; why: string | null } {
  const says = (Array.isArray(card.says) ? card.says : []).filter((l): l is string => typeof l === "string" && l.trim() !== "");
  let why: string | null = null;
  const lines = [...says];
  if (lines.length && /^Why: /.test(lines[lines.length - 1])) why = lines.pop()!;
  if (card.unasked && !lines.includes(UNASKED_LINE)) {
    const at = lines.findIndex(l => l === "This can reach your Windows files.");
    if (at >= 0) lines.splice(at, 0, UNASKED_LINE);
    else lines.push(UNASKED_LINE);
  }
  return { lines, why };
}
