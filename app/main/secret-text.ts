/**
 * Replaces anything in a piece of text that is shaped like a credential (BE audit #1). No imports, so the logger, the
 * sign-in code and the provider code share it. It works on finished text, including a whole JSON log line: every
 * replacement keeps quotes, backslashes and whitespace out of what it consumes, so a JSON line stays valid JSON.
 */

/** GitHub's token shapes: OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_), refresh (ghr_), classic (ghp_), fine-grained. Found inside larger strings too. */
const TOKEN_SHAPE = /(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{8,}/g;
/** `Bearer x`, `Basic x`: an Authorization header's value, whatever token it carries. */
const AUTH_HEADER = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** `token=x`, `access_token: x`, `"password":"x"`, also as it reads inside an escaped JSON string (`\"token\":\"x\"`). */
const KEY_VALUE = /\b((?:[a-z]+_)?token|password|passwd|secret|api[_-]?key|authorization)(\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\&,;}]{4,}/gi;
/** `https://user:pass@host`: the password (and user) of a URL's userinfo. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'\\]*:[^\s/@"'\\]+@/gi;

/** `text` with every credential-shaped piece replaced. */
export function redactSecretText(text: string): string {
  return text
    .replace(TOKEN_SHAPE, "[token]")
    .replace(URL_USERINFO, "$1[userinfo]@")
    .replace(AUTH_HEADER, "$1$2[token]")
    .replace(KEY_VALUE, "$1$2[token]");
}
