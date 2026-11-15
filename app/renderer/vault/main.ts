/**
 * The Secure Form's page (the vault, owner decision of 2026-11-12): Ember's own box where the person types a login, a
 * card or contact details for one app or site, once. Every word it shows is main's (VaultFormView: built from the
 * kind and the destination's identity, never from a model or the screen), set as text nodes. Secret parts are typed
 * into password boxes. Save sends what was typed to main once, to be sealed; nothing main answers holds a value, and
 * the page keeps none once it is kept (main closes the window). Cancel, Esc and the window's close keep nothing. A
 * form whose window hasn't the keyboard says so, so nobody types a secret into another app.
 */

import {
  VAULT_FOCUS_GRACE_MS, VAULT_FORM_BUTTONS, VAULT_KEYBOARD_ELSEWHERE, VAULT_NO_KEYRING, VAULT_NOTHING_TYPED, VAULT_SAVING, checkValues, partLabel, partProblemText, vaultSaveProblem,
  type VaultFormView, type VaultPart, type VaultValues,
} from "../../shared/vault";
import type { VaultFormApi } from "./api";
import { saveHeldBack } from "./copy";

declare global { interface Window { emberVaultForm: VaultFormApi } }

const api = window.emberVaultForm;
const $ = (id: string) => document.getElementById(id)!;
const card = $("card") as HTMLFormElement;
const save = $("save") as HTMLButtonElement;
const cancel = $("cancel") as HTMLButtonElement;
const problem = $("problem");
const hint = $("hint");
let view: VaultFormView | null = null;
let shownAt = 0;
/** When the form took the keyboard: shown, or its window got the keyboard again. Save's Enter waits from here (integ-y-3). */
let keyboardAt = 0;
/** A Save is with main: a second one waits, and so does Cancel (main refuses both until it is done). */
let busy = false;
/** Kept, or closed: nothing more is sent. */
let done = false;
const boxes = new Map<VaultPart, HTMLInputElement | HTMLTextAreaElement>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Marks `part` as one that can't be kept, with its line under it (or clears it). */
function mark(part: VaultPart, text: string): void {
  const box = boxes.get(part);
  if (!box) return;
  if (text) box.setAttribute("aria-invalid", "true"); else box.removeAttribute("aria-invalid");
  $(`e-${part}`).textContent = text;
}

/** The keyboard's line: said once the window has had a moment to get the keyboard and hasn't. */
function judgeFocus(): void {
  const elsewhere = !!view && view.keyring && !done && !document.hasFocus() && Date.now() - shownAt >= VAULT_FOCUS_GRACE_MS;
  const text = elsewhere ? VAULT_KEYBOARD_ELSEWHERE : "";
  if (hint.textContent !== text) hint.textContent = text;
}
window.addEventListener("focus", () => { keyboardAt = Date.now(); judgeFocus(); });
window.addEventListener("blur", judgeFocus);

function setBusy(on: boolean): void {
  busy = on;
  // aria-disabled, not disabled: the button keeps the focus while main seals what was typed.
  save.setAttribute("aria-disabled", String(on));
  cancel.setAttribute("aria-disabled", String(on));
  if (on) problem.textContent = VAULT_SAVING;
}

