/**
 * The prompt window's controller (app/main/remote/prompt-window.ts; §8.6) and its page's press logic: one card at a
 * time in order, cancel and dismiss, answers only from its own page and only for the card on screen, secrets handed
 * on once and never logged, the field emptied when its value is sent, and consent cards that count only with the hash
 * of their own text. Plain Node with fakes for the window and ipcMain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_IPC, type PromptAnswer, type PromptCard } from "../../app/shared/remote-ui";
import {
  PROMPT_FOCUS_CHECK_MS, PROMPT_SIZE, consentHash, consentPanel, createPromptWindow, createPromptWindowController, fitBounds, promptSizeOf, validConsent, validPromptCard, type ConsentAnswer,
} from "../../app/main/remote/prompt-window";
import {
  CONSENT_READ_HINT, KEYBOARD_ELSEWHERE_HINT, PROMPT_ARM_MS, consentHashText, judgeRead, moreBelow, pressResult, promptHint, promptView, readIn, readThrough,
} from "../../app/renderer/prompt/copy";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../../app/main/targets/types";
import type { Logger } from "../../app/main/logger";
import type { ConsentPanel } from "../../app/shared/consent";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Handler = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  ons = new Map<string, Handler[]>();
  handles = new Map<string, Handler>();
  on(channel: string, fn: Handler) { this.ons.set(channel, [...(this.ons.get(channel) ?? []), fn]); }
  handle(channel: string, fn: Handler) { this.handles.set(channel, fn); }
  send(channel: string, sender: WebContentsLike, ...args: unknown[]) { for (const fn of this.ons.get(channel) ?? []) fn({ sender }, ...args); }
  invoke(channel: string, sender: WebContentsLike) { return this.handles.get(channel)!({ sender }); }
}

let nextId = 500;
class FakeWindow implements BrowserWindowLike {
  webContents = { id: nextId++, sent: [] as unknown[][], send(channel: string, ...args: unknown[]) { this.sent.push([channel, ...args]); } };
  visible = false; minimized = false; destroyed = false; onTop = true; focused = false;
  /** Set by windows.ts when the page crashed, before it closes the window (review #91). */
  pageGone?: boolean;
  /** The page crashed: windows.ts marks the window and destroys it, which closes it. */
  crash() { this.pageGone = true; this.close(); }
  private closedFns: (() => void)[] = [];
  show() { this.visible = true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.focused = true; }
  close() { this.destroyed = true; this.visible = false; for (const f of this.closedFns) f(); }
  moveTop() { /* no-op */ }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isDestroyed() { return this.destroyed; }
  isAlwaysOnTop() { return this.onTop; }
  isFocused() { return this.focused; }
  setAlwaysOnTop(f: boolean) { this.onTop = f; }
  setBounds() { /* no-op */ }
  setContentProtection() { /* no-op */ }
  on(event: string, fn: () => void) { if (event === "closed") this.closedFns.push(fn); }
  shown(): PromptCard | null { const s = this.webContents.sent.filter(x => x[0] === PROMPT_IPC.show); return (s[s.length - 1]?.[1] ?? null) as PromptCard | null; }
}

const logs: unknown[] = [];
const log: Logger = {
  debug: (m, f) => logs.push([m, f]), info: (m, f) => logs.push([m, f]), warn: (m, f) => logs.push([m, f]), error: (m, f) => logs.push([m, f]),
  child: () => log, file: "",
};

function setup() {
  const ipc = new FakeIpc();
  const windows: FakeWindow[] = [];
  const ctl = createPromptWindowController({ create: () => { const w = new FakeWindow(); windows.push(w); return w; }, ipc, log, os: "linux" });
  const win = () => windows[windows.length - 1];
  const page = () => win().webContents;
  const consents: ConsentAnswer[] = [];
  ctl.onConsent(a => consents.push(a));
  return { ipc, ctl, windows, win, page, consents };
}

const password = (id = "p1"): PromptCard => ({ id, kind: "secret", secret: "password", host: "build-01", login: "deploy", prompt: "deploy@build-01's password: " });
const hostKey = (id = "h1"): PromptCard => ({ id, kind: "host-key", host: "build-01", address: "203.0.113.7", fingerprint: "SHA256:abc" });
const commandsCard = (): ConsentPanel => consentPanel({ feature: "commands", os: "linux", target: "local", targetLabel: "This computer" });

