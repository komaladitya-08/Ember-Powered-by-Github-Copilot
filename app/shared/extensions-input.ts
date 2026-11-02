/**
 * What Home's Extensions section accepts from the user and from the runtime, checked the same way in the page (to say
 * so at once) and in main (which trusts nothing the page sends): a marketplace's address, and the GitHub page a
 * connector's Connect may open in the browser. Pure and renderer-safe: no Node, no Electron.
 */

/** Longest marketplace address Ember takes (a URL a person would paste). */
export const MARKETPLACE_SOURCE_MAX = 2048;
/** Longest name or id Home sends main (a marketplace's, an entry's or an installed item's). */
export const EXTENSIONS_NAME_MAX = 200;

/** GitHub's own limits: an owner is 1–39 letters, digits or hyphens; a repository up to 100 of letters, digits, `.`, `-` and `_`. */
const GITHUB_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * A marketplace's address as Ember keeps it, or null when it is neither:
 * - a GitHub repository, `owner/repo` (also `https://github.com/owner/repo`, which becomes `owner/repo`), or
 * - an https URL with a host, no user name or password in it, and no spaces.
 * Plain http is refused: the list would come over the network unprotected.
 */
export function marketplaceSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\.git$/, "");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused here
  if (!s || s.length > MARKETPLACE_SOURCE_MAX || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  const repo = GITHUB_REPO.exec(s);
  if (repo) return repo[2] === "." || repo[2] === ".." ? null : `${repo[1]}/${repo[2]}`;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  if (url.hostname === "github.com") {
    const path = url.pathname.replace(/\/+$/, "").replace(/^\//, "");
    const gh = GITHUB_REPO.exec(path);
    if (gh && !url.search && !url.hash) return `${gh[1]}/${gh[2]}`;
  }
  return url.href;
}

/**
 * Whether Connect may open `url` in the system browser: only GitHub's own pages (github.com or one of its subdomains)
 * over https, on the default port, with no user name or password. Anything else the runtime hands back stays unopened.
 */
export function mayOpenConnectUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > MARKETPLACE_SOURCE_MAX) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return host === "github.com" || host.endsWith(".github.com");
}

/** A name or id from the page: a non-empty string of at most EXTENSIONS_NAME_MAX characters, with no control characters. */
export function extensionsName(raw: unknown): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused here
  if (typeof raw !== "string" || !raw || raw.length > EXTENSIONS_NAME_MAX || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}
