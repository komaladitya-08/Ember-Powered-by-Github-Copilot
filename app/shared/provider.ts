/**
 * The user's own model provider ("bring your own key"): what main and the settings window both check about it. An
 * endpoint is https, or plain http only on this computer (a local model server such as Ollama or LM Studio), and holds
 * no user name or password (the key travels apart from it, encrypted on disk). Pure: no Node, no DOM.
 */

/** The kinds of model service the Copilot runtime can use instead of Copilot (its ProviderConfig `type`). */
export const PROVIDER_TYPES = ["openai", "azure", "anthropic"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** The API formats an OpenAI or Azure endpoint speaks (ProviderConfig `wireApi`). */
export const WIRE_APIS = ["completions", "responses"] as const;
export type WireApi = (typeof WIRE_APIS)[number];

/** The longest endpoint address Ember keeps. */
export const MAX_ENDPOINT = 2048;
/** The longest API key Ember takes (real ones are under 200 characters; an Azure AD token is about 2,000). */
export const MAX_API_KEY = 8192;
/** A model or deployment id as services write them ("gpt-4.1", "claude-sonnet-4-5", "llama3.2:3b", "org/model@v2"). */
export const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
/** An Azure API version ("2024-10-21", "2025-04-01-preview"). */
export const AZURE_API_VERSION = /^[A-Za-z0-9._-]{1,40}$/;

/** Hosts plain http may reach: this computer only. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** No control characters or spaces (they could hide what an address says). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what's refused here
const UNPRINTABLE = /[\u0000- \u007f-\u009f]/;

/** The endpoint's address parsed, or null when it isn't one. */
function parse(url: string): URL | null {
  if (typeof url !== "string" || !url || url.length > MAX_ENDPOINT || UNPRINTABLE.test(url)) return null;
  try { return new URL(url); } catch { return null; }
}

/**
 * Why `url` can't be the user's model endpoint, in one plain sentence, or null when it can: https anywhere, http only
 * for localhost, 127.0.0.1 or ::1, and no user name or password in it.
 */
export function endpointProblem(url: string): string | null {
  const u = parse(url);
  if (!u || !u.hostname) return "Enter the service's full address, starting with https://.";
  if (u.username || u.password) return "Leave the user name and password out of the address: put the key in API key.";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") return LOCAL_HOSTS.has(u.hostname.toLowerCase()) ? null : "Use an https:// address. Only a model server on this computer (localhost) may use http://.";
  return "Enter the service's full address, starting with https://.";
}

/**
 * Whether the endpoint is a service that needs an API key: anything but a model server on this computer (localhost,
 * 127.0.0.1, ::1), which often needs none (Ollama, LM Studio; main sends no key then, and its check says when one is
 * needed). An address that isn't one counts as needing a key (first-run-v2).
 */
export function keyNeeded(url: string): boolean {
  const u = parse(url);
  return !u || !LOCAL_HOSTS.has(u.hostname.toLowerCase());
}

/** Whether a host as Ember names it (with its port: "localhost:11434", "[::1]:1234") is this computer. */
export function onThisComputer(host: string): boolean {
  return LOCAL_HOSTS.has(host.replace(/:\d+$/, "").toLowerCase());
}

/**
 * Whether Ember may say it is connected to the user's own provider, as the agent's status names it (`host`, and
 * `listed`: what the start's check of a server on this computer found). Only a server on this computer is asked at a
 * start, and only one whose answer held a model list is "connected", as main's ready status says (localProviderLine,
 * integrations-r8-1); first run says the same (integrations-x8-2). A host elsewhere is only in use (integrations-r3).
 */
export function ownConnected(s: { host: string; listed?: boolean }): boolean {
  return onThisComputer(s.host) && s.listed !== false;
}

/** How long "I agree" ignores activation after the card is drawn for a new host: confirm.ts's own arm delay. */
export const AGREE_ARM_MS = 500;

/**
 * Runs asynchronous reads of one thing so only the newest one's outcome (value or failure) is applied: an older read that
 * settles after a newer one began is dropped, so a late failure can't overwrite a newer success, nor a late success a
 * newer failure.
 */
export function latestOnly<T>(read: () => Promise<T>, apply: (r: { ok: true; value: T } | { ok: false }) => void): () => Promise<void> {
  let generation = 0;
  return async () => {
    const mine = ++generation;
    let r: { ok: true; value: T } | { ok: false };
    try { r = { ok: true, value: await read() }; } catch { r = { ok: false }; /* the caller treats it as unknown */ }
    if (mine === generation) apply(r);
  };
}

/**
 * The card's "I agree" as Ember's questions are (confirm.ts): drawn or redrawn for another host, it ignores activation
 * for AGREE_ARM_MS; and the host is taken when it is pressed (pointer down, or the key), so a card redrawn between the
 * press and the click (pressing blurs the address field, which saves it and redraws the card) agrees to nothing.
 */
export class AgreeGuard {
  private host: string | null = null;
  private drawnAt = -Infinity;
  /** Counts every draw of the card, for the same host too. */
  private draws = 0;
  private pressed: { host: string | null; armed: boolean; draws: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now(), private readonly armMs = AGREE_ARM_MS) {}

  /** The card is drawn for `host` (null: no card up). A different host starts the arm delay again. */
  drawn(host: string | null): void {
    this.draws++;
    if (host === this.host) return;
    this.host = host;
    this.drawnAt = this.now();
  }

  private armed(): boolean {
    return this.host !== null && this.now() - this.drawnAt >= this.armMs;
  }

  /** "I agree" was pressed: the host the card names now, and whether it was armed then. */
  press(): void {
    this.pressed = { host: this.host, armed: this.armed(), draws: this.draws };
  }

  /**
   * "I agree" was activated: the host to agree to, or null (pressed too soon, or the card redrawn since the press). An
   * activation with no press before it (a screen reader's) counts as pressed now.
   */
  activate(): string | null {
    const p = this.pressed ?? { host: this.host, armed: this.armed(), draws: this.draws };
    this.pressed = null;
    // Redrawn at all since the press (even for the same host): what was pressed may not be what shows now.
    if (!p.armed || !this.armed() || p.host !== this.host || p.draws !== this.draws) return null;
    return this.host;
  }
}

/**
 * What Home's "I agree" does: agree for the host the card was drawn for (`cardHost`), and only for it. When the address
 * field (`typed`) names another host by the time it is clicked, that address is saved and the card drawn again for it
 * instead (nothing is agreed); one that isn't an address says why. No card up: nothing.
 */
export function agreeAction(cardHost: string | null, typed: string): { agree: string } | { save: string } | { problem: string } | null {
  if (!cardHost) return null;
  const t = typed.trim();
  if (!t) return { agree: cardHost };
  const host = endpointHost(t);
  if (host === cardHost) return { agree: cardHost };
  if (!host) return { problem: endpointProblem(t) ?? "Enter the service's full address, starting with https://." };
  return { save: t };
}

/**
 * What the check of a held edit's new address found (integrations-c5-1): `answered` with a model list, so the edit is
 * saved with the card's yes; `unlisted`, something answered there but not with a model list (a gateway that answers
 * chat only, and just as well a mistyped path or a web page), so the provider in force and its key stay until the
 * person says to use the address as typed; `failed`, anything else, which changes nothing.
 */
export function heldAnswer(r: { ok: boolean; cause?: string }): "answered" | "unlisted" | "failed" {
  if (r.ok) return "answered";
  return r.cause === "no-list" ? "unlisted" : "failed";
}

/** The host (with its port, when it has one) of a valid endpoint, as the consent card and the setup check name it; null otherwise. */
export function endpointHost(url: string): string | null {
  if (endpointProblem(url) !== null) return null;
  return parse(url)?.host.toLowerCase() ?? null;
}
