/**
 * The prompt window's controller ("Ember", §8.6): one card at a time for what an SSH connection needs from the user (a
 * host key to trust, a password, a key's passphrase, a code, a security key touch, any other prompt) and for the
 * first-use consent cards (§8.4), whether a Confirmer question (showConsent) or asked directly (ask, settings' switches).
 *
 * Plain Node (L13): the window comes from `create()` (windows.ts's createPromptWindow, S0b), the IPC from `ipc`. An
 * answer is taken only from this window's own page, only for the card on screen; a secret goes only to whoever asked
 * for it (the askpass server, through `ask`'s promise) and is never logged or kept. A consent yes counts only with the
 * hash of the exact text that was shown, and a consent card whose hash doesn't match its own text is never shown.
 */

import { createHash } from "node:crypto";
import { PROMPT_IPC, type PromptAnswer, type PromptCard } from "../../shared/remote-ui";
import type { OS } from "../../shared/shortcuts";
import type { ConsentPanel } from "../../shared/consent";
import type { Logger } from "../logger";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../targets/types";
import type { PromptUi } from "./types";
import { consentHashText, consentText, type ConsentInput } from "../../renderer/prompt/copy";

/** sha256 of a consent card's title and body (ConsentPanel.sha256). */
export function consentHash(c: { title: string; body: readonly string[] }): string {
  return createHash("sha256").update(consentHashText(c), "utf8").digest("hex");
}

/** A consent card ready for a question's panel or for `ask` (§8.4): its exact text for the PC's OS, and its hash. */
export function consentPanel(i: ConsentInput): ConsentPanel {
  const t = consentText(i);
  return { feature: i.feature, target: i.target, targetLabel: i.targetLabel, ...t, sha256: consentHash(t) };
}

/** A consent answer from its card's own buttons (already checked: this window, the card on screen, the hash). */
export interface ConsentAnswer { n: number; answer: "once" | "deny"; sha256: string }

/** What the controller adds for the targets runtime (beyond the contract; see the package report). */
export interface PromptWindowExtras {
  /** Answers to consent questions (showConsent): wire to confirmer.answer(`q${n}:${answer}`, "panel", { sha256 }). */
  onConsent(fn: (a: ConsentAnswer) => void): () => void;
  /** Brings the window back up (the bubble's "Read it"), if it has a card. */
  show(): void;
  owns(sender: WebContentsLike): boolean;
}

export type PromptWindowController = PromptUi & PromptWindowExtras & {
  showConsent(n: number, c: ConsentPanel): void; hideConsent(n: number): void; consentReady(n: number): boolean; dispose(): void;
};

/** A rectangle in DIP: a window's bounds, a display's work area. */
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * The page's size for each kind of card (§8.6), inside the window's title bar and borders. An SSH prompt fits the small
 * card; a consent card is two screens of text in it, with what it can reach and the stop chord below the fold, so it
 * gets a window that shows all of it (review #182, #270), capped to the work area. Whatever still runs on below (a long
 * key path, larger text, a short screen) keeps the yes off until it has been read (copy.ts readThrough).
 */
export const PROMPT_SIZE = { card: { width: 440, height: 300 }, consent: { width: 520, height: 600 } } as const;
export type PromptSize = (typeof PROMPT_SIZE)[keyof typeof PROMPT_SIZE];

/** The size a card's window takes. */
export const promptSizeOf = (card: PromptCard): PromptSize =>
  (card.kind === "consent" || card.kind === "consent-direct" ? PROMPT_SIZE.consent : PROMPT_SIZE.card);

/** Bounds for a window of `size`, centred where the window is now, inside `area` (with `margin` where there is room). */
export function fitBounds(now: Rect, size: { width: number; height: number }, area: Rect, margin = 16): Rect {
  const width = Math.max(1, Math.min(size.width, area.width - 2 * margin));
  const height = Math.max(1, Math.min(size.height, area.height - 2 * margin));
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const x = clamp(Math.round(now.x + now.width / 2 - width / 2), area.x + margin, area.x + area.width - margin - width);
  const y = clamp(Math.round(now.y + now.height / 2 - height / 2), area.y + margin, area.y + area.height - margin - height);
  return { x, y, width, height };
}

/** The prompt window as windows.ts makes it: the contract's window, plus the hooks the controller uses when present. */
export interface PromptWindowLike extends BrowserWindowLike {
  /** Sizes the window for a card (fitBounds within its display's work area). */
  fit?(size: { width: number; height: number }): void;
  /**
   * Shows the window and gives it the keyboard as main brings settings to the front (review #235): macOS activates
   * Ember (a hotkey or the ask box leaves the user's app active, so focus() alone doesn't make it the key window), and
   * Windows asks through the input backend (foreground rules). Without it: show() and focus().
   */
  takeKeyboard?(): void;
}

