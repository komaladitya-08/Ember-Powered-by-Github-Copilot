/**
 * The bubble's motion in a real Chromium (Electron on Xvfb), frame by frame: a question comes in by its opacity alone,
 * never growing or sliding under the pointer, whatever the bubble showed before (design-system.md "Nothing near a
 * pending question moves"); an ordinary answer still grows out of Ember. The overlay never passes a mood to a hidden
 * bubble, so a question arrives on a bubble still posed as it was (thinking, working): the reviewer measured it scaling
 * 0.96 to 1 and sliding 4 px over 420 ms with the mood and the show in one frame, and for 160 ms with the mood a frame
 * earlier. Skipped without Xvfb or off Linux, except with EMBER_ATSPI_TEST=1 (RHEL 8 CI), where a missing one fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { electronBinary } from "./vocabulary-clipboard";
import { ANSWER_MAX_HEIGHT } from "../../packages/bubble/src/bubble";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const xvfb = process.platform === "linux" && spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1" && process.platform === "linux";

/**
 * The page's script: the real ReasoningBubble, driven through each sequence. Its look is sampled on the transitions' own
 * clock (Web Animations: each one paused and sought every 20 ms over 600 ms), not by waiting for frames, so a slow runner,
 * or one that gives the window no frames for a while, samples the same as a fast one.
 */
