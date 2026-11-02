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

/** The host (with its port, when it has one) of a valid endpoint, as the consent card and the setup check name it; null otherwise. */
export function endpointHost(url: string): string | null {
  if (endpointProblem(url) !== null) return null;
  return parse(url)?.host.toLowerCase() ?? null;
}
