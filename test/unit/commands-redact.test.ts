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
