/**
 * SSH destinations as Ember accepts them (§5.1.2): what the user typed in settings or accepted from an offer, and the
 * jump hops `ssh -G` names. Every string here ends up as one element of ssh's argv (after `--`) or inside the hardened
 * ProxyCommand Ember builds (§5.1.3), so the validators are allow-lists: no option can be smuggled in (a leading `-`),
 * no whitespace or control character, and no `%` in a hop (ssh would expand it inside a ProxyCommand). Pure; plain Node.
 */

import { HOST_ID } from "../../shared/targets";

/** §5.1.2's destination validator: an alias, user@host or an address; never an option. */
const DEST = /^(?!-)[A-Za-z0-9._%+@[\]:-]{1,255}$/;
/** §5.1.2's jump hop validator: stricter, no `%` (ssh expands it in a ProxyCommand) and no brackets. */
const HOP = /^(?!-)[A-Za-z0-9._@:-]{1,255}$/;
/** A user name or host name inside a hop: what HOP allows, without the separators. */
const HOP_PART = /^(?!-)[A-Za-z0-9._-]{1,255}$/;
/** No control characters (they could hide what a value says, or end a line in ssh's config). */
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/; // eslint-disable-line no-control-regex -- control characters are exactly what's refused here
/** The characters an allow-listed -o value may hold (§5.1.2). */
const OPTION_VALUE = /^[A-Za-z0-9._@:/~+-]{1,255}$/;

/** The -o options Ember carries over from the user's own ssh command line (§2.7's allow-list), as ssh spells them. */
export const SSH_OPTION_KEYS = ["Port", "User", "ProxyJump", "IdentityFile", "IdentitiesOnly", "HostKeyAlias", "HostName"] as const;
export type SshOptionKey = (typeof SSH_OPTION_KEYS)[number];

/** Is `s` a destination ssh may be given (after `--`)? */
export function validDest(s: string): boolean {
  return typeof s === "string" && DEST.test(s);
}

/** Is `s` a jump hop Ember may put inside its hardened ProxyCommand? */
export function validHop(s: string): boolean {
  return typeof s === "string" && HOP.test(s);
}

/** The allow-listed -o key spelled as ssh documents it ("hostname" → "HostName"), or null for any other key. */
export function optionKey(k: string): SshOptionKey | null {
  const lower = k.toLowerCase();
  return SSH_OPTION_KEYS.find(o => o.toLowerCase() === lower) ?? null;
}

/** Is `v` a value an allow-listed -o option may carry? */
export function validOptionValue(v: string): boolean {
  return typeof v === "string" && OPTION_VALUE.test(v);
}

/**
 * An identity or config file carried over from the user's command line: absolute (`/…`, or `C:\…` on Windows) or
 * `~/`-relative, at most 1024 characters, no control characters, and never something ssh could read as an option.
 */
export function validSshFile(p: string): boolean {
  return typeof p === "string" && p.length >= 2 && p.length <= 1024 && NO_CONTROL.test(p) && /^(\/|~\/|[A-Za-z]:[\\/])/.test(p);
}

