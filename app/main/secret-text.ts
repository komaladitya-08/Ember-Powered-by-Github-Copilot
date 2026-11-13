/**
 * Replaces anything in a piece of text that is shaped like a credential (BE audit #1). Its one import is the commands
 * redactor's token shapes (pure, with no imports of its own), so the logger, the sign-in code and the provider code
 * share it and logs hide the same keys command output does (safety-privacy-2). It works on finished text, including a
 * whole JSON log line: every replacement keeps quotes, backslashes and whitespace out of what it consumes, so a JSON
 * line stays valid JSON.
 */

import { TOKEN_SHAPES } from "./commands/redact";

/** GitHub's token shapes: OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_), refresh (ghr_), classic (ghp_), fine-grained. Found inside larger strings too. */
const TOKEN_SHAPE = /(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{8,}/g;
/** `Bearer x`, `Basic x`: an Authorization header's value, whatever token it carries. */
const AUTH_HEADER = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * `Authorization: x`, and with a scheme's word before its value (`Token x`, `Bot x`, `Digest username=…`): the word
 * stays and the value is hidden; after any other word, the word and a long value after it are both hidden. Before, the word was taken for the value and the secret after it stayed
 * (safety-privacy-r9-4).
 */
const AUTHORIZATION = /\b(authorization)(\\?["']?\s*[:=]\s*\\?["']?)(?:(Bearer|Basic|Token|Digest|Bot|ApiKey|Api-Key|Key|SSWS|Splunk|GenieKey|Negotiate|NTLM|DPoP|AWS4-HMAC-SHA256)(\s+))?[^\s"'\\&,;}]{4,}(?:\s+[A-Za-z0-9._~+/=-]{8,})?/gi;
/** Digest's `response=`, `nonce=` and `cnonce=`. */
const DIGEST_PARTS = /\b(response|nonce|cnonce)(\s*=\s*"?)[A-Za-z0-9+/=]{8,}/gi;
/**
 * `token=x`, `access_token: x`, `"password":"x"`, `client_secret=x`, `aws_secret_access_key = x`, `pwd=x`, also as it
 * reads inside an escaped JSON string (`\"token\":\"x\"`).
 */
const KEY_VALUE = /\b((?:[a-z]+_)*(?:token|password|passwd|pwd|secret|api[_-]?key)|(?:[a-z]+_)+key)(\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\&,;}]{4,}/gi;
/** `https://user:pass@host`: the password (and user) of a URL's userinfo. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'\\]*:[^\s/@"'\\]+@/gi;

/** `text` with every credential-shaped piece replaced. */
export function redactSecretText(text: string): string {
  let out = text.replace(TOKEN_SHAPE, "[token]");
  for (const re of TOKEN_SHAPES) out = out.replace(re, "[token]");
  return out
    .replace(URL_USERINFO, "$1[userinfo]@")
    .replace(AUTH_HEADER, "$1$2[token]")
    .replace(AUTHORIZATION, "$1$2$3$4[token]")
    .replace(DIGEST_PARTS, "$1$2[token]")
    .replace(KEY_VALUE, "$1$2[token]");
}
