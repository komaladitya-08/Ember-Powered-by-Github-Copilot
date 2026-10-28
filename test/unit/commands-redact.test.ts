/**
 * Secret redaction (design §3.11 step 4): each pattern hides its value as "[secret hidden]", keeps what names it, and
 * leaves ordinary text alone; commandLineSecret finds the same tokens typed into a command (§3.5.4).
 */

import { describe, expect, it } from "vitest";
import { commandLineSecret, redactSecrets, SECRET_HIDDEN } from "../../app/main/commands/redact";

const GH = `ghp_${"a1B2".repeat(9)}`;
const PAT = `github_pat_${"x".repeat(22)}`;
const JWT = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;

describe("redactSecrets", () => {
  it.each([
    [`token ${GH} here`, `token ${SECRET_HIDDEN} here`],
    [`use ${PAT}`, `use ${SECRET_HIDDEN}`],
    [`gho_${"z".repeat(36)} and ghs_${"y".repeat(40)}`, `${SECRET_HIDDEN} and ${SECRET_HIDDEN}`],
    ["key AKIAABCDEFGHIJKLMNOP done", `key ${SECRET_HIDDEN} done`],
    ["ASIAABCDEFGHIJKLMNOP", SECRET_HIDDEN],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", `aws_secret_access_key = ${SECRET_HIDDEN}`],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter", `${SECRET_HIDDEN}\nafter`],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----", SECRET_HIDDEN],
    [`bearer ${JWT}`, `bearer ${SECRET_HIDDEN}`],
    ["xoxb-1234567890-abcdef", SECRET_HIDDEN],
    [`AIza${"Q".repeat(35)}`, SECRET_HIDDEN],
    [`npm_${"k".repeat(36)}`, SECRET_HIDDEN],
    ["DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc+/def==;EndpointSuffix=x", `DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${SECRET_HIDDEN};EndpointSuffix=x`],
    ["sv=1&SharedAccessSignature=sig123;x", `sv=1&SharedAccessSignature=${SECRET_HIDDEN};x`],
    ["Authorization: Bearer abc.def", `Authorization: Bearer ${SECRET_HIDDEN}`],
    ["authorization: token 123abc", `authorization: token ${SECRET_HIDDEN}`],
    ["Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${SECRET_HIDDEN}`],
    ["cloning https://ana:hunter2@github.com/o/r.git", `cloning https://${SECRET_HIDDEN}@github.com/o/r.git`],
    ["password=hunter2", `password=${SECRET_HIDDEN}`],
    ["DB_PASSWORD: hunter2", `DB_PASSWORD: ${SECRET_HIDDEN}`],
    ['{"api_key": "abc123", "name": "x"}', `{"api_key": "${SECRET_HIDDEN}", "name": "x"}`],
    ["client_secret=abc; next", `client_secret=${SECRET_HIDDEN}; next`],
    ["ACCESS-KEY=zzz", `ACCESS-KEY=${SECRET_HIDDEN}`],
    ["private_key: k", `private_key: ${SECRET_HIDDEN}`],
    ["passwd=p pwd=q secret=r token=s", `passwd=${SECRET_HIDDEN} pwd=${SECRET_HIDDEN} secret=${SECRET_HIDDEN} token=${SECRET_HIDDEN}`],
  ])("hides %j", (text, want) => {
    expect(redactSecrets(text)).toBe(want);
  });

  it("leaves ordinary text alone", () => {
    for (const text of ["build ok in 3.2s", "password reset email sent to the user", "the token is valid", "https://github.com/o/r", "ghp_short", "AKIA1234", "key: value"]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it("doesn't hide a value twice", () => {
    expect(redactSecrets(`password=${GH}`)).toBe(`password=${SECRET_HIDDEN}`);
    expect(redactSecrets(redactSecrets("token=abc"))).toBe(`token=${SECRET_HIDDEN}`);
  });
});

describe("commandLineSecret", () => {
  it.each([GH, PAT, JWT, "AKIAABCDEFGHIJKLMNOP", "https://ana:pw@example.com", "API_TOKEN=abc", "--password=x", "DB_PASSWORD=x", "Authorization: Bearer x"])("finds %j", word => {
    expect(commandLineSecret(word)).toBe(true);
  });
  it.each(["token: fix the build", "PWD=/home/ana", "OLDPWD=/tmp", "--tokenizer=fast", "password", "src/secret.ts", "https://example.com"])("leaves %j", word => {
    expect(commandLineSecret(word)).toBe(false);
  });
  it("gives the same answer every time (no global-flag state)", () => {
    for (let k = 0; k < 3; k++) expect(commandLineSecret(GH)).toBe(true);
  });
});

describe("redactSecrets on long output (review #26)", () => {
  /** The patterns as they were before they were made linear: the oracle for what is hidden. */
  const before = (text: string): string => {
    let out = text;
    for (const re of [
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      /xox[abposr]-[A-Za-z0-9-]{10,}/g,
      /AIza[0-9A-Za-z_-]{35}/g,
      /npm_[A-Za-z0-9]{36}/g,
    ]) out = out.replace(re, SECRET_HIDDEN);
    for (const re of [/(aws_secret_access_key\s*[=:]\s*)\S+/gi, /(AccountKey=)[^;\s]+/g, /(SharedAccessSignature=)[^;\s]+/g, /(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi]) {
      out = out.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN);
    }
    out = out.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, `://${SECRET_HIDDEN}@`);
    const kv = /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*(?:=|:)\s*["']?)([^\s"',;]+)/gi;
    return out.replace(kv, (m, keep: string, value: string) => (value.startsWith("[secret") ? m : keep + SECRET_HIDDEN));
  };

  it.each([
    "DB_PASSWORD=hunter2 and APP.SECRET.KEY: x",
    "my-app.client_secret_id = 'abc' ; next_token=def",
    "export GITHUB_TOKEN=abc; PWD=/home/ana",
    "x.y.z-password-for-db=1 tokenizer=fast max_tokens: 100",
    "secret_token_value=abc password=mytoken=x",
    `x-eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)} y`,
    `${JWT} ${JWT}-eyJ`,
    "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----BEGIN EC PRIVATE KEY-----\nBBB\n-----END EC PRIVATE KEY-----\ntail",
    "-----BEGIN A PRIVATE KEY-----\nno end here\n-----BEGIN B PRIVATE KEY-----\nnor here",
    "one\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\nmid\n-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    "Authorization: Bearer abc password: [secret hidden] token=[secret hidden]",
    `https://ana:pw@example.com ${GH} AKIAABCDEFGHIJKLMNOP`,
    // A long suffix after the secret word (second round).
    "PASSWORD_FOR_THE_PRODUCTION_DATABASE_SERVER_IN_THE_EU_WEST_REGION_PRIMARY_REPLICA=hunter2",
    "client_secret_for_the_very_long_named_integration_with_the_partner_service_account_v2: abc123",
  ])("hides what the earlier patterns hid in %j", text => {
    expect(redactSecrets(text)).toBe(before(text));
  });

  const size = 1024 * 1024;
  const repeat = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  it.each([
    ["one long token", repeat("a")],
    ["a long run of dots and dashes", repeat(".-")],
    ["a secret word repeated in one token", repeat("password")],
    ["a secret word repeated on 4 KiB lines", repeat(`${"DB_TOKEN".repeat(511)}\n`)],
    ["private key headers without an end", repeat("-----BEGIN RSA PRIVATE KEY-----\n")],
    ["a run of -eyJ", repeat("-eyJ")],
    ["URL-like runs", repeat("://a:")],
  ])("takes linear time on %s (1 MiB)", (_name, text) => {
    const t0 = performance.now();
    redactSecrets(text);
    // Linear work here is tens of milliseconds; the quadratic patterns took minutes to hours at this size.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
