/**
 * The Secure Form's controller (owner decision of 2026-11-12, PLAN.md §2 "Approvals"): Ember's own window that asks
 * the person, once, for a login, a card or contact details for one app or site. Only main opens it (ask()); one form
 * at a time, the next waiting. Every word it shows is built by main (VaultFormView, shared/vault.ts formWords) from
 * the kind and the destination's identity, never from model or screen text.
 *
 * The values come from this window's own page only (its webContents, checked first), for the form on screen only, as
 * `unknown` checked whole (checkValues: only that kind's parts, each a bounded string); they go straight to `keep`,
 * which seals them, and are never logged, kept here, sent back to a page or put in an answer (VaultSubmitResult and
 * VaultAnswer carry none). Each form has a window of its own, closed once it is answered, so nothing typed outlives it
 * in a renderer. Cancel, Esc and the window's close keep nothing. Plain Node: the window comes from `create()`
 * (windows.ts createVaultWindow), the IPC from `ipc`.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../targets/types";
import {
  PART_SPEC, SECRET_PARTS, VAULT_IPC, VAULT_KINDS, VAULT_PARTS, checkValues, formWords, validDestination,
  type VaultDestination, type VaultFormView, type VaultKind, type VaultSubmitResult,
} from "../../shared/vault";
import type { VaultKept } from "./store";

/**
 * How a form ended: `saved` (kept, sealed), `cancelled` (the person closed a form that could have kept what they
 * typed: their no), `unavailable` (no window could be shown, its page crashed, or the form could keep nothing: shown
 * without a keyring, or closed after a Save the keyring, the disk or a full vault refused. Nobody said no: integ-y-2)
 * or `stopped` (Stop, or Ember quitting).
 */
export type VaultAnswer = "saved" | "cancelled" | "unavailable" | "stopped";

/** What main asks the form for: the kind, the destination, how to name it, and whether a keyring can keep it. */
export interface VaultFormRequest {
  kind: VaultKind;
  dest: VaultDestination;
  /** The destination as the form names it: "github.com", "Thunderbird" (main's, from the identity). */
  where: string;
  /** For a site, the browser the form is asked from ("Firefox"): from the window system, never a model. */
  via: string | null;
  /** This computer can keep values safely; false: the form says so, and Save keeps nothing. */
  keyring: boolean;
}

/** The window as windows.ts makes it: the contract's window, its size for the form and its way of taking the keyboard. */
export interface VaultWindowLike extends BrowserWindowLike {
  takeKeyboard?(): void;
  /** Its page crashed (set before windows.ts closes it): nobody could answer its form. */
  pageGone?: boolean;
}

/** The form's size by kind (the page's own; windows.ts adds the frame and grows it with the text). Words that don't fit scroll. */
export const VAULT_FORM_SIZE: Readonly<Record<VaultKind, { width: number; height: number }>> = {
  login: { width: 440, height: 400 }, card: { width: 440, height: 520 }, contact: { width: 440, height: 560 },
};

export interface VaultFormOptions {
  /** A new window for one form of `kind` (windows.ts createVaultWindow). */
  create: (kind: VaultKind) => VaultWindowLike;
  ipc: IpcLike;
  log: Logger;
  /** Seals and keeps one entry (VaultService.keep: VaultStore.add, where the vault may still be used; else `gone`). */
  keep: (kind: VaultKind, dest: VaultDestination, values: unknown) => Promise<VaultKept | { ok: false; why: "gone" }>;
}

export interface VaultFormController {
  /** Shows a form for `req` (after any form already up) and resolves with how it ended. */
  ask(req: VaultFormRequest): Promise<VaultAnswer>;
  /**
   * Stop: every form closes, each answered `stopped`, and none is asked again. A Save already pressed still finishes
   * keeping what the person typed (their own act, not Ember's), but its form is answered `stopped`.
   */
  stop(): void;
  /** Whether `sender` is the form's own page now. */
  owns(sender: WebContentsLike | undefined): boolean;
  dispose(): void;
}