/** A port as ssh takes it: a whole number from 1 to 65535. */
export function validPort(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** HostRecord.extra: the options carried over from the user's own ssh command line (§2.7). */
export interface CarriedOptions { jump?: string[]; identityFiles?: string[]; configFile?: string; options?: Record<string, string> }

/** Does every carried option pass its validator (hops, files, allow-listed keys and their values)? */
export function validExtra(extra: CarriedOptions | undefined): boolean {
  if (!extra) return true;
  if (extra.jump && (!Array.isArray(extra.jump) || extra.jump.length > 8 || !extra.jump.every(validHop))) return false;
  if (extra.identityFiles && (!Array.isArray(extra.identityFiles) || extra.identityFiles.length > 16 || !extra.identityFiles.every(validSshFile))) return false;
  if (extra.configFile !== undefined && !validSshFile(extra.configFile)) return false;
  if (extra.options) {
    for (const [k, v] of Object.entries(extra.options)) {
      if (optionKey(k) !== k || !validOptionValue(v)) return false;
      if (k === "ProxyJump" && !v.split(",").every(validHop)) return false;
      if (k === "IdentityFile" && !validSshFile(v)) return false;
    }
  }
  return true;
}

/**
 * What the user typed in settings' "Add a computer": an alias from ~/.ssh/config, `user@host`, `user@host:port`,
 * `[v6 address]:port` or `ssh://user@host:port`. The port is taken apart (ssh gets it as `-p`); null for anything else.
 */
export function parseTypedDestination(text: string): { dest: string; port?: number } | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (!s || s.length > 300) return null;
  let port: number | undefined;
  const uri = /^ssh:\/\/(.+?)\/?$/i.exec(s);
  if (uri) s = uri[1];
  const at = s.lastIndexOf("@");
  const user = at >= 0 ? s.slice(0, at + 1) : "";
  let host = at >= 0 ? s.slice(at + 1) : s;
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(host);
  if (bracket) {
    host = bracket[1];
    if (bracket[2] !== undefined) port = Number(bracket[2]);
  } else {
    const colons = host.split(":").length - 1;
    const hostPort = /^([^:]+):(\d{1,5})$/.exec(host);
    if (colons === 1 && hostPort) {
      host = hostPort[1];
      port = Number(hostPort[2]);
    } else if (colons === 1 || (uri && colons > 1)) {
      // "host:" or "host:x", and an unbracketed IPv6 address inside an ssh:// URI, are ambiguous: refused.
      return null;
    }
  }
  if (port !== undefined && !validPort(port)) return null;
  if (user && !/^[A-Za-z0-9._-]+@$/.test(user)) return null;
  const dest = user + host;
  if (!host || !validDest(dest)) return null;
  return port === undefined ? { dest } : { dest, port };
}

/** The host part of a destination ("deploy@build-01" → "build-01"): the name Ember shows for a host (its label). */
export function hostLabel(dest: string): string {
  const at = dest.lastIndexOf("@");
  return at >= 0 ? dest.slice(at + 1) : dest;
}

/**
 * HOST_ID for a new host record (§5.1.2): its label lower-cased, every character outside [a-z0-9._-] made "-", leading
 * separators dropped, at most 60 characters, made unique among `taken` with "-2", "-3"…
 */
export function hostIdFor(dest: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = hostLabel(dest).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 60);
  if (!base) base = "host";
  if (!used.has(base) && HOST_ID.test(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** One jump hop taken apart: ssh gets `-p <port>` and `-- user@host` (a `host:port` destination would be a host name). */
export interface Hop { user?: string; host: string; port?: number }

/**
 * One hop as `ssh -G` prints it in `proxyjump` (`[user@]host[:port]`, a numeric host in brackets: `[10.0.0.5]:2200`)
 * or as the user wrote it after -J. Null when it isn't a plain hop Ember can harden (an ssh:// URI, a `%`, a space…).
 */
export function parseHop(s: string): Hop | null {
  if (typeof s !== "string" || s.length > 300) return null;
  const at = s.lastIndexOf("@");
  const user = at >= 0 ? s.slice(0, at) : undefined;
  let rest = at >= 0 ? s.slice(at + 1) : s;
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(rest);
  if (bracket) {
    rest = bracket[1];
    if (bracket[2] !== undefined) port = Number(bracket[2]);
  } else {
    const hostPort = /^([^:]+):(\d{1,5})$/.exec(rest);
    if (hostPort) {
      rest = hostPort[1];
      port = Number(hostPort[2]);
    }
  }
  if (port !== undefined && !validPort(port)) return null;
  if (user !== undefined && !HOP_PART.test(user)) return null;
  // An IPv6 hop keeps its colons; anything else must be a plain name.
  if (!(HOP_PART.test(rest) || /^[0-9A-Fa-f:.]+$/.test(rest) && rest.includes(":"))) return null;
  const dest = user !== undefined ? `${user}@${rest}` : rest;
  if (!validHop(dest)) return null;
  return { ...(user !== undefined ? { user } : {}), host: rest, ...(port !== undefined ? { port } : {}) };
}

/** A hop as one ssh destination ("deploy@bastion"); its port goes apart as `-p`. */
export function hopDest(h: Hop): string {
  return h.user !== undefined ? `${h.user}@${h.host}` : h.host;
}
