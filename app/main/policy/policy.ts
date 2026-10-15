/**
 * The policy engine: every action a worker wants to take is described as a
 * structured ActionRequest and decided here, never by the model. Tiers follow
 * PLAN.md §5: read and reversible actions run automatically, risky ones need
 * the user's click, and some are never done by Ember at all.
 *
 * Labels come from the screen, so they are normalised before matching:
 * look-alike letters, invisible characters and typographic apostrophes can't
 * hide a "Delete" from the risky-word check.
 */

import { isNeverLook } from "../perception/elements";

export type Tier = "read" | "reversible" | "confirm" | "never";
export type Verdict = "allow" | "confirm" | "deny";

export type ActionKind = "read" | "click" | "toggle" | "text" | "select" | "value" | "setting" | "open_app"
  /** Tier 3: with the user's borrowed mouse and keyboard. */
  | "cursor_click" | "cursor_text" | "keys" | "scroll";

export type TextMode = "replace" | "insert" | "append";

export interface ActionRequest {
  taskId: string;
  kind: ActionKind;
  /** App name and window title the action touches ("" for settings; the app's name for launching). */
  app: string;
  window: string;
  element?: { role: string; name: string };
  /** For text: what will be typed; for settings: the new value; for keys: the combination. */
  value?: string;
  /** For text: replace everything, insert at the caret, or append. */
  mode?: TextMode;
  /** For text: what the field holds now (replacing a lot of it is confirmed). */
  currentText?: string;
  /** On Ember's own desk (its private display): no app grant needed, full input allowed. */
  onDesk?: boolean;
  /** The user's request this action serves (for the task-alignment check). */
  goal?: string;
}

export interface Decision {
  tier: Tier;
  verdict: Verdict;
  reason: string;
  /** Plain sentence for the confirmation bubble, built from the request (never model text). */
  prompt: string;
  /** Set when the app has no grant yet: confirming also asks to remember it. */
  needsGrant?: boolean;
  /** The action itself needs the user's OK every time, whatever the grant. */
  risky?: boolean;
  /** "Always in this app" may be offered (the administrator can turn grants off). */
  remember?: boolean;
  /** False when a risky action names nothing the user asked for (shown in the question). */
  aligned?: boolean;
  /** Ask every time: an earlier "Allow" in this task doesn't cover it. */
  everyTime?: boolean;
  /** The on-screen words that make it risky (checked against what the user asked for). */
  about?: string;
}

export type Grant = "observe" | "act";

export interface PolicyInputs {
  neverLook: () => string[];
  grants: () => Record<string, Grant>;
  /** Max actions per task per minute. */
  rateLimit?: number;
  now?: () => number;
  /** Administrator switches (admin.ts): acting at all, and asking before every action. */
  actionsAllowed?: () => boolean;
  confirmEveryAction?: () => boolean;
  allowGrants?: () => boolean;
  /** Is this app a terminal (Ember never opens or types into one)? */
  isTerminalApp?: (name: string) => boolean;
}

/** Latin look-alikes from Cyrillic and Greek, enough to keep "Dеlete" (Cyrillic е) from passing as harmless. */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ү": "y", "һ": "h",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
};