beforeEach(() => { logs.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("the prompt window's queue", () => {
  it("shows one card at a time, in the order asked, and hides when none is left", async () => {
    const { ipc, ctl, win, page } = setup();
    const a = ctl.ask(password("a"));
    const b = ctl.ask(hostKey("b"));
    expect(win().shown()?.id).toBe("a");
    expect(win().visible).toBe(true);
    expect(win().focused).toBe(true);
    expect((ipc.invoke(PROMPT_IPC.show, page()) as PromptCard).id).toBe("a");
    ipc.send(PROMPT_IPC.answer, page(), { id: "a", ok: true, value: "hunter2" });
    await expect(a).resolves.toEqual({ id: "a", ok: true, value: "hunter2" });
    expect(win().shown()?.id).toBe("b");
    ipc.send(PROMPT_IPC.cancel, page(), { id: "b" });
    await expect(b).resolves.toEqual({ id: "b", ok: false });
    expect(win().visible).toBe(false);
    expect(JSON.stringify(logs)).not.toContain("hunter2");
  });

  it("dismisses a card shown or waiting, answering it no", async () => {
    const { ctl, win } = setup();
    const a = ctl.ask(password("a"));
    const b = ctl.ask(password("b"));
    ctl.dismiss("b");
    await expect(b).resolves.toEqual({ id: "b", ok: false });
    expect(win().shown()?.id).toBe("a");
    ctl.dismiss("a");
    await expect(a).resolves.toEqual({ id: "a", ok: false });
    ctl.dismiss("nope");
  });

  it("refuses a malformed card, a duplicate id and a consent question through ask, saying it was refused (review #193)", async () => {
    const { ctl, windows } = setup();
    await expect(ctl.ask({ id: "", kind: "touch", host: "x" })).resolves.toMatchObject({ ok: false, refused: true });
    await expect(ctl.ask({ id: "x", kind: "secret", secret: "pin", host: "x", prompt: "" } as unknown as PromptCard)).resolves.toMatchObject({ ok: false, refused: true });
    await expect(ctl.ask({ id: "c", kind: "consent", n: 1, consent: commandsCard() })).resolves.toMatchObject({ ok: false, refused: true });
    // A server's keyboard-interactive question too long to show, and a host name too long: nobody was asked.
    await expect(ctl.ask({ id: "long", kind: "secret", secret: "other", host: "build-01", prompt: "x".repeat(2001) })).resolves.toEqual({ id: "long", ok: false, refused: true });
    await expect(ctl.ask({ id: "host", kind: "secret", secret: "password", host: "h".repeat(256), prompt: "Password: " })).resolves.toEqual({ id: "host", ok: false, refused: true });
    expect(windows).toHaveLength(0);
    void ctl.ask(password("dup"));
    await expect(ctl.ask(password("dup"))).resolves.toEqual({ id: "dup", ok: false, refused: true });
  });

  it("answers an SSH prompt no at once when no window can be made, so ssh never waits on it, saying it was refused", async () => {
    const ctl = createPromptWindowController({ create: () => { throw new Error("no display"); }, ipc: new FakeIpc(), log, os: "linux" });
    await expect(ctl.ask(password("a"))).resolves.toEqual({ id: "a", ok: false, refused: true });
    ctl.showConsent(1, commandsCard());
    expect(ctl.consentReady(1)).toBe(false);
  });

  it("makes no window, and listens to nothing, until a card needs one", () => {
    const { ipc, ctl, windows } = setup();
    expect(windows).toHaveLength(0);
    expect(ipc.ons.size + ipc.handles.size).toBe(0);
    expect(ctl.consentReady(1)).toBe(false);
    ctl.show();
    expect(windows).toHaveLength(0);
  });
});

describe("answers", () => {
  it("are taken only from the window's own page, only for the card on screen", async () => {
    const { ipc, ctl, page } = setup();
    const a = ctl.ask(password("a"));
    const stranger = { id: 1, send: () => undefined };
    ipc.send(PROMPT_IPC.answer, stranger, { id: "a", ok: true, value: "x" });
    ipc.send(PROMPT_IPC.cancel, stranger, { id: "a" });
    expect(ipc.invoke(PROMPT_IPC.show, stranger)).toBeNull();
    ipc.send(PROMPT_IPC.answer, page(), { id: "b", ok: true, value: "x" });
    ipc.send(PROMPT_IPC.answer, page(), "a");
    let done = false;
    void a.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(logs.filter(l => (l as unknown[])[0] === "prompt.ipc_refused")).toHaveLength(3);
    ipc.send(PROMPT_IPC.answer, page(), { id: "a", ok: true, value: "x" });
    await expect(a).resolves.toEqual({ id: "a", ok: true, value: "x" });
  });

  it("hand on a secret only as one line of at most 1 KiB; anything else is a cancel", async () => {
    for (const value of ["", "a\nb", "a\rb", "a\0b", "x".repeat(1025), 42]) {
      const { ipc, ctl, page } = setup();
      const a = ctl.ask(password());
      ipc.send(PROMPT_IPC.answer, page(), { id: "p1", ok: true, value });
      await expect(a).resolves.toEqual({ id: "p1", ok: false });
    }
  });

  it("trust a host key only with its own button; a changed key or a touch card can only close", async () => {
    const a = setup();
    const p1 = a.ctl.ask(hostKey());
    a.ipc.send(PROMPT_IPC.answer, a.page(), { id: "h1", ok: true });
    await expect(p1).resolves.toEqual({ id: "h1", ok: true });
    const b = setup();
    const p2 = b.ctl.ask({ id: "c1", kind: "host-key-changed", host: "build-01" });
    b.ipc.send(PROMPT_IPC.answer, b.page(), { id: "c1", ok: true });
    await expect(p2).resolves.toEqual({ id: "c1", ok: false });
    const c = setup();
    const p3 = c.ctl.ask({ id: "t1", kind: "touch", host: "build-01" });
    c.ipc.send(PROMPT_IPC.answer, c.page(), { id: "t1", ok: true });
    await expect(p3).resolves.toEqual({ id: "t1", ok: false });
  });

  it("cancel an SSH prompt when the user closes the window, and show the next card", async () => {
    const { ctl, windows } = setup();
    const a = ctl.ask(password("a"));
    const b = ctl.ask(password("b"));
    windows[0].close();
    await expect(a).resolves.toEqual({ id: "a", ok: false });
    expect(windows).toHaveLength(2);
    expect(windows[1].shown()?.id).toBe("b");
    ctl.dispose();
    await expect(b).resolves.toEqual({ id: "b", ok: false });
  });

  it("refuse an SSH prompt whose page crashed: nobody could answer it, so it isn't the user's Cancel (cross-review X8)", async () => {
    // A host key, a password and a touch card: each is answered as refused (connections then says Ember couldn't show
    // the question, with Try again, instead of ending the connection quietly as a Cancel), and the next card shows.
    const { ctl, windows } = setup();
    const a = ctl.ask(hostKey("h"));
    const b = ctl.ask(password("p"));
    const c = ctl.ask({ id: "t", kind: "touch", host: "build-01" });
    windows[0].crash();
    await expect(a).resolves.toEqual({ id: "h", ok: false, refused: true });
    expect(windows[1].shown()?.id).toBe("p");
    windows[1].crash();
    await expect(b).resolves.toEqual({ id: "p", ok: false, refused: true });
    windows[2].crash();
    await expect(c).resolves.toEqual({ id: "t", ok: false, refused: true });
    // The user's own close of a new window is their Cancel, as before.
    const d = ctl.ask(password("d"));
    windows[3].close();
    await expect(d).resolves.toEqual({ id: "d", ok: false });
  });
});

describe("consent cards", () => {
  it("count a yes only with the hash of their own text, and anything else as Not now", () => {
    const { ipc, ctl, page, consents } = setup();
    const c = commandsCard();
    ctl.showConsent(4, c);
    expect(page().sent.at(-1)).toEqual([PROMPT_IPC.show, { id: "consent-4", kind: "consent", n: 4, consent: c }]);
    ipc.send(PROMPT_IPC.answer, page(), { id: "consent-4", ok: true, sha256: "0".repeat(64) });
    expect(consents).toEqual([{ n: 4, answer: "deny", sha256: c.sha256 }]);
    ctl.showConsent(5, c);
    ipc.send(PROMPT_IPC.answer, page(), { id: "consent-5", ok: true, sha256: c.sha256 });
    expect(consents[1]).toEqual({ n: 5, answer: "once", sha256: c.sha256 });
    ctl.showConsent(6, c);
    ipc.send(PROMPT_IPC.cancel, page(), { id: "consent-6" });
    expect(consents[2]).toEqual({ n: 6, answer: "deny", sha256: c.sha256 });
  });

  it("are never shown when their hash isn't of their own text", () => {
    const { ctl, windows } = setup();
    ctl.showConsent(1, { ...commandsCard(), body: ["Something else"] });
    ctl.showConsent(2, { ...commandsCard(), sha256: "x" });
    expect(windows).toHaveLength(0);
    expect(validConsent(commandsCard())).toBe(true);
    expect(validPromptCard({ id: "c", kind: "consent-direct", consent: { ...commandsCard(), title: "Changed" } })).toBe(false);
  });

  it("are ready only while shown, in a visible window on top or focused, and go when hidden", () => {
    const { ctl, win } = setup();
    ctl.showConsent(3, commandsCard());
    expect(ctl.consentReady(3)).toBe(true);
    expect(ctl.consentReady(4)).toBe(false);
    win().minimized = true;
    expect(ctl.consentReady(3)).toBe(false);
    win().minimized = false;
    win().onTop = false;
    win().focused = false;
    expect(ctl.consentReady(3)).toBe(false);
    win().focused = true;
    expect(ctl.consentReady(3)).toBe(true);
    ctl.hideConsent(3);
    expect(ctl.consentReady(3)).toBe(false);
    expect(win().visible).toBe(false);
  });

  it("asked directly, are refused when their page crashed, not answered Not now (cross-review X8)", async () => {
    const { ctl, windows } = setup();
    const a = ctl.ask({ id: "d1", kind: "consent-direct", consent: commandsCard() });
    windows[0].crash();
    await expect(a).resolves.toEqual({ id: "d1", ok: false, refused: true });
    // A Confirmer's consent question stays asked, as when the user closes the window.
    ctl.showConsent(3, commandsCard());
    windows[1].crash();
    ctl.show();
    expect(windows[2].shown()).toMatchObject({ id: "consent-3" });
  });

  it("stay asked when the window is closed, and come back when asked again", () => {
    const { ctl, windows } = setup();
    ctl.showConsent(3, commandsCard());
    windows[0].close();
    expect(windows).toHaveLength(1);
    ctl.showConsent(3, commandsCard());
    expect(windows).toHaveLength(2);
    expect(windows[1].shown()).toMatchObject({ id: "consent-3" });
  });

  it("come back with the bubble's Read it while their question is still asked, and not once it was hidden", () => {
    const { ipc, ctl, win, page, consents } = setup();
    const c = commandsCard();
    ctl.showConsent(7, c);
    // Answered, but (say) too soon for the Confirmer: the card left, the question is still asked.
    ipc.send(PROMPT_IPC.answer, page(), { id: "consent-7", ok: true, sha256: c.sha256 });
    expect(consents).toEqual([{ n: 7, answer: "once", sha256: c.sha256 }]);
    expect(win().shown()).toBeNull();
    ctl.show();
    expect(win().shown()).toMatchObject({ id: "consent-7", n: 7 });
    expect(win().visible).toBe(true);
    // The question ended: hidden, and Read it brings nothing back.
    ctl.hideConsent(7);
    expect(win().shown()).toBeNull();
    ctl.show();
    expect(win().shown()).toBeNull();
    expect(win().visible).toBe(false);
  });

  it("asked directly (settings' switch), answer yes with their hash", async () => {
    const { ipc, ctl, page } = setup();
    const c = commandsCard();
    const p = ctl.ask({ id: "direct", kind: "consent-direct", consent: c });
    ipc.send(PROMPT_IPC.answer, page(), { id: "direct", ok: true, sha256: c.sha256 });
    await expect(p).resolves.toEqual({ id: "direct", ok: true, sha256: c.sha256 });
  });

  it("hash exactly title + newline + body lines (ConsentPanel.sha256)", () => {
    const c = commandsCard();
    expect(c.sha256).toBe(createHash("sha256").update(`${c.title}\n${c.body.join("\n")}`).digest("hex"));
    expect(consentHash(c)).toBe(c.sha256);
    expect(consentHashText({ title: "T", body: ["a", "b"] })).toBe("T\na\nb");
  });
});

describe("the page's buttons (pure press logic)", () => {
  const ok = (card: PromptCard) => promptView(card).buttons.find(b => b.id === "ok")!;
  const cancel = (card: PromptCard) => promptView(card).buttons.find(b => b.id === "cancel")!;

  it("empties the field the moment a secret is sent, and waits for one to be typed", () => {
    const field = { value: "" };
    expect(pressResult(password(), ok(password()), field, 0, 0, true)).toEqual({ kind: "wait", focusField: true });
    field.value = "hunter2";
    expect(pressResult(password(), ok(password()), field, 0, 0, true)).toEqual({ kind: "answer", answer: { id: "p1", ok: true, value: "hunter2" } });
    expect(field.value).toBe("");
  });

  it("cancels at once, and arms Trust and connect and a consent yes for a moment", () => {
    const field = { value: "keep" };
    expect(pressResult(hostKey(), cancel(hostKey()), field, 0, 0, true)).toEqual({ kind: "cancel", id: "h1" });
    expect(pressResult(hostKey(), ok(hostKey()), field, PROMPT_ARM_MS - 1, 0, true)).toEqual({ kind: "wait", focusField: false });
    expect(pressResult(hostKey(), ok(hostKey()), field, PROMPT_ARM_MS, 0, true)).toEqual({ kind: "answer", answer: { id: "h1", ok: true } });
    expect(field.value).toBe("keep");
    const consent: PromptCard = { id: "consent-1", kind: "consent", n: 1, consent: commandsCard() };
    expect(pressResult(consent, ok(consent), field, 10, 0, true).kind).toBe("wait");
    expect(pressResult(consent, ok(consent), field, PROMPT_ARM_MS, 0, true)).toMatchObject({ kind: "consent", id: "consent-1", sha256: commandsCard().sha256 });
  });

  it("keeps a consent card's yes off until every word of it has been in view, and Not now on (review #182, #270)", () => {
    const field = { value: "" };
    const consent: PromptCard = { id: "consent-1", kind: "consent", n: 1, consent: commandsCard() };
    const direct: PromptCard = { id: "d", kind: "consent-direct", consent: commandsCard() };
    for (const c of [consent, direct]) {
      expect(pressResult(c, ok(c), field, 60_000, 0, false)).toEqual({ kind: "wait", focusField: false });
      expect(pressResult(c, ok(c), field, 60_000, 0, true).kind).toBe("consent");
      expect(pressResult(c, cancel(c), field, 0, 0, false)).toEqual({ kind: "cancel", id: c.id });
    }
    // Other cards don't wait on it (their words are short, and a secret must not wait on a scroll).
    expect(pressResult(hostKey(), ok(hostKey()), field, PROMPT_ARM_MS, 0, false).kind).toBe("answer");
    field.value = "x";
    expect(pressResult(password(), ok(password()), field, 0, 0, false).kind).toBe("answer");
  });

  it("judges every word in view only with nothing left below, and never for a block it can't measure", () => {
    expect(readThrough({ scrollTop: 0, scrollHeight: 198, clientHeight: 198 }, true)).toBe(true);
    expect(readThrough({ scrollTop: 0, scrollHeight: 382, clientHeight: 198 }, true)).toBe(false);
    expect(moreBelow({ scrollTop: 0, scrollHeight: 382, clientHeight: 198 })).toBe(true);
    expect(readThrough({ scrollTop: 183.5, scrollHeight: 382, clientHeight: 198 }, true)).toBe(true);
    expect(readThrough({ scrollTop: 100, scrollHeight: 382, clientHeight: 198 }, true)).toBe(false);
    expect(readThrough({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, true)).toBe(false);
    expect(readThrough({ scrollTop: Number.NaN, scrollHeight: 10, clientHeight: 10 }, true)).toBe(false);
    expect(CONSENT_READ_HINT).toBe("Scroll down to read it all first.");
  });

  it("counts nothing as read while the page's typeface is still loading: the words may yet run on below (review #182)", () => {
    // A new window's first card is laid out in a fallback face until Ember's own has loaded. Measured in one at
    // 1280x600: 466 px of words fit the 466 px block, and 478 px ran on below it once Ember's face had loaded.
    const fits = { scrollTop: 0, scrollHeight: 466, clientHeight: 466 };
    expect(readThrough(fits, false)).toBe(false);
    expect(readThrough(fits, true)).toBe(true);
    const atEnd = { scrollTop: 12, scrollHeight: 478, clientHeight: 466 };
    expect(readThrough(atEnd, false)).toBe(false);
    expect(readThrough(atEnd, true)).toBe(true);
    // The fade is the layout's own: on while words are below what shows, whatever the typeface.
    expect(moreBelow(fits)).toBe(false);
    expect(moreBelow({ scrollTop: 0, scrollHeight: 478, clientHeight: 466 })).toBe(true);
    // The page says whether its fonts have loaded, read after the words are laid out (that starts the load), and judges
    // again when they finish (read from the page's source).
    const src = readFileSync(new URL("../../app/renderer/prompt/main.ts", import.meta.url), "utf8");
    const judge = /function judge\(\): void \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(judge).toMatch(/const m = \{[^\n]*scrollHeight[^\n]*\};\n\s*const fontsLoaded = document\.fonts\.status === "loaded";/);
    expect(judge).toMatch(/gate = judgeRead\(gate, m, fontsLoaded, layoutNow\(\)\);/);
    expect(src).toMatch(/document\.fonts\.addEventListener\("loadingdone", judge\);/);
    expect(src).toMatch(/document\.fonts\.addEventListener\("loadingerror", judge\);/);
  });

  it("counts a card read through only at the text size it has now: main sets it after a new window's first card is drawn (cross-review X7)", () => {
    // Measured in Ember's prompt window at Larger text on a 1280x500 screen: drawn before main's text size landed, the
    // SSH card fitted (339 of 339 px); at Larger it ran on below (407 px in 325).
    const before: { seen: boolean; layout: string } = { seen: false, layout: "default" };
    const fitted = judgeRead(before, { scrollTop: 0, scrollHeight: 339, clientHeight: 339 }, true, "default");
    expect(readIn(fitted, "default")).toBe(true);
    // The text size lands: not read through until it has been judged at it, and then only if every word was in view.
    expect(readIn(fitted, "larger")).toBe(false);
    const larger = judgeRead(fitted, { scrollTop: 0, scrollHeight: 407, clientHeight: 325 }, true, "larger");
    expect(larger).toEqual({ seen: false, layout: "larger" });
    expect(promptHint({ consent: true, seen: readIn(larger, "larger"), more: true, field: false, focused: true, sinceShownMs: 5000 })).toBe(CONSENT_READ_HINT);
    // Scrolled to the end at that size: read through, and it stays so when scrolled back up.
    const atEnd = judgeRead(larger, { scrollTop: 82, scrollHeight: 407, clientHeight: 325 }, true, "larger");
    expect(readIn(atEnd, "larger")).toBe(true);
    expect(readIn(judgeRead(atEnd, { scrollTop: 0, scrollHeight: 407, clientHeight: 325 }, true, "larger"), "larger")).toBe(true);
    // Another size again starts unread; one where everything fits is read through at once (with the typeface in).
    expect(readIn(judgeRead(atEnd, { scrollTop: 0, scrollHeight: 300, clientHeight: 339 }, false, "default"), "default")).toBe(false);
    expect(readIn(judgeRead(atEnd, { scrollTop: 0, scrollHeight: 300, clientHeight: 339 }, true, "default"), "default")).toBe(true);
  });

  it("judges the words again when main sets the text size, and lets the yes go only when read through at it (read from the page's source)", () => {
    const src = readFileSync(new URL("../../app/renderer/prompt/main.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const layoutNow = \(\): string => document\.documentElement\.dataset\.textSize \?\? "default";/);
    expect(src).toMatch(/new MutationObserver\(\(\) => judge\(\)\)\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \["data-text-size"\] \}\);/);
    // The yes and its press go by the gate at the size the card has now, never by a flag kept from another size.
    expect(src).toMatch(/const seenNow = \(\): boolean => readIn\(gate, layoutNow\(\)\);/);
    expect(src).toMatch(/pressResult\(card, b, field, Date\.now\(\), shownAt, seenNow\(\)\)/);
    expect(src).toMatch(/const unread = !!card && isConsent\(card\) && !seenNow\(\);/);
    expect(src).not.toMatch(/\bseen = true\b/);
  });

  it("keeps the window's title \"Ember\" and builds nothing from HTML (read from the page's source)", () => {
    const src = readFileSync(new URL("../../app/renderer/prompt/main.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/document\.title\s*=/);
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("makes Cancel the default on a host key card and leaves Enter pressing nothing on a consent card", () => {
    expect(promptView(hostKey()).buttons.filter(b => b.isDefault).map(b => b.id)).toEqual(["cancel"]);
    expect(promptView({ id: "c", kind: "consent", n: 1, consent: commandsCard() }).buttons.filter(b => b.isDefault)).toEqual([]);
    expect(promptView(password()).buttons.filter(b => b.isDefault).map(b => b.id)).toEqual(["ok"]);
  });
});

describe("the contract's factory", () => {
  it("returns the controller with PromptUi and the consent methods", () => {
    const p = createPromptWindow({ create: () => new FakeWindow(), ipc: new FakeIpc(), log, os: "darwin" });
    for (const k of ["ask", "dismiss", "showConsent", "hideConsent", "consentReady", "dispose"]) expect(typeof (p as unknown as Record<string, unknown>)[k]).toBe("function");
    const answer: Promise<PromptAnswer> = p.ask(password());
    p.dispose();
    return expect(answer).resolves.toEqual({ id: "p1", ok: false });
  });
});

describe("the window's size", () => {
  it("is fitted to each card before it shows: large for a consent card, small for an SSH prompt (review #182, #270)", async () => {
    const ipc = new FakeIpc();
    const windows: (FakeWindow & { fits: { width: number; height: number }[] })[] = [];
    const ctl = createPromptWindowController({
      create: () => { const w = Object.assign(new FakeWindow(), { fits: [] as { width: number; height: number }[] }); windows.push(w); return Object.assign(w, { fit: (s: { width: number; height: number }) => { w.fits.push(s); } }); },
      ipc, log, os: "linux",
    });
    ctl.showConsent(1, commandsCard());
    const pw = ctl.ask(password());
    expect(windows[0].fits).toEqual([PROMPT_SIZE.consent]);
    ctl.hideConsent(1);
    expect(windows[0].fits).toEqual([PROMPT_SIZE.consent, PROMPT_SIZE.card]);
    expect(windows[0].shown()?.id).toBe("p1");
    ctl.dismiss("p1");
    await pw;
    expect(PROMPT_SIZE.card).toEqual({ width: 440, height: 300 });
    expect(PROMPT_SIZE.consent.height).toBeGreaterThanOrEqual(520);
    expect(promptSizeOf({ id: "d", kind: "consent-direct", consent: commandsCard() })).toBe(PROMPT_SIZE.consent);
    expect(promptSizeOf(hostKey())).toBe(PROMPT_SIZE.card);
    // A window without the hook (tests, an older factory) is shown as before.
    const plain = setup();
    plain.ctl.showConsent(2, commandsCard());
    expect(plain.win().visible).toBe(true);
  });

  it("keeps the window's centre and stays inside the work area, with a margin where there is room", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    // Centred 440×300 grows to 520×600 around the same centre.
    expect(fitBounds({ x: 740, y: 370, width: 440, height: 300 }, PROMPT_SIZE.consent, area)).toEqual({ x: 700, y: 220, width: 520, height: 600 });
    // Near the bottom edge: moved up into the area.
    expect(fitBounds({ x: 100, y: 900, width: 440, height: 300 }, PROMPT_SIZE.consent, area)).toEqual({ x: 60, y: 424, width: 520, height: 600 });
    // A small screen (or a display left of the primary): capped to it, never off it.
    expect(fitBounds({ x: -1000, y: 100, width: 440, height: 300 }, PROMPT_SIZE.consent, { x: -1280, y: 0, width: 1280, height: 480 }))
      .toEqual({ x: -1000 + 220 - 260, y: 16, width: 520, height: 448 });
    expect(fitBounds({ x: 0, y: 0, width: 440, height: 300 }, PROMPT_SIZE.consent, { x: 0, y: 0, width: 20, height: 20 })).toMatchObject({ width: 1, height: 1 });
  });
});

describe("the keyboard (review #235)", () => {
  /** A window whose keyboard hook and focus the test controls. */
  function keyboardRig(o: { hook?: boolean; gets?: boolean } = {}) {
    const ipc = new FakeIpc();
    const notes: [string, string][] = [];
    const windows: (FakeWindow & { takes: number })[] = [];
    const ctl = createPromptWindowController({
      create: () => {
        const w = Object.assign(new FakeWindow(), { takes: 0 });
        // focus() says it worked, but the OS may not give the keyboard (macOS: another app active; Windows: foreground lock).
        w.focus = () => { w.focused = o.gets ?? false; };
        windows.push(w);
        return o.hook === false ? w : Object.assign(w, { takeKeyboard: () => { w.takes++; w.focused = o.gets ?? false; } });
      },
      ipc, log, os: "darwin", notify: (title: string, body: string) => { notes.push([title, body]); },
    });
    return { ctl, windows, notes, page: () => windows[0].webContents, ipc };
  }

  it("asks main to bring the window to the front with the keyboard, as settings does, for every card", () => {
    const { ctl, windows } = keyboardRig({ gets: true });
    void ctl.ask(password());
    expect(windows[0].takes).toBe(1);
    ctl.showConsent(1, commandsCard());
    ctl.dismiss("p1");
    expect(windows[0].shown()?.id).toBe("consent-1");
    expect(windows[0].takes).toBe(2);
  });

  it("tells the user in a notification when a card that takes typing didn't get the keyboard, once", () => {
    vi.useFakeTimers();
    const { ctl, notes } = keyboardRig({ gets: false });
    void ctl.ask(password());
    expect(notes).toEqual([]);
    vi.advanceTimersByTime(PROMPT_FOCUS_CHECK_MS);
    expect(notes).toEqual([["Click Ember's window before you type", "Ember is asking for your password, and the keyboard is still in another app."]]);
    vi.advanceTimersByTime(10 * PROMPT_FOCUS_CHECK_MS);
    expect(notes).toHaveLength(1);
  });

  it("stays quiet when the window got the keyboard, when the card went first, and for a card nothing is typed into", () => {
    vi.useFakeTimers();
    const got = keyboardRig({ gets: true });
    void got.ctl.ask(password());
    vi.advanceTimersByTime(PROMPT_FOCUS_CHECK_MS);
    expect(got.notes).toEqual([]);
    const gone = keyboardRig({ gets: false });
    void gone.ctl.ask(password());
    gone.ctl.dismiss("p1");
    vi.advanceTimersByTime(PROMPT_FOCUS_CHECK_MS);
    expect(gone.notes).toEqual([]);
    const consent = keyboardRig({ gets: false });
    consent.ctl.showConsent(1, commandsCard());
    void consent.ctl.ask(hostKey());
    vi.advanceTimersByTime(PROMPT_FOCUS_CHECK_MS);
    expect(consent.notes).toEqual([]);
  });

  it("names what each secret card asks for, and still shows and focuses a window without the hook", () => {
    vi.useFakeTimers();
    for (const [secret, what] of [["passphrase", "your SSH key's passphrase"], ["code", "a verification code"], ["other", "an answer"]] as const) {
      const r = keyboardRig({ gets: false, hook: false });
      void r.ctl.ask({ id: "s", kind: "secret", secret, host: "build-01", prompt: "Enter passphrase for key '/home/ana/.ssh/id_ed25519':" });
      expect(r.windows[0].visible).toBe(true);
      vi.advanceTimersByTime(PROMPT_FOCUS_CHECK_MS);
      expect(r.notes).toEqual([["Click Ember's window before you type", `Ember is asking for ${what}, and the keyboard is still in another app.`]]);
    }
  });
});

describe("the page's hint line", () => {
  it("says to read a consent card through first, and on a card that takes typing that the keyboard is elsewhere (review #182, #235)", () => {
    const base = { consent: false, seen: false, more: true, field: false, focused: true, sinceShownMs: 5000 };
    expect(promptHint({ ...base, consent: true })).toBe(CONSENT_READ_HINT);
    expect(promptHint({ ...base, consent: true, seen: true, more: false })).toBe("");
    // Not read yet with nothing below: only while the typeface loads (the yes stays off, and nothing says to scroll).
    expect(promptHint({ ...base, consent: true, more: false })).toBe("");
    expect(promptHint({ ...base, field: true, focused: false })).toBe(KEYBOARD_ELSEWHERE_HINT);
    expect(KEYBOARD_ELSEWHERE_HINT).toBe("Click here before you type: the keyboard is still in another app.");
    // Not while the window is still being given the keyboard, not once it has it, and not on a card nothing is typed into.
    expect(promptHint({ ...base, field: true, focused: false, sinceShownMs: 100 })).toBe("");
    expect(promptHint({ ...base, field: true, focused: true })).toBe("");
    expect(promptHint({ ...base, focused: false })).toBe("");
  });
});

describe("the page's semantics", () => {
  const html = readFileSync(new URL("../../app/renderer/prompt/index.html", import.meta.url), "utf8");

  it("keeps the main landmark and puts the dialog inside it, named by its title and described by its words (review #60)", () => {
    const main = /<main\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(main).not.toBe("");
    expect(main).not.toMatch(/\brole=/);
    const dialog = /<(\w+)\b[^>]*\brole="dialog"[^>]*>/.exec(html);
    expect(dialog?.[1]).toBe("div");
    expect(dialog?.[0]).toMatch(/\bid="card"/);
    expect(dialog?.[0]).toMatch(/aria-labelledby="title"/);
    expect(dialog?.[0]).toMatch(/aria-describedby="body"/);
    expect(html.indexOf(main)).toBeLessThan(html.indexOf(dialog![0]));
    expect(html.indexOf(dialog![0])).toBeLessThan(html.indexOf("</main>"));
  });
});
