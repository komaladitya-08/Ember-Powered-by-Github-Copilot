/**
 * A pretend app that gives everything back, for the vault's leak tests (test/unit/vault-leak.test.ts and
 * test/integration/vault-leak.test.ts; the slice's decision 7): a sign-in, a card and a contact form in one page of a
 * site, read through a pretend accessibility helper over a grey pretend screen. Whatever is filled into it, the app
 * repeats: in the field's own text, in a line under the form, in a link's name, in an error it raises and, after a
 * click, in its window's title. The tests fill every kind of entry into it with the canary values here and then look
 * for them everywhere Ember writes or sends anything. The one thing it never repeats outside its own field is the
 * card's security code, as no shop does: a secret that short is kept by its field alone (the redactor doesn't look
 * for it in other text, where a mark's place would give it away: review vault-3-x9-1).
 */

import fs from "node:fs";
import path from "node:path";
import { VAULT_FILL_UNAVAILABLE } from "../../../app/main/perception/sidecar";
import type { AxNode, AxWindow, Bounds, ReadWindowResult } from "../../../app/main/perception/sidecar";
import type { SecretBox } from "../../../app/main/agent/auth";
import type { VaultDestination, VaultKind } from "../../../app/shared/vault";

/** What is saved in the vault for the pretend site: every kind, every part. */
export const CANARY = {
  login: { user: "ada.canary-user@example.org", password: "Pw-CANARY&9x!\"q" },
  card: { cardName: "ADA CANARY-HOLDER", cardNumber: "4111111111111111", expiry: "12/27", securityCode: "8642" },
  contact: { name: "Ada Canarybird", email: "ada.contact-canary@example.org", phone: "+44 20 7946 0958", address: "1 Canary Wharf Row\nLondon E14 9ZZ" },
} as const;
export const SITE: VaultDestination = { site: "https://shop.example" };
export const ENTRIES: [VaultKind, VaultDestination, Record<string, string>][] = [["login", SITE, CANARY.login], ["card", SITE, CANARY.card], ["contact", SITE, CANARY.contact]];

