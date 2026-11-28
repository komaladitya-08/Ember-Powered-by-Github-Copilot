/**
 * MCP servers' secrets kept from the coding window (docs/CODING-APP.md §3 "Secrets"): the runtime's `mcp.config.list`
 * answers each server's variables and headers with their values (probed on runtime 1.0.97: `env: { TOKEN: "…" }`,
 * `headers: { Authorization: "Bearer …" }`), so main puts CODE_KEPT in place of every such value before the answer
 * leaves it, and of any other value under a secret-named key (an auth block's client secret, a token). The window's
 * form is write-only already and sends the marker back for a value left as it was; `keptMerged` puts the stored value
 * back in its place before `mcp.config.update` goes to the runtime. A marker with no stored value behind it (a new
 * server, a name the config doesn't hold) is refused: Ember never sends the marker itself as a value. Pure.
 */

import { CODE_KEPT } from "../../shared/code";

/** Keys whose every value is a secret: a stdio server's variables and a remote server's headers. */
const VALUE_MAPS = new Set(["env", "headers"]);
/** Other keys whose string value is a secret, wherever they stand in a server's config. */
const SECRET_KEY = /secret|token|password|passwd|api[-_]?key|credential|authorization/i;
const MAX_DEPTH = 12;

/** A server config with each secret value replaced by CODE_KEPT. */
function hideIn(v: unknown, depth: number, secret: boolean): unknown {
  if (depth > MAX_DEPTH) return secret ? CODE_KEPT : null;
  if (typeof v === "string") return secret ? CODE_KEPT : v;
  if (Array.isArray(v)) return v.map(x => hideIn(x, depth + 1, secret));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (VALUE_MAPS.has(k) && x && typeof x === "object" && !Array.isArray(x)) {
        out[k] = Object.fromEntries(Object.keys(x as Record<string, unknown>).map(n => [n, CODE_KEPT]));
      } else out[k] = hideIn(x, depth + 1, secret || SECRET_KEY.test(k));
    }
    return out;
  }
  return v;
}

/** `mcp.config.list`'s answer as the window gets it: every server's names kept, its secret values replaced by CODE_KEPT. */
export function hideMcpSecrets(answer: unknown): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const a = answer as Record<string, unknown>;
  const servers = a.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { ...a, servers: {} };
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(servers as Record<string, unknown>)) out[name] = hideIn(c, 0, false);
  return { ...a, servers: out };
}

/** Whether `v` holds CODE_KEPT anywhere. */
export function holdsKept(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (v === CODE_KEPT) return true;
  if (Array.isArray(v)) return v.some(x => holdsKept(x, depth + 1));
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(x => holdsKept(x, depth + 1));
  return false;
}

/** A marker that has no stored value behind it: the call is refused. */
export class KeptMissing extends Error {}

/** `config` with each CODE_KEPT replaced by the string at the same place in `stored`; throws KeptMissing where there is none. */
function mergeIn(config: unknown, stored: unknown, depth: number): unknown {
  if (config === CODE_KEPT) {
    if (typeof stored !== "string" || stored === CODE_KEPT) throw new KeptMissing("no stored value");
    return stored;
  }
  if (depth > MAX_DEPTH) return config;
  const s = stored && typeof stored === "object" ? stored as Record<string, unknown> : undefined;
  if (Array.isArray(config)) return config.map((x, i) => mergeIn(x, Array.isArray(stored) ? stored[i] : undefined, depth + 1));
  if (config && typeof config === "object") {
    return Object.fromEntries(Object.entries(config as Record<string, unknown>).map(([k, x]) => [k, mergeIn(x, s?.[k], depth + 1)]));
  }
  return config;
}

/**
 * `mcp.config.update`'s (or `add`'s) params with every CODE_KEPT the window sent back replaced by the value the stored
 * config (`mcp.config.list`'s raw answer) holds at that place for that server; throws KeptMissing where it holds none.
 */
export function keptMerged(params: unknown, storedList: unknown): unknown {
  if (!holdsKept(params)) return params;
  const p = params && typeof params === "object" ? params as Record<string, unknown> : {};
  const name = typeof p.name === "string" ? p.name : "";
  const servers = storedList && typeof storedList === "object" ? (storedList as Record<string, unknown>).servers : undefined;
  const stored = name && servers && typeof servers === "object" ? (servers as Record<string, unknown>)[name] : undefined;
  if (!stored) throw new KeptMissing("no such server");
  const merged = { ...p, config: mergeIn(p.config, stored, 0) };
  if (holdsKept(merged)) throw new KeptMissing("left over");
  return merged;
}