function show(v: VaultFormView): void {
  view = v;
  shownAt = Date.now();
  keyboardAt = shownAt;
  $("title").textContent = v.title;
  $("where").textContent = v.where;
  boxes.clear();
  if (!v.keyring) {
    // No keyring: nothing can be kept, so nothing is asked for.
    $("lead").textContent = VAULT_NO_KEYRING;
    $("fields").replaceChildren();
    save.hidden = true;
    cancel.textContent = VAULT_FORM_BUTTONS.close;
    card.hidden = false;
    cancel.focus();
    return;
  }
  $("lead").textContent = v.lead;
  $("fields").replaceChildren(...v.parts.map(p => {
    const row = el("div", "field");
    const label = el("label", "", partLabel(p.label, p.required));
    label.htmlFor = `f-${p.part}`;
    const box = p.multiline ? el("textarea") : el("input");
    box.id = `f-${p.part}`;
    if (box instanceof HTMLInputElement) {
      box.type = p.secret ? "password" : p.part === "email" ? "email" : "text";
      if (p.part === "cardNumber" || p.part === "securityCode") box.inputMode = "numeric";
    } else box.rows = 3;
    box.autocomplete = "off";
    box.spellcheck = false;
    box.maxLength = p.max;
    if (p.required) box.setAttribute("aria-required", "true");
    box.setAttribute("aria-describedby", `e-${p.part}`);
    box.addEventListener("input", () => mark(p.part, ""));
    boxes.set(p.part, box);
    const error = el("p", "error");
    error.id = `e-${p.part}`;
    row.append(label, box, error);
    return row;
  }));
  save.textContent = VAULT_FORM_BUTTONS.save;
  cancel.textContent = VAULT_FORM_BUTTONS.cancel;
  card.hidden = false;
  boxes.get(v.parts[0].part)?.focus();
  setTimeout(judgeFocus, VAULT_FOCUS_GRACE_MS + 5);
}

function typed(): VaultValues {
  const values: VaultValues = {};
  for (const [part, box] of boxes) if (box.value) values[part] = box.value;
  return values;
}

/** Says which part can't be kept and puts the keyboard there. */
function refuse(part: VaultPart | undefined, text: string): void {
  if (part && boxes.has(part)) {
    mark(part, partProblemText(part));
    boxes.get(part)!.focus();
  }
  problem.textContent = text;
}

async function submit(): Promise<void> {
  if (!view || !view.keyring || busy || done) return;
  const shown = view;
  for (const part of boxes.keys()) mark(part, "");
  const values = typed();
  // The page's own check, so a slip is said before anything leaves it; main's check is the one that counts.
  const checked = checkValues(shown.kind, values);
  if (!checked.ok) {
    if (!checked.part && !Object.keys(values).length) { problem.textContent = VAULT_NOTHING_TYPED; boxes.values().next().value?.focus(); return; }
    refuse(checked.part, vaultSaveProblem("invalid"));
    return;
  }
  setBusy(true);
  let result: Awaited<ReturnType<VaultFormApi["submit"]>>;
  try { result = await api.submit(shown.id, values); } catch { result = { ok: false, why: "gone" }; }
  setBusy(false);
  if (result.ok) {
    // Kept: main closes this window; the boxes are emptied at once all the same.
    done = true;
    for (const box of boxes.values()) box.value = "";
    problem.textContent = "";
    return;
  }
  if (result.why === "keyring" || result.why === "gone") {
    // Nothing more can be saved from this form: only Close is left.
    done = true;
    for (const box of boxes.values()) { box.value = ""; box.disabled = true; }
    save.hidden = true;
    cancel.textContent = VAULT_FORM_BUTTONS.close;
    problem.textContent = vaultSaveProblem(result.why);
    cancel.focus();
    return;
  }
  refuse(result.why === "invalid" ? result.part : undefined, vaultSaveProblem(result.why));
  if (!(result.why === "invalid" && result.part)) save.focus();
}

function close(): void {
  if (!view || busy) return;
  for (const box of boxes.values()) box.value = "";
  api.cancel(view.id);
  // A form main no longer has (a refused Save's "gone") is closed by the page itself.
  if (done) window.close();
}

card.addEventListener("submit", e => {
  e.preventDefault();
  if (e.isTrusted) void submit();
});
cancel.addEventListener("click", e => { if (e.isTrusted) close(); });
// The form takes the keyboard as it opens, so keys meant for another app land here: an Enter that is a held key's
// repeat, or that comes before the form has had the keyboard for the prompt window's arm time, saves nothing
// (integ-y-3). Esc, Cancel and Close are taken at once.
window.addEventListener("keydown", e => {
  const target = e.target instanceof HTMLTextAreaElement ? "lines" : e.target === cancel ? "cancel" : "other";
  if (saveHeldBack(e, target, Date.now(), keyboardAt)) e.preventDefault();
}, true);
window.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !view) return;
  e.preventDefault();
  close();
});

void api.form().then(v => { if (v) show(v); }).catch(() => { /* no form for this window: it stays empty, and main closes it */ });