const PAGE = `
import { ReasoningBubble } from "./packages/bubble/src/bubble";
import { askKeepOff, askKeepOffKey } from "./app/renderer/overlay/layout";
type Sample = { scale: string; translate: string; opacity: number };
type Ended = { endShown: boolean; told: number };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const look = (b: ReasoningBubble): Sample => { const cs = getComputedStyle(b.root); return { scale: cs.scale, translate: cs.translate, opacity: Number(cs.opacity) }; };
/** Its look every 20 ms of its first ms after the style that starts its transitions, on their own clock. */
function watch(b: ReasoningBubble, ms: number): Sample[] {
  look(b);
  const anims = b.root.getAnimations();
  for (const a of anims) a.pause();
  const out: Sample[] = [];
  for (let t = 0; t <= ms; t += 20) {
    for (const a of anims) a.currentTime = t;
    out.push(look(b));
  }
  for (const a of anims) a.finish();
  return out;
}
/** One frame passing: the style resolved, and what it started 16 ms on. */
function oneFrame(b: ReasoningBubble): void {
  look(b);
  for (const a of b.root.getAnimations()) a.currentTime = 16;
}
/** A bubble posed as it is once hidden after \`mood\`: every transition run to its end. */
function hiddenAs(mood: string, thought: string): { b: ReasoningBubble; host: HTMLElement } {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setMood(mood as never);
  b.setThought(thought);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  look(b);
  b.setVisible(false);
  look(b);
  for (const a of b.root.getAnimations()) a.finish();
  return { b, host };
}
/** Then a question: its mood and the show in one frame, or its mood a frame before. */
async function question(before: string, sameFrame: boolean): Promise<Sample[]> {
  const { b, host } = hiddenAs(before, "Reading the window");
  await sleep(20);
  b.setMood("attention");
  b.setThought("May I click Send in Mail?");
  if (!sameFrame) oneFrame(b);
  b.setVisible(true);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  const s = watch(b, 600);
  host.remove();
  return s;
}
async function answer(): Promise<Sample[]> {
  const { b, host } = hiddenAs("idle", "Revenue grew in every region.");
  await sleep(20);
  b.setVisible(true);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  const s = watch(b, 600);
  host.remove();
  return s;
}
/** Ember's suggestions under an answer: where the chips are, and whether the overlay takes clicks there (interactiveRects). */
function chips(): { row: { x: number; y: number; w: number; h: number } | null; covered: boolean; buttons: number; labelledBy: string } {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setThought("Opened your notes in Text Editor.");
  b.setSuggestions([{ label: "Close it", onClick: () => undefined }, { label: "Read it out", onClick: () => undefined }]);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  look(b);
  const row = b.root.querySelector<HTMLElement>(".eb-suggest")!;
  const r = row.getBoundingClientRect();
  const hot = b.interactiveRects(0);
  const covered = hot.some(h => h.x <= r.x + 1 && h.y <= r.y + 1 && h.x + h.width >= r.right - 1 && h.y + h.height >= r.bottom - 1);
  const out = { row: row.hidden ? null : { x: r.x, y: r.y, w: r.width, h: r.height }, covered, buttons: row.querySelectorAll("button").length, labelledBy: row.getAttribute("aria-labelledby") ?? "" };
  b.setSuggestions(null);
  const gone = row.hidden;
  host.remove();
  return gone ? out : { ...out, row: null };
}
/**
 * A question's key hint on each OS, at the narrowest the bubble gets and beside the Ask box, at Default and Larger text:
 * how far its keys reach past the glass's inner edge (the bubble's content box, px), how far the step's own text does
 * (a flex item as wide as its widest chord, so it widened with a hint that ran past and hid it: companion-v4-2), and for
 * each chord after the first whether the " · " before it shows and whether it shares a line with the chord before it.
 */
function keyHints(): { name: string; over: number; textOver: number; seps: { shown: boolean; sameLine: boolean }[] }[] {
  const out: { name: string; over: number; textOver: number; seps: { shown: boolean; sameLine: boolean }[] }[] = [];
  const html = document.documentElement;
  const steps: [string, string][] = [["linux", "Ctrl+Alt+Y allow · Ctrl+Alt+N not now"], ["windows", "Win+Alt+Y allow · Win+Alt+N not now"],
    ["mac", "Control+Shift+Command+Y allow · Control+Shift+Command+N not now"], ["mac whole text", "Control+Shift+Command+Y shows the next part · Control+Shift+Command+N not now"]];
  for (const [size, scale] of [["default", "1"], ["larger", "1.3"]]) {
    html.dataset.textSize = size;
    html.style.setProperty("--text-scale", scale);
    for (const [os, step] of steps) for (const width of [0, 220, 273]) {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;inset:0";
      document.body.append(host);
      const b = new ReasoningBubble(host);
      b.setMood("attention");
      b.setThought("May I click Apply in Settings?");
      b.setActions([{ key: "q1:once", label: "Allow", primary: true, onClick: () => undefined }, { key: "q1:deny", label: "Not now", onClick: () => undefined }]);
      b.setStep(step);
      b.setVisible(true);
      // Its own width (0), or narrowed as place() narrows it (useWidth).
      if (width) { b.root.style.width = width + "px"; b.root.style.boxSizing = "border-box"; }
      const text = b.root.querySelector<HTMLElement>(".eb-step-text")!.getBoundingClientRect();
      const rs = getComputedStyle(b.root);
      const inner = b.root.getBoundingClientRect().right - parseFloat(rs.paddingRight) - parseFloat(rs.borderRightWidth);
      const reach = Math.max(...[...b.root.querySelectorAll<HTMLElement>(".eb-step kbd, .eb-step .eb-key-word")].map(e => e.getBoundingClientRect().right));
      const chords = [...b.root.querySelectorAll<HTMLElement>(".eb-key")];
      const em = parseFloat(getComputedStyle(b.root.querySelector(".eb-step-text")!).fontSize);
      // A chord's " · " is in the 1em before its keys; the list's first 1em, left of the row, is clipped.
      const seps = chords.slice(1).map((c, i) => {
        const r = c.getBoundingClientRect(), prev = chords[i].getBoundingClientRect();
        return { shown: r.left >= text.left - 0.5, sameLine: r.top < prev.bottom - 1 };
      });
      out.push({ name: os + " " + (width ? width + " px" : "at its own width") + " at " + size + " text", over: Math.max(0, reach - inner), textOver: Math.max(0, text.right - inner), seps });
      host.remove();
    }
  }
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return out;
}
/**
 * How tall a finished answer gets at each text size, in the tallest ways it can be (ask.ts ANSWER_MAX_HEIGHT keeps room
 * for it beside the Ask box): six lines cut short with Read all and the longest keyboard hint (a Mac's), and a whole
 * six-line answer with three of Ember's suggestions under it.
 */
function answerHeights(): { name: string; scale: number; height: number }[] {
  const out: { name: string; scale: number; height: number }[] = [];
  const html = document.documentElement;
  const long = "Tokyo is nine hours ahead of London, so it is evening there. ".repeat(8).trim();
  const six = "One. Two.\\nThree.\\nFour.\\nFive.\\nSix.";
  for (const [size, scale] of [["default", 1], ["large", 1.15], ["larger", 1.3]] as const) {
    html.dataset.textSize = size;
    html.style.setProperty("--text-scale", String(scale));
    for (const kind of ["cut short", "with suggestions"]) {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;inset:0";
      document.body.append(host);
      const b = new ReasoningBubble(host);
      if (kind === "cut short") {
        b.setThought(long);
        b.setActions([{ key: "ui:more", label: "Read all", onClick: () => undefined }]);
        b.setStep("Or press Control+Shift+Command+E and go to Conversation.");
      } else {
        b.setThought(six);
        b.setSuggestions(["Yes, please", "No, thanks", "What's the weather in London now"].map(label => ({ label, onClick: () => undefined })));
      }
      b.setVisible(true);
      b.place({ x: 200, y: 120 }, { width: 900, height: 900 }, 60);
      out.push({ name: kind + " at " + size + " text", scale, height: b.root.offsetHeight });
      host.remove();
    }
  }
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return out;
}
/**
 * An answer opened in full ("Read all") at Larger text, as the overlay places it with the Ask box open across a
 * 1024 x 768 screen above Ember (the box may be gone across: companion-c5-1), then again with nothing to keep off: where
 * it went and how tall, its text's height and how far it scrolls, its line, whether its text and its buttons take the
 * pointer (interactiveRects), and its buttons' place.
 */
function openedInFull(): { spot: { x: number; y: number; w: number; h: number } | null; text: number; scroll: number; line: number; textHot: boolean; buttons: { x: number; y: number; w: number; h: number }; buttonsHot: boolean; whole: number; wholeText: number }[] {
  const html = document.documentElement;
  html.dataset.textSize = "larger";
  html.style.setProperty("--text-scale", "1.3");
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setThought("Tokyo is nine hours ahead of London, so it is evening there. ".repeat(20).trim());
  b.setExpanded(true);
  b.setActions([{ key: "ui:close", label: "Close", onClick: () => undefined }, { key: "ui:conversation", label: "Open conversation", onClick: () => undefined }]);
  b.setVisible(true);
  const screen = { width: 1024, height: 768 }, handle = { x: 752, y: 700, width: 260, height: 56 };
  const out = [];
  for (const [box, anchor] of [[{ x: 195, y: 242, width: 728, height: 173 }, { x: 559, y: 461 }], [{ x: 195, y: 284, width: 728, height: 173 }, { x: 559, y: 695 }]] as const) {
    b.place(anchor, screen, 60, [handle, box], [], [], [box]);
    const r = b.rect();
    const t = b.root.querySelector<HTMLElement>(".eb-thought")!, a = b.root.querySelector<HTMLElement>(".eb-actions")!;
    const pos = (e: HTMLElement) => { const q = e.getBoundingClientRect(), o = b.root.getBoundingClientRect(); return { x: (r?.x ?? 0) + q.x - o.x, y: (r?.y ?? 0) + q.y - o.y, w: q.width, h: q.height }; };
    const hot = b.interactiveRects(0);
    const covers = (q: { x: number; y: number; w: number; h: number }) => hot.some(h => h.x <= q.x + 1 && h.y <= q.y + 1 && h.x + h.width >= q.x + q.w - 1 && h.y + h.height >= q.y + q.h - 1);
    const text = pos(t), buttons = pos(a);
    const kept = { spot: r && { x: r.x, y: r.y, w: r.width, h: r.height }, text: t.clientHeight, scroll: t.scrollHeight, line: parseFloat(getComputedStyle(t).lineHeight), textHot: covers(text), buttons, buttonsHot: covers(buttons) };
    // Nothing to keep off: whole again.
    b.place(anchor, screen, 60);
    out.push({ ...kept, whole: b.root.offsetHeight, wholeText: t.clientHeight });
  }
  host.remove();
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return out;
}
/**
 * An answer opened in full with the Ask box open at Larger text, Ember mid-screen on a 1024 x 768 screen (nine lines,
 * its offer last), as the overlay places it while the box is open and after the box closes (askKeepOff, as
 * measureTasks calls it): whether it was cut, its text's cap, height and scroll height each time, whether its end has
 * shown (endShown, and how often onEndShown was told), and where it went. Then the same answer cut again, scrolled to
 * its end.
 */
function closedAfterCut(): { open: Ended & { cut: boolean; cap: string; text: number; scroll: number }; closed: Ended & { cut: boolean; cap: string; text: number; scroll: number; spot: { x: number; y: number; w: number; h: number } | null }; scrolled: { cut: boolean; before: Ended; after: Ended } } {
  const html = document.documentElement;
  html.dataset.textSize = "larger";
  html.style.setProperty("--text-scale", "1.3");
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const words = ["Tokyo", "is", "nine", "hours", "ahead", "of", "London,", "so", "it", "is", "evening", "there."];
  let told = 0;
  const opened = () => {
    const o = new ReasoningBubble(host);
    o.onEndShown = () => { told++; };
    o.setThought(Array.from({ length: 70 }, (_, i) => words[i % 12]).join(" ") + " Want me to add a world clock?");
    o.setExpanded(true);
    o.setActions([{ key: "ui:close", label: "Close", onClick: () => undefined }, { key: "ui:conversation", label: "Open conversation", onClick: () => undefined }]);
    o.setVisible(true);
    return o;
  };
  const b = opened();
  const screen = { width: 1024, height: 768 }, handle = { x: 752, y: 700, width: 260, height: 56 };
  const box = { x: 195, y: 242, width: 728, height: 173 }, anchor = { x: 559, y: 461 };
  const cutState = { visible: true, mood: "idle" as const, title: "Ember", actions: [{ id: "ui:more", label: "Read all" }] };
  const full = { ...cutState, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
  const t = b.root.querySelector<HTMLElement>(".eb-thought")!;
  const read = () => ({ cut: b.isCut(), cap: t.style.maxHeight, text: t.clientHeight, scroll: t.scrollHeight, endShown: b.endShown(), told });
  const placeFor = (held: { box: typeof box | null; grew?: true }) => b.place(anchor, screen, 60, held.box ? [handle, held.box] : [handle], [], [], held.box && held.grew ? [held.box] : []);
  let held = askKeepOff(box, askKeepOffKey(cutState), { box: null, question: "" });
  held = askKeepOff(box, askKeepOffKey(full), held, true, b.isCut());
  placeFor(held);
  const open = read();
  // The box closes (Esc): state.askBox goes null.
  held = askKeepOff(null, askKeepOffKey(full), held, true, b.isCut());
  placeFor(held);
  const r = b.rect();
  const closed = { ...read(), spot: r && { x: r.x, y: r.y, w: r.width, h: r.height } };
  b.root.remove();
  // The same answer cut short again with the box open, then its text scrolled to its end (the wheel, or a screen reader),
  // on a screen the size of this page's window (its last line must be on screen to count).
  told = 0;
  const c = opened();
  const page = { width: window.innerWidth, height: window.innerHeight };
  const pageBox = { x: 150, y: 120, width: 700, height: 250 };
  c.place({ x: 500, y: 420 }, page, 60, [{ x: page.width - 272, y: page.height - 68, width: 260, height: 56 }, pageBox], [], [], [pageBox]);
  const ct = c.root.querySelector<HTMLElement>(".eb-thought")!;
  const cutBefore = c.isCut(), before = { endShown: c.endShown(), told };
  ct.scrollTop = ct.scrollHeight;
  ct.dispatchEvent(new Event("scroll"));
  const scrolled = { cut: cutBefore, before, after: { endShown: c.endShown(), told } };
  host.remove();
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return { open, closed, scrolled };
}
/** Where an answer opened in full is, whether all of its text shows, and how much of the open Ask box it is under. */
type Stage = { spot: { x: number; y: number; w: number; h: number } | null; whole: boolean; over: number };
/**
 * An answer opened in full (13 lines, its offer last) at Larger text with Ember low, as the overlay places it (askKeepOff,
 * as measureTasks calls it): Read all with the Ask box open, the box closed (Esc), then the box opened again where main
 * opens it (ask.ts openingBounds, over the answer shown whole, as nothing by Ember is clear of it), first a row short. On a
 * 1024 x 768 screen, where it is cut short for the box (companion-repairs-x6-1), and a 1366 x 768 one, where it is
 * narrowed into the screen's side strip (companion-repairs-x6-2). Then Read all with the box closed, and the box opened
 * on it the same way to reply (\`direct\`, as it shows whole; \`replied\`, the box open: companion-y6-1).
 */
function reopenedOver(): { name: string; open: Stage; closed: Stage; reopened: Stage; direct: Stage; replied: Stage }[] {
  const html = document.documentElement;
  html.dataset.textSize = "larger";
  html.style.setProperty("--text-scale", "1.3");
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const words = ["Tokyo", "is", "nine", "hours", "ahead", "of", "London,", "so", "it", "is", "evening", "there."];
  const cutState = { visible: true, mood: "idle" as const, title: "Ember", actions: [{ id: "ui:more", label: "Read all" }] };
  const full = { ...cutState, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
  type Box = { x: number; y: number; width: number; height: number };
  const area = (a: Box, c: Box) => Math.max(0, Math.min(a.x + a.width, c.x + c.width) - Math.max(a.x, c.x)) * Math.max(0, Math.min(a.y + a.height, c.y + c.height) - Math.max(a.y, c.y));
  const out = [];
  for (const [name, width, handleX, emberX] of [["1024 x 768", 1024, 752, 559], ["1366 x 768", 1366, 1094, 730]] as const) {
    const b = new ReasoningBubble(host);
    b.setThought(Array.from({ length: 110 }, (_, i) => words[i % 12]).join(" ") + " Want me to add a world clock?");
    b.setExpanded(true);
    b.setActions([{ key: "ui:close", label: "Close", onClick: () => undefined }, { key: "ui:conversation", label: "Open conversation", onClick: () => undefined }]);
    b.setVisible(true);
    const screen = { width, height: 768 }, handle = { x: handleX, y: 700, width: 260, height: 56 }, anchor = { x: emberX, y: 637 };
    const box = { x: emberX - 364, y: 226, width: 728, height: 173 }, reopened = { x: emberX - 364, y: 355, width: 728, height: 236 };
    const t = b.root.querySelector<HTMLElement>(".eb-thought")!;
    const placeFor = (held: { box: Box | null; grew?: true }) => b.place(anchor, screen, 60, held.box ? [handle, held.box] : [handle], [], [], held.box && held.grew ? [held.box] : []);
    const read = (open: Box | null): Stage => {
      const r = b.rect();
      return { spot: r && { x: r.x, y: r.y, w: r.width, h: r.height }, whole: t.scrollHeight <= t.clientHeight + 1, over: r && open ? area(r, open) : 0 };
    };
    let held = askKeepOff(box, askKeepOffKey(cutState), { box: null, question: "" });
    held = askKeepOff(box, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    const open = read(box);
    // Esc: state.askBox goes null.
    held = askKeepOff(null, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    const closed = read(null);
    // Ctrl+Alt+Space: the box opens again, on it, a row short, and grows a row up into place as it lays out (as live).
    held = askKeepOff({ ...reopened, y: 386, height: 205 }, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    held = askKeepOff(reopened, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    const again = read(reopened);
    // Asked in the box (which closes on send), Read all with the box closed, then Ctrl+Alt+Space to reply.
    held = askKeepOff(null, askKeepOffKey(cutState), { box: null, question: "" });
    held = askKeepOff(null, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    const direct = read(null);
    held = askKeepOff({ ...reopened, y: 386, height: 205 }, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    held = askKeepOff(reopened, askKeepOffKey(full), held, true, b.clipped(), b.rect());
    placeFor(held);
    out.push({ name, open, closed, reopened: again, direct, replied: read(reopened) });
    b.root.remove();
  }
  host.remove();
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return out;
}
/**
 * The same answer opened in full with the Ask box open where it shows whole, clear of the box, on a 1280 x 720 screen at
 * Larger text with Ember at 180,540: the box opened on the answer cut short, below Ember (ask.ts openingBounds, a row:
 * its offer is under Read all), Read all, Esc, then the box opened again to reply a row taller (\`opening\`: where it is
 * then; \`replied\`: the box open), over it as nothing by Ember is clear of it (companion-z6-1).
 */
function replyAfterWhole(): { open: Stage; closed: Stage; opening: Stage; replied: Stage } {
  const html = document.documentElement;
  html.dataset.textSize = "larger";
  html.style.setProperty("--text-scale", "1.3");
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const words = ["Tokyo", "is", "nine", "hours", "ahead", "of", "London,", "so", "it", "is", "evening", "there."];
  const cutState = { visible: true, mood: "idle" as const, title: "Ember", actions: [{ id: "ui:more", label: "Read all" }] };
  const full = { ...cutState, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
  type Box = { x: number; y: number; width: number; height: number };
  const area = (a: Box, c: Box) => Math.max(0, Math.min(a.x + a.width, c.x + c.width) - Math.max(a.x, c.x)) * Math.max(0, Math.min(a.y + a.height, c.y + c.height) - Math.max(a.y, c.y));
  const b = new ReasoningBubble(host);
  b.setThought(Array.from({ length: 110 }, (_, i) => words[i % 12]).join(" ") + " Want me to add a world clock?");
  b.setExpanded(true);
  b.setActions([{ key: "ui:close", label: "Close", onClick: () => undefined }, { key: "ui:conversation", label: "Open conversation", onClick: () => undefined }]);
  b.setVisible(true);
  const screen = { width: 1280, height: 720 }, handle = { x: 1008, y: 652, width: 260, height: 56 }, anchor = { x: 180, y: 564 };
  const box = { x: 8, y: 576, width: 728, height: 111 }, reopened = { x: 8, y: 376, width: 728, height: 142 };
  const t = b.root.querySelector<HTMLElement>(".eb-thought")!;
  const placeFor = (held: { box: Box | null; grew?: true }) => b.place(anchor, screen, 60, held.box ? [handle, held.box] : [handle], [], [], held.box && held.grew ? [held.box] : []);
  const read = (open: Box | null): Stage => {
    const r = b.rect();
    return { spot: r && { x: r.x, y: r.y, w: r.width, h: r.height }, whole: t.scrollHeight <= t.clientHeight + 1, over: r && open ? area(r, open) : 0 };
  };
  let held = askKeepOff(box, askKeepOffKey(cutState), { box: null, question: "" });
  held = askKeepOff(box, askKeepOffKey(full), held, true, b.clipped(), b.rect());
  placeFor(held);
  const open = read(box);
  // Esc: state.askBox goes null; it showed whole, so it stays where it is.
  held = askKeepOff(null, askKeepOffKey(full), held, true, b.clipped(), b.rect());
  placeFor(held);
  const closed = read(null);
  // Ctrl+Alt+Space to reply: the box opens on it, a row taller for "Yes, please" and "No, thanks".
  const opening = read(reopened);
  held = askKeepOff(reopened, askKeepOffKey(full), held, true, b.clipped(), b.rect());
  placeFor(held);
  const replied = read(reopened);
  b.root.remove();
  host.remove();
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return { open, closed, opening, replied };
}
/**
 * Question hints left in the page for main to read from its accessibility tree: Linux's at the bubble's own width (the
 * two chords on one line) and a Mac's narrowed to 220 px (each chord on a line of its own). Their hosts' ids.
 */
function axHints(): string[] {
  const hints: [string, string, number][] = [["ax-linux", "Ctrl+Alt+Y allow · Ctrl+Alt+N not now", 0],
    ["ax-mac", "Control+Shift+Command+Y allow · Control+Shift+Command+N not now", 220]];
  for (const [id, step, width] of hints) {
    const host = document.createElement("div");
    host.id = id;
    host.style.cssText = "position:absolute;inset:0";
    document.body.append(host);
    const b = new ReasoningBubble(host);
    b.setMood("attention");
    b.setThought("May I click Apply in Settings?");
    b.setStep(step);
    b.setVisible(true);
    if (width) { b.root.style.width = width + "px"; b.root.style.boxSizing = "border-box"; }
  }
  return hints.map(h => h[0]);
}
(window as unknown as { start: () => Promise<void> }).start = async () => {
  // A first run, thrown away: the page's fonts, layout and the bubble's style sheet in place before anything counts.
  await question("thinking", true);
  const result = {
    thinkingSame: await question("thinking", true),
    thinkingNext: await question("thinking", false),
    actingSame: await question("acting", true),
    idleNext: await question("idle", false),
    answer: await answer(),
    chips: chips(),
    keyHints: keyHints(),
    answerHeights: answerHeights(),
    openedInFull: openedInFull(),
    closedAfterCut: closedAfterCut(),
    reopenedOver: reopenedOver(),
    replyAfterWhole: replyAfterWhole(),
    axHints: axHints(),
    // Ember's own font, loaded: the key hints are measured in it, not in a fallback a runner happens to have.
    emberSans: [...document.fonts].some(f => f.family.replace(/"/g, "") === "Ember Sans" && f.status === "loaded"),
  };
  (window as unknown as { done: unknown }).done = result;
};
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
/**
 * The words a screen reader is given for each hint left in the page (ids): the text of the accessibility tree under its
 * step, in order, as Orca's flat review reads it. Generated content is in that tree whatever clips it from sight.
 */
async function axTexts(win, ids) {
  const out = {};
  const dbg = win.webContents.debugger;
  try {
    dbg.attach("1.3");
    await dbg.sendCommand("Accessibility.enable");
    const { root } = await dbg.sendCommand("DOM.getDocument", { depth: -1 });
    const { nodes } = await dbg.sendCommand("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    for (const id of ids) {
      const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#" + id + " .eb-step-text" });
      const { node } = await dbg.sendCommand("DOM.describeNode", { nodeId });
      const words = [];
      const walk = n => {
        if (!n) return;
        if (!n.ignored && n.role && n.role.value === "StaticText") { words.push(n.name ? n.name.value : ""); return; }
        for (const c of n.childIds || []) walk(byId.get(c));
      };
      const start = nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
      walk(start);
      out[id] = start ? words.join(" ").split(" ").filter(Boolean).join(" ") : null;
    }
  } catch (e) { out.error = String(e); }
  return out;
}
app.whenReady().then(async () => {
  setTimeout(() => app.exit(3), 30_000);
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "page.html"));
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => { window.start(); return true; })");
  for (let i = 0; i < 200; i++) {
    const r = await win.webContents.executeJavaScript("window.done ?? null");
    if (r) { r.axHints = await axTexts(win, r.axHints); process.stdout.write("RESULT " + JSON.stringify(r) + "\\n"); app.exit(0); return; }
    await new Promise(r => setTimeout(r, 100));
  }
  app.exit(4);
});
`;

