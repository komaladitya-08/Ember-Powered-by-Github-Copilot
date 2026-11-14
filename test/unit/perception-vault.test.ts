/**
 * What Ember reads and captures after a fill from its vault (owner decision of 2026-11-12; PLAN.md §2 "Approvals",
 * "The vault"; the slice's decision 7): whatever on screen says a value the vault filled is dropped from every read and
 * blacked out of every picture as a secret field is, and where that can't be done there is no picture. The real
 * Perception and redactor over a pretend desktop, with real pixels.
 */

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { Perception } from "../../app/main/perception";
import { quoteUntrusted, screenWord, setQuoteRedactor } from "../../app/main/perception/elements";
import { VaultRedactor } from "../../app/main/vault/redact";
import type { AtspiSidecar, AxNode, AxWindow, Bounds, ReadWindowResult } from "../../app/main/perception/sidecar";
import type { StackedWindow, X11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const EMAIL = "ada.canary@example.org";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const FRAME: Bounds = { x: 0, y: 0, width: 800, height: 600 };
const win = (name: string): AxWindow => ({ app: "firefox", pid: 42, path: "/w/1", name, role: "frame", active: true, bounds: FRAME });
const stack = (title: string): StackedWindow[] => [{ id: 1, client: 2, pid: 42, title, wmClass: "firefox", ...FRAME, outer: FRAME, inner: FRAME, overrideRedirect: false }];
const at = (y: number): Bounds => ({ x: 100, y, width: 300, height: 30 });
const EDIT = ["enabled", "editable", "showing"];

function desktop(o: { title?: string; nodes: AxNode[]; answer?: Partial<ReadWindowResult>; redactor?: VaultRedactor | null; markFails?: boolean }) {
  const marked: number[][] = [];
  const title = o.title ?? "Account — Mozilla Firefox";
  const sidecar = {
    readWindow: async (): Promise<ReadWindowResult> => ({ window: win(title), nodes: o.nodes, ms: 1, ...o.answer }),
    listWindows: async () => ({ windows: [win(title)] }),
    scaleElements: () => {},
    markSecret: async (ids: number[]) => { marked.push(ids); if (o.markFails) throw new Error("down"); },
    readElement: async (id: number) => { const n = o.nodes.find(x => x.id === id); return { role: n?.role ?? "text", name: "", states: [], bounds: n?.bounds ?? null }; },
    shellOverlays: async () => ({ overlays: [] }),
    secretFields: async () => ({ fields: [], complete: true, ms: 1 }),
  } as unknown as AtspiSidecar;
  const x11 = {
    stack: () => stack(title), focusWindow: () => null, activeWindow: () => null, clientWindows: () => [],
    capture: (x: number, y: number, width: number, height: number) => ({ x, y, width, height, bgra: Buffer.alloc(width * height * 4, 200) }),
  } as unknown as X11;
  const r = o.redactor === undefined ? new VaultRedactor() : o.redactor;
  const perception = new Perception({ sidecar, x11, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1000, height: 1000 }), log: quiet, ownPid: 999,
    ...(r ? { holdsVaultValue: (t: string) => r.holds(t), vaultShown: () => r.shown, vaultFilled: () => r.active } : {}) });
  return { perception, marked, redactor: r };
}

async function pixel(data: Buffer, x: number, y: number): Promise<number> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  return raw[(y * info.width + x) * info.channels];
}

const FIELD: AxNode = { id: 1, parent: null, depth: 1, role: "entry", name: "Email", states: EDIT, bounds: at(100), text: EMAIL };
const ECHO: AxNode = { id: 2, parent: null, depth: 1, role: "static", name: `Signed in as ${EMAIL.toUpperCase()}`, states: ["showing"], bounds: at(200) };
const TAB: AxNode = { id: 3, parent: null, depth: 1, role: "page tab", name: `Inbox (${EMAIL})`, states: ["showing"], bounds: { x: 0, y: 0, width: 200, height: 30 } };
const OTHER: AxNode = { id: 4, parent: null, depth: 1, role: "entry", name: "Search", states: EDIT, bounds: at(300), text: "canaries" };
const NODES = [FIELD, ECHO, TAB, OTHER];

