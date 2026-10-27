/**
 * The prompt window's controller (app/main/remote/prompt-window.ts; §8.6) and its page's press logic: one card at a
 * time in order, cancel and dismiss, answers only from its own page and only for the card on screen, secrets handed
 * on once and never logged, the field emptied when its value is sent, and consent cards that count only with the hash
 * of their own text. Plain Node with fakes for the window and ipcMain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_IPC, type PromptAnswer, type PromptCard } from "../../app/shared/remote-ui";
import { consentHash, consentPanel, createPromptWindow, createPromptWindowController, validConsent, validPromptCard, type ConsentAnswer } from "../../app/main/remote/prompt-window";
import { PROMPT_ARM_MS, consentHashText, pressResult, promptView } from "../../app/renderer/prompt/copy";
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

  it("refuses a malformed card, a duplicate id and a consent question through ask", async () => {
    const { ctl, windows } = setup();
    await expect(ctl.ask({ id: "", kind: "touch", host: "x" })).resolves.toMatchObject({ ok: false });
    await expect(ctl.ask({ id: "x", kind: "secret", secret: "pin", host: "x", prompt: "" } as unknown as PromptCard)).resolves.toMatchObject({ ok: false });
    await expect(ctl.ask({ id: "c", kind: "consent", n: 1, consent: commandsCard() })).resolves.toMatchObject({ ok: false });
    expect(windows).toHaveLength(0);
    void ctl.ask(password("dup"));
    await expect(ctl.ask(password("dup"))).resolves.toEqual({ id: "dup", ok: false });
  });

  it("answers an SSH prompt no at once when no window can be made, so ssh never waits on it", async () => {
    const ctl = createPromptWindowController({ create: () => { throw new Error("no display"); }, ipc: new FakeIpc(), log, os: "linux" });
    await expect(ctl.ask(password("a"))).resolves.toEqual({ id: "a", ok: false });
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
    expect(pressResult(password(), ok(password()), field, 0, 0)).toEqual({ kind: "wait", focusField: true });
    field.value = "hunter2";
    expect(pressResult(password(), ok(password()), field, 0, 0)).toEqual({ kind: "answer", answer: { id: "p1", ok: true, value: "hunter2" } });
    expect(field.value).toBe("");
  });

  it("cancels at once, and arms Trust and connect and a consent yes for a moment", () => {
    const field = { value: "keep" };
    expect(pressResult(hostKey(), cancel(hostKey()), field, 0, 0)).toEqual({ kind: "cancel", id: "h1" });
    expect(pressResult(hostKey(), ok(hostKey()), field, PROMPT_ARM_MS - 1, 0)).toEqual({ kind: "wait", focusField: false });
    expect(pressResult(hostKey(), ok(hostKey()), field, PROMPT_ARM_MS, 0)).toEqual({ kind: "answer", answer: { id: "h1", ok: true } });
    expect(field.value).toBe("keep");
    const consent: PromptCard = { id: "consent-1", kind: "consent", n: 1, consent: commandsCard() };
    expect(pressResult(consent, ok(consent), field, 10, 0).kind).toBe("wait");
    expect(pressResult(consent, ok(consent), field, PROMPT_ARM_MS, 0)).toMatchObject({ kind: "consent", id: "consent-1", sha256: commandsCard().sha256 });
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