interface Entry {
  view: VaultFormView; req: VaultFormRequest; resolve: (a: VaultAnswer) => void;
  /** Why this form could keep nothing (no keyring when it was shown, or what its last Save was refused for); null while it could. */
  unkept: "keyring" | "write" | "full" | "gone" | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The form's view for a request: main's words, each part's label and limits. */
export function formView(id: string, req: VaultFormRequest): VaultFormView {
  const site = "site" in req.dest;
  const words = formWords(req.kind, req.where, site, site ? req.via : null);
  return {
    id, kind: req.kind, ...words, keyring: req.keyring,
    parts: VAULT_PARTS[req.kind].map(part => ({
      part, label: PART_SPEC[part].label, secret: SECRET_PARTS.has(part), required: PART_SPEC[part].required, max: PART_SPEC[part].max, multiline: PART_SPEC[part].multiline === true,
    })),
  };
}

/** A request well formed: a kind, a destination, short names without controls. */
function validRequest(r: VaultFormRequest): boolean {
  // eslint-disable-next-line no-control-regex -- a name with a control character in it isn't one main built
  const name = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
  return isObj(r) && VAULT_KINDS.includes(r.kind) && validDestination(r.dest) && name(r.where, 300) && (r.via === null || name(r.via, 100)) && typeof r.keyring === "boolean";
}

export function createVaultForm(o: VaultFormOptions): VaultFormController {
  const note = (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) => {
    try { o.log[level](msg, fields); } catch { /* the form goes on failing closed whatever the log does */ }
  };
  const queue: Entry[] = [];
  let win: VaultWindowLike | null = null;
  let disposed = false;
  /** The form on screen is being kept (a Save under way): a second Save and a Cancel are refused until it is done. */
  let saving = false;
  /** Its window was closed while that Save was under way: the Save's own end answers the form (kept, or not). */
  let closedSaving = false;

  const live = (): VaultWindowLike | null => (win && !win.isDestroyed() ? win : null);
  const owns = (sender: WebContentsLike | undefined): boolean => {
    const w = live();
    return !!w && !!sender && typeof sender.id === "number" && sender.id === w.webContents.id;
  };
  const safe = (what: string, f: () => void) => {
    try { f(); } catch (err) { note("warn", "vault.window_call_failed", { what, err }); }
  };

  /** Answers the form on screen, closes its window (nothing typed stays in a renderer) and shows the next. */
  function finish(e: Entry, a: VaultAnswer): void {
    const at = queue.indexOf(e);
    if (at < 0) return;
    queue.splice(at, 1);
    // Closing a form that could keep nothing is not the person's no (integ-y-2): nobody could have said yes.
    if (a === "cancelled" && e.unkept) a = "unavailable";
    note("info", "vault.form_done", { kind: e.req.kind, answer: a, ...(a === "unavailable" && e.unkept ? { unkept: e.unkept } : {}) });
    e.resolve(a);
    if (at !== 0) return;
    const w = live();
    win = null;
    if (w) safe("close", () => w.close());
    reveal();
  }

  function reveal(): void {
    if (disposed || !queue.length || live()) return;
    const head = queue[0];
    let w: VaultWindowLike;
    try { w = o.create(head.req.kind); } catch (err) {
      note("error", "vault.window_failed", { err });
      finish(head, "unavailable");
      return;
    }
    win = w;
    w.on("closed", () => {
      if (win !== w) return;
      win = null;
      const e = queue[0];
      if (e !== head) return;
      // Closed while its Save was being kept: what the Save comes to answers the form.
      if (saving) { closedSaving = true; return; }
      // Closed with its form up: the person's own close keeps nothing; a crashed page couldn't be answered.
      finish(e, w.pageGone === true ? "unavailable" : "cancelled");
    });
    note("info", "vault.form_shown", { kind: head.req.kind });
    safe("show", () => {
      w.show();
      w.moveTop();
      if (typeof w.takeKeyboard === "function") w.takeKeyboard();
      else w.focus();
    });
  }

  let wired = false;
  function wire(): void {
    if (wired) return;
    wired = true;
    const refused = (channel: string) => note("warn", "vault.ipc_refused", { channel });
    o.ipc.handle(VAULT_IPC.form, e => {
      if (disposed || !owns(e?.sender)) { refused(VAULT_IPC.form); return null; }
      return queue[0]?.view ?? null;
    });
    o.ipc.handle(VAULT_IPC.submit, async (e, id, values): Promise<VaultSubmitResult> => {
      if (disposed || !owns(e?.sender)) { refused(VAULT_IPC.submit); return { ok: false, why: "gone" }; }
      const head = queue[0];
      if (!head || saving || typeof id !== "string" || id !== head.view.id) return { ok: false, why: "gone" };
      if (!head.req.keyring) return { ok: false, why: "keyring" };
      // Checked whole here (the store checks again): only this kind's parts, each a bounded string. A refusal names the
      // part, never its value.
      const checked = checkValues(head.req.kind, values);
      if (!checked.ok) return { ok: false, why: "invalid", ...(checked.part ? { part: checked.part } : {}) };
      saving = true;
      closedSaving = false;
      let kept: VaultKept | { ok: false; why: "gone" };
      try { kept = await o.keep(head.req.kind, head.req.dest, checked.values); } catch { kept = { ok: false, why: "write" }; } finally { saving = false; }
      const closed = closedSaving;
      closedSaving = false;
      if (queue[0] !== head) return { ok: false, why: "gone" }; // stopped while it was being kept
      if (!kept.ok) {
        // Refused by the keyring, the disk or a full vault (never the person's slip): this form kept nothing it was asked to.
        if (kept.why !== "invalid") head.unkept = kept.why;
        // Its window went meanwhile: nobody is left to try again, and nothing was kept.
        if (closed) finish(head, "cancelled");
        return { ok: false, why: kept.why };
      }
      finish(head, "saved");
      return { ok: true };
    });
    o.ipc.on(VAULT_IPC.cancel, (e, id) => {
      if (disposed || !owns(e?.sender)) { refused(VAULT_IPC.cancel); return; }
      const head = queue[0];
      if (!head || saving || typeof id !== "string" || id !== head.view.id) return;
      finish(head, "cancelled");
    });
  }

  wire();
  return {
    ask(req) {
      if (disposed || !validRequest(req)) {
        note("warn", "vault.form_refused", {});
        return Promise.resolve("unavailable");
      }
      return new Promise<VaultAnswer>(resolve => {
        queue.push({ view: formView(randomUUID(), req), req, resolve, unkept: req.keyring ? null : "keyring" });
        if (queue.length === 1) reveal();
      });
    },
    stop() {
      const all = queue.splice(0);
      const w = live();
      win = null;
      if (w) safe("close", () => w.close());
      for (const e of all) e.resolve("stopped");
    },
    owns: sender => owns(sender),
    dispose() {
      if (disposed) return;
      disposed = true;
      this.stop();
    },
  };
}