/** A keyring that seals without the OS (the store never sees which). */
export const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed:${Buffer.from(s, "utf8").toString("hex")}`),
  decryptString: b => Buffer.from(b.toString().slice(7), "hex").toString("utf8"),
};

/** The fields, by the tool's own names for what goes in them. */
export const FIELDS = [
  { id: 1, what: "user name", role: "entry", name: "Username or email address", value: CANARY.login.user },
  { id: 2, what: "password", role: "password text", name: "Password", value: CANARY.login.password },
  { id: 3, what: "name on card", role: "entry", name: "Name on card", value: CANARY.card.cardName },
  { id: 4, what: "card number", role: "entry", name: "Card number", value: CANARY.card.cardNumber },
  { id: 5, what: "card expiry", role: "entry", name: "Expiry date", value: CANARY.card.expiry },
  { id: 6, what: "card security code", role: "entry", name: "Security code", value: CANARY.card.securityCode },
  { id: 7, what: "full name", role: "entry", name: "Full name", value: CANARY.contact.name },
  { id: 8, what: "email", role: "entry", name: "Email", value: CANARY.contact.email },
  /** The one field that takes no text by accessibility: the value is typed as keys. */
  { id: 9, what: "phone", role: "entry", name: "Phone", value: CANARY.contact.phone },
  { id: 10, what: "address", role: "entry", name: "Street address", value: CANARY.contact.address },
] as const;
export const TYPED_FIELD = 9;
export const ECHO = 11, REFRESH = 12, ACCOUNT = 13, PAGE = 100;

const FRAME: Bounds = { x: 0, y: 0, width: 800, height: 600 };
const EDIT = ["enabled", "sensitive", "editable", "focusable", "showing"];
/** Where field `id` is on the pretend screen. */
export const fieldBounds = (id: number): Bounds => ({ x: 100, y: 60 + 40 * id, width: 300, height: 30 });

/** Every form of every canary a text could hold. A short one counts only where no digit stands against it. */
const NEEDLES: [string, RegExp][] = [
  ...Object.values(CANARY).flatMap(kind => Object.entries(kind)).flatMap(([part, value]): [string, RegExp][] => {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    if (part === "cardNumber") return [[part, new RegExp([...value].join("[\\s.-]*"))]];
    if (part === "securityCode" || part === "expiry") return [[part, new RegExp(`(?<![\\d.:/-])${esc(value)}(?![\\d/])`)]];
    if (part === "address") return [[part, new RegExp(value.split(/\s+/).map(esc).join("(\\s|\\\\n|,)+"), "i")], ["address line", /Canary Wharf Row/i]];
    return [[part, new RegExp(esc(value), "i")], [`${part} as JSON`, new RegExp(esc(JSON.stringify(value).slice(1, -1)), "i")], [`${part} in an address`, new RegExp(esc(encodeURIComponent(value)), "i")]];
  }),
  ["any canary word", /canary/i],
];

/** The canaries `text` holds, by name (empty: none). */
export function canariesIn(text: string): string[] {
  return [...new Set(NEEDLES.filter(([, re]) => re.test(text)).map(([name]) => name))];
}

/** Every file under `dir`, as text (a sealed vault file and binary files included: the canaries are plain text). */
export function filesUnder(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ file: path.relative(dir, p), text: fs.readFileSync(p, "latin1") });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

export interface LeakyApp {
  /** What the accessibility helper is to Perception and to the worker. */
  sidecar: Record<string, (...args: never[]) => unknown>;
  /** The pretend screen: one window, grey pixels. */
  x11: Record<string, (...args: never[]) => unknown>;
  /** The worker's vault calls that reach the helper. */
  pages(id: number): Promise<string[]>;
  put(id: number, text: string): Promise<{ ok: boolean; took?: boolean }>;
  mark(id: number): Promise<void>;
  /** The borrowed keyboard: what it types goes into the field that has the keyboard. */
  cursor: { borrow: { borrow(fn: (hand: unknown) => Promise<void>, opts: { preflight?: (hand: unknown) => void }): Promise<void> }; findWindow(): number; setBorrowing(): void };
  clipboard: Record<string, (...args: never[]) => unknown>;
  /** What the app holds now, by field: proof that the fills happened. */
  held: Map<number, string>;
  /** How each field was filled. */
  how: Map<number, "accessibility" | "keys">;
  state: { clipboard: number; title: string; marked: Set<number>; borrows: number };
  window(): AxWindow;
}

/**
 * The app, its helper and its screen. `stderr`: where the helper's own complaints go (the real client logs each line at
 * debug level as `sidecar.stderr`); the pretend helper complains with the app's words, values and all.
 */
export function leakyApp(o: { stderr?: (line: string) => void } = {}): LeakyApp {
  const held = new Map<number, string>();
  const how = new Map<number, "accessibility" | "keys">();
  const state = { clipboard: 0, title: "Checkout — Mozilla Firefox", marked: new Set<number>(), borrows: 0, focused: 0 };
  const SECURITY_CODE = FIELDS.find(f => f.what === "card security code")!.id;
  const everything = () => [...held].filter(([id]) => id !== SECURITY_CODE).map(([, v]) => v).join(" | ");
  const window = (): AxWindow => ({ app: "firefox", pid: 42, path: "/w/1", name: state.title, role: "frame", active: true, bounds: FRAME });
  const nodes = (): AxNode[] => {
    const secret = (id: number, role: string) => state.marked.has(id) || role === "password text";
    return [
      { id: PAGE, parent: null, depth: 1, role: "document web", name: "Checkout", states: ["enabled", "sensitive"], bounds: { x: 0, y: 40, width: 800, height: 560 } },
      ...FIELDS.map((f): AxNode => ({ id: f.id, parent: PAGE, depth: 2, role: f.role, name: f.name, states: state.focused === f.id ? [...EDIT, "focused"] : EDIT, bounds: fieldBounds(f.id),
        // As the real helper: a field it knows is secret says nothing; any other says what it holds.
        ...(secret(f.id, f.role) ? (state.marked.has(f.id) ? { secret: true } : {}) : held.has(f.id) ? { text: held.get(f.id)! } : {}) })),
      { id: ECHO, parent: PAGE, depth: 2, role: "static", name: "", states: ["showing"], bounds: { x: 450, y: 100, width: 300, height: 60 }, ...(held.size ? { text: `You entered: ${everything()}` } : {}) },
      { id: REFRESH, parent: PAGE, depth: 2, role: "push button", name: "Refresh", states: ["enabled", "sensitive", "showing"], bounds: { x: 450, y: 200, width: 100, height: 30 } },
      { id: ACCOUNT, parent: PAGE, depth: 2, role: "link", name: held.get(8) ?? "Account", states: ["enabled", "sensitive", "showing"], bounds: { x: 450, y: 260, width: 300, height: 30 } },
    ];
  };
  const element = (id: number) => {
    const n = nodes().find(x => x.id === id);
    return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...(n.secret ? { secret: true } : {}), ...(n.text !== undefined ? { text: n.text } : {}) } : null;
  };
  const hand = {
    glideTo: async () => {},
    click: async () => { state.focused = TYPED_FIELD; },
    keys: async (k: string) => { if (/delete/i.test(k)) held.delete(state.focused); },
    type: async (t: string) => { held.set(state.focused, (held.get(state.focused) ?? "") + t); how.set(state.focused, "keys"); },
    checkTyping: () => {}, checkKeys: () => {}, scroll: async () => {},
  };
  return {
    held, how, state, window,
    sidecar: {
      readWindow: async (): Promise<ReadWindowResult> => ({ window: window(), nodes: nodes(), ms: 1 }),
      listWindows: async () => ({ windows: [window()] }),
      scaleElements: () => {}, scaleOf: () => 1,
      markSecret: async (ids: number[]) => { for (const id of ids) state.marked.add(id); },
      readElement: async (id: number) => element(id),
      shellOverlays: async () => ({ overlays: [] }),
      secretFields: async () => ({ fields: FIELDS.filter(f => state.marked.has(f.id) || f.role === "password text").map(f => ({ id: f.id, bounds: fieldBounds(f.id) })), complete: true, ms: 1 }),
      // The app answers a click on Refresh with an error that repeats everything it was given, and renames its window.
      doAction: async (id: number) => {
        if (id !== REFRESH) return { ok: true, after: element(id) };
        state.title = `Checkout (${held.get(8) ?? "nobody"}) — Mozilla Firefox`;
        o.stderr?.(`Traceback (most recent call last): GLib.Error: the form holds ${everything()}`);
        throw new Error(`the app refused: the form holds ${everything()}`);
      },
      setText: async () => { throw new Error("ordinary typing reached the helper"); },
      stop: () => {},
    } as never,
    x11: {
      stack: () => [{ id: 1, client: 2, pid: 42, title: state.title, wmClass: "firefox", ...FRAME, outer: FRAME, inner: FRAME, overrideRedirect: false }],
      focusWindow: () => null, activeWindow: () => null, clientWindows: () => [],
      capture: (x: number, y: number, width: number, height: number) => ({ x, y, width, height, bgra: Buffer.alloc(width * height * 4, 200) }),
    } as never,
    pages: async () => ["https://shop.example/checkout?step=2"],
    put: async (id, text) => {
      if (id === TYPED_FIELD) throw new Error(VAULT_FILL_UNAVAILABLE);
      state.marked.add(id); // secret before anything is written, as the helpers do
      held.set(id, text);
      how.set(id, "accessibility");
      return { ok: true, ...(id === 2 ? {} : { took: true }) };
    },
    mark: async id => { state.marked.add(id); },
    cursor: {
      borrow: { borrow: async (fn, opts) => { state.borrows++; opts.preflight?.(hand); await fn(hand); } },
      findWindow: () => 1, setBorrowing: () => undefined,
    },
    clipboard: {
      save: async () => { state.clipboard++; return { items: [] }; }, writeText: async () => { state.clipboard++; },
      restore: async () => { state.clipboard++; }, unchanged: async () => true,
    } as never,
  };
}