/** How long after a card that takes typing shows the window must have the keyboard, or the user is told (review #235). */
export const PROMPT_FOCUS_CHECK_MS = 800;

/** What a card that takes typing asks for, in the notification that says the keyboard is elsewhere. */
const ASKS_FOR = { password: "your password", passphrase: "your SSH key's passphrase", code: "a verification code", other: "an answer" } as const;

/** A secret the page may send: one line, no NUL, at most this long (askpass hands it to ssh as one line). */
const SECRET_MAX = 1024;

interface Entry {
  card: PromptCard;
  /** For `ask`: its answer. Consent questions answer through onConsent instead. */
  resolve?: (a: PromptAnswer) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** A consent card whose fields are well formed and whose hash is of its own text. */
export function validConsent(c: unknown): c is ConsentPanel {
  if (!isObj(c)) return false;
  return ["commands", "wsl", "ssh"].includes(c.feature as string) && str(c.target, 200, 1) && str(c.targetLabel, 200, 1) && str(c.title, 500, 1)
    && Array.isArray(c.body) && c.body.length >= 1 && c.body.length <= 16 && c.body.every(l => str(l, 2000, 1)) && str(c.yes, 50, 1) && str(c.no, 50, 1)
    && isSha(c.sha256) && consentHash({ title: c.title as string, body: c.body as string[] }) === c.sha256;
}

/** A card the window can show (every field the page draws, of the right type and size). */
export function validPromptCard(c: unknown): c is PromptCard {
  if (!isObj(c) || !str(c.id, 128, 1)) return false;
  const host = str(c.host, 255, 1);
  switch (c.kind) {
    case "host-key": return host && str(c.address, 255, 1) && str(c.fingerprint, 512, 1);
    case "host-key-changed": case "touch": return host;
    case "secret":
      return host && ["password", "passphrase", "code", "other"].includes(c.secret as string) && str(c.prompt, 2000)
        && (c.via === undefined || str(c.via, 255, 1)) && (c.login === undefined || str(c.login, 255, 1));
    case "consent": return typeof c.n === "number" && Number.isSafeInteger(c.n) && c.n >= 0 && validConsent(c.consent);
    case "consent-direct": return validConsent(c.consent);
    default: return false;
  }
}

/** What the prompt window is made from. `notify`: an OS notification (main's), for a card the keyboard didn't reach. */
export interface PromptWindowOptions {
  create: () => PromptWindowLike;
  ipc: IpcLike;
  log: Logger;
  os: OS;
  notify?: (title: string, body: string) => void;
}

/** The prompt window, as connections and the targets runtime use it. */
export function createPromptWindow(o: PromptWindowOptions):
  PromptUi & { showConsent(n: number, c: ConsentPanel): void; hideConsent(n: number): void; consentReady(n: number): boolean; dispose(): void } {
  return createPromptWindowController(o);
}

/** createPromptWindow with its extras typed: the same object (the targets runtime may call this name instead). */
export function createPromptWindowController(o: PromptWindowOptions): PromptWindowController {
  /** Logs, never letting a logger that fails stop the fail-closed path it reports. */
  const note = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => {
    try { o.log[level](msg, fields); } catch { /* nothing else to do: the caller goes on failing closed */ }
  };
  let win: PromptWindowLike | null = null;
  let disposed = false;
  /** The card on screen is queue[0]. */
  const queue: Entry[] = [];
  const consentFns = new Set<(a: ConsentAnswer) => void>();
  /**
   * Consent questions shown and not yet hidden (the targets runtime hides each when its question ends). A card the user
   * answered leaves the window at once, but if the Confirmer didn't take that answer (too soon, or while Ember moved the
   * pointer) the question is still asked: the bubble's "Read it" (show()) brings its card back instead of leaving it
   * unanswerable until it expires.
   */
  const consents = new Map<number, ConsentPanel>();

  const live = (): PromptWindowLike | null => (win && !win.isDestroyed() ? win : null);
  const owns = (sender: WebContentsLike | undefined): boolean => {
    const w = live();
    return !!w && !!sender && typeof sender.id === "number" && sender.id === w.webContents.id;
  };
  const safe = (what: string, f: () => void) => {
    try { f(); } catch (err) { note("warn", "prompt.window_call_failed", { what, err }); }
  };

  function ensure(): PromptWindowLike | null {
    if (disposed) return null;
    const w0 = live();
    if (w0) return w0;
    let w: PromptWindowLike;
    try { w = o.create(); } catch (err) {
      note("error", "prompt.window_failed", { err });
      return null;
    }
    win = w;
    try { wire(); } catch (err) { note("error", "prompt.ipc_failed", { err }); }
    w.on("closed", () => {
      if (win !== w) return;
      win = null;
      // Closed with a card up: an SSH prompt is cancelled (ssh gets no answer) and the next card, if any, shows; a
      // consent question stays asked, to come back with the bubble's "Read it", and expires as "no" if it doesn't.
      const head = queue[0];
      if (head && head.card.kind !== "consent") finish(head, { id: head.card.id, ok: false });
    });
    return w;
  }

  function push(): void {
    const w = live();
    if (!w) return;
    safe("send", () => w.webContents.send(PROMPT_IPC.show, queue[0]?.card ?? null));
  }

  /** The card on screen, in a window that takes the keyboard (it takes typing); hidden when there is none. */
  function reveal(): void {
    if (!queue.length) {
      const w = live();
      // The page lets go of the card too (so the same card shown again later is drawn afresh, its buttons live).
      push();
      if (w) safe("hide", () => { if (w.isVisible()) w.hide(); });
      return;
    }
    const w = ensure();
    if (!w) {
      // No window to ask in: an SSH prompt is answered no at once, as refused (nobody can answer it, and ssh mustn't
      // wait); a consent question stays asked and expires as "no".
      const head = queue[0];
      if (head.card.kind !== "consent") finish(head, { id: head.card.id, ok: false, refused: true });
      return;
    }
    // On the display the user is on, and every workspace (windows.ts's placement: review #272). First, so the card's
    // size below is fitted to that display's work area.
    safe("place", () => { const p = w as typeof w & { placeNearUser?: () => void; setOnAllWorkspaces?: (on: boolean) => void }; p.placeNearUser?.(); p.setOnAllWorkspaces?.(true); });
    // Sized for the card before it is drawn and shown (review #182, #270).
    const size = promptSizeOf(queue[0].card);
    if (typeof w.fit === "function") safe("fit", () => w.fit?.(size));
    push();
    safe("show", () => {
      w.show();
      w.moveTop();
      if (typeof w.takeKeyboard === "function") w.takeKeyboard();
      else w.focus();
    });
    checkKeyboard(w, queue[0]);
  }

  /**
   * A card that takes typing whose window didn't get the keyboard (macOS with another app active, Windows' foreground
   * lock, a window manager that prevents focus stealing): a notification says so, once per card, so nobody types a
   * secret into another app. The page says so on the card too.
   */
  let focusTimer: ReturnType<typeof setTimeout> | null = null;
  const warned = new Set<string>();
  function checkKeyboard(w: PromptWindowLike, e: Entry): void {
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = null;
    const card = e.card;
    if (card.kind !== "secret" || !o.notify || warned.has(card.id)) return;
    focusTimer = setTimeout(() => {
      focusTimer = null;
      if (disposed || queue[0] !== e || live() !== w) return;
      let has: boolean;
      try { has = w.isFocused(); } catch { has = false; } // a window that can't say has to be clicked
      if (has) return;
      warned.add(card.id);
      try { o.notify?.("Click Ember's window before you type", `Ember is asking for ${ASKS_FOR[card.secret]}, and the keyboard is still in another app.`); } catch (err) { note("warn", "prompt.notify_failed", { err }); }
    }, PROMPT_FOCUS_CHECK_MS);
  }

  /** Answers a card (an `ask` card's promise) and moves to the next. */
  function finish(e: Entry, a: PromptAnswer): void {
    const at = queue.indexOf(e);
    if (at < 0) return;
    queue.splice(at, 1);
    warned.delete(e.card.id);
    e.resolve?.(a);
    if (at === 0) reveal();
  }

  function enqueue(e: Entry): void {
    queue.push(e);
    if (queue.length === 1) reveal();
  }

  // ───── Messages from the page (each from this window's own page only, every field checked) ─────
  // Wired when the window is first made: no window, no handlers (commands off, nothing new anywhere).
  let wired = false;
  function wire(): void {
    if (wired) return;
    wired = true;
    const refused = (channel: string) => note("warn", "prompt.ipc_refused", { channel });

    o.ipc.handle(PROMPT_IPC.show, e => {
      if (disposed || !owns(e?.sender)) { refused(PROMPT_IPC.show); return null; }
      return queue[0]?.card ?? null;
    });

    o.ipc.on(PROMPT_IPC.answer, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(PROMPT_IPC.answer); return; }
      const head = queue[0];
      if (!head || !isObj(raw) || raw.id !== head.card.id || typeof raw.ok !== "boolean") return;
      const card = head.card;
      const id = card.id;
      if (card.kind === "consent" || card.kind === "consent-direct") {
        // The yes counts only with the hash of the text that was shown; anything else is a no.
        const yes = raw.ok && raw.sha256 === card.consent.sha256;
        if (raw.ok && !yes) note("warn", "prompt.consent_hash_mismatch", { feature: card.consent.feature });
        if (card.kind === "consent") {
          const a: ConsentAnswer = { n: card.n, answer: yes ? "once" : "deny", sha256: card.consent.sha256 };
          finish(head, { id, ok: yes });
          for (const fn of [...consentFns]) safe("consent", () => fn(a));
        } else {
          finish(head, yes ? { id, ok: true, sha256: card.consent.sha256 } : { id, ok: false });
        }
        return;
      }
      if (card.kind === "secret") {
        // One line of at most 1 KiB, no NUL: anything else can't be handed to ssh, so it is a cancel (never logged).
        const v = raw.value;
        const good = raw.ok && typeof v === "string" && v.length > 0 && v.length <= SECRET_MAX && !/[\0\r\n]/.test(v);
        finish(head, good ? { id, ok: true, value: v as string } : { id, ok: false });
        return;
      }
      // A host key is trusted only by its own button; a changed key and a touch card can only be closed.
      finish(head, { id, ok: card.kind === "host-key" && raw.ok });
    });