/** What a label says, ready for matching: compatibility forms folded, invisible characters gone, look-alikes mapped. */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC")
    .replace(/[\p{Cf}\u00ad]/gu, "")
    .replace(/[\u2019\u02bc\u2018`\u00b4]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase()
    .replace(/[\u0080-\uffff]/g, c => CONFUSABLES[c] ?? c);
}

/** Words on buttons that make an action hard to undo or visible to others. */
const RISKY = /\b(send|post|submit|publish|share|delete|remove|erase|discard|overwrite|replace|empty|format|buy|pay|order|purchase|checkout|install|uninstall|upload|transfer|reply|forward|sign|accept|approve|confirm|authori[sz]e|grant|trust|merge|run|execute|reset|clear|archive|revoke|unsubscribe|trash|wipe|destroy|quit|close without saving|don't save|log ?out|sign ?out|shut ?down|restart|reboot|power off)\b/;
/** Answers that agree to whatever a dialog asks: risky when the dialog's own title is about something risky. */
const AFFIRMATIVE = /^\s*(yes|ok|okay|continue|proceed|allow|confirm|do it|i understand|got it|agree)\b/;
/** Fields Ember never fills: secrets and payment details. */
const SECRET_FIELD = /\b(password|passphrase|passcode|pin|card ?number|credit ?card|cvv|cvc|security code|expir(y|ation)|iban|routing number|account number|one-time code|otp|2fa|recovery code|secret)\b/;
/** Windows Ember never acts in: authentication prompts and keyrings. */
const SECURITY_WINDOW = /\b(authenticat(e|ion) (is )?required|polkit|sudo|unlock (login )?keyring|password required|enter password|security settings|firewall)\b/;

/** Is this an authentication or security prompt (polkit, sudo, keyring…)? Ember stays out of those. */
export function isSecurityWindow(w: { app?: string; title?: string; name?: string }): boolean {
  return SECURITY_WINDOW.test(normalizeLabel(`${w.app ?? ""} ${w.title ?? w.name ?? ""}`)) || /polkit|gcr-prompter|pinentry|ssh-askpass/i.test(w.app ?? "");
}

export const isRiskyLabel = (s: string) => RISKY.test(normalizeLabel(s));
export const isSecretField = (s: string) => SECRET_FIELD.test(normalizeLabel(s));

const ACTIVATING_ROLES = /button|link|menu item|check box|radio|toggle|switch|tab/;
/** Keys that activate the focused control. */
const ACTIVATE_KEY = /^(return|enter|kp_enter|space)$/;
/** Shortcuts that delete, send, close or quit, whatever has focus. */
const DESTRUCTIVE_KEYS = new Set(["delete", "shift+delete", "ctrl+delete", "ctrl+shift+delete", "ctrl+return", "alt+return", "ctrl+shift+return",
  "alt+f4", "ctrl+q", "ctrl+w", "ctrl+shift+w", "ctrl+shift+q"]);
/** Desktop-level shortcuts (virtual terminals, the run dialog, the shell): never pressed by Ember. */
const SYSTEM_KEYS = /^(ctrl\+alt\+(f\d+|backspace|delete|del|t|l)|alt\+f[12]|super(\+.*)?|meta(\+.*)?|alt\+sysrq.*|ctrl\+alt\+tab)$/;

/** "Ctrl + Shift + Del" → "ctrl+shift+delete": one spelling for matching. */
export function normalizeKeys(keys: string): string {
  const alias: Record<string, string> = { control: "ctrl", del: "delete", enter: "return", esc: "escape", win: "super", cmd: "super" };
  return keys.toLowerCase().split("+").map(k => k.trim()).filter(Boolean).map(k => alias[k] ?? k).join("+");
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "all", "now", "you", "your", "button", "item"]);
const words = (s: string) => normalizeLabel(s).match(/[\p{L}\p{N}]{3,}/gu)?.filter(w => !STOP.has(w)) ?? [];
/** Rough stem, so "deleting", "deleted" and "delete" match. */
const stem = (w: string) => w.replace(/(ing|ed|es|s|e)$/, "");

/**
 * Task alignment: does a risky control's name share a word with what the user
 * asked for? "Send" in "send the report to Ana" does; "Delete all" while filling in
 * a form doesn't, and the question then says so (words on screen can't make it look asked-for).
 * When the control's name has a risky verb, that verb itself must be in the request:
 * "Delete all my form data" doesn't become asked-for by sharing "form" with "fill in the form".
 */
export function alignedWithGoal(goal: string | undefined, element: string): boolean {
  if (!goal) return true;
  const asked = new Set(words(goal).map(stem));
  const risky = words(element).filter(w => RISKY.test(w));
  if (risky.length) return risky.some(w => asked.has(stem(w)));
  return words(element).some(w => asked.has(stem(w)));
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const quote = (s: string) => `“${s.length > 60 ? s.slice(0, 59) + "…" : s}”`;
const visible = (s: string) => s.replace(/\n/g, "⏎").replace(/\t/g, "⇥");

function describe(r: ActionRequest, withApp = true): string {
  const el = r.element ? `${r.element.name ? quote(r.element.name) : "the"} ${r.element.role}` : "";
  const where = r.app && withApp ? ` in ${r.app}` : "";
  const replacing = r.mode === "replace" && (r.currentText ?? "").length > 0;
  switch (r.kind) {
    case "click": return `Click ${el}${where}?`;
    case "toggle": return `Switch ${el}${where}?`;
    case "text": return replacing ? `Replace the text in ${el}${where} with ${quote(visible(r.value ?? ""))}?` : `Type ${quote(visible(r.value ?? ""))} into ${el}${where}?`;
    case "select": return `Choose ${quote(r.value ?? "")} in ${el}${where}?`;
    case "value": return `Set ${el} to ${r.value}${where}?`;
    case "setting": return `Change the setting ${quote(r.value ?? "")}?`;
    case "open_app": return `Open ${quote(r.value ?? "")}?`;
    case "cursor_click": return `Borrow your mouse to click ${el}${where}?`;
    case "cursor_text": return `Borrow your mouse and keyboard to ${replacing ? "replace the text in" : "type"} ${replacing ? `${el} with ${quote(visible(r.value ?? ""))}` : `${quote(visible(r.value ?? ""))} into ${el}`}${where}?`;
    case "keys": return `Borrow your keyboard to press ${r.value ?? ""}${r.element ? ` on ${el}` : ""}${where}?`;
    case "scroll": return `Borrow your mouse to scroll ${el} ${r.value ?? ""}${where}?`;
    default: return `Read ${r.window || r.app}?`;
  }
}

export class PolicyEngine {
  private recent = new Map<string, number[]>();

  constructor(private o: PolicyInputs) {}

  decide(r: ActionRequest): Decision {
    const d = this.decideBase(r);
    if (d.verdict === "deny") return d;
    // "Always in this app" is for ordinary steps; a risky or off-task question is answered for this once only.
    const remember = (this.o.allowGrants?.() ?? true) && !!d.needsGrant && !d.risky;
    // Risky and off-task: say so in the question, so a page that talked Ember into it is easy to spot.
    if (d.about && !alignedWithGoal(r.goal, d.about)) {
      return { ...d, remember: false, aligned: false, everyTime: true, reason: `${d.reason}; not something the user asked for`, prompt: `${d.prompt} You didn't ask for this, so say no if it looks wrong.` };
    }
    // The administrator wants a click before every action.
    if (d.tier !== "read" && this.o.confirmEveryAction?.()) {
      return d.verdict === "allow"
        ? { ...d, verdict: "confirm", tier: "confirm", reason: "your organisation asks you to confirm every action", remember: false, everyTime: true }
        : { ...d, remember: false, everyTime: true };
    }
    return { ...d, remember };
  }

  /**
   * Is this request hard to undo or visible to others, whatever the app's grant?
   * `about`: the on-screen words that make it so, when there are any.
   */
  private riskOf(r: ActionRequest): { reason: string; about?: string } | null {
    const name = r.element?.name ?? "";
    const role = r.element?.role ?? "";
    // "OK" / "Yes" in a "Delete 500 files?" dialog agrees to the dialog's own risky question.
    const agrees = AFFIRMATIVE.test(normalizeLabel(name)) && isRiskyLabel(r.window);
    switch (r.kind) {
      case "click": case "toggle": case "cursor_click":
        if (isRiskyLabel(name)) return { reason: "this action may be hard to undo or visible to others", about: name };
        if (agrees) return { reason: "this answers a dialog about something hard to undo", about: `${name} ${r.window}` };
        return null;
      case "select":
        return isRiskyLabel(r.value ?? "") ? { reason: "this choice may be hard to undo or visible to others", about: r.value } : null;
      case "text": case "cursor_text": {
        if (/[\n\r\t]/.test(r.value ?? "")) return { reason: "the text contains a line break or tab, which can submit a form or move to another field" };
        const current = r.currentText ?? "";
        if (r.mode === "replace" && (current.length > 80 || current.includes("\n"))) return { reason: `this replaces all ${current.length >= 200 ? "the" : current.length} characters already there` };
        return null;
      }
      case "keys": {
        const k = normalizeKeys(r.value ?? "");
        if (DESTRUCTIVE_KEYS.has(k)) return { reason: "this shortcut can delete, send or close things" };
        if (ACTIVATE_KEY.test(k)) {
          // Enter or Space on a focused button is a click on that button.
          if (ACTIVATING_ROLES.test(role) && isRiskyLabel(name)) return { reason: "this presses a button that may be hard to undo or visible to others", about: name };
          if (ACTIVATING_ROLES.test(role) && agrees) return { reason: "this answers a dialog about something hard to undo", about: `${name} ${r.window}` };
          if (!r.element) return { reason: "Ember can't tell what this key will activate" };
        }
        return null;
      }
      default:
        return null;
    }
  }

  private decideBase(r: ActionRequest): Decision {
    const prompt = describe(r);
    const win = { app: r.app, name: r.window };
    const never = (reason: string): Decision => ({ tier: "never", verdict: "deny", reason, prompt });

    if ((r.app || r.window) && isNeverLook(win, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (r.kind === "open_app" && r.value && isNeverLook({ app: r.value, name: r.value }, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (isSecurityWindow({ app: r.app, title: r.window })) return never("authentication and security windows are for the user only");
    if (r.element?.role === "password text") return never("password fields are for the user only");
    if (r.element?.role === "terminal") return never("Ember doesn't run commands, so it never types into terminals");
    if (r.kind === "open_app" && this.o.isTerminalApp?.(r.app || r.value || "")) return never("Ember doesn't run commands, so it never opens terminals");
    if ((r.kind === "text" || r.kind === "cursor_text" || r.kind === "select" || r.kind === "value" || r.kind === "keys") && r.element && isSecretField(r.element.name)) {
      return never("this looks like a password or payment field");
    }
    if (r.kind === "keys" && SYSTEM_KEYS.test(normalizeKeys(r.value ?? ""))) return never("desktop shortcuts (terminals, the run dialog, switching sessions) are for the user only");

    if (r.kind === "read") return { tier: "read", verdict: "allow", reason: "reading is allowed", prompt };
    if (this.o.actionsAllowed && !this.o.actionsAllowed()) return never("your organisation has turned off Ember acting in apps");

    if (!this.withinRate(r.taskId)) return { tier: "confirm", verdict: "deny", reason: "too many actions in a minute; slow down and check the result", prompt };

    const risk = this.riskOf(r);
    if (r.onDesk) {
      // Ember's desk: its own display and app instances, so mouse and keyboard need no borrowing.
      // Hard-to-undo actions are still confirmed (desk apps share the user's files).
      if (risk) return { tier: "confirm", verdict: "confirm", reason: risk.reason, about: risk.about, prompt: `${prompt.replace(/\?$/, "")} (on my desk)?`, risky: true, everyTime: true };
      return { tier: "reversible", verdict: "allow", reason: "on Ember's desk", prompt };
    }

    // Anything with the borrowed mouse or keyboard is confirmed every time (PLAN.md §5).
    if (r.kind === "cursor_click" || r.kind === "cursor_text" || r.kind === "keys" || r.kind === "scroll") {
      return { tier: "confirm", verdict: "confirm", reason: risk?.reason ?? "Ember needs your mouse or keyboard for this", about: risk?.about, prompt, risky: true, everyTime: true };
    }

    // Launching apps and Ember's short list of comfort settings are easy to undo.
    if (r.kind === "open_app" || r.kind === "setting") return { tier: "reversible", verdict: "allow", reason: "easy to undo", prompt };

    const grant = this.o.grants()[r.app.toLowerCase()];
    if (risk) return { tier: "confirm", verdict: "confirm", reason: risk.reason, about: risk.about, prompt, needsGrant: grant !== "act", risky: true };
    if (grant === "act") return { tier: "reversible", verdict: "allow", reason: `Ember may act in ${r.app}`, prompt };
    return {
      tier: "reversible", verdict: "confirm", reason: `first action in ${r.app || "this app"}`,
      prompt: `Let me work in ${r.app || "this app"}? First step: ${lowerFirst(describe(r, false)).replace(/\?$/, ".")}`,
      needsGrant: true,
    };
  }

  private withinRate(taskId: string): boolean {
    const now = (this.o.now ?? Date.now)();
    const list = (this.recent.get(taskId) ?? []).filter(t => now - t < 60_000);
    list.push(now);
    this.recent.set(taskId, list);
    return list.length <= (this.o.rateLimit ?? 40);
  }
}