describe("a read after a fill from the vault (vault-3)", () => {
  it("reads everything as it is until a value has been filled", async () => {
    const d = desktop({ nodes: NODES });
    const seen = await d.perception.read({ pid: 42 });
    expect(seen.nodes).toEqual(NODES);
    expect(d.marked).toEqual([]);
    expect(JSON.stringify((await d.perception.perceive({ image: false, scope: "window", target: { pid: 42 } })).text)).toContain(EMAIL);
  });

  it("drops what a field, a line of text or a tab says of the value, and tells the helper the field is secret", async () => {
    const d = desktop({ nodes: NODES });
    d.redactor!.note("email", EMAIL);
    const p = await d.perception.perceive({ image: false, scope: "window", target: { pid: 42 } });
    expect(JSON.stringify([p.text, p.nodes])).not.toMatch(/ada\.canary/i);
    expect(p.nodes.map(n => [n.id, n.name, !!n.secret, !!n.withheld, n.text])).toEqual([
      [1, "Email", true, false, undefined], [2, "", true, true, undefined], [3, "", true, true, undefined], [4, "Search", false, false, "canaries"]]);
    // The field stays secret to the helper (nothing is typed into it); a line of text is found again at each read.
    expect(d.marked).toEqual([[1]]);
  });

  it("drops it though the helper couldn't be told", async () => {
    const d = desktop({ nodes: NODES, markFails: true });
    d.redactor!.note("email", EMAIL);
    const seen = await d.perception.read({ pid: 42 });
    expect(JSON.stringify(seen.nodes)).not.toMatch(/ada\.canary/i);
  });
});

describe("a checkout after a card's security code was filled (vault-3)", () => {
  it("keeps the names, the fields and the picture of whatever only has the code's digits in it (vault-3-x9-3)", async () => {
    const PAY: AxNode = { id: 11, parent: null, depth: 1, role: "push button", name: "Pay $1,437.00", states: ["enabled", "showing"], bounds: at(100) };
    const NOTES: AxNode = { id: 12, parent: null, depth: 1, role: "entry", name: "Delivery notes", states: EDIT, bounds: at(200), text: "Flat 437, ring twice" };
    const ORDER: AxNode = { id: 13, parent: null, depth: 1, role: "label", name: "Order 54371 confirmed", states: ["showing"], bounds: at(300) };
    const d = desktop({ nodes: [PAY, NOTES, ORDER], title: "Order 1437 — Mozilla Firefox" });
    d.redactor!.note("securityCode", "437");
    const p = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(p.nodes.map(n => [n.id, n.name, !!n.secret, !!n.withheld])).toEqual([[11, "Pay $1,437.00", false, false], [12, "Delivery notes", false, false], [13, "Order 54371 confirmed", false, false]]);
    expect(p.nodes[1].text).toBe("Flat 437, ring twice");
    expect(d.marked).toEqual([]);
    expect(p.capture).toBeTruthy();
  });
});

describe("text cut short for a model after a fill from the vault (vault-3)", () => {
  afterEach(() => setQuoteRedactor(null));
  const LONG = `Re: the quarterly planning notes for the northern region office move and budget — ${EMAIL} — Example Mail — Mozilla Firefox`;

  it("never hands on the first part of a value that the cut falls in: a window's title, a name, a click's landing place (vault-3-x9-2)", async () => {
    const d = desktop({ nodes: [{ id: 1, parent: null, depth: 1, role: "entry", name: "Search", states: EDIT, bounds: at(100), text: "" }], title: LONG });
    d.redactor!.note("email", EMAIL);
    setQuoteRedactor(t => d.redactor!.text(t));
    // The title is cut at 100 characters, in the middle of the address: the boundary can't know "ada.canary@example…".
    expect(LONG.slice(0, 100)).toContain("ada.canary@example");
    const p = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    const sent = d.redactor!.text(p.text);
    expect(sent).not.toMatch(/ada\.can|canary@/i);
    expect(sent.split("\n")[0]).toContain('budget — [hidden: filled fr…" untrusted="true">');
    // list_windows' line and a click's landing place use the same quoting (worker.ts `q`), at 100 and 80 characters.
    for (const max of [100, 97, 90, 80, 40]) expect(quoteUntrusted(LONG, max), String(max)).not.toMatch(/ada|canary/i);
    expect(quoteUntrusted(`${"x".repeat(70)} ${EMAIL}`, 80)).toBe(JSON.stringify(`${"x".repeat(70)} [hidden: …`));
    expect(screenWord(`role ${EMAIL} ${"y".repeat(40)}`)).not.toMatch(/canary/);
  });

  it("hands on nothing of a text it couldn't check, and everything as it is while nothing was filled (vault-3-x9-2)", () => {
    expect(quoteUntrusted(LONG, 100)).toBe(JSON.stringify(`${LONG.slice(0, 100)}…`));
    setQuoteRedactor(() => { throw new Error("down"); });
    expect(quoteUntrusted(LONG, 100)).toBe('""');
  });
});