type Sample = { scale: string; translate: string; opacity: number };
/** Where an answer opened in full is, whether all of its text shows, and how much of the open Ask box it is under. */
type Stage = { spot: { x: number; y: number; w: number; h: number } | null; whole: boolean; over: number };
/** Whether an answer opened in full has shown its end (endShown), and how many times onEndShown was told. */
type Ended = { endShown: boolean; told: number };
type Result = Record<"thinkingSame" | "thinkingNext" | "actingSame" | "idleNext" | "answer", Sample[]> & {
  chips: { row: { x: number; y: number; w: number; h: number } | null; covered: boolean; buttons: number; labelledBy: string };
  keyHints: { name: string; over: number; textOver: number; seps: { shown: boolean; sameLine: boolean }[] }[];
  /** A finished answer's height in its tallest forms at each text size (answerHeights). */
  answerHeights: { name: string; scale: number; height: number }[];
  /** An answer opened in full beside the open Ask box, Ember mid-screen and low (openedInFull). */
  openedInFull: { spot: { x: number; y: number; w: number; h: number } | null; text: number; scroll: number; line: number; textHot: boolean; buttons: { x: number; y: number; w: number; h: number }; buttonsHot: boolean; whole: number; wholeText: number }[];
  /** An answer opened in full, cut for the open Ask box, then the box closed; and cut, then scrolled (closedAfterCut). */
  closedAfterCut: { open: Ended & { cut: boolean; cap: string; text: number; scroll: number }; closed: Ended & { cut: boolean; cap: string; text: number; scroll: number; spot: { x: number; y: number; w: number; h: number } | null }; scrolled: { cut: boolean; before: Ended; after: Ended } };
  /**
   * An answer opened in full with the box open, the box closed, then opened again on it, at Ember low; then one opened in
   * full with the box closed and the box opened on it (reopenedOver).
   */
  reopenedOver: { name: string; open: Stage; closed: Stage; reopened: Stage; direct: Stage; replied: Stage }[];
  /**
   * An answer opened in full with the box open that showed whole, the box closed, then opened again on it to reply
   * (replyAfterWhole).
   */
  replyAfterWhole: { open: Stage; closed: Stage; opening: Stage; replied: Stage };
  /** What a screen reader reads of each hint left in the page (by its host's id). */
  axHints: Record<string, string | null>;
  /** Whether the bundled "Ember Sans" (Inter) had loaded when the hints were measured. */
  emberSans: boolean;
};