    o.ipc.on(PROMPT_IPC.cancel, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(PROMPT_IPC.cancel); return; }
      const head = queue[0];
      if (!head || !isObj(raw) || raw.id !== head.card.id) return;
      if (head.card.kind === "consent") {
        const a: ConsentAnswer = { n: head.card.n, answer: "deny", sha256: head.card.consent.sha256 };
        finish(head, { id: head.card.id, ok: false });
        for (const fn of [...consentFns]) safe("consent", () => fn(a));
        return;
      }
      finish(head, { id: head.card.id, ok: false });
    });
  }

  return {
    ask(card) {
      if (disposed || !validPromptCard(card) || card.kind === "consent" || queue.some(e => e.card.id === card.id)) {
        note("warn", "prompt.card_refused", { kind: (card as { kind?: unknown })?.kind });
        // Nobody was asked: the caller says so, not that the user said no (review #193).
        return Promise.resolve({ id: (card as { id?: string })?.id ?? "", ok: false, refused: true });
      }
      return new Promise<PromptAnswer>(resolve => enqueue({ card, resolve }));
    },

    dismiss(id) {
      const e = queue.find(x => x.card.id === id);
      if (e) finish(e, { id, ok: false });
    },

    showConsent(n, c) {
      if (disposed) return;
      if (!Number.isSafeInteger(n) || n < 0 || !validConsent(c)) { note("error", "prompt.consent_refused", { n }); return; }
      consents.set(n, c);
      const existing = queue.find(x => x.card.kind === "consent" && x.card.n === n);
      // Asked again (the bubble's "Read it"): the same card comes back up.
      if (existing) { if (queue[0] === existing) reveal(); return; }
      enqueue({ card: { id: `consent-${n}`, kind: "consent", n, consent: c } });
    },

    hideConsent(n) {
      consents.delete(n);
      const e = queue.find(x => x.card.kind === "consent" && x.card.n === n);
      if (e) finish(e, { id: e.card.id, ok: false });
    },

    consentReady(n) {
      const w = live();
      const head = queue[0];
      if (!w || !head || head.card.kind !== "consent" || head.card.n !== n) return false;
      try {
        return w.isVisible() && !w.isMinimized() && (w.isAlwaysOnTop() || w.isFocused());
      } catch { return false; } // a window that can't say isn't ready
    },

    onConsent(fn) {
      consentFns.add(fn);
      return () => { consentFns.delete(fn); };
    },

    show() {
      if (disposed) return;
      // A consent question still asked whose card went (answered, but the answer wasn't taken): it comes back.
      for (const [n, c] of consents) {
        if (!queue.some(x => x.card.kind === "consent" && x.card.n === n)) queue.push({ card: { id: `consent-${n}`, kind: "consent", n, consent: c } });
      }
      if (queue.length) reveal();
    },

    owns: sender => owns(sender),

    dispose() {
      if (disposed) return;
      disposed = true;
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = null;
      for (const e of queue.splice(0)) e.resolve?.({ id: e.card.id, ok: false });
      consentFns.clear();
      consents.clear();
      const w = live();
      win = null;
      if (w) safe("close", () => w.close());
    },
  };
}