describe("a picture after a fill from the vault (vault-3)", () => {
  it("blacks out every place that says the value, as a secret field's", async () => {
    const d = desktop({ nodes: NODES });
    const before = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(await pixel(before.capture!.data, 250, 115)).toBeGreaterThan(150);
    d.redactor!.note("email", EMAIL);
    const p = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(p.capture).not.toBeNull();
    for (const [x, y] of [[250, 115], [250, 215], [100, 15]]) expect(await pixel(p.capture!.data, x, y), `${x},${y}`).toBeLessThan(40);
    // What says nothing of it shows as before.
    expect(await pixel(p.capture!.data, 600, 500)).toBeGreaterThan(150);
  });

  it("blacks out a line the helper withheld for repeating a filled field's value, whose words never reach Ember (vault-3, GTK's echo in CI's el8 job)", async () => {
    // The helper finds the user name in the filled field (secret from the fill on) and withholds the GTK label that
    // repeats it, so Perception gets no words to recognise: the label's place must still be black.
    const ECHOED: AxNode = { id: 5, parent: null, depth: 1, role: "label", name: "", withheld: true, states: ["showing"], bounds: at(400) };
    const d = desktop({ nodes: [OTHER, ECHOED] });
    const before = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(await pixel(before.capture!.data, 250, 415)).toBeGreaterThan(150);
    expect(before.nodes.find(n => n.id === 5)?.secret).toBeUndefined();
    d.redactor!.note("password", "Tr0ub4dor-CANARY-3");
    const p = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(p.nodes.find(n => n.id === 5)).toMatchObject({ name: "", withheld: true, secret: true });
    expect(await pixel(p.capture!.data, 250, 415)).toBeLessThan(40);
    // What wasn't withheld shows as before, and a label isn't told to the helper as a secret field.
    expect(await pixel(p.capture!.data, 250, 315)).toBeGreaterThan(150);
    expect(d.marked).toEqual([]);
  });

  it("takes none of a window whose own title says the value", async () => {
    for (const d of [desktop({ nodes: [OTHER], title: `Inbox - ${EMAIL} - Mail` }),
      desktop({ nodes: [{ id: 9, parent: null, depth: 0, role: "frame", name: `Inbox - ${EMAIL}`, states: [], bounds: FRAME }, OTHER] })]) {
      expect((await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } })).capture).not.toBeNull();
      d.redactor!.note("email", EMAIL);
      const p = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
      expect(p.capture).toBeNull();
      expect(p.text).toContain("(No screenshot: the window's title shows something Ember filled from its vault.)");
      expect(JSON.stringify(p.nodes)).not.toMatch(/ada\.canary/i);
    }
  });

  it("takes none of a read cut short once a value an app shows as it is has been filled, and still takes one after a password alone", async () => {
    const d = desktop({ nodes: [OTHER], answer: { truncated: true } });
    d.redactor!.note("password", "Tr0ub4dor-CANARY-3");
    expect((await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } })).capture).not.toBeNull();
    d.redactor!.note("email", EMAIL);
    const p = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(p.capture).toBeNull();
    expect(p.text).toContain("(No screenshot: Ember couldn't read the whole window, so it can't tell where what it filled from its vault shows.)");
  });

  it("takes none when the check itself fails", async () => {
    const d = desktop({ nodes: [OTHER], redactor: null });
    const broken = new Perception({ ...(d.perception as unknown as { o: ConstructorParameters<typeof Perception>[0] }).o, holdsVaultValue: () => { throw new Error("broken"); } });
    const p = await broken.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(p.capture).toBeNull();
    expect(p.nodes.every(n => n.secret || n.role === "frame")).toBe(true);
  });
});
