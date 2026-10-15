/**
 * The policy engine: every action a worker wants to take is described as a
 * structured ActionRequest and decided here, never by the model. Tiers follow
 * PLAN.md §5: read and reversible actions run automatically, risky ones need
 * the user's click, and some are never done by Ember at all.
 */

import { isNeverLook } from "../perception/elements";

export type Tier = "read" | "reversible" | "confirm" | "never";
export type Verdict = "allow" | "confirm" | "deny";

export type ActionKind = "read" | "click" | "toggle" | "text" | "select" | "value" | "setting" | "open_app"
  /** Tier 3: with the user's borrowed mouse and keyboard. */
  | "cursor_click" | "cursor_text" | "keys" | "scroll";

export interface ActionRequest {
  taskId: string;
  kind: ActionKind;
  /** App name and window title the action touches ("" for settings / launching). */
  app: string;
  window: string;
  element?: { role: string; name: string };
  /** For text: what will be typed; for settings: the new value. */
  value?: string;
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
}

export type Grant = "observe" | "act";

export interface PolicyInputs {
  neverLook: () => string[];
  grants: () => Record<string, Grant>;
  /** Max actions per task per minute. */
  rateLimit?: number;
  now?: () => number;
}

/** Words on buttons that make an action hard to undo or visible to others. */
const RISKY = /\b(send|post|submit|publish|share|delete|remove|erase|discard|overwrite|replace all|empty|format|buy|pay|order|purchase|checkout|install|uninstall|upload|transfer|reply|forward|sign|accept|approve|confirm|quit|close without saving|don't save|log ?out|sign ?out|shut ?down|restart|reboot)\b/i;
/** Fields Ember never fills: secrets and payment details. */
const SECRET_FIELD = /\b(password|passphrase|pin|card ?number|credit ?card|cvv|cvc|security code|expir(y|ation)|iban|routing number|one-time code|otp|2fa|recovery code)\b/i;
/** Windows Ember never acts in: authentication prompts and keyrings. */
const SECURITY_WINDOW = /\b(authenticat(e|ion) (is )?required|polkit|sudo|unlock (login )?keyring|password required|enter password|security settings|firewall)\b/i;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const quote = (s: string) => `“${s.length > 60 ? s.slice(0, 59) + "…" : s}”`;

function describe(r: ActionRequest, withApp = true): string {
  const el = r.element ? `${r.element.name ? quote(r.element.name) : "the"} ${r.element.role}` : "";
  const where = r.app && withApp ? ` in ${r.app}` : "";
  switch (r.kind) {
    case "click": return `Click ${el}${where}?`;
    case "toggle": return `Switch ${el}${where}?`;
    case "text": return `Type ${quote(r.value ?? "")} into ${el}${where}?`;
    case "select": return `Choose ${quote(r.value ?? "")} in ${el}${where}?`;
    case "value": return `Set ${el} to ${r.value}${where}?`;
    case "setting": return `Change the setting ${quote(r.value ?? "")}?`;
    case "open_app": return `Open ${quote(r.value ?? "")}?`;
    case "cursor_click": return `Borrow your mouse to click ${el}${where}?`;
    case "cursor_text": return `Borrow your mouse and keyboard to type ${quote(r.value ?? "")} into ${el}${where}?`;
    case "keys": return `Borrow your keyboard to press ${r.value ?? ""}${where}?`;
    case "scroll": return `Borrow your mouse to scroll ${el} ${r.value ?? ""}${where}?`;
    default: return `Read ${r.window || r.app}?`;
  }
}

export class PolicyEngine {
  private recent = new Map<string, number[]>();

  constructor(private o: PolicyInputs) {}

  decide(r: ActionRequest): Decision {
    const prompt = describe(r);
    const win = { app: r.app, name: r.window };
    const never = (reason: string): Decision => ({ tier: "never", verdict: "deny", reason, prompt });

    if ((r.app || r.window) && isNeverLook(win, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (SECURITY_WINDOW.test(`${r.app} ${r.window}`)) return never("authentication and security windows are for the user only");
    if (r.element?.role === "password text") return never("password fields are for the user only");
    if (r.element?.role === "terminal") return never("Ember doesn't run commands, so it never types into terminals");
    if ((r.kind === "text" || r.kind === "cursor_text") && r.element && SECRET_FIELD.test(r.element.name)) return never("this looks like a password or payment field");

    if (r.kind === "read") return { tier: "read", verdict: "allow", reason: "reading is allowed", prompt };

    if (!this.withinRate(r.taskId)) return { tier: "confirm", verdict: "deny", reason: "too many actions in a minute; slow down and check the result", prompt };

    // Anything with the borrowed mouse or keyboard is confirmed every time (PLAN.md §5).
    if (r.kind === "cursor_click" || r.kind === "cursor_text" || r.kind === "keys" || r.kind === "scroll") {
      return { tier: "confirm", verdict: "confirm", reason: "Ember needs your mouse or keyboard for this", prompt, risky: true };
    }

    // Launching apps and Ember's short list of comfort settings are easy to undo.
    if (r.kind === "open_app" || r.kind === "setting") return { tier: "reversible", verdict: "allow", reason: "easy to undo", prompt };

    const grant = this.o.grants()[r.app.toLowerCase()];
    const risky = (r.kind === "click" || r.kind === "toggle") && r.element && RISKY.test(r.element.name);
    if (risky) return { tier: "confirm", verdict: "confirm", reason: "this action may be hard to undo or visible to others", prompt, needsGrant: grant !== "act", risky: true };
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
