/** Actual renderer/preload observer boundaries with stand-ins only; no application build, desktop or input authority. */
/* eslint-disable @typescript-eslint/no-explicit-any -- The VM executes real unexported renderer functions against small DOM/IPC stand-ins. */
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { beforeEach, expect, it, vi } from "vitest";
import { COMMANDS_IPC } from "../../app/shared/commands";
import { COMMAND_CARD_OBSERVATION_BITS, COMMAND_CARD_OBSERVATION_RANGES } from "../../app/shared/command-card-observation";
import { allowEnabled, allowHint, judgeMetrics, reduce } from "../../app/renderer/command/model";
import type { CommandsApi } from "../../app/renderer/command/model";

const source = fs.readFileSync("app/renderer/command/main.ts", "utf8");
const fn = (name: string) => new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}`).exec(source)?.[0] ?? "";
const boundary = vi.hoisted(() => ({ api: undefined as unknown, sent: [] as { channel: string; value: unknown }[], throws: false }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { boundary.api = api; } }, ipcRenderer: {
  on() {}, invoke: async () => null, send: (channel: string, value: unknown) => { if (boundary.throws) throw new Error("Existing IPC failure"); boundary.sent.push({ channel, value }); },
} }));
await import("../../app/preload/command");
const cardSeen = (value: unknown) => (boundary.api as CommandsApi).cardSeen(value as Parameters<CommandsApi["cardSeen"]>[0]);
const diagnostic = { schema: 1, source: 2, model: 31, ui: 15, geometry: 511, arm: 2, capped: 0 };
beforeEach(() => { boundary.sent.length = 0; boundary.throws = false; });

it("preserves every valid old report exactly, prioritising it without touching a diagnostic getter", () => {
  let reads = 0;
  for (const n of [0, 1, Number.MAX_SAFE_INTEGER]) for (const inView of [false, true]) for (const seen of [false, true]) {
    cardSeen({ n, inView, seen, private: "PRIVATE", get diagnostic() { reads++; throw new Error("PRIVATE"); } });
    expect(boundary.sent.at(-1)).toEqual({ channel: COMMANDS_IPC.cardSeen, value: { n, inView, seen } });
  }
  expect(reads).toBe(0); expect(JSON.stringify(boundary.sent)).not.toContain("PRIVATE");
});
it("forwards only a standalone closed numeric diagnostic, without approval-bearing seen/inView", () => {
  cardSeen({ n: 2, diagnostic }); expect(boundary.sent).toEqual([{ channel: COMMANDS_IPC.cardSeen, value: { n: 2, diagnostic } }]);
  expect(Object.keys((boundary.sent[0].value as any).diagnostic)).toEqual(Object.keys(COMMAND_CARD_OBSERVATION_RANGES));
  expect(boundary.sent[0].value).not.toHaveProperty("seen"); expect(boundary.sent[0].value).not.toHaveProperty("inView");
});
it.each(Object.keys(COMMAND_CARD_OBSERVATION_RANGES))("enforces both ends and refuses overflow/non-integers for %s", key => {
  const [min, max] = COMMAND_CARD_OBSERVATION_RANGES[key as keyof typeof COMMAND_CARD_OBSERVATION_RANGES];
  for (const value of [min, max]) { const before = boundary.sent.length; cardSeen({ n: 1, diagnostic: { ...diagnostic, [key]: value } }); expect(boundary.sent.length).toBe(before + 1); }
  for (const value of [min - 1, max + 1, NaN, Infinity, min + 0.5, "PRIVATE"]) { const before = boundary.sent.length; cardSeen({ n: 1, diagnostic: { ...diagnostic, [key]: value } }); expect(boundary.sent.length).toBe(before); }
});
it("ignores extra data, getters and malformed observations rather than sending text or activating the old report path", () => {
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); };
  for (const value of [null, { n: -1, diagnostic }, { n: 1.5, diagnostic }, { n: 1, diagnostic, seen: "PRIVATE" }, { n: 1, diagnostic: { ...diagnostic, private: "PRIVATE" } },
    { n: 1, diagnostic: { ...diagnostic, [Symbol("PRIVATE")]: 1 } }, { n: 1, get diagnostic() { return trap(); } }, { n: 1, diagnostic: { ...diagnostic, get ui() { return trap(); } } }]) cardSeen(value);
  expect(boundary.sent).toEqual([]); expect(reads).toBe(0);
});
it("isolates observer IPC failure while preserving an original report's existing thrown IPC failure", () => {
  boundary.throws = true; expect(() => cardSeen({ n: 1, diagnostic })).not.toThrow();
  expect(() => cardSeen({ n: 1, seen: true, inView: true })).toThrow("Existing IPC failure");
});

function renderer() {
  const sent: any[] = [], timers: any[] = [], cleared: any[] = []; let clock = 0, clockReads = 0, queryReads = 0, throws = false;
  const html = { dataset: {} as Record<string, string> }, metrics = { top: 80, bottom: 180, left: 20, right: 700, scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 680, clientWidth: 680 };
  const ask: any = { key: "1:" + "a".repeat(64), card: { n: 1, sha256: "a".repeat(64) }, sent: false, retry: 0, observationGeometry: 0, observationTextSize: "",
    allow: { disabled: true }, deny: { disabled: false }, hint: { textContent: "" }, keys: { textContent: "", hidden: true },
    block: { ...metrics, parentElement: html, getBoundingClientRect() { queryReads++; return metrics; } }, actions: { getBoundingClientRect() { queryReads++; return { top: 280 }; } } };
  const model: any = { view: { keyHint: "fixed keys" }, card: { n: 1, sha256: ask.card.sha256, shownAt: 0, armMs: 1500, fits: false, atEnd: false, seen: false, inView: false }, reported: null };
  const module = { exports: undefined as any };
  const program = `let ask,model,armTimer=null,observationCard="",observationLast="",observationCount=0,observationTotal=0;
    ${["clipOf", "measuredObservation", "observeCard", "paintAllow", "measureCard"].map(fn).join("\n")}
    const dispatch=ev=>{const r=reduce(model,ev);model=r.model;for(const e of r.effects)api.cardSeen(e.msg);};
    module.exports={set:(a,m)=>{ask=a;model=m;},paint:paintAllow,measure:measureCard,geometry:measuredObservation,observe:observeCard,counts:()=>[observationCount,observationTotal],state:()=>model};`;
  runInNewContext(transformSync(program, { loader: "ts", format: "cjs", target: "node22" }).code, { module, OBSERVATION: COMMAND_CARD_OBSERVATION_BITS, allowEnabled, allowHint, judgeMetrics, reduce,
    Date: { now: () => { clockReads++; return clock; } }, document: { documentElement: html, visibilityState: "visible" }, window: { innerWidth: 760, innerHeight: 480 }, getComputedStyle: () => ({ overflowX: "visible", overflowY: "visible" }),
    ANSWER_RETRY_HINT: "fixed retry", api: { cardSeen: (value: unknown) => { if (throws && (value as any).diagnostic) throw new Error("PRIVATE observer"); sent.push(structuredClone(value)); } },
    setTimeout: (callback: unknown, wait: number) => { const timer = { callback, wait }; timers.push(timer); return timer; }, clearTimeout: (timer: unknown) => cleared.push(timer) });
  module.exports.set(ask, model);
  return { ask, model, html, metrics, sent, timers, cleared, functions: module.exports, time: (value: number) => { clock = value; }, fail: () => { throws = true; }, reads: () => ({ clock: clockReads, query: queryReads }) };
}
it("the actual measurement preserves its original seen report and layout/clock query counts, then observes the existing arm transition", () => {
  const r = renderer(); r.functions.measure();
  expect(r.sent.filter(value => !value.diagnostic)).toEqual([{ n: 1, seen: true, inView: true }]);
  expect(r.sent.find(value => value.diagnostic).diagnostic).toEqual({ schema: 1, source: 1, model: 31, ui: 27, geometry: 511, arm: 1, capped: 0 });
  expect(r.reads()).toEqual({ clock: 1, query: 2 }); expect(r.timers.map(value => value.wait)).toEqual([1505]);
  r.time(1500); r.functions.paint(); expect(r.ask.allow.disabled).toBe(false); expect(r.ask.keys.hidden).toBe(false);
  expect(r.sent.at(-1).diagnostic).toEqual({ schema: 1, source: 2, model: 31, ui: 15, geometry: 511, arm: 2, capped: 0 });
  expect(r.reads()).toEqual({ clock: 2, query: 2 }); expect(r.cleared).toHaveLength(1);
});
it("source provenance alone never emits another record and an observation failure is not retried", () => {
  const r = renderer(); r.functions.measure(); const before = r.sent.length;
  r.functions.paint(2); r.functions.paint(1); expect(r.sent).toHaveLength(before);
  r.time(1500); r.fail(); expect(() => r.functions.paint()).not.toThrow(); const counts = r.functions.counts();
  r.functions.paint(); expect(r.functions.counts()).toEqual(counts); expect(r.ask.allow.disabled).toBe(false);
});
it("caps changes at16 per exact card and64 per page before sending while the original paint continues", () => {
  const r = renderer(); r.time(1500);
  for (let card = 1; card <= 5; card++) {
    r.ask.card = { n: card, sha256: "a".repeat(64) }; r.ask.key = card + ":" + r.ask.card.sha256;
    r.model.card.n = card;
    for (let change = 0; change < 24; change++) { r.model.card.seen = change % 2 === 0; r.functions.paint(change % 2 ? 1 : 2); }
  }
  expect(r.sent).toHaveLength(64); for (const n of [1, 2, 3, 4]) expect(r.sent.filter(value => value.n === n)).toHaveLength(16);
  for (const n of [1, 2, 3, 4]) { const frames = r.sent.filter(value => value.n === n); expect(frames.at(-1).diagnostic.capped).toBe(1); expect(frames.slice(0, -1).every(value => value.diagnostic.capped === 0)).toBe(true); }
  expect(r.sent.some(value => value.n === 5)).toBe(false); expect(r.ask.allow.disabled).toBe(true);
  expect(JSON.stringify(r.sent)).not.toContain("sha256"); expect(r.sent.every(value => Object.keys(value).join("|") === "n|diagnostic")).toBe(true);
});
it("marks the global64 boundary even when the current card has fewer than16 observations", () => {
  const r = renderer(); r.time(1500);
  for (let card = 1; card <= 64; card++) { r.ask.card.n = card; r.ask.key = card + ":" + r.ask.card.sha256; r.model.card.n = card; r.functions.paint(); }
  expect(r.sent).toHaveLength(64); expect(r.sent.at(-1).diagnostic.capped).toBe(1); expect(r.functions.counts()).toEqual([1, 64]);
});
it("geometry is unknown before measurement and after a text-size or exact-card mismatch", () => {
  const r = renderer(); r.functions.paint(); expect(r.sent.at(-1).diagnostic.geometry).toBe(0);
  r.functions.measure(); expect(r.sent.at(-1).diagnostic.geometry).toBe(511);
  r.html.dataset.textSize = "large"; r.functions.paint(); expect(r.sent.at(-1).diagnostic.geometry).toBe(0);
  delete r.html.dataset.textSize; r.functions.paint(); expect(r.sent.at(-1).diagnostic.geometry).toBe(0);
  r.html.dataset.textSize = "large";
  r.functions.measure(); expect(r.sent.at(-1).diagnostic.geometry).toBe(511);
  r.functions.state().card.sha256 = "b".repeat(64); r.functions.paint(); expect(r.sent.at(-1).diagnostic).toMatchObject({ geometry: 0, arm: 0 });
});
it.each([0, 1, 2, 3, 4, 5])("the independent geometry projection shares actual judgeMetrics semantics and one-pixel slack (%i)", variant => {
  const r = renderer(), metrics: any = { ...r.metrics, top: 80, bottom: 180, left: 20, right: 700, viewHeight: 480, viewWidth: 760, visible: true, clip: { top: 12, bottom: 280, left: 12, right: 748 } };
  if (variant === 1) metrics.bottom = 282; if (variant === 2) metrics.visible = false; if (variant === 3) metrics.clientHeight = 0; if (variant === 4) metrics.scrollWidth = metrics.clientWidth + 2; if (variant === 5) metrics.left = 10;
  const actual = judgeMetrics(metrics), observed = r.functions.geometry(metrics, 280);
  expect(!!(observed & 2)).toBe(actual.fits); expect(!!(observed & 4)).toBe(actual.atEnd); expect(!!(observed & 8)).toBe(actual.onScreen);
  expect(r.functions.geometry({ ...metrics, bottom: NaN }, 280)).toBe(0);
});