/** How far a sample is from at rest: its scale's distance from 1, its translate in px. */
const scaleOff = (s: Sample) => (s.scale === "none" ? 0 : Math.abs(Number(s.scale.split(" ")[0]) - 1));
const slide = (s: Sample) => (s.translate === "none" ? 0 : Math.max(...s.translate.split(" ").map(v => Math.abs(parseFloat(v)) || 0)));

describe.skipIf(!required && !xvfb)("the bubble's motion, frame by frame in a real Chromium", () => {
  let server: ChildProcess;
  let display = "";
  let dir = "";
  let result: Result;

  beforeAll(async () => {
    if (!xvfb) throw new Error("the bubble's motion can't be checked here: no Xvfb");
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    dir = path.join(root, ".cache", "test", "bubble-motion-electron");
    fs.mkdirSync(dir, { recursive: true });
    buildSync({
      stdin: { contents: PAGE, loader: "ts", resolveDir: root, sourcefile: "bubble-motion-page.ts" },
      bundle: true, platform: "browser", format: "iife", target: "chrome120", outfile: path.join(dir, "page.js"), logLevel: "silent",
    });
    // The page as Ember's overlay has it: the shared design system, then the bubble's own CSS (it adds it itself), and
    // the bundled font beside it as in dist/app/renderer (ember.css loads ../fonts/). Without it the page fell back to
    // whatever sans-serif the runner has: Inter here, wider DejaVu Sans on CI's Ubuntu, where a Windows key hint that
    // fits the bubble in Ember's own font wrapped.
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
    fs.copyFileSync(path.join(root, "app", "renderer", "shared", "ember.css"), path.join(dir, "shared", "ember.css"));
    fs.cpSync(path.join(root, "assets", "fonts"), path.join(dir, "fonts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "page.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="shared/ember.css"><style>html,body{margin:0;background:transparent}</style></head><body><script src="page.js"></script></body></html>`);
    fs.writeFileSync(path.join(dir, "main.cjs"), MAIN);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ember-bubble-motion-test", main: "main.cjs" }));
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display, ELECTRON_ENABLE_LOGGING: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    // A test harness that loads only its own local page, so it runs without the Chromium sandbox: on a runner whose
    // chrome-sandbox isn't set up setuid root (ubuntu's CI) Electron aborts at once with it ("The SUID sandbox helper
    // binary was found, but is not configured correctly"), and as root (EL8's container) it can't run with it at all.
    const child = spawn(electronBinary(), ["--no-sandbox", dir], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    result = await new Promise((resolve, reject) => child.on("exit", code => {
      const line = out.split("\n").find(l => l.startsWith("RESULT "));
      if (line) resolve(JSON.parse(line.slice("RESULT ".length)) as Result);
      else reject(new Error(`the page's Electron exited (${String(code)}) without a result\n${out}\n${err}`));
    }));
  }, 60_000);
  afterAll(() => { server?.kill(); });

  for (const [key, what] of [["thinkingSame", "after thinking, its mood and the show in one frame"], ["thinkingNext", "after thinking, its mood a frame before the show"],
    ["actingSame", "after working"], ["idleNext", "after an answer"]] as const) {
    it(`brings a question in by its opacity alone, never growing or sliding (${what})`, () => {
      const all = result[key];
      // Every 20 ms over 600 ms, on the transitions' own clock.
      expect(all.length).toBe(31);
      // What can be seen (a frame still at opacity 0 shows nothing).
      const s = all.filter(x => x.opacity > 0.001);
      expect(Math.max(...s.map(scaleOff)), JSON.stringify(s.slice(0, 4))).toBeLessThan(0.001);
      expect(Math.max(...s.map(slide)), JSON.stringify(s.slice(0, 4))).toBeLessThan(0.05);
      // It does fade in.
      expect(all[all.length - 1].opacity).toBeCloseTo(1, 2);
    });
  }

  it("still grows an ordinary answer out of Ember", () => {
    expect(Math.max(...result.answer.map(scaleOff))).toBeGreaterThan(0.005);
  });

  it("takes clicks on Ember's suggestions under an answer (interactiveRects covers their row), named by their caption (review of #145)", () => {
    const c = result.chips;
    expect(c.row).not.toBeNull();
    expect(c.row!.h).toBeGreaterThanOrEqual(24);
    expect(c.buttons).toBe(2);
    expect(c.covered).toBe(true);
    expect(c.labelledBy).toMatch(/^eb-suggest-cap-\d+$/);
  });

  it("keeps a question's key hint inside a narrowed bubble on every OS and text size, with no \" · \" ending or starting a line (companion-r3-2, accessibility-visual-r3-2, accessibility-visual-c3-1, companion-v4-2)", () => {
    // Measured in the bubble's own font: a runner's wider fallback wrapped a Windows hint that fits (CI's Ubuntu).
    expect(result.emberSans).toBe(true);
    const all = result.keyHints;
    expect(all.length).toBe(24);
    for (const k of all) {
      // A Mac's four keys at 220 px reached 34 px (Default) and 88 px (Larger) past the glass's inner edge, a whole
      // text's 173 px; measured against the step's own text, which widened with them, it read 0.
      expect(k.over, k.name).toBeLessThan(0.5);
      expect(k.textOver, k.name).toBeLessThan(0.5);
      // The " · " shows only between two chords on one line: never left at a line's end, nor starting the next.
      for (const sep of k.seps) expect(sep.shown, k.name).toBe(sep.sameLine);
    }
    // Where there is room, the two chords still share a line with the " · " between them.
    for (const name of ["linux at its own width at default text", "windows at its own width at larger text"]) {
      expect(all.find(k => k.name === name)!.seps, name).toEqual([{ shown: true, sameLine: true }]);
    }
  });

  it("is never taller as a finished answer than the room the Ask box leaves for it beside itself (companion-c3-1, accessibility-visual-c4-1)", () => {
    expect(result.answerHeights.length).toBe(6);
    for (const a of result.answerHeights) {
      expect(a.height, a.name).toBeLessThanOrEqual(Math.ceil(ANSWER_MAX_HEIGHT * a.scale));
    }
    // And the room is no bigger than it must be: the tallest is within 8 % of it at each text size.
    for (const scale of [1, 1.15, 1.3]) {
      const tallest = Math.max(...result.answerHeights.filter(a => a.scale === scale).map(a => a.height));
      expect(tallest, String(scale)).toBeGreaterThan(ANSWER_MAX_HEIGHT * scale * 0.92);
    }
  });

  it("cuts an answer opened in full beside the open Ask box short to the room clear of the box, whole lines of it, its text scrolling and its buttons in view; whole again with room (companion-c5-1)", () => {
    const boxes = [{ x: 195, y: 242, width: 728, height: 173 }, { x: 195, y: 284, width: 728, height: 173 }];
    const handle = { x: 752, y: 700, width: 260, height: 56 };
    expect(result.openedInFull.length).toBe(2);
    result.openedInFull.forEach((o, i) => {
      const name = i ? "Ember low" : "Ember mid-screen";
      // 410 x 489 whole, laid under the field (46,359 and 57,528 px² of it): now clear of the box and the handle, on screen.
      expect(o.spot, name).not.toBeNull();
      const s = o.spot!, clear = (b: typeof handle) => s.x >= b.x + b.width || s.x + s.w <= b.x || s.y >= b.y + b.height || s.y + s.h <= b.y;
      expect(clear(boxes[i]), name).toBe(true);
      expect(clear(handle), name).toBe(true);
      expect(s.y + s.h, name).toBeLessThanOrEqual(768 - 8);
      expect(s.h, name).toBeLessThan(o.whole);
      // Whole lines of its text, at least three, and the rest scrolls inside it under the wheel.
      expect(o.text % o.line, name).toBe(0);
      expect(o.text, name).toBeGreaterThanOrEqual(3 * o.line);
      expect(o.scroll, name).toBeGreaterThan(o.text);
      expect(o.textHot, name).toBe(true);
      // Its buttons inside it, taking clicks.
      expect(o.buttons.y + o.buttons.h, name).toBeLessThanOrEqual(s.y + s.h);
      expect(o.buttonsHot, name).toBe(true);
      // With room again it shows as much as it always did: sixteen lines.
      expect(o.wholeText, name).toBe(16 * o.line);
    });
  });

  it("shows an answer cut short for the open Ask box whole once the box closes, where all of it fits: its cap goes (companion-v6-3)", () => {
    const { open, closed } = result.closedAfterCut;
    // Cut while the box was open, its offer scrolled out of view.
    expect(open.cut).toBe(true);
    expect(open.cap).not.toBe("");
    expect(open.scroll).toBeGreaterThan(open.text);
    // Esc: the cap goes and all of it shows, clear of the handle, on screen.
    expect(closed.cut).toBe(false);
    expect(closed.cap).toBe("");
    expect(closed.scroll).toBeLessThanOrEqual(closed.text);
    const s = closed.spot!, handle = { x: 752, y: 700, width: 260, height: 56 };
    expect(s.x >= handle.x + handle.width || s.x + s.w <= handle.x || s.y >= handle.y + handle.height || s.y + s.h <= handle.y).toBe(true);
    expect(s.y).toBeGreaterThanOrEqual(0);
    expect(s.y + s.h).toBeLessThanOrEqual(768);
  });

  it("says an answer opened in full has shown its end only once its last line has been in view: whole, or scrolled to it (companion-v6-2)", () => {
    const { open, closed, scrolled } = result.closedAfterCut;
    // Cut short for the open box, its offer out of view: not shown, and the overlay isn't told (the Ask box offered
    // "Yes, please" to it all the same).
    expect(open).toMatchObject({ endShown: false, told: 0 });
    // Whole once the box closed: shown, told once.
    expect(closed).toMatchObject({ endShown: true, told: 1 });
    // Cut again and scrolled to its end: shown from then on, told once.
    expect(scrolled.cut).toBe(true);
    expect(scrolled.before).toEqual({ endShown: false, told: 0 });
    expect(scrolled.after).toEqual({ endShown: true, told: 1 });
  });

  it("shows an answer opened in full whole once the box closes though it was narrowed for the box, and keeps it clear of the box opening on it again (companion-repairs-x6-1, companion-repairs-x6-2)", () => {
    const handleOf = (width: number) => ({ x: width === 1024 ? 752 : 1094, y: 700, w: 260, h: 56 });
    for (const { name, open, closed, reopened } of result.reopenedOver) {
      const width = Number(name.split(" ")[0]);
      // With the box open: clear of it, and its text doesn't all show (cut short beside Ember at 1024, narrowed into the
      // side strip at 1366, its offer behind the scroll bar).
      expect(open.spot, name).not.toBeNull();
      expect(open.over, name).toBe(0);
      expect(open.whole, name).toBe(false);
      // Esc: all of it shows, at its own width, on screen and clear of the handle (x6-2: the narrowed one stayed narrow,
      // 650 px of text in a 416 px box).
      const s = closed.spot!, h = handleOf(width);
      expect(closed.whole, name).toBe(true);
      expect(s.w, name).toBe(410);
      expect(s.x >= h.x + h.w || s.x + s.w <= h.x || s.y >= h.y + h.h || s.y + s.h <= h.y, name).toBe(true);
      expect(s.y >= 0 && s.y + s.h <= 768 && s.x >= 0 && s.x + s.w <= width, name).toBe(true);
      // The box opens again on it: it keeps off the box again, still shown (x6-1: the field opened over its lines,
      // 66,176 px² of the field).
      expect(reopened.spot, name).not.toBeNull();
      expect(reopened.over, name).toBe(0);
    }
  });

  it("keeps an answer opened in full with the box closed clear of the box opening on it to reply (companion-y6-1)", () => {
    for (const { name, direct, replied } of result.reopenedOver) {
      // Read all with the box closed: whole, and the box opens on it (nothing by Ember is clear of it).
      expect(direct.whole, name).toBe(true);
      expect(direct.spot, name).not.toBeNull();
      // The box open: it keeps off the box, still shown (the field, Send and its hint lay over lines 9 to 11 of it,
      // 66,176 px² of the field, whichever order Read all and the box came in).
      expect(replied.spot, name).not.toBeNull();
      expect(replied.over, name).toBe(0);
    }
  });

  it("keeps an answer opened in full with the box open that showed whole clear of the box opening on it again to reply (companion-z6-1)", () => {
    const { open, closed, opening, replied } = result.replyAfterWhole;
    // Read all with the box open: whole above Ember, clear of the box; Esc: it stays where it is, whole.
    expect(open.spot).not.toBeNull();
    expect(open.whole).toBe(true);
    expect(open.over).toBe(0);
    expect(closed.whole).toBe(true);
    expect(closed.spot).toEqual(open.spot);
    // The box opens to reply on its last lines, its offer and its Close (37,720 px² of it, live) ...
    expect(opening.over).toBeGreaterThan(0);
    // ... and it keeps off the box, still shown (it kept off only the first box's old place, and stayed under the field).
    expect(replied.spot).not.toBeNull();
    expect(replied.over).toBe(0);
  });

  it("reads a question's key hint to a screen reader with the \" · \" only between its chords, never before the first (companion-v4-3)", () => {
    // The first chord's own dot, clipped from sight, was read all the same: "· Ctrl Alt Y allow · Ctrl Alt N not now".
    expect(result.axHints).toEqual({
      "ax-linux": "Ctrl Alt Y allow · Ctrl Alt N not now",
      "ax-mac": "Control Shift Command Y allow · Control Shift Command N not now",
    });
  });
});
